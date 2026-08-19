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

/** The engine that produced the current tags file. */
export type TagsEngine = "tags-file" | "generated" | "none";

/** Status metadata for the tags file. */
export interface TagsStatus {
  /** Which engine produced the current tags file. */
  engine: TagsEngine;
  /** Absolute path to the tags file. */
  tagsPath: string;
  /** Size of the tags file in bytes. */
  fileSizeBytes: number;
  /** Last modification time of the tags file (ms since epoch), or null. */
  mtime: number | null;
  /** Last error message, or null if no error. */
  lastError: string | null;
  /** Whether a build is currently in progress. */
  isBuilding: boolean;
}

/** Result of executing a shell command, as returned by pi.exec(). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** Executor function type, abstracts pi.exec() or test mock. */
export type Executor = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

/** Async manager for the tags file lifecycle. */
export interface TagsManager {
  /**
   * Use the existing tags file or generate one when missing.
   * Concurrent calls join the same build.
   */
  ensure(): Promise<void>;

  /** Always regenerate the tags file with ctags. */
  regenerate(): Promise<void>;

  /** Get the current tags file status metadata. */
  getStatus(): TagsStatus;
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
