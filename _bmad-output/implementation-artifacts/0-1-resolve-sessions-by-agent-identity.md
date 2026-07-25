---
baseline_commit: 0f4b8ddcede5e7d6acb7ae9347993dc300395f15
---

# Story 0.1: Resolve sessions by agent identity

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Cortex maintainer,
I want hook payloads carrying an `agent_id` to resolve to a child session rather than the parent,
so that subagent activity stops silently polluting the parent's timeline.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 0 → Story 0.1. Do not reword, split, or extend these. If one is wrong, stop and say so rather than implementing around it.

1. **Given** a PostToolUse payload with no `agent_id`
   **When** the session is resolved for the payload's `cwd`
   **Then** it resolves to the scope's active primary session
   **And** existing capture behavior is unchanged.

2. **Given** a PostToolUse payload carrying `agent_id` and `agent_type`
   **When** the session is resolved
   **Then** a child session is created on demand with `parent_session_id` set to the scope's active primary session, `agent_type` from the payload, and the scope's `scope_key`
   **And** the event is attributed to the child, never the parent.

3. **Given** two payloads carrying different `agent_id` values in the same scope
   **When** both are resolved
   **Then** they resolve to two distinct child sessions
   **And** neither is attributed to the other.

4. **Given** a payload whose `agent_id` matches an existing child session
   **When** it is resolved
   **Then** the existing child is reused rather than duplicated.

5. **Given** the spool carries entries recorded before this change with no `agent_id` field
   **When** the flush replays them
   **Then** they resolve to the primary session without error (N-7 idempotence preserved).

## Tasks / Subtasks

