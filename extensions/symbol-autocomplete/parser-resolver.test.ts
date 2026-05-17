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
 * - Diagnostic metadata on all resolution outcomes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSymbol, ParseResult, ResolveResult } from "./types.ts";
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

function refs(symbols: ProjectSymbol[]): ProjectSymbol[] {
  return symbols;
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
});

// ═══════════════════════════════════════════════════════════════════════
// RESOLVER TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("resolver", () => {
  // ── Stable token resolution ─────────────────────────────────────

  void it("resolves stable token with exact path+line match", () => {
    const parsed = parsePrompt("#MyService@src/services/my-service.ts:10");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "MyService");
    assert.equal(r.symbol?.path, "src/services/my-service.ts");
    assert.equal(r.symbol?.line, 10);
    assert.equal(r.parsed.type, "stable");
  });

  void it("resolves stable token with stale line (same name+file, different line)", () => {
    // Symbol exists at MyService in same file but at line 10, not 99
    const parsed = parsePrompt("#MyService@src/services/my-service.ts:99");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "stale");             // stale indicator since line didn't match
    assert.equal(r.symbol?.name, "MyService");   // same name
    assert.equal(r.symbol?.path, "src/services/my-service.ts"); // same file
    assert.equal(r.symbol?.line, 10);           // correct line from index
    assert.ok(r.message.includes("stale") || r.message.includes("line"));
  });

  void it("reports unresolved for stable token with wrong file", () => {
    const parsed = parsePrompt("#MyService@src/nonexistent/file.ts:10");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("unresolved") || r.message.includes("not found"));
  });

  void it("does NOT resolve stable token with wrong name on existing path+line", () => {
    // Regression: stable token must match name + path + line, not path+line alone.
    // #NonExistent at path:line where MyService exists should NOT resolve.
    const parsed = parsePrompt("#NonExistent@src/services/my-service.ts:10");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("unresolved") || r.message.includes("not found"));
  });

  void it("resolves stable token where same name exists but different file — uses stale chain same-file", () => {
    // MyService exists in two files. Stable token points to file that has it.
    const parsed = parsePrompt("#MyService@src/deprecated/my-service.ts:3");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved"); // exact match path+line
    assert.equal(r.symbol?.path, "src/deprecated/my-service.ts");
    assert.equal(r.symbol?.line, 3);
  });

  void it("does NOT cross-file fallback for stale stable token", () => {
    // MyService exists at src/services/my-service.ts:10 and src/deprecated/my-service.ts:3
    // Stable token points to src/nonexistent/my-service.ts:99 — wrong file entirely
    const parsed = parsePrompt("#MyService@src/nonexistent/my-service.ts:99");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    // Should NOT cross-file fallback: no MyService in src/nonexistent/, so unresolved
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  // ── Plain token resolution ──────────────────────────────────────

  void it("resolves plain #name with unique match", () => {
    const parsed = parsePrompt("#Database");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "Database");
    assert.equal(r.symbol?.path, "src/db/database.ts");
  });

  void it("reports ambiguous for plain #name with multiple matches", () => {
    const parsed = parsePrompt("#MyService");  // two MyService symbols
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);            // no injection for ambiguous
    assert.ok(r.message.includes("ambiguous") || r.message.includes("multiple"));
  });

  void it("reports unresolved for plain #name with no match", () => {
    const parsed = parsePrompt("#NonExistent");
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  void it("reports ambiguous for #name with multiple matches of same name across files", () => {
    const parsed = parsePrompt("#Helper");  // two Helper symbols
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);
  });

  // ── Injectable results ──────────────────────────────────────────

  void it("includes resolved and stale references in injectable list", () => {
    const parsed = parsePrompt("#Database\n#MyService\n#NonExistent");
    // #Database → unique, #MyService → ambiguous, #NonExistent → unresolved
    const result = resolveReferences(parsed.references, SYMBOLS);

    assert.equal(result.resolved.length, 3);
    assert.equal(result.injectable.length, 1);
    assert.equal(result.injectable[0].parsed.name, "Database");
    assert.equal(result.injectable[0].status, "resolved");
  });

  void it("includes stale stable token in injectable list", () => {
    // Regression: stable token with same name+file but stale line should
    // be injectable (has a fallback symbol) while surfacing stale warning.
    const parsed = parsePrompt(
      "#MyService@src/services/my-service.ts:999" +
      "\n#Database" +
      "\n#NonExistent"
    );
    const result = resolveReferences(parsed.references, SYMBOLS);

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

  // ── Edge cases ──────────────────────────────────────────────────

  void it("handles empty symbol index", () => {
    const parsed = parsePrompt("#Database");
    const result = resolveReferences(parsed.references, []);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.injectable.length, 0);
  });

  void it("handles empty parsed references", () => {
    const result = resolveReferences([], SYMBOLS);

    assert.equal(result.resolved.length, 0);
    assert.equal(result.injectable.length, 0);
  });

  void it("handles multiple references with mixed resolution outcomes", () => {
    const parsed = parsePrompt([
      "#config",                             // unique → resolved
      "#MyService@src/services/my-service.ts:10", // exact match → resolved
      "#NonExistent",                        // no match → unresolved
      "#MyService@src/nonexistent/file.ts:1",    // wrong file → unresolved
      "#Helper",                             // ambiguous → ambiguous
    ].join("\n"));

    const result = resolveReferences(parsed.references, SYMBOLS);

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
