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
 * One operation coordinator guards all work. The queue tail is a permanent
 * promise chain, so operations never overlap and no older finalizer can
 * clear a newer request. Same-kind concurrent calls share one promise,
 * including failures. A queued request joins a ctags attempt that started
 * after it was scheduled, so a `regenerate()` behind a generating `ensure()`
 * shares one ctags command.
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
  // Permanent queue tail. Each distinct request runs only after the
  // previous request settles, so ctags processes never overlap.
  let tail: Promise<void> = Promise.resolve();
  // Distinct in-flight or queued ensure request. Same-kind calls join it.
  let ensureRequest: Promise<void> | null = null;
  // Distinct in-flight or queued regenerate request. Same-kind calls join it.
  let regenerateRequest: Promise<void> | null = null;
  // Number of distinct queued and active requests. isBuilding stays true
  // until this is 0. Coalesced callers do not increment it.
  let pendingDistinct = 0;
  // Monotonic ctags attempt counter. Incremented before every ctags
  // executor call. A request whose observed count is stale at execution
  // time joins the intervening attempt.
  let ctagsAttemptId = 0;

  /** Probe readtags once per manager instance. */
  function probeReadtags(): Promise<boolean> {
    probeResult ??= executor("readtags", ["--version"], { cwd, timeout: PROBE_TIMEOUT_MS }).then(
      (result) => {
        // pi.exec resolves a killed run with code 0. A killed probe must
        // disable the feature like a missing readtags.
        if (result.killed) return false;
        return result.code === 0;
      },
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
      status = { ...status, engine: "none", fileSizeBytes: 0, mtime: null, lastError };
      return;
    }
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

    // A queued request uses this count to join this attempt.
    ctagsAttemptId += 1;

    let result: ExecResult;
    try {
      result = await executor("ctags", args, { cwd, timeout: ctagsTimeout });
    } catch {
      await recordOutcome(CTAGS_NOT_FOUND);
      return;
    }

    // pi.exec resolves a killed run with code 0. A killed ctags must never
    // mark the file as generated, even when a partial file exists.
    if (result.killed) {
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

  /**
   * One uncoordinated ensure. The coordinator guards concurrency.
   * Joins a ctags attempt that started after this request was scheduled.
   */
  async function runEnsure(observedAttempt: number): Promise<void> {
    if (ctagsAttemptId !== observedAttempt) return;
    status = { ...status, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND };
        return;
      }
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

  /**
   * One uncoordinated regenerate. The coordinator guards concurrency.
   * Joins a ctags attempt that started after this request was scheduled.
   */
  async function runRegenerate(observedAttempt: number): Promise<void> {
    if (ctagsAttemptId !== observedAttempt) return;
    status = { ...status, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND };
        return;
      }
      await runCtags();
    } catch (err: unknown) {
      status = { ...status, engine: "none", lastError: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Operation coordinator. Queued requests run after the active request
   * settles. Same-kind concurrent calls share one promise, including
   * failures. Each finalizer clears its own request pointer only.
   */
  function coordinate(kind: "ensure" | "regenerate"): Promise<void> {
    if (kind === "ensure" && ensureRequest !== null) return ensureRequest;
    if (kind === "regenerate" && regenerateRequest !== null) return regenerateRequest;

    pendingDistinct += 1;
    status = { ...status, isBuilding: true };
    const observedAttempt = ctagsAttemptId;
    const run = kind === "ensure" ? () => runEnsure(observedAttempt) : () => runRegenerate(observedAttempt);
    // The settled chain cannot reject, so a failure never poisons the tail.
    const request = tail.then(run, run).then(finish, finish);
    tail = request;
    if (kind === "ensure") ensureRequest = request;
    else regenerateRequest = request;
    return request;

    function finish(): void {
      pendingDistinct -= 1;
      // Clear only when this finalizer still owns the request pointer.
      if (ensureRequest === request) ensureRequest = null;
      if (regenerateRequest === request) regenerateRequest = null;
      if (pendingDistinct === 0) status = { ...status, isBuilding: false };
    }
  }

  function ensure(): Promise<void> {
    return coordinate("ensure");
  }

  function regenerate(): Promise<void> {
    return coordinate("regenerate");
  }

  function getStatus(): TagsStatus {
    return status;
  }

  return { ensure, regenerate, getStatus };
}
