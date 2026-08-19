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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  TagsStatus,
  TagsManager,
  Executor,
} from "./types.ts";

// We import the default export (the extension factory)
import symbolAutocompleteExtension from "./index.ts";

// ── Helper: create a mock tags manager ──────────────────────────────

function createMockManager(overrides?: {
  status?: Partial<TagsStatus>;
}): TagsManager {
  const status: TagsStatus = {
    engine: "none",
    tagsPath: "/test/project/tags",
    fileSizeBytes: 0,
    mtime: null,
    lastError: null,
    isBuilding: false,
    ...overrides?.status,
  };

  return {
    ensure: async () => {},
    regenerate: async () => {},
    getStatus: () => status,
    shutdown: async () => {},
  };
}

// ── Helper: create a mock ExtensionAPI ──────────────────────────────

interface MockExtensionAPI extends ExtensionAPI {
  commands: Map<string, { handler: (...args: unknown[]) => unknown }>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  notifyCalls: Array<{ message: string; type: string }>;
}

function createMockPi(executor: Executor = async () => ({ code: 0, stdout: "", stderr: "", killed: false })): MockExtensionAPI {
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
  ui?: {
    notify?: (message: string, type: string) => void;
    addAutocompleteProvider?: (factory: (current: unknown) => unknown) => void;
  };
}): ExtensionCommandContext {
  const notifyCalls: Array<{ message: string; type: string }> = [];
  const ctx = {
    cwd: overrides?.cwd ?? "/test/project",
    ui: {
      notify: overrides?.ui?.notify ?? ((message: string, type: string) => {
        notifyCalls.push({ message, type });
      }),
      addAutocompleteProvider: overrides?.ui?.addAutocompleteProvider ?? (() => {}),
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
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
    void it("triggers regenerate on the tags manager", async () => {
      let regenerateCalled = false;
      const manager: TagsManager = {
        ...createMockManager(),
        regenerate: async () => {
          regenerateCalled = true;
        },
        getStatus: () => ({
          engine: "tags-file",
          tagsPath: "/test/project/tags",
          fileSizeBytes: 42,
          mtime: Date.now(),
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

      assert.equal(regenerateCalled, true);
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].message, /rescanning symbols/i);
    });

    void it("coalesces when a regenerate is already in-flight", async () => {
      let regenerateCount = 0;
      const manager: TagsManager = {
        ...createMockManager(),
        regenerate: async () => {
          regenerateCount++;
        },
        getStatus: () => ({
          engine: "generated",
          tagsPath: "/test/project/tags",
          fileSizeBytes: 42,
          mtime: 1000,
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

      // Should NOT have called regenerate again
      assert.equal(regenerateCount, 0);
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
    void it("reports engine, tags file, size, mtime, in-flight, and error", async () => {
      const now = Date.now();
      const manager: TagsManager = {
        ...createMockManager(),
        getStatus: () => ({
          engine: "tags-file",
          tagsPath: "/test/project/tags",
          fileSizeBytes: 99,
          mtime: now,
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
      assert.match(msg, /Engine: tags-file/);
      assert.match(msg, /Tags: \/test\/project\/tags/);
      assert.match(msg, /Size: 99 bytes/);
      assert.match(msg, /Modified: /);
      assert.match(msg, /In flight: false/);
      assert.match(msg, /Last error: /);
      // P2: the report must not contain any symbol count field or text.
      assert.ok(!/\bsymbol/i.test(msg), "status must not mention symbols");
      assert.ok(!/\bcount\b/i.test(msg), "status must not mention a count");
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
        // Hang until explicitly resolved - simulates a long-running tags build
        return execPromise.then(() => ({ code: 0, stdout: "", stderr: "", killed: false }));
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

      // Let the event loop tick to start the async tags build
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(execCalls[0]?.command, "readtags");

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

    void it("does not burn warnedEngine on healthy first turn; warns exactly once after degradation", async () => {
      const allNotifyCalls: Array<{ message: string; type: string }> = [];
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-ix-"));

      try {
        // Mock executor: readtags probe succeeds; ctags starts healthy and later fails
        let ctagsFails = false;

        const exec: Executor = async (command: string, args: string[]) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            if (ctagsFails) {
              return { code: 1, stdout: "", stderr: "timeout", killed: false };
            }
            // A successful ctags run writes the tags file
            const fIndex = args.indexOf("-f");
            fs.writeFileSync(
              args[fIndex + 1],
              "MyClass\tsrc/my-class.ts\t/^class MyClass$/;\"\tc\tline:10\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
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
          cwd: tmpDir,
        });

        // ── Session start: generates tags with healthy ctags ────────
        sessionStartHandler?.({}, sessionCtx as any);

        // Wait for async tags ensure to complete
        await new Promise((r) => setTimeout(r, 50));

        // ── First turn: healthy engine, no engine warning ───────────
        const turn1Result = await beforeAgentStartHandler?.(
          { prompt: "Hello world", ...createPromptEventPartial() },
          sessionCtx as any,
        );

        assert.equal(turn1Result, undefined);

        const engineWarningsFilter = (c: { message: string }) =>
          c.message.includes("indexing failed");

        assert.equal(
          allNotifyCalls.filter(engineWarningsFilter).length,
          0,
          "no engine warning on healthy first turn",
        );

        // ── Degrade: ctags fails and the tags file is gone ──────────
        ctagsFails = true;
        fs.rmSync(path.join(tmpDir, "tags"));

        const rescanHandler = pi.commands.get("rescan-symbols") as
          | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        assert.ok(rescanHandler);

        await rescanHandler("", sessionCtx as any);

        // Wait for async regeneration to complete
        await new Promise((r) => setTimeout(r, 50));

        // ── Second turn: engine none, exactly one warning ───────────
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
          "exactly one engine warning after degradation",
        );

        // Verify the warning is the right one
        const newEngineWarnings = allNotifyCalls.filter(engineWarningsFilter);
        assert.match(
          newEngineWarnings[newEngineWarnings.length - 1].message,
          /indexing failed/,
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
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    void it("fails open when the backend lookup rejects", async () => {
      // A backend rejection at the extension boundary must not crash Pi:
      // warn once per session and proceed without injection.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-bnd-"));

      try {
        // ctags must write a real tags file so the engine is usable and
        // resolution actually reaches the (rejecting) backend.
        const executor: Executor = async (command: string, args: string[]) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            const fIndex = args.indexOf("-f");
            fs.writeFileSync(
              args[fIndex + 1],
              "MyService\tservice.ts\t/^class MyService$/;\"\tc\tline:1\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        };

        const pi = createMockPi(executor);
        const createBackend = () => ({
          queryPrefix: async () => [],
          queryDotted: async () => [],
          scanExact: async () => {
            throw new Error("readtags exploded");
          },
        });
        symbolAutocompleteExtension(pi as unknown as ExtensionAPI, { createBackend });

        const sessionStartHandler = pi.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
          | undefined;
        assert.ok(sessionStartHandler);
        assert.ok(beforeAgentStartHandler);

        const notifyCalls: Array<{ message: string; type: string }> = [];
        const sessionCtx = createMockCtx({
          cwd: tmpDir,
          ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
        });

        sessionStartHandler?.({}, sessionCtx as any);
        await new Promise((r) => setTimeout(r, 50));

        const result = await beforeAgentStartHandler?.(
          { ...createPromptEventPartial(), prompt: "Use #MyService" },
          sessionCtx as any,
        );

        assert.equal(result, undefined, "backend failure must skip injection");
        const failureWarnings = notifyCalls.filter(
          (c) => c.message.includes("lookup failed"),
        );
        assert.equal(failureWarnings.length, 1, "warn exactly once");
        assert.equal(failureWarnings[0].type, "warning");

        // Second turn: no additional warning (non-spam).
        await beforeAgentStartHandler?.(
          { ...createPromptEventPartial(), prompt: "Use #MyService" },
          sessionCtx as any,
        );
        assert.equal(
          notifyCalls.filter((c) => c.message.includes("lookup failed")).length,
          1,
          "no additional backend-failure warning",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    void it("fails open when the resolver total deadline aborts the scans", { timeout: 10_000 }, async () => {
      // The backend hangs until the resolver's shared signal aborts at the
      // 5 s total deadline. The extension must warn once, inject nothing,
      // and bound the resolution time to one deadline, not N × 5 s.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-dl-"));

      try {
        const executor: Executor = async (command: string) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            fs.writeFileSync(
              path.join(tmpDir, "tags"),
              "MyService\tservice.ts\t/^class MyService$/;\"\tc\tline:1\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        };

        const pi = createMockPi(executor);
        const createBackend = () => ({
          queryPrefix: async () => [],
          queryDotted: async () => [],
          scanExact: async (_name: string, _onSymbol: unknown, signal?: AbortSignal) => {
            if (!signal) throw new Error("resolver must pass its total-deadline signal");
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("resolver deadline")),
                { once: true },
              );
            });
          },
        });
        symbolAutocompleteExtension(pi as unknown as ExtensionAPI, { createBackend });

        const sessionStartHandler = pi.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
          | undefined;
        assert.ok(sessionStartHandler);
        assert.ok(beforeAgentStartHandler);

        const notifyCalls: Array<{ message: string; type: string }> = [];
        const sessionCtx = createMockCtx({
          cwd: tmpDir,
          ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
        });

        sessionStartHandler?.({}, sessionCtx as any);
        await new Promise((r) => setTimeout(r, 50));

        const started = Date.now();
        const result = await beforeAgentStartHandler?.(
          { ...createPromptEventPartial(), prompt: "#MyService\n#OtherA\n#OtherB" },
          sessionCtx as any,
        );
        const elapsed = Date.now() - started;

        assert.equal(result, undefined, "a deadline abort must skip injection");
        const failureWarnings = notifyCalls.filter((c) => c.message.includes("lookup failed"));
        assert.equal(failureWarnings.length, 1, "warn exactly once");
        assert.equal(failureWarnings[0].type, "warning");
        assert.ok(elapsed < 5_500, `the total deadline must bound resolution (took ${elapsed} ms)`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    void it("recreates manager and backend per session cwd without stale closures", async () => {
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "sym-sess-a-"));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "sym-sess-b-"));

      try {
        // ctags writes the tags file; the probe must succeed.
        const ctagsTargets: string[] = [];
        const executor: Executor = async (command: string, args: string[]) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            const target = args[args.indexOf("-f") + 1];
            ctagsTargets.push(target);
            fs.writeFileSync(
              target,
              "MyService\tservice.ts\t/^class MyService$/;\"\tc\tline:1\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        };

        const pi = createMockPi(executor);

        // Track every backend instance and which one served queries and scans.
        const backends: Array<{ tagsFilePath: string; cwd: string; queries: string[]; scans: string[] }> = [];
        const providerFactories: Array<(current: unknown) => unknown> = [];
        const createBackend = (tagsFilePath: string, cwd: string) => {
          const record = { tagsFilePath, cwd, queries: [] as string[], scans: [] as string[] };
          backends.push(record);
          return {
            queryPrefix: async (query: string) => {
              record.queries.push(query);
              return [{ name: "MyService", kind: "class", path: "service.ts", line: 1 }];
            },
            queryDotted: async () => [],
            scanExact: async (name: string, onSymbol: (symbol: { name: string; kind: string; path: string; line: number }) => void) => {
              record.scans.push(name);
              onSymbol({ name, kind: "class", path: "service.ts", line: 1 });
            },
          };
        };
        symbolAutocompleteExtension(pi as unknown as ExtensionAPI, { createBackend });

        const sessionStartHandler = pi.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
          | undefined;
        assert.ok(sessionStartHandler);
        assert.ok(beforeAgentStartHandler);

        // Start session A, then a second session in a different cwd.
        const makeSessionCtx = (cwd: string) =>
          createMockCtx({
            cwd,
            ui: {
              addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
                providerFactories.push(factory);
              },
            },
          });
        sessionStartHandler?.({}, makeSessionCtx(dirA));
        await new Promise((r) => setTimeout(r, 50));
        sessionStartHandler?.({}, makeSessionCtx(dirB));
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(backends.length, 2, "one backend per session");
        assert.equal(backends[0].cwd, dirA);
        assert.equal(backends[1].cwd, dirB);
        assert.equal(backends[1].tagsFilePath, path.join(dirB, "tags"));
        assert.equal(providerFactories.length, 2, "one autocomplete provider per session");

        // P2: the provider registered for the second session must query the
        // second session's backend, never the first session's.
        const provider = providerFactories[1]({
          async getSuggestions() {
            return null;
          },
          applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string }, prefix: string) {
            const line = lines[cursorLine] ?? "";
            const start = cursorCol - prefix.length;
            const nextLines = [...lines];
            nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
            return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
          },
          shouldTriggerFileCompletion() {
            return true;
          },
        }) as { getSuggestions: (lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }) => Promise<{ prefix: string } | null> };
        const suggestions = await provider.getSuggestions(["#MySer"], 0, 6, {
          signal: AbortSignal.timeout(1000),
        });
        assert.ok(suggestions, "second-session provider must return suggestions");
        assert.equal(suggestions.prefix, "#MySer");
        assert.deepEqual(backends[0].queries, [], "provider must not query the session A backend");
        assert.deepEqual(backends[1].queries, ["MySer"], "provider must query the session B backend");

        // Write the file the mock symbol path points at, so injection succeeds.
        fs.writeFileSync(path.join(dirB, "service.ts"), "class MyService {}\n");

        const notifyCalls: Array<{ message: string; type: string }> = [];
        const ctxB = createMockCtx({
          cwd: dirB,
          ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
        });

        const result = await beforeAgentStartHandler?.(
          { ...createPromptEventPartial(), prompt: "Use #MyService" },
          ctxB as any,
        );

        // The turn must resolve through the backend of the current session.
        assert.ok(result !== undefined, "should inject via the current backend");
        assert.deepEqual(backends[0].scans, [], "no scan on the stale session A backend");
        assert.deepEqual(backends[1].scans, ["MyService"]);

        // Command handlers must use the current session's manager.
        const rescanHandler = pi.commands.get("rescan-symbols") as
          | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        assert.ok(rescanHandler);
        await rescanHandler("", ctxB as any);
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(
          ctagsTargets[ctagsTargets.length - 1].startsWith(dirB + path.sep),
          true,
          "rescan must regenerate the current session's tags file",
        );
      } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    });

    void it("reuses one manager and backend for a same-cwd restart while the build runs", async () => {
      // P2: a second session_start for the same effective tags path must
      // reuse the current manager and backend. Its ensure() joins the
      // in-flight build, so a second ctags process never runs and no
      // older finalizer can overwrite newer tags.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-same-"));

      try {
        // Gate the first ctags generation until both session starts fired.
        let releaseCtags: () => void = () => {};
        const ctagsGate = new Promise<void>((resolve) => { releaseCtags = resolve; });
        let ctagsCalls = 0;
        let ctagsStarted: () => void = () => {};
        const ctagsStartedPromise = new Promise<void>((resolve) => { ctagsStarted = resolve; });

        const executor: Executor = async (command: string, args: string[]) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            ctagsCalls += 1;
            ctagsStarted();
            await ctagsGate;
            const fIndex = args.indexOf("-f");
            fs.writeFileSync(
              args[fIndex + 1],
              "MyService\tservice.ts\t/^class MyService$/;\"\tc\tline:1\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        };

        const pi = createMockPi(executor);
        const backends: Array<{ tagsFilePath: string; cwd: string; queries: string[] }> = [];
        const providerFactories: Array<(current: unknown) => unknown> = [];
        const createBackend = (tagsFilePath: string, cwd: string) => {
          const record = { tagsFilePath, cwd, queries: [] as string[] };
          backends.push(record);
          return {
            queryPrefix: async (query: string) => {
              record.queries.push(query);
              return [{ name: "MyService", kind: "class", path: "service.ts", line: 1 }];
            },
            queryDotted: async () => [],
            scanExact: async () => {},
          };
        };
        symbolAutocompleteExtension(pi as unknown as ExtensionAPI, { createBackend });

        const sessionStartHandler = pi.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        assert.ok(sessionStartHandler);

        const makeSessionCtx = (cwd: string) =>
          createMockCtx({
            cwd,
            ui: {
              addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
                providerFactories.push(factory);
              },
            },
          });

        // First session start: the tags build starts and is gated on ctags.
        sessionStartHandler?.({}, makeSessionCtx(tmpDir));
        await ctagsStartedPromise;

        // Second session start for the same cwd while the build is in flight.
        sessionStartHandler?.({}, makeSessionCtx(tmpDir));

        // Release the build. The reused manager's ensure() must coalesce.
        releaseCtags();
        await waitForTagsFile(path.join(tmpDir, "tags"));

        assert.equal(ctagsCalls, 1, "both session starts share one ctags process");
        assert.equal(backends.length, 1, "the same-path restart reuses the backend");
        assert.equal(providerFactories.length, 2, "each session registers its own provider");

        // The published tags file is the single build's output.
        assert.match(fs.readFileSync(path.join(tmpDir, "tags"), "utf8"), /MyService/);

        // The second editor's provider must query the reused backend.
        const provider = providerFactories[1]({
          async getSuggestions() {
            return null;
          },
          applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string }, prefix: string) {
            const line = lines[cursorLine] ?? "";
            const start = cursorCol - prefix.length;
            const nextLines = [...lines];
            nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
            return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
          },
          shouldTriggerFileCompletion() {
            return true;
          },
        }) as { getSuggestions: (lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }) => Promise<{ prefix: string } | null> };
        const suggestions = await provider.getSuggestions(["#MySer"], 0, 6, {
          signal: AbortSignal.timeout(1000),
        });
        assert.ok(suggestions, "the second provider must return suggestions");
        assert.equal(suggestions.prefix, "#MySer");
        assert.deepEqual(backends[0].queries, ["MySer"], "the second provider must query the reused backend");

        // Command hooks must use the reused current manager.
        const statusHandler = pi.commands.get("symbol-autocomplete-status") as
          | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        assert.ok(statusHandler);
        const statusNotify: Array<{ message: string; type: string }> = [];
        const statusCtx = createMockCtx({
          cwd: tmpDir,
          ui: { notify: (msg, type) => statusNotify.push({ message: msg, type }) },
        });
        await statusHandler("", statusCtx as any);
        assert.equal(statusNotify.length, 1);
        assert.ok(
          statusNotify[0].message.includes(path.resolve(tmpDir, "tags")),
          "status must report the reused manager's tags path",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    void it("old manager never publishes after session_shutdown; a new instance publishes and serves new state", async () => {
      // Real Pi lifecycle: pi emits and awaits session_shutdown, tears down
      // the old runtime, then starts the new extension instance. The old
      // manager must never publish its build, even when the executor
      // ignores the abort signal and returns code 0 during shutdown.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-xfact-"));

      try {
        // First ctags run is gated until shutdown; it ignores the signal
        // and returns code 0. The second run (new instance) succeeds.
        let ctagsRuns = 0;
        let releaseFirstCtags: () => void = () => {};
        const firstCtagsGate = new Promise<void>((resolve) => { releaseFirstCtags = resolve; });
        let firstCtagsStarted: () => void = () => {};
        const firstCtagsStartedPromise = new Promise<void>((resolve) => { firstCtagsStarted = resolve; });

        const executor: Executor = async (command: string, args: string[]) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            ctagsRuns += 1;
            const target = args[args.indexOf("-f") + 1];
            if (ctagsRuns === 1) {
              firstCtagsStarted();
              await firstCtagsGate;
              fs.writeFileSync(target, "OLD_MANAGER_PUBLISH\n");
              return { code: 0, stdout: "", stderr: "", killed: false };
            }
            fs.writeFileSync(target, "NEW_MANAGER_PUBLISH\n");
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 1, stdout: "", stderr: "", killed: false };
        };

        const backends: Array<{ tagsFilePath: string; cwd: string; queries: string[] }> = [];
        const providerFactories: Array<(current: unknown) => unknown> = [];
        const createBackend = (tagsFilePath: string, cwd: string) => {
          const record = { tagsFilePath, cwd, queries: [] as string[] };
          backends.push(record);
          return {
            queryPrefix: async (query: string) => {
              record.queries.push(query);
              return [{ name: "MyService", kind: "class", path: "service.ts", line: 1 }];
            },
            queryDotted: async () => [],
            scanExact: async () => {},
          };
        };
        const makeSessionCtx = () =>
          createMockCtx({
            cwd: tmpDir,
            ui: {
              addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
                providerFactories.push(factory);
              },
            },
          });

        // ── Old extension instance: gated tags build ────────────────
        const pi1 = createMockPi(executor);
        symbolAutocompleteExtension(pi1 as unknown as ExtensionAPI, { createBackend });
        const sessionStart1 = pi1.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        const sessionShutdown = pi1.handlers.get("session_shutdown") as
          | ((event: unknown, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        assert.ok(sessionStart1);
        assert.ok(sessionShutdown);

        sessionStart1?.({}, makeSessionCtx());
        await firstCtagsStartedPromise;
        assert.equal(fs.existsSync(path.join(tmpDir, "tags")), false);

        // ── Pi teardown: dispatch and await session_shutdown ────────
        const shutdownPromise = sessionShutdown({}, makeSessionCtx());
        releaseFirstCtags(); // the executor ignores the signal; returns code 0
        await shutdownPromise;

        // The obsolete manager must never publish, and no temp remains.
        assert.equal(
          fs.existsSync(path.join(tmpDir, "tags")),
          false,
          "old manager must not publish after shutdown",
        );
        assert.deepEqual(
          fs.readdirSync(tmpDir).filter((f) => f.startsWith(".tags.tmp-")),
          [],
          "shutdown must clean the old manager's temp file",
        );

        // ── New extension instance (real Pi replacement) ────────────
        const pi2 = createMockPi(executor);
        symbolAutocompleteExtension(pi2 as unknown as ExtensionAPI, { createBackend });
        const sessionStart2 = pi2.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        assert.ok(sessionStart2);
        sessionStart2?.({}, makeSessionCtx());
        await waitForTagsFile(path.join(tmpDir, "tags"));

        const published = fs.readFileSync(path.join(tmpDir, "tags"), "utf8");
        assert.match(published, /NEW_MANAGER_PUBLISH/);
        assert.ok(!published.includes("OLD_MANAGER_PUBLISH"), "the old build must never reach the live file");
        assert.equal(ctagsRuns, 2, "one ctags run per factory instance");
        assert.equal(backends.length, 2, "one backend per factory instance");

        // ── Commands use the new manager's state ────────────────────
        const statusHandler = pi2.commands.get("symbol-autocomplete-status") as
          | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
          | undefined;
        assert.ok(statusHandler);
        const statusNotify: Array<{ message: string; type: string }> = [];
        await statusHandler("", createMockCtx({
          cwd: tmpDir,
          ui: { notify: (msg, type) => statusNotify.push({ message: msg, type }) },
        }) as any);
        assert.equal(statusNotify.length, 1);
        assert.match(statusNotify[0].message, /Engine: generated/);
        assert.ok(statusNotify[0].message.includes(path.resolve(tmpDir, "tags")));

        // ── The new provider queries the new backend ────────────────
        const provider = providerFactories[1]({
          async getSuggestions() {
            return null;
          },
          applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string }, prefix: string) {
            const line = lines[cursorLine] ?? "";
            const start = cursorCol - prefix.length;
            const nextLines = [...lines];
            nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
            return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
          },
          shouldTriggerFileCompletion() {
            return true;
          },
        }) as { getSuggestions: (lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }) => Promise<{ prefix: string } | null> };
        const suggestions = await provider.getSuggestions(["#MySer"], 0, 6, {
          signal: AbortSignal.timeout(1000),
        });
        assert.ok(suggestions, "the new provider must return suggestions");
        assert.deepEqual(backends[1].queries, ["MySer"], "the new provider must query the new backend");
        assert.deepEqual(backends[0].queries, [], "the old backend must never serve queries after shutdown");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    void it("shows the resolver omission reason for the ninth distinct name", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-9n-"));
      try {
        const executor: Executor = async (command: string) => {
          if (command === "readtags") {
            return { code: 0, stdout: "Universal Ctags 6.1.0", stderr: "", killed: false };
          }
          if (command === "ctags") {
            fs.writeFileSync(
              path.join(tmpDir, "tags"),
              "Seed\tsrc/seed.ts\t/^class Seed$/;\"\tc\tline:1\n",
            );
            return { code: 0, stdout: "", stderr: "", killed: false };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        };

        const pi = createMockPi(executor);
        const scanned: string[] = [];
        const createBackend = () => ({
          queryPrefix: async () => [],
          queryDotted: async () => [],
          scanExact: async (name: string, onSymbol: (s: { name: string; kind: string; path: string; line: number }) => void) => {
            scanned.push(name);
            onSymbol({ name, kind: "class", path: "src/sym.ts", line: 1 });
          },
        });
        symbolAutocompleteExtension(pi as unknown as ExtensionAPI, { createBackend });

        const sessionStartHandler = pi.handlers.get("session_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => void)
          | undefined;
        const beforeAgentStartHandler = pi.handlers.get("before_agent_start") as
          | ((event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>)
          | undefined;
        assert.ok(sessionStartHandler);
        assert.ok(beforeAgentStartHandler);

        const notifyCalls: Array<{ message: string; type: string }> = [];
        const sessionCtx = createMockCtx({
          cwd: tmpDir,
          ui: { notify: (msg, type) => notifyCalls.push({ message: msg, type }) },
        });

        sessionStartHandler?.({}, sessionCtx as any);
        await new Promise((r) => setTimeout(r, 50));

        const prompt = Array.from({ length: 9 }, (_, i) => `#Sym${i}`).join(" ");
        await beforeAgentStartHandler?.(
          { ...createPromptEventPartial(), prompt },
          sessionCtx as any,
        );

        assert.equal(scanned.length, 8, "only the first 8 distinct names are scanned");
        const limitWarnings = notifyCalls.filter((c) => c.message.includes("8-name lookup limit"));
        assert.equal(limitWarnings.length, 1);
        assert.match(limitWarnings[0].message, /^Symbol autocomplete: /);
        assert.match(limitWarnings[0].message, /Sym8/, "the omitted ninth name must appear");
        assert.equal(limitWarnings[0].type, "warning");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Wait until the tags file exists at `tagsPath`. */
async function waitForTagsFile(tagsPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(tagsPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`tags file never appeared at ${tagsPath}`);
}

function createPromptEventPartial() {
  return {
    type: "before_agent_start" as const,
    prompt: "",
    images: undefined,
    systemPrompt: "",
    systemPromptOptions: {} as any,
  };
}
