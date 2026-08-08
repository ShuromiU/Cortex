---
baseline_commit: 0c60aa42999fa87ca1d79222a002f63d11afc8a3
---

# Story 5.3: Write subagent conclusions back

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

> **~~BLOCKING PREREQUISITE: Story 5.2 must ship first.~~ SATISFIED 2026-08-07** — 5.2 is `done`,
> reviewed and installed machine-wide (`b3ebebd`, `195eec4`, `f73aac2`). Everything below marked
> "5.2 will…" was written BEFORE 5.2 existed; the 2026-08-07 re-check note in Dev Notes records
> which predictions held and which did not. Original text: at this baseline 5.2 was specified but
> not implemented. This story's Task 1 depends on 5.2's `wiredElsewhere` fix and its fixture
> repair, and Task 5 closes an audit 5.2 defers. Do not start until 5.2 is `done`.

## Story

As a user who paid for a subagent's investigation,
I want its conclusions to survive the subagent,
so that a 200k-token run leaves more than one paragraph behind.

## Acceptance Criteria and their status

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 5 → Story 5.3, **including
the dated 2026-08-06 amendments** — the re-base pass before this story was written, and two
further rulings taken during its validation. Do not reword, split, or extend. If one is
wrong, stop and say so rather than implementing around it.

---

**AC #1 — Given** a subagent finishes **When** `SubagentStop` fires **Then** its
`last_assistant_message` is captured and its load-bearing findings are recorded as episodes
attached to the parent's scope.

*Confirmed 2026-08-06:* `last_assistant_message` is present, and so is
`agent_transcript_path` — the subagent's complete transcript, which the PRD did not count on.
"Attached to the parent's scope" needs no work: Story 5.1's child session already inherits the
parent's `scope_key`. *"Load-bearing"* is defined (PRD §Glossary). Reuse
`suggestNotes(store, sessionId?)` for selection.

**Status: NOT MET, and the pipeline has an ordering dependency that must be built in.** No
`SubagentStop` wiring exists (`certify_refs` reports one source hit, a prose comment in
`src/capture/substitution.ts`). See § The three findings that reshape this story, #3.

---

**AC #2 — Given** a finding is note-shaped **When** write-back runs **Then** it is routed
through the non-mutating suggestion path and projects into `memory_items` only once accepted
(AD-4, FR-19).

*Stands, with the acceptance path named:* the Stop hook already surfaces high-confidence
suggestions to the parent when a subagent ran this turn, so acceptance is the parent choosing
to write the note.

**Status: the path exists and is already wired more widely than the story assumed.**
`endOfTurn` already calls `store.getSessionTreeIds(sessionId).flatMap(id => suggestNotes(store, id))`
— it walks **every child session** today. This story therefore adds the *episode*, not a second
`suggestNotes` caller. See Task 3.

---

**AC #3 — Given** a subagent attempts to modify or resolve a note authored outside its own
session **When** the operation is evaluated **Then** it is refused.

*Amended three times, all 2026-08-06.* Cortex's MCP server cannot distinguish a subagent's
call from its parent's — the twelve `ensureScopedSession` call sites in
`src/transports/mcp.ts` pass only `(store, cwd)`, and MCP carries no caller id. Enforcement is
possible only at `PreToolUse`, which does carry `agent_id` for a subagent's call and can deny.
**Ruling: enforce it**, failing **OPEN**. **Ruling (a): "its own session" means its own
SESSION TREE** — this conversation — because no note is ever stamped with a subagent's id.
**Ruling (b): the command-line route is in scope**, guarded by a cheap shell text check.

**Status: NOT MET, and the exposure is wider than the AC's own wording in three separate
ways.** See § The three findings that reshape this story, #1 and #2, and Task 4.

---

**AC #4 — Given** a new episode kind is introduced by write-back **When** the change ships
**Then** a locked eval fixture exercising that kind ships with it (AD-5).

**Status: will bind, and touches three registries rather than one.** `KIND_WEIGHTS`
(`src/memory/kind-weights.ts`) is what `checkKindCoverage` in `src/eval/gate.ts` reads, and it
has no subagent kind. `episodeState` and `episodeImportance` (`src/memory/items.ts`) also
switch on episode kind and both fall through to defaults **silently** — no error, no gate
failure, just a wrong tier and importance.

### Scope this story inherits, in writing

Listed explicitly because Story 5.2's validation caught its predecessor silently dropping half
of a re-filed pair.

- **Deferred here by Story 5.2:** exact verification that a dispatch was paired to the right
  subagent. `SubagentStart` carries no `tool_use_id`, so 5.2 could prove its pairing
  *unambiguous*, not *right*. `SubagentStop` is the first place the sidecar exists. Task 5.
- **Re-filed from `deferred-work.md`:** child-timeline rendering. Task 7.
- **Re-filed from `deferred-work.md`:** `promoteSubagentNotes`' re-activation defect. Task 6.

## The three findings that reshape this story

Each was verified against the code before this story was written, and each changes what a task
must do rather than merely adding caution.

### 1. Every note is stamped with a primary's session id — including a subagent's own

