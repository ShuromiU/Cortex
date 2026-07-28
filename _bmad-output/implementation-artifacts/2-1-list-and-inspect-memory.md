---
baseline_commit: f79b19a
---

# Story 2.1: List and inspect memory

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who does not trust what they cannot see,
I want to list and inspect stored memory,
So that I can verify what Cortex actually holds.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.1 (lines 373-386). Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** a store with memory items across several scopes and kinds
   **When** the listing command runs with scope, kind, and state filters
   **Then** it returns matching items with ids, ordered by a stated criterion
   **And** output is paginated and never dumps the whole store.

2. **Given** a memory item id
   **When** the inspect command runs
   **Then** it shows the full text, extracted references, trust label, conflict status, and access history.

3. **Given** an id that does not exist
   **When** inspect runs
   **Then** it reports that clearly and exits non-zero.

### AC assessment — all three are buildable as written; nothing is already true

Unlike 1.4, no clause here is a behavior reversal and none is already satisfied. This is a **new read-only surface** assembled from parts that all exist. The assessment worth recording is about what "trust label" and "conflict status" *mean* in AC #2, because both acquired real semantics in Epic 1 that postdate this epic's planning:

- **"trust label"** already exists and is named: `describeValidity` (`src/query/render.ts:287`) returns exactly the one-word summary that `recall`'s lead line prints — `refs OK` · `stale refs` · `refs moved` · `refs unverified` · `no file refs`. **Reuse it. Do not invent a second vocabulary**, and do not edit `render.ts` to make reuse convenient (see § Zero-delta).
- **"conflict status"** is now four distinct facts, not one: the `notes.conflict` column, the `[contested]` pair relationship, the `(superseded)`/`(resolved)` status, and the hotness tier. Inspect surfaces **what exists**; it invents no new state.

**AC #1's `scope` filter is not "the current scope".** The AC names a store holding items *across several scopes* and asks for a filter. Default (no `--scope`) therefore lists **all** scopes — this is an inspection tool for a user who does not trust what they cannot see, and a default that silently hides other branches' memory would defeat its purpose. Same reasoning applies to `state`: **the default includes `archived`.** Every other query surface in this repo excludes archived by SQL; this one must not, or the tool lies by omission about what the store holds.

## The design — read this before any code

### Where the code goes (layer direction is not negotiable)

`transports/` → `query/` → `memory/` + `scope/` → `db/`. Three edits, in that direction:

| Layer | File | Adds |
| --- | --- | --- |
| `db/` | `src/db/store.ts` | `listMemoryItemsFiltered`, `countMemoryItemsFiltered`, `getRetrievalLogsForItem` |
| `query/` | `src/query/inspect.ts` **(new)** | `listMemory`, `inspectMemory`, `resolvePageLimit` — pure, return structures, render nothing |
| `transports/` | `src/transports/cli.ts` | `list-memory`, `inspect-memory` — render the structures, own exit codes |

New module ⇒ new test file: `tests/inspect.test.ts` (repo rule: one test file per module, named after it). CLI-level tests extend `tests/cli.test.ts`; store-level tests extend `tests/store.test.ts`.

The query layer returning a **structure** and the transport rendering it is what makes `--json` nearly free — and `--json` is what lets tests assert exact values instead of scraping prose. Build it in this order, not the reverse.

### Naming

`cortex list-memory` and `cortex inspect-memory <id>`, matching the existing flat `validate-memory` / `suggest-notes` / `note-resolve` convention. Not a `memory` subcommand group — `log read` is the only nested group and it exists for a different reason.

### Store methods

**`listMemoryItemsFiltered(filter)` / `countMemoryItemsFiltered(filter)`** — share one private WHERE builder so the count can never describe a different set than the page. Filters: `scopeKeys?: string[]`, `kinds?: string[]`, `states?: string[]`, plus `limit`/`offset` on the list method only. Each absent filter contributes no clause. Empty-array-vs-undefined must be decided and pinned: an explicitly empty array means "match nothing", `undefined` means "no filter" — the CLI never produces the former, but the library API can, and a silent reinterpretation is how a filter tool starts lying.

Order: `created_at DESC, rowid DESC` — the same criterion `listMemoryItemsByScopes` already uses. `rowid DESC` is the tiebreaker that makes pagination stable when timestamps collide, which they do: seeded and same-transaction items share `created_at` to the millisecond. **Without a total order, offset pagination silently repeats and skips rows.** This is the single most likely correctness bug in AC #1 and it must be tested with same-timestamp fixtures, not merely reasoned about.

**Do not modify `listMemoryItemsByScopes`.** It has callers, it hard-excludes `archived`, and this story needs the opposite default.

**`getRetrievalLogsForItem(memoryItemId, limit)`** — `retrieval_log.result_ids_json` is a JSON array. Query it with JSON1:

