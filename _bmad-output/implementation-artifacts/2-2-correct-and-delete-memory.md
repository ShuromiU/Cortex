---
baseline_commit: 5170fc0
---

# Story 2.2: Correct and delete memory

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who found a wrong memory,
I want to edit or delete it,
So that a mistake is not permanent.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.2 (lines 396-408). Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** an existing memory item
   **When** its text is edited
   **Then** references are re-extracted and the memory item is re-projected
   **And** the correction is recorded in an audit trail that survives the correction.

2. **Given** an existing memory item
   **When** deletion is requested
   **Then** the user confirms before it runs
   **And** the item and its derived rows are removed together in one transaction.

3. **Given** a deletion of an item with a derived file card
   **When** the deletion runs
   **Then** the card and its projection are removed with it (AD-14).

### AC assessment — one forward reference, already adjudicated

**AC #3 names a thing that does not exist yet, and that is deliberate.** File cards arrive in Story 4.1 (`AD-14` binds FR-10/FR-11/FR-16, all Epic 4); `grep -rn "file card\|file_card" src/` returns nothing today. This is **not** an AC defect — the implementation-readiness report already found and accepted it:

> "Story 2.2's card-deletion criterion references cards introduced in Story 4.1. Both are conditional and vacuously satisfiable before their producer exists, and both are **testable in isolation with a synthetic record**. Accepted rather than reordered." — `implementation-readiness-report-2026-07-24.md` Finding 3

So: build deletion so that **every** row derived from a memory item goes with it, generically, and prove it with a synthetic derived row standing in for a card. Do not invent a `file_cards` table — that is Story 4.1's, and creating it here would give Epic 4 a table it did not design.

**AC #2's "the user confirms" has a repo-native form.** `project-context.md` states the convention: "`cortex gc` is **dry-run by default**. Any new destructive operation follows that convention." So delete previews by default and requires an explicit `--yes` to proceed. That is a confirmation the user must give, it is testable without a TTY, and it matches the one destructive command already shipped. Do **not** build an interactive `readline` prompt: the CLI runs under hooks with no TTY, and a prompt there either hangs or silently auto-answers.

## The mechanism — read this before any code

### Deleting a memory item alone does nothing. It comes back.

`backfillMemoryItems` (`src/db/schema.ts:746`) does `INSERT OR IGNORE INTO memory_items` from `notes`, `episodes`, `project_snapshots` and `command_runs`, reconstructing each item's derived id. It runs inside `backfillV2Artifacts`, which `ensureCortexSchema` calls **on every open** — and `openCortexDb` calls `ensureCortexSchema` for **every CLI command**.

Consequence, and it is the spine of this story: **a delete that removes the `memory_items` row but leaves its source row is not a delete.** The item returns on the next `cortex` invocation, with its original id. Any test that deletes and then asserts absence *without reopening the database* will pass against this broken implementation — the same shape as 1.4's "write `warm` once and never refresh" trap.

The load-bearing test is therefore: delete → **reopen the store through `openCortexDb`** (or call `ensureCortexSchema` again) → assert still gone.

So deletion removes, in one transaction: the source row, the `memory_items` row, and everything derived from it.

### What is actually derived, and what cascades on its own

`openDatabase` sets `foreign_keys = ON` (`src/db/schema.ts:336`), so these already follow a `memory_items` delete:

| Row | Mechanism |
| --- | --- |
| `memory_references` | `ON DELETE CASCADE` (`schema.ts:181`) |
| `memory_item_semantics` | `ON DELETE CASCADE` (`schema.ts:143`) |
| `memory_items_fts` | `trg_memory_items_ad` AFTER DELETE trigger (`schema.ts:220`) |

**Verify each of these rather than assuming it.** The cascade depends on a pragma set in one place; a test that pins "references are gone after delete" is cheap and catches a future `openDatabase` regression that nothing else would.