`find_referencing_symbols` on `CortexStore/insertNote` returns four call sites:
`promoteSubagentNotes` (×2, dormant), and in `src/transports/mcp.ts` the `cortex_note` handler
and the `cortex_resolve --replacement` handler. Both MCP handlers resolve their session with
`ensureSession(store, cwd)` → `ensureScopedSession(store, cwd)` — **no identity** — so they
land on the primary.

**Consequence:** comparing a note's `session_id` against the calling subagent's *child* id
would deny every subagent memory operation, including on a note that subagent wrote seconds
earlier. That is the fail-closed outcome the AC's own ruling forbids. **Ruling (a) resolves
it: compare against the session TREE** (`getSessionTreeIds`), which today always includes the
primary that stamped the note.

### 2. Three routes retire other people's decisions, not one

`insertNote`'s auto-supersede query filters by **neither session nor scope** — the source says
so: *"Deliberately NOT scope-filtered: auto-supersede has always been scope-blind."* So:

- `cortex_resolve` on a named note — the route the AC names.
- **`cortex_note`** — writing a `decision` retires every other active `decision` on that
  subject, anywhere in the store.
- **`cortex_resolve` with `replacement`** — it calls `insertNote`, so it carries the same
  auto-supersede. A named-target check alone passes it straight through.

Plus the command-line route (`note-resolve`, `edit-memory`, `delete-memory`), which ruling (b)
brings in scope.

**Get the predicate right — the earlier draft of this story described it wrongly in three
ways, and Task 4 orders it mirrored exactly:**
- The supersede filter is `prior.kind === opts.kind`. A `decision` write retires prior
  **decisions only**; it does not touch `intent`s. The `(n.kind = 'decision' OR n.kind = ?)`
  clause in the SQL is the wider set fetched for *contradiction detection*, and the supersede
  set is partitioned out of it afterwards. A guard built from "decision or intent"
  over-matches and denies writes that would supersede nothing.
- The **AD-17 veto** excludes any prior with `conflict === 1` from supersession. A guard
  ignoring it denies a legitimate write.
- Subject normalisation is `subject.trim().toLowerCase()`. `deferred-work.md` already records
  one incident of exactly this drift between two subject lookups.

### 3. The selection machinery never sees the subagent's answer

`collectEvidence` (`src/query/suggest-notes.ts`) reads exactly three things for a session:
`getEpisodesBySession` (its `summary`), `getEventsBySession`, `getCommandRunsBySession`. It
never reads `last_assistant_message`.

And for a child session those sources are mostly empty: `handleReadEvent` writes metadata
carrying only a line range, so `eventText` returns `''` for a subagent's reads; command runs
count only when `exit_code` is non-zero and non-null.

**Consequence:** a subagent that only thinks — the case Story 5.1 exists to make visible —
produces **zero** suggestions, and so does one that only reads files. The pipeline works only
if the conclusion is written as an **episode on the child session first**, with the conclusion
text in `episode.summary`, because that is the field `collectEvidence` reads. **That ordering
is a requirement, not an implementation detail**, and without it AC #1 and AC #2 capture
nothing.

## Host contract — measured

Story 5.1's Appendix A carries the full `SubagentStop` key set. The parts this story stands on:

- `last_assistant_message` — documented and measured.
- `agent_transcript_path` — **measured, NOT documented.** Read defensively; degrade to
  `last_assistant_message` alone.
- **`SubagentStop` CAN block.** The host dispatches `hook_blocking_error` for
  `Stop`/`SubagentStop`, and its own operator guidance says to check `stop_hook_active` and
  return success while it is true. This is the one subagent hook that can damage a run.
- **`PreToolUse` for a subagent's tool call carries `agent_id`** — measured
  `ae3fb76952fd58038`, on a `Read`.
- **Denial shape:** `hookSpecificOutput.permissionDecision` — `allow` / `deny` / `ask`, with
  `permissionDecisionReason`. `decision: "block"` is explicitly **deprecated** for
  `PreToolUse`. Matchers evaluate as regex against tool-name variants for `PreToolUse`, so an
  `mcp__cortex__*` matcher is syntactically sound.
- **NOT YET MEASURED, and Task 4 must probe it first:** that `PreToolUse` fires for
  `mcp__cortex__cortex_note` **with `agent_id` present**. The measurement in hand is for a
  `Read`. This epic's precedent is unambiguous — 5.1's most valuable finding came from a live
  probe, and the documentation's `tool_input` claim for `SubagentStart` measured **absent**.

## Tasks / Subtasks

