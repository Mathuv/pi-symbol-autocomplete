/**
 * Async symbol index engine with tags-file→ctags→ast-grep fallback.
 *
 * Builds a repository symbol catalog asynchronously (non-blocking),
 * using a pre-built `tags` file first, ctags next, and ast-grep as fallback.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type Executor,
  type IndexStatus,
  type ProjectSymbol,
  type SymbolIndexManager,
  type SymbolIndexManagerOptions,
  DEFAULT_EXCLUDES,
  DEFINITION_KINDS,
} from "./types.ts";

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

// ── Parser: ctags JSON output ───────────────────────────────────────

interface CtagsTag {
  _type: string;
  name: string;
  path: string;
  pattern: string;
  line: number;
  kind: string;
  scope?: string;
  scopeKind?: string;
}

/**
 * Parse ctags JSON lines into ProjectSymbol[].
 * Filters to definition-level kinds only; scoped symbols with
 * non-definition-kind parents are excluded.
 */
function parseCtagsOutput(stdout: string): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const tag = JSON.parse(trimmed) as CtagsTag;
      if (tag._type !== "tag") continue;

      // Only include definition-level kinds
      if (!DEFINITION_KINDS.has(tag.kind)) continue;

      // Scoped variables/constants: include only if within a class/type-like member scope.
      // Base decision on scopeKind or scope prefix (not language).
      if (tag.kind === "variable" || tag.kind === "constant") {
        if (tag.scope || tag.scopeKind) {
          const scopeKindValue = (tag.scopeKind || tag.scope?.split(":")[0] || "").toLowerCase();
          if (!MEMBER_SCOPE_KINDS.has(scopeKindValue)) continue;
        }
      }

      // Determine depth and parentName from scope info
      let depth = 0;
      let parentName: string | undefined;
      if (tag.scope) {
        // scope format can be "class:MyClass" or just "MyClass" with scopeKind: "class".
        const segments = tag.scope.split(":");
        parentName = segments[segments.length - 1];
        depth = segments.length > 1 || tag.scopeKind ? 1 : 0;
      }

      symbols.push({
        name: tag.name,
        kind: tag.kind,
        path: tag.path,
        line: tag.line,
        depth,
        parentName,
      });
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  return symbols;
}

// ── Parser: classic ctags `tags` file output ────────────────────────

const TAG_KIND_DESCRIPTION_PREFIX = "!_TAG_KIND_DESCRIPTION!";

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

function normalizeTagKind(rawKind: string, language: string | undefined, aliases: Map<string, string>): string {
  if (rawKind.length > 1) return rawKind;

  if (language) {
    const languageAlias = aliases.get(`${language}\0${rawKind}`);
    if (languageAlias) return languageAlias;
  }

  return COMMON_KIND_ALIASES.get(rawKind) ?? rawKind;
}

function isScopeField(fieldName: string): boolean {
  return !NON_SCOPE_FIELD_NAMES.has(fieldName);
}

function parseClassicCtagsOutput(stdout: string): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  const lines = stdout.split("\n");
  const aliases = new Map<string, string>();

  for (const line of lines) {
    if (line.startsWith(TAG_KIND_DESCRIPTION_PREFIX)) {
      parseKindAlias(line, aliases);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("!_TAG_")) continue;

    const columns = line.split("\t");
    if (columns.length < 4) continue;

    const [name, rawPath] = columns;
    if (!name || !rawPath) continue;

    let rawKind: string | undefined;
    let lineNumber: number | undefined;
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
      } else if (key === "language") {
        language = value;
      } else if (key === "scope" || key === "scopeKind" || isScopeField(key)) {
        hasScope = true;
        if (MEMBER_SCOPE_KINDS.has(key)) isMemberScope = true;
        if (key === "scope" && MEMBER_SCOPE_KINDS.has(value.split(":")[0])) isMemberScope = true;
        if (key === "scopeKind" && MEMBER_SCOPE_KINDS.has(value.toLowerCase())) isMemberScope = true;
        if (key !== "scopeKind" && value) {
          // scope field value format is "kind:name" (e.g. "class:Campaign").
          // Extract only the last segment (the actual parent name).
          parentName = value.split(":").at(-1) ?? value;
        }
      }
    }

    if (!rawKind || lineNumber === undefined) continue;

    const kind = normalizeTagKind(rawKind, language, aliases);
    if (!DEFINITION_KINDS.has(kind)) continue;

    // Exclude scoped variables/constants unless they are member-scoped (class/type-like)
    if ((kind === "variable" || kind === "constant") && hasScope && !isMemberScope) {
      continue;
    }

    symbols.push({
      name,
      kind,
      path: rawPath.replace(/^\.\//, ""),
      line: lineNumber,
      depth: hasScope ? 1 : 0,
      parentName,
    });
  }

  return symbols;
}

