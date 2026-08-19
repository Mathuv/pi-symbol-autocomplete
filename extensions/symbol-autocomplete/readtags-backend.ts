/**
 * Readtags query backend for the symbol autocomplete extension.
 *
 * The backend runs a `readtags` subprocess for each query.
 * It reads stdout line by line and never buffers the full output.
 * Memory use is constant per query.
 *
 * Each query enforces four bounds. The first bound reached kills the child:
 * - result cap (caller-provided, at most 50 results),
 * - scanned-line cap (10 000 lines),
 * - timeout (5 s),
 * - abort via an AbortSignal.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";

import {
  type ProjectSymbol,
  type ReadtagsBackend,
  DEFINITION_KINDS,
} from "./types.ts";

const MAX_RESULTS = 50;
const MAX_SCANNED_LINES = 10_000;
const QUERY_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_KIND_ALIASES = 1_000;
const TAG_KIND_DESCRIPTION_PREFIX = "!_TAG_KIND_DESCRIPTION!";

/**
 * Ctags scope kinds that represent class/type-like member scopes.
 * Variables/constants under these scopes are member-like, not local variables.
 * Language-agnostic: derives from ctags scope metadata, not language names.
 */
const MEMBER_SCOPE_KINDS = new Set([
  "class",
  "struct",
  "interface",
  "namespace",
  "module",
  "union",
  "enum",
  "trait",
  "impl",
]);

/** Short kind letters shared by most languages, without a language-specific alias. */
const COMMON_KIND_ALIASES = new Map<string, string>([
  ["C", "constant"],
  ["M", "macro"],
  ["P", "method"],
  ["c", "class"],
  ["e", "enumerator"],
  ["f", "function"],
  ["g", "enum"],
  ["i", "interface"],
  ["m", "method"],
  ["n", "namespace"],
  ["p", "property"],
  ["s", "struct"],
  ["t", "typedef"],
  ["v", "variable"],
]);

/** Extension fields that never represent a scope. */
const NON_SCOPE_FIELD_NAMES = new Set([
  "access",
  "end",
  "epoch",
  "extras",
  "file",
  "implementation",
  "inherits",
  "input",
  "kind",
  "language",
  "line",
  "name",
  "pattern",
  "roles",
  "signature",
  "typeref",
]);

/**
 * Read a kind alias from a `!_TAG_KIND_DESCRIPTION!` pseudo-tag line.
 * The alias key combines the language and the short kind letter.
 */
function parseKindAlias(line: string, aliases: Map<string, string>): void {
  const columns = line.split("\t");
  const language = columns[0]?.slice(TAG_KIND_DESCRIPTION_PREFIX.length);
  const kindSpec = columns[1];
  if (!language || !kindSpec) return;

  const comma = kindSpec.indexOf(",");
  if (comma === -1) return;

  const shortKind = kindSpec.slice(0, comma);
  const longKind = kindSpec.slice(comma + 1);
  if (!shortKind || !longKind) return;

  aliases.set(`${language}\0${shortKind}`, longKind);
}

/** Map a raw kind to its long form. Long kinds pass through unchanged. */
function normalizeTagKind(rawKind: string, language: string | undefined, aliases: Map<string, string>): string {
  if (rawKind.length > 1) return rawKind;

  if (language) {
    const languageAlias = aliases.get(`${language}\0${rawKind}`);
    if (languageAlias) return languageAlias;
  }

  return COMMON_KIND_ALIASES.get(rawKind) ?? rawKind;
}

/** Return true when the field name can represent a scope. */
function isScopeField(fieldName: string): boolean {
  return !NON_SCOPE_FIELD_NAMES.has(fieldName);
}

/**
 * Parse one classic-format tags line into a ProjectSymbol.
 * Returns null for pseudo-tag lines, malformed lines, and filtered symbols.
 *
 * A definition line looks like:
 * `name\tpath\t/^pattern$/;"\tkind:class\tline:1\tscope:class:Campaign\tend:9`
 */
