/**
 * Shared types for the symbol autocomplete extension.
 */

/** A single definition-level symbol in the project index. */
export interface ProjectSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  /** Optional end line for multi-line definitions (e.g. classes, functions). */
  endLine?: number;
  /** Scope depth within the file. 0 = file-level. */
  depth?: number;
  /** Parent symbol name for scoped members (e.g. class name for a property). */
  parentName?: string;
}

/** The indexing engine used to build the symbol catalog. */
export type IndexEngine = "tags-file" | "ctags" | "ast-grep" | "none";

/** Status metadata for the symbol index. */
export interface IndexStatus {
  /** Which engine produced the current index. */
  engine: IndexEngine;
  /** Number of symbols in the current index. */
  symbolCount: number;
  /** Timestamp of last successful refresh (ms since epoch), or null if never refreshed. */
  lastRefresh: number | null;
  /** Last error message, or null if no error. */
  lastError: string | null;
  /** Whether a refresh is currently in progress. */
  isBuilding: boolean;
}

/** Result of executing a shell command, as returned by pi.exec(). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Executor function type, abstracts pi.exec() or test mock. */
export type Executor = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

/** Configuration for createSymbolIndexManager. */
export interface SymbolIndexManagerOptions {
  /** Working directory for the project to index. */
  cwd: string;
  /** Executor for running shell commands (pi.exec or mock). */
  executor: Executor;
  /** Optional path to a pre-built ctags `tags` file (default: `${cwd}/tags`). */
  tagsFilePath?: string;
  /** Additional exclude patterns beyond defaults. */
  extraExcludes?: string[];
  /** Timeout in ms for ctags invocation (default 10000). */
  ctagsTimeout?: number;
  /** Timeout in ms for ast-grep invocation (default 10000). */
  astGrepTimeout?: number;
}

/** Async symbol index manager with ctags→ast-grep fallback. */
export interface SymbolIndexManager {
  /**
   * Trigger an async index build. If a build is already in-flight,
   * waits for that build and returns (coalesces concurrent calls).
   */
  refresh(): Promise<void>;

  /** Get a snapshot of the current symbol catalog. */
  getSymbols(): ProjectSymbol[];

  /** Get the current index status metadata. */
  getStatus(): IndexStatus;
}

/** Async query backend over a readtags-managed tags file. */
export interface ReadtagsBackend {
  /**
   * Prefix-search symbols by name. Case-insensitive.
   * Results are capped at `limit` (at most 50).
   */
  queryPrefix(query: string, limit: number, signal?: AbortSignal): Promise<ProjectSymbol[]>;

  /**
   * Search members whose parent name matches `parentQuery` by
   * case-insensitive prefix. Exact parent matches rank first.
   */
  queryDotted(parentQuery: string, memberQuery: string, limit: number, signal?: AbortSignal): Promise<ProjectSymbol[]>;

  /** Look up symbols by exact name. Results are capped at `limit` (at most 50). */
  lookupExact(name: string, limit?: number): Promise<ProjectSymbol[]>;
}

/** Default directory exclude patterns. */
export const DEFAULT_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  ".tox",
  "bazel-*",
];

/** Definition-level ctags kinds to include in the index. */
export const DEFINITION_KINDS = new Set([
  "class",
  "function",
  "method",
  "interface",
  "enum",
  "struct",
  "type",
  "namespace",
  "module",
  "constant",
  "variable",
  "macro",
  "typedef",
  "union",
  "prototype",
  "singleton",
  "event",
  "trait",
  "impl",
  "property",
  "field",
  "member",
]);

// ── Parser / Resolver types ─────────────────────────────────────────

/**
 * A parsed symbol reference from a prompt.
 */
export interface ParsedReference {
  /** Raw matched text including the # prefix. */
  raw: string;
  /** Symbol name (without #). */
  name: string;
  /** Repository-relative file path (stable tokens only). */
  path?: string;
  /** Line number (stable tokens only). */
  line?: number;
  /** Whether this is a stable selected token or plain typed token. */
  type: "stable" | "plain";
  /** 0-indexed line number in the prompt where this reference appears. */
  lineIndex: number;
  /** 0-indexed column offset where the # starts. */
  column: number;
}

/** Resolution outcome for a parsed reference. */
export type ResolveStatus = "resolved" | "ambiguous" | "unresolved" | "stale";

/**
 * A fully resolved (or skipped) reference with diagnostic metadata.
 */
export interface ResolvedReference {
  /** The original parsed reference from the prompt. */
  parsed: ParsedReference;
  /** The resolved symbol, or null if unresolved/ambiguous/stale. */
  symbol: ProjectSymbol | null;
  /** Resolution status for injection and warning logic. */
  status: ResolveStatus;
  /** Human-readable explanation for warnings/diagnostics. */
  message: string;
}

/** Result of parsing a prompt for symbol references. */
export interface ParseResult {
  /** All symbol references found in the prompt (excluding fenced code). */
  references: ParsedReference[];
}

/** Result of resolving parsed references against a symbol index. */
export interface ResolveResult {
  /** All resolution outcomes. */
  resolved: ResolvedReference[];
  /** References that are safe to inject (resolved uniquely). */
  injectable: ResolvedReference[];
}
