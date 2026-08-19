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

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createReadtagsBackend, parseTagLine } from "./readtags-backend.ts";
import type { ProjectSymbol } from "./types.ts";
import {
  hasBinary,
  makeTempDir,
  pollUntil,
  removeTempDir,
  withTempDir,
} from "./test-support.ts";

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
  });

  void it("parses the bare interface:X scope form", () => {
    const sym = parseTagLine(tagLine("x", "a.ts", ["kind:property", "line:2", "interface:MyInterface"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.parentName, "MyInterface");
  });

  void it("includes a class-scoped variable", () => {
    const sym = parseTagLine(tagLine("reservation_date", "models.py", ["kind:variable", "line:5", "class:Campaign"]), new Map());
    assert.ok(sym !== null);
    assert.equal(sym.kind, "variable");
    assert.equal(sym.parentName, "Campaign");
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

const readtagsPresent = hasBinary("readtags");
const integrationAvailable = readtagsPresent && hasBinary("ctags");

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
 * Generate a fixture tags file with real ctags inside `dir`.
 * Returns the tags file path.
 */
function createFixture(dir: string, files: Array<{ name: string; content: string }>): string {
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file.name), file.content);
  }
  const result = spawnSync(
    "ctags",
    ["--sort=foldcase", "--fields=+KznZe", "-f", "tags", ...files.map((f) => f.name)],
    { cwd: dir },
  );
  assert.equal(result.status, 0, `ctags failed: ${result.stderr.toString()}`);
  return path.join(dir, "tags");
}

function createReadtagsShim(dir: string, mode: string): { tagsPath: string; command: string; markerPath: string } {
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
  return { tagsPath, command, markerPath };
}

function readMarker(markerPath: string): string {
  return fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "";
}

void describe("readtags backend bounds", () => {
  void it("kills the child at the result cap", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "results");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.equal((await backend.queryPrefix("symbol", 5)).length, 5);
      await pollUntil(() => readMarker(markerPath).includes("K"));
      const marker = readMarker(markerPath);
      assert.match(marker, /K\d+/);
      assert.ok(Number.parseInt(marker.match(/K(\d+)/)![1], 10) < 500);
    });
  });

  void it("kills the child at the scanned-line cap", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "scanned");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.match(readMarker(markerPath), /K\d+/);
      assert.ok(Date.now() - started < 2_000);
    });
  });

  void it("kills the child for a line longer than 64 KiB", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "huge-line");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      assert.ok(Date.now() - started < 2_000);
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.match(readMarker(markerPath), /K0/);
    });
  });

  void it("does not spawn for an aborted signal or a zero limit", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "results");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const controller = new AbortController();
      controller.abort();
      assert.deepEqual(await backend.queryPrefix("symbol", 50, controller.signal), []);
      assert.deepEqual(await backend.queryPrefix("symbol", 0), []);
      assert.equal(readMarker(markerPath), "");
    });
  });

  void it("applies one deadline to alias loading and the query", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "slow-alias");
      // The test seam shortens the 5 s default to 500 ms. Two deadlines
      // would need about 1 000 ms, so the bound below rejects them.
      const backend = createReadtagsBackend({
        tagsFilePath: tagsPath,
        cwd: dir,
        readtagsPath: command,
        queryTimeoutMs: 500,
      });
      const started = Date.now();
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 900, `one deadline must bound the alias load and the query (took ${elapsed} ms)`);
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.equal(readMarker(markerPath), "D\nK0");
    });
  });

  void it("caches aliases after the alias cap", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "alias-cap");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      await backend.queryPrefix("symbol", 1);
      await backend.queryPrefix("symbol", 1);
      assert.equal(readMarker(markerPath).match(/D/g)?.length, 1);
    });
  });

  void it("ranks an exact dotted parent before a prefix parent", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command } = createReadtagsShim(dir, "dotted");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.deepEqual((await backend.queryDotted("Campaign", "res", 1)).map((symbol) => symbol.name), ["resZ"]);
    });
  });

  void it("normalizes non-finite limits", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command } = createReadtagsShim(dir, "results");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      assert.equal((await backend.queryPrefix("symbol", Number.NaN)).length, 50);
    });
  });

  void it("completes an alias load of exactly 10,000 lines and caches it", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "alias-10k");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const symbols = await backend.queryPrefix("symbol", 1);
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "Symbol0");
      // The complete load is cached; a second query does not re-run -D.
      await backend.queryPrefix("symbol", 1);
      assert.equal(readMarker(markerPath).match(/D/g)?.length, 1);
    });
  });

  void it("rejects an alias load past the 10,000-line cap as incomplete", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "alias-10001");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      await assert.rejects(backend.queryPrefix("symbol", 1), /did not complete/);
      // The active caller retries an incomplete load exactly once: the
      // marker records two -D spawns and two kills.
      const marker = readMarker(markerPath);
      assert.match(marker, /K\d+/);
      assert.equal(
        marker.match(/D/g)?.length,
        2,
        "an incomplete load must retry once for an active caller",
      );

      // The cache never keeps an incomplete load. A later caller starts
      // a fresh load and retries it once again.
      await assert.rejects(backend.queryPrefix("symbol", 1), /did not complete/);
      assert.equal(
        readMarker(markerPath).match(/D/g)?.length,
        4,
        "a later caller must start a fresh load",
      );
    });
  });

  void it("gives an aborted caller no aliases while a concurrent caller gets the complete load", async () => {
    // The alias load belongs to the backend, not to one caller. The first
    // caller aborts and receives no partial map. The concurrent caller
    // still receives the complete map from the same cached load.
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "gated-alias");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const controller = new AbortController();

      // The first caller starts the gated alias load; the second joins it.
      const first = backend.queryPrefix("symbol", 50, controller.signal);
      await pollUntil(() => readMarker(markerPath).includes("P"));
      const second = backend.queryPrefix("symbol", 1);

      controller.abort();
      assert.deepEqual(await first, [], "an aborted caller receives no partial map");
      assert.ok(!readMarker(markerPath).includes("K"), "the load must survive the abort");

      // Release the gate. The cached load completes for the second caller.
      fs.writeFileSync(markerPath + "-go", "");
      const symbols = await second;
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "Symbol0");
      assert.equal(symbols[0].kind, "class");
      assert.equal(readMarker(markerPath).match(/D/g)?.length, 1, "both callers share one load");
    });
  });

  void it("dispose kills a SIGTERM-ignoring alias child and stops later queries", async () => {
    // dispose() aborts the backend lifetime signal. The in-flight alias
    // child dies through the SIGKILL grace and every later call ends
    // without a subprocess.
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "stubborn-alias");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });

      const pending = backend.queryPrefix("symbol", 50);
      await pollUntil(() => readMarker(markerPath).includes("P"));
      const pid = Number.parseInt(readMarker(markerPath).match(/P(\d+)/)![1], 10);

      backend.dispose();
      assert.deepEqual(await pending, [], "a disposed backend returns no results");

      // The child ignores SIGTERM, so it dies at the SIGKILL grace.
      await pollUntil(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, { message: "the alias child must die after dispose()" });

      const spawnsAfterDispose = readMarker(markerPath).match(/D/g)?.length;
      assert.deepEqual(await backend.queryPrefix("symbol", 50), []);
      assert.deepEqual(await backend.queryDotted("Camp", "res", 50), []);
      await assert.rejects(backend.scanExact("Symbol", () => {}), /interrupted/);
      assert.equal(
        readMarker(markerPath).match(/D/g)?.length,
        spawnsAfterDispose,
        "a disposed backend must not spawn a child",
      );
    });
  });

  void it("kills a SIGTERM-ignoring child with SIGKILL after a grace period", async () => {
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "no-term");
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
    });
  });
});