export function parseTagLine(line: string, aliases: Map<string, string>): ProjectSymbol | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("!_TAG_")) return null;

  const columns = line.split("\t");
  if (columns.length < 4) return null;

  const [name, rawPath] = columns;
  if (!name || !rawPath) return null;

  let rawKind: string | undefined;
  let lineNumber: number | undefined;
  let endLine: number | undefined;
  let language: string | undefined;
  let hasScope = false;
  let parentName: string | undefined;
  // Track whether the scope is a class/type-like member scope (e.g. "class:Campaign",
  // "struct:MyStruct") so member-scoped variables/constants can be included while
  // function/parameter-scoped ones are excluded.
  let isMemberScope = false;

  for (const field of columns.slice(3)) {
    if (!field) continue;

    const colon = field.indexOf(":");
    if (colon === -1) {
      rawKind ??= field;
      continue;
    }

    const key = field.slice(0, colon);
    const value = field.slice(colon + 1);

    if (key === "kind") {
      rawKind = value;
    } else if (key === "line") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) lineNumber = parsed;
    } else if (key === "end") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) endLine = parsed;
    } else if (key === "language") {
      language = value;
    } else if (key === "scope" || key === "scopeKind" || isScopeField(key)) {
      hasScope = true;
      if (MEMBER_SCOPE_KINDS.has(key)) isMemberScope = true;
      if (key === "scope" && MEMBER_SCOPE_KINDS.has(value.split(":")[0])) isMemberScope = true;
      if (key === "scopeKind" && MEMBER_SCOPE_KINDS.has(value.toLowerCase())) isMemberScope = true;
      if (key !== "scopeKind" && value) {
        // The scope value format is "kind:name" (e.g. "class:Campaign").
        // Extract only the last segment (the actual parent name).
        parentName = value.split(":").at(-1) ?? value;
      }
    }
  }

  if (!rawKind || lineNumber === undefined) return null;

  const kind = normalizeTagKind(rawKind, language, aliases);
  if (!DEFINITION_KINDS.has(kind)) return null;

  // Exclude scoped variables/constants unless they are member-scoped (class/type-like)
  if ((kind === "variable" || kind === "constant") && hasScope && !isMemberScope) {
    return null;
  }

  return {
    name,
    kind,
    path: rawPath.replace(/^\.\//, ""),
    line: lineNumber,
    endLine,
    depth: hasScope ? 1 : 0,
    parentName,
  };
}

/**
 * Stream `readtags` stdout line by line into `onLine`.
 * The callback returns false to stop; the child is killed on stop.
 * The timeout and the AbortSignal also kill the child.
 * The promise reports whether the stream completed, hit a callback cap, or stopped early.
 */
type StreamResult = "complete" | "capped" | "interrupted";

function streamReadtags(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  deadline: number,
  onLine: (line: string) => boolean,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || Date.now() >= deadline) {
      resolve("interrupted");
      return;
    }

    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      reject(error);
      return;
    }

    let finished = false;
    let result: StreamResult = "complete";
    let pendingBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let lines: ReturnType<typeof createInterface>;
    let abort: () => void;

    const settle = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      lines.close();
      if (error) reject(error);
      else resolve(result);
    };

    const stop = (nextResult: Exclude<StreamResult, "complete">) => {
      if (finished) return;
      result = nextResult;
      child.kill();
      settle();
    };

    const byteCap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          const lineBytes = pendingBytes + index - start;
          if (lineBytes > MAX_LINE_BYTES) {
            stop("interrupted");
            callback();
            return;
          }
          this.push(chunk.subarray(start, index + 1));
          pendingBytes = 0;
          start = index + 1;
        }

        const tailBytes = chunk.length - start;
        if (pendingBytes + tailBytes > MAX_LINE_BYTES) {
          const allowed = MAX_LINE_BYTES - pendingBytes;
          if (allowed > 0) this.push(chunk.subarray(start, start + allowed));
          stop("interrupted");
          callback();
          return;
        }
        pendingBytes += tailBytes;
        if (tailBytes > 0) this.push(chunk.subarray(start));
        callback();
      },
    });
    lines = createInterface({ input: child.stdout.pipe(byteCap) });

    abort = () => stop("interrupted");
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      if (result !== "complete" || code === 0) settle();
      else settle(new Error(`readtags exited with code ${code ?? "signal"}`));
    });
    lines.on("line", (line) => {
      if (!finished && !onLine(line)) stop("capped");
    });
  });
}

