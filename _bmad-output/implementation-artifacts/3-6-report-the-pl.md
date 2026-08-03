---
baseline_commit: 2d2b2e4eeda72635f39149fb311cd1b402a22083
---

# Story 3.6: Report the P&L

**Epic:** 3 — Read Ledger and Token P&L
**FR:** FR-9
**Status:** done

As a user,
I want `cortex stats` to show what Cortex cost and returned,
So that I can judge it on a number rather than a claim.

## Acceptance Criteria (verbatim from epics.md:724-740)

**Given** a session with ledger activity
**When** stats runs
**Then** it reports tokens injected, tokens saved, net, and ratio, for the session and cumulatively for the scope.

**Given** a store with memory items
**When** stats runs
**Then** it reports item counts by state, the count never retrieved, and the ten most-retrieved items.

**Given** unrealized savings exist
**When** stats runs
**Then** they are reported distinctly from realized savings, so the capability-versus-adoption gap is visible.

**Given** a database with 10,000 memory items
**When** stats runs
**Then** it completes within 200 ms (B-6).

## What is actually here — run before designing

`cortex stats` (cli.ts:944-1020) already prints, **store-wide and unscoped**:
`Focus / Sessions / Active notes / Injected / Saved / Net / Efficiency`, plus
`Unrealized` and `Estimated` when non-zero, the honest `Saved: 0` explanation
Story 3.5 added, and the FR-25 `Database` / `WAL` lines (which run
`maybeCheckpointWal` first, deliberately). So AC #1's quantities exist but at
the wrong granularity — nothing is per-session or per-scope — and AC #2's
retrieval health does not exist at all.

What the store already gives us, verified by symbol lookup, not recalled:

- `getTotalTokens()` / `getLedgerStats()` (store.ts:3185, 3216) — store-wide
  sums by all four directions. `byType` carries all four since the 3.5
  reconciliation.
- `token_ledger` has `idx_ledger_session` on `session_id` (schema.ts:489);
  scope attribution must come by joining `sessions` (rows carry no scope_key).
  GC rollup rows keep `session_id` (`GROUP BY session_id, direction, ...`), so
  they survive that join.
- `resolveWorkingScopeKeys(store)` (state.ts:79) — preferred scope key +
  project scope key, the same pair FR-7's brief uses.
- `getRecentSessionsByScope(scopeKey, limit)` (store.ts:1392) — **primary**
  sessions only, `ORDER BY started_at DESC, rowid DESC`.
- `getSessionTreeIds(sessionId)` (store.ts:1746) — root primary + all its
  children; the established one-turn's-work grouping. Depth is 2 by
  construction; the `parent_session_id ?? id` shorthand inside is the same one
  AD-16's walk documents as correct for exactly this shape.
- `memory_items.access_count INTEGER NOT NULL DEFAULT 0` and
  `last_accessed_at` (schema.ts:290) — durable, bumped only by
  `touchMemoryItems`, preserved by every re-sync path (FR-22 work). So
  "most-retrieved" and "never retrieved" have exact, already-maintained
  meanings: `access_count DESC` and `access_count = 0`.
- Label helpers: `isSupersededMemoryItem` (memory/items.ts:121, trailer-scoped)
  and `isContested(item: ParsedMemoryItem)` (render.ts:58, line-exact
  note-only). These are the canonical sniffs; nothing here invents a substring
  match.
- `formatTokens` gained its negative branch in 3.5 — session `Net` will
  routinely be negative and must not print raw.

**The B-6 platform fact, known before writing a line:** Story 3.3 measured the
CLI floor on this machine at ~500 ms+ — `cortex read-ledger` end-to-end cost
532–573 ms against ~48–52 ms for a bare `node -e 0`, dominated by Node boot,
module graph and store open. `cortex stats` pays the same floor, so **the CLI
invocation cannot meet 200 ms end-to-end on this platform no matter what this
story does.** The 3.3 precedent is the ruling: measure the stats path
in-process (build + render against a 10,000-item store), pin that by test
under 200 ms, measure the CLI end-to-end, and record both numbers. Reporting
"within B-6" off the in-process number alone without stating the CLI cost
would be a false green — the exact reporting failure the 3.5 reconciliation
existed to correct.

