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

  // ── Python class-scoped variable/constant in classic tags (bugcamp01) ──

  void it("includes class-scoped variable from classic tags with kind v and class:Campaign scope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-class-var-ct-"));
    try {
      // Real Adtrac shape: kind=v, class:Campaign, language:Python
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        [
          "reservation_date",
          "dsp/models.py",
          "/^    reservation_date = models.DateTimeField(null=True, blank=True, default=None)$/;\"",
          "v",
          "line:208",
          "language:Python",
          "class:Campaign",
          "access:public",
        ].join("\t"),
        [
          "Campaign",
          "dsp/models.py",
          "/^class Campaign(models.Model):$/;\"",
          "c",
          "line:100",
          "language:Python",
        ].join("\t"),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      assert.equal(index.getStatus().engine, "tags-file");

      const field = index.getSymbols().find((s) => s.name === "reservation_date");
      assert.ok(field !== undefined, "reservation_date should be indexed");
      assert.equal(field!.kind, "variable");
      assert.equal(field!.parentName, "Campaign");
      assert.equal(field!.depth, 1);
      assert.equal(field!.path, "dsp/models.py");
      assert.equal(field!.line, 208);

      // Campaign class itself should still be indexed
      assert.ok(index.getSymbols().find((s) => s.name === "Campaign") !== undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("still excludes function-scoped variable from classic tags", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-func-var-ct-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("localVar", "src/test.ts", "v", 5, ["function:foo"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      const symbols = index.getSymbols();
      assert.equal(symbols.length, 0, "function-scoped variable should still be excluded");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("includes interface-scoped variable from classic tags with kind v and interface:MyInterface scope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-var-ct-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("x", "src/test.ts", "v", 10, ["interface:MyInterface"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      const symbols = index.getSymbols();
      assert.equal(symbols.length, 1, "interface-scoped variable should be included");
      assert.equal(symbols[0].name, "x");
      assert.equal(symbols[0].parentName, "MyInterface");
      assert.equal(symbols[0].depth, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("includes struct-scoped variable from classic tags with kind v and struct:MyStruct scope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-struct-var-ct-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("field", "src/test.rs", "v", 5, ["struct:MyStruct"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      const symbols = index.getSymbols();
      assert.equal(symbols.length, 1, "struct-scoped variable should be included");
      assert.equal(symbols[0].name, "field");
      assert.equal(symbols[0].parentName, "MyStruct");
      assert.equal(symbols[0].depth, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("includes namespace-scoped variable from classic tags with kind v and namespace:MyNs scope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-ns-var-ct-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("CONST_VAL", "src/test.cpp", "v", 3, ["namespace:MyNs"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      const symbols = index.getSymbols();
      assert.equal(symbols.length, 1, "namespace-scoped variable should be included");
      assert.equal(symbols[0].name, "CONST_VAL");
      assert.equal(symbols[0].parentName, "MyNs");
      assert.equal(symbols[0].depth, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("includes module-scoped variable from classic tags with kind v and module:MyMod scope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-mod-var-ct-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("glob", "src/test.ex", "v", 7, ["module:MyMod"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      const symbols = index.getSymbols();
      assert.equal(symbols.length, 1, "module-scoped variable should be included");
      assert.equal(symbols[0].name, "glob");
      assert.equal(symbols[0].parentName, "MyMod");
      assert.equal(symbols[0].depth, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });



  void it("extracts parentName from classic tags scope fields", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tags-pname-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("_type", "src/types.ts", "p", 24, ["interface:CtagsTag"]),
        classicTagLine("MyClass", "src/types.ts", "c", 1),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      assert.equal(index.getStatus().engine, "tags-file");

      const typeProp = index.getSymbols().find((s) => s.name === "_type");
      assert.ok(typeProp !== undefined);
      assert.equal(typeProp!.kind, "property");
      assert.equal(typeProp!.parentName, "CtagsTag");
      assert.equal(typeProp!.depth, 1);

      const myClass = index.getSymbols().find((s) => s.name === "MyClass");
      assert.ok(myClass !== undefined);
      assert.equal(myClass!.parentName, undefined);
      assert.equal(myClass!.depth, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("extracts last scope segment from classic tags scope:kind:name format", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tags-scope-kind-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("reservation_date", "src/models/campaign.ts", "p", 42, ["scope:class:Campaign"]),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      assert.equal(index.getStatus().engine, "tags-file");

      const sym = index.getSymbols().find((s) => s.name === "reservation_date");
      assert.ok(sym !== undefined);
      assert.equal(sym!.kind, "property");
      // scope:class:Campaign should extract last segment "Campaign", not "class:Campaign"
      assert.equal(sym!.parentName, "Campaign");
      assert.equal(sym!.depth, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("does not set parentName for unscoped classic tags symbols", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-noscope-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("CONFIG", "src/config.ts", "C", 1),
      ]));

      const index = createSymbolIndexManager({
        cwd: tmpDir,
        executor: async () => ({ code: 127, stdout: "", stderr: "should not run" }),
      });
      await index.refresh();

      assert.equal(index.getStatus().engine, "tags-file");
      const sym = index.getSymbols()[0];
      assert.equal(sym.parentName, undefined);
      assert.equal(sym.depth, 0);
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

  // ── Variable/constant scope filtering (regression + bugcamp01) ─────

  void it("includes class-scoped variable with Universal Ctags scope and scopeKind", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "reservation_date", path: "dsp/models.py", pattern: "/^    reservation_date = ...$/", line: 208, kind: "variable", scope: "Campaign", scopeKind: "class", access: "public", language: "Python" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "reservation_date");
    assert.equal(symbols[0].kind, "variable");
    assert.equal(symbols[0].parentName, "Campaign");
    assert.equal(symbols[0].depth, 1);
  });

  void it("includes class-scoped variable with legacy scope class:Campaign", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "reservation_date", path: "dsp/models.py", pattern: "/^    reservation_date = ...$/", line: 208, kind: "variable", scope: "class:Campaign", scopeKind: "class", access: "public", language: "Python" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "reservation_date");
    assert.equal(symbols[0].kind, "variable");
    assert.equal(symbols[0].parentName, "Campaign");
    assert.equal(symbols[0].depth, 1);
  });

  void it("includes class-scoped constant with scope class:MyClass", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "MY_CONST", path: "src/test.ts", line: 5, kind: "constant", scope: "class:MyClass", scopeKind: "class" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "MY_CONST");
    assert.equal(symbols[0].parentName, "MyClass");
  });

  void it("includes class-scoped variable with scopeKind: class (no scope field)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "ivar", path: "src/test.ts", line: 3, kind: "variable", scopeKind: "class" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "ivar");
  });

  void it("includes struct-scoped variable with scope struct:MyStruct", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "x", path: "src/test.rs", line: 1, kind: "variable", scope: "struct:MyStruct", scopeKind: "struct" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "x");
    assert.equal(symbols[0].parentName, "MyStruct");
  });

  void it("includes interface-scoped variable with scope interface:MyInterface", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "ifaceConst", path: "src/test.ts", line: 5, kind: "constant", scope: "interface:MyInterface", scopeKind: "interface" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "ifaceConst");
    assert.equal(symbols[0].parentName, "MyInterface");
  });

  void it("includes namespace-scoped variable with scope namespace:MyNs", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "nsVal", path: "src/test.cpp", line: 1, kind: "variable", scope: "namespace:MyNs", scopeKind: "namespace" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "nsVal");
    assert.equal(symbols[0].parentName, "MyNs");
  });

  void it("includes module-scoped variable with scope module:MyMod", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "modConst", path: "src/test.ex", line: 1, kind: "constant", scope: "module:MyMod", scopeKind: "module" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "modConst");
    assert.equal(symbols[0].parentName, "MyMod");
  });

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

  void it("extracts parentName from JSON ctags scope field", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "reservation_date", path: "src/models/campaign.ts", pattern: "/^  reservation_date: Date$/", line: 42, kind: "property", scope: "class:Campaign" }),
      JSON.stringify({ _type: "tag", name: "Campaign", path: "src/models/campaign.ts", pattern: "/^class Campaign {}$/", line: 1, kind: "class" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 2);

    const prop = symbols.find((s) => s.name === "reservation_date");
    assert.ok(prop !== undefined);
    assert.equal(prop!.kind, "property");
    assert.equal(prop!.parentName, "Campaign");
    assert.equal(prop!.depth, 1);

    const cls = symbols.find((s) => s.name === "Campaign");
    assert.ok(cls !== undefined);
    assert.equal(cls!.parentName, undefined);
    assert.equal(cls!.depth, 0);
  });

  void it("includes property, field, and member as definition kinds", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "prop", path: "src/a.ts", line: 1, kind: "property", scope: "class:A" }),
      JSON.stringify({ _type: "tag", name: "field", path: "src/a.ts", line: 2, kind: "field", scope: "struct:A" }),
      JSON.stringify({ _type: "tag", name: "member", path: "src/a.ts", line: 3, kind: "member", scope: "class:A" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 3);
    assert.ok(symbols.find((s) => s.name === "prop") !== undefined);
    assert.ok(symbols.find((s) => s.name === "field") !== undefined);
    assert.ok(symbols.find((s) => s.name === "member") !== undefined);
  });

  void it("extracts parentName from nested scope (last segment only)", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "innerMethod", path: "src/a.ts", line: 5, kind: "method", scope: "class:Outer:Inner" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    // For nested scope "class:Outer:Inner", we take the last segment "Inner"
    assert.equal(symbols[0].parentName, "Inner");
    assert.equal(symbols[0].depth, 1);
  });

  void it("does not set parentName for symbols without scope", async () => {
    const { executor } = mockExecutor(mockCtagsSuccess([
      JSON.stringify({ _type: "tag", name: "topLevel", path: "src/a.ts", line: 1, kind: "function" }),
    ]));

    const index = createSymbolIndexManager({ cwd: "/project", executor });
    await index.refresh();

    const symbols = index.getSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].parentName, undefined);
    assert.equal(symbols[0].depth, 0);
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
