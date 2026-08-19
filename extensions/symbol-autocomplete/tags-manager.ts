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
  let inFlightEnsure: Promise<void> | null = null;
  let inFlightRegenerate: Promise<void> | null = null;

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

  /** Generate the tags file with ctags. Output goes to the file. */
  async function generate(): Promise<void> {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await recordCtagsOutcome(/ENOENT|not found/i.test(message) ? CTAGS_NOT_FOUND : message);
      return;
    }

    if (result.code !== 0) {
      await recordCtagsOutcome(result.stderr.trim() || `ctags exited with code ${result.code}`);
      return;
    }

    await recordCtagsOutcome(null);
  }

  /**
   * Update the status after a ctags attempt.
   * Uses the file on disk when it exists; otherwise the engine is `none`.
   */
  async function recordCtagsOutcome(lastError: string | null): Promise<void> {
    const info = await statTags();
    if (info === null) {
      status = { ...status, engine: "none", lastError, isBuilding: false };
      return;
    }
    status = {
      engine: lastError === null ? "generated" : "tags-file",
      tagsPath: resolvedTagsPath,
      fileSizeBytes: info.size,
      mtime: info.mtime,
      lastError,
      isBuilding: false,
    };
  }

  async function runEnsure(): Promise<void> {
    status = { ...status, isBuilding: true, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND, isBuilding: false };
        return;
      }

      const info = await statTags();
      if (info !== null) {
        status = {
          ...status,
          engine: "tags-file",
          fileSizeBytes: info.size,
          mtime: info.mtime,
          isBuilding: false,
        };
        return;
      }

      await generate();
    } catch (err: unknown) {
      status = {
        ...status,
        engine: "none",
        lastError: err instanceof Error ? err.message : String(err),
        isBuilding: false,
      };
    }
  }

  async function runRegenerate(): Promise<void> {
    status = { ...status, isBuilding: true, lastError: null };
    try {
      if (!(await probeReadtags())) {
        status = { ...status, engine: "none", lastError: READTAGS_NOT_FOUND, isBuilding: false };
        return;
      }
      await generate();
    } catch (err: unknown) {
      status = {
        ...status,
        engine: "none",
        lastError: err instanceof Error ? err.message : String(err),
        isBuilding: false,
      };
    }
  }

  function ensure(): Promise<void> {
    inFlightEnsure ??= runEnsure().finally(() => {
      inFlightEnsure = null;
    });
    return inFlightEnsure;
  }

  function regenerate(): Promise<void> {
    inFlightRegenerate ??= runRegenerate().finally(() => {
      inFlightRegenerate = null;
    });
    return inFlightRegenerate;
  }

  function getStatus(): TagsStatus {
    return status;
  }

  return { ensure, regenerate, getStatus };
}
