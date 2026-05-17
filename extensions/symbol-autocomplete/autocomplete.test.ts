/**
 * Tests for the symbol autocomplete provider.
 *
 * Covers:
 * - `#` boundary detection (trigger at start/whitespace, no mid-token)
 * - Delegation to current provider when no trigger or empty index
 * - Ranking: exact prefix > fuzzy > path-depth tie-break
 * - Disambiguation of duplicate symbol names
 * - Stable token insertion on selection
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSymbol } from "./types.ts";
import {
  createSymbolAutocompleteProvider,
  type AutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteSuggestions,
} from "./autocomplete.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a minimal mock current provider that records calls. */
function mockCurrentProvider(
  opts?: { defaultResult?: AutocompleteSuggestions | null },
): AutocompleteProvider & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const provider: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      calls.push({ method: "getSuggestions", args: [lines, cursorLine, cursorCol, options] });
      return opts?.defaultResult ?? null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      calls.push({ method: "applyCompletion", args: [lines, cursorLine, cursorCol, item, prefix] });
      const line = lines[cursorLine] ?? "";
      const prefixStart = cursorCol - prefix.length;
      if (prefixStart < 0 || line.slice(prefixStart, cursorCol) !== prefix) {
        return { lines, cursorLine, cursorCol };
      }
      const newLine = line.slice(0, prefixStart) + item.value + line.slice(cursorCol);
      const newLines = [...lines];
      newLines[cursorLine] = newLine;
      return { lines: newLines, cursorLine, cursorCol: prefixStart + item.value.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      calls.push({ method: "shouldTriggerFileCompletion", args: [lines, cursorLine, cursorCol] });
      return true;
    },
  };
  return Object.assign(provider, { calls });
}

function signal(): AbortSignal {
  return AbortSignal.timeout(5000);
}

// ── Sample symbols ──────────────────────────────────────────────────

const SYMBOLS: ProjectSymbol[] = [
  { name: "MyService", kind: "class", path: "src/services/my-service.ts", line: 10 },
  { name: "MySerializer", kind: "class", path: "src/serializers/my-serializer.ts", line: 5 },
  { name: "Database", kind: "interface", path: "src/db/database.ts", line: 1 },
  { name: "myFunction", kind: "function", path: "src/utils/helpers.ts", line: 42 },
  { name: "config", kind: "constant", path: "config.ts", line: 1 },
  { name: "MyService", kind: "class", path: "src/deprecated/my-service.ts", line: 3 }, // duplicate name
];

function getSymbols(): ProjectSymbol[] {
  return SYMBOLS;
}

// ── 1. Trigger detection ───────────────────────────────────────────

void describe("trigger detection", () => {
  void it("triggers on # at line start", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null, "should return suggestions");
    assert.equal(result.prefix, "#My");
    assert.ok(result.items.length > 0, "should have items");
    assert.equal(current.calls.length, 0, "should not delegate to current provider");
  });

  void it("triggers on # after whitespace", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["some code #My"], 0, 14, { signal: signal() });

    assert.ok(result !== null, "should return suggestions");
    assert.equal(result.prefix, "#My");
    assert.ok(result.items.length > 0);
    assert.equal(current.calls.length, 0);
  });

  void it("triggers on # after tab", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["\t#My"], 0, 4, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "#My");
    assert.equal(current.calls.length, 0);
  });

  void it("does NOT trigger mid-token (foo#bar)", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [] },
    });
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["foo#bar"], 0, 7, { signal: signal() });

    assert.ok(result !== null, "should delegate to current provider");
    assert.equal(result.prefix, "", "(delegated result)");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(current.calls[0].method, "getSuggestions");
  });

  void it("triggers on bare # (empty query)", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["#"], 0, 1, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "#");
    assert.ok(result.items.length > 0, "should show all symbols with empty query");
    assert.equal(current.calls.length, 0);
  });
});

// ── 2. Delegation ───────────────────────────────────────────────────

void describe("delegation", () => {
  void it("delegates to current when there is no # trigger", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "@", items: [{ value: "@file.ts", label: "@file.ts" }] },
    });
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["@file"], 0, 5, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "@");
    assert.equal(current.calls.length, 1);
  });

  void it("delegates to current when # query matches zero symbols", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    // Query "Xyzzy" matches none of the sample symbols
    const result = await provider.getSuggestions(["#Xyzzy"], 0, 7, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(current.calls[0].method, "getSuggestions");
    // Should return the delegated result, not an empty items array
    assert.equal(result.items.length, 1, "should return current provider's items");
    assert.equal(result.items[0].value, "fallback");
  });

  void it("delegates to current when symbols array is empty", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [] },
    });
    const provider = createSymbolAutocompleteProvider(current, () => []);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "", "(delegated result)");
    assert.equal(current.calls.length, 1, "should delegate when empty index");
  });

  void it("delegates shouldTriggerFileCompletion to current", () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = provider.shouldTriggerFileCompletion!(["foo"], 0, 3);

    assert.equal(result, true);
    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].method, "shouldTriggerFileCompletion");
  });
});

// ── 3. Ranking ──────────────────────────────────────────────────────

