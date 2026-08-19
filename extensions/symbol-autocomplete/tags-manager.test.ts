/**
 * Tests for the tags file lifecycle manager.
 *
 * Covers:
 * - Existing tags file used as-is (no ctags call)
 * - Missing file triggers generation with the correct ctags flags
 * - readtags probe failure → engine `none` with install hint
 * - ctags failure with no tags file → engine `none`
 * - regenerate() always runs ctags
 * - Concurrent ensure() calls coalesce into one build
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, Executor } from "./types.ts";
import { createTagsManager } from "./tags-manager.ts";
import { DEFAULT_EXCLUDES } from "./types.ts";

const SAMPLE_TAGS = [
  "!_TAG_FILE_FORMAT\t2\t/extended format/",
  "MyService\tsrc/service.ts\t/^class MyService$/;\"\tc\tline:4",
].join("\n") + "\n";

interface MockOptions {
  readtagsCode?: number;
  ctagsCode?: number;
  ctagsStderr?: string;
  ctagsKilled?: boolean;
  ctagsThrows?: boolean;
  delayMs?: number;
  /** Runs before a ctags result is returned. Use to create the tags file. */
  onCtags?: (args: string[]) => void;
}

function createMockExecutor(options: MockOptions = {}): {
  executor: Executor;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const executor: Executor = async (command, args, _execOptions) => {
    calls.push({ command, args });
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (command === "readtags") {
      return {
        code: options.readtagsCode ?? 0,
        stdout: "Universal Ctags 6.1.0",
        stderr: "",
      };
    }
    if (command === "ctags") {
      options.onCtags?.(args);
      if (options.ctagsThrows) throw new Error("spawn ctags ENOENT");
      return {
        code: options.ctagsCode ?? 0,
        stdout: "",
        stderr: options.ctagsStderr ?? "",
        killed: options.ctagsKilled,
      };
    }
    // pi.exec resolves missing executables; it does not reject.
    return { code: 1, stdout: "", stderr: "", killed: false };
  };
  return { executor, calls };
}

/** Write a sample tags file into the directory. Returns the file path. */
function writeSampleTags(dir: string): string {
  const tagsPath = path.join(dir, "tags");
  fs.writeFileSync(tagsPath, SAMPLE_TAGS);
  return tagsPath;
}

/** Write the tags file that a successful ctags run would create. */
function writeTagsAt(args: string[]): void {
  const fIndex = args.indexOf("-f");
  const tagsPath = args[fIndex + 1];
  if (!tagsPath) throw new Error(`ctags args missing -f: ${args.join(" ")}`);
  fs.writeFileSync(tagsPath, SAMPLE_TAGS);
}

function ctagsFlags(): string[] {
  const flags = ["--recurse", "--sort=foldcase", "--fields=+KznZe"];
  for (const exclude of DEFAULT_EXCLUDES) {
    flags.push(`--exclude=${exclude}`);
  }
  return flags;
}

// ── ensure() ────────────────────────────────────────────────────────

