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

import {
  type ProjectSymbol,
  type ReadtagsBackend,
  DEFINITION_KINDS,
} from "./types.ts";

const MAX_RESULTS = 50;
const MAX_SCANNED_LINES = 10_000;
const QUERY_TIMEOUT_MS = 5_000;
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
 * The promise resolves when the stream ends, stops, times out, or aborts.
 */
function streamReadtags(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onLine: (line: string) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("readtags", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      lines.close();
      resolve();
    };

    const onAbort = () => finish();

    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(finish, QUERY_TIMEOUT_MS);

    child.on("error", finish);
    lines.on("close", finish);
    lines.on("line", (line) => {
      if (finished) return;
      if (!onLine(line)) finish();
    });
  });
}

/** Load language kind aliases once from `readtags -D` output. */
async function loadKindAliases(tagsFilePath: string, cwd: string): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  await streamReadtags(["-D", "-t", tagsFilePath], cwd, undefined, (line) => {
    if (line.startsWith(TAG_KIND_DESCRIPTION_PREFIX)) {
      parseKindAlias(line, aliases);
    }
    return true;
  });
  return aliases;
}

/**
 * Create a readtags query backend.
 * The tags file must already exist at `tagsFilePath`.
 */
export function createReadtagsBackend(options: { tagsFilePath: string; cwd: string }): ReadtagsBackend {
  const { tagsFilePath, cwd } = options;

  let aliasesPromise: Promise<Map<string, string>> | null = null;

  function getAliases(): Promise<Map<string, string>> {
    aliasesPromise ??= loadKindAliases(tagsFilePath, cwd);
    return aliasesPromise;
  }

  /**
   * Run a readtags query with all bounds.
   * Keeps accepted symbols until `limit` is reached, then kills the child.
   */
  async function runQuery(
    args: string[],
    limit: number,
    signal: AbortSignal | undefined,
    accept: (sym: ProjectSymbol) => boolean,
  ): Promise<ProjectSymbol[]> {
    const aliases = await getAliases();
    const symbols: ProjectSymbol[] = [];
    let scannedLines = 0;

    await streamReadtags(args, cwd, signal, (line) => {
      scannedLines += 1;
      if (scannedLines > MAX_SCANNED_LINES) return false;

      const sym = parseTagLine(line, aliases);
      if (sym && accept(sym)) {
        symbols.push(sym);
        if (symbols.length >= limit) return false;
      }
      return true;
    });

    return symbols;
  }

  return {
    async queryPrefix(query, limit, signal) {
      return runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-p", "-i", "-", query],
        Math.min(limit, MAX_RESULTS),
        signal,
        () => true,
      );
    },

    async queryDotted(parentQuery, memberQuery, limit, signal) {
      const results = await runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-p", "-i", "-", memberQuery],
        Math.min(limit, MAX_RESULTS),
        signal,
        (sym) => {
          if (!sym.parentName) return false;
          return sym.parentName.toLowerCase().startsWith(parentQuery.toLowerCase());
        },
      );

      // Rank exact-parent matches before prefix-parent matches.
      const lowerParent = parentQuery.toLowerCase();
      const exact = results.filter((sym) => sym.parentName!.toLowerCase() === lowerParent);
      const prefix = results.filter((sym) => sym.parentName!.toLowerCase() !== lowerParent);
      return [...exact, ...prefix];
    },

    async lookupExact(name, limit = MAX_RESULTS) {
      return runQuery(
        ["-t", tagsFilePath, "-e", "-n", "-", name],
        Math.min(limit, MAX_RESULTS),
        undefined,
        () => true,
      );
    },
  };
}
