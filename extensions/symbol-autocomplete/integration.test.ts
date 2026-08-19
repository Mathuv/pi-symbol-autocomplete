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
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import symbolAutocompleteExtension from "./index.ts";
import { createTagsManager } from "./tags-manager.ts";
import { createReadtagsBackend } from "./readtags-backend.ts";
import { createSymbolAutocompleteProvider } from "./autocomplete.ts";
import { resolveReferences } from "./resolver.ts";
import { parsePrompt } from "./reference-parser.ts";
import { buildInjectionPayload } from "./injection.ts";

// The autocomplete provider queries the real `readtags` binary against a
// fixture tags file. Skip when the binary is not installed.
const HAS_READTAGS = spawnSync("readtags", ["--version"]).status === 0;
const SKIP_NO_READTAGS = HAS_READTAGS ? false : "readtags binary not available";
const HAS_CTAGS = spawnSync("ctags", ["--version"]).status === 0;
const SKIP_NO_TOOLS = HAS_READTAGS && HAS_CTAGS ? false : "ctags/readtags binary not available";

// ── Mock PI ────────────────────────────────────────────────────────

function createMockPi(
  executor: (cmd: string, args: string[], options?: unknown) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> = async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
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
  executor: (cmd: string, ...args: unknown[]) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>,
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

function classicTagsFile(lines: string[]): string {
  return [
    "!_TAG_FILE_FORMAT\t2\t/extended format/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tc,class\t/classes/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tf,function\t/functions/",
    ...lines,
  ].join("\n") + "\n";
}

function classicTagLine(name: string, filePath: string, kind: string, line: number, scope?: string): string {
  const parts = [
    name,
    filePath,
    `/^${kind} ${name}/;\"`,
    kind,
    `line:${line}`,
    "language:TypeScript",
  ];
  if (scope) parts.push(`scope:${scope}`);
  return parts.join("\t");
}

/** Run a command with the actual binaries on PATH (ctags/readtags). */
function realExecutor(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    encoding: "utf-8",
    timeout: options?.timeout,
  });
  return Promise.resolve({
    code: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed: !!result.signal,
  });
}

