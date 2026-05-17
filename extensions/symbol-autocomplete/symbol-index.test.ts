/**
 * Tests for the symbol index engine (ctags→ast-grep fallback).
 *
 * Covers:
 * - ctags parser: JSON output → ProjectSymbol[]
 * - ast-grep parser: JSON output → ProjectSymbol[]
 * - Fallback chain: ctags success → use; ctags fail → ast-grep; both fail → empty
 * - Concurrent refresh coalescing
 * - Status tracking (engine, count, timestamps, errors)
 * - Exclude handling
 * - Variable/constant scope filtering (regression)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, Executor, SymbolIndexManager } from "./types.ts";
import { createSymbolIndexManager } from "./symbol-index.ts";
import { DEFAULT_EXCLUDES } from "./types.ts";

// Build the full ctags args list as the implementation would produce them
function ctagsArgs(): string[] {
  const args = ["--recurse", "--fields=+K+n", "--output-format=json", "."];
  for (const exclude of DEFAULT_EXCLUDES) {
    args.push("--exclude", exclude);
  }
  return args;
}

function ctagsKey(): string {
  return `ctags ${ctagsArgs().join(" ")}`;
}

/** Create a mock executor that returns canned results. */
function mockExecutor(
  results: Record<string, ExecResult>,
): { executor: Executor; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const executor: Executor = async (command, args, _options) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const result = results[key];
    if (result) return result;
    // Default: command not found
    return { code: 127, stdout: "", stderr: `command not found: ${command}` };
  };
  return { executor, calls };
}

// Mock a ctags success with given JSON lines
function mockCtagsSuccess(lines: string[]): Record<string, ExecResult> {
  return { [ctagsKey()]: { code: 0, stdout: lines.join("\n") + "\n", stderr: "" } };
}

function classicTagsFile(lines: string[]): string {
  return [
    "!_TAG_FILE_FORMAT\t2\t/extended format/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tC,constant\t/constants/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tc,class\t/classes/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tf,function\t/functions/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\ti,interface\t/interfaces/",
    ...lines,
  ].join("\n") + "\n";
}

function classicTagLine(name: string, filePath: string, kind: string, line: number, extraFields: string[] = []): string {
  return [
    name,
    filePath,
    `/^${kind} ${name}/;\"`,
    kind,
    `line:${line}`,
    "language:TypeScript",
    ...extraFields,
  ].join("\t");
}

// ── tags file parser ────────────────────────────────────────────────