## Design decisions

### D1 — The report is built in `src/query/stats.ts`, not inline in the CLI

The current stats action does everything inline in `cli.ts`. FR-9 adds session
resolution, scope attribution, and retrieval health — logic that must be
testable and perf-measurable in-process (D7). Layer direction is
transports → query → db, so the shape is `buildStatsReport(store, opts):
StatsReport` (structured data) plus `renderStatsReport(report): string`, with
the CLI action reduced to open → build → render → write. Tests assert against
the query layer and against real rendered lines; the B-6 fixture times
build + render without a process spawn.

**Architecture variance, stated:** the spine maps FR-8..FR-9 to
`ledger/accounting.ts`. The codebase settled the ledger in `store.ts` (Story
3.5) and every query surface in `src/query/` — recall, brief, state, doctor,
inspect, read-ledger. Follow the repo, not the stale module name.

### D2 — "The session" is the scope's most recent primary, and its report covers its tree

`cortex stats` runs from a shell, outside any session, and **must not create
one** — the FR-21 rule (list-memory/inspect-memory/doctor create no session)
binds a reporting surface hardest. So "the session" is resolved read-only: the
most recently started primary across `resolveWorkingScopeKeys` — preferred key
first; latest `started_at` wins; a **cross-key** tie keeps the preferred key's
candidate (strict `>` never displaces the incumbent), while `rowid` tiebreaks
only **within** a key, inside `getRecentSessionsByScope`. (Corrected at
review: the original sentence claimed the rowid tiebreak across keys.) Active or ended — after a turn
finishes, "what did that session cost" is exactly the question this exists to
answer, and `inject-header` ends the tree on every SessionStart, so
active-only would leave the block empty almost always (the FR-7 lesson:
Story 3.3 hit the same wall with `read by primary`).

The session block totals the whole **tree** via `getSessionTreeIds`: a
subagent's injected brief is a real cost of the turn that dispatched it, and
Epic 0 gave children their own sessions precisely so this attribution is
possible. The rendered label says `(incl. subagents)` only when child rows
contributed, so the word "session" is never silently redefined. No primary in
scope → the block renders an explicit "no session in this scope yet" line, not
zeros pretending to be a measurement.

### D3 — Scope cumulative joins the ledger through `sessions` on the working scope keys

`SELECT direction, SUM(tokens) FROM token_ledger JOIN sessions ON
token_ledger.session_id = sessions.id WHERE sessions.scope_key IN (…) GROUP BY
direction`. Children inherit the primary's `scope_key` (Epic 0), so subagent
rows are included naturally; rollup rows keep their `session_id`, so GC does
not leak tokens out of the scope totals (pin this with a rolled-up fixture). A
ledger row whose session row is gone cannot be attributed to a scope and drops
out of the join — an undercount, the safe direction under FR-9's own PRD note
("under-reporting is acceptable, over-reporting is fatal"); nothing in `src/`
deletes sessions today. Store-wide totals remain available via
`getTotalTokens` (other callers keep it); the printed report is session +
scope, which is what AC #1 names.

### D4 — Ratio is `saved / injected`, rendered in ×, and it replaces `Efficiency`

AC #1 says "net, and ratio". The PRD note under FR-9 names "the injected/saved
ratio" as *the* number the product is judged on and demands it be conservative
by construction; SM-1's target is stated in the same unit ("≥ 5× injected").
`Efficiency: N%` — `saved/(spent+saved)` — is the pre-R1 dashboard formula
that dressed the withdrawn consolidation credit as 93%, and keeping two
derivations of the same two totals is vocabulary drift of exactly the kind D1
of Story 3.5 retired. It goes. `Ratio: 0.00×` with: `injected = 0` rendering
`—` (no denominator is "no measurement", never `0` or `Infinity`); and
`unrealized`/`estimated` never entering the numerator or denominator —
conservative by construction, structurally.

