/**
 * Tests for symbol autocomplete extension index and command behavior.
 *
 * Covers:
 * - Command registration (/rescan-symbols, /symbol-autocomplete-status)
 * - /rescan-symbols triggers async refresh, coalesces in-flight
 * - /symbol-autocomplete-status returns formatted status
 * - Warmup fail-open: prompt during index build skips injection
 * - Non-spam warnings (single warning per session)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  IndexStatus,
  ProjectSymbol,
  SymbolIndexManager,
  Executor,
} from "./types.ts";

// We import the default export (the extension factory)
import symbolAutocompleteExtension from "./index.ts";

// ── Helper: create a mock index manager ──────────────────────────────

function createMockManager(overrides?: {
  symbols?: ProjectSymbol[];
  status?: Partial<IndexStatus>;
}): SymbolIndexManager {
  const status: IndexStatus = {
    engine: "none",
    symbolCount: 0,
    lastRefresh: null,
    lastError: null,
    isBuilding: false,
    ...overrides?.status,
  };
  const symbols = overrides?.symbols ?? [];

  return {
    refresh: async () => {},
    getSymbols: () => symbols,
    getStatus: () => status,
  };
}

// ── Helper: create a mock ExtensionAPI ──────────────────────────────

interface MockExtensionAPI extends ExtensionAPI {
  commands: Map<string, { handler: (...args: unknown[]) => unknown }>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  notifyCalls: Array<{ message: string; type: string }>;
}

function createMockPi(executor: Executor = async () => ({ code: 0, stdout: "", stderr: "" })): MockExtensionAPI {
  const commands = new Map();
  const handlers = new Map();
  const notifyCalls: Array<{ message: string; type: string }> = [];

  const pi = {
    commands,
    handlers,
    notifyCalls,
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

  return pi as unknown as MockExtensionAPI;
}

// ── Helper: create a mock ExtensionCommandContext ───────────────────

function createMockCtx(overrides?: {
  cwd?: string;
  ui?: { notify?: (message: string, type: string) => void };
}): ExtensionCommandContext {
  const notifyCalls: Array<{ message: string; type: string }> = [];
  const ctx = {
    cwd: overrides?.cwd ?? "/test/project",
    ui: {
      notify: overrides?.ui?.notify ?? ((message: string, type: string) => {
        notifyCalls.push({ message, type });
      }),
      addAutocompleteProvider: () => {},
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  };

  return Object.assign(ctx, { _notifyCalls: notifyCalls }) as unknown as ExtensionCommandContext;
}

// ── Tests ───────────────────────────────────────────────────────────

void describe("symbol autocomplete extension", () => {
  void describe("command registration", () => {
    void it("registers /rescan-symbols and /symbol-autocomplete-status commands", () => {
      const pi = createMockPi();
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      assert.ok(pi.commands.has("rescan-symbols"));
      assert.ok(pi.commands.has("symbol-autocomplete-status"));
    });
  });

  void describe("/rescan-symbols", () => {
    void it("triggers refresh on the index manager", async () => {
      let refreshCalled = false;
      const manager: SymbolIndexManager = {
        ...createMockManager(),
        refresh: async () => {
          refreshCalled = true;
        },
        getStatus: () => ({
          engine: "ctags",
          symbolCount: 42,
          lastRefresh: Date.now(),
          lastError: null,
          isBuilding: false,
        }),
      };

      const pi = createMockPi();
      // Manually create handler and test it
      const { createRescanHandler } = await import("./commands.ts");
      const handler = createRescanHandler(() => manager);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
      });

      await handler("", ctx);

      assert.equal(refreshCalled, true);
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /rescanning symbols/i);
    });

    void it("coalesces when a refresh is already in-flight", async () => {
      let refreshCount = 0;
      const manager: SymbolIndexManager = {
        ...createMockManager(),
        refresh: async () => {
          refreshCount++;
        },
        getStatus: () => ({
          engine: "ctags",
          symbolCount: 42,
          lastRefresh: 1000,
          lastError: null,
          isBuilding: true,
        }),
      };

      const { createRescanHandler } = await import("./commands.ts");
      const handler = createRescanHandler(() => manager);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
      });

      await handler("", ctx);

      // Should NOT have called refresh again
      assert.equal(refreshCount, 0);
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /already in progress/i);
    });

    void it("reports not initialized when manager is null", async () => {
      const { createRescanHandler } = await import("./commands.ts");
      const handler = createRescanHandler(() => null);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
      });

      await handler("", ctx);

      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /not initialized/i);
      assert.equal(notifyCalls[0].type, "error");
    });
  });

  void describe("/symbol-autocomplete-status", () => {
    void it("reports engine, symbol count, refresh time, in-flight, and error", async () => {
      const now = Date.now();
      const manager: SymbolIndexManager = {
        ...createMockManager(),
        getStatus: () => ({
          engine: "ast-grep",
          symbolCount: 99,
          lastRefresh: now,
          lastError: "ctags: timeout",
          isBuilding: false,
        }),
      };

      const { createStatusHandler } = await import("./commands.ts");
      const handler = createStatusHandler(() => manager);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
      });

      await handler("", ctx);

      assert.equal(notifyCalls.length, 1);
      const msg = notifyCalls[0].message;
      assert.match(msg, /Engine: ast-grep/);
      assert.match(msg, /Symbols: 99/);
      assert.match(msg, /Last refresh: /);
      assert.match(msg, /In flight: false/);
      assert.match(msg, /Last error: /);
    });

    void it("reports not initialized when manager is null", async () => {
      const { createStatusHandler } = await import("./commands.ts");
      const handler = createStatusHandler(() => null);

      const notifyCalls: Array<{ message: string; type: string }> = [];
      const ctx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
      });

      await handler("", ctx);

      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /not initialized/i);
      assert.equal(notifyCalls[0].type, "error");
    });
  });

  void describe("warmup and fail-open", () => {
    void it("before_agent_start during index build skips injection and warns once", async () => {
      // Use a Pi-level executor because real ExtensionContext does not expose ctx.exec.
      const execCalls: Array<{ command: string; args: string[] }> = [];
      let resolveExec: (() => void) | null = null;
      const execPromise = new Promise<void>((resolve) => { resolveExec = resolve; });
      const executor: Executor = async (command, args) => {
        execCalls.push({ command, args });
        // Hang until explicitly resolved - simulates long-running ctags
        return execPromise.then(() => ({ code: 0, stdout: "{}", stderr: "" }));
      };

      const pi = createMockPi(executor);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      // Get the session_start and before_agent_start handlers
      const sessionStartHandler = pi.handlers.get("session_start") as
        | ((event: unknown, ctx: ExtensionCommandContext) => void)
        | undefined;
      const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
        | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
        | undefined;

      assert.ok(sessionStartHandler);
      assert.ok(beforeAgentStartHandler);

      // Capture notify calls
      const notifyCalls: Array<{ message: string; type: string }> = [];

      // Start a session. The index build starts but is not yet complete.
      // We need an executor that hangs so the index is "building"
      const sessionCtx = createMockCtx({
        ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
        cwd: "/test/project",
      });

      // Fire session_start
      sessionStartHandler?.({}, sessionCtx as any);

      // Let the event loop tick to start the async refresh
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(execCalls[0]?.command, "ctags");

      // Fire before_agent_start while build is in-flight
      const turnResult = await beforeAgentStartHandler?.(
        { prompt: "Use #MyService", ...createPromptEventPartial() },
        sessionCtx as any,
      );

      // Should return undefined (no injection), and warn once
      assert.equal(turnResult, undefined);
      const buildingWarnings = notifyCalls.filter(
        (c) => c.message.includes("still building"),
      );
      assert.equal(buildingWarnings.length, 1);
      assert.equal(buildingWarnings[0].type, "warning");
    });

    void it("does not burn warnedEngine on healthy ctags first turn; warns exactly once after degradation", async () => {
      const allNotifyCalls: Array<{ message: string; type: string }> = [];

      // Mock executor: starts with healthy ctags, switches to failing
      let execMode: "ctags-healthy" | "ctags-fail" = "ctags-healthy";

      const exec: Executor = async (command: string, _args: string[]) => {
        if (command === "ctags") {
          if (execMode === "ctags-healthy") {
            const output =
              JSON.stringify({
                _type: "tag",
                name: "MyClass",
                path: "src/my-class.ts",
                pattern: "/^class MyClass/",
                line: 10,
                kind: "class",
              }) + "\n";
            return { code: 0, stdout: output, stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "timeout" };
        }
        if (command === "ast-grep") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const pi = createMockPi(exec);
      symbolAutocompleteExtension(pi as unknown as ExtensionAPI);

      const sessionStartHandler = pi.handlers.get("session_start") as
        | ((event: unknown, ctx: ExtensionCommandContext) => void)
        | undefined;
      const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
        | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
        | undefined;

      assert.ok(sessionStartHandler);
      assert.ok(beforeAgentStartHandler);

      const sessionCtx = createMockCtx({
        ui: { notify: (msg, type) => allNotifyCalls.push({ message: msg, type }) },
        cwd: "/test/project",
      });

      // ── Session start: builds index with healthy ctags ──────────
      sessionStartHandler?.({}, sessionCtx as any);

      // Wait for async refresh to complete
      await new Promise((r) => setTimeout(r, 50));

      // ── First turn: healthy ctags, no engine warning ────────────
      const turn1Result = await beforeAgentStartHandler?.(
        { prompt: "Hello world", ...createPromptEventPartial() },
        sessionCtx as any,
      );

      assert.equal(turn1Result, undefined);

      const engineWarningsFilter = (c: { message: string }) =>
        c.message.includes("ctags unavailable") ||
        c.message.includes("indexing failed");

      assert.equal(
        allNotifyCalls.filter(engineWarningsFilter).length,
        0,
        "no engine warning on healthy first turn",
      );

      // ── Degrade: fail ctags, forcing ast-grep fallback ──────────
      execMode = "ctags-fail";

      const rescanHandler = pi.commands.get("rescan-symbols") as
        | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
        | undefined;
      assert.ok(rescanHandler);

      await rescanHandler("", sessionCtx as any);

      // Wait for async refresh (ast-grep fallback) to complete
      await new Promise((r) => setTimeout(r, 50));

      // ── Second turn: ast-grep fallback, exactly one warning ─────
      const warningsBeforeTurn2 = allNotifyCalls.filter(engineWarningsFilter).length;

      const turn2Result = await beforeAgentStartHandler?.(
        { prompt: "Hello world", ...createPromptEventPartial() },
        sessionCtx as any,
      );

      assert.equal(turn2Result, undefined);

      const warningsAfterTurn2 = allNotifyCalls.filter(engineWarningsFilter).length;
      assert.equal(
        warningsAfterTurn2 - warningsBeforeTurn2,
        1,
        "exactly one engine warning after degradation to ast-grep",
      );

      // Verify the warning is the right one
      const newEngineWarnings = allNotifyCalls.filter(engineWarningsFilter);
      assert.match(
        newEngineWarnings[newEngineWarnings.length - 1].message,
        /ctags unavailable/,
      );

      // ── Third turn: no additional engine warning (non-spam) ─────
      const turn3Result = await beforeAgentStartHandler?.(
        { prompt: "Hello world", ...createPromptEventPartial() },
        sessionCtx as any,
      );

      assert.equal(turn3Result, undefined);

      const warningsFinal = allNotifyCalls.filter(engineWarningsFilter).length;
      assert.equal(
        warningsFinal - warningsAfterTurn2,
        0,
        "no additional engine warning on subsequent turns",
      );
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function createPromptEventPartial() {
  return {
    type: "before_agent_start" as const,
    prompt: "",
    images: undefined,
    systemPrompt: "",
    systemPromptOptions: {} as any,
  };
}
