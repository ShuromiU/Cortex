---
baseline_commit: 4fb59c8
---

# Story 1.3: Surface rejected alternatives at recall

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an agent proposing an approach,
I want to see which options were already considered and rejected,
so that I stop relitigating decisions that were settled before I arrived.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 1 → Story 1.3 (lines 295-311). Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** a `note:decision` with a non-empty `alternatives` array
   **When** it is included in recall output
   **Then** an `already rejected:` line lists those alternatives.

2. **Given** the output budget binds
   **When** rendering a decision with alternatives
   **Then** the alternatives line drops before the decision itself drops.

3. **Given** a decision with no alternatives
   **When** it is rendered
   **Then** output is byte-identical to current behavior.

4. **Given** a new locked eval fixture exercising a decision that carries alternatives
   **When** the suite runs
   **Then** the fixture asserts the `already rejected:` line is present and within budget.

### AC assessment — no deviations, one deliberate superset

**All four ACs are sound as written.** Unlike 1.2, none needs to be worked around. Two notes on how they were read:

#### Note 1 — AC #4 is a real gate this time. 1.2's was not.

Story 1.2 had to flag its AC #4 as gating nothing (`grep -rn conflict eval/` returned zero, so "no suite regresses" was satisfied by inaction). This story's AC #4 *names* the new fixture and *names* the assertion. It is the gate. Build it as specified — Task 5.

#### Note 2 — `brief` is included alongside `recall`. Superset, recorded, not a deviation.

AC #1 and the FR heading say **recall**. FR-3's second consequence is surface-agnostic: *"included whenever the parent decision is included and the budget permits."* This story renders the line in **`recall` and `brief`**, and in no other surface.

The reason is structural, not preferential — see Task 2. `already rejected:` is a **second line**, so it cannot ride inside `renderMemoryLine` the way `[contested]` did, because that function returns one line. It has to be assembled where multi-line budgeting happens, which is `assembleBudgeted` — and `assembleBudgeted` has exactly two callers, `recall` and `brief` (Serena-enumerated; no test imports it). Including `brief` costs no extra mechanism and inherits AC #2's guarantee identically. Excluding it would mean *removing* the line from a surface the same code path already produces.

`brief` is also where the user story's actor lives: it is the subagent-briefing channel, and "an agent proposing an approach" is precisely its consumer.

The gate is unaffected either way — `src/eval/harness.ts:201` measures `recall()` only.

## Tasks / Subtasks

