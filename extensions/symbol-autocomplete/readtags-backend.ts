/**
 * Readtags query backend for the symbol autocomplete extension.
 *
 * The backend runs a `readtags` subprocess for each query.
 * It reads stdout line by line and never buffers the full output.
 * Memory use is constant per query.
 *
 * Autocomplete prefix and dotted queries cap results at 50. Exact resolver
 * scans intentionally stream every exact match and use scanned-line,
 * per-line byte, total-time, and abort bounds instead of a result cap.
 * The first bound reached kills the child:
 * - result cap (autocomplete queries only, at most 50 results),
 * - scanned-line cap (10 000 lines),
 * - per-line byte cap (64 KiB),
 * - timeout (5 s),
 * - abort via an AbortSignal.
 *
 * The backend owns a lifetime AbortController. Every child runs under a
 * signal composed from that lifetime signal and the caller signal, so
 * `dispose()` kills every active child. A caller that leaves the shared
 * kind-alias load does not kill it. That child stays bounded: it lives
 * until its own 5 s deadline or until `dispose()`, then it takes SIGTERM
 * and then SIGKILL after the 200 ms grace.
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
const MAX_ALIAS_LINES = 10_000;
const QUERY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 200;
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

/**
 * The reason one stream stopped early. `ok: true` carries the early stop
 * reason; `ok: false` carries the failure that must reject the promise.
 */
type StopOutcome =
  | { ok: true; result: Exclude<StreamResult, "complete"> }
  | { ok: false; error: unknown };

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
    // The early stop reason, or null while the stream still runs.
    // A null outcome at settlement means the stream reached normal EOF.
    let outcome: StopOutcome | null = null;
    let pendingBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let childClosed = false;
    let stopping = false;
    let lines: ReturnType<typeof createInterface>;
    let abort: () => void;

    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", abort);
      lines.close();
      byteCap.destroy();
    };

    // Settle from the single outcome. A failure rejects for any thrown
    // value, including falsy ones. A thrown `undefined` must not resolve
    // a partial scan as if it completed.
    const settle = () => {
      if (finished) return;
      cleanup();
      if (outcome === null) resolve("complete");
      else if (outcome.ok) resolve(outcome.result);
      else reject(outcome.error);
    };

    // Stop the child and settle only after its close event. A short
    // grace timer escalates to SIGKILL when the child ignores SIGTERM,
    // so the promise never settles while the child remains alive.
    const stop = (nextOutcome: StopOutcome) => {
      if (finished || stopping) return;
      stopping = true;
      clearTimeout(timer);
      outcome = nextOutcome;
      child.kill();
      if (childClosed) settle();
      else graceTimer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    };

    const byteCap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          const lineBytes = pendingBytes + index - start;
          if (lineBytes > MAX_LINE_BYTES) {
            stop({ ok: true, result: "interrupted" });
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
          stop({ ok: true, result: "interrupted" });
          callback();
          return;
        }
        pendingBytes += tailBytes;
        if (tailBytes > 0) this.push(chunk.subarray(start));
        callback();
      },
    });
    lines = createInterface({ input: child.stdout.pipe(byteCap) });

    abort = () => stop({ ok: true, result: "interrupted" });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    child.on("error", (error) => {
      outcome = { ok: false, error };
      settle();
    });
    child.on("close", (code) => {
      childClosed = true;
      clearTimeout(graceTimer);
      // An early stop already fixed the outcome. Without an early stop a
      // non-zero exit fails and a zero exit is a complete stream.
      if (outcome === null && code !== 0) {
        outcome = { ok: false, error: new Error(`readtags exited with code ${code ?? "signal"}`) };
      }
      settle();
    });
    lines.on("line", (line) => {
      if (finished || stopping) return;
      let keepGoing: boolean;
      try {
        keepGoing = onLine(line);
      } catch (error) {
        // A visitor exception must kill the child and reject, not escape
        // the EventEmitter callback and crash the process. Falsy thrown
        // values reject too; they never resolve a partial scan.
        stop({ ok: false, error });
        return;
      }
      if (!keepGoing) stop({ ok: true, result: "capped" });
    });
  });
}

/** One kind-alias load: the parsed aliases and whether the load finished. */
type AliasResult = { aliases: Map<string, string>; complete: boolean };