/** A minimal delegating provider; the real backend answers queries here. */
function createCurrentProvider(): any {
  return {
    async getSuggestions() { return null; },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) {
      const line = lines[cursorLine] ?? "";
      const start = cursorCol - prefix.length;
      const nextLines = [...lines];
      nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
      return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("symbol autocomplete integration", () => {
  void it("loads cwd/tags and serves # autocomplete suggestions without running ctags", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-tags-"));
    fs.writeFileSync(path.join(tmpDir, "service.ts"), "class MyService {}\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("MyService", "service.ts", "c", 1),
    ]), "utf-8");

    try {
      // The readtags probe must succeed; ctags must never run.
      const commands: string[] = [];
      const executor = async (cmd: string) => {
        commands.push(cmd);
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
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

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");
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
      const suggestions = await provider.getSuggestions(["#My"], 0, 3, { signal: AbortSignal.timeout(5000) });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#My");
      assert.equal(suggestions.items[0].label, "#MyService");
      assert.equal(suggestions.items[0].value, "#MyService@service.ts:1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("injects hidden symbol-context message for valid symbol refs (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
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
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("MyService", "service.ts", "c", 4),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      // The readtags probe must succeed; ctags must never run.
      const commands: string[] = [];
      const executor = async (cmd: string) => {
        commands.push(cmd);
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");

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

  void it("injects stale stable token fallback symbol and surfaces stale warning (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
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
    // Symbol at line 4, but the stable token references a stale line (99).
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("MyService", "service.ts", "c", 4),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const executor = async (cmd: string) => {
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-noref-"));
    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      // A healthy engine: the probe succeeds and ctags writes a tags file.
      const executor = async (command: string, args: string[]) => {
        if (command === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        if (command === "ctags") {
          const target = args[args.indexOf("-f") + 1];
          fs.writeFileSync(target, "SomeClass\ttest.ts\t/^class SomeClass$/;\"\tc\tline:1\n");
          return { code: 0, stdout: "", stderr: "", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Hello, can you help me with something?"),
        ctx,
      );

      assert.equal(result, undefined);
      assert.equal(notifyCalls.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("issues warning for unresolved symbol refs without injection", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-unresolved-"));
    fs.writeFileSync(path.join(tmpDir, "real.ts"), "class RealClass {}\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("RealClass", "real.ts", "c", 1),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const executor = async (cmd: string) => {
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Use #NonExistent"),
        ctx,
      );

      const unresolvedWarnings = notifyCalls.filter(
        (c) => c.message.includes('no symbol named "NonExistent"'),
      );
      assert.equal(unresolvedWarnings.length, 1);
      assert.equal(unresolvedWarnings[0].type, "warning");
      assert.match(unresolvedWarnings[0].message, /^Symbol autocomplete: /);
      assert.equal(result, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("issues warning for ambiguous symbol refs without injection", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-ambiguous-"));
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("SharedName", "src/a.ts", "c", 1),
      classicTagLine("SharedName", "src/b.ts", "f", 5),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const executor = async (cmd: string) => {
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("suggests scoped members via dotted autocomplete from tags file", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-dotted-ac-"));
    fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
      "class Campaign {",
      "  reservation_date: string;",
      "  reservation_expiration_date: string;",
      "  constructor() { this.reservation_date = ''; }",
      "}",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("Campaign", "campaign.ts", "class", 1),
      classicTagLine("reservation_date", "campaign.ts", "property", 2, "class:Campaign"),
      classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, "class:Campaign"),
    ]), "utf-8");

    try {
      // The readtags probe must succeed; ctags must never run.
      const commands: string[] = [];
      const executor = async (cmd: string) => {
        commands.push(cmd);
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
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

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");
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
      const suggestions = await provider.getSuggestions(["#Campaign.reservatio"], 0, 20, { signal: AbortSignal.timeout(5000) });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#Campaign.reservatio");
      assert.equal(suggestions.items[0].label, "#Campaign.reservation_date");
      assert.equal(suggestions.items[0].value, "#Campaign.reservation_date@campaign.ts:2");
      assert.equal(suggestions.items[0].description, "Property \u00b7 campaign.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("injects dotted stable token symbol-context for scoped member (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-dotted-stable-"));
    fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
      "class Campaign {",
      "  reservation_date: string;",
      "  reservation_expiration_date: string;",
      "  constructor() { this.reservation_date = ''; }",
      "}",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("Campaign", "campaign.ts", "c", 1),
      classicTagLine("reservation_date", "campaign.ts", "property", 2, "class:Campaign"),
      classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, "class:Campaign"),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const executor = async (cmd: string) => {
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Use #Campaign.reservation_date@campaign.ts:2"),
        ctx,
      );

      assert.ok(result !== undefined, "should return injection result");
      assert.ok((result as any).message !== undefined, "should have message property");
      assert.equal((result as any).message.customType, "symbol-context");
      assert.equal((result as any).message.display, false);

      const payload = JSON.parse((result as any).message.content);
      assert.ok(Array.isArray(payload));
      assert.equal(payload.length, 1);
      assert.equal(payload[0].metadata.name, "reservation_date");
      assert.equal(payload[0].metadata.kind, "property");
      assert.equal(payload[0].metadata.path, "campaign.ts");
      assert.equal(payload[0].metadata.line, 2);
      assert.ok(payload[0].definition.includes("reservation_date"));
      assert.ok(payload[0].definition.includes("string"));

      // No warnings for happy path
      assert.equal(notifyCalls.filter((c) => c.type === "warning").length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("injects symbol-context for typed plain dotted reference when unique (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-dotted-plain-"));
    fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
      "class Campaign {",
      "  reservation_date: string;",
      "  reservation_expiration_date: string;",
      "  constructor() { this.reservation_date = ''; }",
      "}",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("Campaign", "campaign.ts", "c", 1),
      classicTagLine("reservation_date", "campaign.ts", "property", 2, "class:Campaign"),
      classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, "class:Campaign"),
    ]), "utf-8");

    try {
      const notifyCalls: Array<{ message: string; type: string }> = [];
      const executor = async (cmd: string) => {
        if (cmd === "readtags") {
          return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
        }
        return { code: 127, stdout: "", stderr: "should not run", killed: false };
      };
      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const ctx = createContext(tmpDir, notifyCalls, executor);

      pi.handlers.get("session_start")({}, ctx);
      await new Promise((r) => setTimeout(r, 100));

      const result = await pi.handlers.get("before_agent_start")(
        createPromptEvent("Use #Campaign.reservation_date"),
        ctx,
      );

      assert.ok(result !== undefined, "should return injection result");
      assert.ok((result as any).message !== undefined, "should have message property");
      assert.equal((result as any).message.customType, "symbol-context");
      assert.equal((result as any).message.display, false);

      const payload = JSON.parse((result as any).message.content);
      assert.ok(Array.isArray(payload));
      assert.equal(payload.length, 1);
      assert.equal(payload[0].metadata.name, "reservation_date");
      assert.equal(payload[0].metadata.kind, "property");
      assert.equal(payload[0].metadata.path, "campaign.ts");
      assert.equal(payload[0].metadata.line, 2);
      assert.ok(payload[0].definition.includes("reservation_date"));
      assert.ok(payload[0].definition.includes("string"));

      // No warnings for happy path
      assert.equal(notifyCalls.filter((c) => c.type === "warning").length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("generates a missing tags file with ctags and serves # prefix suggestions", { skip: SKIP_NO_TOOLS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-generate-"));
    fs.writeFileSync(path.join(tmpDir, "greeter.ts"), [
      "export function greet(name: string): string {",
      "  return `Hello ${name}`;",
      "}",
      "",
      "export class Greeter {",
      "  greet(name: string): string {",
      "    return `Hello ${name}`;",
      "  }",
      "}",
    ].join("\n"), "utf-8");

    try {
      const manager = createTagsManager({ cwd: tmpDir, executor: realExecutor });
      await manager.ensure();

      assert.equal(manager.getStatus().engine, "generated");
      assert.ok(fs.existsSync(path.join(tmpDir, "tags")), "ctags must write the tags file");

      // The generated tags serve autocomplete through the real backend.
      const backend = createReadtagsBackend({
        tagsFilePath: manager.getStatus().tagsPath,
        cwd: tmpDir,
      });
      const provider = createSymbolAutocompleteProvider(createCurrentProvider(), backend);
      const suggestions = await provider.getSuggestions(["#gre"], 0, 4, {
        signal: AbortSignal.timeout(5000),
      });

      assert.ok(suggestions, "should return suggestions from the generated tags file");
      assert.equal(suggestions.prefix, "#gre");
      const labels = suggestions.items.map((item) => item.label);
      assert.ok(labels.includes("#Greeter"), "class Greeter should be suggested");
      assert.ok(labels.includes("#greet"), "function greet should be suggested");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("suggests dotted members with a shortened case-insensitive parent prefix (#camp.res)", { skip: SKIP_NO_READTAGS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-parent-prefix-"));
    fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
      "class Campaign {",
      "  reservation_date: string;",
      "  reservation_expiration_date: string;",
      "  constructor() { this.reservation_date = ''; }",
      "}",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
      classicTagLine("Campaign", "campaign.ts", "class", 1),
      classicTagLine("reservation_date", "campaign.ts", "property", 2, "class:Campaign"),
      classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, "class:Campaign"),
    ]), "utf-8");

    try {
      const backend = createReadtagsBackend({ tagsFilePath: path.join(tmpDir, "tags"), cwd: tmpDir });
      const provider = createSymbolAutocompleteProvider(createCurrentProvider(), backend);
      const suggestions = await provider.getSuggestions(["#camp.res"], 0, 9, {
        signal: AbortSignal.timeout(5000),
      });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#camp.res");
      assert.equal(suggestions.items[0].label, "#Campaign.reservation_date");
      assert.equal(suggestions.items[0].value, "#Campaign.reservation_date@campaign.ts:2");
      assert.equal(suggestions.items[0].description, "Property \u00b7 campaign.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void it("regenerates tags on rescan and discovers symbols added after a file edit", { skip: SKIP_NO_TOOLS }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-int-regen-"));
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "class Existing {}\n", "utf-8");

    try {
      const manager = createTagsManager({ cwd: tmpDir, executor: realExecutor });
      await manager.ensure();
      assert.equal(manager.getStatus().engine, "generated");

      // A new symbol appears in the file after the initial build.
      fs.appendFileSync(path.join(tmpDir, "app.ts"), "class BrandNew {}\n");

      // The stale tags file does not know BrandNew yet: no injection.
      const backend = createReadtagsBackend({
        tagsFilePath: manager.getStatus().tagsPath,
        cwd: tmpDir,
      });
      const stale = await resolveReferences(parsePrompt("Use #BrandNew").references, backend);
      assert.equal(stale.resolved[0].status, "unresolved");

      // /rescan-symbols regenerates the tags file.
      await manager.regenerate();
      assert.equal(manager.getStatus().lastError, null);

      // The same turn now resolves and the injection payload builds.
      const result = await resolveReferences(parsePrompt("Use #BrandNew").references, backend);
      assert.equal(result.resolved[0].status, "resolved");
      assert.equal(result.resolved[0].symbol?.name, "BrandNew");
      assert.equal(result.resolved[0].symbol?.path, "app.ts");

      const injection = await buildInjectionPayload(result.injectable, tmpDir);
      assert.equal(injection.symbols.length, 1);
      assert.equal(injection.symbols[0].metadata.name, "BrandNew");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
