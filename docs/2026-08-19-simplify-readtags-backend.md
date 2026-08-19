# Plan: simplify the readtags backend and its test suite

Date: 2026-08-19
Branch: `fix-memory-overflow-issue` (20 commits against `origin/main`)
Driver: a `/simplify` review of the readtags migration. Five review agents
(reuse, simplification, efficiency, altitude, test value) produced the
findings. This document merges them into one implementation specification.
Parent plan: `.pi/plans/2026-08-18-readtags-backend/plan.md`.

## Goal

Reduce human pain: readability, maintainability, and complexity. Keep all
behavior that the parent plan requires. Remove complexity that the
review-fix commits layered on, and remove test cases without permanent
value.

Baseline: `npm test` reports 233 pass, 0 fail, 11.6 s wall time.
Production code: ~2,500 lines. Test code: ~6,800 lines.

## Decisions

| # | Decision | Source |
|---|----------|--------|
| D1 | Replace the shared alias-load refcount subsystem with a cached promise. Add `dispose()` to the backend. | simplification + altitude |
| D2 | The final-waiter guarantee changes: an abandoned alias child now dies by its own 5 s deadline or by `dispose()`, not at final-caller resolution. Accepted tradeoff. | this plan |
| D3 | Run resolver exact scans concurrently with `Promise.all`. This deviates from the parent plan word "sequential". The 8-name cap and the single deadline stay. | efficiency |
| D4 | Delete `ProjectSymbol.depth`. It has one writer and zero production readers. | own verification |
| D5 | Add two test seams: `queryTimeoutMs` on the backend and `deadlineMs` on the resolver. Tests stop sleeping 5 s. | efficiency |
| D6 | A query that contains a dot and does not split cleanly delegates to the default provider. This unifies `#.foo` handling with `#foo.` handling. | reuse |
| D7 | Skip: shared exact-parent predicate, `formatSymbolItem` O(n²) count, `waitForShared` fast path, chmod-as-root portability guard, a `SessionResources` wrapper class. | this plan |
| D8 | Override the prior audit for alias final-child-closure tests: the mechanism goes away, so its tests go away. Replacement tests cover the new mechanism. | this plan |

## Part A — production changes

### A1. Backend lifecycle and alias cache (`readtags-backend.ts`, `types.ts`, `index.ts`)

The largest complexity block. Delete `SharedAliasLoad`, `getSharedLoad`,
and `waitForShared` (~100 lines, three manual invariants). Replace them:

1. Add a backend lifetime `AbortController` inside `createReadtagsBackend`.
2. Compose the lifetime signal with each caller signal. Give
   `streamReadtags` one composed signal per call. Use one small helper
   (`AbortSignal.any([...])` is available on Node >= 20).
3. Cache the alias load as `let aliasLoad: Promise<AliasResult> | null`.
   Keep these rules from the current code:
   - Cache only a complete load. Clear the cache on an incomplete or
     failed load, so the next caller starts a fresh load.
   - A caller races the cached promise against its own signal and
     deadline. A caller that leaves gets `null`; a partial alias map
     never reaches a caller.
   - Retry once after an incomplete load. A second incomplete load
     throws `"kind alias loading did not complete"`.
4. Add `dispose(): void` to the `ReadtagsBackend` interface in
   `types.ts`. `dispose()` aborts the lifetime controller. After
   `dispose()`: `queryPrefix`/`queryDotted` resolve with an empty array,
   `scanExact` rejects as interrupted. Active children die through the
   composed signal.
5. In `index.ts`:
   - `session_shutdown`: call `backend.dispose()` next to
     `oldManager.shutdown()`. Teardown becomes symmetric.
   - Path replacement in `session_start`: dispose the old backend and
     shut down the old manager before the replacement is created.
   - Drop the redundant `resolve()` around `getStatus().tagsPath`
     (line 78). The manager already stores an absolute path.

Constraint: the alias child stays bounded. Worst case after this change:
the child lives until its 5 s deadline, then SIGTERM, then SIGKILL after
the 200 ms grace. State this bound in the module header comment.

### A2. Merge `runEnsure` and `runRegenerate` (`tags-manager.ts`)

The two functions differ only in one stat check. Replace both with:

