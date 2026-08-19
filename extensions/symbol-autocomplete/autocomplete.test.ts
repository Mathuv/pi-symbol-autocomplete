/**
 * Tests for the symbol autocomplete provider.
 *
 * Covers:
 * - `#` boundary detection (trigger at start/whitespace, no mid-token)
 * - Delegation to current provider (bare `#`, bare `#Parent.`, empty
 *   results, backend errors)
 * - Routing: prefix queries to queryPrefix, dotted queries to queryDotted
 * - Result cap at 50 items, abort signal forwarding
 * - Disambiguation of duplicate symbol names within capped results
 * - Stable token insertion on selection
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ProjectSymbol, ReadtagsBackend } from "./types.ts";
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

/** Create a mock ReadtagsBackend that records calls. */
function createMockBackend(overrides?: {
  prefix?: (query: string, limit: number, signal?: AbortSignal) => Promise<ProjectSymbol[]>;
  dotted?: (parent: string, member: string, limit: number, signal?: AbortSignal) => Promise<ProjectSymbol[]>;
}): ReadtagsBackend & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend: ReadtagsBackend = {
    async queryPrefix(query, limit, signal) {
      calls.push({ method: "queryPrefix", args: [query, limit, signal] });
      return overrides?.prefix ? overrides.prefix(query, limit, signal) : [];
    },
    async queryDotted(parent, member, limit, signal) {
      calls.push({ method: "queryDotted", args: [parent, member, limit, signal] });
      return overrides?.dotted ? overrides.dotted(parent, member, limit, signal) : [];
    },
    async lookupExact() {
      return [];
    },
  };
  return Object.assign(backend, { calls });
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

const DOTTED_SYMBOLS: ProjectSymbol[] = [
  { name: "Campaign", kind: "class", path: "src/models/campaign.ts", line: 1 },
  { name: "reservation_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 42 },
  { name: "reservation_expiration_date", kind: "property", parentName: "Campaign", path: "src/models/campaign.ts", line: 43 },
  { name: "User", kind: "class", path: "src/models/user.ts", line: 1 },
  { name: "name", kind: "property", parentName: "User", path: "src/models/user.ts", line: 10 },
  { name: "email", kind: "property", parentName: "User", path: "src/models/user.ts", line: 15 },
];

// ── 1. Trigger detection ───────────────────────────────────────────

void describe("trigger detection", () => {
  void it("triggers on # at line start", async () => {
    const current = mockCurrentProvider();
    const backend = createMockBackend({
      prefix: async () => [SYMBOLS[0]],
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null, "should return suggestions");
    assert.equal(result.prefix, "#My");
    assert.ok(result.items.length > 0, "should have items");
    assert.equal(current.calls.length, 0, "should not delegate to current provider");
    assert.equal(backend.calls.length, 1, "should query the backend");
    assert.equal(backend.calls[0].method, "queryPrefix");
  });

  void it("triggers on # after whitespace", async () => {
    const current = mockCurrentProvider();
    const backend = createMockBackend({
      prefix: async () => [SYMBOLS[0]],
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["some code #My"], 0, 14, { signal: signal() });

    assert.ok(result !== null, "should return suggestions");
    assert.equal(result.prefix, "#My");
    assert.ok(result.items.length > 0);
    assert.equal(current.calls.length, 0);
  });

  void it("triggers on # after tab", async () => {
    const current = mockCurrentProvider();
    const backend = createMockBackend({
      prefix: async () => [SYMBOLS[0]],
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["\t#My"], 0, 4, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "#My");
    assert.equal(current.calls.length, 0);
  });

  void it("does NOT trigger mid-token (foo#bar)", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [] },
    });
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["foo#bar"], 0, 7, { signal: signal() });

    assert.ok(result !== null, "should delegate to current provider");
    assert.equal(result.prefix, "", "(delegated result)");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(current.calls[0].method, "getSuggestions");
    assert.equal(backend.calls.length, 0, "should not query the backend");
  });
});

// ── 2. Delegation ───────────────────────────────────────────────────