Nothing cascades from `memory_items` to its **source** (`source_table`/`source_id` are loose strings, by design — AD-14's direction is source→derived). The source delete is explicit and kind-dispatched.

### The audit trail must not be a child of the thing it outlives

New table, and **it deliberately has no foreign key to `memory_items`**:

```sql
CREATE TABLE IF NOT EXISTS memory_corrections (
  id             TEXT PRIMARY KEY,
  memory_item_id TEXT NOT NULL,   -- plain text, NOT a REFERENCES: see below
  source_table   TEXT,
  source_id      TEXT,
  scope_key      TEXT,
  operation      TEXT NOT NULL,   -- 'edit' | 'delete'
  prior_text     TEXT NOT NULL,
  new_text       TEXT,            -- NULL for a delete
  prior_subject  TEXT,
  created_at     TEXT NOT NULL
);
```

An `FK ... ON DELETE CASCADE` would destroy the audit row together with the item — precisely what AC #1 forbids. An FK *without* cascade would make the delete fail outright. **No FK is the only shape that satisfies "survives the correction itself."** State that reason in the DDL comment; it reads like an oversight otherwise, and a future contributor will "fix" it.

`prior_text` is populated for both operations — **this is the user's decision, taken at create-story time**: an edit records the text it replaced so a bad correction is itself reversible, and a delete records what was removed so the trail can say what was lost. The honest consequence, which the docs must state: deleted content remains readable in `memory_corrections` until `cortex gc` prunes it. Anyone deleting a memory to make it unreadable needs to know that.

### `SCHEMA_VERSION`: this story bumps it, and it is the only one that may

`AD-11` mandates one increment per release. The readiness report's binding rule for R1:

> "the first story to add a table bumps `SCHEMA_VERSION` 4 → 5 and creates the `V5_TABLES` constant; every later story **appends to that same constant** and does not touch the version." — Finding 2

Epic 2 runs before Epic 3, so **Story 2.2 is the first story in R1 to add a table**. It performs the 4 → 5 bump and creates `V5_TABLES`; Stories 3.1, 4.1, 4.3 and 4.4 append to it. (`deferred-work.md` contains a stale line saying 3.1 "already spent" the bump — written before the epic ordering was settled. The rule, not that line, is authoritative. Correct it in the same commit.)

Adding a table requires the four coordinated edits `project-context.md` names: bump `SCHEMA_VERSION`, add the `V5_TABLES` DDL constant, add a backfill if existing rows need projection (**none needed here** — an audit table starts empty), and wire both into `ensureCortexSchema`.

### Contested-pair deletion — decided, at create-story time

Retrospective action item 3 ("Decide contested-pair deletion semantics before Story 2.2 implements", owner Winston + ShuromiU) is **closed with this decision**: deleting one side of a contest calls `clearConflictsForSubject(subject, scopeKey)` **in the same transaction as the delete**, so the survivor stops rendering `[contested]`.

Rationale: it matches what `cortex_resolve` already does (`mcp.ts:510,523`), it needs no new mechanism, and it cannot leave a survivor pointing at a counterpart that no longer exists. Inherited limitation, already logged and accepted in `deferred-work.md`: clearing is per-subject, so a three-way contest over-clears. Detection produces two-note contests, which is the case this covers.

`clearConflictsForSubject` is scope-keyed (`store.ts:1780` joins through `sessions.scope_key`), so pass the deleted note's scope via `getScopeKeyForNote` **before** the note row is gone. Read it first; the ordering is the bug waiting to happen.

### The two folded-in CLI defects (retrospective action item 2)

Both are `note-resolve` in `src/transports/cli.ts`, and both are already fixed on the MCP path — port the fix, do not redesign it:

1. **`note-resolve` never clears conflicts.** It calls only `updateNoteStatus`, so a resolved note keeps `Conflict: true` in its projection and renders `… [contested] (resolved)` forever, while the surviving side keeps a bare `[contested]`. `mcp.ts:505-525` does clear. Mirror it.
2. **`note-resolve --subject` keeps the ambiguity the MCP path refuses.** `mcp.ts:461-476` refuses when a subject has more than one *contested* active note, listing both ids, and deliberately still allows the ordinary decision-plus-blocker case. Port that guard verbatim, including its scope-blindness — the comment there explains why a scoped guard over a scope-blind lookup lets the ambiguity through.

Neither has test coverage today. That is why they survived; add it.

### Where the code goes

`transports/` → `query/` → `memory/` + `scope/` → `db/`.

| Layer | File | Adds |
| --- | --- | --- |
| `db/` | `src/db/schema.ts` | `SCHEMA_VERSION` 4→5, `V5_TABLES` with `memory_corrections`, wired into `ensureCortexSchema` |
| `db/` | `src/db/store.ts` | `recordMemoryCorrection`, `getMemoryCorrections`, `updateMemoryItemText`, `deleteMemoryItemCascade` |
| `query/` | `src/query/correct.ts` **(new)** | `editMemory`, `deleteMemory` — pure, return structures, render nothing |
| `transports/` | `src/transports/cli.ts` | `edit-memory`, `delete-memory`; the two `note-resolve` repairs |

New module ⇒ `tests/correct.test.ts`. Reuse Story 2.1's `inspectMemory` to prove the post-conditions rather than re-reading rows by hand where it fits — it already reports references, conflict status and the projection/column divergence.

### Re-projection on edit (AC #1)

Editing must leave the store in the state a fresh write would have produced:

- **note-backed** — update `notes.content`, then re-run the existing projection (`syncMemoryItemForNote`) so `buildNoteMemoryText` rebuilds the trailer (`Subject:`/`Alternatives:`/`Conflict:`/`Status:`). Hand-patching `memory_items.text` instead would desynchronise the trailer from the columns — the exact drift `inspect-memory` was built to detect, and it would start reporting `diverged` on notes this command touched.
- **not note-backed** — update `memory_items.text` directly.
- **either way** — re-extract references via `extractMemoryReferences` + `replaceMemoryReferences`, which `upsertMemoryItem` already does (`store.ts:2108`); AC #1 names this explicitly, so pin that a path removed from the old text loses its `memory_references` row and a path added gains one.
- Do **not** reset `access_count`, `last_accessed_at` or `state`. A correction is not a new memory, and silently reheating it would change ranking as a side effect of a typo fix.

### What deliberately does NOT change

- `src/query/render.ts`, `retrieval.ts`, `recall.ts`, `state.ts` — untouched. **Zero delta expected on all 8 locked suites** (`alternatives=237 · budget=178 · contested=117 · kind-ordering=103 · rename-moved=97 · stale-label=164 · stemming=93 · superseded-history=192`). If one moves, stop and find out why; regenerating is never how a red gate goes green.
- No new `memory_items` **kind** ⇒ AD-5 does not apply. (`memory_corrections` is a new *table*, not a new kind — the gate's kind-coverage check reads `memory_items.kind`.)
- No new MCP tool. Both ACs say "command"; ARCHITECTURE-SPINE:287 binds FR-21..FR-26 to `transports/cli.ts`. `CLAUDE.md`'s tool list does not change.
- `gc.ts` is not rewritten here. Note only that `memory_corrections` will need a retention rule; that belongs with Story 4.6's eviction work, and the docs should say so rather than leaving it implied.

## Tasks / Subtasks

- [x] **Task 1 — Schema: the audit table** (AC: #1)
  - [x] `SCHEMA_VERSION` 4→5; `V5_TABLES` holding `memory_corrections`; wire into `ensureCortexSchema` alongside the other DDL constants. No backfill (starts empty). DDL comment states why there is **no FK** to `memory_items`.
  - [x] Tests (`tests/schema.test.ts`): table exists after `applySchema`; migration is idempotent (apply twice); a v4 store upgrades to v5 and keeps its rows; **an audit row survives deletion of the `memory_items` row it names** — the property the missing FK exists to provide.

- [x] **Task 2 — Store: correction and cascade** (AC: #1, #2, #3)
  - [x] `recordMemoryCorrection` / `getMemoryCorrections(memoryItemId)`.
  - [x] `updateMemoryItemText(id, text)` — note-backed path updates `notes.content` and re-syncs the projection; otherwise updates the item; both re-extract references. Preserves `access_count`, `last_accessed_at`, `state`.
  - [x] `deleteMemoryItemCascade(id)` — **one transaction**: read the item and its scope key → write the audit row → clear conflicts for the subject when the source note is contested → delete the source row (kind-dispatched) → delete the `memory_items` row.
  - [x] Tests (`tests/store.test.ts`): references and semantics rows gone after delete (pinning the cascade, not assuming the pragma); the FTS row gone (search stops returning it); audit row present and complete after both operations; edit re-extracts references **both ways** (a removed path loses its row, an added path gains one); edit preserves access counters and state; a note-backed edit leaves the projected trailer consistent with the columns (assert via `inspectMemory(...).conflict.diverged === false`).

- [x] **Task 3 — Resurrection is the real test** (AC: #2)
  - [x] Delete a note-backed item, then **reopen through `openCortexDb`** (which re-runs `ensureCortexSchema` → `backfillMemoryItems`) and assert the item is still absent. Pre-assert the fixture is adversarial: confirm the same reopen **does** resurrect an item whose source row was left behind, so the test proves the source delete is what matters.
  - [x] Same for an episode-backed and a command-run-backed item — `backfillMemoryItems` reads four source tables and the dispatch must cover the ones reachable by id.

- [x] **Task 4 — Contested-pair deletion and the two `note-resolve` repairs** (AC: #2)
  - [x] Deleting one side of a contest clears the contest for the subject in the same transaction; read the scope key **before** deleting the note. Test: build a real contested pair via `insertNote`, pre-assert both carry `conflict = 1`, delete one, assert the survivor's column is clear **and** that `inspect-memory` no longer reports it contested.
  - [x] `note-resolve` calls `clearConflictsForSubject`; `--subject` refuses a subject with more than one contested active note, listing both ids. Port from `mcp.ts:461-476` and `505-525`.
  - [x] Tests: a resolved note no longer renders `[contested] (resolved)`; the survivor is clean; the ambiguous `--subject` case exits non-zero naming both ids; the ordinary decision-plus-blocker subject still resolves (the guard must not over-refuse).

- [x] **Task 5 — `src/query/correct.ts` and the CLI** (AC: #1, #2, #3)
  - [x] `editMemory` / `deleteMemory` returning structures; `--json` falls out of that shape as it did in 2.1.
  - [x] `cortex edit-memory <id> --text <text>` (accept `--file <path>` too — a multi-line correction through a shell argument is miserable). `cortex delete-memory <id>`: **previews by default**, deletes only with `--yes`, per the `gc` convention. Unknown id → stderr, `process.exitCode = 1`, non-zero in `--json` too. Never `process.exit`.
  - [x] AC #3 with a **synthetic derived row**: insert a row into a `memory_items`-referencing table standing in for a future file card, delete the item, assert it went too. State in the test's comment that it stands in for Story 4.1's `file_cards` and why (readiness Finding 3).
  - [x] Tests: preview names what will be deleted and deletes **nothing** (assert the row still exists afterwards); `--yes` deletes; author-supplied text is collapsed/sanitised on output exactly as 2.1 does (this command echoes stored text too).

- [x] **Task 6 — Verification, mutation, docs**
  - [x] `npm run build && npm run lint && npx vitest run` — baseline **821 tests / 29 files green at `5170fc0`** — then `npm run gate`: **8 suites, zero delta**.
  - [x] Mutation-test every new assertion. Mutate `src/`, never `dist/`; anchors EOL-adaptive (**this repo is mixed** — `store.ts`/`cli.ts` are CRLF, `schema.ts`/`query/*.ts`/`tests/*` are LF); **reject any anchor matching more than once** (2.1 round 1 patched `note-resolve` while aiming at `inspect-memory` and the survivor looked like a code defect); and **cover every surface the change touches, including the CLI's text renderer** — 2.1's round-1 campaign reported 28/28 while 12 of 15 renderer mutations survived untested. Minimum set: source row not deleted (resurrection) · audit row written inside the transaction but rolled back with it · audit FK added (delete cascades the trail away) · conflict not cleared on delete · scope key read after the delete · references not re-extracted on edit · edit resets access counters · preview actually deletes · `--yes` not required · exit code left 0 · `note-resolve` conflict clearing dropped · `--subject` guard dropped.
  - [x] Docs in the same commit: `README.md` (both commands, the preview/`--yes` convention, and **plainly**: deleted text remains in `memory_corrections` until gc). `CLAUDE.md` § Core Files gains `src/query/correct.ts`; § Expected Behavior gains the delete contract (source row goes too or backfill resurrects it; one transaction; contest cleared; audit survives and why it has no FK; `SCHEMA_VERSION` now 5). Correct the stale `deferred-work.md` line about 3.1 owning the bump, and mark retrospective action items 2 and 3 done in `sprint-status.yaml`. **Every doc sentence is an assertion — verify each against the code.**
  - [x] Stage `CLAUDE.md` **surgically** — rebuild the blob from `HEAD:CLAUDE.md` plus only this story's hunks (`git hash-object -w --path CLAUDE.md` + `git update-index --cacheinfo`), verifying the staged hunk count before committing. **Never `git add CLAUDE.md` wholesale**: the working copy carries the user's own unstaged "Agent Tooling" edits and RefCertify-section removal. `.mcp.json` stays unstaged; `.serena/` stays untracked.

## Dev Notes

### Files touched

| File | Change |
| --- | --- |
| `src/db/schema.ts` | `SCHEMA_VERSION` 4→5, `V5_TABLES`, `memory_corrections` |
| `src/db/store.ts` | correction record/read, text update, cascade delete |
| `src/query/correct.ts` | **new** — `editMemory`, `deleteMemory` |
| `src/transports/cli.ts` | `edit-memory`, `delete-memory`, two `note-resolve` repairs |
| `src/index.ts` | exports |
| `tests/correct.test.ts` | **new** |
| `tests/store.test.ts`, `tests/schema.test.ts`, `tests/cli.test.ts` | extended |
| `README.md`, `CLAUDE.md`, `deferred-work.md`, `sprint-status.yaml` | docs, same commit |

### Traps, carried forward

- **The resurrection trap is this story's version of 1.4's "test against the refresh, not the write".** A delete test that never reopens the database passes against an implementation that deletes nothing durable.
- **Don't assert a property; test it.** Named in 1.2, recurred in 1.3, 1.4 and again in 2.1 (a pagination test asserted three pages *union* to the full set — true under any stable order — while the tiebreaker it claimed to pin went untested). Pre-assert preconditions inside each test.
- **A mutation campaign's coverage is a claim like any other.** Prove it applied, prove it applied *where aimed*, and prove it reached every surface — including rendered text.
- **Reading the real output finds what tests miss.** 2.1 shipped a raw ISO timestamp and a `branch:branch:` scope line past a green suite; both were caught by running the command and looking.
- `npm run lint` does **not** typecheck `tests/`. Import specifiers end in `.js`. Temp dirs via `os.tmpdir()`. Store fixture: `new Database(':memory:')` → `db.pragma('foreign_keys = ON')` → `applySchema` → `initializeMeta` → `new CortexStore(db)`. Note that the in-memory fixture sets the FK pragma by hand — the production guarantee comes from `openDatabase`, so at least one delete test must go through `openCortexDb` to prove the real path.

### References

- [Source: `epics.md:396-408`] — ACs verbatim. [Source: `prd.md:358-365`] — FR-22's three consequences. [Source: `implementation-readiness-report-2026-07-24.md` Findings 2 and 3] — the `SCHEMA_VERSION` rule and the accepted file-card forward reference. [Source: `ARCHITECTURE-SPINE.md` AD-11, AD-14] — migration discipline; derived content owned by its source. [Source: `src/db/schema.ts:746`] — the backfill that resurrects. [Source: `src/transports/mcp.ts:461-476,505-525`] — the resolve guard and conflict clearing to port. [Source: `epic-1-retro-2026-07-27.md` action items 2 and 3] — folded in and closed here. [Source: story 2.1 review record] — mutation-campaign discipline.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

**Mutation testing** (`scratchpad/mutate-2-2.mjs`, 23 mutations across four test files): **23/23 killed, 0 never applied**, after one survivor was investigated and closed. The harness carries 2.1's three rules — mutate `src/`, normalise anchors per file (this repo is mixed-EOL), and **reject any anchor matching more than once**, which is the rule 2.1 round 1 learned by patching `note-resolve` while aiming at `inspect-memory`.

The survivor was real: **"counterpart scope filter dropped in the deletion preview."** No fixture had a same-subject contested pair in another scope, so nothing exercised the scope filter — the identical gap 2.1's review found in `inspectMemory`, reproduced in a new module because the fixture was not carried across with the code pattern. Added the cross-scope fixture (a contest of its own in `scope-b`, so both foreign notes genuinely carry `conflict = 1` and only scope can exclude them) and re-ran that single mutation to confirm it now dies.

**The resurrection mechanism was verified before being designed against, and the test proves the fixture reaches it.** `backfillMemoryItems` re-inserts from four source tables on every `ensureCortexSchema`; `openCortexDb` calls that on every command. The suite includes a deliberately-adversarial precondition test — delete *only* the projection, reopen, assert the item **is** back — so the durability tests cannot pass vacuously against a store that never re-projects.

**`npm run lint` again caught what tests could not:** the first pass of the CLI's `--text`/`--file` mutual-exclusion check typechecked only because `opts.text!` was asserted; the guard shape was corrected before the tests ran.

**Literal control characters were embedded into source twice** (once in `cli.ts` during 2.1, once in `cli.test.ts` here) because shell heredocs collapse backslash escapes. Both were repaired by a Node script writing the escape sequences directly, and a byte-level check now confirms zero literal control characters remain in either file. The lesson is narrow and practical: write regex/string literals containing control characters through the file tools, never through a shell heredoc.

**One AC-adjacent finding was left out of scope deliberately.** `findActiveNoteBySubject` orders by `timestamp DESC` with no tiebreaker, so `note-resolve --subject` on an ordinary decision-plus-blocker subject closes an arbitrary one of the two when they share a millisecond. This is *not* the ambiguity retrospective action item 2 named — that one concerned contested pairs and is now refused on both paths — and fixing it changes behavior for `cortex_resolve` too. Logged in `deferred-work.md`; the test asserts *exactly one* note resolved rather than pinning which, so it does not freeze the current arbitrary order.

### Completion Notes List

**AC #1 — edit.** `edit-memory` replaces an item's text, re-extracts its references and re-projects it, recording the prior text in `memory_corrections` **inside the same transaction** — "recorded in an audit trail" is only true if the record cannot survive a correction that rolled back, or the reverse. A note-backed item is corrected *through its note* so the projected trailer stays consistent with the columns it mirrors; patching `memory_items.text` directly would manufacture the exact drift `inspect-memory` reports as `diverged`, from the command meant to repair memory. That property is asserted through `inspectMemory(...).conflict.diverged === false` rather than by re-reading the text. Access counters and state are preserved: a correction is not a new memory.

The audit table **has no foreign key to `memory_items`**, and that is the design, not an omission: `ON DELETE CASCADE` destroys the trail with the item; a non-cascading FK makes the delete fail. The DDL says so, and a mutation that adds the cascading FK is killed by a test that deletes the item and reads the audit row back.

**AC #2 — delete.** Deletion removes the source row, the item, its references, its semantics row and its FTS entry **in one transaction**, and clears the contest when the item is one side of a contested pair. The confirmation is preview-by-default with `--yes` to act, matching `cortex gc` — the repo's stated convention for destructive operations and the only form that works in a CLI running under hooks with no TTY.

**The spine of the story is that deleting the projection alone is not a deletion.** `backfillMemoryItems` re-inserts from `notes`, `episodes`, `project_snapshots` and `command_runs` on every `ensureCortexSchema`, which every command triggers — so the item returns with its original id on the next invocation. Four tests reopen the store and assert absence for note-, episode- and command-run-backed items, plus the adversarial precondition proving the backfill really does resurrect.

**AC #3 — derived rows.** Built generically, and proved with `memory_item_semantics` standing in for Story 4.1's `file_cards`: it is a real `memory_items`-derived table with the same FK shape a card will have. Per the readiness report's Finding 3 this forward reference is accepted and prescribed to be tested with a synthetic record; inventing a `file_cards` table here would hand Epic 4 a schema it did not design.

**Retrospective action items 2 and 3 are closed.** `note-resolve` now clears conflicts (a resolved note stopped rendering `[contested] (resolved)`, and the survivor stopped keeping a bare `[contested]`), and `note-resolve --subject` refuses a subject with more than one contested active note, listing both ids — ported verbatim from the MCP path including its scope-blindness, and tested to *not* over-refuse the ordinary decision-plus-blocker case. Item 3's decision — clear the contest in the same transaction as the delete — was taken at create-story time with the user and is recorded in the story and in `sprint-status.yaml`.

**`SCHEMA_VERSION` 4 → 5, and this story owns it.** Per AD-11 a release gets one increment, and the readiness report's binding rule gives it to the first story that adds a table. Epic 2 runs before Epic 3, so that is 2.2, not 3.1 as `deferred-work.md` recorded before the ordering settled — corrected in the same commit. `V5_TABLES` now exists for Stories 3.1, 4.1, 4.3 and 4.4 to append to.

**Zero delta on all 8 locked suites** despite the schema bump: `alternatives=237 · budget=178 · contested=117 · kind-ordering=103 · rename-moved=97 · stale-label=164 · stemming=93 · superseded-history=192`. No new `memory_items` kind, so AD-5 is not triggered. No new MCP tool, so `CLAUDE.md`'s tool list is unchanged.

### File List

- `src/db/schema.ts` — modified; `SCHEMA_VERSION` 4→5, `V5_TABLES` with `memory_corrections`, index, wired into `applySchema`
- `src/db/store.ts` — modified; `ParsedMemoryCorrection`/`RecordMemoryCorrectionOpts`, `recordMemoryCorrection`, `getMemoryCorrections`, `updateMemoryItemText`, `deleteMemoryItemCascade`
- `src/query/correct.ts` — new; `editMemory`, `previewMemoryDeletion`, `deleteMemory`
- `src/transports/cli.ts` — modified; `edit-memory`, `delete-memory`, deletion-preview renderer, two `note-resolve` repairs
- `src/index.ts` — modified; exports for the new query module and store types
- `tests/correct.test.ts` — new; 12 tests over edit, preview and delete
- `tests/store.test.ts` — modified; +12 tests over correction, cascade and re-open durability
- `tests/schema.test.ts` — modified; +3 tests for the table and the bump, 2 version pins updated
- `tests/cli.test.ts` — modified; +12 tests over both commands and the `note-resolve` repairs
- `README.md` — modified; both commands in § CLI Commands, new § "Correcting and deleting memory"
- `CLAUDE.md` — modified; `src/query/correct.ts` in § Core Files, seven § Expected Behavior bullets
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified; stale `SCHEMA_VERSION` line corrected, two new findings logged
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified; story status, action items 2 and 3 closed

## Senior Developer Review (AI)

**Reviewed:** `c989412` vs `5170fc0` · three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) · 2026-07-28
**Outcome:** Changes Requested → addressed in the repair round below.

The Auditor confirmed AC #2 and AC #3 met by execution — including installing a `BEFORE DELETE … RAISE(ABORT)` trigger to prove the transaction is real (0 audit rows left behind) — and verified every numeric claim. AC #1 came back **partially met**. The Blind Hunter's summary is the line that matters: *"Full suite, lint, and gate all pass — so none of these are caught."* 860 green tests caught none of it.

### The through-line

**The story's central guarantee was broken on the mainline path, and my own fixtures hid it.** "Deletion survives the backfill" was the spine of the design, and I checked exactly one level of the source chain. Three of the six source tables are *themselves* re-derived: `command_runs` from `events`, `episodes` and `project_snapshots` from `state`, each reusing the same primary key. Deleting the source row is undone by the next command exactly as deleting the projection was.

It shipped because the three "survives the backfill" tests built their fixtures with `insertCommandRun` / `insertEpisode` directly — leaving no `events` or `state` row for the backfill to resurrect from, so they could not fail. The one test that *did* establish the precondition used `notes`, the single source table with no second layer. **The story file warned, in its own words, that a non-adversarial fixture would defeat this exact guarantee.** Rebuilt through `handleCmdEvent` / `writeSessionSummary` / `replaceProjectState`, all three go red against the shipped code.

**And I repeated Epic 1's named failure in a repair meant to fix contest handling.** The CLI's conflict clearing carried the comment "Mirrors `mcp.ts`" while porting half its guard: MCP gates on `note.conflict && note.subject`, with a comment naming the hazard; I gated on `note.subject`. Resolving an unrelated blocker on a subject silently closed a live contest between two decisions. That is "imported half of a discipline and claimed the whole", one epic after it was written down — and the same commit's `deleteMemoryItemCascade` carried the correct guard, so the file contradicted itself.

### Action items — all addressed

- [x] **[High] Deletion resurrected via second-order sources** (blind+edge+verified live). `deleteUpstreamOf` walks `command_runs → events` and `episodes`/`project_snapshots → state`; a `state`-backed delete also removes the twin projection sharing its id. A source table with **no** rule now throws instead of half-deleting. Verified end to end: all three kinds stay gone across a reopen.
- [x] **[High] The three durability tests were vacuous** (blind+edge). Rebuilt through the real producers, each with a pre-asserted precondition; added the missing `project_snapshots` case.
- [x] **[High] `edit-memory` reset `access_count`, `last_accessed_at` and tier on note-backed items** (all three layers). `syncMemoryItemForNote` read `existing` only for superseded notes, so its upsert wrote the defaults over real history — reheating cold memories and un-pinning pinned ones, both `computeHotness` inputs. Counters are now preserved unconditionally; tier by status (`superseded` keeps, `resolved` re-derives cold, `active` keeps). The old test used a `source_table`-NULL item and never reached the branch; note-backed and pinned cases are now pinned separately.
- [x] **[High] `note-resolve` wiped unrelated contests** (edge+auditor). Guard completed to `note.conflict && note.subject`, with a test that pre-asserts the blocker is uncontested and the pair is.
- [x] **[Med/High] `edit-memory` could manufacture the `diverged` state the README says it prevents** (blind). Text whose last non-empty line looks like a projection trailer is refused; a mid-text mention is allowed, and both are tested. `--file` would otherwise have promoted a documented bounded residual into a first-class input.
- [x] **[Med/High] Both new transactions were DEFERRED** (blind+edge+auditor), against the rule CLAUDE.md states and `insertNote` follows. Now `runInImmediateTransaction`. See "Accepted" for the testing gap.
- [x] **[Med] `cortex gc` never pruned `memory_corrections`** while three shipped surfaces said it did — including the line printed at every deletion. Added a retention rule (90 days, `CORTEX_GC_CORRECTION_DAYS`) so the sentence is true, rather than softening the sentence.
- [x] **[Med] No command surfaced the audit trail**, though `edit-memory` told the user `inspect-memory` did. `inspectMemory` now returns `corrections` and the CLI renders them.
- [x] **[Med] Preview and delete compared scope differently** (blind+auditor) — the preview used the `memory_items` column, the delete the session join, so a NULL-scope session made the confirmation surface report zero counterparts for a contest the delete then cleared. Both now use the session join; pinned with an unscoped-session fixture.
- [x] **[Med] `prior_text` was unreplayable** (auditor). It recorded the projection while `edit-memory` consumes note content, so feeding it back doubled the kind prefix and the trailer — falsifying the story's stated reason for storing it. Now records the editable text, with a round-trip test.
- [x] **[Med] The preview promised source-row deletion for tables the cascade skips** (edge), and understated aggregate sources. It now reports `NO deletion rule`, names the upstream table, and warns when a snapshot or state row carries more than the one item.
- [x] **[Med] A failed delete printed `deleted <id>` with exit 0** (blind+edge). `deleteMemory` now runs preview and cascade in one immediate transaction, so the race cannot occur; the CLI still checks and exits non-zero.
- [x] **[Med] `--text ""` blanked a memory** (blind+edge). Refused, pointing at `delete-memory`.
- [x] **[Low] `--json` emitted nothing on the flag and file error paths** (edge). Both now emit `{error, id}`.
- [x] **[Low] A UTF-8 BOM from `--file` was stored verbatim** (edge) — the likely source on Windows. Stripped.
- [x] **[Low] Four stale or false doc claims of mine** (blind+auditor): the README transcript omitted three lines the command prints (regenerated from real output); CLAUDE.md called the `foreign_keys` pragma "the whole guarantee" when better-sqlite3 defaults it on; CLAUDE.md and `schema.ts` named the **withdrawn** Story 4.1 as a future `V5_TABLES` appender; and `replan-r1-2026-07-28.md` still said 3.1 takes the `SCHEMA_VERSION` bump that this story took. All corrected.

### Accepted, not changed

- **The IMMEDIATE guarantee has no automated test.** The failure it prevents is only observable across processes; an in-process attempt passed under both modes and was **removed rather than kept**, since a test that cannot fail is worse than none. Logged with the two-process harness that would close it — which would also cover `insertNote`'s identically untested guarantee.
- **`deleteMemory`'s `deleted: false` branch is now unreachable** by construction (preview and cascade share one transaction), so its mutation survives as a true equivalent. Kept as defense-in-depth against a future loss of atomicity, and labelled as such rather than counted as a kill.
- **`gc`'s command-run overflow prune is undone by the same backfill** (auditor). Real, measured, and explicitly out of this story's scope — but this story is what makes it legible, so it is logged with the fix (reuse the cascade).
- **`edit-memory` does not re-run contradiction detection**, so it cannot clear a false contest. A behavior change that can newly mark items contested as a side effect of a typo fix; deferred with reasoning.
- **`--status` coercion and `--subject` normalisation drift** — pre-existing, enlarged in consequence by this story, deferred with the `findActiveNoteBySubject` tiebreaker they belong with.

### Change Log

- 2026-07-28 — Round-2 repair: 17 review findings addressed across 8 files; 879 tests (+19), 8 gate suites unchanged, 36/39 round-2 mutations killed with 0 unapplied (3 survivors classified: 2 untestable in-process, 1 equivalent by construction).
- 2026-07-28 — Story 2.2 implemented. Edit re-extracts references and re-projects through the note; delete removes the source row, the item and its derived rows in one transaction, previews by default, and clears a contest it breaks up; both record the prior text in an audit trail that outlives them. Two `note-resolve` defects repaired. 860 tests (+39), 30 files (+1), 8 gate suites at zero delta, 23/23 mutations killed with 0 unapplied.
