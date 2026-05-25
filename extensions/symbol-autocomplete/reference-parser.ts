/**
 * Symbol reference parser for prompt text.
 *
 * Extracts symbol references (#name or #name@path:line) from a prompt,
 * respecting fenced code block boundaries and boundary-only trigger semantics.
 */

import type { ParsedReference, ParseResult } from "./types.ts";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a prompt string for symbol references.
 *
 * - Scans each line for `#` at a valid boundary (start of line or after
 *   whitespace). Mid-word `#` references (e.g. `foo#Bar`) are skipped.
 * - Tries stable token format `#name@path:line` first, then falls back
 *   to plain `#name`.
 * - Excludes all content inside triple-backtick fenced code blocks.
 *
 * Returns structured diagnostics for each reference found.
 */
export function parsePrompt(prompt: string): ParseResult {
  const lines = prompt.split("\n");
  const references: ParsedReference[] = [];
  let insideFence = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";

    // Toggle fenced code block state on lines starting with triple backticks
    if (line.trimStart().startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }

    if (insideFence) continue;

    const lineRefs = parseLine(line, lineIndex);
    references.push(...lineRefs);
  }

  return { references };
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Scan a single line for symbol references at valid boundaries.
 *
 * Iterates character-by-character to find `#` at start-of-line or
 * after whitespace, then tries stable and plain token patterns.
 */
function parseLine(line: string, lineIndex: number): ParsedReference[] {
  const refs: ParsedReference[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      const rest = line.slice(i);

      // Try stable token: #name@path:line (name may include dots)
      const stableMatch = rest.match(/^#([\w][\w\d]*(?:\.[\w][\w\d]*)*)@([^\s:]+?):(\d+)/);
      if (stableMatch) {
        refs.push({
          raw: stableMatch[0],
          name: stableMatch[1],
          path: stableMatch[2],
          line: Number.parseInt(stableMatch[3], 10),
          type: "stable",
          lineIndex,
          column: i,
        });
        i += stableMatch[0].length;
        continue;
      }

      // Try plain token: #name (name may include dots)
      const plainMatch = rest.match(/^#([\w][\w\d]*(?:\.[\w][\w\d]*)*)/);
      if (plainMatch) {
        refs.push({
          raw: plainMatch[0],
          name: plainMatch[1],
          type: "plain",
          lineIndex,
          column: i,
        });
        i += plainMatch[0].length;
        continue;
      }
    }

    i++;
  }

  return refs;
}
