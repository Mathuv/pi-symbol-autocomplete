/**
 * Command handlers for symbol autocomplete extension.
 *
 * Provides:
 * - `/rescan-symbols` — async tags regeneration with coalescing
 * - `/symbol-autocomplete-status` — engine/file/error/inFlight report
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TagsManager } from "./types.ts";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a handler for the `/rescan-symbols` command.
 *
 * Triggers an async index refresh. If a refresh is already in-flight,
 * reports that status instead of spawning a duplicate scan.
 */
export function createRescanHandler(
  getManager: () => TagsManager | null,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (_args: string, ctx: ExtensionCommandContext) => {
    const mgr = getManager();
    if (!mgr) {
      ctx.ui.notify("Symbol autocomplete: not initialized.", "error");
      return;
    }

    const status = mgr.getStatus();
    if (status.isBuilding) {
      ctx.ui.notify(
        "Symbol autocomplete: rescan already in progress.",
        "warning",
      );
      return;
    }

    ctx.ui.notify("Symbol autocomplete: rescanning symbols...", "info");
    // Fire and forget — errors are tracked in TagsStatus
    mgr.regenerate().catch(() => {});
  };
}

/**
 * Create a handler for the `/symbol-autocomplete-status` command.
 *
 * Returns a formatted report of the current index status including
 * engine, symbol count, last refresh time, in-flight state, and
 * last error (if any).
 */
export function createStatusHandler(
  getManager: () => TagsManager | null,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (_args: string, ctx: ExtensionCommandContext) => {
    const mgr = getManager();
    if (!mgr) {
      ctx.ui.notify("Symbol autocomplete: not initialized.", "error");
      return;
    }

    const status = mgr.getStatus();
    const fields: string[] = [
      `Engine: ${status.engine}`,
      `Tags: ${status.tagsPath}`,
      `Size: ${status.fileSizeBytes} bytes`,
      `Modified: ${status.mtime ? new Date(status.mtime).toISOString() : "never"}`,
      `In flight: ${status.isBuilding}`,
    ];
    if (status.lastError) {
      fields.push(`Last error: ${status.lastError}`);
    }

    ctx.ui.notify(fields.join(" | "), "info");
  };
}