void describe("delegation", () => {
  void it("delegates to current when there is no # trigger", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "@", items: [{ value: "@file.ts", label: "@file.ts" }] },
    });
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["@file"], 0, 5, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.prefix, "@");
    assert.equal(current.calls.length, 1);
    assert.equal(backend.calls.length, 0);
  });

  void it("delegates on bare # (empty query) and never calls the backend", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#"], 0, 1, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
    assert.equal(backend.calls.length, 0, "bare # should not query the backend");
  });

  void it("delegates on bare #Parent. (empty member) and never calls the backend", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#Campaign."], 0, 10, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
    assert.equal(backend.calls.length, 0, "bare #Parent. should not query the backend");
  });

  void it("delegates when the backend returns zero matches", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend({
      prefix: async () => [],
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#Xyzzy"], 0, 7, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
    assert.equal(backend.calls.length, 1);
  });

  void it("delegates when the backend query throws", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend({
      prefix: async () => {
        throw new Error("readtags failed");
      },
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null, "getSuggestions must not throw");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
    assert.equal(backend.calls.length, 1);
  });

  void it("delegates when the query is aborted while the backend is pending", async () => {
    let resolveBackend!: (syms: ProjectSymbol[]) => void;
    const deferred = new Promise<ProjectSymbol[]>((resolve) => {
      resolveBackend = resolve;
    });
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend({
      prefix: async () => deferred,
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const controller = new AbortController();
    const pending = provider.getSuggestions(["#My"], 0, 3, { signal: controller.signal });

    controller.abort();
    resolveBackend([SYMBOLS[0]]);

    const result = await pending;

    assert.ok(result !== null, "getSuggestions must not throw");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback", "should delegate instead of returning backend results");
    assert.equal(
      result.items.some((i) => i.value.startsWith("#MyService@")),
      false,
      "must not return symbols from an aborted backend result",
    );
  });

  void it("delegates on a multi-dot query (#A.B.C) without calling the backend", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#Campaign.User.name"], 0, 18, { signal: signal() });

    assert.ok(result !== null, "should delegate to current provider");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
    assert.equal(backend.calls.length, 0, "multi-dot query must not call the backend");
    assert.equal(
      backend.calls.some((c) => c.method === "queryPrefix"),
      false,
      "queryPrefix must not be called",
    );
    assert.equal(
      backend.calls.some((c) => c.method === "queryDotted"),
      false,
      "queryDotted must not be called",
    );
  });

  void it("delegates when the dotted backend query throws", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend({
      dotted: async () => {
        throw new Error("readtags failed");
      },
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#Foo.bar"], 0, 8, { signal: signal() });

    assert.ok(result !== null, "getSuggestions must not throw");
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
  });

  void it("delegates shouldTriggerFileCompletion to current", () => {
    const current = mockCurrentProvider();
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = provider.shouldTriggerFileCompletion!(["foo"], 0, 3);

    assert.equal(result, true);
    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].method, "shouldTriggerFileCompletion");
  });
});

// ── 3. Routing and bounds ───────────────────────────────────────────

