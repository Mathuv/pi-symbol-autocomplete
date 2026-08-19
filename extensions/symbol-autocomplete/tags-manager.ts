/**
 * Tags file lifecycle manager for the symbol autocomplete extension.
 *
 * The manager owns the on-disk `tags` file:
 * - `ensure()` uses an existing file or generates one with ctags.
 * - `regenerate()` always generates with ctags (tags files are disposable).
 * - Status reports the engine, the file metadata, and the last error.
 *
 * The manager probes `readtags` once per instance. When the probe fails,
 * the engine becomes `none` and the feature disables with an install hint.
 * There is no in-memory fallback (decision 6 in the plan).
 *
 * One operation coordinator guards all work. Concurrent `ensure()` calls
 * coalesce, concurrent `regenerate()` calls coalesce, and the two APIs
 * never run ctags concurrently. When `ensure()` is generating a missing
 * file, a queued `regenerate()` joins that generation (one ctags command).
 * When `ensure()` only probes and finds an existing file, a queued
 * `regenerate()` runs its own ctags command after it.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type ExecResult,
  type Executor,
  type TagsManager,
  type TagsStatus,
  DEFAULT_EXCLUDES,
} from "./types.ts";

const READTAGS_NOT_FOUND = "readtags not found — install universal-ctags";
const CTAGS_NOT_FOUND = "ctags not found — install universal-ctags";
const CTAGS_HINT = "ctags failed — install universal-ctags";
const PROBE_TIMEOUT_MS = 5_000;

/** Build the ctags exclude flags from DEFAULT_EXCLUDES and extraExcludes. */
function buildExcludeArgs(extraExcludes?: string[]): string[] {
  const patterns = [...DEFAULT_EXCLUDES, ...(extraExcludes ?? [])];
  return patterns.map((pattern) => `--exclude=${pattern}`);
}

/** Create a tags file manager for the project at `cwd`. */
export function createTagsManager(options: {
  cwd: string;
  executor: Executor;
  tagsFilePath?: string;
  extraExcludes?: string[];
  ctagsTimeout?: number;
}): TagsManager {
  const {
    cwd,
    executor,
    tagsFilePath = "tags",
    extraExcludes,
    ctagsTimeout = 10_000,
  } = options;
  const resolvedTagsPath = resolve(cwd, tagsFilePath);

  let status: TagsStatus = {
    engine: "none",
    tagsPath: resolvedTagsPath,
    fileSizeBytes: 0,
    mtime: null,
    lastError: null,
    isBuilding: false,
  };

  let probeResult: Promise<boolean> | null = null;
  // Serializes operations: each op runs only after the previous settles.
  let inFlight: Promise<void> | null = null;
  // Number of queued and active ops. isBuilding stays true until this is 0.
  let pendingOps = 0;
  // True after a successful generation. Queued ops join that generation.
  // The coordinator clears it when the queue drains.
  let generatedInQueue = false;

  /** Probe readtags once per manager instance. */
  function probeReadtags(): Promise<boolean> {
    probeResult ??= executor("readtags", ["--version"], { cwd, timeout: PROBE_TIMEOUT_MS }).then(
      (result) => result.code === 0,
      () => false,
    );
    return probeResult;
  }

  /** Stat the tags file. Returns null when the file is missing. */
  async function statTags(): Promise<{ size: number; mtime: number } | null> {
    try {
      const info = await stat(resolvedTagsPath);
      return { size: info.size, mtime: info.mtimeMs };
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }
  }

  /**
   * Update the status from the file on disk after a ctags attempt.
   * A missing file clears size and mtime; the engine becomes `none`.
   */
  async function recordOutcome(lastError: string | null): Promise<void> {
    const info = await statTags();
    if (info === null) {
      generatedInQueue = false;
      status = { ...status, engine: "none", fileSizeBytes: 0, mtime: null, lastError };
      return;
    }
    generatedInQueue = lastError === null;
    status = {
      ...status,
      engine: lastError === null ? "generated" : "tags-file",
      fileSizeBytes: info.size,
      mtime: info.mtime,
      lastError,
    };
  }

  /** Run one ctags command and record the outcome. */
  async function runCtags(): Promise<void> {
    const args = [
      "--recurse",
      "--sort=foldcase",
      "--fields=+KznZe",
      ...buildExcludeArgs(extraExcludes),
      "-f",
      resolvedTagsPath,
      ".",
    ];

    let result: ExecResult;
    try {
      result = await executor("ctags", args, { cwd, timeout: ctagsTimeout });
    } catch {
      await recordOutcome(CTAGS_NOT_FOUND);
      return;
    }

    // pi.exec resolves a killed run with code 0. A killed ctags must never
    // mark the file as generated, even when a partial file exists.
    if (result.killed === true) {
      await recordOutcome("ctags timed out");
      return;
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `ctags exited with code ${result.code}`;
      await recordOutcome(`${detail} — ${CTAGS_HINT}`);
      return;
    }
    await recordOutcome(null);
  }

  /** One uncoordinated ensure. The coordinator guards concurrency. */
  async function runEnsure(): Promise<void> {
    status = { ...status, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND };
        return;
      }
      // Join a generation the preceding op just completed.
      if (generatedInQueue) return;

      const info = await statTags();
      if (info !== null) {
        status = {
          ...status,
          engine: "tags-file",
          fileSizeBytes: info.size,
          mtime: info.mtime,
        };
        return;
      }

      await runCtags();
    } catch (err: unknown) {
      status = { ...status, engine: "none", lastError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** One uncoordinated regenerate. The coordinator guards concurrency. */
  async function runRegenerate(): Promise<void> {
    status = { ...status, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND };
        return;
      }
      // Join a generation the preceding op just completed.
      if (generatedInQueue) return;
      await runCtags();
    } catch (err: unknown) {
      status = { ...status, engine: "none", lastError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Operation coordinator. Queued ops run after the active op settles. */
  function coordinate(op: () => Promise<void>): Promise<void> {
    pendingOps += 1;
    status = { ...status, isBuilding: true };
    const run = inFlight ? inFlight.then(op, op) : op();
    const tracked = run.finally(() => {
      inFlight = null;
      pendingOps -= 1;
      if (pendingOps === 0) {
        generatedInQueue = false;
        status = { ...status, isBuilding: false };
      }
    });
    inFlight = tracked;
    return tracked;
  }

  function ensure(): Promise<void> {
    return coordinate(runEnsure);
  }

  function regenerate(): Promise<void> {
    return coordinate(runRegenerate);
  }

  function getStatus(): TagsStatus {
    return status;
  }

  return { ensure, regenerate, getStatus };
}
