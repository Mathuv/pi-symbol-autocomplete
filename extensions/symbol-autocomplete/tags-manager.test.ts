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
      const tagsTarget = args[args.indexOf("-f") + 1];
      assert.ok(
        tagsTarget.startsWith(tmpDir + path.sep),
        "ctags must write a temp file in the tags directory",
      );
      assert.notEqual(tagsTarget, path.join(tmpDir, "tags"), "ctags must not write the live file directly");
      assert.ok(fs.existsSync(path.join(tmpDir, "tags")), "a complete build must publish the tags file");
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

  void it("removes the partial temp file and never marks a killed ctags run as generated", async () => {
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
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /ctags timed out/);
      assert.equal(status.fileSizeBytes, 0);
      assert.equal(
        fs.existsSync(path.join(tmpDir, "tags")),
        false,
        "a killed build must never publish a partial file",
      );
      assert.deepEqual(fs.readdirSync(tmpDir), [], "the partial temp file must be removed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("removes the partial temp file after a failed initial build", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      // ctags writes partial output to its temp file, then fails.
      const { executor } = createMockExecutor({
        ctagsCode: 1,
        ctagsStderr: "boom",
        onCtags: writeTagsAt,
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /boom/);
      assert.equal(fs.existsSync(path.join(tmpDir, "tags")), false);
      assert.deepEqual(fs.readdirSync(tmpDir), [], "the partial temp file must be removed");
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
  });

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
  });

  void it("keeps an existing file with a tags-file engine when regeneration fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const original = fs.readFileSync(path.join(tmpDir, "tags"), "utf8");
      const { executor } = createMockExecutor({ ctagsCode: 1, ctagsStderr: "boom" });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await manager.regenerate();

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.match(status.lastError ?? "", /boom.*install universal-ctags/);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "tags"), "utf8"),
        original,
        "a failed regeneration must not touch the live file",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("atomically replaces the live file only after a complete build", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      writeSampleTags(tmpDir);
      const { executor } = createMockExecutor({
        onCtags: (args) => {
          const target = args[args.indexOf("-f") + 1];
          assert.notEqual(target, path.join(tmpDir, "tags"), "ctags must write a temp file");
          fs.writeFileSync(target, "NewClass\tsrc/new.ts\t/^class NewClass$/;\"\tc\tline:1\n");
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await manager.regenerate();

      assert.equal(manager.getStatus().engine, "generated");
      assert.match(fs.readFileSync(path.join(tmpDir, "tags"), "utf8"), /NewClass/);
      assert.deepEqual(
        fs.readdirSync(tmpDir).filter((f) => f.startsWith(".tags.tmp-")),
        [],
        "no temp file may remain after a complete build",
      );
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
  void it("runs a queued ensure's ctags only after a failed regenerate settles", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    try {
      // The first ensure finds an existing file, so it never runs ctags.
      writeSampleTags(tmpDir);
      const gates = [deferred(), deferred()];
      const attemptStarted = [deferred(), deferred()];
      const events: string[] = [];
      let ctagsRuns = 0;
      let activeCtags = 0;
      let maxActiveCtags = 0;
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          const attempt = ctagsRuns + 1;
          ctagsRuns += 1;
          events.push(`start${attempt}`);
          attemptStarted[attempt - 1].resolve();
          activeCtags += 1;
          maxActiveCtags = Math.max(maxActiveCtags, activeCtags);
          try {
            await gates[attempt - 1].promise;
            if (attempt === 1) {
              // The first attempt fails without recreating the tags file.
              return { code: 1, stdout: "", stderr: "boom", killed: false };
            }
            writeTagsAt(args);
            return { code: 0, stdout: "", stderr: "", killed: false };
          } finally {
            events.push(`end${attempt}`);
            activeCtags -= 1;
          }
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const ensurePromise = manager.ensure(); // probes and stats only
      const regeneratePromise = manager.regenerate(); // ctags attempt 1, gated
      await ensurePromise;

      await attemptStarted[0].promise;
      assert.equal(manager.getStatus().isBuilding, true);
      assert.equal(maxActiveCtags, 1);

      // Remove the file before the third request executes, so its ensure
      // must run ctags instead of only stat'ing.
      fs.rmSync(path.join(tmpDir, "tags"));
      const thirdPromise = manager.ensure(); // queued behind the regenerate

      // The first attempt fails. The queued ensure's ctags may start only
      // after the regenerate settled, so attempt 1 must end first.
      gates[0].resolve();
      await attemptStarted[1].promise;
      assert.deepEqual(events, ["start1", "end1", "start2"]);
      assert.equal(manager.getStatus().isBuilding, true);
      assert.equal(fs.existsSync(path.join(tmpDir, "tags")), false);
      assert.equal(maxActiveCtags, 1);

      gates[1].resolve();
      await Promise.all([regeneratePromise, thirdPromise]);

      assert.deepEqual(events, ["start1", "end1", "start2", "end2"]);
      assert.equal(ctagsRuns, 2);
      assert.equal(maxActiveCtags, 1);
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("starts a fresh ctags attempt for a regenerate queued after a later attempt began", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tm-"));
    const gates = [deferred(), deferred(), deferred()];
    try {
      // No tags file exists, so every request must run ctags.
      const attemptStarted = [deferred(), deferred(), deferred()];
      const events: string[] = [];
      let ctagsRuns = 0;
      let activeCtags = 0;
      let maxActiveCtags = 0;
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          const attempt = ctagsRuns + 1;
          ctagsRuns += 1;
          events.push(`start${attempt}`);
          attemptStarted[attempt - 1].resolve();
          activeCtags += 1;
          maxActiveCtags = Math.max(maxActiveCtags, activeCtags);
          try {
            await gates[attempt - 1].promise;
            if (attempt < 3) {
              // The first two attempts fail without creating the tags file.
              return { code: 1, stdout: "", stderr: "boom", killed: false };
            }
            writeTagsAt(args);
            return { code: 0, stdout: "", stderr: "", killed: false };
          } finally {
            events.push(`end${attempt}`);
            activeCtags -= 1;
          }
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const regeneratePromise = manager.regenerate(); // ctags attempt 1, gated
      await attemptStarted[0].promise;
      const ensurePromise = manager.ensure(); // queued behind attempt 1
      gates[0].resolve();
      await attemptStarted[1].promise; // ensure ctags attempt 2, gated
      // This request arrived after attempt 2 began. It must queue behind
      // attempt 2 and run a fresh attempt, not join attempt 2.
      const secondRegeneratePromise = manager.regenerate();

      // The third request must not start a ctags process while attempt 2
      // is still gated.
      assert.deepEqual(events, ["start1", "end1", "start2"]);
      assert.equal(maxActiveCtags, 1);
      assert.equal(ctagsRuns, 2);
      assert.equal(manager.getStatus().isBuilding, true);

      gates[1].resolve();
      await attemptStarted[2].promise;
      gates[2].resolve();
      await Promise.all([ensurePromise, regeneratePromise, secondRegeneratePromise]);

      assert.deepEqual(events, ["start1", "end1", "start2", "end2", "start3", "end3"]);
      assert.equal(ctagsRuns, 3);
      assert.equal(maxActiveCtags, 1);
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      // Release every gate so a failed assertion cannot leave gated
      // promises hanging.
      for (const gate of gates) gate.resolve();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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

// ── shutdown() ──────────────────────────────────────────────────────

void describe("tags manager shutdown()", () => {
  void it("aborts in-flight work and settles queued work before resolving", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-shut-"));
    const gates = [deferred(), deferred()];
    const attemptStarted = [deferred(), deferred()];
    const signalByAttempt: Array<AbortSignal | undefined> = [];
    try {
      const executor: Executor = async (command, args, execOptions) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          const attempt = signalByAttempt.length + 1;
          signalByAttempt.push(execOptions?.signal);
          attemptStarted[attempt - 1].resolve();
          await gates[attempt - 1].promise;
          // This executor ignores the abort signal and returns code 0.
          writeTagsAt(args);
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const regeneratePromise = manager.regenerate(); // attempt 1, gated
      await attemptStarted[0].promise;
      const ensurePromise = manager.ensure(); // queued behind attempt 1

      const shutdownPromise = manager.shutdown();
      // The lifetime signal must reach the executor and be aborted.
      assert.equal(signalByAttempt[0]?.aborted, true);
      // A second shutdown call is a safe no-op that returns the same work.
      assert.equal(manager.shutdown(), shutdownPromise);

      // Release the gate during shutdown. The executor ignores the abort
      // and returns code 0, but the obsolete manager must skip the rename.
      gates[0].resolve();
      await shutdownPromise;
      await Promise.all([regeneratePromise, ensurePromise]);

      assert.equal(fs.existsSync(path.join(tmpDir, "tags")), false, "an obsolete manager must never publish");
      assert.deepEqual(
        fs.readdirSync(tmpDir).filter((f) => f.startsWith(".tags.tmp-")),
        [],
        "shutdown must leave no temp file behind",
      );
      assert.equal(manager.getStatus().engine, "none");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      gates[0].resolve();
      gates[1].resolve();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("makes ensure() and regenerate() safe no-ops after shutdown", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-shut2-"));
    try {
      let ctagsRuns = 0;
      const { executor } = createMockExecutor({
        onCtags: (args) => {
          ctagsRuns += 1;
          writeTagsAt(args);
        },
      });

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.shutdown();
      await manager.ensure();
      await manager.regenerate();

      assert.equal(ctagsRuns, 0, "no ctags may run after shutdown");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("kills an in-flight ctags via the lifetime signal", { timeout: 5_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-shut3-"));
    const started = deferred();
    try {
      const executor: Executor = async (command, args, execOptions) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          started.resolve();
          writeTagsAt(args);
          // A signal-abiding executor waits for the abort, then reports
          // the run as killed, like pi.exec does.
          await new Promise<void>((resolve) => {
            const signal = execOptions?.signal;
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { code: 0, stdout: "", stderr: "", killed: true };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      const ensurePromise = manager.ensure();
      await started.promise;
      await manager.shutdown();
      await ensurePromise;

      assert.equal(fs.existsSync(path.join(tmpDir, "tags")), false);
      assert.match(manager.getStatus().lastError ?? "", /ctags timed out/);
      assert.deepEqual(
        fs.readdirSync(tmpDir).filter((f) => f.startsWith(".tags.tmp-")),
        [],
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── temp-file cleanup failures ──────────────────────────────────────

void describe("tags manager cleanup failures", () => {
  void it("rejects the operation and shutdown when the temp file cannot be removed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean-"));
    try {
      // The fake ctags writes the temp file, then locks the directory so
      // the manager's rename and cleanup unlink fail with EACCES. The
      // read-only mode is platform-sensitive; tests run as a non-root user.
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          fs.chmodSync(tmpDir, 0o555);
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await assert.rejects(manager.ensure(), /failed to remove temporary tags file/);

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.match(status.lastError ?? "", /failed to remove temporary tags file .*\.tags\.tmp-/);
      assert.equal(status.isBuilding, false);
      assert.ok(
        fs.readdirSync(tmpDir).some((name) => name.startsWith(".tags.tmp-")),
        "the failed cleanup must leave the temp file in place",
      );

      // Shutdown rejects after the queue settles. Repeated calls return
      // the same rejected promise instead of a successful cleanup.
      fs.chmodSync(tmpDir, 0o755);
      const shutdownPromise = manager.shutdown();
      assert.equal(manager.shutdown(), shutdownPromise);
      await assert.rejects(shutdownPromise, /failed to remove temporary tags file/);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("keeps the live tags file when cleanup fails during a regenerate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean2-"));
    try {
      writeSampleTags(tmpDir);
      const original = fs.readFileSync(path.join(tmpDir, "tags"), "utf8");
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          fs.chmodSync(tmpDir, 0o555);
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await assert.rejects(manager.regenerate(), /failed to remove temporary tags file/);

      assert.equal(
        fs.readFileSync(path.join(tmpDir, "tags"), "utf8"),
        original,
        "a cleanup failure must never replace or delete the live file",
      );
      assert.match(manager.getStatus().lastError ?? "", /failed to remove temporary tags file .*\.tags\.tmp-/);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("runs a later request after a rejected cleanup failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean3-"));
    try {
      // Only the first ctags run locks the directory. The later request
      // must prove the queue does not stick after a rejection.
      let locked = false;
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          if (!locked) {
            locked = true;
            fs.chmodSync(tmpDir, 0o555);
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await assert.rejects(manager.ensure(), /failed to remove temporary tags file/);

      fs.chmodSync(tmpDir, 0o755);
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "generated");
      assert.equal(manager.getStatus().isBuilding, false);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("combines the ctags failure and the cleanup failure when the live file remains", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean4-"));
    try {
      writeSampleTags(tmpDir);
      const original = fs.readFileSync(path.join(tmpDir, "tags"), "utf8");
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          fs.chmodSync(tmpDir, 0o555);
          return { code: 1, stdout: "", stderr: "boom", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await assert.rejects(
        manager.regenerate(),
        /boom.*failed to remove temporary tags file .*\.tags\.tmp-/,
      );

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.ok(status.fileSizeBytes > 0);
      assert.ok(status.mtime !== null);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "tags"), "utf8"),
        original,
        "a failed regeneration must not touch the live file",
      );
      assert.match(
        status.lastError ?? "",
        /boom.*failed to remove temporary tags file .*\.tags\.tmp-/,
        "lastError must keep the primary ctags failure and add the cleanup path",
      );

      fs.chmodSync(tmpDir, 0o755);
      const shutdownPromise = manager.shutdown();
      assert.equal(manager.shutdown(), shutdownPromise);
      await assert.rejects(shutdownPromise, /boom.*failed to remove temporary tags file/);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("combines the rename failure and the cleanup failure when the live file remains", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean5-"));
    try {
      writeSampleTags(tmpDir);
      const original = fs.readFileSync(path.join(tmpDir, "tags"), "utf8");
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          fs.chmodSync(tmpDir, 0o555);
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "tags-file");

      await assert.rejects(
        manager.regenerate(),
        /ctags failed to write the tags file.*failed to remove temporary tags file .*\.tags\.tmp-/,
      );

      const status = manager.getStatus();
      assert.equal(status.engine, "tags-file");
      assert.ok(status.fileSizeBytes > 0);
      assert.ok(status.mtime !== null);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "tags"), "utf8"),
        original,
        "a failed publication must not touch the live file",
      );
      assert.match(
        status.lastError ?? "",
        /ctags failed to write the tags file.*failed to remove temporary tags file .*\.tags\.tmp-/,
        "lastError must keep the primary rename failure and add the cleanup path",
      );

      fs.chmodSync(tmpDir, 0o755);
      const shutdownPromise = manager.shutdown();
      await assert.rejects(shutdownPromise, /ctags failed to write the tags file.*failed to remove temporary tags file/);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("combines the ctags and cleanup failures when no live file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-clean6-"));
    try {
      const executor: Executor = async (command, args) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          writeTagsAt(args);
          fs.chmodSync(tmpDir, 0o555);
          return { code: 1, stdout: "", stderr: "boom", killed: false };
        }
        return { code: 1, stdout: "", stderr: "", killed: false };
      };

      const manager = createTagsManager({ cwd: tmpDir, executor });
      await assert.rejects(
        manager.ensure(),
        /boom.*failed to remove temporary tags file .*\.tags\.tmp-/,
      );

      const status = manager.getStatus();
      assert.equal(status.engine, "none");
      assert.equal(status.fileSizeBytes, 0);
      assert.equal(status.mtime, null);
      assert.match(
        status.lastError ?? "",
        /boom.*failed to remove temporary tags file .*\.tags\.tmp-/,
        "lastError must include both the ctags and the cleanup failure",
      );
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
