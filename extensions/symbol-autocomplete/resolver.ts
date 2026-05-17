/**
 * Symbol reference resolver.
 *
 * Maps parsed references to concrete ProjectSymbols following deterministic
 * resolution rules:
 *
 * - **Stable token** (`#name@path:line`):
 *   1. Exact match on name + path + line → resolved
 *   2. Same name + same file (stale line) → stale-resolved
 *   3. Otherwise → unresolved (no cross-file fallback)
 *
 * - **Plain token** (`#name`):
 *   - Exactly one symbol with that name → resolved
 *   - Multiple symbols with that name → ambiguous (skip injection)
 *   - No symbol with that name → unresolved
 */

import type {
  ParsedReference,
  ProjectSymbol,
  ResolveResult,
  ResolvedReference,
  ResolveStatus,
} from "./types.ts";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve parsed references against a symbol index.
 *
 * Returns structured outcomes with diagnostic metadata, including an
 * `injectable` subset of references that passed ambiguity/uniqueness checks.
 */
export function resolveReferences(
  references: ParsedReference[],
  symbols: ProjectSymbol[],
): ResolveResult {
  const resolved: ResolvedReference[] = [];

  for (const ref of references) {
    const outcome = resolveOne(ref, symbols);
    resolved.push(outcome);
  }

  return {
    resolved,
    injectable: resolved.filter((r) => r.status === "resolved" || r.status === "stale"),
  };
}

// ── Internal resolution logic ───────────────────────────────────────

/**
 * Resolve a single parsed reference against the symbol index.
 */
function resolveOne(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
): ResolvedReference {
  if (ref.type === "stable") {
    return resolveStable(ref, symbols);
  }
  return resolvePlain(ref, symbols);
}

/**
 * Resolve a stable token using the stale chain:
 *
 * 1. Exact name + path + line match → resolved
 * 2. Same name + same file (any line) → stale (line number changed)
 * 3. Otherwise → unresolved
 */
function resolveStable(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
): ResolvedReference {
  const path = ref.path;
  const line = ref.line;
  const name = ref.name;

  // Guard: stable tokens always have path and line
  if (path === undefined || line === undefined) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Malformed stable token: missing path or line`,
    };
  }

  // Step 1: Exact name + path + line match
  const exactMatch = symbols.find(
    (s) => s.name === name && s.path === path && s.line === line,
  );
  if (exactMatch) {
    return {
      parsed: ref,
      symbol: exactMatch,
      status: "resolved",
      message: `Resolved via exact name+path+line: ${name}@${path}:${line}`,
    };
  }

  // Step 2: Same name + same file (stale line number)
  const sameFileMatch = symbols.find(
    (s) => s.name === name && s.path === path,
  );
  if (sameFileMatch) {
    return {
      parsed: ref,
      symbol: sameFileMatch,
      status: "stale",
      message: `Stable token line ${line} is stale; resolved to ${sameFileMatch.name} at ${path}:${sameFileMatch.line}`,
    };
  }

  // Step 3: Unresolved — no cross-file fallback
  return {
    parsed: ref,
    symbol: null,
    status: "unresolved",
    message: `Unresolved stable token: ${name} not found at ${path}:${line}`,
  };
}

/**
 * Resolve a plain token:
 *
 * - Exactly one symbol with that name → resolved
 * - Multiple → ambiguous (skip)
 * - None → unresolved
 */
function resolvePlain(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
): ResolvedReference {
  const name = ref.name;

  const matches = symbols.filter((s) => s.name === name);

  if (matches.length === 1) {
    return {
      parsed: ref,
      symbol: matches[0],
      status: "resolved",
      message: `Resolved unique match: ${name} → ${matches[0].path}:${matches[0].line}`,
    };
  }

  if (matches.length === 0) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Unresolved plain token: no symbol named "${name}"`,
    };
  }

  // matches.length > 1
  const paths = matches.map((s) => `${s.path}:${s.line}`).join(", ");
  return {
    parsed: ref,
    symbol: null,
    status: "ambiguous",
    message: `Ambiguous plain token: "${name}" matches multiple symbols: ${paths}`,
  };
}