```ts
async function runBuild(observedAttempt: number, useExisting: boolean): Promise<void>
```

`ensure` calls `runBuild(n, true)`. `regenerate` calls `runBuild(n, false)`.
Keep the guard order: obsolete check, stale-attempt check, error reset,
probe, optional stat short-circuit, `runCtags`, shared catch.

### A3. Replace the request-slot pairs with a map (`tags-manager.ts`)

Replace `ensureRequest`/`regenerateRequest` and the three `if (kind === …)`
pairs in `coordinate` with one
`const requests = new Map<"ensure" | "regenerate", Promise<void>>()`.
Lookup, store, and clear become one line each.

### A4. Reuse `errorCode()` in `statTags` (`tags-manager.ts`)

`statTags` re-implements the helper inline (lines 127-132). Call
`errorCode(err)` instead.

### A5. Unify `stop` and `stopFailure` (`readtags-backend.ts`)

In `streamReadtags`, merge the two near-identical stop paths into one:

```ts
type StopOutcome = { ok: true; result: Exclude<StreamResult, "complete"> } | { ok: false; error: unknown };
function stop(outcome: StopOutcome): void
```

Replace the four state variables (`result`, `failed`, `failure`,
`stopping`) with one `outcome` variable plus `stopping`. The `close`
handler branches on the single outcome. Keep the kill/grace choreography
identical: SIGTERM, then SIGKILL after `STOP_GRACE_MS`, settle only after
`close`.

### A6. Restructure `runCtags` error precedence (`tags-manager.ts`)

Replace the `primaryError` local plus the `throw` inside `finally` with a
small helper:

```ts
async function runWithCleanup<T>(run: () => Promise<T>, cleanup: () => Promise<void>): Promise<T>
```

The helper always runs `cleanup` after `run` settles. A cleanup failure
merges into a known primary failure; it never replaces it. **Hard
constraint: every status transition and every error message stays
byte-identical.** The existing combined-failure tests are the equivalence
check. If byte-identical output needs more code than the current shape,
abandon A6 and report the abandonment.

### A7. Share the dotted-name split (`resolver.ts`, `autocomplete.ts`)

Export `splitDottedName` from `resolver.ts`. In `autocomplete.ts`:

- If the query contains no dot: `queryPrefix(query, …)`.
- If the query contains a dot: call `splitDottedName(query)`. A `null`
  result delegates to the default provider (covers `#Parent.`, `#.foo`,
  and `#A.B.C`). A valid split calls
  `queryDotted(split.parentName, split.memberName, …)`.
- Hoist the split result once. Derive `isDotted` and the `rankDotted`
  parent argument from it. Remove the three separate
  `query.slice(dotIndex + 1)` computations.

Behavior note (D6): `#.foo` previously ran `queryPrefix(".foo")`. It now
delegates. Document this in the provider header comment.

### A8. Concurrent resolver scans (`resolver.ts`)

Replace the sequential `for … await` over `groups.values()` with
`await Promise.all([...groups.values()].map(g => backend.scanExact(…)))`.
Each group writes only its own members, so the callbacks stay safe. The
shared controller and the single deadline stay. Update the module header
comment ("sequential" → "concurrent, at most 8").

### A9. Delete `ProjectSymbol.depth` (`types.ts`, `readtags-backend.ts`)

Remove the field from the interface and the `depth: hasScope ? 1 : 0`
write in `parseTagLine`. Adapt any test that asserts `depth`.

### A10. Test seams for the two 5 s constants

- `createReadtagsBackend(options)`: add optional `queryTimeoutMs`
  (default 5000). Use it wherever `QUERY_TIMEOUT_MS` is read.
- `resolveReferences(references, backend, options?)`: add optional
  `{ deadlineMs?: number }` (default 5000).

Production callers pass nothing. Only tests pass small values.

## Part B — test-suite changes

### B1. Create `extensions/symbol-autocomplete/test-support.ts`

One shared module. Contents, consolidated from the six files:

- `createMockPi()` — the fake `ExtensionAPI` (now duplicated in
  `index.test.ts` and `integration.test.ts`).
- `createCommandContext()` and `promptEvent()` builders.
- `withTempDir(prefix, fn)` — replaces 56 `mkdtempSync` +
  paired `rmSync` sites across all six files.
