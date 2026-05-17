/**
 * Integration tests for the symbol autocomplete extension.
 *
 * Covers end-to-end flows through the extension lifecycle:
 * - session_start → async index build → before_agent_start injection
 * - Unresolved/ambiguous refs → warnings, no injection
 * - No refs in prompt → no injection, no warnings
 *
 * Written as a separate file to avoid module-state interference
 * from other test suites within the test runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import symbolAutocompleteExtension from "./index.ts";

// ── Mock PI ────────────────────────────────────────────────────────

function createMockPi(
  executor: (cmd: string, args: string[], options?: unknown) => Promise<{ code: number; stdout: string; stderr: string }> = async () => ({ code: 0, stdout: "", stderr: "" }),
): any {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, opts: { handler: (...args: unknown[]) => unknown }) => {
      commands.set(name, opts.handler);
    },
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: executor,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off" as const,
    setThinkingLevel: () => {},
  };
}

// ── Shared helpers ─────────────────────────────────────────────────

function createContext(
  cwd: string,
  notifyCalls: Array<{ message: string; type: string }>,
  executor: (cmd: string, ...args: unknown[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): any {
  return {
    cwd,
    ui: {
      notify: (msg: string, type: string) => notifyCalls.push({ message: msg, type }),
      addAutocompleteProvider: () => {},
    },
    exec: executor,
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  };
}

function createPromptEvent(prompt: string) {
  return {
    type: "before_agent_start" as const,
    prompt,
    images: undefined,
    systemPrompt: "",
    systemPromptOptions: {} as any,
  };
}

// ── Ctags data helpers ─────────────────────────────────────────────

function ctagsLine(name: string, path: string, line: number, kind: string): string {
  return JSON.stringify({ _type: "tag", name, path, pattern: "/^" + kind + " " + name + "/", line, kind });
}

function classicTagsFile(lines: string[]): string {
  return [
    "!_TAG_FILE_FORMAT\t2\t/extended format/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tc,class\t/classes/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tf,function\t/functions/",
    ...lines,
  ].join("\n") + "\n";
}

function classicTagLine(name: string, filePath: string, kind: string, line: number): string {
  return [
    name,
    filePath,
    `/^${kind} ${name}/;\"`,
    kind,
    `line:${line}`,
    "language:TypeScript",
  ].join("\t");
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("symbol autocomplete integration", () => {
  void it("loads cwd/tags and serves # autocomplete suggestions without running ctags", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-tags-"));
    fs.writeFileSync(path.join(tmpDir, "service.ts"), "class MyService {}\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("MyService", "service.ts", "c", 1),
    ]), "utf-8");

    try {
      let commandCalls = 0;
      const executor = async () => {
        commandCalls++;
        return { code: 127, stdout: "", stderr: "should not run" };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      let providerFactory: ((current: any) => any) | undefined;
      const ctx = createContext(tmpDir, notifyCalls, executor);
      ctx.ui.addAutocompleteProvider = (factory: (current: any) => any) => {
        providerFactory = factory;
      };

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(commandCalls, 0, "pre-built tags file should avoid ctags execution");
      assert.ok(providerFactory, "should register autocomplete provider");

      const currentProvider = {
        async getSuggestions() { return null; },
        applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) {
          const line = lines[cursorLine] ?? "";
          const start = cursorCol - prefix.length;
          const nextLines = [...lines];
          nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
          return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
        },
      };
      const provider = providerFactory(currentProvider);
      const suggestions = await provider.getSuggestions(["#My"], 0, 3, { signal: AbortSignal.timeout(1000) });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#My");
      assert.equal(suggestions.items[0].label, "#MyService");
      assert.equal(suggestions.items[0].value, "#MyService@service.ts:1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("injects hidden symbol-context message for valid symbol refs (end-to-end)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-"));
    fs.writeFileSync(path.join(tmpDir, "service.ts"), [
      "/**",
      " * MyService handles business logic.",
      " */",
      "class MyService {",
      "  private value: number;",
      "  constructor(v: number) { this.value = v; }",
      "  getValue(): number { return this.value; }",
      "}",
    ].join("\n"), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctags = ctagsLine("MyService", "service.ts", 4, "class");
      const executor = async () => ({ code: 0, stdout: ctags + "\n", stderr: "" });
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Use #MyService"),
        ctx,
      );

      assert.ok(result !== undefined, "should return injection result");
      assert.ok((result as any).message !== undefined, "should have message property");
      assert.equal((result as any).message.customType, "symbol-context");
      assert.equal((result as any).message.display, false);

      const payload = JSON.parse((result as any).message.content);
      assert.ok(Array.isArray(payload));
      assert.equal(payload.length, 1);
      assert.equal(payload[0].metadata.name, "MyService");
      assert.equal(payload[0].metadata.kind, "class");
      assert.equal(payload[0].metadata.path, "service.ts");
      assert.equal(payload[0].metadata.line, 4);
      assert.ok(payload[0].definition.includes("class MyService"));
      assert.ok(payload[0].definition.includes("getValue"));

      // No warnings for happy path
      assert.equal(notifyCalls.filter((c) => c.type === "warning").length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("injects stale stable token fallback symbol and surfaces stale warning (end-to-end)", async () => {
    // Regression: stable token with stale line (same name+file, different line)
    // should resolve to the fallback symbol AND be included in the injection
    // payload (hidden message), while also surfacing a stale warning to the UI.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-stale-"));
    fs.writeFileSync(path.join(tmpDir, "service.ts"), [
      "/**",
      " * MyService handles business logic.",
      " */",
      "class MyService {",
      "  private value: number;",
      "  constructor(v: number) { this.value = v; }",
      "  getValue(): number { return this.value; }",
      "}",
    ].join("\n"), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      // Symbol at line 4, but stable token will reference a stale line (99)
      const ctags = ctagsLine("MyService", "service.ts", 4, "class");
      const executor = async () => ({ code: 0, stdout: ctags + "\n", stderr: "" });
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      // Stable token referencing stale line 99 (symbol is at line 4)
      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Use #MyService@service.ts:99"),
        ctx,
      );

      // Should still inject (fallback symbol is valid)
      assert.ok(result !== undefined, "should return injection result for stale fallback");
      assert.ok((result as any).message !== undefined, "should have message property");
      assert.equal((result as any).message.customType, "symbol-context");
      assert.equal((result as any).message.display, false);

      const payload = JSON.parse((result as any).message.content);
      assert.ok(Array.isArray(payload));
      assert.equal(payload.length, 1);
      // Uses the fallback symbol metadata (actual line 4, not stale 99)
      assert.equal(payload[0].metadata.name, "MyService");
      assert.equal(payload[0].metadata.kind, "class");
      assert.equal(payload[0].metadata.path, "service.ts");
      assert.equal(payload[0].metadata.line, 4);
      assert.ok(payload[0].definition.includes("class MyService"),
        "definition should contain the actual symbol");

      // Stale warning should be surfaced
      const staleWarnings = notifyCalls.filter(
        (c) => c.type === "warning" && c.message.includes("stale"),
      );
      assert.equal(staleWarnings.length, 1,
        "should surface stale warning to UI");
      assert.ok(staleWarnings[0].message.includes("99"),
        "stale warning should reference the stale line number");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("returns undefined when prompt has no symbol references", async () => {
    const notifyCalls: Array<{ message: string; type: string }> = [];
    const ctags = ctagsLine("SomeClass", "test.ts", 1, "class");
    const executor = async () => ({ code: 0, stdout: ctags + "\n", stderr: "" });
    const pi = createMockPi(executor);
    symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

    const ctx = createContext("/test/project", notifyCalls, executor);

    pi.handlers.get("session_start")({}, ctx);
    await new Promise((r) => setTimeout(r, 100));

    const result = await pi.handlers.get("before_agent_start")(
      createPromptEvent("Hello, can you help me with something?"),
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(notifyCalls.length, 0);
  });

  void it("issues warning for unresolved symbol refs without injection", async () => {
    const notifyCalls: Array<{ message: string; type: string }> = [];
    const ctags = ctagsLine("RealClass", "real.ts", 1, "class");
    const executor = async () => ({ code: 0, stdout: ctags + "\n", stderr: "" });
    const pi = createMockPi(executor);
    symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

    const ctx = createContext("/test/project", notifyCalls, executor);

    pi.handlers.get("session_start")({}, ctx);
    await new Promise((r) => setTimeout(r, 100));

    const result = await pi.handlers.get("before_agent_start")(
      createPromptEvent("Use #NonExistent"),
      ctx,
    );

    const unresolvedWarnings = notifyCalls.filter(
      (c) => c.message.includes('"NonExistent"') && c.message.includes("not found"),
    );
    assert.equal(unresolvedWarnings.length, 1);
    assert.equal(unresolvedWarnings[0].type, "warning");
    assert.equal(result, undefined);
  });

  void it("issues warning for ambiguous symbol refs without injection", async () => {
    const notifyCalls: Array<{ message: string; type: string }> = [];
    const ctags1 = ctagsLine("SharedName", "src/a.ts", 1, "class");
    const ctags2 = ctagsLine("SharedName", "src/b.ts", 5, "function");
    const executor = async () => ({ code: 0, stdout: ctags1 + "\n" + ctags2 + "\n", stderr: "" });
    const pi = createMockPi(executor);
    symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

    const ctx = createContext("/test/project", notifyCalls, executor);

    pi.handlers.get("session_start")({}, ctx);
    await new Promise((r) => setTimeout(r, 100));

    const result = await pi.handlers.get("before_agent_start")(
      createPromptEvent("Use #SharedName"),
      ctx,
    );

    const ambiguousWarnings = notifyCalls.filter(
      (c) => c.message.includes("ambiguous") && c.message.includes("SharedName"),
    );
    assert.equal(ambiguousWarnings.length, 1);
    assert.equal(ambiguousWarnings[0].type, "warning");
    assert.equal(result, undefined);
  });
});