void describe("tags file parser", () => {
  void it("loads a pre-built classic ctags file before running ctags", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tags-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("MyService", "src/service.ts", "c", 4),
        classicTagLine("helper", "src/helper.ts", "f", 12),
      ]));

      let commandCalls = 0;
      const executor: Executor = async () => {
        commandCalls++;
        return { code: 127, stdout: "", stderr: "should not run" };
      };

      const index = createSymbolIndexManager({ cwd: tmpDir, executor });
      await index.refresh();

      assert.equal(commandCalls, 0);
      assert.equal(index.getStatus().engine, "tags-file");
      assert.equal(index.getStatus().symbolCount, 2);
      assert.deepEqual(
        index.getSymbols().map((s) => ({ name: s.name, kind: s.kind, path: s.path, line: s.line })),
        [
          { name: "MyService", kind: "class", path: "src/service.ts", line: 4 },
          { name: "helper", kind: "function", path: "src/helper.ts", line: 12 },
        ],
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("filters scoped variables and constants from classic tags files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tags-scope-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("CONFIG", "src/config.ts", "C", 1),
        classicTagLine("localConfig", "src/config.ts", "C", 8, ["function:loadConfig"]),
        classicTagLine("localValue", "src/config.ts", "v", 9, ["function:loadConfig"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      assert.equal(index.getStatus().engine, "tags-file");
      assert.deepEqual(index.getSymbols().map((s) => s.name), ["CONFIG"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("falls back to ctags when no tags file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-no-tags-"));
    try {
      const output = JSON.stringify({ _type: "tag", name: "Fallback", path: "fallback.ts", line: 2, kind: "class" }) + "\n";
      let ctagsCalled = false;
      const executor: Executor = async (command) => {
        if (command === "ctags") {
          ctagsCalled = true;
          return { code: 0, stdout: output, stderr: "" };
        }
        return { code: 127, stdout: "", stderr: "unexpected" };
      };

      const index = createSymbolIndexManager({ cwd: tmpDir, executor });
      await index.refresh();

      assert.equal(ctagsCalled, true);
      assert.equal(index.getStatus().engine, "ctags");
      assert.equal(index.getSymbols()[0].name, "Fallback");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── ctags parser ────────────────────────────────────────────────────

void describe("ctags parser", () => {
  void it("parses a valid ctags JSON line into a ProjectSymbol", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "MyClass", path: "src/test.ts", pattern: "/^class MyClass {}$/", line: 10, kind: "class" }),
      JSON.stringify({ _type: "tag", name: "hello", path: "src/test.ts", pattern: "/^function hello() {}$/", line: 20, kind: "function" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 2);

    const myClass = symbols.find((s) => s.name === "MyClass");
    assert.ok(myClass !== undefined);
    assert.equal(myClass!.kind, "class");
    assert.equal(myClass!.path, "src/test.ts");
    assert.equal(myClass!.line, 10);

    const hello = symbols.find((s) => s.name === "hello");
    assert.ok(hello !== undefined);
    assert.equal(hello!.kind, "function");

    const status = index.getStatus();
    assert.equal(status.engine, "ctags");
    assert.equal(status.symbolCount, 2);
    assert.ok(status.lastRefresh !== null && status.lastRefresh > 0);
    assert.equal(status.lastError, null);
    assert.equal(status.isBuilding, false);
  });

  void it("filters out kinds not in DEFINITION_KINDS", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "myVar", path: "src/test.ts", line: 1, kind: "variable" }),
      JSON.stringify({ _type: "tag", name: "i", path: "src/test.ts", line: 2, kind: "local" }),
      JSON.stringify({ _type: "tag", name: "param", path: "src/test.ts", line: 3, kind: "variable" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    // "variable" is in DEFINITION_KINDS (module-level variables), but "local" is not
    assert.equal(symbols.length, 2);
    assert.equal(symbols.every((s) => s.name !== "i"), true);
  });

  void it("filters symbols to definition-level kinds only", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "MyClass", path: "src/test.ts", line: 1, kind: "class" }),
      JSON.stringify({ _type: "tag", name: "greet", path: "src/test.ts", line: 5, kind: "method", scope: "class:MyClass" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    // Both class and method are definition-level, so both pass through
    const symbols = index.getSymbols();
    assert.equal(symbols.length, 2);
  });

  // ── Variable/constant scope filtering (regression) ────────────────

  void it("excludes variable with scope (local/parameter variable)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "x", path: "src/test.ts", line: 1, kind: "variable", scope: "function:foo" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes variable with scopeKind only (no scope)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "x", path: "src/test.ts", line: 1, kind: "variable", scopeKind: "Function" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes variable with scopeKind: Local", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "x", path: "src/test.ts", line: 1, kind: "variable", scopeKind: "Local" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes variable with scopeKind: Parameter", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "x", path: "src/test.ts", line: 1, kind: "variable", scopeKind: "Parameter" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes constant with scopeKind: Local", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "LIMIT", path: "src/test.ts", line: 5, kind: "constant", scopeKind: "Local" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes constant with scopeKind: Parameter", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "LIMIT", path: "src/test.ts", line: 5, kind: "constant", scopeKind: "Parameter" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes constant with scopeKind only (no scope)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "LIMIT", path: "src/test.ts", line: 5, kind: "constant", scopeKind: "Function" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("excludes constant with scope (local const)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "LIMIT", path: "src/test.ts", line: 5, kind: "constant", scope: "function:bar" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 0);
  });

  void it("includes module-level variable (no scope)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "globalConfig", path: "src/test.ts", line: 1, kind: "variable" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "globalConfig");
    assert.equal(symbols[0].kind, "variable");
  });

  void it("includes module-level constant (no scope)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "MAX_SIZE", path: "src/test.ts", line: 1, kind: "constant" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "MAX_SIZE");
    assert.equal(symbols[0].kind, "constant");
  });

  void it("mixes scoped and unscoped variables correctly", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "GLOBAL", path: "src/test.ts", line: 1, kind: "constant" }),
      JSON.stringify({ _type: "tag", name: "localVar", path: "src/test.ts", line: 5, kind: "variable", scope: "function:bar" }),
      JSON.stringify({ _type: "tag", name: "MyClass", path: "src/test.ts", line: 10, kind: "class" }),
      JSON.stringify({ _type: "tag", name: "localConst", path: "src/test.ts", line: 12, kind: "constant", scope: "function:baz" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    // GLOBAL (constant, no scope) + MyClass (class, no scope) = 2
    assert.equal(symbols.length, 2);
    assert.ok(symbols.find((s) => s.name === "GLOBAL") !== undefined);
    assert.ok(symbols.find((s) => s.name === "MyClass") !== undefined);
    assert.equal(symbols.find((s) => s.name === "localVar"), undefined);
    assert.equal(symbols.find((s) => s.name === "localConst"), undefined);
  });
});

// ── Ast-grep pattern combinations ───────────────────────────────────

function astGrepKey(pattern: string): string {
  const args = ["run", "--pattern", pattern, "--json", "."];
  for (const exclude of DEFAULT_EXCLUDES) {
    args.push("--ignore", exclude);
  }
  return `ast-grep ${args.join(" ")}`;
}