```sql
SELECT * FROM retrieval_log
 WHERE EXISTS (SELECT 1 FROM json_each(retrieval_log.result_ids_json) WHERE value = ?)
 ORDER BY created_at DESC, rowid DESC LIMIT ?
```

**Not `LIKE '%' || id || '%'`.** Verified empirically on this checkout (SQLite 3.51.3, JSON1 available): with ids `x2` and `x2x` seeded, `json_each` returns 1 row and `LIKE` returns 2. Substring matching over an id list is the same defect class Epic 1 spent three stories hardening against in `isContested` / `renderedAlternatives` / `isSupersededMemoryItem`; do not reintroduce it in SQL. `json_each` is a hermetic, exact join and costs nothing at this scale.

### `src/query/inspect.ts`

```ts
export interface MemoryListFilter { scopeKeys?: string[]; kinds?: string[]; states?: string[]; limit?: number; offset?: number }
export interface MemoryListPage { items: ParsedMemoryItem[]; total: number; limit: number; offset: number; order: string; filter: {...} }
export function resolvePageLimit(raw: number | undefined): number   // clamp
export function listMemory(store, filter): MemoryListPage
export function inspectMemory(store, id): MemoryInspection | null
```

**`resolvePageLimit` is the AC #1 "never dumps the whole store" guarantee and must be a separately-tested pure function.** Default 20, hard cap 200, floor 1. Non-finite / `NaN` / negative / zero all fall back to the default — `parseInt('abc')` is `NaN` and Commander hands through raw strings. A cap that lives inline in the CLI action is a cap that cannot be tested across its boundary values.

`MemoryInspection` carries, per AC #2:

- **full text** — `item.text` **verbatim and untruncated**. Every other surface in this repo truncates; this one must not. `renderMemorySnippet` has no business here.
- **references** — `validateMemoryReferences(store, item)` gives per-reference `raw_reference`, `normalized_path`, `status` (`exists|missing|moved|unknown|external`) and `moved_to`.
- **trust label** — attach the validation to the item and call `describeValidity`:
  ```ts
  const validation = validateMemoryReferences(store, item);
  const trust = describeValidity({ ...item, reference_validation: validation });
  ```
  `describeValidity` reads `item.reference_validation`; attaching it is how `recall` already feeds it. No new logic, no edit to `render.ts`.
- **conflict status** — four facts, and inspect is the **only** surface that can read the first one directly:
  1. `notes.conflict` and `notes.status`, authoritative, via `source_table === 'notes'` → `store.getNote(source_id)`.
  2. the projected reading every *other* surface uses: `isContested(item)`, `isSupersededMemoryItem(item)`.
  3. **divergence between 1 and 2 is itself a finding and must be reported**, not silently resolved in favor of either. Epic 1's review rounds found three separate ways for projected text to disagree with the column; this command is where a user would go to see that, and it is free to surface.
  4. counterparts: for a contested note, `store.getActiveNotesBySubject(subject)`, excluding self, filtered to the same scope via `store.getScopeKeyForNote(note.id)` — **detection is scope-keyed, so the counterpart lookup must be too.** `getActiveNotesBySubject` is not scope-filtered; filter in the query layer. Also carry `notes.alternatives` (already parsed to `string[] | null` on `ParsedNote`).
- **access history** — two sources with different durability, and the difference must be stated in the output:
  - durable: `access_count`, `last_accessed_at` on the item.
  - per-retrieval: `getRetrievalLogsForItem` → timestamp, topic, session id.
  - **`retrieval_log` is pruned by `cortex gc`** (`src/db/gc.ts:110` keeps only the most recent N rows), so the per-retrieval list is bounded and lossy while `access_count` is not. A user reading "3 retrievals" next to "access count 47" will otherwise file a bug. One line of output prevents it.

**Id resolution.** Look up `getMemoryItem(id)` first; on a miss, fall back to `getMemoryItemBySource('notes', id)` so a note id pasted from `cortex_note`'s output resolves. A genuinely unknown id misses both and takes the AC #3 path. Pin both branches.

### CLI contract

```
cortex list-memory [--scope <keys>] [--kind <kinds>] [--state <states>] [--limit <n>] [--offset <n>] [--json]
cortex inspect-memory <id> [--json]
```

Comma-separated multi-values, parsed with the existing `parseTopics` splitter pattern (trim, drop empties) — reuse it rather than writing a third splitter.

**AC #1 requires the ordering criterion to be *stated*, not merely implemented.** The header line says it:

```
memory items 1-20 of 137 · newest first (created_at DESC) · filters: kind=note:decision state=hot,warm
next page: cortex list-memory --offset 20 ...
```