void describe("routing and bounds", () => {
  void it("routes plain query to queryPrefix with cap 50 and the exact signal", async () => {
    const sig = signal();
    const current = mockCurrentProvider();
    const backend = createMockBackend({
      prefix: async (query, limit, signalArg) => {
        assert.equal(query, "c");
        assert.equal(limit, 50, "cap should be 50");
        assert.equal(signalArg, sig, "abort signal must be forwarded unchanged");
        return [SYMBOLS[0]];
      },
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#c"], 0, 2, { signal: sig });

    assert.ok(result !== null);
    assert.equal(result.prefix, "#c");
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0].method, "queryPrefix");
    assert.equal(current.calls.length, 0, "should not delegate when the backend returns results");
  });

  void it("routes dotted query to queryDotted with parent, member, cap 50, and the exact signal", async () => {
    const sig = signal();
    const backend = createMockBackend({
      dotted: async (parent, member, limit, signalArg) => {
        assert.equal(parent, "camp");
        assert.equal(member, "res");
        assert.equal(limit, 50, "cap should be 50");
        assert.equal(signalArg, sig, "abort signal must be forwarded unchanged");
        return [DOTTED_SYMBOLS[1], DOTTED_SYMBOLS[2]];
      },
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#camp.res"], 0, 9, { signal: sig });

    assert.ok(result !== null);
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0].method, "queryDotted");
  });

  void it("caps provider output at 50 even when the backend returns more", async () => {
    const many: ProjectSymbol[] = Array.from({ length: 60 }, (_, i) => ({
      name: `Symbol${String(i).padStart(2, "0")}`,
      kind: "class",
      path: "src/a.ts",
      line: i + 1,
    }));
    const backend = createMockBackend({
      prefix: async () => many,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Sym"], 0, 4, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.items.length, 50, "provider must cap results at 50");
    assert.equal(backend.calls.length, 1);
  });
});

// ── 4. Ranking ──────────────────────────────────────────────────────

void describe("ranking", () => {
  void it("renders one item per backend result", async () => {
    const backend = createMockBackend({
      prefix: async () => [SYMBOLS[0], SYMBOLS[1], SYMBOLS[3]],
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#My"], 0, 3, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.items.length, 3, "all backend results should be shown");
    const values = result.items.map((i) => i.value);
    assert.ok(values.some((v) => v.startsWith("#MyService@")));
    assert.ok(values.some((v) => v.startsWith("#MySerializer@")));
    assert.ok(values.some((v) => v.startsWith("#myFunction@")));
  });

  void it("shallower path wins tie-break for same-depth names", async () => {
    const symbols: ProjectSymbol[] = [
      { name: "Helper", kind: "function", path: "src/utils/deep/helper.ts", line: 1 },
      { name: "Helper", kind: "function", path: "src/helper.ts", line: 1 },
      { name: "Helper", kind: "function", path: "src/utils/helper.ts", line: 1 },
    ];
    const backend = createMockBackend({
      prefix: async () => symbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Helper"], 0, 7, { signal: signal() });

    assert.ok(result !== null);
    const descriptions = result.items.map((i) => i.description ?? "");
    // Should be ordered by path depth: src/helper.ts (depth 1) < src/utils/helper.ts (depth 2) < src/utils/deep/helper.ts (depth 3)
    const depth1 = descriptions.findIndex((d) => d.includes("src/helper.ts"));
    const depth2 = descriptions.findIndex((d) => d.includes("src/utils/helper.ts"));
    const depth3 = descriptions.findIndex((d) => d.includes("src/utils/deep/helper.ts"));

    assert.ok(depth1 >= 0 && depth2 >= 0 && depth3 >= 0);
    assert.ok(depth1 < depth2, "shallower path should come first");
    assert.ok(depth2 < depth3, "shallower path should come first");
  });

  void it("orders same-depth names by name, ignoring backend order", async () => {
    const symbols: ProjectSymbol[] = [
      { name: "Beta", kind: "class", path: "src/beta.ts", line: 3 },
      { name: "Zebra", kind: "class", path: "src/zebra.ts", line: 2 },
      { name: "alpha", kind: "class", path: "src/alpha.ts", line: 1 },
    ];
    const backend = createMockBackend({
      // Backend returns the reverse of the sorted order.
      prefix: async () => [...symbols].reverse(),
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#a"], 0, 2, { signal: signal() });

    assert.ok(result !== null);
    assert.deepEqual(
      result.items.map((i) => i.label),
      ["#Beta", "#Zebra", "#alpha"],
      "same-depth names must sort by the byDepthThenName contract",
    );
  });

  void it("keeps exact-parent dotted items before prefix-parent items, case-insensitively", async () => {
    const symbols: ProjectSymbol[] = [
      // Prefix-parent match, returned first by the backend.
      { name: "cancel_reservation", kind: "method", parentName: "CampaignViewSet", path: "dsp/views.py", line: 42 },
      // Exact parent match (case differs from the query), deeper path.
      { name: "reservation_expiration_date", kind: "variable", parentName: "Campaign", path: "dsp/deep/models.py", line: 207 },
      // Exact parent match, same depth, returned before its name order.
      { name: "zzz_after", kind: "property", parentName: "Campaign", path: "dsp/models.py", line: 209 },
      // Exact parent match, same depth, name sorts first.
      { name: "reservation_date", kind: "variable", parentName: "Campaign", path: "dsp/models.py", line: 208 },
    ];
    const backend = createMockBackend({
      dotted: async () => symbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#cAmPaIgN.res"], 0, 13, { signal: signal() });

    assert.ok(result !== null);
    const labels = result.items.map((i) => i.label);

    // Exact Campaign members come first despite the mixed-case query,
    // sorted by path depth then name.
    assert.deepEqual(labels.slice(0, 3), [
      "#Campaign.reservation_date",
      "#Campaign.zzz_after",
      "#Campaign.reservation_expiration_date",
    ]);

    // Prefix-parent matches follow, never ahead of exact matches.
    assert.equal(labels[3], "#CampaignViewSet.cancel_reservation");
  });

  void it("suggests scoped members for a dotted prefix query", async () => {
    const backend = createMockBackend({
      dotted: async () => [DOTTED_SYMBOLS[1], DOTTED_SYMBOLS[2]],
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Campaign.reservatio"], 0, 20, { signal: signal() });

    assert.ok(result !== null);
    assert.deepEqual(result.items.map((i) => i.label), [
      "#Campaign.reservation_date",
      "#Campaign.reservation_expiration_date",
    ]);
    assert.equal(
      result.items[0].value,
      "#Campaign.reservation_date@src/models/campaign.ts:42",
    );
    assert.equal(
      result.items[1].value,
      "#Campaign.reservation_expiration_date@src/models/campaign.ts:43",
    );
  });

  void it("supports prefix parent + prefix member", async () => {
    const backend = createMockBackend({
      dotted: async () => [DOTTED_SYMBOLS[1], DOTTED_SYMBOLS[2]],
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Camp.reserv"], 0, 12, { signal: signal() });

    assert.ok(result !== null);
    const labels = result.items.map((i) => i.label);
    assert.ok(labels.includes("#Campaign.reservation_date"));
    assert.ok(labels.includes("#Campaign.reservation_expiration_date"));
  });

  void it("delegates when the dotted backend returns no matches", async () => {
    const current = mockCurrentProvider({
      defaultResult: { prefix: "", items: [{ value: "fallback", label: "fallback" }] },
    });
    const backend = createMockBackend({
      dotted: async () => [],
    });
    const provider = createSymbolAutocompleteProvider(current, backend);

    const result = await provider.getSuggestions(["#Foo.nonexistent"], 0, 16, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(current.calls.length, 1, "should delegate to current provider");
    assert.equal(result.items[0].value, "fallback");
  });

  void it("preserves non-dotted query behavior", async () => {
    const backend = createMockBackend({
      prefix: async () => [DOTTED_SYMBOLS[0]],
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Campaign"], 0, 9, { signal: signal() });

    assert.ok(result !== null);
    const labels = result.items.map((i) => i.label);
    assert.ok(labels.includes("#Campaign"), "should show Campaign class");
    assert.equal(backend.calls[0].method, "queryPrefix");
  });
});

// ── 5. Disambiguation ───────────────────────────────────────────────

void describe("disambiguation", () => {
  void it("includes path:line in description for duplicate symbol names", async () => {
    const backend = createMockBackend({
      prefix: async () => SYMBOLS.filter((s) => s.name === "MyService"),
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#MyService"], 0, 10, { signal: signal() });

    assert.ok(result !== null);
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

  void it("counts duplicate names within the capped result set only", async () => {
    const many: ProjectSymbol[] = [];
    for (let i = 2; i <= 50; i += 1) {
      many.push({ name: `Item${String(i).padStart(2, "0")}`, kind: "class", path: "src/a.ts", line: i });
    }
    // One "Dup" inside the cap (49 items + Dup = 50), one outside it.
    many.unshift({ name: "Dup", kind: "class", path: "src/dup-keep.ts", line: 1 });
    many.push({ name: "Dup", kind: "class", path: "src/dup-dropped.ts", line: 99 });

    const backend = createMockBackend({
      prefix: async () => many,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Dup"], 0, 4, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.items.length, 50, "provider caps results at 50");

    const keptDup = result.items.find((i) => i.value.startsWith("#Dup@src/dup-keep.ts"));
    assert.ok(keptDup, "the kept Dup should be present");
    // The dropped duplicate is beyond the cap, so "Dup" is unique in the
    // capped set: the description shows the path without :line.
    assert.equal(keptDup.description, "Class · src/dup-keep.ts");
    assert.equal(
      result.items.some((i) => i.value.startsWith("#Dup@src/dup-dropped.ts")),
      false,
      "the capped-out duplicate must not appear",
    );
  });

  void it("shows full non-dotted labels instead of description-clipped labels", async () => {
    const symbols: ProjectSymbol[] = [
      {
        name: "SalesChannelContractContactMilestone",
        kind: "class",
        path: "marketplace/views/contract_management.py",
        line: 153,
      },
    ];

    const backend = createMockBackend({
      prefix: async () => symbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);
    const line = "#SalesChannelCon";

    const result = await provider.getSuggestions([line], 0, line.length, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.items[0].label, "#SalesChannelContractContactMilestone");
    assert.equal(
      result.items[0].value,
      "#SalesChannelContractContactMilestone@marketplace/views/contract_management.py:153",
    );
    assert.equal(result.items[0].description, undefined);
  });

  void it("includes path:line in description for duplicate dotted names", async () => {
    const dupeSymbols: ProjectSymbol[] = [
      { name: "value", kind: "property", parentName: "Foo", path: "src/a.ts", line: 10 },
      { name: "value", kind: "property", parentName: "Foo", path: "src/b.ts", line: 20 },
    ];

    const backend = createMockBackend({
      dotted: async () => dupeSymbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);

    const result = await provider.getSuggestions(["#Foo.value"], 0, 10, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(result.items.length, 2);
    for (const item of result.items) {
      assert.ok(
        item.description?.includes(":") && item.description?.includes(".ts"),
        `description should include path:line: "${item.description}"`,
      );
    }
  });

  void it("shows full dotted labels up to a generous max length", async () => {
    const symbols: ProjectSymbol[] = [
      {
        name: "semantic_settings_cache_key",
        kind: "variable",
        parentName: "CmsConnectionInfo",
        path: "ssp/models.py",
        line: 437,
      },
    ];

    const backend = createMockBackend({
      dotted: async () => symbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);
    const line = "#CmsConnectionInfo.sema";

    const result = await provider.getSuggestions([line], 0, line.length, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(
      result.items[0].value,
      "#CmsConnectionInfo.semantic_settings_cache_key@ssp/models.py:437",
    );
    assert.equal(result.items[0].label, "#CmsConnectionInfo.semantic_settings_cache_key");
    assert.equal(result.items[0].description, undefined);
  });

  void it("compacts extreme dotted labels without changing the inserted token", async () => {
    const symbols: ProjectSymbol[] = [
      {
        name: "memberNameThatIsFarLongerThanNormalAndWouldOverwhelmTheAutocompleteMenu",
        kind: "variable",
        parentName: "ParentNameThatIsAlsoFarLongerThanNormalAndWouldOverwhelmTheAutocompleteMenu",
        path: "ssp/models.py",
        line: 437,
      },
    ];

    const backend = createMockBackend({
      dotted: async () => symbols,
    });
    const provider = createSymbolAutocompleteProvider(mockCurrentProvider(), backend);
    const line = "#ParentNameThatIsAlsoFarLongerThanNormalAndWouldOverwhelmTheAutocompleteMenu.member";

    const result = await provider.getSuggestions([line], 0, line.length, { signal: signal() });

    assert.ok(result !== null);
    assert.equal(
      result.items[0].value,
      "#ParentNameThatIsAlsoFarLongerThanNormalAndWouldOverwhelmTheAutocompleteMenu.memberNameThatIsFarLongerThanNormalAndWouldOverwhelmTheAutocompleteMenu@ssp/models.py:437",
    );
    assert.notEqual(result.items[0].label, result.items[0].value.split("@")[0]);
    assert.ok(result.items[0].label.length <= 96);
    assert.ok(result.items[0].label.startsWith("#Parent"));
    assert.ok(result.items[0].label.endsWith("AutocompleteMenu"));
    assert.equal(result.items[0].description, undefined);
  });
});

// ── 6. Insertion (stable token) ─────────────────────────────────────

void describe("insertion", () => {
  void it("inserts stable token format #name@path:line on selection", () => {
    const current = mockCurrentProvider();
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

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
    const backend = createMockBackend();
    const provider = createSymbolAutocompleteProvider(current, backend);

    const item: AutocompleteItem = { value: "#Foo@src/foo.ts:1", label: "#Foo" };
    provider.applyCompletion(["#F"], 0, 2, item, "#F");

    assert.equal(current.calls.length, 1);
    assert.equal(current.calls[0].method, "applyCompletion");
  });
});