function parseTagsFileOutput(stdout: string): ProjectSymbol[] {
  const firstDataLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("!_TAG_"));

  if (firstDataLine?.startsWith("{")) {
    return parseCtagsOutput(stdout);
  }

  return parseClassicCtagsOutput(stdout);
}

async function readTagsFile(tagsFilePath: string): Promise<{
  exists: boolean;
  symbols: ProjectSymbol[];
  error: string | null;
}> {
  try {
    const content = await readFile(tagsFilePath, "utf8");
    return { exists: true, symbols: parseTagsFileOutput(content), error: null };
  } catch (err: unknown) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { exists: false, symbols: [], error: null };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { exists: true, symbols: [], error: message };
  }
}

// ── Parser: ast-grep JSON output ────────────────────────────────────

interface AstGrepMatch {
  text: string;
  file: string;
  range: {
    byteOffset?: { start: number; end: number };
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  lines?: string;
  language?: string;
  metaVariables?: {
    single?: Record<string, { text: string }>;
    multi?: Record<string, { text: string[] }>;
  };
}

/**
 * Ast-grep patterns to search for definition-level symbols.
 * Each pattern targets a specific kind of symbol.
 */
const AST_GREP_PATTERNS: Array<{ pattern: string; kind: string }> = [
  { pattern: "function $NAME($$$)", kind: "function" },
  { pattern: "class $NAME", kind: "class" },
  { pattern: "interface $NAME", kind: "interface" },
  { pattern: "enum $NAME", kind: "enum" },
  { pattern: "type $NAME = $$$", kind: "type" },
  // const/let/var patterns intentionally omitted — ast-grep cannot scope-filter
  // to module-level-only, so they'd incorrectly match local variables.
  { pattern: "struct $NAME", kind: "struct" },
  { pattern: "trait $NAME", kind: "trait" },
  { pattern: "impl $NAME", kind: "impl" },
  { pattern: "def $NAME($$$)", kind: "function" },        // Python
  { pattern: "class $NAME($$$)", kind: "class" },           // Python class with bases
  { pattern: "fn $NAME($$$)", kind: "function" },           // Rust
  { pattern: "pub fn $NAME($$$)", kind: "function" },       // Rust
  { pattern: "macro_rules! $NAME", kind: "macro" },         // Rust
  { pattern: "func $NAME($$$)", kind: "function" },         // Go
  { pattern: "type $NAME struct", kind: "struct" },         // Go struct type
  { pattern: "type $NAME interface", kind: "interface" },   // Go interface type
];

/**
 * Parse ast-grep JSON output into ProjectSymbol[].
 * Handles the array-of-matches format from `ast-grep run --json`.
 */
function parseAstGrepOutput(stdout: string, kind: string): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  let matches: AstGrepMatch[];

  try {
    matches = JSON.parse(stdout) as AstGrepMatch[];
  } catch {
    return symbols;
  }

  if (!Array.isArray(matches)) return symbols;

  for (const match of matches) {
    const name =
      match.metaVariables?.single?.NAME?.text ??
      match.metaVariables?.single?.name?.text;

    if (!name) continue;

    // ast-grep uses 0-indexed lines; convert to 1-indexed
    const line = (match.range.start.line ?? 0) + 1;
    const endLine = match.range.end.line != null ? match.range.end.line + 1 : undefined;

    symbols.push({
      name,
      kind,
      path: match.file,
      line,
      endLine,
      depth: 0,
    });
  }

  return symbols;
}

/**
 * Run ast-grep with all patterns and merge results.
 * Deduplicates by name+path+line.
 */
