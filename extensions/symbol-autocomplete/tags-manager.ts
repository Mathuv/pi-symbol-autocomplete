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

import { randomUUID } from "node:crypto";
import { rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

/** The two operation kinds the coordinator serializes. */
type RequestKind = "ensure" | "regenerate";

/** Return the Node error code (e.g. "ENOENT") for an error, or "". */
function errorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
}

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

  // Manager lifetime. shutdown() aborts it; every executor call passes
  // its signal so pi.exec kills the child. The probe and ctags share it.
  const lifetimeController = new AbortController();
  // True after shutdown(). An obsolete manager never publishes tags and
  // accepts no new work.
  let obsolete = false;
  // The settled shutdown promise. shutdown() is idempotent.
  let shutdownPromise: Promise<void> | null = null;

  let probeResult: Promise<boolean> | null = null;
  // Permanent queue tail. Each distinct request runs only after the
  // previous request settles, so ctags processes never overlap.
  let tail: Promise<void> = Promise.resolve();
  // Distinct in-flight or queued request per kind. Same-kind calls join it.
  const requests = new Map<RequestKind, Promise<void>>();
  // Number of distinct queued and active requests. isBuilding stays true
  // until this is 0. Coalesced callers do not increment it.
  let pendingDistinct = 0;
  // First operation failure, surfaced by shutdown().
  let operationFailure: unknown = null;
  // Monotonic ctags attempt counter. Incremented before every ctags
  // executor call. A request whose observed count is stale at execution
  // time joins the intervening attempt.
  let ctagsAttemptId = 0;

  /** Probe readtags once per manager instance. */
  function probeReadtags(): Promise<boolean> {
    probeResult ??= executor("readtags", ["--version"], {
      cwd,
      timeout: PROBE_TIMEOUT_MS,
      signal: lifetimeController.signal,
    }).then(
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
      const code = errorCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }
  }

  /**
   * Update the status from the file on disk after a ctags attempt.
   * A missing file clears size and mtime; the engine becomes `none`.
   * A failed stat keeps the current engine and metadata; only the error
   * changes, so the stat failure never hides the operation failure.
   */
  async function recordOutcome(lastError: string | null): Promise<void> {
    let info: { size: number; mtime: number } | null;
    try {
      info = await statTags();
    } catch {
      status = { ...status, lastError };
      return;
    }
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
    // An obsolete manager never starts new work.
    if (obsolete) return;
    // ctags writes to a unique temporary file in the tags directory. The
    // live file is replaced atomically only after a complete build, so a
    // failed build never leaves a partial live tags file.
    const tempTagsPath = join(dirname(resolvedTagsPath), `.tags.tmp-${process.pid}-${randomUUID()}`);
    const args = [
      "--recurse",
      "--sort=foldcase",
      "--fields=+KznZe",
      ...buildExcludeArgs(extraExcludes),
      "-f",
      tempTagsPath,
      ".",
    ];

    // A queued request uses this count to join this attempt.
    ctagsAttemptId += 1;

    // The ctags or rename failure. A failed cleanup appends its own
    // context to this instead of replacing the primary failure.
    let primaryError: string | null = null;

    try {
      let result: ExecResult;
      try {
        result = await executor("ctags", args, {
          cwd,
          timeout: ctagsTimeout,
          signal: lifetimeController.signal,
        });
      } catch {
        primaryError = CTAGS_NOT_FOUND;
        await recordOutcome(primaryError);
        return;
      }

      // pi.exec resolves a killed run with code 0. A killed ctags must
      // never publish the temp file, even when a partial file exists.
      if (result.killed) {
        primaryError = "ctags timed out";
        await recordOutcome(primaryError);
        return;
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || `ctags exited with code ${result.code}`;
        primaryError = `${detail} — ${CTAGS_HINT}`;
        await recordOutcome(primaryError);
        return;
      }

      // The executor may ignore the abort signal and return code 0 after
      // shutdown. An obsolete manager checks immediately before rename so
      // it never publishes a late build.
      if (obsolete) return;

      try {
        // Atomically replace the live file only with a complete build.
        await rename(tempTagsPath, resolvedTagsPath);
      } catch {
        primaryError = "ctags failed to write the tags file";
        await recordOutcome(primaryError);
        return;
      }
      await recordOutcome(null);
    } finally {
      // Never leave a partial temp file behind. ENOENT means the rename
      // already moved it; the live file is never replaced on failure.
      // Any other cleanup error rejects the operation with the primary
      // failure appended, so shutdown surfaces both failures.
      try {
        await unlink(tempTagsPath);
      } catch (err: unknown) {
        if (errorCode(err) !== "ENOENT") {
          const cleanup = `failed to remove temporary tags file ${tempTagsPath}: ${err instanceof Error ? err.message : String(err)}`;
          throw new Error(primaryError === null ? cleanup : `${primaryError} — ${cleanup}`);
        }
      }
    }
  }

  /**
   * One uncoordinated build. The coordinator guards concurrency.
   * Joins a ctags attempt that started after this request was scheduled.
   * `useExisting` keeps an existing tags file instead of a new build.
   */
  async function runBuild(observedAttempt: number, useExisting: boolean): Promise<void> {
    if (obsolete) return;
    if (ctagsAttemptId !== observedAttempt) return;
    status = { ...status, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND };
        return;
      }
      if (useExisting) {
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
      }

      await runCtags();
    } catch (err: unknown) {
      // A valid live file keeps the tags-file engine; a missing file
      // clears to none. The catch never hides the primary failure.
      await recordOutcome(err instanceof Error ? err.message : String(err));
      // A failed temporary-file cleanup must reject the operation.
      throw err;
    }
  }

  /**
   * Operation coordinator. Queued requests run after the active request
   * settles. Same-kind concurrent calls share one promise, including
   * failures. Each finalizer clears its own request entry only.
   */
  function coordinate(kind: RequestKind): Promise<void> {
    // After shutdown, calls become safe no-ops.
    if (obsolete) return Promise.resolve();
    const active = requests.get(kind);
    if (active !== undefined) return active;

    pendingDistinct += 1;
    status = { ...status, isBuilding: true };
    const observedAttempt = ctagsAttemptId;
    const run = () => runBuild(observedAttempt, kind === "ensure");
    // The settled tail cannot reject, so a failure never poisons the queue.
    // The request rejects so callers and shutdown see the failure.
    const request = tail.then(run, run).then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        operationFailure ??= error;
        throw error;
      },
    );
    tail = request.then(
      () => undefined,
      () => undefined,
    );
    requests.set(kind, request);
    return request;

    function finish(): void {
      pendingDistinct -= 1;
      // Clear only when this finalizer still owns the request entry.
      if (requests.get(kind) === request) requests.delete(kind);
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

  /**
   * Stop the manager. Idempotent. Marks the manager obsolete, aborts the
   * lifetime signal, and resolves after queued and active work settles.
   */
  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise;
    // Mark obsolete before reading the tail: any coordinate call after
    // this point returns immediately and never appends to the tail.
    obsolete = true;
    lifetimeController.abort();
    shutdownPromise = tail.then(() => {
      // A failed temporary-file cleanup rejects shutdown after the queue
      // settles, instead of reporting a successful cleanup.
      if (operationFailure !== null) throw operationFailure;
    });
    return shutdownPromise;
  }

  return { ensure, regenerate, getStatus, shutdown };
}