- [x] **Task 1 — Wire `SubagentStop`** (AC: #1)
  - [x] New `subagent-stop` action; a new arm in `hooks/claude/cortex-subagent.sh`'s `case`; a `handleHookPayload` branch.
  - [x] **The branch is not optional and a test must prove it.** `handleHookPayload` ends in `return reflectFromPayload(...)` with no exhaustive `switch` and no `never` guard, and `main()` casts `argv[2]` unchecked — so adding the union member without the branch **compiles cleanly** and routes every subagent completion into the reflex path. Assert `subagent-stop` returns `''`. This is the second instance of the trap (5.2 has the first, for `dispatch-pre`). *Confirmed 2026-08-07: 5.2 did NOT build the shared test — its coverage is a `dispatch-pre`-specific case in `tests/hook-entry.test.ts`.* So this story owns it: **one test that iterates every `HookAction` member** and asserts each returns what its branch promises, retro-fitting `dispatch-pre` and `subagent-start` into it rather than adding a third one-off.
  - [x] New `REQUIRED_WIRING` entry. *Corrected 2026-08-07 against shipped 5.2 — the conclusion holds, the reason given here did not.* `install.ts` no longer skips by event key: 5.2 re-keyed `wiredElsewhere` on `wiringKey(required)` (event **plus** `action ?? script ?? token`), so entries are discriminated by action everywhere, and `SubagentStop` is unambiguous for a stronger reason than the one originally written. Two consequences for this task: give the entry an explicit `action: 'subagent-stop'` with **no** `actionOptionalUnless` — that action token is what tells it apart from its two siblings on `cortex-subagent.sh` — and add its key to the `wiringKey` collision test 5.2 added to `tests/install.test.ts`.
  - [x] **This hook can block a subagent.** Emit nothing, exit 0 unconditionally, and swallow every error **inside the action** rather than relying on `main()`, which rethrows anything that is not `UnopenableStoreError`. Honour `stop_hook_active` — return success while it is true, per the host's own guidance.
  - [x] **Fixtures: ANSWERED, do not repeat.** 5.2 made both derive from `REQUIRED_WIRING` — `healthyWiring` in `tests/doctor.test.ts` and the loop in `tests/cli.test.ts`’s `seedSandboxHome`, each carrying the matcher its wiring declares. A new entry is picked up automatically. Confirm it, and confirm the third derived fixture 5.2 added: `tests/capture-hook.test.ts` asserts the script’s `case` arms are EXACTLY the actions `REQUIRED_WIRING` points at `cortex-subagent.sh`, and that each arm passes its OWN token to Node — so a new arm without a wiring entry, or vice versa, fails there.

- [x] **Task 2 — Capture the conclusion as an episode on the child** (AC: #1)
  - [x] Resolve the child by `(scope_key, agent_id)` and **handle the recorded hazard**: `getSessionByAgentId` filters by neither parent nor status, deliberately (Story 0.2 AC #3 requires a child to stay findable after its parent ends). `deferred-work.md` records this reproduced — *"a re-fire for a recycled `agent_id` after the session tree ended lands on the ended child"* — and the same property caused a HIGH defect in 5.1, where a reused child back-dated the first-fire marker. Decide what happens when the resolved child is `ended` or belongs to a previous primary, and say so.
  - [x] **Write the conclusion into `episode.summary`.** This is the ordering requirement from § finding #3: `collectEvidence` reads `episode.summary`, so the conclusion must exist as an episode on the child **before** any suggestion pass runs, or nothing downstream can see it.
  - [x] The child is still `active` at `SubagentStop` — but **not for the reason a reader might assume.** `find_referencing_symbols` on `endSessionTree` returns two callers, and the `ensurePrimarySession` one fires **only when the scope key changes**. A SessionStart on the same branch and worktree ends nothing, so children can stay `active` for days. That is fine here and is the cause of the noise problem in Task 3.
  - [x] Bound what is stored. A final message can be long and `agent_transcript_path` can be megabytes. State the ceiling; parse any `CORTEX_*` option with **`Number`, never `parseInt`** (five incidents) and reuse an existing helper — `resolveEnvCeiling` (`src/capture/census.ts`) or `envNumber`/`envCount` (`src/db/gc.ts`) — rather than writing a sixth.
  - [x] Read `agent_transcript_path` only if present and readable; never make a finding depend on it.

- [x] **Task 3 — Draw the episode/suggestion line, and bound the noise it creates** (AC: #1, #2)
  - [x] **The ACs answer the design question; the PRD glossary is the rule:** *"episodes are captured, notes are authored."* The record that a subagent ran and what it concluded is an **episode** — automatic, and it projects. A durable decision, blocker or insight is **note-shaped** — suggestion only, projecting when the parent writes it.
  - [x] Getting this wrong either way is the story's main risk: too permissive and a subagent's opinion becomes durable memory nobody agreed to (the AD-4/FR-19 failure); too strict and a 200k-token investigation leaves nothing.
  - [x] **Do not add a second `suggestNotes` caller.** `endOfTurn` already walks `getSessionTreeIds` and flatMaps `suggestNotes` over every child. Once Task 2 writes the episode, the existing Stop nudge picks it up. This story's job is the episode; the suggestion path is already wired.
  - [x] **Bound the re-nagging, which this story would otherwise create.** `getSessionTreeIds` → `getChildSessions` is a bare `SELECT * FROM sessions WHERE parent_session_id = ?` with no status, recency or limit filter; `suggestNotes` has no recency filter; and the primary rarely rotates (above). So every conclusion episode this story writes would re-surface in the Stop nudge on **every subsequent turn that uses any subagent**, for the life of the primary. `endOfTurn`'s `seen` dedupe is per-invocation only. Add a recency window or a shown-marker, and pin it — an accepted suggestion that keeps being re-offered trains the user to ignore the nudge, which is the same attention cost `docs/invariants.md` records for a check that cries wolf.
  - [x] Register the new episode kind in **all three** places: `KIND_WEIGHTS` (`src/memory/kind-weights.ts`), and `episodeState` + `episodeImportance` (`src/memory/items.ts`). The latter two switch on kind and fall through to `'warm'` / `0.6` silently — no error, no gate failure, just wrong ranking.

- [x] **Task 4 — Refuse a subagent editing memory outside its session tree** (AC: #3)

  **RULES — binding:**
  - [x] **Probe first.** Confirm `PreToolUse` fires for `mcp__cortex__cortex_note` with `agent_id` present before building anything on it. Measured evidence exists only for a `Read`.
  - [x] Act **only when `agent_id` is present**. No `agent_id` means the parent, and the parent is untouched by this story. Reuse `agentIdentity`; do not re-derive it.
  - [x] Compare the target against **`getSessionTreeIds`** of the calling subagent's session — ruling (a). Not the child id: no note is ever stamped with one.
  - [x] Matcher covers **three MCP routes and the shell**: `mcp__cortex__cortex_note`, `mcp__cortex__cortex_resolve`, and `Bash`. Nothing else — not the read-only tools.
  - [x] For `Bash`, a **pure-shell text check runs first** and exits without spawning Node unless the command text looks like `cortex note-resolve`, `cortex edit-memory` or `cortex delete-memory`. N-4: no Node per tool call.
  - [x] Deny with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. Not `decision: "block"`, which the host marks deprecated for `PreToolUse`. The reason is user-facing: say plainly that a subagent may not retire memory from an earlier session, and name what the parent can do instead.
  - [x] **Fail OPEN.** Any inability to establish that the target lies outside the tree — unreadable store, missing note, unparseable payload, thrown error — **allows** the call, emits nothing, exits 0.
  - [x] Mirror `insertNote`'s supersede predicate **exactly**, per § finding #2: same-kind only, AD-17 veto excluded, subject `trim().toLowerCase()`. Pin it with a test so the guard and the behaviour it guards cannot drift.

  **WHY — context, not instructions:**
  - [x] Three routes retire other people's decisions, not one; `cortex_resolve --replacement` calls `insertNote` and carries the auto-supersede, so a named-target check alone passes it through.
  - [x] AD-7 scopes refunds to `PostToolUse` substitution and explicitly not to `PreToolUse` deny. This is a different capability on a different path — add a companion clause to `docs/invariants.md` so a reader does not find an apparent contradiction.

- [x] **Task 5 — Close Story 5.2's deferred pairing audit** (AC: #1)
  - [x] At `SubagentStop` the per-agent sidecar exists and its `toolUseId` equals the `PreToolUse.tool_use_id` 5.2 recorded. Compare them; record agreement or disagreement.
  - [x] Read the sidecar defensively — host-internal, undocumented, derived path. If it cannot be read, record **nothing** and report nothing: an absent audit is not a failed audit, and conflating them produces the false-alarm class 5.1's review found twice.
  - [x] Surface the mispairing count where 5.1’s and 5.2’s counters live, under the same rules — and *those rules grew during 5.2’s review (2026-08-07), so inherit the current set, not the one written here*: conditional, silent until there is something to say, `warn` never `fail`, no flapping on a healthy install, **an expected-but-safe outcome is REPORTED and never warned on** (5.2’s refusal count — warning on the design working as ruled is the cries-wolf half of AD-12), and **a corrupt counter must not manufacture a warn** (`readMetaCount` returns a `corrupt` flag; a valid capture count beside an unparseable paired count read as "captured, never paired" and invented a fault out of corruption). A mispairing count is the one number here that genuinely SHOULD warn — say why it differs from the refusal count.

- [x] **Task 6 — Delete `promoteSubagentNotes`** (AC: #2)
  - [x] **Recommended disposition: delete it.** It has zero runtime callers (`find_referencing_symbols`: only the `src/index.ts` barrel), it **mutates** — re-activating an arbitrary prior same-kind, same-subject parent note via `Array.prototype.find` over `getNotesBySession`, which returns all statuses — and AC #2 mandates the non-mutating path, so this story must not give it a caller. Keeping it means maintaining dead code that contradicts the AC it sits next to.
  - [x] Deleting it also requires removing the `src/index.ts` barrel export and its four call sites plus `describe` block in `tests/consolidate.test.ts`. Prefer `safe_delete_symbol` over hand-editing.
  - [x] **Before deleting, check one thing:** Story 1.1 records that auto-supersede being scope-blind is *"load-bearing for … `promoteSubagentNotes`, which relies on `insertNote` superseding the parent note it then re-activates."* Removing it removes one of the two documented reasons that behaviour exists. Confirm the other reason still stands, and record it — the scope-blind supersede is what § finding #2 is entirely about.
  - [x] If the dev disagrees and keeps it, fix the re-activation defect and say why keeping it beat deleting it. Do not leave it re-filed a third time.

- [x] **Task 7 — Child-timeline rendering: judge it, with a live defect in hand** (AC: #1)
  - [x] **Recommended disposition: defer with an owner**, unless the evidence below changes the call. AC #1 requires findings to be *recorded*, not raw child activity to be *rendered*, so this is adjacent scope.
  - [x] Judge it against a defect that already exists: `deferred-work.md` records *"`cortex stats` reports `Focus: unfocused` after ten subagent dispatches"*, caused by `getRecentSessions(10)` — the first name in this item's own unfiltered enumeration. "Surface child activity" and "stop children polluting the focus line" are two directions on the same accessor, and fixing one without deciding the other is how this returns a third time.
  - [x] **Do not drop it silently.** 5.2's validation caught exactly that in its predecessor.

- [x] **Task 8 — Tests** (AC: #1, #2, #3, #4)
  - [x] AD-5: a locked fixture exercising the new kind, in **this** change. The gate reads `seed.items[].kind` in `eval/suites/*.json` — a fixture `topic` alone does not satisfy `checkKindCoverage`. Adding the kind to `eval/kind-coverage.json`'s grandfathered list is explicitly not how to pass; the file says so itself.
  - [x] AC #1: a `SubagentStop` payload writes the conclusion as an episode on the **child**; no `agent_id` writes nothing; an over-long message is bounded; a resolved child that is `ended` or from a previous primary behaves as Task 2 decided.
  - [x] **AC #1/#2 end-to-end, and this is the test that proves the story works at all:** a subagent with **no captured tool calls** — the Story 5.1 case — produces a conclusion episode, and the Stop nudge then surfaces a suggestion from it. Without the Task 2 ordering this yields nothing, so this test is the guard on § finding #3.
  - [x] AC #2: a note-shaped finding produces a **suggestion** and **no `memory_items` row**; the episode half produces exactly one episode. This is the AD-4/FR-19 line and must fail if it moves.
  - [x] Task 3's noise bound: a conclusion already surfaced is not re-offered on the next turn.
  - [x] AC #3 allow-path: a **parent** call is never denied; a subagent acting on memory from **its own session tree** is never denied.
  - [x] AC #3 deny-path: a subagent resolving a note from an earlier session; a subagent writing a `decision` whose subject would supersede one; a subagent calling `cortex_resolve --replacement` with the same effect; a subagent running `cortex delete-memory` through `Bash`.
  - [x] AC #3 **fail-open**: a throwing store, an unreadable note, a malformed payload and a missing target each **allow** and emit nothing. Mutation-check this — a fail-closed regression blocks the user's own work and is the worst outcome this story can produce.
  - [x] The `Bash` pre-filter does not spawn Node for ordinary commands. Assert on process behaviour, not on reading the script.
  - [x] The guard's supersede predicate matches `insertNote`'s: same-kind only, AD-17 veto respected, subject normalised.
  - [x] `subagent-stop` returns `''` and never reflex JSON; the hook exits 0 even when the action throws; `stop_hook_active` is honoured.
  - [x] Task 5: agreeing ids record agreement; disagreeing ids record a mispairing; an unreadable sidecar records nothing.
  - [x] Standard store fixture exactly. Import specifiers end in `.js`. **`npm run lint` does not typecheck `tests/`.**

- [x] **Task 9 — Documentation** (AC: all)
  - [x] `docs/invariants.md`: the episode-versus-suggestion line; the three auto-supersede routes and the exact predicate; ruling (a)'s session-tree definition and *why* the child id cannot be used; ruling (b)'s shell pre-filter; the fail-open rule; the AD-7 companion clause; the sidecar audit's absent-is-not-failed rule; the Stop-nudge recency bound.
  - [x] `README.md`: what survives a subagent, and that Cortex refuses a subagent retiring memory from an earlier session.
  - [x] `CLAUDE.md`: Current Model, Core Files, tool list if a surface changes.
  - [x] `deferred-work.md`: Task 6's and Task 7's decisions, so neither is re-filed a third time.
  - [x] `sprint-status.yaml` at each transition.
  - [x] **Every written claim must be true of the shipped code.** Cite symbols and files, not line numbers — 5.1's citations were measurably off by one within a day. Note for accuracy: `N-1`, `FR-19` and `AD-9` do **not** appear in `docs/invariants.md` (they live in `epics.md` and the PRD); `AD-4`, `AD-5`, `AD-7`, `AD-12`, `AD-17`, `N-4`, `SM-C3` and `P-5` do.

## Dev Notes

### Re-checked against shipped 5.2 (2026-08-07)

This story was written on 2026-08-06 against `0c60aa4`, **before 5.2 existed**, so every
statement about 5.2 was a prediction. 5.2 then changed materially in review. Re-checked
against the shipped code; the delta is small and none of it is design-breaking, which is the
point of doing this before building rather than during.

| Prediction | Verdict |
|---|---|
| `wiredElsewhere` is keyed by event | **Stale.** 5.2 re-keyed it on `wiringKey` (event + `action ?? script ?? token`). Conclusion unchanged, reason corrected in Task 1. |
| Both test fixtures hand-write their hooks and need repair | **Answered.** 5.2 derives both from `REQUIRED_WIRING`, plus a third derived fixture over the script’s `case` arms. Confirm, do not repeat. |
| 5.2 wrote a shared test over every `HookAction` member | **False.** 5.2’s coverage is `dispatch-pre`-specific. This story owns the shared test. |
| The doctor counter rules are 5.1’s | **Incomplete.** 5.2’s review added report-don’t-warn for expected-but-safe outcomes and corrupt-counter suppression. |
| `collectEvidence` never reads `last_assistant_message` | **Holds** — still absent from `src/query/suggest-notes.ts`, so finding #3’s ordering requirement stands. |
| `endOfTurn` already walks `getSessionTreeIds`, so do not add a second caller | **Holds** — exactly one occurrence in `src/transports/hook-entry.ts`. |
| `promoteSubagentNotes` is dormant | **Holds** — still at `src/capture/consolidate.ts`, no runtime caller. |

**Two things 5.2 leaves that this story should treat as precedent, not re-derive.**
(1) A design premise that rests on an event ORDERING must be proven against the MEASURED
ordering: 5.2’s FIFO justification survived a whole build because its test and its sandbox
driver both encoded an ordering the host does not use. (2) A budget or size test seeded with
many small items cannot see a cap that fails on ONE large item — 5.2’s 150-token cap was not a
cap, and its test could not tell.

**Open and NOT closed by this story:** no budget covers `SubagentStart`, `dispatch-pre`, or the
`SubagentStop` hook this story adds. 5.2 measured its two (median 606.1 and 622.2 ms, together
1272.8 ms per dispatch) and raised a fact Story 5.1’s ruling did not cover — `PreToolUse` gates
the tool call. This story adds a third per-dispatch spawn on an event that CAN block a
subagent. Measure it and bring the number; do not invent a ceiling.
### What 5.1 and 5.2 leave for this story

5.1 wired `SubagentStart`, created the child session at dispatch, and left the script's `case`
shaped for appending with **no default action**. 5.2 adds the dispatch capture, the brief, and
the `wiredElsewhere` installer fix. This story adds the last event and the guard.

`recordSubagentStart` / `CortexStore.incrementMetaCounter` remain the observability precedent:
written once, incremented in **one** SQL statement, reported by a conditional `doctor` row.

### Three traps specific to this story

1. **`SubagentStop` can block.** Every other hook in this epic can only make noise. A throw
   that escapes here can stop a subagent finishing, so the action swallows its own errors.
2. **The guard must fail open.** A blocking hook that errs toward blocking stops the user's own
   work. Every uncertainty allows.
3. **A guard on the MCP tools alone is not a guarantee** — the shell reaches the same memory,
   and `delete-memory` is more destructive than anything the AC names.

### One hazard worth naming for whoever accepts a suggestion

`DECISION_RE` in `src/query/suggest-notes.ts` matches `\buse\b|\busing\b`, so most technical
conclusions become a `decision` suggestion with a machine-inferred subject. If the parent then
writes it as `cortex_note(kind='decision', subject=<inferred>)`, that write auto-supersedes
scope-blind — and the parent is deliberately exempt from this story's guard. So the suggestion
path should not carry an inferred subject into a `decision`, or the hazard this story exists to
close arrives through the front door.

### Constraints binding this story

- **AD-4 / FR-19** — subagents propose, they do not author. The episode/suggestion line is where this is won or lost.
- **AD-5** — the new kind ships with a locked fixture in the same change, registered in `KIND_WEIGHTS`, `episodeState` and `episodeImportance`.
- **AD-7** — refunds are `PostToolUse` substitution, never `PreToolUse` deny. This adds a deny on a different path for a different purpose; record the companion clause.
- **AD-12 / N-3** — degrade silently, report the rate.
- **N-1** — this hook emits nothing to the subagent; its only output is a denial on a different event.
- **N-4 / AD-2** — no Node per tool call. `SubagentStop` is per subagent; the MCP guard is per memory-write; the `Bash` guard is a shell text check that spawns nothing for ordinary commands.
- **AD-11 / P-5** — `SCHEMA_VERSION` stays **6**; append to `V5_TABLES` if a table is needed, with no inline `--` comments inside the `CREATE TABLE`.
- **AD-1** — layer direction; do not import a transport from a query.
- **SM-C3** — the worst failure is a false assertion: a suggestion presented as accepted memory, or a denial reason that misstates why.

### Verification

```bash
npm run build
npm run lint
npx vitest run
npm run gate
node dist/transports/cli.js doctor
```

**What the gate does here, precisely.** Adding a `KIND_WEIGHTS` key turns the gate **RED** on
`checkKindCoverage` until a locked suite seeds the new kind — that is a *failure*, not a delta.
Every **existing** suite must still be at **zero delta**; suites are hermetic (`evaluateSuite`
runs against `:memory:` seeded from the suite's own fixture), so a new key cannot move an
existing score, and any movement there is a regression to explain. Adding the **new** baseline
file needs no `Baseline-Regenerated:` trailer — `checkBaselineJustification` skips added files,
because adding a locked artifact is not regenerating one. Regenerating an existing baseline is
never how a red gate goes green.

Then: byte-scan every touched file, and run an **EOL-aware** mutation campaign — mutate `src/`
and `hooks/`, never `dist/`, prove each mutation by sha, restore byte-identically, and treat a
surviving mutation as a missing test. **The fail-open guard is the highest-value anchor in this
story**: making it fail closed must turn a test red.

**Verification order — three ordered gates (ruling, ShuromiU, 2026-08-06):** sandbox first
(`CORTEX_HOME` plus a temp project, the real rendered hook against a real store), then the
three-layer review, then `cortex install` machine-wide.

Live proof at gate 3, **four cases**: a real subagent finishing and leaving a conclusion a
later session can retrieve; a subagent that used **no tools** doing the same (the Story 5.1
case, and the one § finding #3 says would otherwise capture nothing); a parent's own
`cortex_note` succeeding untouched; and a subagent's attempt to retire an earlier session's
note being refused with a readable reason. The third is the regression that would hurt most and
is the easiest to forget.

**One store is not a sample.** Verify against at least two real projects.

### Project Structure Notes

| File | Change |
|---|---|
| `hooks/claude/cortex-subagent.sh` | `subagent-stop` arm; the memory-guard arm with its shell pre-filter |
| `src/transports/hook-entry.ts` | `HookAction` members, `handleHookPayload` branches, the stop handler, the guard |
| `src/query/doctor.ts` | `REQUIRED_WIRING` entries; mispairing reporting |
| `src/memory/kind-weights.ts` | the new episode kind |
| `src/memory/items.ts` | `episodeState` and `episodeImportance` for the new kind |
| `src/capture/consolidate.ts`, `src/index.ts` | Task 6's deletion |
| `eval/suites/*`, `eval/baselines/*` | the AD-5 locked fixture |
| `docs/invariants.md`, `README.md`, `CLAUDE.md`, `deferred-work.md` | per Task 9 |
| `tests/*` | per Task 8 |

No new dependency. Conventional Commits, lowercase subject — `feat:`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.3] — ACs and all three 2026-08-06 amendments, verbatim
- [Source: _bmad-output/implementation-artifacts/5-1-link-subagent-sessions-to-their-parent.md] — Appendix A, the hook script and its no-default-action property, the observability precedent
- [Source: _bmad-output/implementation-artifacts/5-2-brief-subagents-automatically.md] — the deferred pairing audit this story closes; the `handleHookPayload` fallthrough trap; the fixture repair
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — the two items re-filed onto this story, and the `cortex stats` focus defect Task 7 is judged against
- [Source: _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md#FR-19] — §Glossary for *load-bearing* and *episode*
- [Source: docs/invariants.md] — AD-4, AD-5, AD-7, AD-12, AD-17, N-4, SM-C3, P-5
- [Source: _bmad-output/project-context.md] — 41 binding implementation rules

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

- **Mutation campaign: 20 anchors, 20 killed.** EOL-aware after a first pass in which every
  MULTI-LINE anchor failed to match — the script reported eight `ANCHOR-FAILED` rather than
  silently skipping them, which is the whole reason that rule exists; single-line anchors matched
  because they carry no embedded newline. Anchors are now re-line-ended to the file's own
  convention before matching. Each mutation is proven applied by sha and restored byte-identically
  (`original -> mutated -> original`, verified). The highest-value anchor the story names — making
  the guard fail CLOSED — is **M1**, and it is killed.
- **`sed -i` converted `src/transports/hook-entry.ts` from CRLF to LF** while fixing a field name.
  Caught by an explicit byte check, not by any test: `core.autocrlf=true` normalises on commit, so
  the diff and the suite were both clean and nothing would have reported it. Restored, along with
  the two new source files, so the working tree stays one convention.
- **Gate 1 sandbox: 16/16**, against the real rendered hook under bash, an isolated `CORTEX_HOME`
  and a real git project. One check had to be rebuilt mid-run: "an ordinary shell command never
  spawns Node" was first written as an elapsed-time threshold and measured **485 ms**, which on
  Windows is indistinguishable between a Node start and bash plus three `jq` spawns — a proxy, and
  AD-6 forbids one. Replaced with interposition: a second rendering whose Node path is a shim that
  records the attempt, plus a control proving the shim fires when it should. The marker's presence
  IS the answer.
- **Two existing tests were narrowed rather than routed around**, both because this story changes
  the property they asserted. `tests/substitution.test.ts` required `permissionDecision` to appear
  nowhere in `hook-entry.ts`; the guard legitimately emits one, and hiding it behind a helper in
  another file would have kept the scan green while the property it named stopped being true. It
  now pins the narrower still-true guarantee: no economics surface denies, and in the bridge a
  decision comes only from `guardMemory`. `tests/capture-hook.test.ts` counted `jq` invocations as
  a proxy for "no hot-path work"; it now asserts placement (one outside the `case`, the rest inside
  the guard arm) plus ordering, which is stronger and survives the arm that needs them.
- **`doctor` reports the two new wirings as `FAIL` until gate 3**, correctly — the entries exist in
  `REQUIRED_WIRING` and nothing is installed yet. `guard-matcher` is absent from the report for the
  same reason, which is its conditional-by-design behaviour, not a miss.

### Completion Notes List

- **Task 3's noise bound was missing from the `tasks 1-3` commit** (`37b4747`) and is built here.
  The commit registered the new kind and wrote the episode but never bounded the re-nagging, which
  would have re-offered every conclusion on every later turn for the life of the primary.
- **Task 4's guard shares `insertNote`'s decision phase rather than mirroring it.**
  `analyzeNoteWrite` was extracted from `insertNote` and is called by both it and the new
  `previewNoteWrite`, so same-kind-only, the AD-17 veto and subject normalisation cannot drift —
  structural, not test-enforced. A test still predicts, performs the write, and compares.
- **Contest marking is deliberately outside the guard**, recorded in `docs/invariants.md`: it is
  not a retirement, both sides stay active and visible, and denying it would turn contradiction
  detection off for subagents entirely.
- **A circular import was avoided by extracting `tokenizeCommand`** into `src/query/command-tokens.ts`.
  `doctor` needs the guard's matcher and the guard needs `doctor`'s tokenizer; a second copy of the
  tokenizer was the alternative, and this repository has already paid for a duplicated primitive
  (`findDbPath`, four copies, one invisible to text search). `doctor` re-exports it so the barrel
  and every existing importer are untouched.
- **Task 6: deleted, not fixed**, after enumerating with `find_referencing_symbols` (barrel only)
  and `certify_refs` (union 9, `lspOnly: 0`, every text-only hit a doc or its own test). Tombstones
  in `src/capture/consolidate.ts` and `tests/consolidate.test.ts` record why, including the one
  thing that survives it: scope-blind auto-supersede is still load-bearing for `cortex_resolve`, and
  now for a third reason — it is exactly why the memory guard has to exist.
- **Task 7 was SPLIT, and that is the ruling.** "Stop children polluting the focus line" is a
  rendering defect on an accessor with a filtered twin already available, and it is fixed here
  (`getRecentPrimarySessions`). "Surface child activity to a reader" is a feature needing a surface,
  a budget and a ranking rule, and it stays deferred with an owner. Fixing the first does not
  foreclose the second — the feature adds a read path rather than changing this one. Both halves are
  written into `deferred-work.md` so neither returns a third time as "the same accessor".
- **`SCHEMA_VERSION` is untouched at 6.** No new table and no new column: the conclusion is an
  episode, the surfaced marker is episode metadata, and the audit uses `meta` counters.
- **Not done in this story, stated rather than implied:** the three per-dispatch hook spawns are
  still unbudgeted, and this story adds a fourth wiring on a hot event whose cost was proven to be
  shell-only but not measured end to end. Gate 3 is where a live number can be taken.

### File List

| File | Change |
|---|---|
| `src/db/store.ts` | `normalizeNoteSubject`, `NoteWritePreview`, `previewNoteWrite`, `analyzeNoteWrite` extracted from `insertNote`, `setEpisodeMetadata`, `getSubagentDispatchByConsumer` |
| `src/query/memory-guard.ts` | NEW — the `PreToolUse` refusal, its four routes, and the fail-open contract |
| `src/query/command-tokens.ts` | NEW — the shared shell-ish tokenizer, extracted to break an import cycle |
| `src/query/subagent-conclusion.ts` | the `surfaced_at` marker helpers and the host sidecar reader |
| `src/query/doctor.ts` | `guard-memory` wiring, `guard-matcher` row, audit counters in `subagent-sessions`, `tokenizeCommand` re-export |
| `src/scope/runtime.ts` | `SUBAGENT_AUDITED_COUNT_KEY`, `SUBAGENT_MISPAIRED_COUNT_KEY`, `recordSubagentAudit` |
| `src/transports/hook-entry.ts` | `guard-memory` action and branch, `guardMemory`, `auditPairing`, the Stop-nudge conclusion bound |
| `src/transports/cli.ts` | `cortex stats` focus line reads primary sessions only |
| `src/capture/consolidate.ts`, `src/index.ts` | `promoteSubagentNotes` deleted; tombstone kept |
| `hooks/claude/cortex-subagent.sh` | the `guard-memory` arm and its two pure-shell gates |
| `tests/subagent-conclusion.test.ts` | NEW — 49 tests across Tasks 1–5 |
| `tests/capture-hook.test.ts` | guard-arm shell tests on process behaviour; jq assertion narrowed to placement |
| `tests/substitution.test.ts` | AD-7 source-negative narrowed to economics surfaces |
| `tests/doctor.test.ts`, `tests/consolidate.test.ts` | new check id; deleted function's tests removed |
| `docs/invariants.md`, `README.md`, `CLAUDE.md`, `deferred-work.md` | per Task 9 |

### Change Log

| Date | Change |
| --- | --- |
| 2026-08-06 | Story created against `0c60aa4` on re-based ACs, then substantially rewritten after independent validation found seven critical issues — none of them in code, because none exists yet. Two required rulings and got them. **(a)** No note is ever stamped with a subagent's session id — both MCP write paths resolve without identity — so comparing against the child would have denied *every* subagent memory operation, the fail-closed outcome the AC forbids; "its own session" now means its own **session tree** (ShuromiU, 2026-08-06). **(b)** The guard had an open side door: three command-line commands reach the same memory through `Bash`, including a delete that is more destructive than anything the AC names; that route is now **in scope**, with a shell text check so ordinary commands cost nothing (ShuromiU, 2026-08-06). Also folded in: the selection machinery never reads `last_assistant_message`, so a thinking-only subagent would have produced nothing unless the conclusion is written as an episode **first** — now a stated ordering requirement and the subject of its own test; `cortex_resolve --replacement` is a third auto-supersede route the draft missed; the supersede predicate was described wrongly in three ways while the story ordered it mirrored exactly; a new episode kind touches three registries, not one, two of which fail silently; the existing Stop nudge already walks every child session, so this story must not add a second caller and must bound the re-nagging it would otherwise create forever; and the child-resolution path walks a reproduced hazard. Status → ready-for-dev, **blocked on Story 5.2**. |