- `classicTagLine(name, path, kind, line, opts)` — one builder with an
  explicit `useKindField` option. The two current builders encode the
  kind differently (`kind:x` vs bare `x`); keep both formats reachable
  and explicit at the call site.
- `hasBinary(name)` — replaces the three copies of the
  `spawnSync(bin, ["--version"])` probe.
- `createFakeReadtagsBackend(overrides?)` — records calls for all three
  methods plus `dispose`; merges the two half-fakes.
- `deferred<T>()` — the manual-gate pattern from `tags-manager.test.ts`.
- `pollUntil(fn, opts?)` — the poll helper; replaces `waitForTagsFile`,
  `waitForMarker`, `waitForKill`, and the fixed sleeps (B3).
- `spliceCompletionProvider()` — the `applyCompletion` slice-and-splice
  stub, currently copy-pasted four times.

Migrate all six test files to these helpers. No assertion changes in
this step.

### B2. Delete or merge tests (audit results, reconciled)

`tags-manager.test.ts`:
- DELETE "starts a fresh ctags attempt for a regenerate queued after a
  later attempt began" (~70 lines). The two-way sibling ("runs a queued
  ensure's ctags only after a failed regenerate settles") keeps the
  attempt-join invariant pinned. This overrides the prior audit's
  blanket preserve of attempt-join tests; one such test survives.
- MERGE "combines the ctags and cleanup failures when no live file
  exists" into "combines the ctags failure and the cleanup failure when
  the live file remains" (one extra assertion).

`readtags-backend.test.ts`:
- The alias-mechanism tests change under A1 — see B6.

`integration.test.ts`:
- MERGE "injects dotted stable token symbol-context for scoped member
  (end-to-end)" into its dotted-plain sibling (~-57 lines).
