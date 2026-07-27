---
baseline_commit: c259710
---

# Story 1.2: Render contested items in retrieval

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an agent recalling a topic,
I want contested memories marked as contested,
so that I do not act on one side of an unresolved disagreement without knowing.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.2. Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** a retrieved item with `conflict = 1`
   **When** recall, brief, or state renders it
   **Then** it carries a `[contested]` marker costing no more than 4 tokens.

2. **Given** both sides of a contested pair rank within the returned set
   **When** results are rendered
   **Then** the two appear adjacently.

3. **Given** the output budget binds
   **When** contested items are rendered
   **Then** the marker is subject to the same budget rules as all other content.

4. **Given** the locked eval suites
   **When** this change is applied
   **Then** no suite regresses on `top1_hit`, `recall_at_3`, or `output_tokens`.

### AC deviations — flagged, not implemented around

**Three, and all three change what you build. Read before Task 1.**

#### Deviation A — AC #4 gates nothing as written. Add a fixture anyway.

`grep -rn conflict eval/` returns **zero matches**. No locked suite seeds a contested item, so no suite can regress on contested rendering, so AC #4 is satisfied by doing nothing at all. It is a regression guard with no subject.

Compare Story 1.3's AC #4 for the same class of change: *"Given a **new locked eval fixture** exercising a decision that carries alternatives… the fixture asserts the `already rejected:` line is present and within budget."* That is a gate. 1.2's is a formality.

**This story adds `eval/suites/contested.json` + its baseline** (Task 5). Without it the marker ships ungated and the *next* change to it regresses silently. AD-5 does not compel this — no new `memory_items` kind is introduced — so this is a deliberate addition beyond the AC, not a rule being followed.

#### Deviation B — AC #2's "recall, brief, or state" cannot mean all three for adjacency.

AC #1 names three surfaces. AC #2 says "when results are rendered" without naming one. Read as *all three*, AC #2 is **unimplementable in state and destructive in brief**:

| Surface | Ordering today | Adjacency verdict |
| --- | --- | --- |
| `recall` | flat, `retrieval_score` desc | **Implementable.** Reorder freely. |
| `brief` | sorted by `KIND_PRIORITY` (decision→intent→blocker→insight), score as tiebreak (`brief.ts:52-58`) | A decision/insight pair can only be made adjacent by **breaking brief's primary sort**. |
| `state` `renderWorkingNotes` | grouped into labelled sections per kind (`state.ts:250-271`) | A decision and an insight live in **different sections under different headings**. Adjacency is structurally impossible without deleting the section structure. |

The PRD is narrower than the epic and resolves it: *"A contested item and its counterpart appear adjacently **in recall output** when both rank in the returned set"* [prd.md:133]. The epic's own §4.1 summary agrees — "counterpart items appear adjacently" is listed against FR-2 with no surface expansion.

**Therefore: adjacency is implemented in `recall` only** (Task 3). In `brief` and `state`, a same-kind contested pair already lands in the same bucket and stays adjacent by score; a cross-kind pair does not, and that is accepted. Do **not** break `KIND_PRIORITY` or the state sections chasing it. Record this in the Dev Agent Record rather than silently shipping a partial AC.

#### Deviation C — the marker already exists. This is a rename, not a new feature.

`state.ts:243` has rendered `' [conflict]'` since before this release. Story 1.1's Completion Notes flagged it explicitly: *"`state.ts` still renders the pre-existing `[conflict]` marker — 1.2's to rename."* Do not plan or build this as greenfield; you will end up with two markers for one condition.

## Tasks / Subtasks

