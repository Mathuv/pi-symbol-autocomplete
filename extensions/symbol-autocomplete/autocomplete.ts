/**
 * Symbol autocomplete provider for `#` symbol references.
 *
 * Detects valid `#` trigger positions (start/whitespace boundary only),
 * ranks candidates (exact prefix > fuzzy > path-depth tie-break),
 * renders disambiguated suggestions, and inserts stable tokens
 * (`#name@path:line`) on selection.
 *
 * When no `#` trigger is detected, or the symbol index is empty,
 * delegates to the built-in provider.
 */

import type { ProjectSymbol } from "./types.ts";

const MAX_LABEL_LENGTH = 96;
const MAX_DESCRIBED_LABEL_LENGTH = 32;

// ── Types matching @earendil-works/pi-tui interfaces ────────────────
// Defined locally to avoid pi-tui import dependency in tests.

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

export interface AutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };

  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create an autocomplete provider layered over `current`.
 *
 * - Detects `#` at start-of-line or after whitespace (no mid-token).
 * - Ranks by: exact prefix > fuzzy match > path-depth tie-break.
 * - Disambiguates duplicate symbol names by showing `path:line`.
 * - Inserts stable token `#<name>@<path>:<line>` on selection.
 * - Delegates to `current` when no `#` trigger or index is empty.
 */