The `Saved: 0` explanation from 3.5 survives, keyed on the **scope** block's
saved total, since that is the cumulative judgment surface.

### D5 — Retrieval health is store-wide, the operator-surface convention

AC #2 opens "Given a store with memory items". FR-21 established the
convention deliberately: an operator surface that hides rows cannot answer the
question it exists for, so list-memory defaults to **no state filter and no
scope filter**. Same here: counts by state cover every state including
`archived` and `pinned`; never-retrieved is `access_count = 0` across the
store; the ten most-retrieved are `access_count DESC` across the store,
**filtered to `access_count > 0`** — padding a "most-retrieved" list with
never-retrieved rows fabricates retrieval history — with a deterministic
tiebreaker (`access_count DESC, last_accessed_at DESC, rowid DESC`; seeded and
same-transaction rows share timestamps to the millisecond, the FR-21 partial-
order lesson) and the ordering criterion **printed** in the section header,
not merely implemented. Fewer than ten retrieved items → a shorter list.

### D6 — Rendered item lines follow the stored-strings-are-content discipline

`subject` and `text` are author-supplied and this is a new surface printing
them: collapse control characters (escaped character classes — **never
literal bytes**; a raw NUL authored here is how two files in this repo became
invisible to grep), collapse newlines so one item cannot forge a second list
row, truncate to a fixed width with the count and kind — the answer — never
what gets cut, and re-attach `[contested]` / `(superseded)` **after**
truncation via the canonical helpers (`isContested`, `isSupersededMemoryItem`)
— the `renderHeaderHighlights` lesson, and never a new substring sniff. This
is a surface that shows notes, and CLAUDE.md's rule is that contested items
carry the marker on every such surface; enumerating `renderMemoryLine` call
sites would not have found this one, which is exactly why the rule is stated
against surfaces.

### D7 — B-6 is measured in-process; the CLI end-to-end number is recorded, not claimed

The perf test seeds 10,000 memory items **and** a populated ledger (a
measurement over an empty ledger measures nothing), runs
`buildStatsReport` + `renderStatsReport` repeatedly, and pins p95 ≤ 200 ms —
expected to pass with an order of magnitude of headroom, since every query
here is a single aggregate or a LIMIT 10 over an indexed or 10k-row table.
The fixture must also assert the seeded shape it claims (pre-assert 10,000
rows exist and that the top-10 query actually returned 10) so the measurement
cannot quietly run against an empty store — the 3.4 lesson that a ceiling
gated on the wrong predicate never fires. The CLI end-to-end cost is measured
once with the spawn floor alongside it and recorded in the completion notes,
CLAUDE.md and README exactly as 3.3 recorded read-ledger's 532–573 ms.
`maybeCheckpointWal` stays in the CLI action (FR-25 depends on it) and is part
of the recorded CLI cost, outside the in-process measurement.

### D8 — Stats reads; it does not touch, create, or book

No session creation (D2), no `touchMemoryItems` — **a surface for revealing
what ranking holds must not change that ranking by being used** (FR-21's rule,
and the top-10 list is precisely "what ranking holds") — and no ledger
booking: a CLI render to a terminal injects nothing into any context, the
documented deliberate state from 3.5's reconciliation. The existing writes on
this path stay as they are (`openCortexDb` runs `ensureCortexSchema`;
`maybeCheckpointWal` folds the WAL — both established with their own
rationale). Pin the non-mutation: run stats twice over a seeded store and
assert `access_count`, session count, and ledger row count are byte-identical
between runs.

## Tasks

1. [x] **Store queries** (`src/db/store.ts`): `getScopeTokenTotals(scopeKeys)`
   (join through sessions, all four directions), `getSessionLedgerTotals(ids)`
   (IN-list over the tree; returns per-session rows so the caller can both
   total and detect child contribution), `getMemoryItemStateCounts()`,
   `countNeverRetrievedMemoryItems()`, `getMostRetrievedMemoryItems(limit)`
   (deterministic order, `access_count > 0`). All read-only.
