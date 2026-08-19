/**
 * Extension entry point for symbol autocomplete.
 *
 * Wires up:
 * - Commands: `/rescan-symbols` (async tags regeneration) and
 *   `/symbol-autocomplete-status` (status report).
 * - `session_start`: creates the TagsManager, starts async tags ensure,
 *   registers `#` autocomplete provider via `ctx.ui.addAutocompleteProvider`.
 * - Warmup fail-open: if tags are still building at turn time, the turn
 *   proceeds without injection; a single non-spam warning is shown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTagsManager } from "./tags-manager.ts";
import { createReadtagsBackend } from "./readtags-backend.ts";
import { createSymbolAutocompleteProvider } from "./autocomplete.ts";
import { createRescanHandler, createStatusHandler } from "./commands.ts";

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
  let indexManager: ReturnType<typeof createTagsManager> | null = null;
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

    // ── Tags manager (uses pi.exec as the underlying executor) ──
    indexManager = createTagsManager({
      cwd: ctx.cwd,
      executor: (command, args, options) => pi.exec(command, args, options),
    });

    // ── Async tags ensure (non-blocking) ────────────────────────
    indexManager.ensure().catch(() => {
      // Silently catch — errors are tracked in TagsStatus
    });

    // ── Register autocomplete provider ────────────────────────────
    // The backend queries the on-disk tags file. A missing or stale
    // file makes queries fail, so the provider delegates to the default.
    const backend = createReadtagsBackend({
      tagsFilePath: indexManager.getStatus().tagsPath,
      cwd: ctx.cwd,
    });
    ctx.ui.addAutocompleteProvider((current) =>
      createSymbolAutocompleteProvider(current, backend),
    );
  });

  // ── Turn-time injection ───────────────────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    // Guard: no tags manager at all
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

    // ── Engine warning (once per session) ───────────────────────────
    if (!warmup.warnedEngine) {
      if (status.engine === "none" && status.lastError) {
        ctx.ui.notify(
          `Symbol autocomplete: indexing failed (${status.lastError}). Falling back to default autocomplete behavior.`,
          "warning",
        );
        warmup.warnedEngine = true;
      }
    }

    // Todo 4 rewires reference resolution and injection to the
    // readtags backend. Until then the turn proceeds without injection.
    return;
  });
}
