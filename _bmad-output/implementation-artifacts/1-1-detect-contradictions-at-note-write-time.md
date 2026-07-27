---
baseline_commit: 51817893da2d09659453ee6465512c660a826ddc
---

# Story 1.1: Detect contradictions at note write time

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an agent writing durable memory,
I want to be told when a new note opposes an active decision on the same subject,
so that contradictions surface before an implementing agent acts on the wrong one.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.1. Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** an active `note:decision` on subject S
   **When** a new note is written on subject S whose content opposes it
   **Then** the write succeeds
   **And** a conflict payload is returned naming the prior item's id, subject, timestamp, and text
   **And** `notes.conflict` is set to `1` on both the prior and the new note.

2. **Given** a note written with no subject
   **When** the write is processed
   **Then** no conflict detection runs and no extra queries are issued.

3. **Given** a subject with no active item
   **When** a note is written on it
   **Then** no conflict is produced.

4. **Given** a database holding 10,000 memory items
   **When** a note is written
   **Then** conflict detection adds no more than 5 ms to the write.

5. **Given** conflict detection is running
   **When** it evaluates a candidate pair
   **Then** it completes deterministically and offline, with no model call on the write path.

### AC deviation — flagged, not implemented around

**AC #1 is incomplete and this story deliberately does more than it says.** Read this before Task 3.

`insertNote` (`src/db/store.ts:1396`) already auto-supersedes: writing a `decision` or `intent` flips **every** prior active note of that kind+subject to `status = 'superseded'` before the insert. And `memoryStateForNote` (`src/memory/items.ts:17-20`) maps `superseded` → `'archived'`, the coldest tier.

So a literal reading of AC #1 produces a write that marks the prior note contested and archives it in the same transaction. The column says "contested"; retrieval says "gone". FR-1's purpose — "contradictions surface before an implementing agent acts on the wrong one" — fails outright, and Story 1.2's "both sides appear adjacently" would have one side to render.

**AD-17 binds here and is unambiguous:** "Conflict detection runs **before** auto-demotion and vetoes it… both are marked contested and **both retain their current state** — no tier change on either side." Archiving is a tier change in the exact sense AD-17 names. The repo already agrees with itself: `promoteSubagentNotes` (`src/capture/consolidate.ts:308`) calls `updateNoteStatus(conflictNote.id, 'active')` for no purpose other than undoing this same auto-supersede after detecting a conflict.

**Therefore this story vetoes the `notes.status` supersede for contested priors** (Task 3). Detection runs *before* the supersede rather than undoing it after, which avoids consolidate's superseded→active round-trip and its two redundant `syncMemoryItemForNote` calls.

**Scope boundary with Story 1.4 — do not blur it:**

| Concern | Owner |
| --- | --- |
| `notes.status` supersede, and its veto when contested | **1.1 (this story)** |
| Hotness-tier demotion (FR-4), and its veto when contested | **1.4** |

Story 1.4 must not re-implement the status veto, and this story must not implement tier demotion. 1.4's AC #2 ("neither item's state changes") will be partly satisfied on arrival — that is expected, not a gap.

## Tasks / Subtasks