The `next page:` line appears only when `offset + items.length < total`. Each item line leads with the **id** (AC #1) and stays one line.

**Exit codes: `process.exitCode = 1`, never `process.exit(1)`.** `note-resolve` (`cli.ts:502`) is the pattern to copy; `status` (`cli.ts:342`) is the one to avoid — `process.exit` inside a vitest worker kills the run. The AC #3 message goes to **stderr** and names the id. `--json` does **not** change the exit code: a missing id exits non-zero in both modes, because a script piping `--json` is precisely the caller that must not read "not found" as success. Decide and pin whether `--json` emits an error object or nothing on that path; either is defensible, silently emitting valid-looking empty JSON with exit 0 is not.

Empty sections render as an explicit "none", never as a blank or `undefined`: an item with no references, no retrieval-log entries, or no conflict is the common case, and "no file refs" already exists as the trust vocabulary for exactly that.

### What deliberately does NOT change

- **`src/query/render.ts` is read-only in this story.** Import from it; do not refactor it to share code with inspect. See § Zero-delta.
- No new `memory_items` kind ⇒ **AD-5 does not apply**, no new locked fixture required.
- No schema change, no `SCHEMA_VERSION` bump, no migration. Read-only surface.
- **No new MCP tool.** ARCHITECTURE-SPINE line 287 binds FR-21..FR-26 to `transports/cli.ts`, and both ACs say "command". `CLAUDE.md`'s tool list therefore does **not** change. If a later story wants `cortex_inspect` for agents, the pure functions are already shaped for it.
- No `--order` flag. AC #1 asks for *a* stated criterion, singular. One order, stated, tested.
- Use `openCortexDb(process.cwd())` like every other command. Do not hardcode a db path — Story 2.5 relocates the store and must not have to touch this command.

### Zero-delta on the eval gate — expected, and one specific way it could break

All 8 locked suites must show **zero delta**: `alternatives=237 · budget=178 · contested=117 · kind-ordering=103 · rename-moved=97 · stale-label=164 · stemming=93 · superseded-history=192`. The gate's `output_tokens` metric reads `recall()` only, and this story adds a surface `recall()` never calls.

There is exactly one path to a delta: **editing `src/query/render.ts`** (or `state.ts`, `recall.ts`, `retrieval.ts`) to make reuse tidier. If any suite moves, do not regenerate — find out why. Baselines are locked artifacts changed only via `cortex eval-gate --regenerate-baseline <suite>` with a `Baseline-Regenerated: <reason>` commit-body line, and **regenerating is never how a red gate goes green.**

A second, quieter risk: `inspectMemory` calls `validateMemoryReferences`, which **writes** — `ReferenceValidator.flush()` persists recomputed `memory_references.status` rows. Inspect is "read-only" from the user's point of view, not the database's. That is the same thing `recall` already does and is fine; just do not be surprised by it, and do not add a second write (no `touchMemoryItems` — **inspecting memory must not reheat it**, or the tool changes the ranking it exists to reveal).

## Tasks / Subtasks

- [x] **Task 1 — Store query surface** (AC: #1, #2)
  - [x] `listMemoryItemsFiltered` + `countMemoryItemsFiltered` over one shared WHERE builder; `undefined` = no filter, `[]` = match nothing; order `created_at DESC, rowid DESC`.
  - [x] `getRetrievalLogsForItem` via `json_each`, newest first, limited.
  - [x] Tests (`tests/store.test.ts`): each filter alone and in combination; `archived` included when unfiltered; **same-`created_at` fixtures paginated across two pages with zero overlap and zero omission** (the stability bug); count agrees with the unfiltered length; `json_each` returns the exact id and **not** a superstring id (seed `<uuid>` and `<uuid>x` — this assertion is the whole reason the method isn't a `LIKE`).

- [x] **Task 2 — `src/query/inspect.ts`** (AC: #1, #2, #3)
  - [x] `resolvePageLimit`: default 20, cap 200, floor 1, non-finite/NaN/≤0 → default. Table-driven test across every boundary.
  - [x] `listMemory` → `MemoryListPage` including `total`, `order`, and the resolved filter.
  - [x] `inspectMemory` → full text verbatim, references, trust label via `describeValidity`, conflict block (column + projection + divergence flag + scoped counterparts + alternatives), access history (durable counters + retrieval-log entries), `null` on miss.
  - [x] Export everything new from `src/index.ts` (repo rule: exhaustive hand-maintained list; type-only exports marked, `isolatedModules`).
  - [x] Tests (`tests/inspect.test.ts`): a **contested pair** — both sides report `conflict: true`, each names the other as counterpart, and a same-subject note in a *different scope* is **not** listed; a **superseded** item reports status superseded; a **divergence fixture** — a note whose `content` embeds a `Conflict: true` line while `notes.conflict = 0` — reports the column as authoritative *and* flags the disagreement; trust label for each of `refs OK` / `stale refs` / `refs moved` / `no file refs`; full text with 20 lines comes back with all 20; note-id fallback resolves; unknown id → `null`.

- [x] **Task 3 — CLI commands** (AC: #1, #2, #3)
  - [x] `list-memory` and `inspect-memory` wired to the pure functions; text renderer + `--json`; header states the order and window; `next page:` only when more remain.
  - [x] AC #3: stderr message naming the id, `process.exitCode = 1`.
  - [x] Tests (`tests/cli.test.ts`) — **run the commands; do not assert they are registered.** Seed a real `.cortex.db` in an `os.tmpdir()` mkdtemp root, `process.chdir` to it, capture `process.stdout`/`process.stderr` (existing `inject-header` tests show the spy pattern), then:
    - 25 seeded items, default limit → **exactly 20 item lines**, header says `of 25`, `next page:` present. Re-run with `--offset 20` → the remaining 5, no `next page:`.
    - `--limit 9999` → still ≤ 200 (assert against the rendered/JSON `limit`, since seeding 200 is wasteful — the boundary itself is Task 2's table test).
    - scope, kind and state filters each narrow the result to a pre-asserted expected id set; the **pre-assertion that the unfiltered listing contains the excluded ids** is what makes the filter test adversarial rather than vacuous.
    - inspect renders all five AC #2 elements — assert on `--json` fields, not prose.
    - unknown id → non-zero `process.exitCode`, message on **stderr**, nothing on stdout. **Reset `process.exitCode = 0` in the test's `finally`** or the whole vitest run inherits a failing exit code.

- [x] **Task 4 — Verification, mutation, docs**
  - [x] `npm run build && npm run lint && npx vitest run` — baseline **749 tests / 28 files green at `f79b19a`**; then `npm run gate` — **8 suites, zero delta**, numbers above.
  - [x] Mutation-test every new assertion, break → red → restore, and **prove each mutation applied** (mutate `src/`, never `dist/` — vitest imports `src/`; working files are CRLF, so anchors must be EOL-adaptive; a campaign that silently applies nothing reports a perfect score). Minimum set: pagination tiebreaker dropped (`rowid DESC` removed) · limit cap removed · limit floor/NaN fallback removed · a filter clause dropped · `json_each` swapped for `LIKE` · counterpart scope filter dropped · text truncated · conflict read from projection only · divergence flag suppressed · exit code left 0 · stderr written to stdout.
  - [x] `README.md`: both commands in § CLI Commands, plus a short section describing what inspect shows and the retrieval-log pruning caveat. `CLAUDE.md`: § Core Files gains `src/query/inspect.ts`; § Expected Behavior gains the list/inspect contract (default order stated, all-scopes/all-states default, hard page cap, exit non-zero on unknown id, inspect never reheats). **Same commit as the behavior. Every doc sentence is an assertion — verify each one against the code the way you verify a test.**
  - [x] Stage `CLAUDE.md` **surgically** — rebuild the blob from `HEAD:CLAUDE.md` plus only this story's hunks (`git hash-object -w --stdin` + `git update-index --cacheinfo`), or stage by explicit hunk. **Never `git add CLAUDE.md` wholesale**: the working copy carries the user's own unstaged "Agent Tooling" edits. `.mcp.json` stays unstaged; `.serena/` stays untracked. Verify the staged hunk count matches the intended count before committing.

## Dev Notes

### Files touched

| File | Change |
| --- | --- |
| `src/db/store.ts` | three query methods, one shared WHERE builder |
| `src/query/inspect.ts` | **new** — `listMemory`, `inspectMemory`, `resolvePageLimit` |
| `src/transports/cli.ts` | `list-memory`, `inspect-memory` |
| `src/index.ts` | exports |
| `tests/inspect.test.ts` | **new** |
| `tests/store.test.ts`, `tests/cli.test.ts` | extended |
| `README.md`, `CLAUDE.md` | docs, same commit |

### Traps, carried forward from Epic 1's five review rounds

- **Don't assert a property; test it.** This was named in 1.2's review and recurred in 1.3 and 1.4 anyway — it is the epic's #1 defect class. **`tests/cli.test.ts` is currently 239 lines of exactly this anti-pattern**: nearly every test is `expect(commandNames).toContain('x')`, which passes for a command whose action throws on every input. Following local convention here reproduces the defect on arrival. New CLI tests invoke the action and assert output, exit code and store effects.
- **Fixtures must be genuinely adversarial.** Pre-assert the precondition inside the test (the unfiltered listing *does* contain the ids the filter must exclude; the divergence fixture's column *is* 0 while its text *does* carry the line), so the test fails loudly when it stops testing anything.
- **Prove every mutation applied.** 1.3 patched `dist/` while vitest imported `src/`; 1.4 used LF anchors against CRLF files and 6 of 12 mutations never applied — both campaigns reported all-clear.
- **Enumerate output surfaces, not renderer call sites.** Here that is small but real: `list-memory` text, `list-memory --json`, `inspect-memory` text, `inspect-memory --json`. A field added to the structure and rendered in only one of the four is the same class of miss.
- **Doc claims are code.** 1.4 shipped three false sentences ("ranked below the current one", "never gets budget priority", "fails the build"). Every sentence written into `README.md`/`CLAUDE.md` in Task 4 gets verified like an assertion.
- **Every Epic 1 story needed a repair round.** Plan build → review → repair, not build → review.
- `npm run lint` does **not** typecheck `tests/` (`tsconfig.json` excludes it) — the compiler will not catch type errors there. Import specifiers end in `.js`. Temp dirs via `os.tmpdir()`, never a literal `/tmp`. Store fixture: `new Database(':memory:')` → `db.pragma('foreign_keys = ON')` → `applySchema` → `initializeMeta` → `new CortexStore(db)`.

### Scope boundary

Two retrospective action items name Story **2.2**, not this one, and must not be pulled forward: the CLI resolve defects (`note-resolve` never clears conflicts; `--subject` ambiguity), and contested-pair deletion semantics. Nothing in 2.1 depends on either. 2.1 is read-only — it neither edits nor deletes.

### References

- [Source: `epics.md:373-386`] — ACs verbatim. [Source: `prd.md:349-356`] — FR-21's three testable consequences. [Source: `ARCHITECTURE-SPINE.md:287`] — FR-21..FR-26 → `transports/cli.ts`. [Source: `src/query/render.ts:287`] — `describeValidity`, the existing trust label. [Source: `src/db/gc.ts:110`] — retrieval-log pruning, the access-history caveat. [Source: `src/db/store.ts:1752`] — `getActiveNotesBySubject` is not scope-filtered. [Source: `epic-1-retro-2026-07-27.md`] — recurring defect classes carried into Task 4's mutation list. [Source: `deferred-work.md`] — 2.2-owned items held out of scope.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

**Mutation testing** (`scratchpad/mutate-2-1.mjs`, 28 mutations against the three touched test files): **28/28 killed, 0 never applied.** The harness proves application twice — anchor present, then bytes on disk changed — and normalises anchors to each file's own line endings, which matters because this repo is **mixed**, not uniformly CRLF: `src/db/store.ts` and `src/transports/cli.ts` are CRLF, `src/query/inspect.ts` and every file under `tests/` are LF. A campaign assuming either one globally would silently apply nothing to half the surface.

**The first run was 24/28, and all four survivors were real.** Three were test defects, one was a harness defect, and none was an equivalent mutant:

1. **`rowid DESC` removed — survived.** The pagination test asserted only that three pages *union* to the full set, which holds under any stable order, and SQLite happened to stay stable. Probed directly: with ten identical `created_at` values, `ORDER BY created_at DESC, rowid DESC` returns `p9..p6` and the same query without the tiebreaker returns `p0..p2` — the order is observable, the test just never looked. Now asserted page by page. This is the epic's recurring failure mode (asserting a property instead of testing it) reproduced once more, and caught only because the mutation existed.
2. **Counterpart scope filter dropped — survived.** The cross-scope fixture's foreign note contradicted nothing in its own scope, so its `conflict` flag was `false` and the *conflict* filter already excluded it; the scope filter was never exercised. The story had specified "only the scope filter can keep it out" and the fixture did not deliver it. Rebuilt after probing a live store: the foreign scope now holds its own contested pair (both `conflict = 1`), so only scope can exclude them.
3. **Counterparts include uncontested same-subject notes — survived.** No fixture had an active, same-subject, *uncontested* note. Added a `blocker` on the same subject, verified by probe to land `conflict = false` (blockers do not contest decisions), so the conflict filter is now the only thing excluding it.
4. **"unknown id exits zero" — survived, and the code was innocent.** `process.exitCode = 1;` occurs four times in `cli.ts` and `String.replace` takes the first, which is `note-resolve`. The mutation applied — the file changed, the harness's proof passed — but it applied *to the wrong call site*, and nothing covers `note-resolve`'s exit code. **Proving a mutation applied is not sufficient; it must be proven to apply where it was aimed.** Anchor re-cut against inspect-specific context. This extends Epic 1's action item 4 rather than repeating it.

Second run after the three test fixes and the anchor re-cut: 28/28.

**Two defects were found by reading real output rather than by any test.** Running both commands against a seeded temp store showed the counterpart line printing a raw ISO timestamp (`2026-07-28T03:37:37.164Z`) while every other timestamp in the same output used the repo's compact `YYYY-MM-DD HH:mmZ` form — a violation of a stated convention in `project-context.md` that no assertion covered. Fixed and pinned, including a negative assertion that the raw form does not reappear.

**`npm run lint` caught what 25 passing tests could not.** `describeValidity({ ...item, reference_validation })` ran correctly but did not typecheck, because `reference_validation` is not on `ParsedMemoryItem` — the renderer reads it through an internal cast. Vitest transpiles without typechecking, so the tests were green against code the compiler rejected. Resolved by annotating the intersection rather than casting.

**Empirical probes, run before writing the behavior rather than after:**
- `json_each` availability and exactness (SQLite 3.51.3): with `x2` and `x2x` seeded, `json_each` matches one row, `LIKE '%x2%'` matches two.
- `json_each` over a **malformed** `result_ids_json` **raises, and the raise aborts the entire query** rather than skipping the row — so one bad row would make access history unreadable for every item in the store. `json_valid()` guards NULL and malformed alike (`json_valid(NULL)` is NULL, hence falsy). The guard is load-bearing and is pinned by its own test.
- `LIMIT -1` returns **all 50** seeded rows (SQLite reads negative as "no limit"); `LIMIT NaN` **throws** a datatype mismatch. These fail differently, which is why `resolvePageLimit` guards both — and why a first draft of the CLAUDE.md sentence describing them was **wrong** and corrected before commit.

### Completion Notes List

**AC #1 — listing.** `list-memory` filters by scope, kind and state (comma-separated, combinable), returns items led by their ids, states its ordering criterion in the header rather than leaving it implicit, and pages. Two defaults deliberately invert the repo-wide convention: **no state filter, so `archived` is listed, and no scope filter, so other branches are visible.** Every other query surface excludes archived by SQL; a tool whose purpose is "verify what Cortex actually holds" cannot. `listMemoryItemsByScopes` was left untouched for exactly this reason — it has callers that want the opposite.

"Never dumps the whole store" is a property of `resolvePageLimit`, not of its callers: 20 default, **200 hard cap regardless of what is passed**, with non-finite, zero and negative all falling back. It is a separately exported pure function precisely so the boundary values are testable, and the CLI-level test proves the cap survives the transport.

**AC #2 — inspection.** All five elements, in both text and `--json`: full text **verbatim and untruncated**, per-reference status with move destinations, the trust label (`describeValidity`, reused rather than reinvented — it is the same string `recall`'s lead line prints), conflict status, and access history.

The design decision worth recording: **inspect is the only surface that reads `notes.conflict` directly.** Every other renderer recovers the flag from the projected `Conflict: true` line because `ParsedMemoryItem` has no such column — the constraint Epic 1 documented three times over. Inspect has the id, so it joins through `source_table='notes'` to the column itself, and reports the column, the projection, **and `diverged` when they disagree**, rather than silently preferring either. That drift is invisible on every other surface, and Epic 1's reviews found three separate ways to produce it. Counterparts are filtered to contested notes in the same scope, because detection is scope-keyed while `getActiveNotesBySubject` is not.

Access history has two halves with different durability and the output says so: `access_count` is durable, the per-retrieval list comes from `retrieval_log`, which `cortex gc` trims. Without that line, "3 retrievals" beside "access count 47" reads as a bug.

**AC #3 — missing id.** Message on **stderr** naming the id, `process.exitCode = 1` (never `process.exit`, which would kill the vitest worker), and non-zero in `--json` mode too — a caller piping JSON is precisely the one that must not read "not found" as success. The test resets `process.exitCode` in a `finally`, since a leaked non-zero code fails the entire run rather than one test.

**Beyond the ACs, and deliberately:** neither command creates a session and neither calls `touchMemoryItems` — a tool for revealing what ranking holds must not change that ranking by being used. Both are pinned by tests. `inspect-memory` does refresh the current app graph and persist corrected reference statuses, exactly as the retrieval path does; that is repair of derived truth, not reinforcement, and it is what makes the trust label describe the checkout as it is now.

**Zero delta on all 8 locked suites**, as predicted: `alternatives=237 · budget=178 · contested=117 · kind-ordering=103 · rename-moved=97 · stale-label=164 · stemming=93 · superseded-history=192`. `src/query/render.ts` was imported from and never edited, which was the one identified path to a delta. No new `memory_items` kind, so AD-5 is not triggered; no schema change, no `SCHEMA_VERSION` bump.

**No new MCP tool**, so `CLAUDE.md`'s tool list is unchanged. ARCHITECTURE-SPINE:287 binds FR-21..FR-26 to `transports/cli.ts` and both ACs say "command". The pure functions are shaped so a later story could expose `cortex_inspect` without rework.

**Local test convention deliberately not followed.** `tests/cli.test.ts` was 239 lines of `expect(commandNames).toContain('x')` — assertions that a command is *registered*, which pass for a command whose action throws on every input. That is the defect class Epic 1's retrospective named as its worst recurring pattern. The 16 new CLI tests seed a real `.cortex.db` in an `os.tmpdir()` root, run the command, and assert stdout, stderr, exit code and store state. The pre-existing registration tests were left alone: rewriting them is not this story's scope.

**Scope held.** The two retrospective action items targeting Story 2.2 (the CLI resolve defects; contested-pair deletion semantics) were not pulled forward. This story neither edits nor deletes.

### File List

- `src/db/store.ts` — modified; `MemoryItemFilter`/`ListMemoryItemsOpts`, `buildMemoryItemFilterClause`, `listMemoryItemsFiltered`, `countMemoryItemsFiltered`, `getRetrievalLogsForItem`
- `src/query/inspect.ts` — new; paging clamps, `listMemory`, `inspectMemory` and its conflict/access/trust assembly
- `src/transports/cli.ts` — modified; `list-memory` and `inspect-memory` commands plus their renderers and option parsing
- `src/index.ts` — modified; public exports for the new query module and the two new store types
- `tests/inspect.test.ts` — new; 25 tests over the paging clamps, listing and inspection
- `tests/store.test.ts` — modified; +11 tests over filtering, ordering, pagination stability and the retrieval-log join
- `tests/cli.test.ts` — modified; +16 tests that run the commands against a seeded temp store
- `README.md` — modified; both commands in § CLI Commands, new § "Inspecting what Cortex holds"
- `CLAUDE.md` — modified; `src/query/inspect.ts` in § Core Files, five § Expected Behavior bullets
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified; epic-2 in-progress, story 2.1 review

## Senior Developer Review (AI)

**Reviewed:** `b4c5f7f` vs `f79b19a` · three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) · 2026-07-28
**Outcome:** Changes Requested → addressed in the repair round below.

The Auditor's verdict on the ACs was clean, verified by driving the built CLI against its own seeded stores: all three ACs met, all numeric claims true (801/29, eight suites at the exact stated values, +52 tests), no writes on either command, and the surgical staging confirmed intact. The two hunters found the defects where the story stopped looking — and the Auditor found the one that mattered most, which was in the verification rather than the code.

### The through-line

**I imported the authoritative column and left its discipline behind.** `notes.alternatives` is the real column, and reading it directly was the right call — but `renderedAlternatives` exists on every other surface precisely because `buildNoteMemoryText` collapses whitespace first, and the story's own design section quotes that guard while specifying the bypass. Rendering the column raw let an alternative containing a newline emit extra lines *inside the conflict section*: a note whose `conflict` column is `false` printed `contested with FAKE-ID-9999`. This is Epic 1's "importing half of a discipline" lesson, one epic later, on the surface CLAUDE.md calls the authority.

**And the mutation campaign that was supposed to catch it never looked there.** The Auditor's independent campaign found 12 of 15 text-renderer mutations surviving — references section emptied, conflict line always "none", divergence warning removed, all green. Round 1 mutated the query/store layer and the CLI's *structure*, then reported 28/28 and read as exhaustive. The lesson generalises past Epic 1's "prove the mutation applied": **prove the campaign reached every surface it claims to cover.** A campaign's coverage is a claim like any other.

Round 1 had already taught the narrower version of this: its "unknown id exits zero" mutation applied cleanly and survived, and the code was innocent — `process.exitCode = 1;` occurs four times in `cli.ts` and `String.replace` patched `note-resolve`. The round-2 harness therefore rejects any anchor matching more than once.

### Action items — all addressed

- [x] **[High] Note content could forge conflict metadata** (blind). Alternatives now render through `renderAlternativesLine`: each entry collapsed to one line, empties dropped, payload capped at 240 chars like `render.ts`. Pinned by a test that asserts no forged `contested with` line reaches the conflict section while the content still appears inside the `already rejected:` line where it belongs.
- [x] **[High] A newline in `subject` forged a second listing row** (edge). Collapsed the same way; `renderMemorySnippet` already handled the text but subject reached the line raw.
- [x] **[High] The next-page footer was unrunnable on real scope keys** (blind+edge). Keys embed the worktree path, and this repo's own is `branch:c:/claude code/cortex/…` — the printed command failed with "too many arguments". Values are now quoted; the test pastes the footer back through a shell-style parse and asserts it pages. The old test passed vacuously on a space-free fixture.
- [x] **[High] `--offset` above int64 crashed with a raw stack trace** (edge). `resolvePageOffset` clamps to `Number.MAX_SAFE_INTEGER`; a top-level catch now turns any remaining store-level failure into one diagnostic line.
- [x] **[Med] Terminal control characters printed verbatim** (edge). This is the first surface printing text untruncated and `captureOutputTail` keeps ESC and lone CR, so stored content could overwrite or recolour the terminal. Stripped in text mode; `--json` stays byte-faithful, and both halves are pinned.
- [x] **[Med] `--kind ""` listed the whole store while `--kind ","` listed nothing** (blind+edge). Truthiness replaced with `!== undefined`, so an empty filter narrows — matching the store layer's own contract, which the CLI was contradicting.
- [x] **[Med] `parseInt` truncated `--limit 1e3` to 1** (blind+edge). `Number` + `Math.trunc`; a partially-parsed value never reached the documented `NaN` fallback.
- [x] **[Med] Fixed column padding collided precisely on `archived`** (blind+edge+auditor). Widths are computed per page and joined with an explicit separator.
- [x] **[Med] `--offset 100` printed `memory items 101-100 of 3`** (blind+edge+auditor). Empty pages now report either "no items match these filters" or "offset N is past the end".
- [x] **[Med] Unvalidated `--state` was indistinguishable from an empty store** (edge). Validated against the closed set with the valid values named.
- [x] **[Med] A comma in a scope key shattered the filter** (edge). `--scope` is repeatable rather than comma-split; git permits commas in branch names.
- [x] **[Med] The text renderer was untested** (auditor). Round-2 campaign of 29 mutations aimed at it: **29/29 killed, 0 unapplied**, after the two survivors were investigated — one was a genuinely missing test (divergence warning in text mode, added), the other an equivalent mutant for its fixture (`padEnd(8)` vs `padEnd(stateWidth)` where the widest state *is* 8) and was replaced with the real defect, removing the separator.
- [x] **[Med] Three vacuous assertions in the AC #2 text test** (blind+auditor). `toContain('src/present.ts')` passed off the verbatim text block and `toContain('transport')` off the subject line. Rewritten as anchored per-section regexes with a retrieval topic that appears nowhere else.
- [x] **[Low] `scope:` printed `branch:branch:…`** (blind), unusable with `--scope`. Now round-trips, pinned by a test that pastes it back.
- [x] **[Low] `--json` not-found emitted zero bytes** (edge). Emits `{"error":"not_found","id":…}`; exit code unchanged.
- [x] **[Low] An orphaned note-backed item reported `diverged: false`** (edge) — the projection still drives decay and channel exclusion with no column left to correct it, so the detector was blind to the one drift it cannot repair.
- [x] **[Low] The printed ordering criterion omitted the tiebreaker** CLAUDE.md called load-bearing (blind+auditor). Now `newest first (created_at DESC, rowid DESC)`.
- [x] **[Low] The access-history caveat blamed gc for a shortfall the cap caused** (blind). Both causes named, and the cap disclosed.
- [x] **[Low] `total` and `items` were two untransacted queries** (blind). One `runInTransaction` snapshot.
- [x] **[Low] `json_valid` as a sibling `AND` term relied on unspecified WHERE evaluation order** (blind, flagged as unproven). Moved inside `json_each`'s argument as a `CASE`, which cannot be reordered away.
- [x] **[Low] Three false documentation sentences of my own** (blind+auditor): the README's `--scope "proj:cortex@main"` example is a form `src/scope/keys.ts` never emits, the sample listing showed elided ids the renderer never produces, and CLAUDE.md claimed the page cap binds "every caller including the library API" when `listMemoryItemsFiltered({})` returns everything by design. All corrected against real output.

### Accepted, not changed

- **Cross-scope trust labels can be wrong** (blind, with live evidence: 4 of 7 scopes in the real store have no app graph and one is ~7 weeks stale). `ReferenceValidator` validates against the item's own scope graph and this is pre-existing behaviour shared with retrieval — but list/inspect is the first surface where cross-scope items are the *point*. Fixing it means touching the module that feeds the locked gate. Documented honestly in both README and CLAUDE.md instead; the principled fix belongs with a story that can re-run the gate against it.
- **`.cortex.db` is created by a read-only command in whatever directory it runs from** (blind). Real, and shared by every command through `openCortexDb`; Story 2.5 relocates the store and owns this.
- **Offset paging can repeat or skip under concurrent writes** (edge). Inherent to offset paging; a keyset cursor would close it. Benign for an operator tool, and the docstring's stability claim is about a static store.
- **`json_each` matches non-array JSON shapes** (edge). `insertRetrievalLog` only ever writes flat string arrays; no external writer exists.
- **Over ~32764 filter values the list throws while the count succeeds** (edge). Unreachable from the CLI (argv limit bites first), reachable from the library API.

### Change Log

- 2026-07-28 — Round-2 repair: 21 review findings addressed across 5 files; 821 tests (+20), 8 gate suites unchanged, 29/29 round-2 mutations killed (57 across both rounds), 0 unapplied.
- 2026-07-27 — Story 2.1 implemented. `cortex list-memory` and `cortex inspect-memory` land as a read-only operator surface: filtered, capped, order-stated paging, and full-item inspection carrying references, trust label, authoritative conflict status with divergence reporting, and access history. 801 tests (+52), 29 files (+1), 8 gate suites at zero delta, 28/28 mutations killed with 0 unapplied.