/** Load language kind aliases once from `readtags -D` output. */
async function loadKindAliases(
  command: string,
  tagsFilePath: string,
  cwd: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<{ aliases: Map<string, string>; complete: boolean }> {
  const aliases = new Map<string, string>();
  const result = await streamReadtags(command, ["-D", "-t", tagsFilePath], cwd, signal, deadline, (line) => {
    if (line.startsWith(TAG_KIND_DESCRIPTION_PREFIX)) {
      parseKindAlias(line, aliases);
      if (aliases.size >= MAX_KIND_ALIASES) return false;
    }
    return true;
  });
  return { aliases, complete: result !== "interrupted" };
}

/**
 * Create a readtags query backend.
 * The tags file must already exist at `tagsFilePath`.
 */
export function createReadtagsBackend(options: { tagsFilePath: string; cwd: string; readtagsPath?: string }): ReadtagsBackend {
  const { tagsFilePath, cwd, readtagsPath = "readtags" } = options;

  let aliasesPromise: Promise<Map<string, string>> | null = null;

  function normalizeLimit(limit: number): number {
    if (!Number.isFinite(limit)) return MAX_RESULTS;
    return Math.min(Math.max(Math.trunc(limit), 0), MAX_RESULTS);
  }

  function getAliases(signal: AbortSignal | undefined, deadline: number): Promise<Map<string, string>> {
    if (aliasesPromise) return aliasesPromise;

    aliasesPromise = loadKindAliases(readtagsPath, tagsFilePath, cwd, signal, deadline).then(
      ({ aliases, complete }) => {
        if (!complete) aliasesPromise = null;
        return aliases;
      },
      (error: unknown) => {
        aliasesPromise = null;
        throw error;
      },
    );
    return aliasesPromise;
  }

  async function runQuery(
    args: string[],
    limit: number,
    signal: AbortSignal | undefined,
    collect: (symbol: ProjectSymbol) => boolean,
  ): Promise<void> {
    if (limit === 0 || signal?.aborted) return;

    const deadline = Date.now() + QUERY_TIMEOUT_MS;
    const aliases = await getAliases(signal, deadline);
    if (signal?.aborted || Date.now() >= deadline) return;

    let scannedLines = 0;
    await streamReadtags(readtagsPath, args, cwd, signal, deadline, (line) => {
      scannedLines += 1;
      if (scannedLines > MAX_SCANNED_LINES) return false;

      const symbol = parseTagLine(line, aliases);
      return !symbol || collect(symbol);
    });
  }

  return {
    async queryPrefix(query, limit, signal) {
      const normalizedLimit = normalizeLimit(limit);
      const symbols: ProjectSymbol[] = [];
      await runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-p", "-i", "-", query],
        normalizedLimit,
        signal,
        (symbol) => {
          symbols.push(symbol);
          return symbols.length < normalizedLimit;
        },
      );
      return symbols;
    },

    async queryDotted(parentQuery, memberQuery, limit, signal) {
      const normalizedLimit = normalizeLimit(limit);
      const exact: ProjectSymbol[] = [];
      const prefix: ProjectSymbol[] = [];
      const lowerParent = parentQuery.toLowerCase();
      await runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-p", "-i", "-", memberQuery],
        normalizedLimit,
        signal,
        (symbol) => {
          const parentName = symbol.parentName?.toLowerCase();
          if (!parentName?.startsWith(lowerParent)) return true;
          if (parentName === lowerParent) {
            exact.push(symbol);
            while (exact.length + prefix.length > normalizedLimit) prefix.pop();
            return exact.length < normalizedLimit;
          }
          if (exact.length + prefix.length < normalizedLimit) prefix.push(symbol);
          return true;
        },
      );
      return [...exact, ...prefix].slice(0, normalizedLimit);
    },

    async lookupExact(name, limit = MAX_RESULTS) {
      const normalizedLimit = normalizeLimit(limit);
      const symbols: ProjectSymbol[] = [];
      await runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-", name],
        normalizedLimit,
        undefined,
        (symbol) => {
          symbols.push(symbol);
          return symbols.length < normalizedLimit;
        },
      );
      return symbols;
    },
  };
}