void describe("readtags backend integration", { skip: !integrationAvailable }, () => {
  // One shared campaign fixture. Every test below that needs the same
  // content reuses it, so ctags runs once instead of seven times.
  let campaignDir = "";
  let campaignTagsPath = "";

  before(() => {
    campaignDir = makeTempDir("rt-campaign-");
    campaignTagsPath = createFixture(campaignDir, [
      { name: "campaign.py", content: CAMPAIGN_FIXTURE },
    ]);
  });

  after(() => {
    if (campaignDir) removeTempDir(campaignDir);
  });

  /** Create a backend over the shared campaign fixture. */
  function campaignBackend() {
    return createReadtagsBackend({ tagsFilePath: campaignTagsPath, cwd: campaignDir });
  }

  void it("returns case-insensitive prefix matches", async () => {
    const symbols = await campaignBackend().queryPrefix("camp", 50);

    assert.deepEqual(
      symbols.map((s) => s.name),
      ["Campaign", "CampaignHelper", "CampaignViewSet"],
    );
    assert.ok(symbols.every((s) => s.kind === "class"));
    assert.ok(symbols.every((s) => s.path === "campaign.py"));
    assert.ok(symbols.every((s) => s.parentName === undefined));
  });

  void it("parses endLine from generated end: fields", async () => {
    const symbols: ProjectSymbol[] = [];
    await campaignBackend().scanExact("Campaign", (symbol) => symbols.push(symbol));

    assert.equal(symbols.length, 1);
    assert.ok(symbols[0].endLine !== undefined);
    assert.ok(symbols[0].endLine! >= symbols[0].line);
  });

  void it("filters dotted queries by parent prefix and ranks exact parents first", async () => {
    const symbols = await campaignBackend().queryDotted("campaign", "res", 50);

    assert.deepEqual(
      symbols.map((s) => s.name),
      ["reservation_date", "reserve", "reset"],
    );
    assert.deepEqual(
      symbols.map((s) => s.parentName),
      ["Campaign", "Campaign", "CampaignHelper"],
    );
  });

  void it("matches dotted parents case-insensitively", async () => {
    const symbols = await campaignBackend().queryDotted("CAMP", "res", 50);

    assert.deepEqual(
      symbols.map((s) => s.name),
      ["reservation_date", "reserve", "reset"],
    );
  });

  void it("stops the stream at the result cap", async () => {
    const manyLines = ["def seed():", "    pass", ""];
    for (let i = 0; i < 100; i += 1) {
      manyLines.push(`class Capped${i}:`, "    pass", "");
    }
    await withTempDir("rt-backend-", async (dir) => {
      const tagsPath = createFixture(dir, [{ name: "capped.py", content: manyLines.join("\n") }]);
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
    });
  });

  void it("streams an exact name", async () => {
    const symbols: ProjectSymbol[] = [];
    await campaignBackend().scanExact("Campaign", (symbol) => symbols.push(symbol));

    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "Campaign");
    assert.equal(symbols[0].kind, "class");
    assert.equal(symbols[0].path, "campaign.py");
    assert.equal(symbols[0].line, 4);
  });

  void it("visits nothing for an unknown exact name", async () => {
    const symbols: ProjectSymbol[] = [];
    await campaignBackend().scanExact("NoSuchSymbol", (symbol) => symbols.push(symbol));
    assert.deepEqual(symbols, []);
  });

  void it("streams more than 50 exact records through the visitor", { skip: !readtagsPresent }, async () => {
    // P1: the backend must not cap exact scans at 50 results. A fixture
    // with 60 identical names must deliver all 60 to the visitor while
    // the backend itself retains none.
    await withTempDir("rt-scan-60-", async (dir) => {
      const tagsPath = path.join(dir, "tags");
      const lines = [
        "!_TAG_FILE_FORMAT\t2\t/extended format/",
        "!_TAG_FILE_SORTED\t2\t/0=unsorted, 1=sorted, 2=foldcase/",
      ];
      for (let i = 1; i <= 60; i += 1) {
        lines.push(`seed\tsrc/seed.ts\t/^def seed():$/;"\tkind:function\tline:${i}\tlanguage:TypeScript`);
      }
      fs.writeFileSync(tagsPath, lines.join("\n") + "\n");

      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir });
      const seen: ProjectSymbol[] = [];
      await backend.scanExact("seed", (symbol) => seen.push(symbol));

      assert.equal(seen.length, 60);
      assert.ok(seen.every((s) => s.name === "seed"));
      assert.equal(new Set(seen.map((s) => s.line)).size, 60);
    });
  });

  void it("rejects an exact scan that hits the scanned-line cap", async () => {
    // P1: when the stream stops before normal EOF, the scan must reject
    // as incomplete instead of returning partial results.
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "scanned");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const started = Date.now();
      await assert.rejects(backend.scanExact("symbol", () => {}), /did not complete/);
      assert.ok(Date.now() - started < 2_000);
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.match(readMarker(markerPath), /K\d+/);
    });
  });

  void it("rejects when the scan visitor throws and kills the child", async () => {
    // P1: a visitor exception must not escape the EventEmitter callback
    // or crash Node; the scan rejects and the child is cleaned up.
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "results");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      const boom = new Error("visitor boom");
      await assert.rejects(
        backend.scanExact("Symbol", () => {
          throw boom;
        }),
        (error: unknown) => error === boom,
      );
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.match(readMarker(markerPath), /K\d+/);
    });
  });

  void it("rejects when the scan visitor throws a falsy value and kills the child", async () => {
    // P1: a falsy thrown value must still reject the scan, not resolve
    // a partial scan as if it completed. The child is killed and cleaned up.
    await withTempDir("rt-shim-", async (dir) => {
      const { tagsPath, command, markerPath } = createReadtagsShim(dir, "results");
      const backend = createReadtagsBackend({ tagsFilePath: tagsPath, cwd: dir, readtagsPath: command });
      for (const falsy of [undefined, null]) {
        await assert.rejects(
          backend.scanExact("Symbol", () => {
            throw falsy;
          }),
          (error: unknown) => error === falsy,
        );
      }
      await pollUntil(() => readMarker(markerPath).includes("K"));
      assert.match(readMarker(markerPath), /K\d+/);
    });
  });

  void it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const symbols = await campaignBackend().queryPrefix("camp", 50, controller.signal);
    assert.deepEqual(symbols, []);
  });
});
