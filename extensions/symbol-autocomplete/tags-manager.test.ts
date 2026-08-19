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
 * - Coordinator: one ctags process at a time, join semantics, isBuilding
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

/** A promise resolved manually by the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface MockOptions {
  readtagsCode?: number;
  readtagsKilled?: boolean;
  ctagsCode?: number;
  ctagsStderr?: string;
  ctagsKilled?: boolean;
  ctagsThrows?: boolean;
  /** ctags waits on this gate before producing its result. */
  ctagsGate?: { promise: Promise<void> };
  /** Called when the ctags executor is entered, before the gate. */
  onCtagsStart?: () => void;
  /** Runs before a ctags result is returned. Use to create the tags file. */
  onCtags?: (args: string[]) => void;
}

function createMockExecutor(options: MockOptions = {}): {
  executor: Executor;
  calls: Array<{ command: string; args: string[] }>;
  tracker: { activeCtags: number; maxActiveCtags: number };
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const tracker = { activeCtags: 0, maxActiveCtags: 0 };
  const executor: Executor = async (command, args, _execOptions) => {
    calls.push({ command, args });
    if (command === "readtags") {
      return {
        code: options.readtagsCode ?? 0,
        stdout: "Universal Ctags 6.1.0",
        stderr: "",
        killed: options.readtagsKilled ?? false,
      };
    }
    if (command === "ctags") {
      options.onCtagsStart?.();
      tracker.activeCtags += 1;
      tracker.maxActiveCtags = Math.max(tracker.maxActiveCtags, tracker.activeCtags);
      try {
        if (options.ctagsGate) await options.ctagsGate.promise;
        options.onCtags?.(args);
        if (options.ctagsThrows) throw new Error("spawn ctags ENOENT");
        return {
          code: options.ctagsCode ?? 0,
          stdout: "",
          stderr: options.ctagsStderr ?? "",
          killed: options.ctagsKilled ?? false,
        };
      } finally {
        tracker.activeCtags -= 1;
      }
    }
    // pi.exec resolves missing executables; it does not reject.
    return { code: 1, stdout: "", stderr: "", killed: false };
  };
  return { executor, calls, tracker };
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

  void it("disables with an install hint when the readtags probe is killed", async () => {
    const { executor, calls } = createMockExecutor({ readtagsKilled: true });

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

  void it("regenerate() joins an in-flight ensure() generation", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const ctagsGate = deferred();
      const started = deferred();
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        ctagsGate,
        onCtagsStart: () => started.resolve(),
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const ensurePromise = manager.ensure();
      const regeneratePromise = manager.regenerate();

      await started.promise;
      assert.equal(manager.getStatus().isBuilding, true);
      ctagsGate.resolve();
      await Promise.all([ensurePromise, regeneratePromise]);

      assert.equal(ctagsRuns, 1);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, { timeout: 5_000 });

  void it("regenerate() queues after an ensure() that finds an existing file", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const ctagsGate = deferred();
      const started = deferred();
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        ctagsGate,
        onCtagsStart: () => started.resolve(),
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const ensurePromise = manager.ensure();
      const regeneratePromise = manager.regenerate();

      // The regenerate's ctags runs only after the ensure settled: the
      // engine still says tags-file while the ctags process is gated.
      await started.promise;
      assert.equal(manager.getStatus().engine, "tags-file");
      assert.equal(manager.getStatus().isBuilding, true);
      ctagsGate.resolve();
      await Promise.all([ensurePromise, regeneratePromise]);

      assert.equal(ctagsRuns, 1);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, { timeout: 5_000 });

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

// ── coordinator serialization ───────────────────────────────────────

void describe("tags manager coordinator", () => {
  void it("never runs two ctags processes and keeps isBuilding true with three queued requests", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const ctagsGate = deferred();
      const started = deferred();
      let ctagsRuns = 0;
      const { executor, tracker } = createMockExecutor({
        ctagsGate,
        onCtagsStart: () => started.resolve(),
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const ensurePromise = manager.ensure(); // finds the existing file, no ctags
      const regeneratePromise = manager.regenerate(); // runs ctags, gated
      await ensurePromise;
      // A third distinct request queues behind the active regenerate.
      const thirdPromise = manager.ensure();

      // The regenerate's ctags is in flight and the third request is queued.
      await started.promise;
      assert.equal(manager.getStatus().isBuilding, true);
      assert.equal(tracker.maxActiveCtags, 1);

      ctagsGate.resolve();
      await Promise.all([regeneratePromise, thirdPromise]);

      assert.equal(ctagsRuns, 1);
      assert.equal(tracker.maxActiveCtags, 1);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, { timeout: 5_000 });

  void it("shares one failed ctags attempt across concurrent ensures", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);

      assert.equal(calls.filter((c) => c.command === "ctags").length, 1);
      assert.equal(manager.getStatus().engine, "none");
      assert.match(manager.getStatus().lastError ?? "", /boom/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("shares one failed ctags attempt across concurrent regenerates", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await Promise.all([manager.regenerate(), manager.regenerate(), manager.regenerate()]);

      assert.equal(calls.filter((c) => c.command === "ctags").length, 1);
      assert.equal(manager.getStatus().engine, "none");
      assert.match(manager.getStatus().lastError ?? "", /boom/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("runs one failed ctags attempt for a missing-file ensure with a queued regenerate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await Promise.all([manager.ensure(), manager.regenerate()]);

      assert.equal(calls.filter((c) => c.command === "ctags").length, 1);
      assert.equal(manager.getStatus().engine, "none");
      assert.match(manager.getStatus().lastError ?? "", /boom/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("makes a fresh ctags attempt for each later non-concurrent regenerate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      const { executor, calls } = createMockExecutor({ onCtags: writeTagsAt });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      await manager.regenerate();
      await manager.regenerate();

      assert.equal(calls.filter((c) => c.command === "ctags").length, 3);
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