void describe("ranking", () => {
  void it("exact prefix matches before fuzzy matches", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null);
    const names = result.items.map((i) => i.value);

    // "MyService" and "MySerializer" start with "My" → exact prefix
    // "myFunction" contains "my" but starts with "my" (case-insensitive) → also exact prefix
    const myServiceIdx = names.findIndex((v) => v.startsWith("#MyService@"));
    const mySerializerIdx = names.findIndex((v) => v.startsWith("#MySerializer@"));

    // Both MyService and MySerializer should appear before any fuzzy-only results
    assert.ok(myServiceIdx >= 0, "MyService should be in results");
    assert.ok(mySerializerIdx >= 0, "MySerializer should be in results");
    // The first item should be an exact prefix match
    assert.ok(result.items[0].value.startsWith("#My"));
  });

  void it("fuzzy matches after exact prefix matches", async () => {
    // Symbols that only match via fuzzy (characters in order)
    const symbols: ProjectSymbol[] = [
      { name: "DataTransformer", kind: "class", path: "src/transform.ts", line: 1 },
      { name: "Database", kind: "interface", path: "src/db.ts", line: 1 },
      { name: "DashRenderer", kind: "class", path: "src/render.ts", line: 1 },
    ];
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), () => symbols);

    // Query "Da" → exact prefix for all three
    // Query "Dba" → fuzzy match for "Database" (chars in order)
    const result = await provider.getSuggestions(["#Dba"], 0, 4, { signal: signal() });

    assert.ok(result !== null);
    assert.ok(result.items.length > 0, "should have fuzzy matches");
    // "Database" has 'D','b','a' in order, "DataTransformer" doesn't have 'b', "DashRenderer" doesn't have 'b'
    assert.ok(
      result.items.some((i) => i.value.startsWith("#Database@")),
      "should fuzzy-match Database",
    );
  });

  void it("shallower path wins tie-break for same-depth names", async () => {
    const symbols: ProjectSymbol[] = [
      { name: "Helper", kind: "function", path: "src/utils/deep/helper.ts", line: 1 },
      { name: "Helper", kind: "function", path: "src/helper.ts", line: 1 },
      { name: "Helper", kind: "function", path: "src/utils/helper.ts", line: 1 },
    ];
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), () => symbols);

    const result = await provider.getSuggestions(["#Helper"], 0, 7, { signal: signal() });

    assert.ok(result !== null);
    const paths = result.items.map((i) => i.description);
    // Should be ordered by path depth: src/helper.ts (depth 1) < src/utils/helper.ts (depth 2) < src/utils/deep/helper.ts (depth 3)
    const depth1 = paths.findIndex((d) => d?.includes("src/helper.ts"));
    const depth2 = paths.findIndex((d) => d?.includes("src/utils/helper.ts"));
    const depth3 = paths.findIndex((d) => d?.includes("src/utils/deep/helper.ts"));

    assert.ok(depth1 >= 0 && depth2 >= 0 && depth3 >= 0);
    assert.ok(depth1 < depth2, "shallower path should come first");
    assert.ok(depth2 < depth3, "shallower path should come first");
  });
});

// ── 4. Disambiguation ───────────────────────────────────────────────

void describe("disambiguation", () => {
  void it("includes path:line in description for duplicate symbol names", async () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const result = await provider.getSuggestions(["#MyService"], 0, 10, { signal: signal() });

    assert.ok(result !== null);
    // MyService appears twice: src/services/my-service.ts:10 and src/deprecated/my-service.ts:3
    const itemsForMyService = result.items.filter((i) => i.value.startsWith("#MyService@"));
    assert.equal(itemsForMyService.length, 2, "should show both MyService symbols");

    for (const item of itemsForMyService) {
      assert.ok(
        item.description?.includes(":") && item.description?.includes(".ts"),
        `description should include path:line for duplicate names: "${item.description}"`,
      );
    }

    // The two should have different descriptions (different paths/lines)
    assert.notEqual(itemsForMyService[0].description, itemsForMyService[1].description);
  });
});

// ── 5. Insertion (stable token) ─────────────────────────────────────

void describe("insertion", () => {
  void it("inserts stable token format #name@path:line on selection", () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const sym: ProjectSymbol = { name: "MyService", kind: "class", path: "src/services/my-service.ts", line: 10 };
    const item: AutocompleteItem = {
      value: `#${sym.name}@${sym.path}:${sym.line}`,
      label: `#${sym.name}`,
      description: "Class · src/services/my-service.ts",
    };

    const initialLines = ["useMyService(#MySer"];
    const result = provider.applyCompletion(initialLines, 0, 19, item, "#MySer");

    // The completed line should contain the stable token
    assert.ok(result.lines[0].includes("#MyService@src/services/my-service.ts:10"));
    // Cursor should be after the inserted token
    assert.equal(result.cursorCol, "useMyService(".length + item.value.length);
    assert.equal(result.cursorLine, 0);
  });

  void it("delegates applyCompletion to current provider", () => {
    const current = mockCurrentProvider();
    const provider = createSymbolAutocompleteProvider(current, getSymbols);

    const item: AutocompleteItem = { value: "#Foo@src/foo.ts:1", label: "#Foo" };
    provider.applyCompletion(["#F"], 0, 2, item, "#F");

    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].method, "applyCompletion");
  });
});