async function runAstGrepIndex(
  executor: Executor,
  cwd: string,
  excludes: string[],
  timeout: number,
): Promise<{ symbols: ProjectSymbol[]; error: string | null }> {
  const allSymbols: ProjectSymbol[] = [];
  const seen = new Set<string>();
  let lastError: string | null = null;
  let anyPatternSucceeded = false;

  for (const { pattern, kind } of AST_GREP_PATTERNS) {
    const args = ["run", "--pattern", pattern, "--json", "."];
    for (const exclude of excludes) {
      args.push("--ignore", exclude);
    }

    const result = await executor("ast-grep", args, { cwd, timeout });

    if (result.code !== 0) {
      lastError = result.stderr || `exit code ${result.code}`;
      continue;
    }

    anyPatternSucceeded = true;

    if (!result.stdout.trim()) continue;

    const parsed = parseAstGrepOutput(result.stdout, kind);
    for (const sym of parsed) {
      const key = `${sym.name}:${sym.path}:${sym.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        allSymbols.push(sym);
      }
    }
  }

  return { symbols: allSymbols, error: anyPatternSucceeded ? null : lastError };
}

// ── Exclude argument builder ────────────────────────────────────────

function buildExcludeArgs(extraExcludes?: string[]): string[] {
  const allExcludes = [...DEFAULT_EXCLUDES, ...(extraExcludes ?? [])];
  const args: string[] = [];
  for (const pattern of allExcludes) {
    args.push("--exclude", pattern);
  }
  return args;
}

// ── SymbolIndexManager factory ──────────────────────────────────────

export function createSymbolIndexManager(options: SymbolIndexManagerOptions): SymbolIndexManager {
  const {
    cwd,
    executor,
    tagsFilePath = "tags",
    extraExcludes,
    ctagsTimeout = 10_000,
    astGrepTimeout = 10_000,
  } = options;
  const resolvedTagsFilePath = resolve(cwd, tagsFilePath);

  let symbols: ProjectSymbol[] = [];
  let status: IndexStatus = {
    engine: "none",
    symbolCount: 0,
    lastRefresh: null,
    lastError: null,
    isBuilding: false,
  };

  /** In-flight refresh promise for coalescing concurrent calls. */
  let inFlightRefresh: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    // Coalesce: if a refresh is already in-flight, join it
    if (inFlightRefresh) {
      return inFlightRefresh;
    }

    // Capture this build so concurrent callers join the same one
    let resolveBuild: (() => void) | null = null;
    const buildPromise = new Promise<void>((resolve) => {
      resolveBuild = resolve;
    });
    inFlightRefresh = buildPromise;

    try {
      status = { ...status, isBuilding: true, lastError: null };

      let tagsFileError: string | null = null;
      const tagsFile = await readTagsFile(resolvedTagsFilePath);
      if (tagsFile.exists && tagsFile.error === null && tagsFile.symbols.length > 0) {
        symbols = tagsFile.symbols;
        status = {
          engine: "tags-file",
          symbolCount: symbols.length,
          lastRefresh: Date.now(),
          lastError: null,
          isBuilding: false,
        };
        return;
      }

      if (tagsFile.error) {
        tagsFileError = `tags-file: ${tagsFile.error}`;
      } else if (tagsFile.exists) {
        tagsFileError = "tags-file: no parseable definition symbols";
      }

      // ── Attempt ctags command fallback ───────────────────────
      const excludeArgs = buildExcludeArgs(extraExcludes);
      const ctagsArgs = ["--recurse", "--fields=+K+n", "--output-format=json", ".", ...excludeArgs];

      const ctagsResult = await executor("ctags", ctagsArgs, { cwd, timeout: ctagsTimeout });

      if (ctagsResult.code === 0) {
        symbols = parseCtagsOutput(ctagsResult.stdout);
        status = {
          engine: "ctags",
          symbolCount: symbols.length,
          lastRefresh: Date.now(),
          lastError: null,
          isBuilding: false,
        };
        return;
      }

      // ctags failed or timed out — try ast-grep fallback
      const { symbols: astGrepSymbols, error: astGrepError } = await runAstGrepIndex(
        executor,
        cwd,
        [...DEFAULT_EXCLUDES, ...(extraExcludes ?? [])],
        astGrepTimeout,
      );

      if (astGrepSymbols.length > 0 || astGrepError === null) {
        // ast-grep succeeded (or returned empty without error)
        symbols = astGrepSymbols;
        status = {
          engine: "ast-grep",
          symbolCount: symbols.length,
          lastRefresh: Date.now(),
          lastError: astGrepError,
          isBuilding: false,
        };
        return;
      }

      // Both engines failed
      status = {
        ...status,
        engine: "none",
        symbolCount: symbols.length, // preserve previous count
        lastRefresh: status.lastRefresh, // preserve previous timestamp
        lastError: [
          tagsFileError,
          `ctags: ${ctagsResult.stderr || `exit ${ctagsResult.code}`}`,
          `ast-grep: ${astGrepError || "failed"}`,
        ].filter(Boolean).join("; "),
        isBuilding: false,
      };
    } catch (err: unknown) {
      // Unexpected error (e.g. executor threw)
      const message = err instanceof Error ? err.message : String(err);
      status = {
        ...status,
        engine: "none",
        lastError: message,
        isBuilding: false,
      };
    } finally {
      resolveBuild!();
      // Clear in-flight if we're the current one (avoid race)
      if (inFlightRefresh === buildPromise) {
        inFlightRefresh = null;
      }
    }
  }

  function getSymbols(): ProjectSymbol[] {
    return symbols;
  }

  function getStatus(): IndexStatus {
    return status;
  }

  return { refresh, getSymbols, getStatus };
}
