/**
 * Tests for the symbol reference parser and resolver.
 *
 * Covers:
 * - Parser boundary detection (start/whitespace, no mid-token)
 * - Parser skips tokens inside fenced code blocks
 * - Stable token parsing (#name@path:line)
 * - Plain token parsing (#name)
 * - Resolver stable token chain (exact path+line → same-name same-file → unresolved)
 * - Resolver plain token rules (unique → resolved, ambiguous → skip)
 * - Resolver lookup deduplication (one lookup per distinct name)
 * - Diagnostic metadata on all resolution outcomes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ProjectSymbol,
  ParseResult,
  ReadtagsBackend,
  ResolveResult,
} from "./types.ts";
import { parsePrompt } from "./reference-parser.ts";
import { resolveReferences } from "./resolver.ts";

// ── Sample symbols for resolver tests ───────────────────────────────

const SYMBOLS: ProjectSymbol[] = [
  { name: "MyService", kind: "class", path: "src/services/my-service.ts", line: 10 },
  { name: "MyService", kind: "class", path: "src/deprecated/my-service.ts", line: 3 },
  { name: "Database", kind: "interface", path: "src/db/database.ts", line: 1 },
  { name: "myFunction", kind: "function", path: "src/utils/helpers.ts", line: 42 },
  { name: "config", kind: "constant", path: "config.ts", line: 1 },
  { name: "Logger", kind: "class", path: "src/logging/logger.ts", line: 15 },
  { name: "Helper", kind: "function", path: "src/helper.ts", line: 5 },
  { name: "Helper", kind: "function", path: "src/utils/helper.ts", line: 1 },
];

// ── Mock backend ────────────────────────────────────────────────────

/**
 * Create a mock backend whose lookupExact returns the exact-name matches
 * from `symbols`. Records every lookup name for dedup assertions.
 */
function createMockBackend(symbols: ProjectSymbol[]): {
  backend: ReadtagsBackend;
  lookupCalls: string[];
} {
  const lookupCalls: string[] = [];
  const backend: ReadtagsBackend = {
    queryPrefix: async () => [],
    queryDotted: async () => [],
    lookupExact: async (name: string) => {
      lookupCalls.push(name);
      return symbols.filter((s) => s.name === name);
    },
  };
  return { backend, lookupCalls };
}