- DELETE "suggests dotted members with a shortened case-insensitive
  parent prefix (#camp.res)" (duplicate at wiring and backend levels).

`parser-resolver.test.ts`:
- MERGE "does NOT parse #name mid-word" into "does NOT parse #name after
  non-whitespace character".
- MERGE "parses #name followed by punctuation" into "parses #name
  followed by comma".
- DELETE "still resolves normal non-dotted refs when literal dotted
  symbol exists" and "still resolves valid two-segment dotted refs when
  literal dotted symbol exists" (both re-prove pinned regressions).

`index.test.ts`:
- DELETE "fails open when the resolver total deadline aborts the scans"
  (a real 5 s sleep; both claims stay pinned elsewhere).
- REWRITE "old manager never publishes after session_shutdown; a new
  instance publishes and serves new state" (~150 lines) as a small
  wiring test: assert `session_shutdown` awaits the manager shutdown
  and disposes the backend; assert a fresh instance publishes
  independently. The manager-level invariant stays pinned in
  `tags-manager.test.ts`.

`autocomplete.test.ts`: no deletions. Adapt to `test-support.ts` only.

### B3. Replace fixed sleeps with polls

Replace the ~19 `await new Promise((r) => setTimeout(r, 50|100))` sites
in `index.test.ts` and `integration.test.ts` with
`pollUntil(() => !mgr.getStatus().isBuilding)` or an equivalent
observable condition.

### B4. Share the real-ctags fixture

In `readtags-backend.test.ts`, build the `CAMPAIGN_FIXTURE` tags file
once per file (a `before` hook) and reuse it across the seven tests that
currently each run `spawnSync("ctags", …)` on identical content. Keep
`createFixture` for the tests with different content.

### B5. Shrink the two 5 s timeout tests

Use the A10 seams. Pass a small timeout (for example 100 ms) in
"applies one deadline to alias loading and the query"
(`readtags-backend.test.ts`) and "bounds all admitted scans with one
total deadline" (`parser-resolver.test.ts`). Tighten the elapsed-time
assertions accordingly.

### B6. Adapt alias-mechanism tests to A1

Delete the tests that pin the removed refcount mechanism:
- "keeps an active caller's alias load complete when the first caller
  aborts" and "keeps an active exact caller's alias load complete when
  the first callers abort" — replace with one test: a caller that
  aborts gets no partial map, and a concurrent caller still receives
  the complete map from the cached load.
- The final-waiter SIGKILL-grace test — replace with: `dispose()` kills
  an in-flight alias child (including a SIGTERM-ignoring one) and later
  queries resolve empty / reject.
- Keep the general capped-query SIGKILL-grace test unchanged.
- Add: an incomplete alias load is not cached; the next caller triggers
  a fresh load; a second incomplete load rejects.

## Execution order (one `npm test` gate per phase)

1. B1 + B3 + B4: shared test support, polls, shared fixture. No
   production change. Suite must stay green with 233 passes.
2. A2 + A3 + A4 + A6: tags-manager reshape. No message or status change.
3. A5: stream stop unification.
4. A1 + B6 + index wiring: backend lifecycle rework with its coupled
   test adaptations.
5. A7 + A8 + A9 + A10 + B5: autocomplete, resolver, types, seams.
6. B2: test deletions and merges.

## Verification

- `npm test` passes after every phase. There is no separate typecheck
  script; the runner strips types.
- Expected end state: ~205-215 runner-reported passes, 0 skips
  (with real ctags/readtags installed), wall time under 4 s.
- Grep gates after phase 6: no `waiters`, no `waitForShared`, no
  `ProjectSymbol` `depth`, no `mkdtempSync` outside `test-support.ts`.
- No stray `tags` or `.tags.tmp-*` files in the repository after the
  suite runs.

## Outcome (2026-08-19)

An Opus 5 subagent implemented all six phases. Final state: 221 tests
pass, 0 fail, 0 skips, 7.0 s wall time (baseline: 233 pass, 11.6 s).
Production diff: +218/−227 across six files. Tracked diff overall:
−897 lines net; the new `test-support.ts` adds 338 lines beside it.
All grep gates pass.

Recorded deviations:

- **A6 abandoned** through its abort clause. `runCtags` returns the
  primary failure as a string; it does not throw it. A
  `runWithCleanup(run, cleanup)` helper cannot see that string without
  extra parameters or a thrown primary failure. Either option costs more
  code than the current shape. `runCtags` is unchanged.
- B6 deleted two more refcount-pinned tests than the plan named; their
  surviving claims moved into the new cached-load tests.
- The incomplete-load test folded into the existing 10,000-line-cap
  retry test with a second-caller assertion.
- The merged combined-failure manager test needed a short second phase
  to assert the cleared status; the survivor could not express it.
- `test-support.ts` adds `makeTempDir`/`removeTempDir` (primitives under
  `withTempDir`) and `readStatusLine` (the only observable surface for
  `isBuilding` polls).
- B5 uses a 500 ms deadline for the backend timeout test; a 100 ms
  deadline kills the shim child before its signal handler installs. The
  resolver test uses 100 ms as planned.
- `classicTagLine` requires `useKindField` at every call site.

## Review round (2026-08-19)

A code-quality review of the working tree found zero P1, one P2, and
three P3 findings. The traced races in the alias cache, the stream stop
path, and the session lifecycle all hold.

- **P2, fixed**: after an early scan rejection, `Promise.all` left
  sibling readtags children active until the 5 s deadline. The resolver
  now aborts the shared controller in the `finally` block. A new test
  ("aborts sibling scans when one scan rejects early") pins it. Final
  suite: 222 pass, 0 fail.
- **P3, recorded, not fixed**: a kill failure (`error` event during the
  SIGTERM grace) settles the stream while the child lives; SIGKILL would
  fail for the same reason, so the escalation would not help.
- **P3, recorded, not fixed**: the `session_start` replacement path
  drops an old manager's shutdown failure silently; `session_shutdown`
  still surfaces it to Pi.
- **P3, recorded, pre-existing**: a complete kind-alias load stays
  cached for the backend lifetime, so `/rescan-symbols` does not refresh
  aliases until a restart.

## Out of scope (recorded skips)

- Shared exact-parent predicate across backend and provider: a one-line
  comparison; extraction adds coupling without payoff.
- `formatSymbolItem` duplicate-count precomputation: bounded at 50 items.
- Root-user guard for the chmod-based cleanup tests: portability topic,
  not simplification; noted for a future change.
- A `SessionResources` wrapper object: the symmetric `dispose()` wiring
  in A1 delivers the guarantee without a new abstraction.