- [x] **Task 1 — Add `agent_id` to the sessions table** (AC: #2, #3, #4)
  - [x] Add `agent_id TEXT` to the `sessions` DDL in `CORE_TABLES` (`src/db/schema.ts`) for fresh databases.
  - [x] Add `ensureColumn(db, 'sessions', 'agent_id', 'agent_id TEXT')` to `ensureSessionScopeColumns` for existing databases. **Do not bump `SCHEMA_VERSION`** — see Dev Notes § Migration rule.
  - [x] Add `CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(scope_key, agent_id);` to the `INDEXES` block — `(scope_key, agent_id)` is the AD-9 identity and the lookup key.
  - [x] Add `agent_id: string | null` to `SessionRow` and `agentId?: string` to `CreateSessionOpts` in `src/db/store.ts`; thread it through the `createSession` INSERT (`opts.agentId ?? null`).

- [x] **Task 2 — Primary-session resolution must never return a child** (AC: #1, #2)
  - [x] Change `CortexStore.getCurrentSession()` to `WHERE status = 'active' AND parent_session_id IS NULL`. Today every row has `parent_session_id IS NULL`, so this is behavior-preserving; without it, an active child becomes "the current session" and the fix inverts itself. See Dev Notes § The trap.
  - [x] Verify the four semantically affected call sites still behave: `src/scope/runtime.ts:125`, `src/query/suggest-notes.ts:36`, `src/query/summarize.ts:82`, `src/transports/cli.ts:207`.

- [x] **Task 3 — Child lookup and creation in the store** (AC: #3, #4)
  - [x] Add `getSessionByAgentId(scopeKey: string, agentId: string): SessionRow | undefined`, keyed on `(scope_key, agent_id)` per AD-9, ordered `started_at DESC, rowid DESC LIMIT 1`.
  - [x] Do **not** filter this lookup by `status` or by parent — AC #4 requires reuse, and Story 0.2's third AC requires a child to remain findable after its parent has ended.

- [x] **Task 4 — Teach `ensureScopedSession` about agent identity** (AC: #1, #2, #3, #4)
  - [x] Extend `ScopeSessionOptions` in `src/scope/runtime.ts` with optional `agentId?: string` and `agentType?: string`.
  - [x] No `agentId` → current behavior, unchanged, byte for byte.
  - [x] With `agentId` → resolve the primary session first (so scope rotation, snapshot sync and session end still happen exactly once and only on the primary), then return the existing child for `(scope_key, agentId)`, or create one with `parentSessionId` = primary id, `agentType` = payload value defaulting to `'subagent'`, and the primary's full scope fields (`gitRoot`, `worktreePath`, `branchRef`, `headOid`, `scopeType`, `scopeKey`).
  - [x] Never end, rotate, or snapshot a child session in this path.

- [x] **Task 5 — Extract agent identity from the hook payload** (AC: #1, #2)
  - [x] In `src/transports/hook-entry.ts`, read `agent_id` / `agent_type` from the payload using the existing `firstString(...)` fallback idiom — accept `agent_id` and `agentId`, `agent_type` and `agentType`. A field-name drift in the host must degrade to today's primary-session behavior, never break capture.
  - [x] Thread the identity through `resolveSessionId(store, cwd, options)` into `ensureScopedSession`. `options.sessionId`, when supplied, still wins — tests and callers depend on it.
  - [x] Applies to the `post` action. Leave the `reflect-*` and `end-of-turn` actions on the primary session: reflex and the Stop nudge are parent-facing surfaces, and `end-of-turn` flushes the whole spool batch.

- [x] **Task 6 — Regression guards** (not in the epic ACs; required for end-to-end correctness — see Dev Notes § Ripple)
  - [x] Restrict `getRecentSessionsByScope` and `getSessionCountByScope` to primary sessions (`parent_session_id IS NULL`). These feed branch snapshots, the recent-session tail, and the consult gate; with zero children today the output is identical, and Epic 5 opts children in deliberately when it owns rendering.
  - [x] Make `syncBranchSnapshotForSession` a no-op for a child session — a subagent's reads must not rewrite the branch snapshot. `handleReadEvent`/`handleEditEvent`/`handleWriteEvent`/`handleCmdEvent`/`handleAgentEvent` all call it on every event.

- [x] **Task 7 — Tests** (AC: #1–#5)
  - [x] `tests/store.test.ts` — `agent_id` round-trips through `createSession`; `getSessionByAgentId` finds by `(scope_key, agent_id)`, returns `undefined` for an unknown id, and does not cross scopes; `getCurrentSession` skips an active child and returns the primary.
  - [x] `tests/scope.test.ts` — the five ACs against `ensureScopedSession`: no `agentId` → primary; `agentId` → child with correct `parent_session_id`/`agent_type`/`scope_key`; two ids → two children; same id twice → one child; a child is never created for a scope with no primary rotation side effects.
  - [x] `tests/hook-entry.test.ts` — a `post` payload carrying `agent_id` attributes its event to the child (`getEventsBySession(child.id)` non-empty, parent's unchanged); the same payload without `agent_id` attributes to the primary.
  - [x] `tests/spool.test.ts` — a spool file of pre-change lines (no `agent_id` field) replays into the primary session without error, and replaying the identical batch twice changes nothing (N-7).
  - [x] `tests/schema.test.ts` — `ensureCortexSchema` on a store created without `agent_id` adds the column and leaves `schema_version` at 4; running it twice is a no-op.

- [x] **Task 8 — Public surface and docs**
  - [x] Nothing new is exported from `src/scope/runtime.ts` or `src/db/store.ts` as a *symbol*, but `ScopeSessionOptions` and `CreateSessionOpts` are already re-exported from `src/index.ts` and gain fields — confirm no new export line is needed and that `tsc` is clean.
  - [x] `CLAUDE.md` § Expected Behavior: add one line stating that a hook payload carrying `agent_id` resolves to a child session keyed `(scope_key, agent_id)` and is never attributed to the parent. Same commit as the behavior change.

### Review Findings

Code review of commit `1982226` against baseline `0f4b8dd`, three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). Every finding below was independently reproduced against `dist/` before being rated — reviewer-assigned severities were discarded.

- [x] [Review][Defer] **`findRecentEpisodeBySummary` folds a child's command failure into the parent's episode** — deferred to Story 0.2: unreachable until the spool carries agent identity, so it is decided there with the real capture path in hand rather than speculatively. Detail: `store.findRecentEpisodeBySummary('command_failure', summary, dayAgo)` (`src/db/store.ts`) filters by neither session nor parentage, so a subagent's failing `npm test` within 24h of an identical parent failure bumps the *parent's* episode row and re-upserts the parent-owned `memory_items` projection at `(seen 2x)`. The child gets no episode of its own. This leaks AC #2 ("attributed to the child, never the parent"). Ambiguous: cross-session folding within a day is deliberate existing behavior, and scoping it would change established dedup semantics and may move eval metrics. Not reachable in the shipped wiring (PostToolUse does not spawn Node), so it becomes live with Story 0.2.

- [x] [Review][Patch] **A subagent payload in a different scope ends and rotates the primary** [src/scope/runtime.ts:166] — `ensureScopedSession` calls `ensurePrimarySession` unconditionally *before* branching on `agentId`, with the subagent's own `cwd`. When that `cwd` resolves to a different `scope_key` (worktree-isolated agent, nested repo, submodule) the parent's active session is snapshot-synced and ended mid-turn, a new primary is created, and the child is parented to the wrong one. Reproduced: `primary.status → 'ended'`, `child.parent_session_id !== primary.id`, `getCurrentSession() !== primary`. Directly contradicts the guarantee stated in that function's own doc comment, and the regression test written for it passes the same `resolveScope` to both calls, so it is structurally incapable of entering the rotation branch.

- [x] [Review][Patch] **The CLAUDE.md contract line over-claims** [CLAUDE.md:72] — written unqualified in the present tense, but no installed hook supplies `agent_id`: `PostToolUse` runs `cortex-capture.sh`, which appends a spool line and never invokes `hook-entry post`. `reflect-pre` also still resolves without identity, so subagent edits bill reflex to the primary. The sentence "Subagent activity is never attributed to the parent" is false in the shipped wiring until Story 0.2. The adjacent claim that "scope session counts read primary sessions only" is also broader than the code — only the two *scoped* queries were filtered.

- [x] [Review][Patch] **`(scope_key, agent_id)` is not unique and resolution is check-then-insert** [src/db/schema.ts:246, src/scope/runtime.ts:141] — `idx_sessions_agent` is a plain index and `ensureAgentSession` reads then inserts with no transaction or uniqueness guard. Reproduced: two `createSession` calls with identical `(scope_key, agent_id)` both succeed; `getSessionByAgentId` masks the duplicate with `LIMIT 1`, stranding the older row's events behind every `parent_session_id IS NULL` filter. Hooks run as independent processes on separate connections, so this is a real race once Story 0.2 wires the path.

- [x] [Review][Patch] **Child sessions are never ended, so they are never consolidated and never GC-eligible** [src/scope/runtime.ts:201] — `endSession` is only ever called on `getCurrentSession()`, which is now primary-only. Reproduced: after a primary rotation the child remains `status='active'` indefinitely and is absent from `getUnconsolidatedSessions()`; `db/gc.ts` prunes events only from ended-and-summarized sessions, so a child's raw events are structurally exempt from `cortex gc --apply` at any age cutoff. This story creates the rows, so it owns their disposal.

- [x] [Review][Patch] **`getPreferredScope` falls through to a child session** [src/query/scope.ts:11] — the fallback is `store.getCurrentSession() ?? store.getRecentSessions(1)[0]`, and `getRecentSessions` was left unfiltered. Reproduced: with the primary ended and an orphaned active child present (exactly the state the previous finding produces), `getPreferredScope` returns the child, so the scope label and session-count anchor for `cortex_state` derive from a subagent session.

- [x] [Review][Patch] **Three tests assert less than they claim** — (a) the rotation test cannot enter the branch it names, see above; (b) `keeps subagent activity out of the branch snapshot` passes byte-identically with the `syncBranchSnapshotForSession` guard removed, because `recent_files` already comes from the primary-filtered `getRecentSessionsByScope` — the guard has zero coverage; (c) the spool AC #5 test is vacuous: the spool format has no agent-id concept in any version, so `flushSpool` structurally cannot create a child and the assertion holds with the entire feature deleted.

- [x] [Review][Patch] **Dev Agent Record RED-gate arithmetic is self-contradictory** — "16 of 17 new tests failed" plus "the two that passed" totals 18. Actual: 17 tests added, 15 of them failed pre-implementation; the 16th failure in the RED run was the modified index assertion inside an existing test.

- [x] [Review][Defer] **`reflect-pre` bills subagent edits to the primary and consumes its reflex dedupe slot** [src/transports/hook-entry.ts:400] — deferred, pre-existing. Unchanged by this diff and explicitly scoped out; Epic 5 owns parent/child reflex routing.

- [x] [Review][Defer] **Subagent file activity has no read path** [src/scope/runtime.ts:13] — deferred, pre-existing shape. Raw `read`/`edit`/`write` events never project into `memory_items`, so with Task 6's primary-only filters a subagent's file activity is captured but surfaced nowhere. Epic 5 owns child-timeline rendering (Story 5.1 AC 2).

- [x] [Review][Defer] **README not updated** [README.md] — deferred. No user-visible behavior changes until Story 0.2 wires the path; README carries no session-identity model to correct yet.

**Dismissed as noise (3):** filtering `getSessionByAgentId` by parent or status — would directly break Story 0.2's third AC, which requires a child to stay findable after its parent ends; `agent_type` being free text and able to disagree with `parent_session_id` — parentage is the discriminator by design and nothing filters on `agent_type`; "the feature is unreachable in the shipped runtime" — the documented, accepted 0.1/0.2 split (epics.md, readiness report Observation 2), though its documentation consequence is patched above.

## Dev Notes

### What is actually broken

Session resolution keys on `cwd` alone (`ensureScopedSession` → `getCurrentSession`), so every subagent tool call lands in the parent's session. Confirmed against the live store at the time of writing: **61 sessions, all `agent_type = 'primary'`, zero with `parent_session_id`, `schema_version` 4, no `agent_id` column.**

### Migration rule — do not bump SCHEMA_VERSION

Story 3.1 is the first *table*-creating story in R1 and owns the single `SCHEMA_VERSION` 4 → 5 bump for the whole release (`epics.md` Validation Finding 2, AD-11). This story adds a **column**, which the existing machinery already handles version-independently: `applySchema` calls `ensureSessionScopeColumns` unconditionally on every open, and `ensureColumn` is a no-op when the column exists. That is exactly how `git_root`, `scope_key` and friends were added. Adding the column without a version bump is additive, idempotent, survives partial application, and leaves the store openable by the previous binary (`SELECT *` simply returns one extra nullable field).

### The trap — `getCurrentSession` returns any active session

`getCurrentSession()` is `WHERE status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1` with no parentage filter. Child sessions created by this story stay `active` (their lifecycle is Story 5.1's), so the newest child would become "the current session" and `ensureScopedSession`'s primary path would resolve to it — re-creating the exact misattribution this story exists to fix, with the direction reversed. Task 2 is not optional.

`certify_refs` on `getCurrentSession`: 11 sites, 9 LSP + text, 2 test-only, 0 manifest. Five read scope fields only and are unaffected (`src/query/scope.ts:11`, `src/query/validate-memory.ts:59`, `src/eval/harness.ts:131`, `src/transports/hook-entry.ts:113`, `src/transports/cli.ts:227` and `:267`). Four are semantically affected and are the ones to check:

| Site | Why it matters |
|---|---|
| `src/scope/runtime.ts:125` | primary resolution — the trap itself |
| `src/query/suggest-notes.ts:36` | Stop-hook nudge would read the child's events instead of the turn's |
| `src/query/summarize.ts:82` | `cortex_summarize` would summarize the subagent |
| `src/transports/cli.ts:207` | `inject-header` would end the child instead of the previous primary |

### Ripple — scope queries start returning children (Task 6)

`getRecentSessionsByScope` and `getSessionCountByScope` filter on `scope_key` only. A child inherits the parent's `scope_key`, so the moment children exist they enter:

- `summarizeScope` and `collectRecentFiles` (`src/scope/runtime.ts:39`, `:10`) → branch snapshot content
- `resolveRecentSessions` (`src/query/state.ts:215`) → the recent-session tail in `cortex_state`
- `hasPriorScopeSessions` (`src/transports/hook-entry.ts:120`) and `src/query/state.ts:349` → consult-gate firing and the session count

CLAUDE.md's behavior contract says branch snapshots and recent-session tails must not be raw hook activity. Restricting these two queries to primary sessions keeps today's output identical (every session is primary right now) and leaves Epic 5 — which owns rendering of child timelines (Story 5.1 AC 2) — free to opt children in deliberately.

### Scope boundary — what this story does NOT fix

In the installed Claude wiring, `PostToolUse` runs only `hooks/claude/cortex-capture.sh`, which appends a spool line via bash; it never invokes `hook-entry.js post`. `flushSpool(store, dir, sessionId)` then takes **one** session id and `replayEntry` applies it to every entry in the batch. So this story builds and proves the resolver, but the live Claude path only starts attributing correctly once **Story 0.2** carries `agent_id` through the spool and makes flush resolve per entry. That is the intended split, not an omission. Do not pull 0.2's spool changes forward.

### Existing code that already anticipates children

`promoteSubagentNotes` (`src/capture/consolidate.ts:270`) walks `getChildSessions(parentId)` and promotes child notes to the parent, handling exact duplicates and conflicts. It has never had a child to walk. It is dormant capability, like `notes.conflict` — do not reimplement note promotion, and do not "fix" it in this story.

### Constraints binding on this story

- **AD-9** — session identity is `(scope_key, agent_id)`. A payload without `agent_id` resolves to the primary. No capture is attributed to a session whose `agent_id` differs from the payload's.
- **AD-1** — layer direction `transports/` → `query/` → `memory/` + `scope/` → `db/`. Agent extraction belongs in `transports/hook-entry.ts`; resolution in `scope/runtime.ts`; persistence in `db/`. Do not import upward.
- **AD-12 / N-3** — hook and capture edges swallow errors with a `catch {}` and a comment stating why. A memory failure must never break the turn.
- **N-4** — never spawn Node per tool call. This story adds nothing to the hot path; `hooks/claude/*.sh` is untouched here (that is Story 0.2).
- **N-7** — replaying a spool batch produces identical state. AC #5 pins this for pre-change lines.
- **Time** — ISO-8601 UTC strings in `TEXT`. Ids are application-generated (`crypto.randomUUID()`), never autoincrement.

### Testing standards

- Store fixture, replicated exactly: `new Database(':memory:')` → `db.pragma('foreign_keys = ON')` → `applySchema(db)` → `initializeMeta(db, root)` → `new CortexStore(db)`. Foreign keys are off by default and `sessions.parent_session_id` is an FK — a missing pragma hides referential bugs.
- Import specifiers end in `.js` even from `.ts`, including in `tests/`.
- Temp dirs via `os.tmpdir()`, never a literal `/tmp` — Node and Git Bash resolve it to different filesystems on Windows.
- **`npm run lint` does not typecheck `tests/`.** `tsconfig.json` excludes the tree and vitest transpiles without checking, so type errors in tests are invisible to both commands. Read test code carefully; the compiler will not catch you.
- Tests that touch engagement state need an isolated temp cwd (commit `22530d8`).
- Assert observable behavior — rendered strings and row contents — not implementation shape, matching the existing suites.

### Verification

All four, in order, before any claim of completion:

```bash
npm run build && npm run lint && npx vitest run
```

The locked eval gate is **not** required for this story: no ranking, tokenization, reference-validation or output-shaping code is touched. If Task 6 turns out to change any rendered surface, that assumption is void — run the suites and reject on any negative `top1_hit`/`recall_at_3` delta or positive `output_tokens` delta.

Baseline as of this story: `main` had one failing test (`tests/state.test.ts`, wall-clock-dependent fixture), fixed in `0f4b8dd`. The suite is green at 421 tests — a red run means this story caused it.

### Project Structure Notes

Files to touch, all existing — this story creates no new module:

| File | Change |
|---|---|
| `src/db/schema.ts` | `agent_id` in `CORE_TABLES`, `ensureSessionScopeColumns`, `INDEXES` |
| `src/db/store.ts` | `SessionRow.agent_id`, `CreateSessionOpts.agentId`, `createSession`, `getCurrentSession`, new `getSessionByAgentId`, primary filter on the two scope queries |
| `src/scope/runtime.ts` | `ScopeSessionOptions.agentId`/`agentType`, child resolution, snapshot guard |
| `src/transports/hook-entry.ts` | agent-identity extraction, `resolveSessionId` |
| `CLAUDE.md` | one behavior line |
| `tests/{store,scope,hook-entry,spool,schema}.test.ts` | per Task 7 |

No new dependency. Conventional Commits, lowercase subject (`fix:` — this is a defect fix, not a feature).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-0-Session-Identity-Correction] — story statement, all five ACs, Validation Finding 2 (`SCHEMA_VERSION` discipline)
- [Source: _bmad-output/planning-artifacts/architecture/architecture-cortex-2026-07-24/ARCHITECTURE-SPINE.md#AD-9] — session identity `(scope_key, agent_id)`; also AD-1, AD-11, AD-12, AD-16
- [Source: _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md#15-Open-Questions] — Q1 resolution: hook payloads carry `agent_id` and `agent_type`, verified against Claude Code v2.1.170; the live defect is named there
- [Source: _bmad-output/planning-artifacts/implementation-readiness-report-2026-07-24.md#Observation-2] — accepted, bounded risk: a user on a stale `cortex-capture.sh` keeps emitting old-format lines; owned by Epic 2, do not reopen
- [Source: _bmad-output/project-context.md] — 41 binding implementation rules; testing rules and the four-command verification block

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

- RED gate: 15 of the 17 new tests failed before implementation. The RED run showed 16 failures because it also included a modified assertion inside the existing `creates all expected indexes` test. The two new tests that passed pre-implementation were regression pins rather than new behavior: `does not rotate or end the primary session` (vacuous while `agentId` was ignored — code review later showed it was vacuous *after* implementation too, and it has been rewritten) and the spool legacy-line replay.
- Verification after implementation: `npm run build` ✅ · `npm run lint` ✅ · `npx vitest run` ✅ **438 passed / 23 files** (baseline 421; +17).
- Verification after review patches: build ✅ · lint ✅ · **444 passed / 23 files** (+6).
- Eval gate run at both points despite the story's "not required" note, because Task 6 touches two queries that feed rendered surfaces. All five locked suites, zero delta on every metric both times:
  `budget`, `kind-ordering`, `rename-moved`, `stale-label`, `stemming` → `{top1_hit_delta: 0, recall_at_3_delta: 0, noise_count_delta: 0, stale_count_delta: 0, output_tokens_delta: 0}`.
- Review patches were verified by reproduction, not by the suite alone: all 11 reproduction probes flipped from BROKEN to FIXED, and the rewritten snapshot-guard test was mutation-checked — removing the guard makes it fail, where the original test passed either way.

### Completion Notes List

- **`agent_id` added as a column, not a table.** `SCHEMA_VERSION` stays at 4; Story 3.1 still owns the single 4 → 5 bump for R1. Delivered via `ensureColumn` inside `ensureSessionScopeColumns`, which `applySchema` runs unconditionally on every open — additive, idempotent, and openable by the previous binary. A test pins both the column and the unchanged version.
- **`getCurrentSession` is now primary-only** (`parent_session_id IS NULL`). Without it the newest active subagent would have become "the current session" and every primary-path caller would have written into it — the original defect with its direction reversed. Behavior-preserving today: every existing row has a null parent.
- **Rotation stays on the primary.** `ensureScopedSession` was split into `ensurePrimarySession` (scope rotation, snapshot sync, session end) and `ensureAgentSession` (find-or-create by `(scope_key, agent_id)`). A subagent payload can never end or rotate the session it belongs to. A subagent payload arriving before any primary exists creates the primary first, then the child under it.
- **Child lookup is deliberately unfiltered by status and parent**, so a spooled entry replayed after its parent ended still finds its own session — required by Story 0.2's third AC and pinned by a test here.
- **Regression guards (Task 6).** `getRecentSessionsByScope` and `getSessionCountByScope` are primary-only, and `syncBranchSnapshotForSession` no-ops for a child. Together these keep subagent reads out of branch snapshots, the recent-session tail, and the consult-gate session count. Identical output today (no children exist); Epic 5 opts children into rendering deliberately.
- **Field-name drift degrades, never breaks.** `agent_id`/`agentId` and `agent_type`/`agentType` are both accepted via the existing `firstString` idiom; an unrecognized payload shape falls through to primary attribution, which is exactly today's behavior. `agent_type` defaults to `'subagent'` when a payload carries an id but no type — defaulting to the schema's `'primary'` would make a child indistinguishable from a parent.
- **Scope boundary honored.** `hooks/claude/*.sh`, `spool.ts` and `flushSpool` are untouched. In the installed Claude wiring `PostToolUse` still only appends a spool line, so the live path starts attributing correctly when Story 0.2 lands. This story builds and proves the resolver.
- **Not touched, deliberately:** `promoteSubagentNotes` (dormant capability that already walks `getChildSessions`), child-session lifecycle/end (Story 5.1), and the `reflect-*` / `end-of-turn` actions, which stay on the primary because reflex and the Stop nudge are parent-facing and `end-of-turn` flushes the whole batch.

### File List

- `src/db/schema.ts` — modified
- `src/db/store.ts` — modified
- `src/scope/runtime.ts` — modified
- `src/query/scope.ts` — modified (review patch)
- `src/transports/hook-entry.ts` — modified
- `src/transports/cli.ts` — modified (review patch)
- `CLAUDE.md` — modified
- `tests/store.test.ts` — modified
- `tests/schema.test.ts` — modified
- `tests/scope.test.ts` — modified
- `tests/hook-entry.test.ts` — modified
- `tests/spool.test.ts` — modified
- `_bmad-output/implementation-artifacts/deferred-work.md` — added (review)

### Change Log

| Date | Change |
| --- | --- |
| 2026-07-24 | Story implemented. Sessions resolve by `(scope_key, agent_id)` per AD-9; hook payloads carrying `agent_id` attribute to a child session instead of the parent. 17 tests added, full suite 438 green, all five locked eval suites at zero delta. Status → review. |
| 2026-07-24 | Code review (3 parallel layers): 7 patches applied, 4 deferred, 3 dismissed. Fixed a high-severity defect where a subagent payload resolving to a different scope ended and rotated the parent's live session; added a partial unique index on the AD-9 identity plus a lost-race fallback; children now end with their primary so they stay consolidatable and GC-eligible; the scope anchor can no longer resolve to a child; corrected an over-claiming `CLAUDE.md` contract line; rewrote three tests that passed with the feature deleted. Suite 444 green, eval suites still at zero delta. |