void describe("tags manager ensure()", () => {
  void it("uses an existing tags file as-is and never runs ctags", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const tagsPath = writeSampleTags(tmpDir);
      const { executor, calls } = createMockExecutor();

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.equal(status.tagsPath, tagsPath);
      assert.ok(status.fileSizeBytes > 0);
      assert.ok(status.mtime !== null);
      assert.equal(status.lastError, null);
      assert.equal(calls.filter((c) => c.command === "ctags").length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("generates a missing tags file with sort, fields, and exclude flags", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ onCtags: writeTagsAt });

      const manager = createTagsManager({
        cwd: tmpDir,
        executor,
        extraExcludes: ["custom-dir"],
      });
      await manager.ensure();

      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().lastError, null);

      const ctagsCalls = calls.filter((c) => c.command === "ctags");
      assert.equal(ctagsCalls.length, 1);
      const args = ctagsCalls[0].args;
      for (const flag of ctagsFlags()) {
        assert.ok(args.includes(flag), `expected ${flag} in ctags args`);
      }
      assert.ok(args.some((a) => a.startsWith("--exclude=")), "expected extraExcludes in ctags args");
      assert.ok(args.includes("--exclude=custom-dir"), "expected custom-dir in ctags args");
      assert.equal(args[args.indexOf("-f") + 1], path.join(tmpDir, "tags"));
      assert.equal(args.at(-1), ".");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("disables with an install hint when the readtags probe fails", async () => {
    const { executor, calls } = createMockExecutor({ readtagsCode: 1 });

    const manager = createTagsManager({ cwd: "/project", executor });
    await manager.ensure();

    const status = manager.getStatus();
    assert.equal(status.engine, "none");
    assert.match(status.lastError ?? "", /readtags not found.*install universal-ctags/);
    assert.equal(calls.filter((c) => c.command === "ctags").length, 0);
  });

  void it("reports engine none when ctags fails and no tags file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "parse error" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /parse error.*install universal-ctags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("reports the install hint when ctags is missing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor } = createMockExecutor({ ctagsThrows: true });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /ctags not found.*install universal-ctags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("reports the install hint when ctags resolves missing with code 1", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({
        ctagsCode: 1,
        ctagsStderr: "ctags: command not found",
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /ctags: command not found.*install universal-ctags/);
      assert.equal(calls.filter((c) => c.command === "ctags").length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("never marks a killed ctags run as generated even with a partial file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor } = createMockExecutor({
        ctagsKilled: true,
        ctagsCode: 0,
        onCtags: writeTagsAt,
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.match(status.lastError ?? "", /ctags timed out/);
      assert.ok(status.fileSizeBytes > 0, "partial file must keep its size");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("clears stale metadata when a deleted tags file fails to regenerate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const { executor } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");
      assert.ok(manager.getStatus().fileSizeBytes > 0);
      assert.ok(manager.getStatus().mtime !== null);

      fs.rmSync(path.join(tmpDir, "tags"));
      await manager.regenerate();

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.equal(status.fileSizeBytes, 0);
      assert.equal(status.mtime, null);
      assert.match(status.lastError ?? "", /boom.*install universal-ctags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("regenerate() joins an in-flight ensure() generation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        delayMs: 20,
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      let buildingWhileRegenerateQueued: boolean | null = null;
      const ensurePromise = manager.ensure().then(() => {
        buildingWhileRegenerateQueued = manager.getStatus().isBuilding;
      });
      const regeneratePromise = manager.regenerate();
      await Promise.all([ensurePromise, regeneratePromise]);

      assert.equal(ctagsRuns, 1);
      assert.equal(buildingWhileRegenerateQueued, true);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("regenerate() queues after an ensure() that finds an existing file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        delayMs: 20,
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      writeSampleTags(tmpDir);
      const manager = createTagsManager({ cwd: tmpDir, executor });
      const states: string[] = [];
      const ensurePromise = manager.ensure().then(() => {
        states.push(manager.getStatus().isBuilding ? "building" : "settled");
      });
      const regeneratePromise = manager.regenerate();
      await Promise.all([ensurePromise, regeneratePromise]);
      states.push(manager.getStatus().isBuilding ? "building" : "settled");

      assert.equal(ctagsRuns, 1);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
      assert.deepEqual(states, ["building", "settled"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("keeps an existing file with a tags-file engine when regeneration fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const { executor } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await manager.regenerate();

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.match(status.lastError ?? "", /boom.*install universal-ctags/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("coalesces concurrent ensure() calls into one build", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        delayMs: 20,
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);

      assert.equal(ctagsRuns, 1);
      assert.equal(manager.getStatus().engine, "generated");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── regenerate() ────────────────────────────────────────────────────

void describe("tags manager regenerate()", () => {
  void it("always runs ctags, even when a tags file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const { executor, calls } = createMockExecutor({ onCtags: writeTagsAt });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await manager.regenerate();

      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(calls.filter((c) => c.command === "ctags").length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("probes readtags only once across ensure() and regenerate()", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ onCtags: writeTagsAt });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      await manager.regenerate();

      assert.equal(calls.filter((c) => c.command === "readtags").length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("disables with an install hint when readtags is missing", async () => {
    const { executor } = createMockExecutor({ readtagsCode: 1 });

    const manager = createTagsManager({ cwd: "/project", executor });
    await manager.regenerate();

    const status = manager.getStatus();
    assert.equal(status.engine, "none");
    assert.match(status.lastError ?? "", /readtags not found.*install universal-ctags/);
  });
});

// ── status shape ────────────────────────────────────────────────────

void describe("tags manager status", () => {
  void it("starts at engine none before the first call", () => {
    const { executor } = createMockExecutor();
    const manager = createTagsManager({ cwd: "/project", executor });

    const status = manager.getStatus();
    assert.equal(status.engine, "none");
    assert.equal(status.isBuilding, false);
    assert.equal(status.tagsPath, path.resolve("/project", "tags"));
    assert.equal(status.fileSizeBytes, 0);
    assert.equal(status.mtime, null);
    assert.equal(status.lastError, null);
  });
});
