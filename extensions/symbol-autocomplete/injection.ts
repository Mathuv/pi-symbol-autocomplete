/**
 * Symbol context injection payload builder.
 *
 * At turn time (called from `before_agent_start`), extracts symbol
 * definition snippets and bounded surrounding context from source files,
 * assembles a bounded payload array, and enforces cardinality + size caps.
 *
 * Design:
 * - For each injectable resolved reference, reads the source file and
 *   extracts the definition lines (line → heuristic end) plus surrounding
 *   context lines before and after.
 * - Caps: max 8 symbols per prompt, max ~3000 chars per symbol payload.
 * - Truncation marker `...[truncated]` appended when clipping.
 * - Missing files cause the symbol to be skipped with a warning.
 */

import type { ProjectSymbol, ResolvedReference } from "./types.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

/** Structured payload for a single resolved symbol. */
export interface SymbolPayload {
  metadata: {
    name: string;
    kind: string;
    path: string;
    line: number;
    /** 1-indexed inclusive end line of the symbol definition. */
    endLine: number;
  };
  /** The definition lines (signature + body) of the symbol. */
  definition: string;
  /** Bounded context lines surrounding the definition. */
  context: string;
}

/** Result of building the injection payload from a batch of refs. */
export interface InjectionResult {
  /** Built symbol payloads (max MAX_SYMBOLS). */
  symbols: SymbolPayload[];
  /** Number of symbols skipped due to the per-turn cap. */
  skipped: number;
  /** UI warnings for skipped/missing symbols. */
  warnings: string[];
}

/** Injectable file reader for testing. */
export type FileReader = (filePath: string) => Promise<string>;

// ── Constants ───────────────────────────────────────────────────────

/** Maximum symbols to inject per turn. */
export const MAX_SYMBOLS = 8;

/** Maximum total characters per symbol payload (metadata + definition + context). */
export const MAX_CHARS_PER_SYMBOL = 3000;

/** Marker appended when content is truncated. */
export const TRUNCATION_MARKER = "...[truncated]";

/** Lines of context to include before the definition. */
const CONTEXT_BEFORE_LINES = 2;

/** Lines of context to include after the definition. */
const CONTEXT_AFTER_LINES = 3;

/**
 * Heuristic definition length by kind (lines).
 * Used when endLine is not available from the index.
 */
