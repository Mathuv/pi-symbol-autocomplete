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
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import symbolAutocompleteExtension from "./index.ts";
import { createTagsManager } from "./tags-manager.ts";
import { createReadtagsBackend } from "./readtags-backend.ts";
import { createSymbolAutocompleteProvider } from "./autocomplete.ts";
import { resolveReferences } from "./resolver.ts";
import { parsePrompt } from "./reference-parser.ts";
import { buildInjectionPayload } from "./injection.ts";
import {
  classicTagLine,
  classicTagsFile,
  createCommandContext,
  createMockPi,
  hasBinary,
  pollUntil,
  promptEvent,
  readStatusLine,
  spliceCompletionProvider,
  withTempDir,
} from "./test-support.ts";

// The autocomplete provider queries the real `readtags` binary against a
// fixture tags file. Skip when the binary is not installed.
const HAS_READTAGS = hasBinary("readtags");
const SKIP_NO_READTAGS = HAS_READTAGS ? false : "readtags binary not available";
const SKIP_NO_TOOLS = HAS_READTAGS && hasBinary("ctags") ? false : "ctags/readtags binary not available";

// ── Shared helpers ─────────────────────────────────────────────────

/** Build a session context that records notifications. */
function createContext(
  cwd: string,
  notifyCalls: Array<{ message: string; type: string }>,
  executor: (cmd: string, ...args: unknown[]) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>,
  addAutocompleteProvider?: (factory: (current: any) => any) => void,
): any {
  return createCommandContext({
    cwd,
    notify: (message, type) => notifyCalls.push({ message, type }),
    exec: executor as any,
    addAutocompleteProvider,
  });
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

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("symbol autocomplete integration", () => {
  void it("loads cwd/tags and serves # autocomplete suggestions without running ctags", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-tags-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "service.ts"), "class MyService {}\n", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("MyService", "service.ts", "c", 1, { useKindField: false }),
      ]), "utf-8");

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
      const ctx = createContext(tmpDir, notifyCalls, executor, (factory) => {
        providerFactory = factory;
      });

      pi.handlers.get("session_start")({}, ctx);
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");
      assert.ok(providerFactory, "should register autocomplete provider");

      const provider = providerFactory(spliceCompletionProvider());
      const suggestions = await provider.getSuggestions(["#My"], 0, 3, { signal: AbortSignal.timeout(5000) });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#My");
      assert.equal(suggestions.items[0].label, "#MyService");
      assert.equal(suggestions.items[0].value, "#MyService@service.ts:1");
    });
  });

  void it("injects hidden symbol-context message for valid symbol refs (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-", async (tmpDir) => {
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
        classicTagLine("MyService", "service.ts", "c", 4, { useKindField: false }),
      ]), "utf-8");

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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");

      const result = await pi.handlers.get("before_agent_start")(
        promptEvent("Use #MyService"),
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
    });
  });

  void it("injects stale stable token fallback symbol and surfaces stale warning (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
    // Regression: stable token with stale line (same name+file, different line)
    // should resolve to the fallback symbol AND be included in the injection
    // payload (hidden message), while also surfacing a stale warning to the UI.
    await withTempDir("sym-int-stale-", async (tmpDir) => {
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
        classicTagLine("MyService", "service.ts", "c", 4, { useKindField: false }),
      ]), "utf-8");

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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      // Stable token referencing stale line 99 (symbol is at line 4)
      const result = await pi.handlers.get("before_agent_start")(
        promptEvent("Use #MyService@service.ts:99"),
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
    });
  });

  void it("returns undefined when prompt has no symbol references", async () => {
    await withTempDir("sym-int-noref-", async (tmpDir) => {
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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      const result = await pi.handlers.get("before_agent_start")(
        promptEvent("Hello, can you help me with something?"),
        ctx,
      );

      assert.equal(result, undefined);
      assert.equal(notifyCalls.length, 0);
    });
  });

  void it("issues warning for unresolved symbol refs without injection", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-unresolved-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "real.ts"), "class RealClass {}\n", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("RealClass", "real.ts", "c", 1, { useKindField: false }),
      ]), "utf-8");

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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      const result = await pi.handlers.get("before_agent_start")(
        promptEvent("Use #NonExistent"),
        ctx,
      );

      const unresolvedWarnings = notifyCalls.filter(
        (c) => c.message.includes('no symbol named "NonExistent"'),
      );
      assert.equal(unresolvedWarnings.length, 1);
      assert.equal(unresolvedWarnings[0].type, "warning");
      assert.match(unresolvedWarnings[0].message, /^Symbol autocomplete: /);
      assert.equal(result, undefined);
    });
  });

  void it("issues warning for ambiguous symbol refs without injection", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-ambiguous-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("SharedName", "src/a.ts", "c", 1, { useKindField: false }),
        classicTagLine("SharedName", "src/b.ts", "f", 5, { useKindField: false }),
      ]), "utf-8");

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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      const result = await pi.handlers.get("before_agent_start")(
        promptEvent("Use #SharedName"),
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

  void it("suggests scoped members via dotted autocomplete from tags file", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-dotted-ac-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
        "class Campaign {",
        "  reservation_date: string;",
        "  reservation_expiration_date: string;",
        "  constructor() { this.reservation_date = ''; }",
        "}",
      ].join("\n"), "utf-8");
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("Campaign", "campaign.ts", "class", 1, { useKindField: false }),
        classicTagLine("reservation_date", "campaign.ts", "property", 2, { useKindField: false, scope: "class:Campaign" }),
        classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, { useKindField: false, scope: "class:Campaign" }),
      ]), "utf-8");

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
      const ctx = createContext(tmpDir, notifyCalls, executor, (factory) => {
        providerFactory = factory;
      });

      pi.handlers.get("session_start")({}, ctx);
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      assert.ok(!commands.includes("ctags"), "pre-built tags file should avoid ctags execution");
      assert.ok(providerFactory, "should register autocomplete provider");

      const provider = providerFactory(spliceCompletionProvider());
      const suggestions = await provider.getSuggestions(["#Campaign.reservatio"], 0, 20, { signal: AbortSignal.timeout(5000) });

      assert.ok(suggestions);
      assert.equal(suggestions.prefix, "#Campaign.reservatio");
      assert.equal(suggestions.items[0].label, "#Campaign.reservation_date");
      assert.equal(suggestions.items[0].value, "#Campaign.reservation_date@campaign.ts:2");
      assert.equal(suggestions.items[0].description, "Property \u00b7 campaign.ts");
    });
  });

  void it("injects symbol-context for a dotted reference, plain and stable (end-to-end)", { skip: SKIP_NO_READTAGS }, async () => {
    await withTempDir("sym-int-dotted-plain-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "campaign.ts"), [
        "class Campaign {",
        "  reservation_date: string;",
        "  reservation_expiration_date: string;",
        "  constructor() { this.reservation_date = ''; }",
        "}",
      ].join("\n"), "utf-8");
      fs.writeFileSync(path.join(tmpDir, "tags"), classicTagsFile([
        classicTagLine("Campaign", "campaign.ts", "c", 1, { useKindField: false }),
        classicTagLine("reservation_date", "campaign.ts", "property", 2, { useKindField: false, scope: "class:Campaign" }),
        classicTagLine("reservation_expiration_date", "campaign.ts", "property", 3, { useKindField: false, scope: "class:Campaign" }),
      ]), "utf-8");

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
      // Wait for the session ensure() to settle instead of a fixed sleep.
      await pollUntil(async () => !(await readStatusLine(pi, tmpDir)).includes("In flight: true"));

      // The plain dotted token and the dotted stable token inject the
      // same scoped member.
      for (const prompt of [
        "Use #Campaign.reservation_date",
        "Use #Campaign.reservation_date@campaign.ts:2",
      ]) {
        const result = await pi.handlers.get("before_agent_start")(promptEvent(prompt), ctx);

        assert.ok(result !== undefined, `should return injection result for "${prompt}"`);
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
      }

      // No warnings for happy path
      assert.equal(notifyCalls.filter((c) => c.type === "warning").length, 0);
    });
  });

  void it("generates a missing tags file with ctags and serves # prefix suggestions", { skip: SKIP_NO_TOOLS }, async () => {
    await withTempDir("sym-int-generate-", async (tmpDir) => {
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

      const manager = createTagsManager({ cwd: tmpDir, executor: realExecutor });
      await manager.ensure();

      assert.equal(manager.getStatus().engine, "generated");
      assert.ok(fs.existsSync(path.join(tmpDir, "tags")), "ctags must write the tags file");

      // The generated tags serve autocomplete through the real backend.
      const backend = createReadtagsBackend({
        tagsFilePath: manager.getStatus().tagsPath,
        cwd: tmpDir,
      });
      const provider = createSymbolAutocompleteProvider(spliceCompletionProvider(), backend);
      const suggestions = await provider.getSuggestions(["#gre"], 0, 4, {
        signal: AbortSignal.timeout(5000),
      });

      assert.ok(suggestions, "should return suggestions from the generated tags file");
      assert.equal(suggestions.prefix, "#gre");
      const labels = suggestions.items.map((item) => item.label);
      assert.ok(labels.includes("#Greeter"), "class Greeter should be suggested");
      assert.ok(labels.includes("#greet"), "function greet should be suggested");
    });
  });

  void it("regenerates tags on rescan and discovers symbols added after a file edit", { skip: SKIP_NO_TOOLS }, async () => {
    await withTempDir("sym-int-regen-", async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, "app.ts"), "class Existing {}\n", "utf-8");

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
    });
  });
});
