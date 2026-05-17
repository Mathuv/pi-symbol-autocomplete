/**
 * Tests for symbol injection payload building.
 *
 * Covers:
 * - buildInjectionPayload produces metadata + definition + context for resolved refs
 * - Unresolved/ambiguous refs are excluded (only injectable refs processed)
 * - 8-symbol cap enforcement
 * - ~3000-char per-symbol truncation with marker
 * - Missing file handling (skipped with warning)
 * - Warnings for cap-skipped refs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedReference } from "./types.ts";
import {
  buildInjectionPayload,
  type SymbolPayload,
  type InjectionResult,
  type FileReader,
  MAX_SYMBOLS,
  MAX_CHARS_PER_SYMBOL,
  TRUNCATION_MARKER,
} from "./injection.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a resolved reference for testing. */
function makeResolved(overrides: Partial<ResolvedReference["parsed"]> & { symbol?: ResolvedReference["symbol"] }): ResolvedReference {
  return {
    parsed: {
      raw: `#${overrides.symbol?.name ?? "Test"}`,
      name: overrides.symbol?.name ?? "Test",
      type: "plain",
      lineIndex: 0,
      column: 0,
      ...overrides,
    },
    symbol: overrides.symbol ?? { name: "Test", kind: "class", path: "test.ts", line: 1 },
    status: "resolved",
    message: "Resolved",
  };
}

/** In-memory file system for testing. */
type MockFS = Map<string, string>;