2. [x] **`src/query/stats.ts`**: `buildStatsReport` / `renderStatsReport` per
   D1–D6. Session resolution via `resolveWorkingScopeKeys` +
   `getRecentSessionsByScope` + `getSessionTreeIds`.
3. [x] **CLI** (`src/transports/cli.ts`): stats action becomes
   open → build → render; keeps `Focus`/`Sessions`/`Active notes` and the
   FR-25 `Database`/`WAL` lines and checkpoint behavior.
4. [x] **`src/index.ts`**: new public symbols and types re-exported.
5. [x] **Tests** (`tests/stats.test.ts`, 25 tests): full edge inventory,
   CLI-level assertions on real rendered lines, D7 perf fixture with
   pre-asserted shape, D8 non-mutation fixture.
6. [x] **Docs**: README (`### The P&L` section + intro bullet), CLAUDE.md
   (seven new invariant bullets + Core Files entry + two updated bullets),
   `_bmad-output/project-context.md` (Dormant Surface paragraph). Verified
   before writing: no existing test pinned `Efficiency:` (comments only).
7. [x] **Mutation campaign**: 12 mutations, **11/11 killable killed**, 1
   measured-equivalent (`IN ()` guard) asserted surviving. Two first-pass
   survivors exposed weak fixtures, both strengthened (see Completion Notes).

## Edge inventory (each becomes a test)

- Session block: most recent primary wins over an older active one; child
  rows included and labeled; no-session scope renders the explicit line.
- Scope totals: include children's rows; **exclude another scope's rows**
  (seed a second scope and assert its tokens do not leak); survive a GC
  rollup byte-identically (roll up, re-total, same numbers — the gc.test
  precedent).
- Ratio: `—` at injected = 0; conservative (unrealized/estimated excluded
  from both terms — mutation-test by folding them in and watching the
  assertion go red); negative net renders through `formatTokens`.
