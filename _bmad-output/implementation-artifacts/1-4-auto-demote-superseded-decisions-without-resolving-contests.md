---
baseline_commit: 1ba3949
---

# Story 1.4: Auto-demote superseded decisions without resolving contests

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user whose decisions evolve,
I want a newer decision to cool its predecessor automatically,
So that stale guidance stops surfacing without me closing every note by hand.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.4 (lines 313-334). Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** an active decision on subject S in state `hot`
   **When** a new, non-contradicting decision is written on subject S
   **Then** the older item moves at least one tier colder
   **And** it remains retrievable for temporal queries such as `old`, `history`, and `what did we decide before`.

2. **Given** a new decision on subject S that **contradicts** the active decision on S
   **When** the write is processed
   **Then** conflict detection marks both contested
   **And** **neither** item's state changes (AD-17)
   **And** demotion resumes only after the conflict is closed via `cortex_resolve`.

3. **Given** an active `note:blocker` on subject S
   **When** a new decision is written on subject S
   **Then** the blocker is not demoted.

### AC assessment — one is a behavior REVERSAL, two are already true and need pinning

#### Note 1 — AC #1 reverses current behavior; an existing test asserts the opposite.

Today a superseded note maps to state `archived` (`memoryStateForNote`, `src/memory/items.ts:17-19`), and `archived` is **hard-excluded from retrieval by SQL** — `searchMemoryItems` carries `AND mi.state != 'archived'` (`src/db/store.ts:2331`), as do the semantic and recent-item queries. A superseded decision is not "very cold" today; it is *invisible*. `tests/recall.test.ts:75` ("excludes superseded notes") pins that invisibility, and `tests/state.test.ts:268` pins it for state.

AC #1's "remains retrievable" therefore means: **stop archiving on supersede**. The recall test must be rewritten to the new contract — active ranks above superseded, superseded reachable and labeled — not deleted. This is the deliberate, AC-driven part of the story; flag it in the commit body.

#### Note 2 — AC #2's first two clauses shipped in Story 1.1. Only the third needs work, and that work is a test.