function createMockFileReader(fs: MockFS): FileReader {
  return async (filePath: string) => {
    // Convert \n-based content back to normalized
    const content = fs.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${filePath}`);
    }
    return content;
  };
}

function mockFS(): MockFS {
  return new Map();
}

const SAMPLE_FILE = [
  "import { something } from './module';",
  "",
  "/**",
  " * MyService handles business logic.",
  " */",
  "class MyService {",
  "  private db: Database;",
  "",
  "  constructor(db: Database) {",
  "    this.db = db;",
  "  }",
  "",
  "  async execute(): Promise<void> {",
  "    await this.db.query('SELECT * FROM users');",
  "  }",
  "}",
  "",
  "export const config = {",
  '  port: 3000,',
  "};",
].join("\n");

const funcFile = [
  "/**",
  " * Calculate the result.",
  " */",
  "function calculate(a: number, b: number): number {",
  "  return a + b;",
  "}",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════
// INJECTION TESTS
// ═══════════════════════════════════════════════════════════════════════

void describe("buildInjectionPayload", () => {
  // ── Basic payload structure ─────────────────────────────────────

  void it("builds payload with metadata, definition, and context for resolved refs", async () => {
    const fs = mockFS();
    fs.set("/project/test.ts", SAMPLE_FILE);

    const ref = makeResolved({
      symbol: { name: "MyService", kind: "class", path: "test.ts", line: 6 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.warnings.length, 0);

    const payload = result.symbols[0];
    // Metadata
    assert.equal(payload.metadata.name, "MyService");
    assert.equal(payload.metadata.kind, "class");
    assert.equal(payload.metadata.path, "test.ts");
    assert.equal(payload.metadata.line, 6);

    // Definition — should include the class declaration and some body
    assert.ok(payload.definition.length > 0, "definition should not be empty");
    assert.ok(payload.definition.includes("class MyService"), "definition should contain class declaration");

    // Context — should include comment lines before the class
    assert.ok(payload.context.length > 0, "context should not be empty");
  });

  void it("includes surrounding context lines before the definition", async () => {
    const fs = mockFS();
    fs.set("/project/test.ts", SAMPLE_FILE);

    const ref = makeResolved({
      symbol: { name: "MyService", kind: "class", path: "test.ts", line: 6 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    const payload = result.symbols[0];
    // Context should include lines before line 6 (e.g., the JSDoc comment)
    assert.ok(payload.context.includes("MyService handles"), "context should include preceding comment");
  });

  // ── Metadata line range ─────────────────────────────────────────

  void it("includes endLine in metadata (from symbol.endLine or computed estimate)", async () => {
    const fs = mockFS();
    fs.set("/project/service.ts", SAMPLE_FILE);
    fs.set("/project/func.ts", funcFile);

    // Symbol with explicit endLine
    const refWithEndLine = makeResolved({
      symbol: { name: "MyService", kind: "class", path: "service.ts", line: 6, endLine: 15 },
    });

    // Symbol without endLine (computed from kind estimate)
    const refWithoutEndLine = makeResolved({
      symbol: { name: "calculate", kind: "function", path: "func.ts", line: 3 },
    });

    const result = await buildInjectionPayload(
      [refWithEndLine, refWithoutEndLine],
      "/project",
      createMockFileReader(fs),
    );

    assert.equal(result.symbols.length, 2);

    const servicePayload = result.symbols.find((s) => s.metadata.name === "MyService")!;
    const funcPayload = result.symbols.find((s) => s.metadata.name === "calculate")!;

    assert.ok(servicePayload !== undefined, "MyService should be in payload");
    assert.ok(funcPayload !== undefined, "calculate should be in payload");

    // Symbol with explicit endLine should use it
    assert.equal(servicePayload.metadata.endLine, 15, "should use explicit endLine from symbol");

    // Symbol without endLine: func.ts has 6 lines, function starts at line 3 (0-indexed 2),
    // estimate for function is 10, so defEndLine = min(6, 2 + 10) = 6
    assert.equal(funcPayload.metadata.endLine, 6, "should compute endLine from kind estimate when symbol.endLine is absent");
  });

  void it("includes endLine in fallback metadata when symbol line exceeds file length", async () => {
    const fs = mockFS();
    // File with only 2 lines, but symbol is at line 10
    fs.set("/project/short.ts", [
      "const A = 1;",
      "const B = 2;",
    ].join("\n"));

    // Symbol beyond file length without explicit endLine
    const refNoEndLine = makeResolved({
      symbol: { name: "Beyond", kind: "constant", path: "short.ts", line: 10 },
    });

    // Symbol beyond file length with explicit endLine
    const refWithEndLine = makeResolved({
      symbol: { name: "FarAway", kind: "function", path: "short.ts", line: 10, endLine: 42 },
    });

    const result = await buildInjectionPayload(
      [refNoEndLine, refWithEndLine],
      "/project",
      createMockFileReader(fs),
    );

    assert.equal(result.symbols.length, 2);

    const beyondPayload = result.symbols.find((s) => s.metadata.name === "Beyond")!;
    const farPayload = result.symbols.find((s) => s.metadata.name === "FarAway")!;

    assert.ok(beyondPayload !== undefined, "Beyond should be in payload");
    assert.ok(farPayload !== undefined, "FarAway should be in payload");

    // Fallback without explicit endLine: metadata still has endLine (same as symbol.line)
    assert.equal(beyondPayload.metadata.endLine, 10, "should have endLine in fallback metadata");
    // Fallback with explicit endLine: preserves the symbol.endLine value
    assert.equal(farPayload.metadata.endLine, 42, "should preserve explicit endLine in fallback");

    // Verify fallback payload structure is preserved
    assert.ok(beyondPayload.definition.includes("(file truncated)"), "definition should indicate truncation");
    assert.equal(beyondPayload.context, "", "context should be empty for out-of-range symbol");
  });

  // ── Excludes non-injectable refs ─────────────────────────────────

  void it("returns empty payload when injectable list is empty", async () => {
    const result = await buildInjectionPayload([], "/project");

    assert.equal(result.symbols.length, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.warnings.length, 0);
  });

  void it("only processes injectable refs (skips unresolved/ambiguous)", async () => {
    // This is implicit: the caller should filter via resolver's `injectable`.
    // BuildInjectionPayload only processes what it receives.
    // Test that it just processes what's given.
    const fs = mockFS();
    fs.set("/project/test.ts", SAMPLE_FILE);

    const ref = makeResolved({
      symbol: { name: "MyService", kind: "class", path: "test.ts", line: 6 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
  });

  void it("builds payload for stale status refs (has symbol, same payload structure)", async () => {
    // Regression: stale stable token fallback should produce a valid injection
    // payload identical to a fully-resolved ref (same metadata, definition, context).
    const fs = mockFS();
    fs.set("/project/service.ts", SAMPLE_FILE);

    const ref: ResolvedReference = {
      parsed: {
        raw: "#MyService@service.ts:999",
        name: "MyService",
        path: "service.ts",
        line: 999,
        type: "stable",
        lineIndex: 0,
        column: 0,
      },
      symbol: { name: "MyService", kind: "class", path: "service.ts", line: 6, endLine: 15 },
      status: "stale",
      message: "Stable token line 999 is stale; resolved to MyService at service.ts:6",
    };

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.warnings.length, 0);

    const payload = result.symbols[0];
    assert.equal(payload.metadata.name, "MyService");
    assert.equal(payload.metadata.kind, "class");
    assert.equal(payload.metadata.path, "service.ts");
    assert.equal(payload.metadata.line, 6);
    assert.equal(payload.metadata.endLine, 15);
    assert.ok(payload.definition.includes("class MyService"), "definition should contain class declaration");
    assert.ok(payload.context.length > 0, "context should not be empty");
  });

  // ── 8-symbol cap ────────────────────────────────────────────────

  void it("enforces max 8 symbols cap", async () => {
    const fs = mockFS();
    fs.set("/project/a.ts", "const A = 1;\n");
    fs.set("/project/b.ts", "const B = 2;\n");

    // Create 10 resolved refs (all pointing to same files but different symbols)
    const refs: ResolvedReference[] = [];
    for (let i = 0; i < MAX_SYMBOLS + 2; i++) {
      const file = i % 2 === 0 ? "a.ts" : "b.ts";
      const name = `Sym${i}`;
      fs.set(`/project/${file}`, `const ${name} = ${i};\n`);
      refs.push(makeResolved({
        symbol: { name, kind: "constant", path: file, line: 1 },
      }));
    }

    const result = await buildInjectionPayload(refs, "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, MAX_SYMBOLS, `should cap at ${MAX_SYMBOLS}`);
    assert.equal(result.skipped, 2, "should report 2 skipped");
    assert.ok(result.warnings.length > 0, "should include cap warning");
    assert.ok(result.warnings[0].includes("cap") || result.warnings[0].includes("omitted"),
      `warning should mention cap/omitted: ${result.warnings[0]}`);
  });

  // ── Truncation ──────────────────────────────────────────────────

  void it("truncates per-symbol payload over ~3000 chars with marker", async () => {
    const fs = mockFS();
    // Create a file with a very long line
    const longBody = "x".repeat(MAX_CHARS_PER_SYMBOL * 2);
    fs.set("/project/huge.ts", `class Huge {\n  ${longBody}\n}`);

    const ref = makeResolved({
      symbol: { name: "Huge", kind: "class", path: "huge.ts", line: 1 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    const payload = result.symbols[0];
    // The combined definition + context should be within budget
    const combinedLen = payload.definition.length + payload.context.length;
    assert.ok(
      combinedLen <= MAX_CHARS_PER_SYMBOL * 1.1, // allow ~10% for metadata JSON overhead
      `combined definition+context length ${combinedLen} should be near ${MAX_CHARS_PER_SYMBOL} limit`,
    );
    assert.ok(
      payload.definition.includes(TRUNCATION_MARKER) || payload.context.includes(TRUNCATION_MARKER),
      `payload should include truncation marker, got: definition ends with "...${payload.definition.slice(-30)}"`,
    );
  });

  void it("does not truncate when payload fits within budget", async () => {
    const fs = mockFS();
    fs.set("/project/small.ts", "const SMALL = 1;\n");

    const ref = makeResolved({
      symbol: { name: "SMALL", kind: "constant", path: "small.ts", line: 1 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    const payload = result.symbols[0];
    assert.ok(!payload.definition.includes(TRUNCATION_MARKER), "small payload should not be truncated");
    assert.ok(payload.definition.includes("const SMALL = 1;"), "definition should contain the actual line");
  });

  // ── Missing file handling ───────────────────────────────────────

  void it("skips symbol when source file cannot be read and issues warning", async () => {
    const fs = mockFS();
    // Don't put the file in the mock FS

    const ref = makeResolved({
      symbol: { name: "Missing", kind: "class", path: "nonexistent.ts", line: 1 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 0, "should skip symbol when file missing");
    assert.equal(result.warnings.length, 1, "should issue warning");
    assert.ok(
      result.warnings[0].includes("Missing") || result.warnings[0].includes("nonexistent"),
      `warning should mention the symbol/file: ${result.warnings[0]}`,
    );
  });

  void it("continues processing remaining symbols when one file is missing", async () => {
    const fs = mockFS();
    fs.set("/project/ok.ts", "const OK = 1;\n");

    const refs: ResolvedReference[] = [
      makeResolved({
        symbol: { name: "Missing", kind: "class", path: "nonexistent.ts", line: 1 },
      }),
      makeResolved({
        symbol: { name: "OK", kind: "constant", path: "ok.ts", line: 1 },
      }),
    ];

    const result = await buildInjectionPayload(refs, "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1, "should include the OK symbol");
    assert.equal(result.symbols[0].metadata.name, "OK");
    assert.ok(result.warnings.length > 0, "should have warning about the missing file");
  });

  // ── Multiple resolved refs ──────────────────────────────────────

  void it("builds payload for multiple resolved references", async () => {
    const fs = mockFS();
    fs.set("/project/service.ts", SAMPLE_FILE);
    fs.set("/project/func.ts", funcFile);

    const refs: ResolvedReference[] = [
      makeResolved({
        symbol: { name: "MyService", kind: "class", path: "service.ts", line: 6 },
      }),
      makeResolved({
        symbol: { name: "calculate", kind: "function", path: "func.ts", line: 3 },
      }),
    ];

    const result = await buildInjectionPayload(refs, "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 2);
    const names = result.symbols.map((s) => s.metadata.name).sort();
    assert.deepEqual(names, ["MyService", "calculate"]);

    // Each should have non-empty fields
    for (const payload of result.symbols) {
      assert.ok(payload.definition.length > 0, `${payload.metadata.name} should have definition`);
    }
  });

  // ── Path resolution ─────────────────────────────────────────────

  void it("resolves symbol path relative to cwd", async () => {
    const fs = mockFS();
    fs.set("/project/src/symbol.ts", "class DeepSymbol {}\n");

    const ref = makeResolved({
      symbol: { name: "DeepSymbol", kind: "class", path: "src/symbol.ts", line: 1 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].metadata.name, "DeepSymbol");
  });

  // ── Context-only symbols (no surrounding lines if at top) ───────

  void it("handles symbol at line 1 (no preceding context)", async () => {
    const fs = mockFS();
    fs.set("/project/top.ts", [
      "const TOP = 1;",
      "const NEXT = 2;",
    ].join("\n"));

    const ref = makeResolved({
      symbol: { name: "TOP", kind: "constant", path: "top.ts", line: 1 },
    });

    const result = await buildInjectionPayload([ref], "/project", createMockFileReader(fs));

    assert.equal(result.symbols.length, 1);
    const payload = result.symbols[0];
    assert.ok(payload.definition.includes("const TOP = 1;"));
    // Context before should be empty since it's line 1, but context may still exist
    assert.ok(payload.context !== undefined);
  });
});
