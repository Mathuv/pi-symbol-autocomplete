/**
 * Extension entry point for symbol autocomplete.
 *
 * Wires up:
 * - Commands: `/rescan-symbols` (async tags regeneration) and
 *   `/symbol-autocomplete-status` (status report).
 * - `session_start`: creates the TagsManager and the ReadtagsBackend for
 *   the session cwd, starts async tags ensure, registers the `#`
 *   autocomplete provider over the backend.
 * - `before_agent_start`: parses `#` references from the prompt, resolves
 *   them against the backend, and injects a hidden custom message with
 *   the matching symbol definitions.
 * - Fail-open: a still-building index, a failed engine, or a backend
 *   error warns once per session and proceeds without injection.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReadtagsBackend } from "./types.ts";
import { createTagsManager } from "./tags-manager.ts";
import { createReadtagsBackend } from "./readtags-backend.ts";
import { createSymbolAutocompleteProvider } from "./autocomplete.ts";
import { createRescanHandler, createStatusHandler } from "./commands.ts";
import { parsePrompt } from "./reference-parser.ts";
import { resolveReferences } from "./resolver.ts";
import { buildInjectionPayload } from "./injection.ts";

// ── Per-session warmup warning state ────────────────────────────────

interface WarmupState {
  /** Whether we've already warned about the index still building. */
  warnedBuilding: boolean;
  /** Whether we've already warned about a failed/unavailable engine. */
  warnedEngine: boolean;
}

function freshWarmupState(): WarmupState {
  return { warnedBuilding: false, warnedEngine: false };
}

// ── Extension factory ───────────────────────────────────────────────

export default function symbolAutocompleteExtension(
  pi: ExtensionAPI,
  options?: { createBackend?: (tagsFilePath: string, cwd: string) => ReadtagsBackend },
) {
  // Shared state — persists across session starts within the same
  // extension runtime (i.e. between `/reload` calls). The manager and
  // the backend are recreated per session_start so handlers always use
  // the objects of the current session cwd.
  let indexManager: ReturnType<typeof createTagsManager> | null = null;
  let backend: ReadtagsBackend | null = null;
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
    // Errors are tracked in TagsStatus.
    indexManager.ensure().catch(() => {});

    // ── Readtags backend for this session's tags file ───────────
    const createBackend =
      options?.createBackend ??
      ((tagsFilePath: string, cwd: string) => createReadtagsBackend({ tagsFilePath, cwd }));
    backend = createBackend(indexManager.getStatus().tagsPath, ctx.cwd);

    // ── Register autocomplete provider ────────────────────────────
    ctx.ui.addAutocompleteProvider((current) =>
      createSymbolAutocompleteProvider(current, backend!),
    );
  });

  // ── Turn-time injection ───────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    // Guard: no manager or backend for the current session
    if (!indexManager || !backend) return;

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

    // No usable tags file: skip resolution. The backend would fail.
    if (status.engine === "none") return;

    // Parse symbol references from the prompt
    const parseResult = parsePrompt(event.prompt);
    if (parseResult.references.length === 0) return;

    // Resolve against the backend. A backend failure fails open: warn
    // once per session and proceed without injection.
    let resolveResult;
    try {
      resolveResult = await resolveReferences(parseResult.references, backend);
    } catch {
      if (!warmup.warnedEngine) {
        ctx.ui.notify(
          "Symbol autocomplete: symbol lookup failed. Falling back to default autocomplete behavior.",
          "warning",
        );
        warmup.warnedEngine = true;
      }
      return;
    }

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