- Unrealized: reported distinctly in both blocks when non-zero, absent when
  zero (AC #3).
- Retrieval health: archived and pinned counted; never-retrieved counts
  `access_count = 0` only; top-10 excludes zero-count rows, truncates at ten,
  is stable across two runs with millisecond-identical timestamps; a
  retrieval through the real path (`touchMemoryItems`) moves an item up —
  fixture built through the real writer, not hand-set counters, for at least
  one case (the FR-22 fixture lesson).
- Rendering: control chars and newlines in `text`/`subject` cannot forge a
  row (assert on the exact rendered block); `[contested]` and `(superseded)`
  labels survive truncation; a note merely *containing* "Conflict: true"
  mid-content does not get the marker (the helpers own this; assert it here
  anyway so this surface cannot regress independently).
- D7 perf and D8 non-mutation as specified.

### Review Findings (three layers, triaged 2026-08-02)

All three layers returned tool-named evidence. 19 patch, 1 defer, 0 dismissed,
0 decision-needed. Severities are the triage's own, not the reviewers'.

- [x] [Review][Patch] **HIGH** Rollup test firing condition unpinned — an exported `CORTEX_GC_LEDGER_DAYS` > 20 or a raised default silently voids the D3 pin (blind+edge+auditor, all three independently) [tests/stats.test.ts:191]
- [x] [Review][Patch] **HIGH** CLAUDE.md "campaign asserts the mutant survives / cannot go stale silently" is unbacked by any tree artifact, and the `IN ()` unit test never executes the `IN ()` SQL (guard short-circuits first) (auditor+blind) [CLAUDE.md:195, tests/stats.test.ts:524]
- [x] [Review][Patch] **MED** Legacy NULL-scope ledger rows invisible on every stats surface — measured 0 on this store (gap to store-wide is other branches: main 93.4k), latent for pre-scope-column stores (edge) [src/db/store.ts getScopeTokenTotals]
- [x] [Review][Patch] **MED** D8 non-mutation snapshot omits `memory_references`/`current_app_graph` — the exact write class the module header names as the threat (blind) [tests/stats.test.ts:504]
- [x] [Review][Patch] **MED** `(incl. subagents)` and `started <ts>` have no positive render assertion — deleting either leaves the suite green (blind) [src/query/stats.ts:224]
- [x] [Review][Patch] **MED** `getMostRetrievedMemoryItems` unguarded LIMIT on exported API — negative reads as no-limit (the FR-21 dump clause), NaN throws raw (blind) [src/db/store.ts:3367]
- [x] [Review][Patch] **MED** Top-10 lines carry no item id — no handle into `cortex inspect-memory`; FR-21 operator surfaces expose ids for exactly this (blind) [src/query/stats.ts:135]
- [x] [Review][Patch] **LOW** Truncation can split a surrogate pair — lone high surrogate mojibake (edge+blind) [src/query/stats.ts:124]
- [x] [Review][Patch] **LOW** Direction fold duplicated store+stats with silent unknown-direction drop; `includesSubagents` counts unknown directions (blind+edge) [src/db/store.ts:3327, src/query/stats.ts:156]
- [x] [Review][Patch] **LOW** Saved-0 explanation asserts a global mechanism fact from scope-local data — false in other scopes the day 4.5 books anywhere; nothing binds 4.5 to revisit (edge+blind) [src/query/stats.ts:245]
- [x] [Review][Patch] **LOW** Perf assertion computes p100, labeled p95 — flake-prone strictness (edge) [tests/stats.test.ts:587]
- [x] [Review][Patch] **LOW** `by access count` assertion satisfiable by the empty branch (edge) [tests/stats.test.ts:415]
- [x] [Review][Patch] **LOW** Printed criterion omits the load-bearing tiebreakers the cited FR-21 precedent prints (auditor) [src/query/stats.ts:265]
- [x] [Review][Patch] **LOW** Stale CLI description "Token savings dashboard" (blind) [src/transports/cli.ts:946]
- [x] [Review][Patch] **LOW** Control-only text renders a dangling `: ` with nothing after (edge) [src/query/stats.ts:137]
- [x] [Review][Patch] **LOW** D2 spec sentence claims a rowid tiebreak across keys; actual rule is preferred-key-wins on cross-key tie, rowid within a key — unpinned (auditor) [story D2]
- [x] [Review][Patch] **LOW** README example abridged with no elision marker (auditor) [README.md]
- [x] [Review][Patch] **LOW** File List omits sprint-status.yaml; "Current Model line" is actually the intro paragraph (auditor) [story]
- [x] [Review][Patch] **LOW** Ratio comment claims unconditional exactness; holds only ≤ 2^53 (edge) [src/query/stats.ts:82]
- [x] [Review][Defer] **LOW** IN-list past SQLITE_MAX_VARIABLE_NUMBER (32766) would throw — unreachable at depth-2 session trees, sole caller passes one primary's tree (edge) [src/db/store.ts getSessionLedgerTotals] — deferred, structurally unreachable today

## Previous-story intelligence (3.5 + its reconciliation, 2d2b2e4)

- **Report only what is verified, and reconcile before recommending.** 3.5's
  first completion report claimed a two-part fix with one part done. Every
  claim in this story's completion notes must name its evidence (test,
  measurement, or commit), and the review pass is not done until all three
  layers' findings are reconciled — not when the suite is green.
- **A test that asserts nothing is worse than no test** — two 3.5 fixes
  shipped untested and one "test" asserted nothing; the mutation campaign is
  what caught all three. 6/6 killed is the bar, with each mutation proven
  applied.
- `getTotalTokens` returns `{spent, saved, unrealized, estimated}` — `spent`
  is the *field name* for injected rows (kept so existing readers compile).
  Do not re-rename it in this story; new methods use `injected` naming and a
  doc comment states the mapping once.
- The evidence guard is a shape check at one door; the GC rollup bypasses it
  by design and carries evidence forward in aggregate. Stats must therefore
  never assume a `saved` row has evidence columns populated (rollups have
  `(N rolled up)` refs; pre-migration rows may be `estimated`).