/** Mock ctags failure + specific ast-grep pattern results. */
function mockAstGrepFallback(
  patterns: Array<{ pattern: string; result: ExecResult }>,
): Record<string, ExecResult> {
  const results: Record<string, ExecResult> = {
    // ctags fails
    [ctagsKey()]: { code: 1, stdout: "", stderr: "ctags: No files found" },
  };
  for (const { pattern, result } of patterns) {
    results[astGrepKey(pattern)] = result;
  }
  return results;
}

void describe("ast-grep parser", () => {
  void it("falls back to ast-grep when ctags fails", async () => {
    const { executor, calls } = mockExecutor(mockAstGrepFallback([
      {
        pattern: "function $NAME($$$)",
        result: {
          code: 0,
          stdout: JSON.stringify([
            {
              text: "function hello() { return 1; }",
              file: "src/test.js",
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 30 } },
              metaVariables: { single: { NAME: { text: "hello" } } },
              language: "JavaScript",
            },
          ]),
          stderr: "",
        },
      },
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    // Should have called ctags first, then ast-grep
    assert.ok(calls.length >= 2);
    assert.equal(calls[0].command, "ctags");

    const symbols = index.getSymbols();
    assert.ok(symbols.length > 0);
    assert.equal(symbols[0].name, "hello");
    assert.equal(symbols[0].kind, "function");
    assert.equal(symbols[0].path, "src/test.js");
    assert.equal(symbols[0].line, 1); // 0-indexed → 1-indexed
  });

  void it("uses ast-grep when ctags times out", async () => {
    let astGrepCalled = false;
    const executor: Executor = async (cmd, _args, _opts) => {
      if (cmd === "ctags") {
        return { code: 124, stdout: "", stderr: "timed out" };
      }
      if (cmd === "ast-grep") {
        astGrepCalled = true;
        return { code: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "not found" };
    };

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    assert.equal(astGrepCalled, true);
    const status = index.getStatus();
    assert.equal(status.engine, "ast-grep");
    assert.equal(status.lastError, null); // ast-grep succeeded (empty result)
  });
});

// ── Fallback chain ──────────────────────────────────────────────────

void describe("fallback chain", () => {
  void it("sets error state when both engines fail", async () => {
    const results: Record<string, ExecResult> = {
      [ctagsKey()]: { code: 1, stdout: "", stderr: "ctags error" },
    };

    const { executor } = mockExecutor(results);
    // The mock will return 127 for unknown commands (ast-grep patterns), so
    // both engines fail → fallback chain should set engine=none with error

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const status = index.getStatus();
    assert.equal(status.engine, "none");
    assert.equal(status.symbolCount, 0);
    assert.ok(status.lastError !== null);
    assert.equal(status.isBuilding, false);
  });

  void it("does not crash on empty ctags output", async () => {
    const { executor } = mockExecutor({
      [ctagsKey()]: { code: 0, stdout: "", stderr: "" },
    });

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    assert.equal(index.getSymbols().length, 0);
    assert.equal(index.getStatus().engine, "ctags");
  });
});

// ── Concurrent refresh coalescing ────────────────────────────────────

void describe("concurrent refresh coalescing", () => {
  void it("coalesces concurrent refresh calls into one in-flight build", async () => {
    let resolveCtags: (() => void) | null = null;
    const ctagsPromise = new Promise<void>((resolve) => {
      resolveCtags = resolve;
    });

    let callCount = 0;
    const executor: Executor = async (_cmd, _args, _opts) => {
      callCount++;
      await ctagsPromise;
      return { code: 0, stdout: JSON.stringify({ _type: "tag", name: "Foo", path: "test.ts", line: 1, kind: "class" }) + "\n", stderr: "" };
    };

    const index = createSymbolIndexManager({ cwd: "/project", executor });

    // Fire two concurrent refreshes
    const refresh1 = index.refresh();
    const refresh2 = index.refresh();

    // Let the first one proceed
    resolveCtags!();
    await Promise.all([refresh1, refresh2]);

    // Should have run ctags only once
    assert.equal(callCount, 1);
    assert.equal(index.getSymbols().length, 1);
  });
});

// ── Status tracking ──────────────────────────────────────────────────

void describe("status tracking", () => {
  void it("reports isBuilding during refresh and false after", async () => {
    let resolveCtags: (() => void) | null = null;
    const executor: Executor = async (_cmd, _args, _opts) => {
      await new Promise<void>((resolve) => {
        resolveCtags = resolve;
      });
      return { code: 0, stdout: JSON.stringify({ _type: "tag", name: "Foo", path: "test.ts", line: 1, kind: "class" }) + "\n", stderr: "" };
    };

    const index = createSymbolIndexManager({ cwd: "/project", executor });

    // Start refresh but don't await
    const refreshPromise = index.refresh();

    // Should be building
    assert.equal(index.getStatus().isBuilding, true);

    while (!resolveCtags) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    resolveCtags();
    await refreshPromise;

    assert.equal(index.getStatus().isBuilding, false);
    assert.ok(index.getStatus().lastRefresh !== null && index.getStatus().lastRefresh > 0);
  });
});