export function createSymbolAutocompleteProvider(
  current: AutocompleteProvider,
  getSymbols: () => ProjectSymbol[],
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);

      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const query = match[1] ?? "";
      const symbols = getSymbols();

      if (symbols.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const ranked = rankSymbols(symbols, query);

      if (ranked.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const isDotted = query.includes(".");
      const items = ranked.map((sym) => formatSymbolItem(sym, symbols, isDotted));

      return { prefix: `#${query}`, items };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Build the stable token for a symbol.
 * Non-dotted: `#name@path:line`
 * Dotted (with parentName): `#parentName.name@path:line`
 */
function stableToken(sym: ProjectSymbol, includeParent?: boolean): string {
  const name = includeParent && sym.parentName
    ? `${sym.parentName}.${sym.name}`
    : sym.name;
  return `#${name}@${sym.path}:${sym.line}`;
}

function compactLabel(displayName: string): string {
  const label = `#${displayName}`;
  if (label.length <= MAX_LABEL_LENGTH) {
    return label;
  }

  const tailLength = Math.floor((MAX_LABEL_LENGTH - 1) / 2);
  const headLength = MAX_LABEL_LENGTH - 1 - tailLength;
  return `${label.slice(0, headLength)}…${label.slice(-tailLength)}`;
}

/**
 * Count path depth from '/' separators.
 * `"src/utils/helper.ts"` → 2
 */
function pathDepth(p: string): number {
  return p.split("/").length - 1;
}

/**
 * Compare two symbols by path depth, then by name.
 */
function byDepthThenName(a: ProjectSymbol, b: ProjectSymbol): number {
  const aDepth = pathDepth(a.path);
  const bDepth = pathDepth(b.path);
  if (aDepth !== bDepth) return aDepth - bDepth;
  // ASCII-safe ordering: uppercase < lowercase
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * Simple fuzzy match: all query characters must appear in order in text.
 * Case-insensitive — both inputs should already be lowercased.
 */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  if (!text) return false;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Filter and rank symbols by query.
 *
 * For non-dotted queries:
 *   Ordering: exact prefix (case-insensitive) → fuzzy (all chars in order).
 *   Within each group, tie-break by shallower path first, then alphabetically.
 *
 * For dotted queries (containing a `.`):
 *   Split into parentQuery and memberQuery.
 *   1. Filter symbols where parentName exactly matches parentQuery (case-insensitive).
 *   2. Then add symbols where parentName prefix-matches parentQuery (broader matches).
 *   3. Within each group, match member name by prefix/fuzzy against memberQuery.
 *   4. Falls back to non-dotted matching if no symbols with parentName match.
 */
function rankSymbols(symbols: ProjectSymbol[], query: string): ProjectSymbol[] {
  const lowerQuery = query.toLowerCase();

  if (!query) {
    // Empty query: show all, sorted by path depth then name
    return [...symbols].sort(byDepthThenName);
  }

  const dotIndex = lowerQuery.indexOf(".");
  if (dotIndex >= 0) {
    const parentQuery = lowerQuery.slice(0, dotIndex);
    const memberQuery = lowerQuery.slice(dotIndex + 1);

    // Only attempt dotted matching if there's a non-empty parent query
    if (parentQuery) {
      // Exact parent matches first, then parent-prefix matches.
      // This ensures #Campaign.reserva shows Campaign members before
      // CampaignViewSet/CampaignReservationUseCase members.
      const exactCandidates = symbols.filter((sym) => {
        if (!sym.parentName) return false;
        return sym.parentName.toLowerCase() === parentQuery;
      });

      const prefixCandidates = symbols.filter((sym) => {
        if (!sym.parentName) return false;
        const name = sym.parentName.toLowerCase();
        return name !== parentQuery && name.startsWith(parentQuery);
      });

      if (exactCandidates.length > 0 || prefixCandidates.length > 0) {
        const exactRanked = rankByMember(exactCandidates, memberQuery);
        const prefixRanked = rankByMember(prefixCandidates, memberQuery);
        return [...exactRanked, ...prefixRanked];
      }
    }
  }

  // Non-dotted (or fallback) matching
  const exactPrefix: ProjectSymbol[] = [];
  const fuzzy: ProjectSymbol[] = [];
  const seen = new Set<string>();

  const dedupKey = (sym: ProjectSymbol) => `${sym.name}:${sym.path}:${sym.line}`;

  for (const sym of symbols) {
    const nameLower = sym.name.toLowerCase();
    if (nameLower.startsWith(lowerQuery)) {
      const k = dedupKey(sym);
      if (!seen.has(k)) {
        seen.add(k);
        exactPrefix.push(sym);
      }
      continue;
    }
    // Only non-exact-prefix symbols get fuzzy-matched
    if (fuzzyMatch(lowerQuery, nameLower)) {
      const k = dedupKey(sym);
      if (!seen.has(k)) {
        seen.add(k);
        fuzzy.push(sym);
      }
    }
  }

  exactPrefix.sort(byDepthThenName);
  fuzzy.sort(byDepthThenName);

  return [...exactPrefix, ...fuzzy];
}

/**
 * Rank candidate symbols (pre-filtered by parentName) against a member query.
 * Uses the same prefix→fuzzy strategy as the main ranker.
 */
function rankByMember(candidates: ProjectSymbol[], memberQuery: string): ProjectSymbol[] {
  const lowerQuery = memberQuery.toLowerCase();

  if (!memberQuery) {
    // Empty member query: show all candidates sorted by path depth then name
    return [...candidates].sort(byDepthThenName);
  }

  const exactPrefix: ProjectSymbol[] = [];
  const fuzzy: ProjectSymbol[] = [];
  const seen = new Set<string>();

  const dedupKey = (sym: ProjectSymbol) => `${sym.name}:${sym.path}:${sym.line}`;

  for (const sym of candidates) {
    const nameLower = sym.name.toLowerCase();
    if (nameLower.startsWith(lowerQuery)) {
      const k = dedupKey(sym);
      if (!seen.has(k)) {
        seen.add(k);
        exactPrefix.push(sym);
      }
      continue;
    }
    if (fuzzyMatch(lowerQuery, nameLower)) {
      const k = dedupKey(sym);
      if (!seen.has(k)) {
        seen.add(k);
        fuzzy.push(sym);
      }
    }
  }

  exactPrefix.sort(byDepthThenName);
  fuzzy.sort(byDepthThenName);

  return [...exactPrefix, ...fuzzy];
}

/**
 * Format a symbol as an AutocompleteItem for display.
 *
 * In dotted mode (when the user typed a dot query), symbols with parentName
 * show as `#Parent.member` label with `#Parent.member@path:line` value.
 * Otherwise uses existing `#SymbolName` / `#name@path:line` format.
 *
 * - Description: `Kind · path` (or `Kind · path:line` when name is ambiguous)
 */
function formatSymbolItem(
  sym: ProjectSymbol,
  allSymbols: ProjectSymbol[],
  isDotted = false,
): AutocompleteItem {
  const includeParent = isDotted && !!sym.parentName;
  const displayName = includeParent
    ? `${sym.parentName}.${sym.name}`
    : sym.name;

  const sameNameCount = allSymbols.filter((s) =>
    includeParent && s.parentName
      ? `${s.parentName}.${s.name}` === `${sym.parentName}.${sym.name}`
      : s.name === sym.name,
  ).length;

  const token = stableToken(sym, includeParent);
  const kind = sym.kind.charAt(0).toUpperCase() + sym.kind.slice(1);

  const location =
    sameNameCount > 1 ? `${sym.path}:${sym.line}` : sym.path;

  const label = compactLabel(displayName);

  const description = label.length > MAX_DESCRIBED_LABEL_LENGTH
    ? undefined
    : `${kind} · ${location}`;

  return {
    value: token,
    label,
    description,
  };
}