- [x] **Task 1 — One source of truth for the contested predicate and marker** (AC: #1)
  - [x] Add to `src/query/render.ts` (it is already the shared renderer; `state.ts` imports from it):
    ```ts
    /** Marker text for a contested item. 12 chars → 3 tokens under estimateTokens (AC #1 caps at 4). */
    export const CONTESTED_MARKER = ' [contested]';

    export function isContested(item: ParsedMemoryItem): boolean {
      return item.text.toLowerCase().includes('conflict: true');
    }
    ```
  - [x] **Why text-sniffing and not a column — this is forced, not chosen.** `ParsedMemoryItem` (`src/db/store.ts:255-270`) has **no** `conflict` field. The signal reaches renderers only as the literal line `Conflict: true` inside `item.text`, written by `buildNoteMemoryText` (`src/memory/items.ts:57`). Adding a real column means a migration and a `SCHEMA_VERSION` bump — and R1 reserves the **single** version bump for Story 3.1 (`epics.md` Finding 2 / AD-11). Sniffing also matches the `status: resolved` precedent sitting one line away at `render.ts:117`.
  - [x] Inherited fragility — note it in a comment, do not fix it here: a note whose *content* literally contains "conflict: true" false-fires. Identical exposure already exists for `resolved`. Fixing it belongs with the column, in a release that can afford the bump.
  - [x] Do **not** add a second copy of this predicate in `state.ts`. `src/memory/kind-weights.ts` is the repo's precedent for "one source of truth" and this follows it.
  - [x] Export both from `src/index.ts` — repo convention is that every new public symbol lands there in the same change.

- [x] **Task 2 — Render the marker on all three surfaces** (AC: #1, #3)
  - [x] `src/query/render.ts:108` `renderMemoryLine` — insert the marker into the `note:` branch, **before** `resolved`, matching `state.ts`'s existing order:
    `${label}${timestampPart}: ${subject}${content}${contested}${resolved}${renderReferenceLabel(item)}`
  - [x] `src/query/state.ts:241` `renderNoteBullet` — replace the inline `' [conflict]'` sniff with `isContested(item) ? CONTESTED_MARKER : ''`. **Rename only**; keep its position between content and `resolved`.
  - [x] This is the whole of AC #1. `recall.ts:99` and `brief.ts:62` both route through `renderMemoryLine`, so they inherit it with no edit. `state.ts` needs the one rename because `renderNoteBullet` is its own renderer — and it feeds **both** `renderWorkingNotes` (line 267) and the `Current session:` block (line 302).
  - [x] **AC #3 needs no code.** `assembleBudgeted` (`recall.ts:49-81`) costs whole rendered lines via `estimateTokens`; a longer line is simply a more expensive line. Do not add marker-specific budget handling — that would *violate* AC #3, which asks for the same rules, not special ones. Write the test (Task 4), not a mechanism.
  - [x] **Do not mark `buildLeadLine`** (`recall.ts:36-42`, also used by `brief.ts:66`). Decided, not overlooked: the lead is a pointer at the top item, and that item is itself rendered as evidence line 1, which carries the marker. `assembleBudgeted` always keeps at least one evidence line (`recall.ts:61`), so a contested top result can never lose its marker to the budget. Marking both places double-charges tokens for one signal.

- [x] **Task 3 — Adjacency in recall** (AC: #2, #4)
  - [x] Add to `src/query/render.ts`:
    ```ts
    /** Stable: pulls a contested item's counterparts up to sit directly after it. Never promotes past rank 0. */
    export function groupContestedAdjacent<T extends ParsedMemoryItem>(items: T[]): T[];
    ```
  - [x] Algorithm: walk in rank order; emit each unemitted item; when the emitted item is contested and has a subject, immediately emit every later unemitted item that is contested and shares its **`(scope_key, subject)`** pair. Handles 3+ contested items on one subject naturally.
  - [x] **Pair on `(scope_key, subject)`, never `subject` alone.** Story 1.1 made detection scope-keyed — two branches can hold the same subject and *not* be a contested pair. `ParsedMemoryItem.scope_key` is present on every row.
  - [x] Apply in `src/query/recall.ts` **after** `retrieveMemory` returns and **before** the `evidence` map. Do **not** touch `retrieveMemory`.
  - [x] **This placement is what makes AC #4 structurally safe, not merely lucky.** `src/eval/harness.ts:198-199, 222, 242-244` computes `top1_hit` and `recall_at_3` from `retrieveMemory(...)` **directly**; only `output_tokens` and `expect_output_contains` read `recall()` (lines 201-206, 208). Reordering inside `recall()` therefore *cannot* move the two ranking metrics. Reordering inside `retrieveMemory` would move both. Keep it in `recall.ts`.
  - [x] Leave `logRetrieval(store, retrieval, rendered)` reading `retrieval.results` in original rank order — it logs what ranking produced, not what rendering displayed.
  - [x] Do not apply grouping in `brief` or `state`. See Deviation B.

- [x] **Task 4 — Tests** (AC: #1, #2, #3)
  - [x] `tests/render.test.ts` — `isContested` true/false; `CONTESTED_MARKER` costs ≤ 4 tokens via `estimateTokens` (assert the AC number, not the current value); `renderMemoryLine` emits it for a contested note and omits it otherwise; marker order is contested-then-resolved when both apply.
  - [x] `groupContestedAdjacent`: a contested pair split by an unrelated higher-ranked item ends adjacent; **rank 0 never changes**; same subject in two different `scope_key`s is *not* paired; a contested item whose counterpart is absent from the set is left alone; a non-contested item sharing the subject is not pulled up; 3-way contest groups together; input order is otherwise preserved.
  - [x] `tests/recall.test.ts` — contested pair renders adjacently in real `recall()` output; **AC #3:** with a budget tight enough to trim, the marker is trimmed as part of its line, and the run does not exceed budget. Assert on rendered output strings — existing suites do, and `project-context.md` requires pinning observable behavior.
  - [x] `tests/brief.test.ts`, `tests/state.test.ts` — marker present on their surfaces. For `state`, cover **both** `renderNoteBullet` consumers: a working-notes section and the `Current session:` block.
  - [x] Assert the string `[conflict]` no longer appears anywhere in rendered output — this is the rename half of the change and nothing else will catch a leftover.
  - [x] **Mutation-test every new assertion before calling the story done.** Story 1.1 needed three rounds and 24 findings; two of its mutations survived initially because tests pinned the design rather than the behavior. For each new test: break the implementation, confirm red, restore. At minimum mutate: marker never emitted · emitted unconditionally · `groupContestedAdjacent` returns input unchanged · pairing drops `scope_key` · grouping promotes past rank 0.
  - [x] `npm run lint` does **not** typecheck `tests/` (tsconfig excludes the tree; vitest transpiles without checking). Type errors there are invisible to both commands.
  - [x] Import specifiers end in `.js` even from `.ts`, including in `tests/`. Temp dirs via `os.tmpdir()`, never a literal `/tmp`.

- [x] **Task 5 — Lock the behavior in the eval gate** (AC: #4, Deviation A)
  - [x] New `eval/suites/contested.json`. Seed two `note:decision` items, same `subject`, same `scope_key`, each with `Conflict: true` on its own line in `text` — that is exactly what `isContested` reads. `ScenarioMemoryItem` (`src/eval/seed.ts:8-22`) has no `conflict` field and does not need one.
  - [x] Separate the pair in rank order with a third, unrelated, non-contested item that also matches the topic — otherwise the fixture passes whether or not `groupContestedAdjacent` exists.
  - [x] Assert via `expect_output_contains: ["[contested]"]`. Set `expected_top` to the higher-scoring contested item and list the other under `allowed`.
  - [x] Generate the baseline with `cortex eval-gate --regenerate-baseline contested`. **A first baseline for a new suite is a normal artifact, not a red-gate override** — but the commit body still carries `Baseline-Regenerated: <reason>`, because CI rejects a baseline change without one.
  - [x] Confirm the gate would fail without the feature: revert Task 2 locally, run `npm run gate`, watch `contested` go red, restore. A fixture that passes against the old code gates nothing — the exact defect Story 1.5 was written to prevent and which still reached `main` four times.
  - [x] Adding a suite means `eval/suites/` and `eval/baselines/` both grow by one. The gate fails on a **baseline with no suite** *and* a **suite with no baseline** (`gate.ts:383`, `gate.ts:402-407`) — land both together.
  - [x] No manifest to update: suites are auto-discovered by `readdirSync` over `eval/suites/*.json` (`gate.ts:129-137`). Note that any non-suite `.json` dropped in that directory fails the gate as "unrecognized file" — do not park scratch files there.

- [x] **Task 6 — Verification and docs**
  - [x] `npm run build && npm run lint && npx vitest run`
  - [x] `npm run gate` — expect **zero delta on the five existing suites**. No locked suite seeds `Conflict: true`, so no existing baseline can move. **If any of the five moves, stop and find out why** — that would mean the marker is firing on something that is not contested. Regenerating is never how a red gate goes green.
  - [x] **AD-5 does not apply** — no new `memory_items` kind. Contested items keep `note:decision` / `note:insight`. The new fixture is Deviation A's doing, not AD-5's.
  - [x] `CLAUDE.md` § Expected Behavior — the `[contested]` marker, the surfaces it appears on, and that adjacency is a recall-only guarantee. `README.md` if it documents recall output. Docs ship in the same commit as the behavior.

## Dev Notes

### Files being modified — current state

| File | Today | This story |
| --- | --- | --- |
| `src/query/render.ts:108` `renderMemoryLine` | Renders `note:` lines with `(resolved)` sniffed from text (line 117). **Never rendered conflict.** | Gains `[contested]`; gains `isContested`, `CONTESTED_MARKER`, `groupContestedAdjacent`. |
| `src/query/state.ts:241` `renderNoteBullet` | Own renderer. Emits `' [conflict]'` inline (line 243). Feeds `renderWorkingNotes` (267) and `Current session:` (302). | Rename to the shared helper. No behavior change beyond the marker text. |
| `src/query/recall.ts:88-108` `recall` | Maps `retrieval.results` straight to evidence lines. | Groups contested items adjacently first. |
| `src/query/brief.ts` | Routes through `renderMemoryLine`. | **No edit.** Inherits the marker. |
| `src/memory/items.ts:57` `buildNoteMemoryText` | Emits `Conflict: true`. | **No edit.** This is the source signal; changing it would break the sniff. |
| `eval/suites/`, `eval/baselines/` | 5 suites, none contested. | +1 suite, +1 baseline. |

### `renderMemoryLine` has five call sites — one is not in the ACs

Serena-enumerated, complete:

1. `recall.ts:99` — AC surface
2. `brief.ts:62` — AC surface
3. `state.ts:341` `renderEvidenceSection` — AC surface
4. `state.ts:115` `renderHeaderHighlights` — AC surface; truncates to 110 chars via `renderMemorySnippet`, so the marker can be cut. That is correct AC #3 behavior, not a bug.
5. **`reflex.ts:175` `reflectMemory` — not named in any AC.**

Call site 5 inherits the marker automatically, and **that is the intended outcome, decided here rather than discovered later.** Reflex injects a single remembered item into the turn as settled context. Injecting one side of an open contest *unmarked* is precisely the failure FR-2 exists to prevent, in the one channel the agent cannot interrogate. Marking it is the more correct behavior.

Watch the budget: reflex output is `additionalContext` on every qualifying turn, and `project-context.md` warns that churn in injected content silently invalidates the model's prompt cache. Three tokens on an item that is genuinely contested is a fair trade; it is also bounded, because reflex emits at most one item.

### Must not break

- **`KIND_PRIORITY` in `brief`** and **the kind sections in `state`.** Deviation B. Adjacency does not reach them.
- **`retrieveMemory` ordering.** Task 3 places grouping in `recall.ts` for a specific reason — see the harness citation there. Moving it "up" into retrieval for reuse would convert AC #4 from structurally-safe to empirically-fragile.
- **Resolved-stays-cold.** `project-context.md`: resolved notes must not resurface in briefs, default state, or reflex. Story 1.1 made `cortex_resolve` clear `conflict` across the subject in scope, so a resolved note should carry no marker. Do not add logic that reintroduces one.
- **`logRetrieval`'s recorded order.** It records ranking output. Rendering order is a display concern.
- **The five existing baselines.** Zero delta expected. They are locked artifacts.

### Previous story intelligence (1.1 — done, 3 review rounds, 24 findings)

- **The gate's blind spot is real and this story inherits it.** 1.1 closed with: *"no locked suite currently covers contested rendering, so 1.2's `[contested]` marker will need a fixture of its own to be gated at all."* Task 5 is that fixture.
- **Eval scenarios never reach `insertNote`.** `seedStoreFromScenario` writes `memory_items` directly. So a fixture must seed the *projected text* (`Conflict: true`), not call the write path.
- **Tests that pin the design instead of the behavior slip through.** 1.1 shipped a test filtering prepared SQL on a literal `kind = 'decision'` when the real query was parameterized. Assert on shape and rendered output.
- **Mutation survival can mean the fix is wrong, not the test.** In 1.1 a "surviving" mutation exposed a repair that was worse than the original. Investigate survivors before assuming the test is at fault.

### Git intelligence

`e293977` → `5c0a9cf` → `c259710` is Story 1.1 across three rounds. Conventions confirmed in those diffs and to be matched here: lowercase Conventional Commit subjects; docs (`CLAUDE.md`, `README.md`) in the same commit as behavior; tests extended in the existing per-module files rather than new parallel ones.

**Uncommitted working-tree state to preserve:** `.mcp.json` and the `CLAUDE.md` § Agent Tooling block carry the user's own edits and are deliberately unstaged. Story 1.1 staged its `CLAUDE.md` changes surgically (`git hash-object -w --stdin` + `git update-index --cacheinfo`) to avoid sweeping them in. Do the same, or stage by explicit hunk. `.serena/` is untracked and stays that way.

### Latest technical information

No new dependency, no external API, no version-sensitive surface. `estimateTokens` is `Math.ceil(text.length / 4)` (`retrieval.ts:80-82`), so `' [contested]'` at 12 chars is exactly 3 tokens — inside AC #1's cap of 4, with one token of headroom. Assert against the AC's 4, not against 3.

### Project structure notes

Everything lands in existing files under the established layout. `render.ts` is the correct home for all three new symbols: it is `query/`-layer, already imported by `state.ts`, `recall.ts`, `brief.ts` and `reflex.ts`, and AD-1's one-way direction (`transports/` → `query/` → `memory/` + `scope/` → `db/`) is respected — nothing here needs to be reachable from `db/`, unlike Story 1.1's predicate.

No variance from the unified structure. One test file per module, named after it.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.2] — acceptance criteria, verbatim.
- [Source: `.../prd.md` § FR-2] — "`[contested]` marker in recall, brief, and state output"; adjacency scoped to **recall output**; "≤ 4 tokens per item and subject to the same output budget as everything else."
- [Source: `.../prd.md` § SM-5] — resolution rate ≥ 50% validates FR-1 **and FR-2**; a marker nobody acts on is a marker nobody sees.
- [Source: `.../ARCHITECTURE-SPINE.md` § AD-17] — binds FR-2; contested pairs are equals until a human breaks the tie. Rendering must not imply a winner: same marker, both sides, no ordering preference between them.
- [Source: `_bmad-output/project-context.md` § Retrieval-Quality Gate] — gate failure conditions, locked-artifact policy.
- [Source: `_bmad-output/implementation-artifacts/1-1-....md` § Completion Notes] — the gate blind spot this story closes.
- [Source: `src/eval/harness.ts:198-244`] — ranking metrics read `retrieveMemory`; output metrics read `recall()`. The reason Task 3 lands where it does.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

**Mutation testing** (`scratchpad/mutate-1-2.mjs`, 8 mutations against `tests/render.test.ts`, `tests/recall.test.ts`, `tests/state.test.ts`): marker never emitted · marker emitted unconditionally · marker reverts to `[conflict]` · grouping is a no-op · pairing drops `scope_key` · pairing drops the contested check · grouping hoists contested items past rank 0 · recall stops applying the grouping. **8/8 killed — but only on the second run.**

The first run left **`recall stops applying the grouping` alive**, and the reason matters more than the fix. In my integration scenario the two contested decisions were twins — same session, same age, same kind, same subject — so they scored identically (38.50 / 38.50) and the third note sorted below both. The pair was *already* adjacent by ranking, so `groupContestedAdjacent` was doing nothing and the test passed either way. This is the same defect class Story 1.1 shipped (a test filtering on literal `kind = 'decision'` against a parameterized query): the assertion described the intended design rather than exercising it. Rebuilt the scenario to age the losing side and warm the insight so ranking genuinely splits the pair (38.50 / 37.95 / 35.50), and added an explicit pre-assertion that retrieval order really is decision-insight-decision — so the test fails loudly if the fixture ever stops being adversarial.

**Backdating had to move after the contest is recorded.** Aging the losing note before writing the contradiction silently did nothing: `markConflict` calls `syncMemoryItemForNote`, which rewrites the projected `created_at`. Caught by the score probe showing 38.50 unchanged after a 60-day backdate.

**The eval fixture was verified to fail without the feature**, patching `dist/query/render.js` per mutation: grouping disabled → the `[contested]\nDecision [` needle goes missing; marker disabled → both needles go missing; restored → passes. Its first draft had the same trivial-pass flaw as the unit test — natural ranking was 53.00 / 45.30 / 35.50 with the pair already adjacent — so the insight was given an exact-phrase match, the shared subject, and an access count until it landed *between* the two sides at 47.10.

**AC #1 measured:** `estimateTokens(' [contested]')` = 3 against a cap of 4. The test asserts the AC's 4, not today's 3, so shortening stays legal and lengthening past the cap fails.

### Completion Notes List

**Deviation A honored — the AC's gate was empty, so the story built one.** `eval/suites/contested.json` + baseline is new, and it locks both halves of FR-2: the marker's presence and the adjacency reorder. Without it AC #4 would have passed by doing nothing. The needle `[contested]\nDecision [` deliberately carries no timestamp, because the scenario clock is generation-time and any timestamp in a needle would make the suite non-deterministic.

**Deviation B honored — adjacency is recall-only, and this is a partial AC by design.** `brief` sorts by `KIND_PRIORITY` and `state` renders kind-headed sections, so a cross-kind contested pair cannot be made adjacent in either without destroying the ordering those surfaces exist to provide. The PRD scopes the requirement to recall output for exactly this reason. Same-kind pairs still read together in both surfaces because they share a bucket. **A reviewer should check this call rather than assume it.**

**Deviation C honored** — `[conflict]` is gone, replaced everywhere by `[contested]`. The pre-existing `state.test.ts` assertion that pinned the old marker was updated; three new assertions now pin its *absence* across recall, brief and state, since nothing else would catch a leftover.

**Reflex inherits the marker, deliberately.** `reflex.ts:175` is the fifth `renderMemoryLine` caller and appears in no AC. It injects a single remembered item as settled context, so an unmarked side of an open contest is the worst instance of the failure FR-2 exists to prevent. Cost is bounded — reflex emits at most one item.

**Ranking metrics are structurally protected, not merely observed clean.** The reorder lives in `recall.ts`, never in `retrieveMemory`, because `src/eval/harness.ts:198-244` computes `top1_hit`/`recall_at_3` directly off retrieval and only `output_tokens` off `recall()`. Display order therefore *cannot* move the two ranking metrics. The five pre-existing suites came back at exactly their baseline token counts (178/103/97/164/93), as predicted — no locked suite seeds `Conflict: true`.

**One judgment call worth flagging.** Task 1 said to export the new symbols from `src/index.ts`. `render.ts` has never been exported there — not even `renderMemoryLine` — so these three are the only members of their module on the public surface, which reads oddly. I did it anyway: `project-context.md` states the rule unconditionally for *new* exported symbols, and partial-module export is already the pattern (`retrieval.ts` exports `estimateTokens`; `index.ts` does not re-export it). If a reviewer prefers render helpers stay internal, dropping the line is safe — nothing consumes them from outside `query/`.

**Not done, deliberately:** `buildLeadLine` is unmarked (the top item carries the marker on its own evidence line, and `assembleBudgeted` always keeps at least one), and no marker-specific budget logic exists — AC #3 asks for the *same* rules, so special-casing would have violated it.

### File List

- `src/query/render.ts` — modified; `CONTESTED_MARKER`, `isContested`, `groupContestedAdjacent`, marker in `renderMemoryLine`
- `src/query/state.ts` — modified; `[conflict]` → shared `[contested]` helper in `renderNoteBullet`
- `src/query/recall.ts` — modified; applies `groupContestedAdjacent` to display order
- `src/index.ts` — modified; three new public exports
- `tests/render.test.ts` — new; 20 tests for the predicate, marker cost, and grouping
- `tests/recall.test.ts` — modified; contested rendering, adjacency, budget, brief marker
- `tests/state.test.ts` — modified; marker on both `renderNoteBullet` consumers; old `[conflict]` assertion renamed
- `eval/suites/contested.json` — new; locked FR-2 fixture
- `eval/baselines/contested.json` — new; its baseline
- `CLAUDE.md` — modified; core files, contested rendering and recall-only adjacency
- `README.md` — modified; "Contested items in retrieval" section

### Change Log

- 2026-07-27 — Story 1.2 implemented. `[contested]` marker across recall/brief/state/reflex (renaming the pre-R1 `[conflict]`), contested-pair adjacency in recall, new locked eval suite. 654 tests (+30), 6 gate suites, 8/8 mutations killed.