- Windows facts that already burned this epic: no literal control bytes in
  source, ever (escaped classes only); `os.tmpdir()` never `/tmp`; POSIX
  tools in tests via `tests/posix-tools.ts` if any are needed (none should
  be); `Number` never `parseInt` for anything numeric from env or CLI.
- `npm run lint` does not typecheck `tests/` — read test code as if the
  compiler will not catch you, because it will not.

## Verification

- `npm run build`, `npm run lint`, `npx vitest run`, `npm run gate` (no
  retrieval surface changes expected — the gate must pass **untouched**; a
  baseline regeneration in this story would be a red flag, not a fix)
- `cortex doctor` (built), and `cortex stats` on the live store before/after,
  both outputs recorded in the completion notes
- Mutation campaign per Task 7
- B-6: in-process p95 pinned by test; CLI end-to-end measured and recorded
  with the spawn floor beside it

## Dev Agent Record

### Agent Model Used

claude-fable-5 (Fable 5)

### Completion Notes

**AC #1 — session + scope.** The session block resolves the most recent
primary across the working scope keys (never active-only — the FR-7 wall) and
totals its tree via `getSessionTreeIds`, rendering `(incl. subagents)` only
when a child contributed tokens. Scope cumulative joins `token_ledger` through
`sessions` on the working keys; a roll-up-then-retotal test pins that GC
cannot leak tokens out of the view. Evidence: tests "resolves the most recent
primary…", "picks the newest primary across both working scope keys",
"includes child-session rows…", "scope totals survive a GC rollup".

**AC #1 — ratio.** `saved / injected` floored to hundredths with integer math
(`Math.floor((saved * 100) / injected) / 100`); `—` when injected is 0;
`Efficiency` retired (verified: no existing test pinned it). Evidence: "is
floored, never rounded up", "has no value when nothing was injected".

**AC #2 — retrieval health.** Store-wide (FR-21 operator convention): counts
across all five states, never-retrieved = `access_count = 0`, top ten
`access_count > 0` with printed criterion and `access_count DESC,
last_accessed_at DESC, rowid DESC`. Lines collapse control chars/newlines,
truncate at 100 chars, and re-attach `[contested]`/`(superseded)` after
truncation via the canonical helpers. Evidence: six retrieval-health tests +
three rendering-discipline tests.

**AC #3 — unrealized distinct.** Rendered in both blocks when non-zero,
absent at zero, excluded from ratio and net. Evidence: "is reported
distinctly in both blocks", "excludes unrealized and estimated…".

**AC #4 — B-6, measured not asserted.** In-process build+render on a
10,000-item store with a populated ledger: **median 2.2 ms, p95 2.7 ms**
(50 runs; the test pins p95 ≤ 200 ms with the seeded shape pre-asserted).
`cortex stats` CLI end-to-end on the live store: **435–454 ms** against a
**54–91 ms** bare-`node -e 0` floor — the same process floor 3.3 measured at
532–573 ms for read-ledger. The CLI number is recorded in CLAUDE.md and here;
it is NOT claimed as within B-6.

**Mutation campaign.** 21 mutations across dev + review rounds, each proven
applied (anchor-verified, byte-identical restore): **20/20 killable killed**,
1 measured-equivalent surviving as asserted. Dev-round survivors that taught
something: (1) the top-10 zero-count filter was unobservable with ≥10
retrieved rows seeded (LIMIT hid the mutation) — fixture now leaves slots to
spare; (2) the cross-scope-key comparison in `resolveCurrentPrimary` was
unobservable with one scope key — a two-key test added; (3) `IN ()` is
**accepted** by SQLite 3.51.3 (measured; my comment claiming syntax error was
false and is corrected) — an equivalent mutant, now pinned by an in-tree test
that executes the raw `IN ()` clause (the durable artifact; a dev-time
campaign script is not one, which the first version of these notes wrongly
implied). Review-round survivor: (4) **M17** — dropping `session_id` from the
GC rollup's GROUP BY survived the whole suite, because every rollup fixture
in the repo seeds ONE session and SQLite's bare-column pick then returns the
only session there is; the stats rollup test now seeds a second session in a
foreign scope, and the mutation dies.

