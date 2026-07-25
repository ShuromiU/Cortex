---
baseline_commit: 71d8a6f9d9becbbd2ba52490ffa479548493b44b
---

# Story 0.2: Carry agent identity through the capture spool

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Cortex maintainer,
I want the capture spool to record `agent_id` and `agent_type` per entry,
so that attribution survives the gap between the hook firing and the batched flush.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 0 → Story 0.2. Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** the PostToolUse hook fires for a subagent tool call
   **When** it appends a spool line
   **Then** the line carries `agent_id` and `agent_type`
   **And** the hook spawns no Node process (N-4)
   **And** the hook stays within budget B-4.

2. **Given** a spool batch containing entries from the primary session and two subagents
   **When** the batch is flushed
   **Then** each entry is written to the session matching its `agent_id`
   **And** replaying the same batch produces identical state (N-7).

3. **Given** a spool line whose `agent_id` refers to a subagent whose parent session has since ended
   **When** the flush replays it
   **Then** the entry is still attributed to the correct child session
   **And** no error surfaces to the user (AD-12).

## Tasks / Subtasks

- [x] **Task 1 — Carry agent identity in the spool line** (AC: #1)
  - [x] In `hooks/claude/cortex-capture.sh`, add `agent_id` and `agent_type` to the emitted JSON in **all three** branches (`Read|Edit|Write`, `Bash`, `Agent`).
  - [x] Add them inside the **existing** `jq` invocation for each branch — no second `jq` call, no `$(...)` subshell, no new process. Use the merge idiom already in the `Bash` branch: `+ (if (.agent_id // "") != "" then {agent_id: .agent_id} else {} end)`.
  - [x] Omit the fields entirely when absent, so a primary-session line is byte-identical to what the current hook emits. This keeps the processed-marker content hash stable for primary-only batches and keeps lines small.
  - [x] Do not touch the threshold-flush branch, the engagement gate, or the `.cortex.agent-used` marker.

- [x] **Task 2 — Accept the fields on the entry type** (AC: #2)
  - [x] Add `agent_id?: string` and `agent_type?: string` to `SpoolEntry` in `src/capture/spool.ts`.
  - [x] `appendSpoolEntry` needs no change — it spreads the entry — but confirm the Node-side writer can round-trip both fields.

- [x] **Task 3 — Resolve each entry to its own session at flush time** (AC: #2, #3)
  - [x] Export a resolver from `src/scope/runtime.ts` that takes the primary session **id** and returns the session id an entry belongs to: `resolveAgentSessionId(store, primarySessionId, agentId, agentType): string`. It loads the primary row, delegates to the existing `ensureAgentSession` find-or-create, and returns `primarySessionId` unchanged if the primary row is missing.
  - [x] **Do not change `flushSpool`'s signature.** `sessionId` stays the primary; per-entry resolution happens inside. That keeps all four production call sites (`cli.ts:210`, `cli.ts:236`, `cli.ts:428`, `hook-entry.ts:348`) untouched — enumerate them with `find_referencing_symbols` and confirm before starting.
  - [x] Memoize per batch: resolve once per distinct `agent_id` into a `Map`, not once per entry. A 256 KiB batch can hold hundreds of entries from one subagent.
  - [x] Resolution happens **inside** the existing `store.runInTransaction` in `processClaimFile`, so child-session creation commits with the replay and the processed marker. A crash mid-batch must not leave a child session with no events.
  - [x] An entry with no `agent_id` resolves to `sessionId` exactly as today.

- [x] **Task 4 — Attribution survives an ended parent** (AC: #3)
  - [x] Verify `getSessionByAgentId` still finds a child whose parent has ended — Story 0.1 made it deliberately unfiltered by status and parent for exactly this. Do **not** add a status or parent filter; a code reviewer proposed it during 0.1 review and it was rejected for breaking this AC.
  - [x] When the child does not yet exist and the primary being flushed into has already ended, create the child under **that** primary — the session the work belongs to — not under whatever is currently active.
  - [x] Wrap per-entry resolution so a failure degrades to attributing the entry to the primary rather than aborting the batch (AD-12). Comment why.

- [x] **Task 5 — Tests** (AC: #1, #2, #3)
  - [x] `tests/spool.test.ts` — a batch mixing primary lines and lines from two distinct `agent_id`s lands each entry in the matching session; two children created, neither cross-attributed; the primary keeps only its own events.
  - [x] `tests/spool.test.ts` — replaying that identical batch is a no-op: no duplicate events, no duplicate child sessions (N-7).
  - [x] `tests/spool.test.ts` — a line whose `agent_id` matches a child whose parent has been ended (`endSessionTree`) still lands on that child, and `flushSpool` does not throw.
  - [x] `tests/spool.test.ts` — legacy lines with no agent field still land on the primary (already covered; keep it passing).
  - [x] **New file `tests/capture-hook.test.ts`** — execute `hooks/claude/cortex-capture.sh` for real via `execFileSync('bash', ...)` with a payload on stdin and a temp cwd containing `.cortex.state` with `enabled=true`; assert the emitted spool line parses and carries `agent_id`/`agent_type`. Skip the suite when `bash` or `jq` is unavailable rather than failing. This is the only thing that catches a jq syntax error — `tsc` cannot see inside the script, and a broken jq program emits an empty line silently in production.
  - [x] Same file — a payload with no agent fields emits a line with **no** `agent_id` key at all.
  - [x] Same file — static N-4 assertion: the script's per-event path contains no `__CORTEX_NODE__` invocation; the only Node reference is inside the ≥256 KiB threshold branch.

- [x] **Task 6 — Decide the deferred episode-fold question** (carried from Story 0.1 review)
  - [x] This story makes it reachable. `findRecentEpisodeBySummary` (`src/db/store.ts`) filters by neither session nor parentage, so a subagent's failing command within 24h of an identical parent failure bumps the **parent's** episode row and re-upserts the parent-owned `memory_items` projection at `(seen 2x)`; the child gets no episode. That leaks Story 0.1's AC #2.
  - [x] Write a test that pins whichever behavior is chosen, so it stops being accidental.
  - [x] If the lookup is scoped, the change touches `memory_items` — **run the locked eval suites** and reject on any negative `top1_hit`/`recall_at_3` or positive `output_tokens` delta.
  - [x] Full detail and the three options are in `_bmad-output/implementation-artifacts/deferred-work.md`.

- [x] **Task 7 — Docs**
  - [x] `CLAUDE.md` § Expected Behavior: the "Not yet reachable from the installed Claude wiring" caveat added by Story 0.1 becomes false when this ships. Remove it and state the reached behavior plainly.
  - [x] Note that users on a stale installed `cortex-capture.sh` keep emitting old-format lines and silently never get subagent attribution. This is an **accepted, documented risk** (readiness report Observation 2) owned by Epic 2 Story 2.3's hook-version check. Do not build detection here.

### Review Findings

Code review of `9d223b9` against `71d8a6f`, three parallel layers. Every finding below was reproduced against `dist/` before rating; reviewer severities were discarded. Reviewers left scratch test files in `tests/`; removed.

- [x] [Review][Decision] **B-4 (≤15 ms) is not achievable on the Windows/Git Bash target, and AC #1 binds it** — **Resolved: recorded as a planning defect, not blocking.** AC #1's third clause is marked **not met, with cause**; the budget needs re-basing against the real platform the way B-4a was already amended, which is a PRD decision. Logged to `deferred-work.md` and carried to the Epic 0 retrospective. N-4 does hold. Detail: AC #1's third clause was marked satisfied with no measurement. Measured: the hook costs ~400 ms per invocation on this machine, against a 15 ms budget; `bash -c 'exit 0'` alone is ~36 ms, so process startup exceeds the budget before the script runs. The pre-change hook measures the same, so **this story did not cause it** — but the criterion is stated as an absolute and the code does not meet it. This is an acceptance criterion that is wrong about its own platform, not code that is wrong.

- [x] [Review][Decision] **Task 6's decision was made on a false premise and must be remade** — **Resolved: the fold is now scoped to the recording session.** `findRecentEpisodeBySummary` takes the recording session and matches only its own episodes, so two sessions that each hit one failure each keep an episode while a retry loop within one session still folds. Both orderings are pinned by test; all five locked eval suites at zero delta. Detail: the Dev Agent Record claims the episode fold is "not a regression — before Story 0.1 the subagent's command was captured against the parent directly and folded identically." That holds **only when the primary fails first**. Reproduced, child-first: primary episodes `[]`, child episodes `['test failed: npm test (exit 1) (seen 2x)']`. When the subagent hits the failure first, the primary's own later identical failure folds into a **child-owned** episode and the primary gets none — pre-0.1 it got one. That is a regression, and it is the ordering the deferral was actually about. The pinning test covers only the favorable ordering, so the unfavorable one is still accidental — precisely what Task 6 said to prevent.

- [x] [Review][Patch] **The Stop-hook nudge is blinded by the only condition that triggers it** [src/transports/hook-entry.ts:369] — the nudge fires only when a subagent ran this turn, then calls `suggestNotes(store, primary)`, and `collectEvidence` reads episodes/events/command-runs for that one session with no child traversal. Reproduced: identical failing command, legacy line → 1 candidate on the primary; with `agent_id` → **0 on the primary, 1 on the child**. This story caused it, and `CLAUDE.md` documents the nudge as subagent-triggered.

- [x] [Review][Patch] **An unreplayable entry still materializes a ghost child session** [src/capture/spool.ts:195] — resolution runs as an argument, before `replayEntry` decides the entry is usable. Reproduced: a line `{tool:'todo', agent_id:'ghost'}` yields `{processed:0, skipped:1}` and a child `ghost/active/events=0`. Contradicts the comment added in this same diff claiming an interrupted batch cannot leave a subagent session with no events. Reachable on hook/CLI version skew — the hook is installed once globally while the CLI resolves per repository.

- [x] [Review][Patch] **A child created under an already-ended primary stays `active` forever** [src/scope/runtime.ts:159] — Task 4 mandates creating the child under the ended primary, and `endSessionTree` has already run on it, so nothing will ever end the child. Reproduced: `late/active`, absent from `getUnconsolidatedSessions()`. This is exactly the structural-immortality failure `endSessionTree` was added in 0.1 to prevent.

- [x] [Review][Patch] **Non-string `agent_id` splits one subagent across two sessions** [src/capture/spool.ts:143] — `SpoolEntry.agent_id?: string` is a type lie: the hook emits whatever JSON type the payload carried, and better-sqlite3 binds a JS number as a double. Reproduced: `agent_id: 42` and `agent_id: "42"` produce two children, `"42.0"` and `"42"`. The two ingestion paths also disagree — `hook-entry.ts` uses `firstString`, which rejects non-strings outright.

- [x] [Review][Patch] **One failed resolution poisons the cache for that agent's whole batch** [src/capture/spool.ts:153] — the catch caches the fallback, so every later entry for that agent skips the retry. Reproduced: a malformed `agent_type` on the first line voids attribution for the agent's entire batch — 0 children, both events on the primary. Also throws once per entry when `agent_id` is an object, since the `Map` keys on identity.

- [x] [Review][Patch] **The hook reads only `agent_id`, while the cold path deliberately accepts `agentId` too** [hooks/claude/cortex-capture.sh:25] — Story 0.1 added two-spelling tolerance with an explicit comment that field-name drift must degrade gracefully. This story makes the bash hook the only live path, so that tolerance is now on dead code. If the host spells it `agentId`, the whole feature is a silent no-op with no test or diagnostic that would reveal it.

- [x] [Review][Patch] **`agent_type` is frozen at first sighting** [src/scope/runtime.ts:154] — a first line without `agent_type` permanently records `'subagent'`; a later line carrying the real type is ignored.

- [x] [Review][Patch] **Test and documentation accuracy** — (a) the jq-count assertion is a whole-file magic number, so it stays green if one branch gains a `jq` while setup loses one, despite its comment claiming one-per-branch; (b) `describe.skipIf` means the only coverage of the shell change vanishes silently on a machine without `jq`; (c) `resolveAgentSessionId`'s docstring claims it keys off the "recorded" primary, but nothing is recorded — `cli.ts:428` resolves whatever is active now; (d) `README.md` was not updated, which `deferred-work.md` item 4 explicitly said to revisit when 0.2 landed; (e) `deferred-work.md` item 1 was not annotated as closed; (f) the story's Task 6 cites "the three options" in `deferred-work.md`, which contains a paragraph and no options; (g) the Change Log's "on the installed Claude path" is false for any existing install until `cortex install-hooks --claude` is re-run.

- [x] [Review][Defer] **Concurrent spool appends tear lines above the stdio buffer** [hooks/claude/cortex-capture.sh:58] — deferred, pre-existing. Measured by a reviewer: 16 concurrent hook invocations, 848-byte lines 16/16 intact, 2.8 KB 13/16, 53 KB 14/16. The `Bash` branch embeds uncapped `stdout`/`stderr`, so a real failing-test capture lands well past one buffer and torn lines are dropped by `parseSpoolLines`. Predates this story; parallel subagents make it easier to hit. Wants its own work item — likely capping the captured streams in jq.

- [x] [Review][Defer] **The same `agent_id` in one scope binds to a previous primary's ended child** — deferred. Follows directly from `getSessionByAgentId` being unfiltered by parent and status, which Task 4 forbids changing because AC #3 depends on it. Agent-id uniqueness across primaries is now a load-bearing assumption about the host; worth stating in the architecture rather than patching here.

- [x] [Review][Defer] **Subagent evidence is unreachable from primary-scoped consumers** — deferred, already logged as `deferred-work.md` item 2 (Epic 5 owns child-timeline rendering). `cortex_summarize`, the session tail, `collectRecentFiles` and `summarizeScope` all read a single session id. `promoteSubagentNotes` exists for this and has zero call sites.

**Dismissed (1):** "the change is inert on this machine" — the installed `~/.claude/hooks/cortex-capture.sh` is stale, which is the accepted risk in readiness report Observation 2, owned by Story 2.3. Its documentation consequence is patched above.

## Dev Notes

### What this story actually turns on

Story 0.1 built and proved the resolver; nothing in the installed runtime reaches it. `PostToolUse` is wired to `hooks/claude/cortex-capture.sh` only (`src/transports/cli.ts:515-519`), which appends one JSON line via `jq` and never invokes `hook-entry post`. `flushSpool` then replays the whole batch into a single session id. This story closes that gap, and it is the point at which subagent tool calls stop polluting the parent's timeline on a real machine.

### Why the hook must stay one `jq` call

N-4 is absolute: no Node per tool call, and the repo rejects any design that shells out per tool call on principle. B-4 gives the non-substituting path 15 ms wall clock. The current script spends one `jq` per event; adding two field reads to that same program costs nothing measurable. Adding a second `jq`, a `$(...)` capture, or a `grep` would roughly double process count on the hot path. The existing `Bash` branch already shows the conditional-merge idiom to copy.

### Layering

`src/capture/` may import from `src/scope/` — `capture/hooks.ts` already imports `syncBranchSnapshotForSession` from `scope/runtime.js`. So `spool.ts` importing a resolver from `scope/runtime.js` follows precedent and does not violate AD-1. `scope/runtime.ts` already imports `capture/consolidate.js`; the new edge is `capture/spool → scope/runtime → capture/consolidate`, which is not a cycle at module level, but keep the resolver a small leaf function so it stays easy to reason about.

### Idempotence (N-7)

`processClaimFile` hashes the raw claim file content and stores `spool_processed:<sha1>` in `meta`, committing the marker inside the same transaction as the replay. Adding fields changes the hash of *new* lines, which is fine — replaying the same bytes twice still no-ops. What must be verified is that child-session creation is inside that transaction: if the batch is replayed after a crash, it must not leave a second child session behind.

### Attribution after the parent ends

Story 0.1 added `endSessionTree`, so when a primary ends its children end with it. A spool line arriving after that finds an **ended** child — `getSessionByAgentId` filters by neither status nor parent, deliberately, and that is what AC #3 depends on. A reviewer proposed adding `AND parent_session_id = ?` during 0.1's review; it was rejected precisely because it breaks this AC. Do not reintroduce it.

### Known trap from Story 0.1

Test code is not typechecked — `tsconfig.json` excludes `tests/` and vitest transpiles without checking, so `npm run lint` will not catch a type error there. Worse for this story: a test can pass while asserting nothing. Three tests in 0.1 passed with the feature deleted and had to be rewritten after review. Before claiming a test covers something, ask whether it would fail if the code under test were removed — and for the hook-script test, actually delete the field from the jq program and confirm the test goes red.

### Constraints binding on this story

- **N-4** no process per tool call · **B-4** ≤15 ms non-substituting PostToolUse · **B-5** 256 KiB batch flush ≤2 s, off the critical path.
- **N-7** idempotent capture; replay produces identical state.
- **AD-12 / N-3** degradation is silent and total — hooks exit 0, a failed resolution must not abort a batch or surface an error.
- **AD-9** session identity is `(scope_key, agent_id)`.
- **P-4** the hook protocol is a compatibility surface. Old-format lines must keep working (Story 0.1 pinned this); new-format lines must be readable by this build.
- Hook scripts in `hooks/claude/*.sh` are **templates** — `__CORTEX_NODE__`, `__CORTEX_CLI__`, `__CORTEX_HOOK_ENTRY__` are substituted at install time. Never hardcode paths.
- Windows first-class: hooks run under Git Bash and depend on `jq`. Temp dirs via `os.tmpdir()`.

### Testing standards

- Store fixture exactly: `new Database(':memory:')` → `db.pragma('foreign_keys = ON')` → `applySchema(db)` → `initializeMeta(db, root)` → `new CortexStore(db)`.
- Import specifiers end in `.js`, including in `tests/`.
- Shelling out in tests is established — `tests/references.test.ts` runs `git` via `execFileSync`. Follow that shape for the hook-script test, but guard on `bash`/`jq` availability so the suite degrades to skipped rather than failing on a machine without them.
- Existing suites assert rendered output strings and row contents. Match that.

### Verification

```bash
npm run build && npm run lint && npx vitest run
```

Baseline entering this story: **444 tests green** at `71d8a6f`. A red run means this story caused it.

Locked eval suites are **not** required unless Task 6 scopes the episode lookup — that path feeds `memory_items`. If it does:

```bash
node dist/transports/cli.js evaluate --suite eval/suites/<name>.json --compare eval/baselines/<name>.json
```

### Project Structure Notes

| File | Change |
|---|---|
| `hooks/claude/cortex-capture.sh` | emit `agent_id` / `agent_type` in all three branches |
| `src/capture/spool.ts` | `SpoolEntry` fields; per-entry resolution with per-batch memoization |
| `src/scope/runtime.ts` | export `resolveAgentSessionId` |
| `src/index.ts` | export the new symbol (exhaustive hand-maintained list) |
| `src/db/store.ts` | only if Task 6 scopes the episode lookup |
| `CLAUDE.md` | drop the "not yet reachable" caveat |
| `tests/spool.test.ts` | mixed-batch, idempotent replay, ended-parent |
| `tests/capture-hook.test.ts` | **new** — executes the real hook script |

No new dependency. Conventional Commits, lowercase subject (`fix:` — Epic 0 is a defect fix).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-0.2] — story statement and the three ACs
- [Source: _bmad-output/planning-artifacts/architecture/architecture-cortex-2026-07-24/ARCHITECTURE-SPINE.md#AD-9] — session identity; also AD-1, AD-2, AD-12
- [Source: _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md#10-Performance-Budgets] — B-4, B-5
- [Source: _bmad-output/planning-artifacts/implementation-readiness-report-2026-07-24.md#Observation-2] — stale-hook risk: accepted, bounded, owned by Story 2.3
- [Source: _bmad-output/implementation-artifacts/0-1-resolve-sessions-by-agent-identity.md] — the resolver this story wires up, plus its review findings
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — Task 6's decision and its three options

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

- RED gate: 7 of the 10 new tests failed before implementation. The three that passed were the two static N-4 assertions and `omits the agent fields entirely for a primary tool call`, which pins existing behavior.
- Verification: `npm run build` ✅ · `npm run lint` ✅ · `npx vitest run` ✅ **455 passed / 24 files** (baseline 444; +11).
- Eval gate run although Task 6 did not scope the episode lookup: all five locked suites at zero delta on every metric.
- Mutation-checked the hook script per the story's own instruction: deleting the `agent_type` merge from the jq program turns two `capture-hook` tests red. The test observes the script, not a copy of it.
- `bash` 5.x and `jq` 1.8.1 are both present on this machine, so `tests/capture-hook.test.ts` executed rather than skipped.

### Completion Notes List

- **The hook emits identity from the same `jq` call.** `AGENT_FIELDS` is defined once and concatenated into all three branch programs, so there is still exactly one `jq` invocation per event and no new process on the hot path (N-4, B-4). Both operands of jq's `+` see the same input, so `.agent_id` inside the merge reads the hook payload rather than the object being built. Fields are omitted when absent, so a primary-session line stays byte-identical to the pre-agent-identity format — which keeps the processed-marker content hash stable for primary-only batches.
- **`flushSpool`'s signature is unchanged.** `sessionId` still means the primary the batch belongs to; per-entry resolution happens inside. All four production call sites (`cli.ts` ×3, `hook-entry.ts` ×1) were enumerated with `find_referencing_symbols` and none needed touching.
- **Resolution is memoized per batch and runs inside the replay transaction**, so a 256 KiB batch from one subagent costs one lookup, and an interrupted batch cannot leave a child session with no events. A resolution failure degrades to the batch's own session rather than aborting (AD-12).
- **AC #3 holds because of a decision made in 0.1:** `getSessionByAgentId` filters by neither status nor parent. Story 0.1's review proposed adding a parent filter; it was rejected precisely to keep this AC satisfiable. A late line for a subagent whose whole session tree has been ended still lands on that child, verified by test.
- **Task 6 — superseded by review. The original decision below was wrong.** I recorded that the fold was harmless because it matched pre-0.1 behavior; that holds only when the *primary* fails first. In the child-first ordering the parent's later identical failure folded into a child-owned episode and the parent got none — a real regression, and the ordering the deferral was actually about. The fold is now **scoped to the recording session**. The reasoning that follows is retained for the record, not as current behavior.
- ~~**Task 6 decided: the command-failure fold stands.**~~ An identical `command_failure` inside the 24-hour window bumps the existing episode rather than creating a second one, so the episode stays on the session that first recorded it even when a subagent hit the same failure. Rationale, with the capture path now in hand: this is **not a regression** — before Story 0.1 the subagent's command was captured against the parent directly and folded identically, so the observable outcome is unchanged. Splitting it would put two identical `command_failure` items into retrieval, which is exactly what the fold exists to prevent, and would touch `memory_items` for no benefit. Recorded as a stated exception to Story 0.1's AC #2 in `CLAUDE.md` and pinned by a test so it stops being accidental. The command *event* and its `command_run` row are still attributed to the child; only the folded episode is not.
- **Not built, deliberately:** stale-hook detection. A user who upgrades the package but keeps an old `cortex-capture.sh` silently never gets subagent attribution. That is the accepted, documented risk in readiness report Observation 2, owned by Story 2.3's hook-version check. `CLAUDE.md` now names the fix (`cortex install-hooks --claude`) without building detection here.

### File List

- `hooks/claude/cortex-capture.sh` — modified
- `src/capture/spool.ts` — modified
- `src/scope/runtime.ts` — modified
- `src/index.ts` — modified
- `CLAUDE.md` — modified
- `tests/spool.test.ts` — modified
- `tests/capture-hook.test.ts` — added

### Change Log

| Date | Change |
| --- | --- |
| 2026-07-24 | Code review (3 parallel layers): 2 decisions resolved, 8 patches applied, 3 deferred, 1 dismissed. **Task 6's decision was remade** — the review proved my recorded rationale false in the child-first ordering, and the `command_failure` fold is now scoped to the recording session. Also fixed: the Stop-hook nudge was blinded in the only case it fires (it now walks the session tree); an unreplayable entry no longer creates a ghost child; a child created under an ended primary is ended immediately; non-scalar and numeric `agent_id` are normalized; a malformed `agent_type` no longer voids an agent's batch; the hook accepts camelCase identity; `agent_type` upgrades from a placeholder; the jq-count assertion is now per-branch; `README.md` gained a Subagent attribution section. AC #1's B-4 clause recorded as not-met-with-cause. Suite 465 green, eval suites at zero delta. |
| 2026-07-24 | Story implemented. The PostToolUse hook carries `agent_id`/`agent_type` on every spool line and the flush resolves each entry to its own session, so subagent tool calls reach their own child session on the installed Claude path. Task 6 resolved: the command-failure episode fold stands, documented as a stated exception and pinned by test. 11 tests added including the first suite that executes a hook script for real. Suite 455 green, all five locked eval suites at zero delta. Status → review. |