// ═══════════════════════════════════════════════════════════════════════
// PARSER TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("parser", () => {
  // ── Boundary detection ──────────────────────────────────────────

  void it("parses plain #name at line start", () => {
    const result = parsePrompt("#MyService");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#MyService");
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[0].type, "plain");
    assert.equal(result.references[0].path, undefined);
    assert.equal(result.references[0].line, undefined);
    assert.equal(result.references[0].lineIndex, 0);
    assert.equal(result.references[0].column, 0);
  });

  void it("parses plain #name after whitespace", () => {
    const result = parsePrompt("check #MyService");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#MyService");
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[0].type, "plain");
  });

  void it("parses plain #name after tab", () => {
    const result = parsePrompt("\t#MyService");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#MyService");
  });

  void it("does NOT parse #name mid-word", () => {
    const result = parsePrompt("foo#MyService");
    assert.equal(result.references.length, 0);
  });

  void it("does NOT parse #name after non-whitespace character", () => {
    const result = parsePrompt("a#MyService");
    assert.equal(result.references.length, 0);
  });

  void it("parses multiple # tokens on the same line", () => {
    const result = parsePrompt("#MyService and #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[1].name, "Database");
  });

  void it("parses # tokens on different lines", () => {
    const result = parsePrompt("#MyService\ncheck #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].lineIndex, 0);
    assert.equal(result.references[0].column, 0);
    assert.equal(result.references[1].lineIndex, 1);
    assert.equal(result.references[1].column, 6);
  });

  void it("parses #name followed by punctuation", () => {
    const result = parsePrompt("check #MyService.");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#MyService");
    assert.equal(result.references[0].name, "MyService");
  });

  void it("parses #name followed by comma", () => {
    const result = parsePrompt("use #MyService, #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[1].name, "Database");
  });

  // ── Fenced code block exclusion ─────────────────────────────────

  void it("skips #name inside triple-backtick fenced code block", () => {
    const prompt = [
      "Here is code:",
      "```",
      "#MyService",
      "```",
      "Check #Database after.",
    ].join("\n");
    const result = parsePrompt(prompt);
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "Database");
  });

  void it("skips stable token inside fenced code block", () => {
    const prompt = [
      "Example:",
      "```typescript",
      "#MyService@src/services/my-service.ts:10",
      "```",
      "Use #Logger.",
    ].join("\n");
    const result = parsePrompt(prompt);
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "Logger");
  });

  void it("handles nested-style fences (``` inside text should not fool it)", () => {
    const prompt = [
      "#Start",
      "```",
      "#Inside1",
      "#Inside2",
      "```",
      "#End",
    ].join("\n");
    const result = parsePrompt(prompt);
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "Start");
    assert.equal(result.references[1].name, "End");
  });

  void it("handles unclosed fenced code block (treats rest as code)", () => {
    const prompt = [
      "Before.",
      "```",
      "#hidden",
      "#alsoHidden",
    ].join("\n");
    const result = parsePrompt(prompt);
    assert.equal(result.references.length, 0);
  });

  void it("handles multiple fenced code blocks", () => {
    const prompt = [
      "#Token1",
      "```",
      "#hidden1",
      "```",
      "#Token2",
      "```",
      "#hidden2",
      "```",
      "#Token3",
    ].join("\n");
    const result = parsePrompt(prompt);
    assert.equal(result.references.length, 3);
    assert.equal(result.references[0].name, "Token1");
    assert.equal(result.references[1].name, "Token2");
    assert.equal(result.references[2].name, "Token3");
  });

  // ── Stable token parsing ────────────────────────────────────────

  void it("parses stable token #name@path:line", () => {
    const result = parsePrompt("#MyService@src/services/my-service.ts:10");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#MyService@src/services/my-service.ts:10");
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[0].path, "src/services/my-service.ts");
    assert.equal(result.references[0].line, 10);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[0].lineIndex, 0);
    assert.equal(result.references[0].column, 0);
  });

  void it("parses stable token after whitespace", () => {
    const result = parsePrompt("see #MyService@src/services/my-service.ts:10");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[0].path, "src/services/my-service.ts");
    assert.equal(result.references[0].line, 10);
  });

  void it("does NOT parse stable token mid-word", () => {
    const result = parsePrompt("foo#MyService@src/foo.ts:10");
    assert.equal(result.references.length, 0);
  });

  void it("parses stable token with deep path", () => {
    const result = parsePrompt("#Helper@src/utils/deep/nested/helper.ts:42");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "Helper");
    assert.equal(result.references[0].path, "src/utils/deep/nested/helper.ts");
    assert.equal(result.references[0].line, 42);
  });

  void it("parses stable token at end of line", () => {
    const result = parsePrompt("check #MyService@src/foo.ts:10");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].type, "stable");
  });

  void it("does NOT parse malformed stable token missing line number", () => {
    // #name@path without :line should not match as stable
    const result = parsePrompt("#MyService@src/foo.ts");
    // Should parse as plain token instead (just #MyService)
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].type, "plain");
    assert.equal(result.references[0].name, "MyService");
  });

  void it("parses stable token with path containing dots", () => {
    const result = parsePrompt("#config@config.ts:1");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[0].path, "config.ts");
    assert.equal(result.references[0].line, 1);
  });

  // ── Mixed tokens ────────────────────────────────────────────────

  void it("parses mixed stable and plain tokens", () => {
    const result = parsePrompt("use #MyService@src/services/my-service.ts:10 and #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[1].type, "plain");
    assert.equal(result.references[1].name, "Database");
  });

  void it("parses #name with underscore", () => {
    const result = parsePrompt("#my_var");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "my_var");
  });

  // ── Dotted token parsing ─────────────────────────────────────────

  void it("parses dotted plain token #Parent.member", () => {
    const result = parsePrompt("#Campaign.reservation_date");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#Campaign.reservation_date");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[0].type, "plain");
    assert.equal(result.references[0].path, undefined);
    assert.equal(result.references[0].line, undefined);
  });

  void it("parses dotted stable token #Parent.member@path:line", () => {
    const result = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:42");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#Campaign.reservation_date@src/models/campaign.ts:42");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[0].path, "src/models/campaign.ts");
    assert.equal(result.references[0].line, 42);
    assert.equal(result.references[0].type, "stable");
  });

  void it("parses dotted plain token despite trailing period", () => {
    const result = parsePrompt("Explain #Campaign.reservation_date.");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#Campaign.reservation_date");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[0].type, "plain");
  });

  void it("parses dotted plain token with trailing comma", () => {
    const result = parsePrompt("use #Campaign.reservation_date, #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[0].type, "plain");
    assert.equal(result.references[1].name, "Database");
  });

  void it("does NOT include trailing period in dotted stable token", () => {
    const result = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:42.");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].raw, "#Campaign.reservation_date@src/models/campaign.ts:42");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
  });

  void it("parses non-dotted tokens alongside dotted tokens", () => {
    const result = parsePrompt("Check #Campaign.reservation_date and #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[1].name, "Database");
  });

  void it("parses dotted stable token alongside non-dotted plain", () => {
    const result = parsePrompt("use #Campaign.reservation_date@src/models/campaign.ts:42 and #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[1].type, "plain");
    assert.equal(result.references[1].name, "Database");
  });

  void it("parses dotted name with multiple dots", () => {
    const result = parsePrompt("#A.B.C");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "A.B.C");
    assert.equal(result.references[0].type, "plain");
  });

  void it("does NOT include trailing dot when no member follows it", () => {
    // The grammar requires Identifier after each dot, so #Foo. should not match the trailing dot
    const result = parsePrompt("#Foo.");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].name, "Foo");
  });

  void it("parses dotted stable token after whitespace", () => {
    const result = parsePrompt("see #Campaign.reservation_date@src/models/campaign.ts:42");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].type, "stable");
    assert.equal(result.references[0].name, "Campaign.reservation_date");
    assert.equal(result.references[0].path, "src/models/campaign.ts");
    assert.equal(result.references[0].line, 42);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RESOLVER TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("resolver", () => {
  // ── Stable token resolution ─────────────────────────────────────

  void it("resolves stable token with exact path+line match", async () => {
    const parsed = parsePrompt("#MyService@src/services/my-service.ts:10");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "MyService");
    assert.equal(r.symbol?.path, "src/services/my-service.ts");
    assert.equal(r.symbol?.line, 10);
    assert.equal(r.parsed.type, "stable");
  });

  void it("resolves stable token with stale line (same name+file, different line)", async () => {
    // Symbol exists at MyService in same file but at line 10, not 99
    const parsed = parsePrompt("#MyService@src/services/my-service.ts:99");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "stale");             // stale indicator since line didn't match
    assert.equal(r.symbol?.name, "MyService");   // same name
    assert.equal(r.symbol?.path, "src/services/my-service.ts"); // same file
    assert.equal(r.symbol?.line, 10);           // correct line from index
    assert.ok(r.message.includes("stale") || r.message.includes("line"));
  });

  void it("reports unresolved for stable token with wrong file", async () => {
    const parsed = parsePrompt("#MyService@src/nonexistent/file.ts:10");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("unresolved") || r.message.includes("not found"));
  });

  void it("does NOT resolve stable token with wrong name on existing path+line", async () => {
    // Regression: stable token must match name + path + line, not path+line alone.
    // #NonExistent at path:line where MyService exists should NOT resolve.
    const parsed = parsePrompt("#NonExistent@src/services/my-service.ts:10");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("unresolved") || r.message.includes("not found"));
  });

  void it("resolves stable token where same name exists but different file — uses stale chain same-file", async () => {
    // MyService exists in two files. Stable token points to file that has it.
    const parsed = parsePrompt("#MyService@src/deprecated/my-service.ts:3");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved"); // exact match path+line
    assert.equal(r.symbol?.path, "src/deprecated/my-service.ts");
    assert.equal(r.symbol?.line, 3);
  });

  void it("does NOT cross-file fallback for stale stable token", async () => {
    // MyService exists at src/services/my-service.ts:10 and src/deprecated/my-service.ts:3
    // Stable token points to src/nonexistent/my-service.ts:99 — wrong file entirely
    const parsed = parsePrompt("#MyService@src/nonexistent/my-service.ts:99");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    // Should NOT cross-file fallback: no MyService in src/nonexistent/, so unresolved
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  // ── Plain token resolution ──────────────────────────────────────

  void it("resolves plain #name with unique match", async () => {
    const parsed = parsePrompt("#Database");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "Database");
    assert.equal(r.symbol?.path, "src/db/database.ts");
  });

  void it("reports ambiguous for plain #name with multiple matches", async () => {
    const parsed = parsePrompt("#MyService");  // two MyService symbols
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);            // no injection for ambiguous
    assert.ok(r.message.includes("ambiguous") || r.message.includes("multiple"));
  });

  void it("reports unresolved for plain #name with no match", async () => {
    const parsed = parsePrompt("#NonExistent");
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  void it("reports ambiguous for #name with multiple matches of same name across files", async () => {
    const parsed = parsePrompt("#Helper");  // two Helper symbols
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);
  });

  // ── Injectable results ──────────────────────────────────────────

  void it("includes resolved and stale references in injectable list", async () => {
    const parsed = parsePrompt("#Database\n#MyService\n#NonExistent");
    // #Database → unique, #MyService → ambiguous, #NonExistent → unresolved
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);
    assert.equal(result.injectable.length, 1);
    assert.equal(result.injectable[0].parsed.name, "Database");
    assert.equal(result.injectable[0].status, "resolved");
  });

  void it("includes stale stable token in injectable list", async () => {
    // Regression: stable token with same name+file but stale line should
    // be injectable (has a fallback symbol) while surfacing stale warning.
    const parsed = parsePrompt(
      "#MyService@src/services/my-service.ts:999" +
      "\n#Database" +
      "\n#NonExistent"
    );
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);

    // Stale token has a symbol, should be in injectable
    const staleRef = result.resolved.find(
      (r) => r.parsed.name === "MyService" && r.parsed.type === "stable",
    );
    assert.ok(staleRef, "stable token should have a resolution outcome");
    assert.equal(staleRef?.status, "stale");
    assert.ok(staleRef?.symbol !== null, "stale fallback should have a symbol");
    assert.equal(staleRef?.symbol?.path, "src/services/my-service.ts");
    assert.equal(staleRef?.symbol?.line, 10);

    // Injectable includes both the resolved unique match AND the stale fallback
    assert.equal(result.injectable.length, 2);
    const injectableNames = result.injectable.map((r) => r.parsed.name).sort();
    assert.deepEqual(injectableNames, ["Database", "MyService"]);

    // Unresolved ref is NOT in injectable
    assert.ok(
      !result.injectable.some((r) => r.parsed.name === "NonExistent"),
      "unresolved ref should NOT be in injectable",
    );
  });

  // ── Lookup deduplication ────────────────────────────────────────

  void it("looks up a repeated name only once per resolve call", async () => {
    // Plain and stable references to the same name share one lookup.
    const parsed = parsePrompt(
      "#MyService\n#MyService@src/services/my-service.ts:10\n#MyService@src/deprecated/my-service.ts:3",
    );
    const { backend, lookupCalls } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);
    assert.equal(
      lookupCalls.filter((n) => n === "MyService").length,
      1,
      "repeated references must share one lookup",
    );
  });

  void it("looks up each distinct name exactly once", async () => {
    const parsed = parsePrompt("#Database\n#Helper");
    const { backend, lookupCalls } = createMockBackend(SYMBOLS);
    await resolveReferences(parsed.references, backend);

    assert.deepEqual(lookupCalls.sort(), ["Database", "Helper"]);
  });

  // ── Edge cases ──────────────────────────────────────────────────

  void it("handles empty symbol index", async () => {
    const parsed = parsePrompt("#Database");
    const { backend } = createMockBackend([]);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.injectable.length, 0);
  });

  void it("handles empty parsed references", async () => {
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences([], backend);

    assert.equal(result.resolved.length, 0);
    assert.equal(result.injectable.length, 0);
  });

  void it("handles multiple references with mixed resolution outcomes", async () => {
    const parsed = parsePrompt([
      "#config",                             // unique → resolved
      "#MyService@src/services/my-service.ts:10", // exact match → resolved
      "#NonExistent",                        // no match → unresolved
      "#MyService@src/nonexistent/file.ts:1",    // wrong file → unresolved
      "#Helper",                             // ambiguous → ambiguous
    ].join("\n"));
    const { backend } = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 5);

    const config = result.resolved.find((r) => r.parsed.name === "config");
    assert.equal(config?.status, "resolved");
    assert.ok(config?.symbol !== null);

    const myServiceExact = result.resolved.find(
      (r) => r.parsed.name === "MyService" && r.parsed.type === "stable" && r.parsed.path === "src/services/my-service.ts",
    );
    assert.equal(myServiceExact?.status, "resolved");
    assert.ok(myServiceExact?.symbol !== null);

    const nonExistent = result.resolved.find((r) => r.parsed.name === "NonExistent");
    assert.equal(nonExistent?.status, "unresolved");

    const wrongFile = result.resolved.find(
      (r) => r.parsed.type === "stable" && r.parsed.path === "src/nonexistent/file.ts",
    );
    assert.equal(wrongFile?.status, "unresolved");

    const helper = result.resolved.find((r) => r.parsed.name === "Helper");
    assert.equal(helper?.status, "ambiguous");

    assert.equal(result.injectable.length, 2); // config + exact MyService
    const injectableNames = result.injectable.map((r) => r.parsed.name).sort();
    assert.deepEqual(injectableNames, ["MyService", "config"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DOTTED RESOLVER TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("dotted resolver", () => {
  // Symbols with parentName for dotted resolution tests
  const DOTTED_SYMBOLS: ProjectSymbol[] = [
    ...SYMBOLS,
    { name: "reservation_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 42, depth: 1 },
    { name: "reservation_expiration_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 55, depth: 1 },
    { name: "status", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 60, depth: 1 },
    // Duplicate Campaign.status in another file (for ambiguous dotted plain test)
    { name: "status", kind: "property", parentName: "Campaign", path: "src/models/campaign_alt.ts", line: 10, depth: 1 },
    // Same member name under a different parent
    { name: "status", kind: "property", parentName: "Order", path: "src/models/order.ts", line: 30, depth: 1 },
  ];

  // ── Dotted stable token resolution ────────────────────────────────

  void it("resolves dotted stable token by parent+member+path+line", async () => {
    const parsed = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:42");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
    assert.equal(r.symbol?.path, "src/models/campaign.ts");
    assert.equal(r.symbol?.line, 42);
  });

  void it("resolves dotted stable token as stale when line differs but parent+member+path match", async () => {
    const parsed = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:999");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "stale");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
    assert.equal(r.symbol?.path, "src/models/campaign.ts");
    assert.equal(r.symbol?.line, 42);
    assert.ok(r.message.includes("stale"));
  });

  void it("does NOT cross-file fallback for stale dotted stable token", async () => {
    // Same parent+member but different file should NOT resolve
    const parsed = parsePrompt("#Campaign.reservation_date@src/other/file.ts:42");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted stable token with wrong parent", async () => {
    const parsed = parsePrompt("#Order.reservation_date@src/models/campaign.ts:42");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted stable token with wrong member", async () => {
    const parsed = parsePrompt("#Campaign.nonExistent@src/models/campaign.ts:42");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("resolves dotted stable token with non-dotted stable token on same line", async () => {
    const parsed = parsePrompt([
      "#Campaign.reservation_date@src/models/campaign.ts:42",
      "#Database",
    ].join("\n"));
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 2);
    const dotted = result.resolved.find((r) => r.parsed.name === "Campaign.reservation_date");
    assert.equal(dotted?.status, "resolved");
    assert.equal(dotted?.symbol?.parentName, "Campaign");

    const db = result.resolved.find((r) => r.parsed.name === "Database");
    assert.equal(db?.status, "resolved");
  });

  // ── Dotted plain token resolution ────────────────────────────────

  void it("resolves unique dotted plain token by parent+member", async () => {
    const parsed = parsePrompt("#Campaign.reservation_date");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
    assert.equal(r.symbol?.path, "src/models/campaign.ts");
    assert.equal(r.symbol?.line, 42);
  });

  void it("reports ambiguous for dotted plain token with same parent+member across files", async () => {
    // Campaign.status exists in two files, so it should be ambiguous
    const parsed = parsePrompt("#Campaign.status");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("ambiguous") || r.message.includes("multiple"));
  });

  void it("resolves dotted plain token when same member name exists under different parent", async () => {
    // Campaign.reservation_date is unique even though Order.status exists
    const parsed = parsePrompt("#Order.status");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "status");
    assert.equal(r.symbol?.parentName, "Order");
  });

  void it("reports unresolved for dotted plain token with no matching parent+member", async () => {
    const parsed = parsePrompt("#Campaign.nonExistent");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted plain token with no matching parent", async () => {
    const parsed = parsePrompt("#NonExistent.status");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("resolves non-dotted tokens alongside dotted plain tokens", async () => {
    const parsed = parsePrompt("#Database and #Campaign.reservation_date");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 2);

    const dbRef = result.resolved.find((r) => r.parsed.name === "Database");
    assert.equal(dbRef?.status, "resolved");

    const dottedRef = result.resolved.find((r) => r.parsed.name === "Campaign.reservation_date");
    assert.equal(dottedRef?.status, "resolved");
    assert.equal(dottedRef?.symbol?.parentName, "Campaign");
    assert.equal(dottedRef?.symbol?.name, "reservation_date");
  });

  void it("includes dotted resolved plain ref in injectable list", async () => {
    const parsed = parsePrompt("#Database\n#Campaign.reservation_date\n#Campaign.nonExistent");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);

    // injectable should include resolved non-dotted + resolved dotted
    assert.ok(result.injectable.some(
      (r) => r.parsed.name === "Database" && r.status === "resolved",
    ), "Database should be injectable");
    assert.ok(result.injectable.some(
      (r) => r.parsed.name === "Campaign.reservation_date" && r.status === "resolved",
    ), "Campaign.reservation_date should be injectable");

    // Unresolved should not be injectable
    assert.ok(!result.injectable.some(
      (r) => r.parsed.name === "Campaign.nonExistent",
    ), "unresolved should not be injectable");
  });

  void it("includes dotted stale stable ref in injectable list", async () => {
    const parsed = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:999\n#Database");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 2);

    const staleRef = result.resolved.find(
      (r) => r.parsed.name === "Campaign.reservation_date" && r.parsed.type === "stable",
    );
    assert.ok(staleRef, "dotted stable token should have a resolution outcome");
    assert.equal(staleRef?.status, "stale");
    assert.ok(staleRef?.symbol !== null, "stale fallback should have a symbol");

    // Injectable should include both resolved and stale
    assert.equal(result.injectable.length, 2);
    const injectableNames = result.injectable.map((r) => r.parsed.name).sort();
    assert.deepEqual(injectableNames, ["Campaign.reservation_date", "Database"]);
  });

  void it("does not include ambiguous dotted plain ref in injectable list", async () => {
    const parsed = parsePrompt("#Campaign.status");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "ambiguous");
    assert.equal(result.injectable.length, 0);
  });

  // ── Multi-dot regression tests ─────────────────────────────────

  void it("reports unresolved for multi-dot plain token #A.B.C", async () => {
    const parsed = parsePrompt("#A.B.C");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    // Must NOT split as parent=A, member=B.C
    assert.ok(r.message.includes("Unresolved") || r.message.includes("not found") || r.message.includes("no symbol"));
  });

  void it("reports unresolved for multi-dot stable token #A.B.C@path:line", async () => {
    const parsed = parsePrompt("#A.B.C@src/foo.ts:1");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    // Must NOT split as parent=A, member=B.C
    assert.ok(r.message.includes("multi-dot"));
  });

  void it("reports unresolved for four-segment dotted plain token", async () => {
    const parsed = parsePrompt("#Namespace.Campaign.reservation_date");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  void it("still resolves valid two-segment dotted plain token", async () => {
    // Regression: ensure #Parent.member still works after multi-dot fix
    const parsed = parsePrompt("#Campaign.reservation_date");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
  });

  void it("still resolves valid two-segment dotted stable token", async () => {
    // Regression: ensure #Parent.member@path:line still works after multi-dot fix
    const parsed = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:42");
    const { backend } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
    assert.equal(r.symbol?.path, "src/models/campaign.ts");
    assert.equal(r.symbol?.line, 42);
  });

  void it("does not look up multi-dot names", async () => {
    // Multi-dot chains are unsupported: they must not reach the backend.
    const parsed = parsePrompt("#A.B.C\n#Namespace.Campaign.reservation_date");
    const { backend, lookupCalls } = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 2);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[1].status, "unresolved");
    assert.equal(lookupCalls.length, 0, "multi-dot names must not trigger lookups");
  });

  // ── Multi-dot regression tests: literal dotted symbol ───────────

  void it("reports unresolved for multi-dot plain #A.B.C even when literal A.B.C exists", async () => {
    // Regression: a literal symbol named "A.B.C" must NOT be resolved
    // via #A.B.C because multi-dot refs are unsupported chains in v1.
    const LITERAL_DOTTED_SYMBOLS: ProjectSymbol[] = [
      ...DOTTED_SYMBOLS,
      { name: "A.B.C", kind: "class", path: "x.ts", line: 1 },
    ];
    const parsed = parsePrompt("#A.B.C");
    const { backend } = createMockBackend(LITERAL_DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("multi-dot"));
  });

  void it("reports unresolved for multi-dot stable #A.B.C@x.ts:1 even when literal A.B.C exists", async () => {
    const LITERAL_DOTTED_SYMBOLS: ProjectSymbol[] = [
      ...DOTTED_SYMBOLS,
      { name: "A.B.C", kind: "class", path: "x.ts", line: 1 },
    ];
    const parsed = parsePrompt("#A.B.C@x.ts:1");
    const { backend } = createMockBackend(LITERAL_DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("multi-dot"));
  });

  void it("still resolves normal non-dotted refs when literal dotted symbol exists", async () => {
    // Ensure non-dotted refs are not affected by the presence of dotted-name symbols
    const LITERAL_DOTTED_SYMBOLS: ProjectSymbol[] = [
      ...DOTTED_SYMBOLS,
      { name: "A.B.C", kind: "class", path: "x.ts", line: 1 },
    ];
    const parsed = parsePrompt("#Database");
    const { backend } = createMockBackend(LITERAL_DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "Database");
  });

  void it("still resolves valid two-segment dotted refs when literal dotted symbol exists", async () => {
    const LITERAL_DOTTED_SYMBOLS: ProjectSymbol[] = [
      ...DOTTED_SYMBOLS,
      { name: "A.B.C", kind: "class", path: "x.ts", line: 1 },
    ];
    const parsed = parsePrompt("#Campaign.reservation_date");
    const { backend } = createMockBackend(LITERAL_DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
  });
});
