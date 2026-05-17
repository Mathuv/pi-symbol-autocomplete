/**
 * Extension entry point for symbol autocomplete.
 *
 * Wires up:
 * - Commands: `/rescan-symbols` (async refresh) and `/symbol-autocomplete-status` (status report).
 * - `session_start`: creates SymbolIndexManager, starts async index load/build,
 *   registers `#` autocomplete provider via `ctx.ui.addAutocompleteProvider`.
 * - `before_agent_start`: parses symbol references from prompt, resolves
 *   against index, injects hidden custom message with symbol definitions.
 * - Warmup fail-open: if index is still building at turn time, the turn
 *   proceeds without injection; a single non-spam warning is shown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSymbolIndexManager } from "./symbol-index.ts";
import { createSymbolAutocompleteProvider } from "./autocomplete.ts";
import { createRescanHandler, createStatusHandler } from "./commands.ts";
import { parsePrompt } from "./reference-parser.ts";
import { resolveReferences } from "./resolver.ts";
import { buildInjectionPayload } from "./injection.ts";

// ── Per-session warmup warning state ────────────────────────────────

interface WarmupState {
  /** Whether we've already warned about the index still building. */
  warnedBuilding: boolean;
  /** Whether we've already warned about a fallback/failed engine. */
  warnedEngine: boolean;
}

function freshWarmupState(): WarmupState {
  return { warnedBuilding: false, warnedEngine: false };
}

// ── Extension factory ───────────────────────────────────────────────

export default function symbolAutocompleteExtension(pi: ExtensionAPI) {
  // Shared state — persists across session starts within the same
  // extension runtime (i.e. between `/reload` calls).
  let indexManager: ReturnType<typeof createSymbolIndexManager> | null = null;
  let warmup = freshWarmupState();

  // ── Register commands (once at load time) ─────────────────────────
  pi.registerCommand("rescan-symbols", {
    description: "Rescan project symbols asynchronously",
    handler: createRescanHandler(() => indexManager),
  });
  pi.registerCommand("symbol-autocomplete-status", {
    description: "Show symbol autocomplete index status",
    handler: createStatusHandler(() => indexManager),
  });

  // ── Session lifecycle ─────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    // Reset warmup state for the new session
    warmup = freshWarmupState();

    // ── Index manager (uses pi.exec as the underlying executor) ──
    indexManager = createSymbolIndexManager({
      cwd: ctx.cwd,
      executor: (command, args, options) => pi.exec(command, args, options),
    });

    // ── Async index load/build (non-blocking) ─────────────────────
    indexManager.refresh().catch(() => {
      // Silently catch — errors are tracked in IndexStatus
    });

    // ── Register autocomplete provider ────────────────────────────
    ctx.ui.addAutocompleteProvider((current) =>
      createSymbolAutocompleteProvider(current, () => indexManager?.getSymbols() ?? []),
    );
  });

  // ── Turn-time injection ───────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    // Guard: no index manager at all
    if (!indexManager) return;

    const status = indexManager.getStatus();

    // ── Fail-open: index still building ─────────────────────────────
    if (status.isBuilding) {
      if (!warmup.warnedBuilding) {
        ctx.ui.notify(
          "Symbol autocomplete: index still building, symbols will be available next turn.",
          "warning",
        );
        warmup.warnedBuilding = true;
      }
      return; // skip injection; turn proceeds
    }

    // ── Warmup/fallback engine warning (once per session) ───────────
    if (!warmup.warnedEngine) {
      if (status.engine === "ast-grep") {
        ctx.ui.notify(
          "Symbol autocomplete: tags file/ctags unavailable, using ast-grep fallback. Some symbols may not be detected.",
          "warning",
        );
        warmup.warnedEngine = true;
      } else if (status.engine === "none" && status.lastError) {
        ctx.ui.notify(
          `Symbol autocomplete: indexing failed (${status.lastError}). Falling back to default autocomplete behavior.`,
          "warning",
        );
        warmup.warnedEngine = true;
      }
    }

    // Skip if no symbols are available (index built but empty)
    const symbols = indexManager.getSymbols();
    if (symbols.length === 0) return;

    // Parse symbol references from the prompt
    const parseResult = parsePrompt(event.prompt);
    if (parseResult.references.length === 0) return;

    // Resolve against the current symbol index
    const resolveResult = resolveReferences(parseResult.references, symbols);

    // ── Issue UI warnings for non-injectable refs ──────────────────
    for (const ref of resolveResult.resolved) {
      if (ref.status === "unresolved") {
        ctx.ui.notify(
          `Symbol autocomplete: "${ref.parsed.name}" not found in index.`,
          "warning",
        );
      } else if (ref.status === "ambiguous") {
        ctx.ui.notify(
          `Symbol autocomplete: "${ref.parsed.name}" is ambiguous (multiple matches). Use a stable token or be more specific.`,
          "warning",
        );
      } else if (ref.status === "stale") {
        ctx.ui.notify(ref.message, "warning");
      }
    }

    // ── Build injection payload ─────────────────────────────────────
    if (resolveResult.injectable.length === 0) return;

    const injection = await buildInjectionPayload(
      resolveResult.injectable,
      ctx.cwd,
    );

    // Nothing to inject (all files failed to read, etc.)
    if (injection.symbols.length === 0) return;

    // ── Issue cap/missing-file warnings ─────────────────────────────
    for (const warning of injection.warnings) {
      ctx.ui.notify(warning, "warning");
    }

    // ── Inject hidden custom message ────────────────────────────────
    return {
      message: {
        customType: "symbol-context",
        content: JSON.stringify(injection.symbols),
        display: false,
      },
    };
  });
}
