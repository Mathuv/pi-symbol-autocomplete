/**
 * Symbol autocomplete provider for `#` symbol references.
 *
 * Detects valid `#` trigger positions (start/whitespace boundary only),
 * queries the readtags backend per keystroke (prefix-only, capped at 50),
 * renders disambiguated suggestions, and inserts stable tokens
 * (`#name@path:line`) on selection.
 *
 * A query needs at least one character after `#`. Bare `#`, bare
 * `#Parent.`, and multi-dot chains (`#A.B.C`) delegate to the built-in
 * provider. Backend errors, empty results, and aborted queries also
 * delegate; this provider never throws out of getSuggestions.
 */

import type { ProjectSymbol, ReadtagsBackend } from "./types.ts";

const MAX_LABEL_LENGTH = 96;
const MAX_DESCRIBED_LABEL_LENGTH = 32;
const MAX_SUGGESTIONS = 50;

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
 * - Routes queries: `#parent.member` → queryDotted, otherwise queryPrefix.
 * - Caps the result set at 50 items and forwards the abort signal.
 * - Disambiguates duplicate symbol names within the capped results.
 * - Inserts stable token `#<name>@<path>:<line>` on selection.
 * - Delegates to `current` when there is no trigger, an empty query, a
 *   backend error, or an empty result set.
 */
export function createSymbolAutocompleteProvider(
  current: AutocompleteProvider,
  backend: ReadtagsBackend,
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
      if (!query) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const dotIndex = query.indexOf(".");
      // The resolver rejects multi-dot chains (#A.B.C), so any stable
      // token built from them would never resolve. Delegate instead.
      if (dotIndex >= 0 && query.slice(dotIndex + 1).includes(".")) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      let results: ProjectSymbol[] | null;
      try {
        results = dotIndex > 0
          ? (query.slice(dotIndex + 1)
              ? await backend.queryDotted(query.slice(0, dotIndex), query.slice(dotIndex + 1), MAX_SUGGESTIONS, options.signal)
              : null)
          : await backend.queryPrefix(query, MAX_SUGGESTIONS, options.signal);
      } catch {
        results = null;
      }

      // An aborted query must not surface partial backend results.
      if (options.signal?.aborted) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (!results || results.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      // Never trust the backend beyond the hard cap.
      const capped = results.slice(0, MAX_SUGGESTIONS);

      const isDotted = dotIndex > 0 && query.slice(dotIndex + 1) !== "";
      const ranked = isDotted
        ? rankDotted(capped, query.slice(0, dotIndex))
        : [...capped].sort(byDepthThenName);

      const items = ranked.map((sym) => formatSymbolItem(sym, capped, isDotted));

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
 * Keep the backend's dotted group order: exact parent matches before
 * parent-prefix matches. Sort within each group by path depth, then name.
 * Never reorders a prefix-parent group ahead of an exact-parent group.
 */
function rankDotted(symbols: ProjectSymbol[], parentQuery: string): ProjectSymbol[] {
  const lowerParent = parentQuery.toLowerCase();
  const exact = symbols.filter((sym) => sym.parentName?.toLowerCase() === lowerParent);
  const prefix = symbols.filter((sym) =>
    !!sym.parentName && sym.parentName.toLowerCase() !== lowerParent,
  );
  exact.sort(byDepthThenName);
  prefix.sort(byDepthThenName);
  return [...exact, ...prefix];
}

/**
 * Format a symbol as an AutocompleteItem for display.
 *
 * In dotted mode (when the user typed a dot query), symbols with parentName
 * show as `#Parent.member` label with `#Parent.member@path:line` value.
 * Otherwise uses existing `#SymbolName` / `#name@path:line` format.
 *
 * - Description: `Kind · path` (or `Kind · path:line` when name is ambiguous)
 * - Duplicate counting scans `cappedSymbols` only (at most 50 items).
 */
function formatSymbolItem(
  sym: ProjectSymbol,
  cappedSymbols: ProjectSymbol[],
  isDotted = false,
): AutocompleteItem {
  const includeParent = isDotted && !!sym.parentName;
  const displayName = includeParent
    ? `${sym.parentName}.${sym.name}`
    : sym.name;

  const sameNameCount = cappedSymbols.filter((s) =>
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