/** Load language kind aliases once from `readtags -D` output. */
async function loadKindAliases(
  command: string,
  tagsFilePath: string,
  cwd: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<AliasResult> {
  const aliases = new Map<string, string>();
  let lineCount = 0;
  let aliasCapReached = false;
  const result = await streamReadtags(command, ["-D", "-t", tagsFilePath], cwd, signal, deadline, (line) => {
    lineCount += 1;
    // The line cap marks the load incomplete; the stored-alias cap is
    // complete by design.
    if (lineCount > MAX_ALIAS_LINES) return false;
    if (line.startsWith(TAG_KIND_DESCRIPTION_PREFIX)) {
      parseKindAlias(line, aliases);
      if (aliases.size >= MAX_KIND_ALIASES) {
        aliasCapReached = true;
        return false;
      }
    }
    return true;
  });
  const complete = result === "complete" || (result === "capped" && aliasCapReached);
  return { aliases, complete };
}

/**
 * Create a readtags query backend.
 * The tags file must already exist at `tagsFilePath`.
 * `queryTimeoutMs` bounds one alias load and one query. Only tests set
 * it; production keeps the 5 s default.
 */
export function createReadtagsBackend(options: {
  tagsFilePath: string;
  cwd: string;
  readtagsPath?: string;
  queryTimeoutMs?: number;
}): ReadtagsBackend {
  const {
    tagsFilePath,
    cwd,
    readtagsPath = "readtags",
    queryTimeoutMs = QUERY_TIMEOUT_MS,
  } = options;

  // Backend lifetime. dispose() aborts it. Every child runs under a
  // signal composed from the lifetime signal and the caller signal, so
  // dispose() kills every active child.
  const lifetime = new AbortController();

  /** Compose the backend lifetime signal with one caller signal. */
  function composeSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
  }

  // The cached kind-alias load. The load runs under the lifetime signal
  // and its own deadline, so one caller's abort never kills a load that
  // another caller waits on. Only a complete load (normal EOF or the
  // intentional alias cap) stays cached. An incomplete or failed load
  // clears the cache, so the next caller starts a fresh load.
  let aliasLoad: Promise<AliasResult> | null = null;

  function startAliasLoad(): Promise<AliasResult> {
    if (aliasLoad !== null) return aliasLoad;
    const load = loadKindAliases(
      readtagsPath,
      tagsFilePath,
      cwd,
      lifetime.signal,
      Date.now() + queryTimeoutMs,
    ).then(
      (result) => {
        // An incomplete load must not stay cached for the next caller.
        if (!result.complete && aliasLoad === load) aliasLoad = null;
        return result;
      },
      (error: unknown) => {
        if (aliasLoad === load) aliasLoad = null;
        throw error;
      },
    );
    aliasLoad = load;
    return load;
  }

  /**
   * Wait for the cached alias load with one caller's signal and deadline.
   * Returns null when the caller leaves through an abort or its deadline.
   * The load itself keeps running for the callers that stay.
   */
  function waitForAliases(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<AliasResult | null> {
    const composed = composeSignal(signal);
    if (composed.aborted || Date.now() >= deadline) return Promise.resolve(null);
    const load = startAliasLoad();
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (settleCaller: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        composed.removeEventListener("abort", onLeave);
        settleCaller();
      };
      const onLeave = () => finish(() => resolve(null));
      const timer = setTimeout(onLeave, Math.max(0, deadline - Date.now()));
      composed.addEventListener("abort", onLeave, { once: true });
      load.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  /**
   * Load aliases for one caller, retrying once after an incomplete load.
   * Returns null when the caller left (abort or deadline). A partial
   * alias map never reaches a caller.
   */
  async function loadAliases(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<Map<string, string> | null> {
    const first = await waitForAliases(signal, deadline);
    if (first === null) return null;
    if (first.complete) return first.aliases;
    // The load ended incomplete. Retry once with a fresh load while this
    // caller remains active; a still-incomplete load rejects.
    const second = await waitForAliases(signal, deadline);
    if (second === null) return null;
    if (second.complete) return second.aliases;
    throw new Error("kind alias loading did not complete");
  }

  function normalizeLimit(limit: number): number {
    if (!Number.isFinite(limit)) return MAX_RESULTS;
    return Math.min(Math.max(Math.trunc(limit), 0), MAX_RESULTS);
  }

  async function runQuery(
    args: string[],
    limit: number,
    signal: AbortSignal | undefined,
    collect: (symbol: ProjectSymbol) => boolean,
  ): Promise<void> {
    if (limit === 0 || signal?.aborted || lifetime.signal.aborted) return;

    const deadline = Date.now() + queryTimeoutMs;
    const aliases = await loadAliases(signal, deadline);
    // The caller aborted, the backend was disposed, or the deadline
    // passed during alias loading.
    if (aliases === null) return;

    let scannedLines = 0;
    await streamReadtags(readtagsPath, args, cwd, composeSignal(signal), deadline, (line) => {
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

    async scanExact(name, onSymbol, signal) {
      const deadline = Date.now() + queryTimeoutMs;
      // Route through the shared retry path like the other query methods.
      // An interrupted load is retried once; a partial alias map never
      // reaches the scan.
      const aliases = await loadAliases(signal, deadline);
      // The caller aborted, the backend was disposed, or the deadline
      // passed while aliases loaded.
      if (aliases === null) {
        throw new Error(`kind alias loading was interrupted; exact scan of "${name}" aborted`);
      }

      let scannedLines = 0;
      const result = await streamReadtags(
        readtagsPath,
        ["-t", tagsFilePath, "-e", "-n", "-", name],
        cwd,
        composeSignal(signal),
        deadline,
        (line) => {
          scannedLines += 1;
          if (scannedLines > MAX_SCANNED_LINES) return false;
          const symbol = parseTagLine(line, aliases);
          if (symbol) onSymbol(symbol);
          return true;
        },
      );

      // Any early stop (timeout, line cap, byte cap, child failure) leaves
      // the output incomplete. Never treat partial exact results as complete.
      if (result !== "complete") {
        throw new Error(`exact scan of "${name}" did not complete (${result})`);
      }
    },

    dispose() {
      lifetime.abort();
    },
  };
}