The AD-17 veto (contested priors are not superseded; neither side's state changes) is live at `src/db/store.ts:1485-1515` and heavily tested. The third clause — "demotion resumes only after the conflict is closed" — is already structurally true: the veto reads `conflict = 1`, and `cortex_resolve` clears `conflict` across the subject in scope. A subsequent decision then supersedes (and with this story, demotes) normally. **No production code should change for AC #2.** Write the end-to-end test: open contest → third decision leaves both sides untouched → resolve one side → fourth decision demotes the survivor.

#### Note 3 — AC #3 is already structurally true. Pin it, do not build it.

The supersede filter is `prior.kind === opts.kind` and only `decision`/`intent` writes supersede at all (`src/db/store.ts:1503-1506`). A decision on subject S can only ever supersede another *decision* — a blocker on S is not in the candidate set. Write the pinning test; touch nothing.

## The mechanism — read this before any code

**A one-time state write does not survive.** `deriveMemoryItemState` (`src/memory/hotness.ts:125-145`) recomputes every non-pinned, non-archived item's state from its hotness score on **every working-set refresh** — `buildHeader`, `buildFullState`, and the SessionStart brief all call `refreshMemoryHotness`, which persists the recomputed states. A freshly superseded decision scores hot-range (importance 0.9×5 + decision kind bonus + created-today 2.6 + access bonuses ≫ 7), so writing `state = 'warm'` at supersede time gets flipped back to `hot` on the next refresh. Story 1.2's "assert a property vs. test it" lesson applies: a demotion test that never calls `refreshMemoryHotness` will pass against this broken design.

**The durable channel is the projected text.** `buildNoteMemoryText` writes `Status: superseded` as its own line the moment the status flips (`src/memory/items.ts:60-62` — any non-active status). The `resolved` close-out already works exactly this way: `deriveMemoryItemState` sniffs `status: resolved` → `cold` on every recompute, `touchMemoryItems`' SQL CASE refuses to reheat it, `stalePenalty` pushes it down, and renderers label it `(resolved)`. **Superseded must join `resolved` at every one of those sites, with one difference: graduated instead of flat.**

The design, in full:

- **`demoteMemoryState(state)`** — new pure helper in `src/memory/items.ts`: `hot→warm`, `warm→cold`, `cold→cold`, `pinned→pinned`, `archived→archived`. Floor at `cold`, never `archived` — archiving is what AC #1 exists to stop. Pinned is explicit user intent and is never auto-demoted (matches `touchMemoryItems`' CASE).
- **`isSupersededMemoryText(text)`** — new pure predicate in `src/memory/items.ts`: note-text line-exact match on `status: superseded` (trimmed, case-insensitive), the `isContested` discipline from 1.2. It must live in `memory/`, not `query/render.ts`, because `hotness.ts` needs it and `memory/ → query/` violates AD-1's layer direction. Reuse it from `query/` (legal direction).
- **`memoryStateForNote(kind, 'superseded')` → `'cold'`** (was `'archived'`). This is the fresh-projection landing: the schema backfill (`src/db/schema.ts:825`) and a sync with no pre-existing item. Signature unchanged — both callers verified (`schema.ts:825`, `store.ts:780`; nothing else, nothing in `src/index.ts`).
- **`syncMemoryItemForNote` preserves state for an already-superseded note.** Re-syncs happen (`markConflict`, `clearConflictsForSubject`, resolve paths); if each re-sync re-derived or re-demoted, the tier would walk downward or oscillate. Rule: `note.status === 'superseded'` and an item exists → pass the existing item's state through; otherwise `memoryStateForNote` as today. The *demotion step happens exactly once, at the transition*, in the two transition sites:
  - `insertNote`'s supersede block — after the status UPDATE and the `syncMemoryItemForNote(supersededId)` loop, read each superseded note's memory item, and write `demoteMemoryState(item.state)` via `updateMemoryItemStates` **inside the same transaction**.
  - `updateNoteStatus(id, 'superseded')` (`store.ts:1643`) — same step. Manual supersede via `cortex_resolve` must not keep archiving while auto-supersede demotes; `resolved` already lands retrievable-cold, and an inconsistent close-out pair is a trap. The `resolved` path through this function is untouched.
- **`deriveMemoryItemState`**: superseded → compute the score tier as normal, then return `demoteMemoryState(tier)`. Refreshes now *agree* with the transition write instead of overwriting it: a hot-scoring superseded item derives `warm`, capped below `hot` forever; as the score decays it walks to `cold` and stays reachable. Place the check after the pinned/archived early-return, beside the resolved branch.
- **`stalePenalty`**: superseded → −1.6, exactly the resolved treatment one line up. Accelerates natural decay of retired guidance.
- **`touchMemoryItems`** (`store.ts:2426`): add `WHEN lower(text) LIKE '%status: superseded%' THEN state` beside the resolved branch — *preserve*, don't reheat to `hot`. Retrieval reinforcement raises the score, and the derive cap turns that into at most `warm`. SQL LIKE is substring, not line-exact — same pre-existing divergence the resolved branch has; note it, don't fix it here.
- **Renderers**: `(superseded)` label in `renderMemoryLine` (`render.ts:348`) and `renderNoteBullet` (`state.ts:261`), in the same slot as `(resolved)` — the two are mutually exclusive by status. A retired decision surfacing unlabeled *is* the "stale guidance" FR-4 exists to stop.
- **Unprompted channels must exclude superseded items — this is the 1.2 lesson, pre-empted.** `BRIEF_STATES` (`session-brief.ts:20`) and `ACTIVE_REFLEX_STATES` (`reflex.ts:32`) both include `warm`, and a hot-scoring superseded decision now derives `warm` — *eligible for both channels*, where `resolved` never was (it lands `cold`, outside both sets, which is why resolved needed no explicit filter). Add an `isSupersededMemoryText` skip to the candidate loop in `buildSessionBrief` and to the reflex candidate filter. Without these two lines, the SessionStart brief and the reflex whisper present a just-retracted decision as settled context.
- **`state.ts` working sections**: a warm superseded decision can rank into `renderWorkingNotes` — accepted, with the `(superseded)` label carrying the honesty. It is one tier down, takes the stale penalty, and cannot be reheated past warm, so it decays out; that is the graduated model working as specified. `resolveCurrentSessionNotes` is safe already (reads `getActiveNotes`, a `status = 'active'` SQL filter).

**What deliberately does NOT change:** `retrieveMemory` scoring code (`STATE_BONUS`, `temporalBonus`, `deriveTemporalIntent`) — retrievability comes from leaving the archived exclusion, not from new bonuses. "what did we decide before" contains no temporal keyword and needs none: the item is in the FTS candidate set and matches lexically. If empirical probing shows the temporal fixture cannot rank the old item into results at all, a `preferOld` bonus for superseded text is the fallback lever — use it only if needed, and say so. Old databases keep their pre-1.4 `archived` items archived: `deriveMemoryItemState` and the sync both preserve `archived`, so the change is forward-only. No migration, no `SCHEMA_VERSION` bump, and **AD-5 does not apply** (no new `memory_items` kind).

## Tasks / Subtasks

- [x] **Task 1 — Pure helpers in `src/memory/items.ts`** (AC: #1)
  - [x] `demoteMemoryState` and `isSupersededMemoryText` as specified above; `memoryStateForNote` superseded → `'cold'`. Export all from `src/index.ts` (repo rule: every new public symbol).
  - [x] Unit tests: every tier through `demoteMemoryState`; predicate line-exact (mid-sentence `status: superseded` in content does not fire; own-line does; case/whitespace tolerated) — mirror `isContested`'s test block.

- [x] **Task 2 — Transition-site demotion in `src/db/store.ts`** (AC: #1, #2)
  - [x] `syncMemoryItemForNote` state pass-through for already-superseded notes; demotion step in `insertNote`'s supersede block (inside the IMMEDIATE transaction) and in `updateNoteStatus` for `'superseded'` only.
  - [x] Tests (`tests/store.test.ts`): hot→warm on auto-supersede; warm→cold; cold stays cold; **re-sync idempotence** — `markConflict`/resolve-path re-syncs do not step the tier again; manual `updateNoteStatus(id,'superseded')` demotes identically; `resolved` path byte-unchanged.
  - [x] AC #2 end-to-end: contest open → third non-contradicting decision leaves both contested sides' states untouched → `cortex_resolve` one side → fourth decision supersedes AND demotes the survivor. AC #3: blocker on S untouched by a decision write on S, state and status both.

- [x] **Task 3 — Durable derivation in `src/memory/hotness.ts`** (AC: #1)
  - [x] `deriveMemoryItemState` demote-after-derive branch; `stalePenalty` −1.6.
  - [x] **The adversarial test this story lives or dies on:** supersede a hot decision, then call `refreshMemoryHotness` (or `selectWorkingMemoryItems`) and assert the item is still not `hot` *after* the refresh — with a pre-assertion that its raw hotness score is genuinely in the hot range, so the test fails loudly if the fixture stops being adversarial. Then `touchMemoryItems` it repeatedly and assert it caps at `warm`.

- [x] **Task 4 — Surfaces** (AC: #1)
  - [x] `(superseded)` label in `renderMemoryLine` + `renderNoteBullet`; superseded skip in `buildSessionBrief` + reflex candidate filter.
  - [x] Enumerate surfaces as *surfaces* (the 1.2 rule): decide explicitly for all of recall, brief, state sections, `Current session:`, `Hot:` highlights, `Resume:`, SessionStart brief, reflex. `renderResumeCandidate` and `renderHeaderHighlights` filter on `hot`/`pinned` — a superseded item cannot reach them (capped at warm); state that in the story record rather than editing them.
  - [x] Tests: label on both renderers; brief with a warm superseded decision seeded — bullet absent; reflex — no whisper for a superseded candidate that would otherwise qualify (build it warm, high-score, subject-anchored, and pre-assert it *would* fire without the filter by asserting the unfiltered candidate list, or by flipping the status and watching it fire).
  - [x] Rewrite `tests/recall.test.ts:75` and `tests/state.test.ts:268` to the new contract. Check `tests/e2e.test.ts:162` still holds (it tolerates superseded appearing; verify, don't assume).

- [x] **Task 5 — Lock it in the eval gate** (beyond-AC, the 1.2 Deviation-A precedent: no AC gates this, so build the gate)
  - [x] New `eval/suites/superseded-history.json` + baseline, together. Seed: active decision (hot, recent), superseded predecessor (`Status: superseded` own line in text, `cold`, aged), one noise item. Fixture A, plain topic: `expected_top` = active decision, `expect_output_contains: ["(superseded)"]` — locks both retrievability and the label. Fixture B, temporal topic (`old`/`history` wording): superseded item's content in `expect_output_contains`. Probe budgets/ranks empirically before locking (the 1.3 method); timestamps out of needles; `recall_at_3` arithmetic checked (`allowed` minimal).
  - [x] Verify red-without-feature: revert the archived→cold mapping locally, run the gate, watch the suite fail (superseded item vanishes → needles missing), restore.
  - [x] `Baseline-Regenerated:` trailer in the commit body. Zero delta expected on all seven existing suites — none seeds `Status: superseded` or `Status: resolved` text (verified by grep); if any moves, a sniff is firing where it must not.

- [x] **Task 6 — Verification and docs**
  - [x] `npm run build && npm run lint && npx vitest run` (baseline 705 tests / 27 files green at `1ba3949`) and `npm run gate` (7 suites green: alternatives=237, budget=178, contested=117, kind-ordering=103, rename-moved=97, stale-label=164, stemming=93).
  - [x] Mutation-test every new assertion (break → red → restore). At minimum: demotion never applied · applied on every re-sync (idempotence) · derive branch dropped (refresh resurrects to hot) · touch reheats superseded · brief filter dropped · reflex filter dropped · label never rendered · predicate substring instead of line-exact.
  - [x] `CLAUDE.md` § Expected Behavior: supersede now demotes one tier (floor cold) instead of archiving; forward-only for old archived rows; retrievable + `(superseded)` labeled; brief/reflex exclusion; touch cannot reheat past warm; GC note — superseded items no longer reach `archived`, so the archived-GC rule no longer collects them, same as `resolved` today. `README.md`: a short section beside contradiction detection. Same commit as behavior.
  - [x] Stage `CLAUDE.md` surgically (rebuild blob from `HEAD:CLAUDE.md` + only these hunks; never `git add CLAUDE.md` wholesale). `.mcp.json` and `.serena/` untouched.

## Dev Notes

### Files touched

| File | Change |
| --- | --- |
| `src/memory/items.ts` | `demoteMemoryState`, `isSupersededMemoryText`, `memoryStateForNote` superseded→cold |
| `src/memory/hotness.ts` | derive demote-branch, stale penalty |
| `src/db/store.ts` | sync pass-through, two transition sites, touch CASE |
| `src/query/render.ts`, `src/query/state.ts` | `(superseded)` label |
| `src/query/session-brief.ts`, `src/query/reflex.ts` | exclusion filters |
| `src/index.ts` | exports |
| `eval/suites/` + `eval/baselines/` | +`superseded-history` |
| tests | store, hotness, recall, state, session-brief, reflex; rewrite two pinned-invisibility tests |

### Traps, from 1.1–1.3's review rounds

- **Test the property against the refresh, not against the write.** The single most likely wrong implementation (write `warm` once) passes every test that skips `refreshMemoryHotness`.
- **Idempotence under re-sync** is where the tier-stepping design breaks; `clearConflictsForSubject` re-syncs every note on the subject.
- **Pre-assert adversarial preconditions** (hot-range score before demotion; reflex candidate would fire without the filter).
- **Don't extend the substring-sniff surface.** New predicates are line-exact; only the SQL CASE inherits LIKE, noted.
- Import specifiers end in `.js`; temp dirs via `os.tmpdir()`; `npm run lint` does not typecheck `tests/`.

### References

- [Source: `epics.md:313-334`] — ACs verbatim. [Source: `prd.md:145-152`] — FR-4: tiers "(hot→warm, warm→cold)", blocker exclusion, temporal retrievability. [Source: `ARCHITECTURE-SPINE.md` § AD-17] — contradiction suppresses demotion. [Source: `src/memory/hotness.ts:125-145`] — why one-time writes don't survive. [Source: 1.2 review record] — surface enumeration; unprompted channels matter most.

## Dev Agent Record

### Agent Model Used

claude-fable-5

### Debug Log References

**Mutation testing** (`scratchpad/mutate-1-4.mjs`, 12 mutations against the eight touched test files + the gate): **12/12 killed.** Demotion never runs · sync re-derives instead of preserving (idempotence) · `updateNoteStatus` demotes on every write instead of the transition · derive branch dropped (refresh resurrects to hot) · stale penalty dropped · touch reheats · brief filter dropped · reflex filter dropped · both labels never emitted · predicate substring instead of line-exact · demotion floor broken (cold→archived).

The first campaign run reported 6/12 with six "anchor missing" — every multi-line anchor failed because the working-copy sources are CRLF while the harness anchors were LF. The harness now adapts anchors to the file's line endings. A campaign that cannot apply its mutations is a false all-clear, the same shape as 1.3's dist-vs-src mistake; the lesson generalizes to "verify the mutation actually applied".

**One planning claim was falsified mid-story, and the correction is the design.** The story predicted "a fresh warm decision demotes to cold and the working set's cold filter keeps it out of the default state". False: the derive layer recomputes state from the hotness score on every refresh, and a *fresh* superseded item scores hot-range, so it settles at `warm` (one tier below its scored tier) — visible in the working sections, which is why the `(superseded)` label on `renderNoteBullet` is load-bearing and why the state test seeds an *aged* predecessor for the decays-out case. The transition write and the derive rule agree wherever stored state matches scored tier; where they briefly disagree (fresh warm-stored/hot-scored), the derive layer is the authority, by design.

**The AC #2 e2e test's first fixture was wrong in an instructive way.** After resolving side A ("flush at turn end") of a contest, a fourth decision reading "flush the spool only at the size threshold" was *vetoed again* — because it genuinely contradicts the surviving side B ("do **not** flush at turn end"), signal `negation`. That is the detector working, not demotion failing to resume. The fixture now retracts the negated side so the survivor and the fourth write share polarity. Probed with a live store before rewriting rather than assumed.

**Red-without-feature, done twice because the first run proved nothing.** The first gate run with the label disabled failed on "no baseline exists" — which masks whatever the fixtures would have said. Regenerated the baseline first, then re-ran the mutation: both fixtures fail on the missing `(superseded)` needle, and the gate names them. Restored, 8 suites green.

### Completion Notes List

**AC #1 is a behavior reversal, delivered in two coupled halves.** The transition half: `memoryStateForNote('superseded')` lands `cold` instead of `archived`, and the two transition sites (`insertNote`'s supersede block, `updateNoteStatus`) demote the existing item exactly one tier via `demoteMemoryState` — floored at cold, pinned untouched. The durable half: `deriveMemoryItemState` derives a superseded item one tier below its scored tier, so refreshes agree with the demotion instead of flipping a hot-scoring predecessor back to hot; `touchMemoryItems` preserves rather than reheats; `stalePenalty` pushes it down like resolved. Without the second half, the first is overwritten on the next working-set refresh — the load-bearing test calls `refreshMemoryHotness` *after* the supersede and pre-asserts the score is genuinely hot-range.

**Idempotence under re-sync is guarded structurally.** `syncMemoryItemForNote` passes an existing item's state through for superseded notes; the demotion lives only at the transitions, and `updateNoteStatus` demotes only when the status actually changed. `markConflict`/`clearConflictsForSubject` re-syncs — which touch every note on a subject — cannot step the tier.

**AC #2 needed no production code**, as the story predicted: the veto reads `conflict = 1` and `cortex_resolve` clears it, so demotion resumes by construction. Pinned end-to-end, including states, with the fixture correction described above. **AC #3 likewise** — supersede matches `prior.kind === opts.kind` and blockers never supersede; pinned with status and state assertions.

**Unprompted channels are explicitly filtered — the part no AC names but 1.2's review round proved matters most.** A superseded decision demotes to `warm` at best, which sits *inside* `BRIEF_STATES` and `ACTIVE_REFLEX_STATES` — unlike `resolved`, which lands `cold` and filters itself. `buildSessionBrief` and the reflex candidate filter now skip superseded items. The reflex test pre-asserts its candidate clears every other gate (state warm, score ≥ 9, scope bonus, anchor match) so it cannot pass vacuously; the brief test carries an active twin differing only by the status line.

**Rendering:** `(superseded)` in `renderMemoryLine` and `renderNoteBullet`, sharing the `(resolved)` slot — a status is exactly one of the three. `Resume:`/`Hot:` filter on hot/pinned, which a superseded item can no longer be, so they need no edit — stated, not assumed.

**Forward-only:** pre-1.4 `archived` rows stay archived (derive and sync both preserve archived). Superseded items no longer reach `archived`, so the archived-GC rule no longer collects them — the same lifecycle `resolved` already has. No migration, no `SCHEMA_VERSION` bump, AD-5 not triggered.

**Beyond-AC, following 1.2's Deviation-A precedent:** locked suite `superseded-history` (+baseline), gating the label and reachability under plain and temporal topics. Its comment states the gate's honest scope: seeds bypass `insertNote`, so the write-path mapping is pinned by unit tests, and what goes red without the feature is the renderer's label.

**Existing pinned-invisibility tests rewritten, not deleted:** `recall.test.ts` ("excludes superseded notes" → ranks-below-and-labeled + temporal reachability), `state.test.ts` ("does not render superseded notes" → aged-decays-out + warm-renders-labeled), plus two stale `'archived'` assertions in `store.test.ts` updated with FR-4 comments. `e2e.test.ts` held unchanged.

### File List

- `src/memory/items.ts` — modified; `demoteMemoryState`, `isSupersededMemoryText`, `memoryStateForNote` superseded→cold
- `src/memory/hotness.ts` — modified; derive demote-branch, superseded stale penalty
- `src/db/store.ts` — modified; sync state pass-through, `demoteMemoryItemForNote`, two transition sites, touch CASE
- `src/query/render.ts` — modified; `(superseded)` label in `renderMemoryLine`
- `src/query/state.ts` — modified; `(superseded)` label in `renderNoteBullet`
- `src/query/session-brief.ts` — modified; superseded exclusion
- `src/query/reflex.ts` — modified; superseded exclusion
- `src/index.ts` — modified; two new public exports
- `tests/items.test.ts` — new; 11 tests for the pure helpers
- `tests/hotness.test.ts` — modified; +5 durable-demotion tests
- `tests/store.test.ts` — modified; +9 transition tests, 2 stale assertions updated
- `tests/render.test.ts` — modified; +3 label tests
- `tests/state.test.ts` — modified; 1 rewrite + 1 new working-set label test
- `tests/session-brief.test.ts` — modified; +1 exclusion test
- `tests/reflex.test.ts` — modified; +1 exclusion test
- `tests/recall.test.ts` — modified; 1 rewrite + 1 temporal reachability test
- `eval/suites/superseded-history.json` — new; locked FR-4 fixture
- `eval/baselines/superseded-history.json` — new; its baseline
- `CLAUDE.md` — modified; five Expected Behavior bullets, one corrected
- `README.md` — modified; "Superseded decisions cool instead of vanishing", one stale sentence corrected

### Change Log

- 2026-07-27 — Story 1.4 implemented. Supersede demotes one tier (floor cold) instead of archiving; durable via the derive layer; `(superseded)` label; brief/reflex exclusion; new locked eval suite. 737 tests (+32), 8 gate suites, 12/12 mutations killed.
