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
 * - Resolver scan deduplication (one scan per distinct name)
 * - Bounded per-reference candidate state with real readtags fixtures (>50 matches)
 * - Diagnostic metadata on all resolution outcomes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectSymbol } from "./types.ts";
import { parsePrompt } from "./reference-parser.ts";
import { resolveReferences } from "./resolver.ts";
import { createReadtagsBackend } from "./readtags-backend.ts";
import {
  classicTagLine,
  createFakeReadtagsBackend,
  hasBinary,
  withTempDir,
} from "./test-support.ts";

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
 * Create a mock backend whose scanExact streams the exact-name matches
 * from `symbols`. The fake records every scanned name for dedup asserts.
 */
function createMockBackend(symbols: ProjectSymbol[]) {
  return createFakeReadtagsBackend({
    scanExact: async (name, onSymbol) => {
      for (const symbol of symbols) {
        if (symbol.name === name) onSymbol(symbol);
      }
    },
  });
}

// ── Real readtags fixtures (P1: >50 identical tag names) ─────────────

const SKIP_NO_READTAGS = hasBinary("readtags") ? false : "readtags binary not available";

/** Write a classic-format tags file and return its path. */
function writeTagsFile(dir: string, lines: string[]): string {
  const tagsPath = path.join(dir, "tags");
  fs.writeFileSync(
    tagsPath,
    [
      "!_TAG_FILE_FORMAT\t2\t/extended format/",
      "!_TAG_FILE_SORTED\t2\t/0=unsorted, 1=sorted, 2=foldcase/",
      ...lines,
    ].join("\n") + "\n",
  );
  return tagsPath;
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

  void it("does NOT parse #name after non-whitespace character", () => {
    assert.equal(parsePrompt("a#MyService").references.length, 0);
    assert.equal(parsePrompt("foo#MyService").references.length, 0);
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

  void it("parses #name followed by comma", () => {
    const result = parsePrompt("use #MyService, #Database");
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].name, "MyService");
    assert.equal(result.references[1].name, "Database");

    // A trailing period is punctuation too; it never joins the name.
    const trailing = parsePrompt("check #MyService.");
    assert.equal(trailing.references.length, 1);
    assert.equal(trailing.references[0].raw, "#MyService");
    assert.equal(trailing.references[0].name, "MyService");
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "Database");
    assert.equal(r.symbol?.path, "src/db/database.ts");
  });

  void it("reports ambiguous for plain #name with multiple matches", async () => {
    const parsed = parsePrompt("#MyService");  // two MyService symbols
    const backend = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "ambiguous");
    assert.equal(r.symbol, null);            // no injection for ambiguous
    assert.ok(r.message.includes("ambiguous") || r.message.includes("multiple"));
  });

  void it("reports unresolved for plain #name with no match", async () => {
    const parsed = parsePrompt("#NonExistent");
    const backend = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  void it("reports ambiguous for #name with multiple matches of same name across files", async () => {
    const parsed = parsePrompt("#Helper");  // two Helper symbols
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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

  // ── Scan deduplication ────────────────────────────────────────

  void it("scans a repeated name only once per resolve call", async () => {
    // Plain and stable references to the same name share one scan.
    const parsed = parsePrompt(
      "#MyService\n#MyService@src/services/my-service.ts:10\n#MyService@src/deprecated/my-service.ts:3",
    );
    const backend = createMockBackend(SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);
    assert.equal(
      backend.scans.filter((n) => n === "MyService").length,
      1,
      "repeated references must share one scan",
    );
  });

  void it("scans each distinct name exactly once", async () => {
    const parsed = parsePrompt("#Database\n#Helper");
    const backend = createMockBackend(SYMBOLS);
    await resolveReferences(parsed.references, backend);

    assert.deepEqual(backend.scans.sort(), ["Database", "Helper"]);
  });

  void it("shares one scan across plain, stable, and dotted refs with the same key", async () => {
    // P2: plain/stable refs on name "seed" and a dotted ref whose member
    // name is "seed" must trigger exactly one scanExact call.
    const SEED_SYMBOLS: ProjectSymbol[] = [
      ...SYMBOLS,
      { name: "seed", kind: "function", path: "src/seed.ts", line: 1 },
      { name: "seed", kind: "function", path: "src/seed.ts", line: 60 },
      { name: "seed", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 5 },
    ];
    const parsed = parsePrompt(
      "#seed\n#seed@src/seed.ts:60\n#Campaign.seed",
    );
    const backend = createMockBackend(SEED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 3);
    assert.equal(backend.scans.length, 1, "one distinct key must use exactly one scan");
    assert.equal(backend.scans[0], "seed");

    // The dotted ref filters by parent within the same shared stream.
    const dotted = result.resolved.find((r) => r.parsed.name === "Campaign.seed");
    assert.equal(dotted?.status, "resolved");
    assert.equal(dotted?.symbol?.parentName, "Campaign");
  });

  void it("rejects when a backend scan rejects", async () => {
    // P2: an incomplete scan must reject resolveReferences, never return
    // partial results as complete.
    const backend = createFakeReadtagsBackend({
      scanExact: async () => {
        throw new Error("exact scan did not complete (capped)");
      },
    });
    const parsed = parsePrompt("#Database");
    await assert.rejects(
      resolveReferences(parsed.references, backend),
      /did not complete/,
    );
  });

  void it("admits at most 8 distinct lookup names and omits later names", async () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const symbols: ProjectSymbol[] = names.map((name, index) => ({
      name,
      kind: "class",
      path: `src/${name.toLowerCase()}.ts`,
      line: index + 1,
    }));
    const backend = createMockBackend(symbols);
    const parsed = parsePrompt(names.map((n) => `#${n}`).join("\n"));
    const result = await resolveReferences(parsed.references, backend);

    assert.deepEqual(backend.scans, names.slice(0, 8), "only the first 8 distinct names may scan");
    assert.equal(result.resolved.length, 9);
    assert.ok(result.resolved.slice(0, 8).every((r) => r.status === "resolved"));
    const ninth = result.resolved[8];
    assert.equal(ninth.status, "unresolved");
    assert.equal(ninth.symbol, null);
    assert.match(ninth.message, /8-name lookup limit/);
    assert.equal(result.injectable.length, 8);
  });

  void it("keeps shared names in one admitted scan across the limit", async () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const symbols: ProjectSymbol[] = names.map((name, index) => ({
      name,
      kind: "class",
      path: `src/${name.toLowerCase()}.ts`,
      line: index + 1,
    }));
    const backend = createMockBackend(symbols);
    // Nine distinct names plus a repeated reference to B.
    const parsed = parsePrompt(names.map((n) => `#${n}`).join("\n") + "\n#B");
    const result = await resolveReferences(parsed.references, backend);

    assert.deepEqual(backend.scans, names.slice(0, 8));
    assert.equal(result.resolved.length, 10);
    const bRefs = result.resolved.filter((r) => r.parsed.name === "B");
    assert.equal(bRefs.length, 2);
    assert.ok(bRefs.every((r) => r.status === "resolved"));
    assert.equal(backend.scans.filter((n) => n === "B").length, 1, "shared names use one scan");
    const omitted = result.resolved.find((r) => r.parsed.name === "I");
    assert.equal(omitted?.status, "unresolved");
    assert.match(omitted?.message ?? "", /8-name lookup limit/);
  });

  void it("bounds all admitted scans with one total deadline", async () => {
    // Each scan hangs until the shared resolver signal aborts at the
    // total deadline. Every scan must receive the abort instead of each
    // scan running its own window. The test seam shortens the deadline.
    const backend = createFakeReadtagsBackend({
      scanExact: async (_name, _onSymbol, signal) => {
        if (!signal) throw new Error("resolver must pass its total-deadline signal");
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("resolver deadline aborted the scan")),
            { once: true },
          );
        });
      },
    });
    const parsed = parsePrompt(["#A", "#B", "#C"].join("\n"));
    const started = Date.now();
    await assert.rejects(
      resolveReferences(parsed.references, backend, { deadlineMs: 100 }),
      /resolver deadline aborted/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `three scans must share one deadline (took ${elapsed} ms)`);
  });

  void it("aborts sibling scans when one scan rejects early", async () => {
    // One rejected scan rejects the whole call. The shared controller
    // must abort the sibling scan, so no child streams until the
    // deadline after the call already failed.
    let siblingAborted = false;
    const backend = createFakeReadtagsBackend({
      scanExact: async (name, _onSymbol, signal) => {
        if (name === "A") throw new Error('exact scan of "A" did not complete (interrupted)');
        if (!signal) throw new Error("resolver must pass its total-deadline signal");
        await new Promise<void>((resolve) => {
          const markAborted = () => {
            siblingAborted = true;
            resolve();
          };
          if (signal.aborted) markAborted();
          else signal.addEventListener("abort", markAborted, { once: true });
        });
      },
    });
    const parsed = parsePrompt(["#A", "#B"].join("\n"));
    await assert.rejects(
      resolveReferences(parsed.references, backend),
      /did not complete/,
    );
    assert.equal(siblingAborted, true, "the sibling scan must receive the abort");
  });

  // ── Edge cases ──────────────────────────────────────────────────

  void it("handles empty symbol index", async () => {
    const parsed = parsePrompt("#Database");
    const backend = createMockBackend([]);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.injectable.length, 0);
  });

  void it("handles empty parsed references", async () => {
    const backend = createMockBackend(SYMBOLS);
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
    const backend = createMockBackend(SYMBOLS);
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
    { name: "reservation_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 42 },
    { name: "reservation_expiration_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 55 },
    { name: "status", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 60 },
    // Duplicate Campaign.status in another file (for ambiguous dotted plain test)
    { name: "status", kind: "property", parentName: "Campaign", path: "src/models/campaign_alt.ts", line: 10 },
    // Same member name under a different parent
    { name: "status", kind: "property", parentName: "Order", path: "src/models/order.ts", line: 30 },
  ];

  // ── Dotted stable token resolution ────────────────────────────────

  void it("resolves dotted stable token by parent+member+path+line", async () => {
    const parsed = parsePrompt("#Campaign.reservation_date@src/models/campaign.ts:42");
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted stable token with wrong parent", async () => {
    const parsed = parsePrompt("#Order.reservation_date@src/models/campaign.ts:42");
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted stable token with wrong member", async () => {
    const parsed = parsePrompt("#Campaign.nonExistent@src/models/campaign.ts:42");
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "status");
    assert.equal(r.symbol?.parentName, "Order");
  });

  void it("reports unresolved for dotted plain token with no matching parent+member", async () => {
    const parsed = parsePrompt("#Campaign.nonExistent");
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("reports unresolved for dotted plain token with no matching parent", async () => {
    const parsed = parsePrompt("#NonExistent.status");
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[0].symbol, null);
  });

  void it("resolves non-dotted tokens alongside dotted plain tokens", async () => {
    const parsed = parsePrompt("#Database and #Campaign.reservation_date");
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "ambiguous");
    assert.equal(result.injectable.length, 0);
  });

  // ── Multi-dot regression tests ─────────────────────────────────

  void it("reports unresolved for multi-dot plain token #A.B.C", async () => {
    const parsed = parsePrompt("#A.B.C");
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
  });

  void it("still resolves valid two-segment dotted plain token", async () => {
    // Regression: ensure #Parent.member still works after multi-dot fix
    const parsed = parsePrompt("#Campaign.reservation_date");
    const backend = createMockBackend(DOTTED_SYMBOLS);
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
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "resolved");
    assert.equal(r.symbol?.name, "reservation_date");
    assert.equal(r.symbol?.parentName, "Campaign");
    assert.equal(r.symbol?.path, "src/models/campaign.ts");
    assert.equal(r.symbol?.line, 42);
  });

  void it("does not scan multi-dot names", async () => {
    // Multi-dot chains are unsupported: they must not reach the backend.
    const parsed = parsePrompt("#A.B.C\n#Namespace.Campaign.reservation_date");
    const backend = createMockBackend(DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 2);
    assert.equal(result.resolved[0].status, "unresolved");
    assert.equal(result.resolved[1].status, "unresolved");
    assert.equal(backend.scans.length, 0, "multi-dot names must not trigger scans");
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
    const backend = createMockBackend(LITERAL_DOTTED_SYMBOLS);
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
    const backend = createMockBackend(LITERAL_DOTTED_SYMBOLS);
    const result = await resolveReferences(parsed.references, backend);

    assert.equal(result.resolved.length, 1);
    const r = result.resolved[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.symbol, null);
    assert.ok(r.message.includes("multi-dot"));
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P1 REGRESSION: >50 identical tag names with the real readtags binary
// ═══════════════════════════════════════════════════════════════════════

void describe("resolver with >50 same-name records (real readtags)", { skip: SKIP_NO_READTAGS }, () => {
  const SEED_COUNT = 60;

  /** 60 `seed` records at src/seed.ts lines 1..60, plus dotted records. */
  function buildSeedFixture(dir: string): { tagsPath: string } {
    const lines: string[] = [];
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      lines.push(classicTagLine("seed", "src/seed.ts", "function", i, { useKindField: true }));
    }
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      lines.push(
        classicTagLine("reservation_date", "src/models/campaign.ts", "property", i, {
          useKindField: true,
          scope: "class:Campaign",
        }),
      );
    }
    return { tagsPath: writeTagsFile(dir, lines) };
  }

  void it("resolves a stable token whose exact target is record 51+", async () => {
    await withTempDir("sym-p1-seed-", async (dir) => {
      const { tagsPath } = buildSeedFixture(dir);
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });

      // Precondition: the target (line 60) is the last of 60 records, so
      // a capped lookup that keeps only 50 would miss it.
      const raw = spawnSync("readtags", ["-t", tagsPath, "-e", "-n", "-", "seed"]);
      assert.equal(raw.status, 0);
      const records = raw.stdout.toString().split("\n").filter((l) => l);
      assert.equal(records.length, SEED_COUNT);
      const targetIndex = records.findIndex((l) => l.includes("line:60"));
      assert.ok(targetIndex >= 50, `target must be record 51+ (got index ${targetIndex})`);

      const parsed = parsePrompt("#seed@src/seed.ts:60");
      const result = await resolveReferences(parsed.references, backend);

      assert.equal(result.resolved.length, 1);
      const r = result.resolved[0];
      assert.equal(r.status, "resolved");
      assert.equal(r.symbol?.name, "seed");
      assert.equal(r.symbol?.path, "src/seed.ts");
      assert.equal(r.symbol?.line, 60);
    });
  });

  void it("prefers a later exact line over an earlier same-file stale candidate", async () => {
    // Records 1..59 are same-file, non-exact (stale) candidates that arrive
    // before the exact record at line 60. The resolver must pick the exact
    // record, not the first stale fallback.
    await withTempDir("sym-p1-stale-", async (dir) => {
      const { tagsPath } = buildSeedFixture(dir);
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });

      const parsed = parsePrompt("#seed@src/seed.ts:60");
      const result = await resolveReferences(parsed.references, backend);

      assert.equal(result.resolved.length, 1);
      const r = result.resolved[0];
      assert.equal(r.status, "resolved", "exact match must beat the stale fallback");
      assert.equal(r.symbol?.line, 60);
      assert.ok(result.injectable.some((i) => i.parsed.name === "seed"));
    });
  });

  void it("still detects plain and dotted ambiguity after 50 records", async () => {
    await withTempDir("sym-p1-ambig-", async (dir) => {
      const { tagsPath } = buildSeedFixture(dir);
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });

      // Plain: 60 records named "seed" → ambiguous.
      const plain = await resolveReferences(parsePrompt("#seed").references, backend);
      assert.equal(plain.resolved[0].status, "ambiguous");
      assert.equal(plain.resolved[0].symbol, null);
      assert.ok(
        plain.resolved[0].message.includes("multiple"),
        "ambiguous diagnostic must say multiple matches",
      );
      assert.equal(plain.injectable.length, 0);

      // Dotted plain: 60 records with parent Campaign and member
      // reservation_date → ambiguous.
      const dotted = await resolveReferences(
        parsePrompt("#Campaign.reservation_date").references,
        backend,
      );
      assert.equal(dotted.resolved[0].status, "ambiguous");
      assert.equal(dotted.resolved[0].symbol, null);
      assert.ok(dotted.resolved[0].message.includes("multiple"));
      assert.equal(dotted.injectable.length, 0);
    });
  });
});