- [x] **Task 1 — Extract the alternatives line, with the three guards that make it safe** (AC: #1, #3)
  - [x] Add to `src/query/render.ts`, in the FR-2/FR-3 block beside `isContested`:
    ```ts
    /** Prefix for the rejected-alternatives continuation line. Two-space indent subordinates it to its decision. */
    export const ALREADY_REJECTED_PREFIX = '  already rejected: ';

    /** The `already rejected:` line for an item, or null when it carries none. */
    export function renderedAlternatives(item: ParsedMemoryItem): string | null;
    ```
  - [x] Same forced-text-sniff situation as 1.2, same reason: `ParsedMemoryItem` has **no** `alternatives` field. The value reaches renderers only as the line `Alternatives: a, b` that `buildNoteMemoryText` writes (`src/memory/items.ts:54-55`). A real column needs a migration and a `SCHEMA_VERSION` bump, and R1 spends its single bump on Story 3.1 (AD-11). State this in the doc comment.
  - [x] **Guard 1 — `kind.startsWith('note:')`, non-negotiable.** Only notes have an `alternatives` column. An `episode:command_failure` carries captured stdout/stderr in `text`; a build log line beginning `Alternatives: ` would otherwise render a fabricated rejection list. Identical reasoning to `isContested`.
  - [x] **Guard 2 — line-prefix match on a trimmed line, never `text.includes(...)`. This one has three live detonators.**
    `eval/suites/budget.json:11`, `eval/suites/kind-ordering.json:11` and `eval/suites/stemming.json:29` each seed decision text containing the literal word `Alternatives:` — but **inline, mid-sentence, on line 0**:
    ```
    "Decision: rotate jwt refresh tokens server-side after renewal. Alternatives: client cookie rotation rejected for XSS exposure."
    ```
    A substring match fires on all three, emits a duplicate `already rejected:` line, and pushes `output_tokens` **positive on 3 of 6 suites** — a red gate that regenerating cannot legitimately fix. A line-prefix match fires on none of them. Verify this claim by running the gate (Task 6); do not take it on trust.
  - [x] **Guard 3 — take the LAST matching line, not the first.** Note content is free-form and may contain newlines (`cortex_note` accepts any string), so a content line can itself read `Alternatives: …`. `buildNoteMemoryText` always emits the real line *after* the content and `Subject:` lines, so last-match is correct whenever a real one exists and no worse than first-match when none does. Document the residual exposure — it is unfixable without the column, exactly like `isContested`'s.
  - [x] Return `null` when the payload after the prefix is empty. `buildNoteMemoryText` only writes the line when `alternatives.length > 0`, but a hand-seeded eval item is not bound by that.
  - [x] Export both symbols from `src/index.ts` — matches 1.2's precedent (`CONTESTED_MARKER`, `isContested`, `groupContestedAdjacent` all landed there) and `project-context.md`'s unconditional rule for new public symbols.

- [x] **Task 2 — Two-phase budgeting in `assembleBudgeted`** (AC: #2, #3)
  - [x] **Read this before writing code: bottom-dropping alone does NOT satisfy AC #2.** `assembleBudgeted` (`src/query/recall.ts:50-82`) treats each evidence entry as an atomic string and drops whole entries from the bottom. Making the alternatives its own entry fails the AC twice over: with `[d1, alt1, d2, alt2]` a cut landing on `d2` drops the decision *and* its alternatives together, and worse, `alt1` has already spent budget that `d2` needed. **Do not fake this by pre-truncating either.**
  - [x] Change the evidence parameter to carry an optional lower-priority continuation:
    ```ts
    export interface BudgetedEvidence {
      /** The line that must survive if this entry survives at all. */
      line: string;
      /** Lower-priority continuation; dropped before any `line` is dropped. */
      continuation?: string;
    }
    ```
    Named `continuation`, **not** `detail` — `RecallOptions.detail` ('none' | 'scores') already exists in the same file and the collision would be genuinely confusing.
  - [x] **Phase 1 — primary lines only, algorithm unchanged.** Same loop, same `included > 0 && used + cost > budget` break, same trimmed-hint pop loop with `hintCost` computed once before it. Do not "improve" any of it; AC #3 is byte-identity and phase 1 is what produces today's bytes.
  - [x] Add one line of new bookkeeping: after pushing the hint, add its cost to `used`, so phase 2 cannot spend budget the hint already claimed. Compute the pushed hint once (`const hint = trimmedHint(...)`) and charge `estimateTokens(hint)`. Leave the loop's pre-computed `hintCost` alone — changing it would alter phase-1 output.
  - [x] **Phase 2 — continuations, strictly lower priority.** Walk the *kept* entries top-down; for each with a `continuation`, charge it and keep it while it fits; **`break` on the first one that does not.**
    - `break`, not `continue`: predictable top-down fill, deterministic to test, and matches the drop-from-the-bottom model used everywhere else. The rejected alternative (a greedy `continue` that lets a short later continuation slip in where a long earlier one did not) shows marginally more content but makes "which alternatives lines appear" depend on relative lengths. Record the choice in a comment.
  - [x] **Assemble last**, interleaving each kept continuation directly beneath its own line, then the hint. When no entry has a continuation the output is `[lead?, ...keptLines, hint?]` — **identical bytes to today**. That is AC #3, and it is satisfied structurally rather than by testing every case.
  - [x] **Why this makes AC #2 literally true at every budget:** phase 1 never sees a continuation, so a continuation can never displace any decision line, and any continuation is charged only after every affordable decision line is already kept.
  - [x] Update both callers. `src/query/recall.ts:103-106` and `src/query/brief.ts:63-66` both map items to strings today; they now map to `BudgetedEvidence`. Use the repo's conditional-spread idiom (`...(x !== null ? { continuation: x } : {})`) — `exactOptionalPropertyTypes` is *not* enabled, so it is style, not a compiler requirement.
  - [x] `renderScoreDetail` still appends to `line`, never to the continuation. A score breakdown belongs to the ranked item.

- [x] **Task 3 — Decide every rendering surface explicitly** (AC: #1)
  - [x] Six note-rendering surfaces exist. **Enumerate surfaces, not `renderMemoryLine` call sites** — that error cost Story 1.2 a review round. Verify this table before coding; do not extend it silently.

    | Renderer | Surface | Alternatives? | Why |
    | --- | --- | --- | --- |
    | `renderMemoryLine` → `recall.ts` | `cortex_recall` | **Yes** | AC #1. Via `assembleBudgeted`. |
    | `renderMemoryLine` → `brief.ts` | `cortex_brief` | **Yes** | Same code path; see Note 2. |
    | `renderMemoryLine` → `state.ts:365` `renderEvidenceSection` | `Recent evidence:` | No | Episodes/commands, not notes. `buildFullState` budgets whole **sections**; a continuation cannot drop independently there, so AC #2 could not hold. |
    | `renderNoteBullet` (`state.ts:258`) | state working sections + `Current session:` | No | Same section-budget problem. |
    | `renderResumeCandidate` (`state.ts:171`), `renderHeaderHighlights` (`state.ts:110`) | `Resume:` / `Hot:` | No | Both hard-truncate (100/110 chars) before any budget applies. A continuation would be silently mangled or lost. |
    | `session-brief.ts:120` | unprompted SessionStart | No | 150-token channel that must stay ≤150 and print nothing on a cold start (`project-context.md`). R1's whole theme is context economy. |
    | `reflex.ts:176` | PreToolUse whisper | No | Emits one line capped at 460 chars as `additionalContext`. A second line breaks its contract, and injected-context churn silently invalidates the prompt cache. |

  - [x] **This is the opposite call from 1.2's, and deliberately so.** `[contested]` is 3 tokens appended to an existing line and belonged everywhere. `already rejected:` is a whole extra line whose budget behavior is the AC — it belongs only where a budget can drop it independently.
  - [x] Make no edit to `state.ts`, `session-brief.ts` or `reflex.ts`. If you find yourself editing one, re-read this table first.

- [x] **Task 4 — Tests** (AC: #1, #2, #3)
  - [x] `tests/render.test.ts` — `renderedAlternatives`: returns the line for a note with a real `Alternatives:` line; `null` for one without; `null` for a **non-note** kind carrying the same line; `null` when the payload is empty. **Guard 2 regression test: a note whose line-0 content contains `Alternatives:` mid-sentence returns `null`** — seed the exact `kind-ordering.json:11` string, so the three-suite hazard is pinned by a unit test and not only by the gate. **Guard 3: content spanning two lines where line 1 reads `Alternatives: decoy` and a real line follows → the real one wins.**
  - [x] `tests/recall.test.ts` — end-to-end via `store.insertNote({ kind: 'decision', alternatives: [...] })`, exercising the real write path rather than a hand-built text blob (mirrors 1.2's `seedContest` helper).
    - AC #1: the line appears directly beneath its decision and lists every alternative.
    - **AC #2, the load-bearing test:** at a budget where two decisions both survive, the continuation of the *last* one must be absent while that decision is present. Assert it as an ordering property, not a substring count.
    - **AC #2, stronger:** a budget sweep — as the budget rises, no continuation ever appears in an output that is missing a decision line present at a lower budget. Pin the invariant, not one sample point.
    - AC #3: byte-identity. Capture `recall()` output for a store with **no** alternatives anywhere and assert it against a literal expected string, at both a generous and a binding budget.
  - [x] `tests/recall.test.ts` (brief section) — the line renders in `brief` too, and `KIND_PRIORITY` ordering still holds with continuations interleaved.
  - [x] **Check that each new assertion is genuinely adversarial before trusting it.** Both of Story 1.2's first-draft tests passed whether or not the feature existed, because natural ranking already produced the asserted order. For every budget-sensitive test here: **pre-assert the precondition** (e.g. that both decision lines really are present at this budget) so the test fails loudly if it stops being adversarial.
  - [x] **Mutation-test every new assertion before calling the story done.** At minimum mutate: continuation never emitted · emitted unconditionally · `renderedAlternatives` uses `includes` instead of line-prefix · drops the `note:` kind guard · takes first match instead of last · phase 2 runs **before** phase 1 (must break AC #2) · phase 2 `break` becomes unconditional keep (must breach budget) · continuation appended to `line` instead of kept separate (must break AC #2 and AC #3). Break, confirm red, restore.
  - [x] `npm run lint` does **not** typecheck `tests/` (tsconfig `exclude`s the tree; vitest transpiles without checking). Type errors there are invisible to both commands — read test code carefully.
  - [x] Import specifiers end in `.js` even from `.ts`, including in `tests/`. Temp dirs via `os.tmpdir()`, never a literal `/tmp`.

- [x] **Task 5 — Lock it in the eval gate** (AC: #4)
  - [x] New `eval/suites/alternatives.json` + its baseline. Both land together — the gate fails on a suite with no baseline (`gate.ts:402`) **and** a baseline with no suite (`gate.ts:383`).
  - [x] Seed the `Alternatives:` line as its **own line** in the item's `text`, exactly as `buildNoteMemoryText` writes it. `ScenarioMemoryItem` (`src/eval/seed.ts:8-22`) has no `alternatives` field and does not need one — eval scenarios write `memory_items` directly via `seedStoreFromScenario` and never reach `insertNote`.
  - [x] **Two fixtures, because AC #4 has two halves** ("present" and "within budget"):
    - Fixture A, generous budget: `expect_output_contains` the `already rejected:` line and its payload.
    - Fixture B, `max_output_tokens` set so the budget binds: `expect_output_contains` the decision's content **and** `expect_output_excludes: ["already rejected:"]`. This is AC #2's gate — the decision survives, its continuation does not.
  - [x] **Fixture B is fiddly; budget it empirically.** The harness passes `max_output_tokens` as `recall`'s budget *and* asserts `est_tokens <= max_output_tokens`, while `assembleBudgeted` can overshoot by the trimmed-hint line (pinned by an existing test in `tests/recall.test.ts`). A new fixture must **pass on arrival** — `findFixtureRegressions` only forgives fixtures already failing at their baseline. Tune the number against real output, do not guess it.
  - [x] Keep `allowed` minimal: `recall_at_3` divides by `|{expected_top} ∪ allowed|` and must come out at 1.
  - [x] Exclude timestamps from every needle. The scenario clock is generation-time; a timestamp in a needle makes the suite non-deterministic (learned in 1.2).
  - [x] Generate with `cortex eval-gate --regenerate-baseline alternatives`. A first baseline for a new suite is a normal artifact, but the commit body still needs `Baseline-Regenerated: <reason>` — CI rejects any baseline change without one.
  - [x] **Confirm the fixture would fail without the feature.** Revert Task 2 in `dist/` locally, run `npm run gate`, watch `alternatives` go red on both fixtures, restore. A fixture that passes against the old code gates nothing — the exact defect that reached `main` four times before Story 1.5.
  - [x] No manifest to update: suites are auto-discovered by `readdirSync` over `eval/suites/*.json`. Any non-suite `.json` parked there fails the gate as "unrecognized file".

- [x] **Task 6 — Verification and docs**
  - [x] `npm run build && npm run lint && npx vitest run` — baseline at `4fb59c8` is **670 tests / 27 files, all green**.
  - [x] `npm run gate` — baseline is 6 suites green at `budget=178, contested=117, kind-ordering=103, rename-moved=97, stale-label=164, stemming=93`. **Expect exactly zero delta on all six.** If `budget`, `kind-ordering` or `stemming` moves, Guard 2 has failed and the inline `Alternatives:` text is being matched — stop and fix the predicate. Regenerating is never how a red gate goes green.
  - [x] **AD-5 does not apply** — no new `memory_items` kind. The new suite seeds `note:decision`/`note:insight`, both already covered. `eval/kind-coverage.json` is untouched.
  - [x] **Measure and record the token cost.** PRD Open Question 8 (`prd.md:780`) asks what the conflict marker and the rejected-alternatives line cost at realistic recall sizes, and assigns the answer to this story's section. Record the measured per-line cost in Completion Notes.
  - [x] `CLAUDE.md` § Expected Behavior — the `already rejected:` line, the two surfaces it appears on, the surfaces it deliberately does not, and the drop-before-the-decision guarantee. § Core Files — `render.ts` and `recall.ts` entries mention the new responsibility.
  - [x] `README.md` — a section beside "Contested items in retrieval" (line 321), with a rendered example. Docs ship in the **same commit** as the behavior.
  - [x] **Stage `CLAUDE.md` surgically.** `.mcp.json` and `CLAUDE.md`'s § Agent Tooling block carry the user's own deliberately-unstaged edits. Rebuild the intended blob from `HEAD:CLAUDE.md` plus only your hunks (`git hash-object -w --stdin` + `git update-index --cacheinfo`), or stage by explicit hunk. **Never `git add CLAUDE.md` wholesale.** `.serena/` stays untracked.

## Dev Notes

### Files being modified — current state

| File | Today | This story |
| --- | --- | --- |
| `src/query/render.ts` | Owns `isContested`, `CONTESTED_MARKER`, the two grouping helpers, `renderMemoryLine`. Note branch reads **`lines[0]` only** — every line after the first is invisible. | Gains `ALREADY_REJECTED_PREFIX`, `renderedAlternatives`. `renderMemoryLine` itself is **unchanged**. |
| `src/query/recall.ts:50-82` `assembleBudgeted` | `evidence: string[]`, atomic entries, drops from the bottom. | Two-phase. New `BudgetedEvidence` type. Phase 1 byte-identical. |
| `src/query/recall.ts:103-113` `recall` | Maps ordered items to strings. | Maps to `BudgetedEvidence`. |
| `src/query/brief.ts:63-74` `brief` | Maps grouped items to strings. | Same change. |
| `src/memory/items.ts:54-55` | Writes `Alternatives: a, b` as its own line. | **No edit.** This is the source signal; changing it breaks the sniff. |
| `src/index.ts` | Exports three render symbols from 1.2. | +2 exports. |
| `eval/suites/`, `eval/baselines/` | 6 suites. | +1 suite, +1 baseline. |
| `src/query/state.ts`, `session-brief.ts`, `reflex.ts` | Six note renderers total. | **No edit.** Task 3. |

### `alternatives` really is dormant — verified, not assumed

`grep -rn alternatives src/` returns six sites: `db/schema.ts` + `db/store.ts` (persist/parse), `capture/consolidate.ts:305,318` (carried through the child→parent note merge), `transports/mcp.ts:217` (tool schema), `memory/items.ts:54` (projection). **Zero in `src/query/`.** No renderer reads it today.

This is genuine greenfield, unlike 1.2 — which planned as greenfield and turned out to be a rename of a pre-existing `[conflict]` marker. `project-context.md`'s "populated by `cortex_note`, surfaced almost nowhere" is accurate; the "almost" is the FTS index, which already searches the line even though nothing displays it.

### The output format is specified, not invented

`prd.md:61` renders it in the target user journey:

> *already rejected: session cookies (no SSO path), JWT-in-localStorage (XSS surface)*

Lowercase, colon, comma-separated. `note.alternatives.join(', ')` — which is exactly what `buildNoteMemoryText` already writes — reproduces it. The parenthetical rationales are the user's own array contents, **not** a structure Cortex imposes; do not invent a rationale field.

### Must not break

- **The three suites carrying inline `Alternatives:` text.** `budget`, `kind-ordering`, `stemming`. Guard 2 exists for them specifically.
- **`renderMemoryLine`'s single-line contract.** Everything else in the codebase assumes it returns one line — `renderMemorySnippet(renderMemoryLine(item, 1), 1, 110)` in `renderHeaderHighlights` would silently fold a second line into a `|`-joined snippet.
- **Phase 1 of `assembleBudgeted`.** AC #3 is byte-identity, and 1.2's tests already pin the trimmed-hint overshoot behavior (`tests/recall.test.ts:500`) and the "top evidence line always survives" property (`recall.ts:62`).
- **Contested grouping.** `groupContestedAdjacent`/`groupContestedWithinKind` run before the evidence map in both callers. The reorder must stay ahead of the `BudgetedEvidence` construction, and continuations must follow their item through the reorder.
- **`retrieveMemory` ordering.** Untouched, as in 1.2. `src/eval/harness.ts:198-206` computes `top1_hit`/`recall_at_3` from retrieval directly and only `output_tokens`/`expect_output_contains` from `recall()`, so a rendering change is structurally incapable of moving the ranking metrics — provided nothing moves into retrieval.
- **The six existing baselines.** Locked artifacts. Zero delta expected.

### Previous story intelligence (1.2 — done, 1 review round, 9 findings)

Read `1-2-render-contested-items-in-retrieval.md` § Senior Developer Review. Its through-line was: *"I asserted a property instead of testing it."* Concretely, and all of it applies here:

- **"Five call sites, Serena-enumerated, complete" was wrong** — it enumerated `renderMemoryLine` *callers*, not note-rendering *surfaces*, and missed `session-brief.ts` and `renderResumeCandidate`. Task 3's table is the corrective; verify it rather than trusting it.
- **Both first-draft adversarial tests were not adversarial.** The unit test's two contested notes scored identically (38.50/38.50) so the pair was already adjacent; the eval fixture ranked 53.00/45.30/35.50 with the pair already together. Each passed with the feature reverted. Fixed by constructing genuine ranking splits **and** pre-asserting the precondition inside the test.
- **Mutation survival can mean the fix is wrong, not the test.** One 1.1 survivor exposed a repair worse than the original. Investigate survivors before blaming the test.
- **Eval scenarios never reach `insertNote`.** Seed the projected text.
- **A locked-artifact commit needs the trailer** even when the baseline is brand new.

### Git intelligence

`e293977` → `5c0a9cf` → `c259710` is Story 1.1 across three rounds; `eac73c2` → `b0f1be8` → `4fb59c8` is Story 1.2. Conventions confirmed in those diffs:

- Lowercase Conventional Commit subjects (`feat:`, `fix:`, `chore:`).
- Docs (`CLAUDE.md`, `README.md`) in the **same commit** as behavior.
- Tests extended in the existing per-module file, never a new parallel one.
- A repair round lands as a separate `fix:` commit naming the finding count.

**Uncommitted working-tree state to preserve:** `.mcp.json` and `CLAUDE.md` § Agent Tooling. See Task 6.

### Latest technical information

No new dependency, no external API, no version-sensitive surface. Relevant local facts:

- `estimateTokens` is `Math.ceil(text.length / 4)` (`retrieval.ts`). `'  already rejected: '` is 20 chars ≈ 5 tokens of pure overhead per line, plus the payload.
- `exactOptionalPropertyTypes` is **not** set in `tsconfig.json`, so `{ continuation: undefined }` would typecheck. Use the conditional-spread idiom anyway — it is the established style and keeps the object shape honest.
- `isolatedModules: true`: export the new interface with `export type` / `export interface`, and re-export types with `export { type BudgetedEvidence }` if they reach `src/index.ts`.

### Project structure notes

Everything lands in existing files. `render.ts` is the right home for the extractor — `query/`-layer, already imported by `recall.ts`, `brief.ts`, `state.ts` and `reflex.ts`, and AD-1's one-way layering (`transports/` → `query/` → `memory/` + `scope/` → `db/`) is respected. `assembleBudgeted` stays in `recall.ts` where `brief.ts` already imports it from.

No variance from the unified structure. One test file per module.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md:289-311`] — acceptance criteria, verbatim.
- [Source: `.../prd.md:136-143` § FR-3] — the three consequences; "included whenever the parent decision is included and the budget permits; it drops before the decision itself drops."
- [Source: `.../prd.md:61` § UJ-2] — the rendered output format.
- [Source: `.../prd.md:780` Open Question 8] — token cost of the marker and this line; owned by this section, gate before §4.1 ships.
- [Source: `.../prd.md:640` § SM-4] — relitigation-avoided metric; validates FR-3.
- [Source: `.../ARCHITECTURE-SPINE.md` § AD-5] — a new kind needs a fixture. Not triggered here; recorded so the reviewer need not re-derive it.
- [Source: `_bmad-output/project-context.md` § Dormant Surface] — `notes.alternatives` intended to show already-rejected options in recall.
- [Source: `src/eval/harness.ts:198-206`] — ranking metrics read `retrieveMemory`, output metrics read `recall()`.
- [Source: `_bmad-output/implementation-artifacts/1-2-....md` § Senior Developer Review] — the surface-enumeration and non-adversarial-test failures this story must not repeat.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

**Mutation testing** (`scratchpad/mutate-1-3.mjs`, 10 mutations against `tests/render.test.ts` + `tests/recall.test.ts` + the gate): **9/10 killed, and the tenth is a proven equivalent mutant.** Killed: feature off · `note:` kind guard dropped · substring instead of line-prefix · first match instead of last · empty-payload guard removed · continuation glued into pass 1 · pass 2 ignores the budget · pass 2 skips greedily instead of stopping · trimmed hint not charged.

**The first campaign was a false all-clear and had to be rewritten.** It patched `dist/`, but vitest imports from `src/` — so the unit tests never saw a single mutation and every kill was attributed to the gate alone. Rewritten to mutate source and rebuild before the gate step. Mutations flip predicates (`item.kind.length >= 0`) rather than substituting literal `true`/`false`, so tsc never sees unreachable code and the build stays clean.

**Two survivors on the corrected run, investigated rather than explained away.**

*`pass 2 greedily skips instead of stopping` was a genuine gap.* The test written for it used budget 104, which is not discriminating: at that budget the top decision's continuation (21 tokens) fits, and `break` and `continue` produce identical output. The discriminating window is 94–100 — the *second* decision's continuation costs only 13, so a greedy fill would show it while the top decision's is missing. Added a test over that window with a pre-assertion that 102 is still where the first one starts fitting, so it fails loudly if the window moves.

*`pass 2 runs over all evidence, not just the kept entries` is equivalent.* Continuations stored beyond `included` are never read by the assembly loop, and the `used` inflation happens after every kept entry is already processed. Verified rather than argued: a 96-budget sweep produced **byte-identical output** with and without the mutation. The first attempt at that probe reported all 96 differing — it created notes at runtime, so the two runs differed only by timestamp. Re-run against a hermetic scenario with a fixed clock (`probe deterministic across runs: true`) before the conclusion was accepted.

**The eval fixture was verified to fail without the feature** via the same campaign: `alternatives` goes red under "feature off" (fixture A loses its needle) and under "continuation glued into pass 1" (fixture B's `already rejected` exclusion is violated *and* it breaches its 90-token budget).

**Guard 2's hazard is real but I had the count wrong.** The story claimed three locked suites would go positive under a substring match. Measured: **two** — `budget` +25 and `kind-ordering` +18. `stemming` seeds the same inline text but its item does not reach the rendered set for that fixture's topic, so it stays flat. The guard is necessary either way; the number in the story was asserted, not measured, and is corrected here and in `CLAUDE.md`.

### Completion Notes List

**AC #2 is the whole story and it needed a real mechanism.** `assembleBudgeted` now runs two passes: pass 1 places every affordable primary line with the pre-existing algorithm untouched, pass 2 spends only the remainder on continuations. The guarantee is structural rather than tuned — a continuation is charged only after every decision that fits is already kept, so it cannot displace one at any budget. Bottom-dropping alone would have failed the AC twice over, and pre-truncating would have faked it.

**AC #3 is satisfied structurally, not by luck.** With no continuations present, pass 2 is a no-op and the assembled output is `[lead?, ...keptLines, hint?]` — the exact array pass 1 alone produced. Pinned by two tests asserting complete literal output under a fixed clock, at a generous and a binding budget.

**Note 2 honored — the line renders in `recall` and `brief` only.** Six note-rendering surfaces were enumerated as *surfaces*, not as `renderMemoryLine` call sites, which is the enumeration error that cost 1.2 a review round. The other four are excluded for a structural reason, not a preference: `state` budgets whole sections, and `Resume:`, `Hot:`, the SessionStart brief and reflex all truncate to a fixed width, so a continuation there could not drop independently of its decision — which is the property AC #2 asks for. This is deliberately the opposite call from `[contested]`, which is three tokens on an existing line and belonged everywhere. **A reviewer should check this call rather than assume it.**

**`renderMemoryLine` was not modified at all.** It returns one line and much downstream code depends on that — `renderHeaderHighlights` pipes it through `renderMemorySnippet`, which would fold a second line into a `|`-joined snippet. A test now pins the single-line contract against an item that carries alternatives.

**PRD Open Question 8 answered** (`prd.md:780`, assigned to this section). The line costs 5 tokens of fixed prefix plus payload; realistic two-item lists measured 21 and 26 tokens. On the new suite: **+47 tokens** where the budget has room (106 → 153, a 44% increase for a recall in which both decisions carry alternatives) and **+0** where it binds, because AC #2's ordering makes the line the first thing sacrificed. The feature is therefore free exactly when context is scarcest, which is the answer §4.1 needed before it ships.

**Zero delta on all six pre-existing baselines** (178/117/103/97/164/93), as required. The gate now runs 7 suites.

**Not done, deliberately:** `renderMemoryLine`, `state.ts`, `session-brief.ts` and `reflex.ts` are untouched; `buildLeadLine` carries no alternatives (the top item carries them on its own continuation, and pass 1 always keeps at least one evidence line); and `eval/kind-coverage.json` is unchanged because AD-5 is not triggered — no new `memory_items` kind.

**One residual limitation, documented in code rather than fixed.** A note whose free-form content *ends* with a line reading `Alternatives: …` and which carries no real alternatives will still false-fire. Taking the last match makes this strictly rarer than taking the first, but it is unfixable without a real column — the same exposure `isContested` carries, and the same reason: R1 spends its single `SCHEMA_VERSION` bump on Story 3.1.

### File List

- `src/query/render.ts` — modified; `ALREADY_REJECTED_PREFIX`, `renderedAlternatives`
- `src/query/recall.ts` — modified; `BudgetedEvidence`, two-pass `assembleBudgeted`, caller builds continuations
- `src/query/brief.ts` — modified; caller builds continuations
- `src/index.ts` — modified; two new public exports
- `tests/render.test.ts` — modified; 10 tests for extraction, the three guards, and the single-line contract
- `tests/recall.test.ts` — modified; 10 tests for rendering, AC #2 budget ordering, and AC #3 byte-identity
- `eval/suites/alternatives.json` — new; locked FR-3 fixture, two fixtures covering "present" and "within budget"
- `eval/baselines/alternatives.json` — new; its baseline
- `CLAUDE.md` — modified; core files, the two surfaces, two-pass budgeting, the line-prefix guard
- `README.md` — modified; "Rejected alternatives in retrieval" section

### Change Log

- 2026-07-27 — Story 1.3 implemented. `already rejected:` line in recall and brief, two-pass budgeting so it drops before its decision, new locked eval suite. 690 tests (+20), 7 gate suites, 9/10 mutations killed (1 proven equivalent).
