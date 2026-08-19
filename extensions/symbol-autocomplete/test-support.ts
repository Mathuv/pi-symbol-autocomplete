/**
 * Shared test support for the symbol autocomplete extension.
 *
 * The module holds every fake and helper that more than one test file
 * needs: temporary directories, a fake Pi extension API, a fake readtags
 * backend, classic tag-line builders, and a poll helper.
 *
 * Only test files import this module. The test runner matches
 * `*.test.ts`, so this file never runs as a test.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Executor, ProjectSymbol } from "./types.ts";

// ── Temporary directories ───────────────────────────────────────────

/**
 * Create a temporary directory with the given name prefix.
 * The caller must remove the directory with `removeTempDir`.
 */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a temporary directory and everything in it.
 * The mode is restored first, so a test that locked the directory can
 * still remove it.
 */
export function removeTempDir(dir: string): void {
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    // The directory is already gone. Nothing to restore.
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Run `fn` with a fresh temporary directory and remove it afterwards. */
export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

// ── Polling ─────────────────────────────────────────────────────────

/**
 * Poll `condition` until it returns true.
 * Throws when the timeout passes. Use this instead of a fixed sleep.
 */
export async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  options?: { intervalMs?: number; timeoutMs?: number; message?: string },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 5;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(options?.message ?? `pollUntil timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A promise that the test resolves by hand. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Binary probes ───────────────────────────────────────────────────

/** Return true when `name --version` succeeds on PATH. */
export function hasBinary(name: string): boolean {
  return spawnSync(name, ["--version"]).status === 0;
}

// ── Classic tag-line builders ───────────────────────────────────────

/**
 * Build one classic-format tags line.
 *
 * `useKindField` selects the kind column format. `true` writes the
 * prefixed form `kind:class`. `false` writes the bare form `class`.
 * Both formats occur in real tags files, so every call states which one
 * it needs.
 */
export function classicTagLine(
  name: string,
  filePath: string,
  kind: string,
  line: number,
  options: { useKindField: boolean; scope?: string },
): string {
  const parts = [
    name,
    filePath,
    `/^${kind} ${name}/;"`,
    options.useKindField ? `kind:${kind}` : kind,
    `line:${line}`,
    "language:TypeScript",
  ];
  if (options.scope) parts.push(`scope:${options.scope}`);
  return parts.join("\t");
}

/** Wrap definition lines in a classic tags file with the usual pseudo tags. */
export function classicTagsFile(lines: string[]): string {
  return [
    "!_TAG_FILE_FORMAT\t2\t/extended format/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tc,class\t/classes/",
    "!_TAG_KIND_DESCRIPTION!TypeScript\tf,function\t/functions/",
    ...lines,
  ].join("\n") + "\n";
}

// ── Fake readtags backend ───────────────────────────────────────────

/** One recorded backend call. */
export interface BackendCall {
  method: string;
  args: unknown[];
}

/**
 * Create a fake readtags backend that records every call.
 *
 * `calls` holds every method call in order. `queries` holds the prefix
 * query strings and `scans` holds the exact scan names, so a test can
 * assert on one method without filtering. `disposals` counts `dispose()`.
 */
export function createFakeReadtagsBackend(overrides?: {
  queryPrefix?: (query: string, limit: number, signal?: AbortSignal) => Promise<ProjectSymbol[]>;
  queryDotted?: (
    parentQuery: string,
    memberQuery: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<ProjectSymbol[]>;
  scanExact?: (
    name: string,
    onSymbol: (symbol: ProjectSymbol) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}) {
  const calls: BackendCall[] = [];
  const queries: string[] = [];
  const scans: string[] = [];
  const state = { disposals: 0 };

  return {
    calls,
    queries,
    scans,
    state,

    async queryPrefix(query: string, limit: number, signal?: AbortSignal): Promise<ProjectSymbol[]> {
      calls.push({ method: "queryPrefix", args: [query, limit, signal] });
      queries.push(query);
      return overrides?.queryPrefix ? overrides.queryPrefix(query, limit, signal) : [];
    },

    async queryDotted(
      parentQuery: string,
      memberQuery: string,
      limit: number,
      signal?: AbortSignal,
    ): Promise<ProjectSymbol[]> {
      calls.push({ method: "queryDotted", args: [parentQuery, memberQuery, limit, signal] });
      return overrides?.queryDotted
        ? overrides.queryDotted(parentQuery, memberQuery, limit, signal)
        : [];
    },

    async scanExact(
      name: string,
      onSymbol: (symbol: ProjectSymbol) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      calls.push({ method: "scanExact", args: [name, onSymbol, signal] });
      scans.push(name);
      if (overrides?.scanExact) await overrides.scanExact(name, onSymbol, signal);
    },

    dispose(): void {
      calls.push({ method: "dispose", args: [] });
      state.disposals += 1;
    },
  };
}

// ── Fake Pi extension API ───────────────────────────────────────────

/** The parts of the fake Pi extension API that tests read. */
export interface MockPi {
  commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
  handlers: Map<string, (event: any, ctx: any) => any>;
  exec: Executor;
}

/** Create a fake `ExtensionAPI` that records commands and event handlers. */
export function createMockPi(
  executor: Executor = async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
): MockPi {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();

  const pi = {
    commands,
    handlers,
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, handler);
    },
    registerCommand: (
      name: string,
      opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
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

  return pi as unknown as MockPi;
}

/** Create a fake `ExtensionCommandContext` for a session or a command. */
export function createCommandContext(options?: {
  cwd?: string;
  notify?: (message: string, type: string) => void;
  addAutocompleteProvider?: (factory: (current: any) => any) => void;
  exec?: Executor;
}): ExtensionCommandContext {
  const ctx = {
    cwd: options?.cwd ?? "/test/project",
    ui: {
      notify: options?.notify ?? (() => {}),
      addAutocompleteProvider: options?.addAutocompleteProvider ?? (() => {}),
    },
    exec: options?.exec ?? (async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  };

  return ctx as unknown as ExtensionCommandContext;
}

/** Build a `before_agent_start` event with the given prompt. */
export function promptEvent(prompt: string) {
  return {
    type: "before_agent_start" as const,
    prompt,
    images: undefined,
    systemPrompt: "",
    systemPromptOptions: {} as any,
  };
}

/**
 * Read the one-line report of `/symbol-autocomplete-status`.
 * A poll condition uses this to observe the manager state.
 */
export async function readStatusLine(pi: MockPi, cwd: string): Promise<string> {
  const handler = pi.commands.get("symbol-autocomplete-status");
  if (!handler) throw new Error("the status command is not registered");
  const messages: string[] = [];
  await handler("", createCommandContext({ cwd, notify: (message) => messages.push(message) }));
  return messages[0] ?? "";
}

// ── Autocomplete provider stub ──────────────────────────────────────

/**
 * Create the delegate provider used by autocomplete tests.
 * `applyCompletion` replaces the typed prefix with the item value.
 */
export function spliceCompletionProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const start = cursorCol - prefix.length;
      const nextLines = [...lines];
      nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
      return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
}
