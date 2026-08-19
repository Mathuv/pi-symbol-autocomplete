/**
 * Tests for the readtags query backend.
 *
 * Unit tests cover parseTagLine: kind normalization, line/end fields,
 * scope forms, the member-scope variable rule, and malformed lines.
 *
 * Integration tests generate a fixture tags file with ctags in a temp
 * directory and run the real `readtags` binary. They skip when ctags or
 * readtags is not on PATH.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createReadtagsBackend, parseTagLine } from "./readtags-backend.ts";
import type { ProjectSymbol } from "./types.ts";

// ── parseTagLine unit tests ─────────────────────────────────────────

/** Build a classic-format line with the given extension fields. */
function tagLine(name: string, filePath: string, fields: string[]): string {
  return [name, filePath, `/^${name}$/;"`, ...fields].join("\t");
}

const TS_ALIASES = new Map<string, string>([
  ["TypeScript\0c", "class"],
  ["TypeScript\0f", "function"],
  ["TypeScript\0i", "interface"],
  ["TypeScript\0m", "method"],
  ["TypeScript\0v", "variable"],
]);

void describe("parseTagLine", () => {
  void it("normalizes a short kind via the language alias", () => {
    const sym = parseTagLine(tagLine("MyClass", "a.ts", ["kind:c", "line:1", "language:TypeScript"]), TS_ALIASES);
    assert.ok(sym !== null);
    assert.equal(sym.kind, "class");
    assert.equal(sym.name, "MyClass");
    assert.equal(sym.path, "a.ts");
    assert.equal(sym.line, 1);
    assert.equal(sym.depth, 0);
  });

  void it("normalizes a bare short kind via the common alias map", () => {
    const sym = parseTagLine(tagLine("MyClass", "a.ts", ["c", "line:1"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.kind, "class");
  });

  void it("keeps a long kind unchanged", () => {
    const sym = parseTagLine(tagLine("MyClass", "a.ts", ["kind:class", "line:1"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.kind, "class");
  });

  void it("parses line and end fields", () => {
    const sym = parseTagLine(tagLine("MyClass", "a.ts", ["kind:class", "line:3", "end:9"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.line, 3);
    assert.equal(sym.endLine, 9);
  });

  void it("parses the scope:interface:X scope form", () => {
    const sym = parseTagLine(tagLine("x", "a.ts", ["kind:property", "line:2", "scope:interface:MyInterface"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.parentName, "MyInterface");
    assert.equal(sym.depth, 1);
  });

  void it("parses the bare interface:X scope form", () => {
    const sym = parseTagLine(tagLine("x", "a.ts", ["kind:property", "line:2", "interface:MyInterface"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.parentName, "MyInterface");
    assert.equal(sym.depth, 1);
  });

  void it("includes a class-scoped variable", () => {
    const sym = parseTagLine(tagLine("reservation_date", "models.py", ["kind:variable", "line:5", "class:Campaign"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.kind, "variable");
    assert.equal(sym.parentName, "Campaign");
    assert.equal(sym.depth, 1);
  });

  void it("excludes a function-scoped variable", () => {
    const sym = parseTagLine(tagLine("localVar", "a.ts", ["kind:variable", "line:2", "function:foo"]), new Map());
    assert.equal(sym, null);
  });

  void it("excludes a local-scoped constant", () => {
    const sym = parseTagLine(tagLine("LIMIT", "a.ts", ["kind:constant", "line:2", "scopeKind:Local"]), new Map());
    assert.equal(sym, null);
  });

  void it("includes an unscoped variable", () => {
    const sym = parseTagLine(tagLine("globalConfig", "a.ts", ["kind:variable", "line:1"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.kind, "variable");
    assert.equal(sym.parentName, undefined);
    assert.equal(sym.depth, 0);
  });

  void it("excludes kinds outside DEFINITION_KINDS", () => {
    const sym = parseTagLine(tagLine("i", "a.ts", ["kind:local", "line:1"]), new Map());
    assert.equal(sym, null);
  });

  void it("returns null for an empty line", () => {
    assert.equal(parseTagLine("", new Map()), null);
  });

  void it("returns null for a pseudo-tag line", () => {
    assert.equal(parseTagLine("!_TAG_FILE_FORMAT\t2\t/extended format/", new Map()), null);
  });

  void it("returns null for a line with fewer than four columns", () => {
    assert.equal(parseTagLine("a\tb.ts", new Map()), null);
    assert.equal(parseTagLine("a\tb.ts\t/^a$/;\"", new Map()), null);
  });

  void it("returns null when the line field is missing", () => {
    assert.equal(parseTagLine(tagLine("a", "b.ts", ["kind:class"]), new Map()), null);
  });
});

// ── Integration tests against the real readtags binary ──────────────

const readtagsPresent = spawnSync("readtags", ["--version"]).status === 0;
const ctagsPresent = spawnSync("ctags", ["--version"]).status === 0;
const integrationAvailable = readtagsPresent && ctagsPresent;

const CAMPAIGN_FIXTURE = [
  "def helper():",
  "    pass",
  "",
  "class Campaign:",
  "    reservation_date = None",
  "    reserve = None",
  "",
  "class CampaignViewSet:",
  "    list = None",
  "",
  "class CampaignHelper:",
  "    reset = None",
  "",
].join("\n");

/**
 * Generate a fixture tags file in a temp directory.
 * Returns the directory and the tags file path.
 */
function createFixture(files: Array<{ name: string; content: string }>): { dir: string; tagsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-backend-"));
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file.name), file.content);
  }
  const result = spawnSync(
    "ctags",
    ["--sort=foldcase", "--fields=+KznZe", "-f", "tags", ...files.map((f) => f.name)],
    { cwd: dir },
  );
  assert.equal(result.status, 0, `ctags failed: ${result.stderr.toString()}`);
  return { dir, tagsPath: path.join(dir, "tags") };
}

function createReadtagsShim(mode: string): { dir: string; tagsPath: string; command: string; markerPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-shim-"));
  const tagsPath = path.join(dir, "tags");
  const markerPath = path.join(dir, "marker");
  const command = path.join(dir, "readtags");
  fs.writeFileSync(tagsPath, `${mode}\n${markerPath}`);
  fs.writeFileSync(command, `#!/usr/bin/env node
import fs from "node:fs";
const [mode, marker] = fs.readFileSync(process.argv[process.argv.indexOf("-t") + 1], "utf8").split("\\n");
const alias = process.argv.includes("-D");
fs.appendFileSync(marker, alias ? "D\\n" : "Q\\n");
let sent = 0;
function stopped() { fs.writeFileSync(marker, fs.readFileSync(marker, "utf8") + "K" + sent); process.exit(0); }
process.on("SIGTERM", stopped);
if (alias) {
  if (mode === "slow-alias") setInterval(() => {}, 1000);
  else if (mode === "gated-alias") {
    fs.appendFileSync(marker, "P" + process.pid + "\\n");
    const gate = marker + "-go";
    (function poll() {
      if (fs.existsSync(gate)) {
        process.stdout.write("!_TAG_KIND_DESCRIPTION!TypeScript\\tc,class\\n");
        process.exit(0);
      }
      setTimeout(poll, 5);
    })();
  } else if (mode === "stubborn-alias") {
    fs.appendFileSync(marker, "P" + process.pid + "\\n");
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", () => {});
    const gate = marker + "-go";
    (function poll() {
      if (fs.existsSync(gate)) {
        process.stdout.write("!_TAG_KIND_DESCRIPTION!TypeScript\\tc,class\\n");
        process.exit(0);
      }
      setTimeout(poll, 5);
    })();
  } else if (mode === "alias-cap") {
    for (let index = 0; index <= 1_000; index += 1) {
      process.stdout.write("!_TAG_KIND_DESCRIPTION!TypeScript\\tc" + index + ",class\\n");
    }
    setInterval(() => {}, 1000);
  } else if (mode === "alias-10k") {
    for (let index = 0; index < 10_000; index += 1) {
      process.stdout.write("!_TAG_FILE_SORTED\\t2\\t/0=unsorted, 1=sorted, 2=foldcase/\\n");
    }
    process.stdout.end(() => process.exit(0));
  } else if (mode === "alias-10001") {
    for (let index = 0; index < 10_001; index += 1) {
      process.stdout.write("!_TAG_FILE_SORTED\\t2\\t/0=unsorted, 1=sorted, 2=foldcase/\\n");
    }
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write("!_TAG_KIND_DESCRIPTION!TypeScript\\tc,class\\n");
    process.exit(0);
  }
} else if (mode === "dotted") {
  process.stdout.write("resA\\ta.ts\\t/^resA$/;\\\"\\tkind:property\\tline:1\\tclass:CampaignHelper\\n");
  process.stdout.write("resZ\\ta.ts\\t/^resZ$/;\\\"\\tkind:property\\tline:2\\tclass:Campaign\\n");
  setInterval(() => {}, 1000);
} else if (mode === "huge-line") {
  process.stdout.write("x".repeat(64 * 1024 + 1));
  setInterval(() => {}, 1000);
} else if (mode === "alias-symbol") {
  process.stdout.write("Aliased\\ta.ts\\tpattern\\tkind:c\\tline:1\\tlanguage:TypeScript\\n");
  process.exit(0);
} else if (mode === "no-term") {
  fs.appendFileSync(marker, "PID" + process.pid + "\\n");
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {});
  process.stdout.write("Symbol0\\ta.ts\\t/^Symbol$/;\\\"\\tkind:class\\tline:1\\n");
  setInterval(() => {}, 1000);
} else {
  const total = mode === "scanned" ? 15_000 : 1_000;
  function emit() {
    for (let index = 0; index < 100 && sent < total; index += 1, sent += 1) {
      process.stdout.write(mode === "scanned" ? "malformed\\n" : "Symbol" + sent + "\\ta.ts\\t/^Symbol$/;\\\"\\tkind:class\\tline:1\\n");
    }
    if (sent < total) {
      if (mode === "scanned") setTimeout(emit, 0);
      else setImmediate(emit);
    } else setInterval(() => {}, 1000);
  }
  emit();
}
`);
  fs.chmodSync(command, 0o755);
  return { dir, tagsPath, command, markerPath };
}

function readMarker(markerPath: string): string {
  return fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "";
}

async function waitForMarker(markerPath: string, value: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const marker = readMarker(markerPath);
    if (marker.includes(value)) return marker;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readMarker(markerPath);
}

async function waitForKill(markerPath: string): Promise<string> {
  return waitForMarker(markerPath, "K");
}

void describe("readtags backend bounds", () => {
  void it("kills the child at the result cap", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("results");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.equal((await backend.queryPrefix("symbol", 5)).length, 5);
      const marker = await waitForKill(markerPath);
      assert.match(marker, /K\d+/);
      assert.ok(Number.parseInt(marker.match(/K(\d+)/)![1], 10) < 500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("kills the child at the scanned-line cap", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("scanned");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      assert.match(await waitForKill(markerPath), /K\d+/);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("kills the child for a line longer than 64 KiB", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("huge-line");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      assert.ok(Date.now() - started < 2_000);
      assert.match(await waitForKill(markerPath), /K0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("does not spawn for an aborted signal or a zero limit", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("results");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const controller = new AbortController();
      controller.abort();
      assert.deepEqual(await backend.queryPrefix("symbol", 50, controller.signal), []);
      assert.deepEqual(await backend.queryPrefix("symbol", 0), []);
      assert.equal(readMarker(markerPath), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("applies one deadline to alias loading and the query", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("slow-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      assert.ok(Date.now() - started < 5_500);
      assert.equal(await waitForKill(markerPath), "D\nK0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("caches aliases after the alias cap", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("alias-cap");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      await backend.queryPrefix("symbol", 1);
      await backend.queryPrefix("symbol", 1);
      assert.equal(readMarker(markerPath).match(/D/g)?.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("retries aliases after an aborted alias load", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("slow-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const controller = new AbortController();
      const firstQuery = backend.queryPrefix("aliased", 50, controller.signal);
      assert.match(await waitForMarker(markerPath, "D"), /D/);
      controller.abort();
      assert.deepEqual(await firstQuery, []);

      fs.writeFileSync(tagsPath, `alias-symbol\n${markerPath}`);
      const symbols = await backend.queryPrefix("aliased", 50);
      assert.deepEqual(symbols.map((symbol) => symbol.name), ["Aliased"]);
      assert.equal(symbols[0].kind, "class");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("ranks an exact dotted parent before a prefix parent", async () => {
    const { dir, tagsPath, command } = createReadtagsShim("dotted");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.deepEqual((await backend.queryDotted("Campaign", "res", 1)).map((symbol) => symbol.name), ["resZ"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("normalizes non-finite limits", async () => {
    const { dir, tagsPath, command } = createReadtagsShim("results");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.equal((await backend.queryPrefix("symbol", Number.NaN)).length, 50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("completes an alias load of exactly 10,000 lines and caches it", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("alias-10k");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const symbols = await backend.queryPrefix("symbol", 1);
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "Symbol0");
      // The complete load is cached; a second query does not re-run -D.
      await backend.queryPrefix("symbol", 1);
      assert.equal(readMarker(markerPath).match(/D/g)?.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("rejects an alias load past the 10,000-line cap as incomplete", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("alias-10001");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      await assert.rejects(backend.queryPrefix("symbol", 1), /did not complete/);
      // The active caller retries an incomplete shared load exactly once:
      // the marker records two -D spawns and two kills.
      const marker = readMarker(markerPath);
      assert.match(marker, /K\d+/);
      assert.equal(
        marker.match(/D/g)?.length,
        2,
        "an incomplete shared load must retry once for an active caller",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("keeps an active caller's alias load complete when the first caller aborts", async () => {
    // P2: the shared alias load must not belong to one caller. A and B
    // abort in sequence while C stays active; C must receive the complete
    // aliases and a successful query, and the shared child must survive.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("gated-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const aController = new AbortController();
      const bController = new AbortController();

      // A starts the shared alias load; B and C join it while it is gated.
      const aQuery = backend.queryPrefix("aliased", 50, aController.signal);
      assert.match(await waitForMarker(markerPath, "P"), /P\d+/);
      const bQuery = backend.queryPrefix("aliased", 50, bController.signal);
      const cQuery = backend.queryPrefix("aliased", 50);

      // A aborts, then B aborts. C remains, so the shared load must not die.
      aController.abort();
      assert.deepEqual(await aQuery, []);
      bController.abort();
      assert.deepEqual(await bQuery, []);
      assert.ok(!readMarker(markerPath).includes("K"), "the shared child must survive while C waits");

      // Point C's query at a complete alias load, then release the gate.
      fs.writeFileSync(tagsPath, `alias-symbol\n${markerPath}`);
      fs.writeFileSync(markerPath + "-go", "");
      const symbols = await cQuery;
      assert.deepEqual(symbols.map((symbol) => symbol.name), ["Aliased"]);
      assert.equal(symbols[0].kind, "class");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("keeps an active exact caller's alias load complete when the first callers abort", async () => {
    // P2: scanExact must use the same ref-counted shared load. A and B
    // abort while C scans; C must not inherit the abort or scan with
    // partial aliases.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("gated-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const aController = new AbortController();
      const bController = new AbortController();

      const seen: ProjectSymbol[] = [];
      const aScan = backend.scanExact("Aliased", (symbol) => seen.push(symbol), aController.signal);
      assert.match(await waitForMarker(markerPath, "P"), /P\d+/);
      const bScan = backend.scanExact("Aliased", (symbol) => seen.push(symbol), bController.signal);
      const cScan = backend.scanExact("Aliased", (symbol) => seen.push(symbol));

      aController.abort();
      await assert.rejects(aScan, /interrupted/);
      bController.abort();
      await assert.rejects(bScan, /interrupted/);

      fs.writeFileSync(tagsPath, `alias-symbol\n${markerPath}`);
      fs.writeFileSync(markerPath + "-go", "");
      await cScan;
      assert.deepEqual(seen.map((symbol) => symbol.name), ["Aliased"]);
      assert.equal(seen[0].kind, "class");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("stops the shared alias child when every caller aborts", async () => {
    // P2: when the final waiter leaves before the load completes, the
    // shared subprocess is aborted so no orphan process survives.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("gated-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const aController = new AbortController();
      const bController = new AbortController();

      const aQuery = backend.queryPrefix("aliased", 50, aController.signal);
      assert.match(await waitForMarker(markerPath, "P"), /P\d+/);
      const bQuery = backend.queryPrefix("aliased", 50, bController.signal);

      aController.abort();
      assert.deepEqual(await aQuery, []);
      bController.abort();
      assert.deepEqual(await bQuery, []);

      const marker = await waitForKill(markerPath);
      const pid = Number.parseInt(marker.match(/P(\d+)/)![1], 10);
      assert.throws(
        () => process.kill(pid, 0),
        "the shared child must be dead after the last caller aborts",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("settles the final aborted caller only after the SIGTERM-ignoring alias child is dead", async () => {
    // P2: a final waiter's abort must not resolve before the shared alias
    // child is dead. A SIGTERM-ignoring child needs the SIGKILL grace, so
    // the caller waits for the close instead of settling early.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("stubborn-alias");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const controller = new AbortController();

      const started = Date.now();
      const query = backend.queryPrefix("aliased", 50, controller.signal);
      assert.match(await waitForMarker(markerPath, "P"), /P\d+/);
      controller.abort();
      assert.deepEqual(await query, []);

      // The caller settled only after the SIGKILL grace. The pid must
      // already be gone; do not poll after the caller settled.
      assert.ok(Date.now() - started >= 150, `SIGKILL grace must elapse before settlement (took ${Date.now() - started} ms)`);
      const pid = Number.parseInt(readMarker(markerPath).match(/P(\d+)/)![1], 10);
      assert.throws(
        () => process.kill(pid, 0),
        "the alias child must be dead when the final caller settles",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("kills a SIGTERM-ignoring child with SIGKILL after a grace period", async () => {
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("no-term");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      const symbols = await backend.queryPrefix("symbol", 1);
      const elapsed = Date.now() - started;

      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "Symbol0");

      const marker = readMarker(markerPath);
      assert.match(marker, /PID\d+/);
      assert.ok(!marker.includes("K"), "the SIGTERM handler must not run");
      assert.ok(elapsed >= 150, `SIGKILL grace must elapse before close (took ${elapsed} ms)`);

      // The promise settled via close; the child must be dead, not a survivor.
      const pid = Number.parseInt(marker.match(/PID(\d+)/)![1], 10);
      assert.throws(() => process.kill(pid, 0), "the child must be dead after resolution");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe("readtags backend integration", { skip: !integrationAvailable }, () => {
  void it("returns case-insensitive prefix matches", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols = await backend.queryPrefix("camp", 50);

      assert.deepEqual(
        symbols.map((s) => s.name),
        ["Campaign", "CampaignHelper", "CampaignViewSet"],
      );
      assert.ok(symbols.every((s) => s.kind === "class"));
      assert.ok(symbols.every((s) => s.path === "campaign.py"));
      assert.ok(symbols.every((s) => s.depth === 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("parses endLine from generated end: fields", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols: ProjectSymbol[] = [];
      await backend.scanExact("Campaign", (symbol) => symbols.push(symbol));

      assert.equal(symbols.length, 1);
      assert.ok(symbols[0].endLine !== undefined);
      assert.ok(symbols[0].endLine! >= symbols[0].line);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("filters dotted queries by parent prefix and ranks exact parents first", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols = await backend.queryDotted("campaign", "res", 50);

      assert.deepEqual(
        symbols.map((s) => s.name),
        ["reservation_date", "reserve", "reset"],
      );
      assert.deepEqual(
        symbols.map((s) => s.parentName),
        ["Campaign", "Campaign", "CampaignHelper"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("matches dotted parents case-insensitively", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols = await backend.queryDotted("CAMP", "res", 50);

      assert.deepEqual(
        symbols.map((s) => s.name),
        ["reservation_date", "reserve", "reset"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("stops the stream at the result cap", async () => {
    const manyLines = ["def seed():", "    pass", ""];
    for (let i = 0; i < 100; i += 1) {
      manyLines.push(`class Capped${i}:`, "    pass", "");
    }
    const { dir, tagsPath } = createFixture([{ name: "capped.py", content: manyLines.join("\n") }]);
    try {
      // The fixture must contain more matches than the cap.
      const all = spawnSync("readtags", ["-t", tagsPath, "-e", "-n", "-p", "-i", "-", "capped"]);
      assert.equal(all.status, 0);
      assert.ok(all.stdout.toString().split("\n").filter((l) => l).length > 5);

      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const capped = await backend.queryPrefix("capped", 5);
      assert.equal(capped.length, 5);
      assert.ok(capped.every((s) => s.name.startsWith("Capped")));

      // A caller limit above the max cap returns at most 50 results.
      const allSymbols = await backend.queryPrefix("capped", 200);
      assert.equal(allSymbols.length, 50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("streams an exact name", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols: ProjectSymbol[] = [];
      await backend.scanExact("Campaign", (symbol) => symbols.push(symbol));

      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "Campaign");
      assert.equal(symbols[0].kind, "class");
      assert.equal(symbols[0].path, "campaign.py");
      assert.equal(symbols[0].line, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("visits nothing for an unknown exact name", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const symbols: ProjectSymbol[] = [];
      await backend.scanExact("NoSuchSymbol", (symbol) => symbols.push(symbol));
      assert.deepEqual(symbols, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("streams more than 50 exact records through the visitor", { skip: !readtagsPresent }, async () => {
    // P1: the backend must not cap exact scans at 50 results. A fixture
    // with 60 identical names must deliver all 60 to the visitor while
    // the backend itself retains none.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-scan-60-"));
    const tagsPath = path.join(dir, "tags");
    const lines = [
      "!_TAG_FILE_FORMAT\t2\t/extended format/",
      "!_TAG_FILE_SORTED\t2\t/0=unsorted, 1=sorted, 2=foldcase/",
    ];
    for (let i = 1; i <= 60; i += 1) {
      lines.push(`seed\tsrc/seed.ts\t/^def seed():$/;"\tkind:function\tline:${i}\tlanguage:TypeScript`);
    }
    fs.writeFileSync(tagsPath, lines.join("\n") + "\n");

    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const seen: ProjectSymbol[] = [];
      await backend.scanExact("seed", (symbol) => seen.push(symbol));

      assert.equal(seen.length, 60);
      assert.ok(seen.every((s) => s.name === "seed"));
      assert.equal(new Set(seen.map((s) => s.line)).size, 60);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("rejects an exact scan that hits the scanned-line cap", async () => {
    // P1: when the stream stops before normal EOF, the scan must reject
    // as incomplete instead of returning partial results.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("scanned");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      await assert.rejects(backend.scanExact("symbol", () => {}), /did not complete/);
      assert.ok(Date.now() - started < 2_000);
      assert.match(await waitForKill(markerPath), /K\d+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("rejects when the scan visitor throws and kills the child", async () => {
    // P1: a visitor exception must not escape the EventEmitter callback
    // or crash Node; the scan rejects and the child is cleaned up.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("results");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const boom = new Error("visitor boom");
      await assert.rejects(
        backend.scanExact("Symbol", () => {
          throw boom;
        }),
        (error: unknown) => error === boom,
      );
      assert.match(await waitForKill(markerPath), /K\d+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("rejects when the scan visitor throws a falsy value and kills the child", async () => {
    // P1: a falsy thrown value must still reject the scan, not resolve
    // a partial scan as if it completed. The child is killed and cleaned up.
    const { dir, tagsPath, command, markerPath } = createReadtagsShim("results");
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      for (const falsy of [undefined, null]) {
        await assert.rejects(
          backend.scanExact("Symbol", () => {
            throw falsy;
          }),
          (error: unknown) => error === falsy,
        );
      }
      assert.match(await waitForKill(markerPath), /K\d+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("returns immediately when the signal is already aborted", async () => {
    const { dir, tagsPath } = createFixture([{ name: "campaign.py", content: CAMPAIGN_FIXTURE }]);
    try {
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const controller = new AbortController();
      controller.abort();
      const symbols = await backend.queryPrefix("camp", 50, controller.signal);
      assert.deepEqual(symbols, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