**Also caught during dev:** two literal ESC bytes landed in test source and a
literal NUL/US/DEL range landed in the collapse regex — both the exact defect
class this repo documents — found by byte-scan before any commit and repaired
to the six-character escape sequences (backslash-u001b and the
backslash-u0000 to backslash-u001F class). All nine touched files
byte-scanned clean before commit.

**Live verification:** gate 9/9 suites ok untouched (no baseline changes);
`cortex doctor` 16/16 (1 pre-existing warning); live `cortex stats` output
recorded in the README example. Before-state (3.5): store-wide
`Injected/Saved/Net/Efficiency` flat list. After: session block (111 injected
— this session), scope block (16k injected over 2 keys, 558.9k estimated
rendered-not-counted), 4767 items / 4614 never retrieved / top-10 with
timestamps.

**Review round (three layers, 2026-08-02).** 19 patch / 1 defer / 0 dismissed
/ 0 decision-needed; all 19 patches applied and re-verified. The substantive
ones: the rollup test's firing condition is now explicit (`ledgerDays: 14`)
with the rollup pre-asserted (found independently by all three layers); the
unbacked "campaign asserts it survives" claim replaced by the in-tree raw
`IN ()` test; NULL-scope/orphaned ledger rows now render as an
`Unattributed:` line instead of vanishing (measured 0 on this store — the
scope/store-wide gap is other branches, verified: main holds 93.4k);
`getMostRetrievedMemoryItems` clamps its limit; top-10 lines carry the item
id (the `inspect-memory` handle); the D8 snapshot covers
`memory_references`/`current_app_graphs`; positive render assertions for
`started …`/`(incl. subagents)`; surrogate-safe truncation; `(no text)`
placeholder; full criterion printed with tiebreakers; p95 is nearest-rank
(was p100); stale CLI description fixed; D2's cross-key-tie sentence
corrected and pinned by test. Deferred (1): the >32766-session IN-list,
structurally unreachable at depth-2 trees.

Verification (final): `npm run build` ✓, `npm run lint` ✓, `npx vitest run`
**1365 passed / 1 skipped** (+34 from this story), `npm run gate` 9 suites ok
untouched, `cortex doctor` 16/16 (1 pre-existing warning), live `cortex
stats` re-recorded in the README (abridgment now marked).

### File List

- `src/db/store.ts` — modified: `LedgerDirectionTotals`,
  `SessionLedgerTotalRow`, `LEDGER_DIRECTIONS` (now exported),
  `foldLedgerDirectionTotals`, `getSessionLedgerTotals`,
  `getScopeTokenTotals`, `getUnattributedTokenTotals`,
  `getMemoryItemStateCounts`, `countNeverRetrievedMemoryItems`,
  `getMostRetrievedMemoryItems` (clamped) — FR-9 reporting reads section
- `src/query/stats.ts` — new: `buildStatsReport`, `renderStatsReport`,
  `MOST_RETRIEVED_LIMIT`, `STATS_ITEM_TEXT_MAX`, report types; unattributed
  line, id handles, surrogate-safe truncation, full printed criterion
- `src/transports/cli.ts` — modified: stats action open → build → render;
  Efficiency block removed; command description updated
- `src/index.ts` — modified: re-exports for the new symbols/types
- `tests/stats.test.ts` — new: 34 tests
- `README.md` — modified: `### The P&L` section (abridgment marked), intro
  economy bullet
- `CLAUDE.md` — modified: seven FR-9 invariant bullets (two extended at
  review), Core Files entry, the intro paragraph above `## Current Model`,
  `Saved: 0` bullet updated
- `_bmad-output/project-context.md` — modified: Dormant Surface paragraph
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified:
  3-4/3-5 marked done (stale), 3-6 lifecycle, new 4.5-binding action item
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified: one
  deferred finding appended