const DEFINITION_LINE_ESTIMATES: Record<string, number> = {
  class: 15,
  interface: 15,
  struct: 15,
  enum: 10,
  trait: 15,
  impl: 15,
  function: 10,
  method: 10,
  macro: 5,
  constant: 3,
  variable: 3,
  type: 5,
  namespace: 3,
  module: 3,
  typedef: 3,
  union: 10,
  prototype: 5,
  singleton: 5,
  event: 3,
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build injection payload from injectable resolved references.
 *
 * For each symbol, reads the source file and extracts:
 * 1. Metadata (name, kind, path, line)
 * 2. Definition snippet (the symbol's definition lines)
 * 3. Bounded surrounding context (lines before and after)
 *
 * Enforces caps:
 * - Max MAX_SYMBOLS per prompt
 * - Max ~MAX_CHARS_PER_SYMBOL per symbol (truncated with marker)
 */
export async function buildInjectionPayload(
  injectable: ResolvedReference[],
  cwd: string,
  fileReader?: FileReader,
): Promise<InjectionResult> {
  const readFileFn = fileReader ?? defaultFileReader;

  const result: InjectionResult = {
    symbols: [],
    skipped: 0,
    warnings: [],
  };

  // Enforce per-turn cap
  const toProcess = injectable.slice(0, MAX_SYMBOLS);
  if (injectable.length > MAX_SYMBOLS) {
    result.skipped = injectable.length - MAX_SYMBOLS;
    result.warnings.push(
      `Symbol autocomplete: ${result.skipped} symbol${result.skipped !== 1 ? "s" : ""} omitted (max ${MAX_SYMBOLS} per turn)`,
    );
  }

  for (const ref of toProcess) {
    if (!ref.symbol) continue;

    try {
      const payload = await extractSymbolPayload(ref.symbol, cwd, readFileFn);
      result.symbols.push(payload);
    } catch {
      // File read error — skip symbol and issue warning
      result.warnings.push(
        `Symbol autocomplete: could not read file for "${ref.symbol.name}" at ${ref.symbol.path}`,
      );
    }
  }

  return result;
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Extract a single symbol's payload from its source file.
 *
 * Reads the file, extracts definition lines and surrounding context,
 * and applies the per-symbol size budget with truncation.
 */
async function extractSymbolPayload(
  symbol: ProjectSymbol,
  cwd: string,
  readFileFn: FileReader,
): Promise<SymbolPayload> {
  const absolutePath = resolve(cwd, symbol.path);
  const content = await readFileFn(absolutePath);
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Convert 1-indexed to 0-indexed for array access
  const zeroBasedLine = Math.max(0, symbol.line - 1);

  // Determine definition end (0-indexed, exclusive)
  const defEndLine = symbol.endLine !== undefined
    ? symbol.endLine  // endLine is 1-indexed; keep it as the last line (inclusive)
    : Math.min(totalLines, zeroBasedLine + estimateDefinitionLines(symbol.kind));

  // Guard: if line exceeds file length, return minimal payload
  if (zeroBasedLine >= totalLines) {
    return {
      metadata: {
        name: symbol.name,
        kind: symbol.kind,
        path: symbol.path,
        line: symbol.line,
        endLine: symbol.endLine ?? symbol.line,
      },
      definition: `// ${symbol.kind} ${symbol.name} (file truncated)`,
      context: "",
    };
  }

  // ── Extract definition lines ──────────────────────────────────────
  const defStartIdx = zeroBasedLine;
  const defEndIdx = Math.min(totalLines, defEndLine);
  const definitionLines = lines.slice(defStartIdx, defEndIdx);

  // ── Extract context lines ─────────────────────────────────────────
  // Context before: up to CONTEXT_BEFORE_LINES before the definition start
  const ctxBeforeStart = Math.max(0, zeroBasedLine - CONTEXT_BEFORE_LINES);
  const contextBeforeLines = lines.slice(ctxBeforeStart, zeroBasedLine);

  // Context after: up to CONTEXT_AFTER_LINES after the definition end
  const ctxAfterStart = Math.min(totalLines, defEndIdx);
  const ctxAfterEnd = Math.min(totalLines, defEndIdx + CONTEXT_AFTER_LINES);
  const contextAfterLines = lines.slice(ctxAfterStart, ctxAfterEnd);

  // Assemble context text
  const contextParts: string[] = [];
  if (contextBeforeLines.length > 0) {
    contextParts.push(contextBeforeLines.join("\n"));
  }
  if (contextAfterLines.length > 0) {
    if (contextParts.length > 0) contextParts.push("");
    contextParts.push(contextAfterLines.join("\n"));
  }
  const context = contextParts.join("\n");

  // Assemble definition text
  const definition = definitionLines.join("\n");

  // ── Apply per-symbol size budget ──────────────────────────────────
  const { truncatedDefinition, truncatedContext } = applySizeBudget(
    definition,
    context,
    symbol,
  );

  return {
    metadata: {
      name: symbol.name,
      kind: symbol.kind,
      path: symbol.path,
      line: symbol.line,
      endLine: defEndLine,
    },
    definition: truncatedDefinition.trim(),
    context: truncatedContext.trim(),
  };
}

/**
 * Estimate the number of lines for a symbol's definition based on its kind.
 * Used when the index does not provide endLine.
 */
function estimateDefinitionLines(kind: string): number {
  return DEFINITION_LINE_ESTIMATES[kind] ?? 5;
}

/**
 * Apply the per-symbol character budget to definition + context.
 *
 * Strategy: prefer preserving the definition snippet over context.
 * If total exceeds budget, truncate context first, then definition if needed.
 */
function applySizeBudget(
  definition: string,
  context: string,
  symbol: ProjectSymbol,
): { truncatedDefinition: string; truncatedContext: string } {
  // Compute metadata JSON overhead for this symbol
  const metadataJson = JSON.stringify({
    name: symbol.name,
    kind: symbol.kind,
    path: symbol.path,
    line: symbol.line,
    endLine: symbol.endLine ?? 0,
  });
  // Budget for definition + context: total minus metadata overhead
  // Add some padding for the JSON wrapper in the final serialized payload
  const metadataOverhead = metadataJson.length + 100;
  const budget = MAX_CHARS_PER_SYMBOL - metadataOverhead;

  // If definition + context already fits, return as-is
  const combined = definition + (context ? "\n\n" + context : "");
  if (combined.length <= budget) {
    return { truncatedDefinition: definition, truncatedContext: context };
  }

  // Need to truncate. Prefer preserving definition.
  const contextSeparator = context ? "\n\n" : "";
  const defLen = definition.length;

  if (context) {
    // Budget available for context after reserving definition + separator
    const ctxBudget = budget - defLen - contextSeparator.length;

    if (ctxBudget >= 20) {
      // Context has room — truncate context only
      const avail = Math.max(0, ctxBudget - TRUNCATION_MARKER.length);
      const truncatedCtx = context.slice(0, avail) + TRUNCATION_MARKER;
      return { truncatedDefinition: definition, truncatedContext: truncatedCtx };
    }
  }

  // Not enough budget for definition + context — truncate definition too.
  // Keep at most 60% of budget for definition, the rest for context.
  const defBudget = Math.floor(budget * 0.6);
  const defAvail = Math.max(0, defBudget - TRUNCATION_MARKER.length);
  const truncatedDef = definition.slice(0, defAvail) + TRUNCATION_MARKER;

  const remainingBudget = budget - truncatedDef.length;
  if (context && remainingBudget > 20) {
    const ctxAvail = Math.max(0, remainingBudget - contextSeparator.length - TRUNCATION_MARKER.length);
    const truncatedCtx = context.slice(0, ctxAvail) + TRUNCATION_MARKER;
    return { truncatedDefinition: truncatedDef, truncatedContext: truncatedCtx };
  }

  return { truncatedDefinition: truncatedDef, truncatedContext: "" };
}

// ── Default file reader ─────────────────────────────────────────────

/**
 * Default file reader using Node.js fs.readFile.
 */
async function defaultFileReader(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content;
}
