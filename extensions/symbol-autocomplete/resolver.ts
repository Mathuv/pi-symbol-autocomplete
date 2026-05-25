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
 *
 * - **Dotted tokens** (`#Parent.member` or `#Parent.member@path:line`):
 *   - Dotted stable: match by parent + member + path + line (exact)
 *   - Dotted stale stable: same parent + member + file (stale line)
 *   - Dotted plain: match by parent + member (unique → resolved, multiple → ambiguous)
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
 * Split a dotted name into parent and member parts.
 * Returns null if the name doesn't contain a valid dot separation.
 */
function splitDottedName(name: string): { parentName: string; memberName: string } | null {
  const dotIndex = name.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= name.length - 1) {
    return null;
  }
  const memberName = name.slice(dotIndex + 1);
  // v1 supports exactly one parent plus one member; reject multi-dot chains
  if (memberName.includes(".")) {
    return null;
  }
  return {
    parentName: name.slice(0, dotIndex),
    memberName,
  };
}

/**
 * Resolve a single parsed reference against the symbol index.
 */
function resolveOne(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
): ResolvedReference {
  const dotted = splitDottedName(ref.name);
  if (dotted) {
    if (ref.type === "stable") {
      return resolveDottedStable(ref, symbols, dotted);
    }
    return resolveDottedPlain(ref, symbols, dotted);
  }
  // Multi-dot names (e.g. A.B.C) are unsupported chains in v1.
  // splitDottedName returned null because the member contains more dots.
  // Explicitly return unresolved rather than falling through to non-dotted
  // resolution which could match a literal symbol with a dotted name.
  if (ref.name.includes(".")) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Unresolved multi-dot reference: "${ref.name}" — dotted chains with more than one dot are not supported in v1`,
    };
  }
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

/**
 * Resolve a dotted stable token using parent+member identity:
 *
 * 1. Exact parent + member + path + line match → resolved
 * 2. Same parent + member + file (stale line) → stale
 * 3. Otherwise → unresolved (no cross-file fallback)
 */
function resolveDottedStable(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
  dotted: { parentName: string; memberName: string },
): ResolvedReference {
  const { parentName, memberName } = dotted;
  const path = ref.path;
  const line = ref.line;

  if (path === undefined || line === undefined) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Malformed dotted stable token: missing path or line`,
    };
  }

  // Step 1: Exact parent + member + path + line match
  const exactMatch = symbols.find(
    (s) => s.parentName === parentName && s.name === memberName && s.path === path && s.line === line,
  );
  if (exactMatch) {
    return {
      parsed: ref,
      symbol: exactMatch,
      status: "resolved",
      message: `Resolved via exact parent+member+path+line: ${parentName}.${memberName}@${path}:${line}`,
    };
  }

  // Step 2: Same parent + member + file (stale line number)
  const sameFileMatch = symbols.find(
    (s) => s.parentName === parentName && s.name === memberName && s.path === path,
  );
  if (sameFileMatch) {
    return {
      parsed: ref,
      symbol: sameFileMatch,
      status: "stale",
      message: `Stable token line ${line} is stale; resolved to ${parentName}.${sameFileMatch.name} at ${path}:${sameFileMatch.line}`,
    };
  }

  // Step 3: Unresolved — no cross-file fallback
  return {
    parsed: ref,
    symbol: null,
    status: "unresolved",
    message: `Unresolved dotted stable token: ${parentName}.${memberName} not found at ${path}:${line}`,
  };
}

/**
 * Resolve a dotted plain token:
 *
 * - Exactly one symbol with that parentName + name → resolved
 * - Multiple → ambiguous (skip)
 * - None → unresolved
 */
function resolveDottedPlain(
  ref: ParsedReference,
  symbols: ProjectSymbol[],
  dotted: { parentName: string; memberName: string },
): ResolvedReference {
  const { parentName, memberName } = dotted;

  const matches = symbols.filter(
    (s) => s.parentName === parentName && s.name === memberName,
  );

  if (matches.length === 1) {
    return {
      parsed: ref,
      symbol: matches[0],
      status: "resolved",
      message: `Resolved unique dotted match: ${parentName}.${memberName} → ${matches[0].path}:${matches[0].line}`,
    };
  }

  if (matches.length === 0) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Unresolved dotted plain token: no symbol with parent="${parentName}" and name="${memberName}"`,
    };
  }

  const paths = matches.map((s) => `${s.path}:${s.line}`).join(", ");
  return {
    parsed: ref,
    symbol: null,
    status: "ambiguous",
    message: `Ambiguous dotted plain token: "${parentName}.${memberName}" matches multiple symbols: ${paths}`,
  };
}
