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

      const items = ranked.map((sym) => formatSymbolItem(sym, symbols));

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
 * Build the stable token for a symbol: `#name@path:line`.
 */
function stableToken(sym: ProjectSymbol): string {
  return `#${sym.name}@${sym.path}:${sym.line}`;
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
 * Ordering: exact prefix (case-insensitive) → fuzzy (all chars in order).
 * Within each group, tie-break by shallower path first, then alphabetically.
 */
function rankSymbols(symbols: ProjectSymbol[], query: string): ProjectSymbol[] {
  const lowerQuery = query.toLowerCase();

  if (!query) {
    // Empty query: show all, sorted by path depth then name
    return [...symbols].sort(byDepthThenName);
  }

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
 * Format a symbol as an AutocompleteItem for display.
 *
 * - Label: `#SymbolName`
 * - Description: `Kind · path` (or `Kind · path:line` when name is ambiguous)
 */
function formatSymbolItem(sym: ProjectSymbol, allSymbols: ProjectSymbol[]): AutocompleteItem {
  const sameNameCount = allSymbols.filter((s) => s.name === sym.name).length;
  const token = stableToken(sym);
  const kind = sym.kind.charAt(0).toUpperCase() + sym.kind.slice(1);

  const location =
    sameNameCount > 1 ? `${sym.path}:${sym.line}` : sym.path;

  return {
    value: token,
    label: `#${sym.name}`,
    description: `${kind} · ${location}`,
  };
}