- [x] **Task 1 — Lower `stemLite` into `memory/` so both layers can reach it** (AC: #5)
  - [x] Move `TOKEN_PATTERN`, `stemLite`, and its private helpers (`VOWEL_PATTERN`, `MIN_STEM_LENGTH`) from `src/query/tokenize.ts` into a new `src/memory/text.ts`.
  - [x] `src/query/tokenize.ts` re-exports both (`export { TOKEN_PATTERN, stemLite } from '../memory/text.js';`) so its public surface is byte-identical. `src/query/retrieval.ts` and `tests/tokenize.test.ts` are the **only** two importers — verified — and neither changes.
  - [x] **Why the move is necessary:** AD-1 is one-way `transports/` → `query/` → `memory/` + `scope/` → `db/`, with an explicit carve-out that `db/` may import `memory/` for text shaping. Detection must run inside `insertNote`, which lives in `db/` and therefore **cannot** import from `query/`. Stemming is a text primitive, not a query concern; the query-specific `tokenizeTopic` / `countTokenHits` / `tokenMatchesText` stay in `query/tokenize.ts`.
  - [x] Do **not** move `LOW_SIGNAL_TOKENS` or `tokenizeTopic`. See Task 2 for why using them here would be a defect.
  - [x] Update `src/index.ts` in this change if `memory/text.ts` exports anything new to the public surface (repo convention: every new export lands in `index.ts` in the same change).

- [x] **Task 2 — Build the contradiction predicate** (AC: #1, #5)
  - [x] New file `src/memory/conflict.ts`. Pure, synchronous, no database handle, no I/O, no model call.
  - [x] Public surface:
    ```ts
    export interface ContradictionEvidence {
      signal: 'negation' | 'antonym';
      /** The token(s) that carried the polarity flip — for tests and SM-5 diagnosis. */
      trigger: string;
    }
    export function detectContradiction(prior: string, incoming: string): ContradictionEvidence | null;
    ```
  - [x] **Tokenization — do NOT call `tokenizeTopic`.** `LOW_SIGNAL_TOKENS` strips `without`, `do`, `does`, `did`, `should`, `would`, `can`. Those are precisely the polarity carriers this predicate detects; routing through `tokenizeTopic` would delete the signal before it is read. Tokenize with `TOKEN_PATTERN`, split on `[._/-]+`, and stem with `stemLite`.
  - [x] **Strip apostrophes before tokenizing.** `TOKEN_PATTERN` is `/[a-z0-9][a-z0-9._/-]*/gi` — no apostrophe — so `"don't"` tokenizes to `don` + `t` and the negator is lost. Normalize `'` and `’` out of the text first so `"don't"` → `dont`.
  - [x] **Signal 1 — negation asymmetry.** `NEGATORS = {not, no, never, none, dont, doesnt, didnt, cannot, cant, wont, shouldnt, isnt, arent, without, avoid, neither, nor}`. Fires when **exactly one** side carries a negator (both sides negated is not a contradiction).
  - [x] **Signal 2 — antonym pair.** A small curated lexicon of stemmed technical opposites: `enable/disable`, `add/remove`, `allow/deny`, `include/exclude`, `keep/drop`, `on/off`, `always/never`, `required/optional`, `sync/async`, `accept/reject`, `start/stop`, `show/hide`, `increase/decrease`, `true/false`. Fires when one side contains member A and the other contains member B, and **neither side contains both**.
  - [x] **Both signals are gated on shared context.** Compute a core token set per side = stemmed tokens minus negators minus antonym members. Require the intersection to be **at least 2 tokens** and `|intersection| / min(|coreA|, |coreB|) >= 0.5`. Without this gate, "never use tabs" and "always run the linter" would read as a contradiction because they share a polarity flip and nothing else.
  - [x] **Deliberate false negative — document it in a comment.** Divergent-choice pairs ("use postgres" vs "use mysql") carry no polarity marker and produce **no** conflict. This is correct: PRD risk R-5 says the detector must be "subject-scoped and conservative", and SM-5 treats a low resolution rate as evidence *the detector is wrong*, not that users are lazy. False negatives are the cheap failure; false positives kill the feature. Do not add a "different content" fallback — that is `consolidate.ts`'s predicate and it is far too loose for FR-1.

- [x] **Task 3 — Wire detection into the write path** (AC: #1, #2, #3, and the AC deviation above)
  - [x] In `insertNote` (`src/db/store.ts:1381`), before the auto-supersede block:
    - [x] If `subject === null`, skip everything. **Issue no query** — AC #2 is explicit. `insertNote` already throws for `decision`/`intent`/`blocker`/`focus` without a subject, so `insight` is the only subjectless kind that reaches here.
    - [x] Otherwise select active `decision` notes on that subject and run `detectContradiction(prior.content, opts.content)` against each. AC #1 scopes the **prior** to `note:decision`; the **incoming** note may be any kind. Honor that asymmetry — do not require both sides to be decisions.
  - [x] **Reuse the existing lookup.** The auto-supersede block already runs `SELECT id FROM notes WHERE kind = ? AND subject = ? AND status = 'active'`. Widen that one query to also select `content`, `timestamp`, `subject` and feed both the supersede and detection from it. Do not add a second round-trip — AC #4's budget is easiest to hold by not spending it.
  - [x] **Veto the supersede for contested priors.** Exclude every contested id from the `UPDATE notes SET status = 'superseded'` statement. Non-contested priors supersede exactly as they do today.
  - [x] Call `markConflict` on each contested prior and on the new note. `markConflict` already calls `syncMemoryItemForNote`, so the projection updates itself — do not add a redundant sync.
  - [x] **Return shape:** widen `insertNote`'s return to `ParsedNote & { conflicts?: NoteConflict[] }`. This is structurally backward-compatible; all four existing call sites (`consolidate.ts:300`, `consolidate.ts:313`, `mcp.ts:380`, `mcp.ts:419`) keep compiling untouched. Do **not** change `ParsedNote` itself — `conflict: boolean` on the row type stays as-is.
    ```ts
    export interface NoteConflict {
      id: string;         // AC #1: prior item's id
      subject: string;    // AC #1: subject
      timestamp: string;  // AC #1: timestamp
      content: string;    // AC #1: text
      signal: 'negation' | 'antonym';
    }
    ```
  - [x] Scan all active decision priors, not just the newest. `findActiveNoteBySubject` returns one row and is the wrong tool here.

- [x] **Task 4 — Surface the payload in `cortex_note`** (AC: #1)
  - [x] `src/transports/mcp.ts:371` currently returns `Noted (kind[subject]) [ts]: preview`. When `conflicts` is non-empty, append a conflict block naming each prior's id, subject, timestamp and text.
  - [x] Keep it terse and budget-aware — this is agent-facing output on every note write. Truncate prior text the same way the existing `preview` does (60 chars + `…`).
  - [x] Reuse `formatMemoryTimestamp` for the prior's timestamp so the `YYYY-MM-DD HH:mmZ` convention holds.
  - [x] Do **not** fail or alter the write on conflict. AC #1: the write always succeeds; conflict is advisory metadata, never a rejection.

- [x] **Task 5 — Tests** (AC: #1, #2, #3, #4, #5)
  - [x] `tests/conflict.test.ts` — new, for the pure predicate. Cover: negation asymmetry fires; both-sides-negated does not; antonym pair fires; both-members-on-one-side does not; low overlap does not fire despite a polarity flip; divergent-choice pairs do not fire; apostrophe forms (`don't`) are detected; stemming works across inflections.
  - [x] Extend `tests/store.test.ts` for the write path: contested prior and new note both get `conflict = 1`; the payload carries id/subject/timestamp/text; **the contested prior stays `active`** (the veto); a non-contradicting decision on the same subject still supersedes as before; subjectless `insight` produces no conflict; a subject with no active decision produces no conflict.
  - [x] **AC #2's "no extra queries" needs a real assertion, not a comment.** Spy on the `Database` prepare/run surface (or count via a wrapper) and assert zero conflict-related queries for a subjectless write. A test that only checks `conflicts === undefined` does not test AC #2.
  - [x] **AC #4 needs a measurement, not a claim.** Seed 10,000 `memory_items`, then time a note write with and without a contradicting prior; assert the delta is under 5 ms. Use `os.tmpdir()` for the database — never a literal `/tmp` (Node and Git Bash resolve it to different filesystems on Windows).
  - [x] **Mutation-test every new assertion before declaring the story done.** Four assert-nothing tests reached `main` across stories 0.1, 0.2 and 1.5. For each new test: break the implementation deliberately, confirm the test goes red, restore. A test that passes against a broken implementation is worse than no test.
  - [x] `npm run lint` does **not** typecheck `tests/` — `tsconfig` excludes the whole tree and vitest transpiles without checking. Type errors there are invisible to both commands. Read test code carefully.
  - [x] Import specifiers end in `.js` even from `.ts`, including in `tests/`.

- [x] **Task 6 — Verification and docs**
  - [x] `npm run build && npm run lint && npx vitest run`.
  - [x] `npm run gate`. This story touches note text projection indirectly (`markConflict` → `syncMemoryItemForNote` → `buildNoteMemoryText` emits `Conflict: true`), so `output_tokens` can move. Eval scenarios seed through `seedStoreFromScenario`, which writes `memory_items` directly rather than through `insertNote` — so the expected delta is zero. **If it is not zero, find out why before touching a baseline.** Regenerating is never the way to turn a red gate green.
  - [x] **AD-5 does not apply.** This story introduces no new `memory_items` kind — contested notes keep their existing `note:decision` / `note:insight` kinds. No new locked fixture is required. (Story 1.3 does introduce one.)
  - [x] Update `CLAUDE.md` § Expected Behavior with the write-time contradiction rule and the supersede veto, and `README.md` if it documents `cortex_note`'s output. Docs land in the same commit as the behavior.

## Dev Notes

### The epic's premise is wrong — verify against code, not prose

Epic 1 opens: *"Activate the two schema columns that have been written since v1 and read by nothing."* Both halves are false, and believing them will cause duplicate work:

- `notes.conflict` **is written today** — `promoteSubagentNotes` (`src/capture/consolidate.ts:288-310`) marks both sides when a subagent's note differs from the parent's on the same kind+subject. Its predicate is "different content", which is *not* FR-1's "opposes". Leave it alone; this story does not change consolidation.
- Both columns **are read today** — `buildNoteMemoryText` (`src/memory/items.ts:54-59`) emits `Alternatives: …` and `Conflict: true` into `memory_items` text, and `src/query/state.ts:243` renders a `[conflict]` marker off that text.

Consequence for the next story: Story 1.2's `[contested]` marker is a **rename of a live marker**, not a new one, and it will move `output_tokens` on any suite holding a contested note. Not this story's problem, but do not let 1.2 be planned as greenfield.

### Files being modified — current state

| File | Today | This story |
| --- | --- | --- |
| `src/db/store.ts:1381` `insertNote` | Auto-supersedes all active same-kind+subject notes for `decision`/`intent`, then inserts with `conflict = 0`. Returns `ParsedNote`. | Detection before supersede; veto for contested priors; widened return. |
| `src/db/store.ts:1524` `markConflict` | Sets `conflict = 1`, syncs the memory item. | Unchanged — reuse it. |
| `src/memory/items.ts:17` `memoryStateForNote` | `superseded` → `archived`; `active` decision → `warm`. | Unchanged — but it is *why* the veto is required. |
| `src/query/tokenize.ts` | Owns `TOKEN_PATTERN`, `stemLite`, `tokenizeTopic`, `countTokenHits`, `tokenMatchesText`. | First two move down to `memory/text.ts`; re-exported so the surface is unchanged. |
| `src/transports/mcp.ts:371` `cortex_note` | Returns a one-line confirmation. | Appends the conflict payload when present. |

### Must not break

- **Auto-supersede for the non-contested case.** It is load-bearing for `cortex_resolve` and for `promoteSubagentNotes`, which relies on `insertNote` superseding the parent note it then re-activates. Narrow the veto to contested ids only.
- **`consolidate.ts`'s conflict path.** It calls `insertNote` and then `updateNoteStatus(…, 'active')` + `markConflict` on both sides. After this change, a *contradicting* promotion may already be contested and already active — the re-activation becomes a no-op rather than a correction. That is fine and should be left in place; a *differing but non-contradicting* promotion still needs it. Confirm `tests/consolidate.test.ts` stays green and do not "simplify" that block.
- **`ParsedNote` shape.** Widening `insertNote`'s return is safe; changing `ParsedNote` is not — it is exported from `src/index.ts` and parsed from raw rows in two places.

### Performance

`idx_notes_kind_subject ON notes(kind, subject)` already exists (`src/db/schema.ts:238`). Detection reuses the auto-supersede lookup on that same index, so AC #4's 5 ms budget is met by adding zero queries. Note that AC #4 says 10,000 **`memory_items`**, not 10,000 notes — `memory_items` is the large table and mostly holds episodes and command runs, so the notes lookup stays small regardless.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.1] — acceptance criteria, verbatim.
- [Source: `_bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md` § FR-1] — "The write **always succeeds**. Conflict is advisory metadata, never a rejection." Out of scope: automatic resolution.
- [Source: `.../prd.md` § R-5] — "Advisory-only and never blocking; subject-scoped and conservative."
- [Source: `.../prd.md` § SM-5] — resolution rate ≥ 50%; a low rate means the detector is wrong.
- [Source: `.../architecture/architecture-cortex-2026-07-24/ARCHITECTURE-SPINE.md` § AD-17] — conflict detection runs before auto-demotion and vetoes it.
- [Source: `_bmad-output/project-context.md` § Architecture Rules] — "Layer direction is strict and one-way… `db/` imports from `memory/` for text shaping only."

### Deviation from the architecture spine — placement

The spine's file map (`ARCHITECTURE-SPINE.md:267`) puts contradiction detection at `query/conflict.ts`. **That placement is unreachable.** FR-1 makes detection a write-path concern, the write path is `insertNote` in `db/`, and AD-1 forbids `db/` importing `query/`. AD-1 is the binding rule; the file map is illustrative. The predicate therefore lands at `src/memory/conflict.ts`, which both `db/` (write path, this story) and `query/` (rendering, Story 1.2) may import legally. The spine's other half — "`db/store.ts`" — is honored exactly.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Mutation testing, run per layer. Every assertion below was verified to go red against a deliberately broken implementation before the story was called done.

- **Predicate** (`scratchpad/mutate-conflict.mjs`, 8 mutations): apostrophe strip removed · negation asymmetry → presence · shared-context gate disabled · `MIN_SHARED_TOKENS` 2→1 · `MIN_OVERLAP_RATIO` 0.5→0.0 · both-members-one-side guard removed · stopwords no longer excluded from core · divergent-choice fallback added. **8/8 killed** — but only after two extra tests were written: the first pass left both threshold constants alive, because every case exercising one was independently blocked by the other. The gate as a whole was tested; the two numbers in it were not.
- **Write path** (`scratchpad/mutate-store.mjs`, 7 mutations): veto removed · new note never marked · prior never marked · subject guard removed · lookup includes superseded rows · conflicts never returned · supersede stops reusing the lookup. **7/7 killed** — after fixing a test of mine that filtered prepared SQL on the literal `kind = 'decision'`; the second round-trip it was meant to catch is parameterized (`kind = ?`) and sailed straight through. Now matched on shape.
- **Transport** (`scratchpad/mutate-mcp.mjs`, 5 mutations): conflict block never appended · appended unconditionally · prior text omitted · `cortex_resolve` reverts to relying on auto-supersede · `cortex_resolve` ignores the requested status. **5/5 killed.**

AC #4 measured against 10,401 `memory_items` rows, 200 iterations per arm: detection ON median 0.491 ms, OFF median 0.222 ms — **0.269 ms attributable to detection against a 5 ms budget.** The committed test asserts the same A/B at 60 iterations.

### Completion Notes List

**A defect this change introduced elsewhere, found and fixed before commit.** `cortex_resolve(note_id, status='superseded', replacement=…)` never called `updateNoteStatus` on the outgoing note — it relied on `insertNote`'s auto-supersede firing as a side effect. Vetoing that supersede for contradicting writes broke it, and a replacement that reverses its predecessor ("we cache X" → "we do not cache X") is the *common* shape for this call, not an edge case. The branch now sets the status explicitly. Two tests pin both statuses; both mutations die. `cortex_resolve` is explicit user resolution, which FR-1 says is the user's to make — the AD-17 veto only ever applied to *automatic* demotion.

**Two design corrections the tests forced.**
1. The shared-context gate originally counted every token, so `'the spool is appended by bash'` and `'the reflex is not appended by node'` overlapped at 67% on `the`/`is`/`by` and read as a contradiction. Structural words are now excluded from the core. This is a second, separate stopword list on purpose — `tokenize.ts`'s `LOW_SIGNAL_TOKENS` strips `without`, `do`, `does` and `did`, which are the exact tokens this module exists to read. A startup assertion fails the build if the two sets ever overlap.
2. `on`/`off` was dropped from the antonym lexicon. `on` is overwhelmingly a preposition, and `enable`/`disable` already covers the toggle case. Every pair in that list is a fresh way to produce a false positive; the story said each must earn its place, and this one did not.

**Eval gate: zero delta on all five suites**, as the story predicted — eval scenarios seed `memory_items` directly through `seedStoreFromScenario` and never touch `insertNote`, so no fixture exercises the new write path. Worth knowing for Story 1.2: that also means **no locked suite currently covers contested rendering**, so 1.2's `[contested]` marker will need a fixture of its own to be gated at all.

**AD-5 does not apply** — no new `memory_items` kind. Contested notes keep `note:decision` / `note:insight`.

**Not done, deliberately:** hotness-tier demotion and its veto (Story 1.4), and `[contested]` rendering (Story 1.2). `buildNoteMemoryText` still emits the pre-existing `Conflict: true` line, and `state.ts` still renders the pre-existing `[conflict]` marker — both predate this story and are 1.2's to rename.

### File List

- `src/memory/text.ts` — new; `TOKEN_PATTERN` + `stemLite` lowered out of `query/`
- `src/memory/conflict.ts` — new; the contradiction predicate
- `src/query/tokenize.ts` — modified; re-exports the moved primitives, surface unchanged
- `src/db/store.ts` — modified; detection, supersede veto, `NoteConflict`/`InsertedNote`
- `src/transports/mcp.ts` — modified; conflict block in `cortex_note`, explicit status in `cortex_resolve`
- `src/index.ts` — modified; new public exports
- `tests/conflict.test.ts` — new; 17 predicate tests
- `tests/store.test.ts` — modified; write-path and AC #4 cost tests
- `tests/mcp.test.ts` — modified; transport reporting and `cortex_resolve` regression tests
- `CLAUDE.md` — modified; core files and expected behavior
- `README.md` — modified; contradiction detection section, tool table, usage

### Change Log

- 2026-07-27 — Story 1.1 implemented. FR-1 contradiction detection at note write time, with the AD-17 supersede veto. 563 tests pass (up from 531); `npm run build`, `npm run lint` and `npm run gate` all clean, gate at zero delta on 5 suites.
