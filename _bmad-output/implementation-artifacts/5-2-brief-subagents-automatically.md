---
baseline_commit: 453e7f243297bce5b142f38d860ba86787e793b1
---

# Story 5.2: Brief subagents automatically

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a parent agent dispatching work,
I want the subagent to receive relevant prior context without my pasting it,
so that delegation stops discarding the memory the parent already has.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 5 → Story 5.2,
**including the dated 2026-08-06 amendments** made by the re-base pass that ran before this
story was written. Do not reword, split, or extend. If one is wrong, stop and say so rather
than implementing around it.

1. **Given** a subagent is dispatched with a description matching memory in scope
   **When** `SubagentStart` fires
   **Then** a brief derived from the dispatch description is emitted on stdout and injected into the subagent's context
   **And** it respects the standard brief budget.

   *Amended 2026-08-06, three clauses:* the description must be **captured at `PreToolUse`
   on the `Agent` tool and consumed at `SubagentStart`**, paired by `agent_type` over
   unconsumed captures in dispatch order, and the pairing **audited, not trusted**.
   *"Emitted on stdout"* is **VOID** — the mechanism is the
   `hookSpecificOutput.additionalContext` envelope. *"The standard brief budget"* is
   **150 tokens** (ruling, ShuromiU, 2026-08-06), the SessionStart cap, not `cortex_brief`'s 450.

2. **Given** no relevant memory exists for the dispatch description
   **When** `SubagentStart` fires
   **Then** nothing is emitted (N-1).

3. **Given** the parent also calls the brief tool explicitly for the same topic
   **When** both paths run
   **Then** context is not double-injected.

   *Clarified 2026-08-06:* the two paths do not share a context — `cortex_brief` returns into
   the **parent's**, the auto-brief lands in the **subagent's**. They collide only when the
   parent pastes its brief into the dispatch prompt, which is detectable because the
   `PreToolUse` capture required by AC #1 hands over the **full dispatch prompt**.

4. **Given** brief generation fails for any reason
   **When** the subagent starts
   **Then** it starts normally with no error surfaced (AD-12).

   *Added 2026-08-06 — a defect this story must fix:* `bookHookInjection` books against
   `store.getCurrentSession()`, which is primary-only, so tokens injected into a subagent
   would be billed to the **parent**.

### One AC clause is deliberately deferred, and says so

AC #1's amendment requires the pairing to be *"verifiable at `SubagentStop`"* via
`PreToolUse.tool_use_id` matching the sidecar's `toolUseId`. **`SubagentStart` carries no
`tool_use_id`** (its payload is seven fields — see § Host contract), so exact verification is
structurally impossible at the moment the brief is emitted. This story therefore ships the
*precondition* half — an ambiguity counter, below — and **defers exact pairing verification
to Story 5.3**, which wires `SubagentStop` and is the first place the sidecar can be read.
Recorded here rather than quietly narrowed: counting ambiguity proves the pairing was
*unambiguous*, not that it was *right*.

### Per-AC status established from the code, not assumed

| AC | Status entering this story | Evidence |
|---|---|---|
| **#1** | **NOT MET, and its stated source of truth does not exist where the AC says.** The delivery channel is proven; the description must come from one event earlier. | Measured 2026-08-06, § Host contract. Story 5.1 built the `SubagentStart` path and deliberately emits nothing. |
| **#2** | **NOT MET, and the obvious implementation gets it exactly backwards.** `brief()` **never returns an empty string** — with no results it returns `No context found for "<topic>".`, and with `forAgent` set (which Task 3 wants) it returns *two* lines, `Briefing for <type>:` then that sentence. It also calls `logRetrieval` on that path. | `find_symbol brief` (`src/query/brief.ts`). |
| **#3** | **NOT MET, and now cheaply satisfiable.** Nothing compares injected content against the dispatch prompt today, because nothing has ever had the prompt. AC #1's capture supplies it. |
| **#4** | **HALF INHERITED.** Story 5.1's `subagentStart` already wraps its body so nothing escapes, and the script prints nothing and exits 0. The **billing** half is a live defect. `bookHookInjection` has exactly two callers — `renderConsultGate` and `endOfTurn`, both primary-facing (`find_referencing_symbols`; `certify_refs` reports `lspOnly: 0` with zero further code sites). |

## Host contract — measured, and the pairing key is in it

Story 5.1's Appendix A is the reference for the `SubagentStart` payload and the sidecar
timing. Two measurements were taken **for this story** on 2026-08-06, with
`~/.claude/settings.json` restored byte-identically (sha256 `ed3ac572…` before and after).
Probe log: `…/scratchpad/rebase-probe.log`.

**The delivery channel works — proven, not inferred.** A `SubagentStart` hook emitting
`{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"…"}}` reaches
the subagent: the dispatched subagent quoted the marker back verbatim and reported it arrived
*"immediately after your task message and before I did any work"*. This satisfies Story 4.5's
standing rule that this mechanism is probed, never inferred — a wrong-shaped payload costs
nothing, throws nothing, exits 0, and is indistinguishable from a miss.

**The two payloads, verbatim key sets — and the three fields that matter are shared:**

```
PreToolUse(Agent): cwd, effort, hook_event_name, permission_mode, prompt_id,
                   session_id, tool_input, tool_name, tool_use_id, transcript_path
     tool_input:   {description, prompt, subagent_type, run_in_background}

SubagentStart:     agent_id, agent_type, cwd, hook_event_name, prompt_id,
                   session_id, transcript_path
```

**`session_id` and `prompt_id` appear in BOTH.** They are the pairing key, and Task 2 is
built on them rather than on `agent_type` and scope alone. `session_id` is the host's window;
`prompt_id` is the user turn. Together they eliminate every cross-window and cross-turn
mispairing — which are the dangerous ones, because they would hand a subagent context from
genuinely unrelated work.

**Event ordering, measured for two same-type agents dispatched in one message:**
`PreToolUse(alpha) 17:04:38.743 → SubagentStart(alpha) 39.530 → PreToolUse(bravo) 39.982 →
SubagentStart(bravo) 41.069`. Strictly interleaved; each pairing confirmed by that agent's own
sidecar. **Stated limit:** the probe did not record whether those dispatches were
`run_in_background`, and that flag is present in `tool_input`. If a host ever queues
backgrounded dispatches, two captures could land before either start — which is exactly the
residual Task 2's counter exists to expose.

**A subagent's own `PreToolUse` carries `agent_id`** (measured `ae3fb76952fd58038` on a
`Read`). Not used by this story; recorded because Story 5.3 depends on it.

## Tasks / Subtasks

- [x] **Task 1 — Capture the dispatch at `PreToolUse` on the `Agent` tool** (AC: #1, #3)
  - [x] New `dispatch-pre` member on `HookAction`, a branch in `handleHookPayload`, and a new arm in `hooks/claude/cortex-subagent.sh`'s `case`. Story 5.1 shaped that `case` for appending and left **no default action** so a wiring `doctor` refuses cannot silently work — preserve both.
  - [x] **The `handleHookPayload` branch must be added, and a test must prove it.** That function is a chain of `if`s ending in `return reflectFromPayload(...)`, and `main()` casts `process.argv[2] as HookAction` unchecked — there is no exhaustive switch and no `never` guard. So adding `'dispatch-pre'` to the union while forgetting the branch **compiles cleanly** and routes every dispatch into the reflex path, whose else-branch maps `toolName === 'Agent'` to the `agent` reflex and injects `additionalContext` into the **parent**. Assert `dispatch-pre` returns `''`, not reflex JSON.
  - [x] **Do NOT widen the existing `Edit|Write` matcher to include `Agent`.** Same dormant path, reached the other way. (Precision, because the earlier draft of this story overstated it: that path is dormant for **two** independent reasons — the matcher excludes `Agent`, *and* `'reflect-agent'` is a live `HookAction` member no shipped script ever passes. Neither is a reason to wake it.)
  - [x] New `REQUIRED_WIRING` entry: `{ event: 'PreToolUse', label: 'PreToolUse (subagent dispatch)', script: 'cortex-subagent.sh', action: 'dispatch-pre', matcher: 'Agent' }`.
  - [x] **This is the first time two `REQUIRED_WIRING` entries share one event, and the installer cannot currently handle it.** `reflect-pre` and `reflect-prompt` are two *events* sharing one script — not a precedent for this. `runInstall` builds `wiredElsewhere` as a `Set<string>` of **event names** (`wiredElsewhere.add(required.event)`, `src/query/install.ts`) and `mergeHookWiring` skips on `wiredElsewhere.has(required.event)`. So on any machine where `PreToolUse` is already wired in another settings file — user vs project scope, or `settings.local.json`, all three of which Claude Code merges — `install` **silently skips** the new entry and `doctor` then fails `hook-wiring` naming `cortex install` as the fix that just declined to help. That is the installer/diagnostic disagreement `docs/invariants.md` explicitly forbids. **Key `wiredElsewhere` by event *plus* the entry's discriminator (`action ?? script ?? token`), and cover it with a two-settings-file test.**
  - [x] Record: `session_id`, `prompt_id`, `tool_use_id`, `agent_type` (from `tool_input.subagent_type`), the `description`, and enough of the `prompt` to answer AC #3 — a **digest plus a bounded prefix**, never verbatim. A dispatch prompt can be tens of kilobytes; this table is not a transcript.
  - [x] Persist in a new table appended to `V5_TABLES` (`src/db/schema.ts`). **Do not touch `SCHEMA_VERSION`** — it is **6**, the R1 increment is spent, and appending is the established pattern (`content_digests` in 3.1; 4.3 and 4.4's tables). `applySchema` runs the DDL unconditionally with `CREATE TABLE IF NOT EXISTS`.
  - [x] **No inline `--` comments inside the `CREATE TABLE`** — SQLite re-parses stored DDL during `ALTER TABLE … DROP COLUMN` and comments inside the parens make the table permanently un-alterable. Backticks there are separately fatal (the DDL is a template literal). Column documentation goes in the TypeScript docstring, which is how every existing table in that constant is written.
  - [x] Per AD-4 this is a **lookup/staging structure that does not project into `memory_items`** — no retrieval kind, and therefore **no AD-5 fixture obligation**. The `content_digests` precedent, stated in `docs/invariants.md`.

- [x] **Task 2 — Pair on the strong key, and make the residual visible** (AC: #1)
  - [x] Pair on **`(session_id, prompt_id, agent_type)`**, oldest unconsumed first. Both ids are present in both payloads (§ Host contract) and cost nothing to store. This is the correction the re-base pass should have made and did not: the key sets were transcribed and then not mined.
  - [x] What each part buys, so nobody "simplifies" it away: `session_id` eliminates two windows on one project colliding — they share a `scope_key`, so scope alone does not separate them. `prompt_id` eliminates a stale capture from an earlier turn pairing with a later subagent, which is the mispairing that would hand a subagent genuinely unrelated context. `agent_type` separates concurrent dispatches of different types.
  - [x] **The residual is one case: N same-type subagents dispatched in a single assistant message.** They share all three key parts, so only ordering separates them. Take the oldest unconsumed capture (FIFO), justified by the measured strict interleaving — and note this is common in practice, not exotic: this repository's own review workflow dispatches three same-type agents in one message. **Refusing to brief on ambiguity would silence exactly the fan-out case, which is where briefing is worth most**, so FIFO is the deliberate choice over silence.
  - [x] **Count the ambiguous case and surface it.** When more than one capture matches the key, record it. That counter is the whole evidence base for whether FIFO is holding: if it stays near zero the assumption is sound, and if it climbs the design needs revisiting before it can be trusted. AD-12 — a design whose safety rests on an assumption must report how often the assumption is tested.
  - [x] **Reject stale captures in the pairing query itself**, with a horizon in seconds-to-minutes: `… WHERE consumed_at IS NULL AND captured_at > :cutoff`. This is correctness, not housekeeping, and it must not be confused with Task 7's growth bound — that runs at most once per 24 hours, so a capture orphaned at 09:00 would otherwise stay eligible to mis-brief all day. Two horizons, two mechanisms.
  - [x] Consumption must be a single conditional `UPDATE … WHERE consumed_at IS NULL` acted on by row count — never read-then-write. Story 5.1's review reproduced two writers losing an increment through exactly that shape, and `busy_timeout` does not prevent it. Reuse `CortexStore.incrementMetaCounter`'s single-statement discipline, including its `GLOB` digit guard, for any counter.
  - [x] Extend Story 5.1's `Subagent sessions` `doctor` row rather than re-inventing its rules: conditional, silent until the path has fired, `warn` never `fail`, and it must not flap on a healthy install.

- [x] **Task 3 — Build the brief, and know *before* generating it that there is nothing to say** (AC: #1, #2)
  - [x] `brief(store, topic, forAgent?, options?)` (`src/query/brief.ts`) is the generator; `forAgent` already exists and produces a `Briefing for <name>:` header that `agent_type` fills.
  - [x] **The emptiness check must run BEFORE `brief()` is called, not on its output.** With no results `brief()` returns `No context found for "<topic>"` — two lines when `forAgent` is set — *and* calls `logRetrieval`, so "call it and discard when empty" still writes a retrieval-log row on every no-match dispatch. Call `retrieveMemory` first and invoke `brief()` only on a non-empty result. **Do not modify `brief()` itself** — its only callers are the `cortex_brief` MCP tool and the `src/index.ts` barrel (`find_referencing_symbols`), and changing its contract would move a shipped surface for no reason.
  - [x] Detect emptiness **structurally**, from the retrieval result count — never by matching the rendered `No context found` text. `docs/invariants.md` records the measured lesson that honouring a rendered display string as data is how three of six shipped markers came to be fiction.
  - [x] Budget is **150** (`DEFAULT_SESSION_BRIEF_BUDGET`, `src/query/session-brief.ts`), not `DEFAULT_BRIEF_BUDGET`'s 450. Ruling, ShuromiU, 2026-08-06.
  - [x] The topic is the dispatch **description**, not the prompt — the description is the human-written summary of the job; the prompt is the whole instruction and would swamp retrieval.
  - [x] **Decide and state whether an auto-brief should reinforce memory.** `logRetrieval` calls `store.touchMemoryItems(...)` on a non-empty result, which moves hotness and therefore ranking on **every** future retrieval surface. So briefing on every dispatch would silently promote whatever memory matches dispatch descriptions. This is a retrieval-*quality* decision, not a reporting one — make it explicitly, and note that `logRetrieval` attributes to `retrieval.context.preferredScope?.session.id`, a different resolution path from the one Task 6 fixes.

- [x] **Task 4 — Emit through the envelope** (AC: #1)
  - [x] Widen `toHookJson` in `src/transports/hook-entry.ts` from `'UserPromptSubmit' | 'PreToolUse'` to include `'SubagentStart'`.
  - [x] **Do not touch the second `toHookJson` in `src/query/reflex.ts`.** It takes a `ReflexEvent`, and no reflex event can ever be a `SubagentStart`, so the two are *correctly* divergent. Widening both would wire a path that cannot exist.
  - [x] **No script change is needed for the output to reach the host.** The existing `subagent-start` arm is a bare pipe, so Node's stdout is already the hook's stdout, and `main()` guards with `if (output)` so an empty return prints nothing at all — not a blank line. Confirm rather than build.
  - [x] `SubagentStart` **cannot block a subagent** (documented; exit 2 renders a notice and it proceeds). The failure mode of this whole story is noise, never breakage — which is exactly why AC #4's silence obligation is the one that must hold.

- [x] **Task 5 — Do not say what the parent already said** (AC: #3)
  - [x] Suppress the auto-brief when its content is already present in the captured dispatch prompt. That is the only way the two paths collide; they otherwise land in different contexts.
  - [x] Compare on **normalised content**, not raw equality — whitespace and line endings differ between what `cortex_brief` returned and what the parent pasted. Do not key on the `Briefing for …:` header alone: `cortex_brief` emits it only when `for` is passed, and a parent may strip it.
  - [x] State the residual: a parent that paraphrases rather than pastes is not detected. Under-suppressing costs tokens; over-suppressing costs the whole feature.

- [x] **Task 6 — Fix the billing, and the sibling defect re-filed onto this story** (AC: #4)
  - [x] `bookHookInjection` books to `store.getCurrentSession()` — primary-only by SQL. Tokens injected into a subagent must book to the **child** session Story 5.1 creates, or this story's own cost lands on the parent and the P&L that judges it is wrong. Its two callers are `renderConsultGate` and `endOfTurn` (`find_referencing_symbols`; `certify_refs` confirms no further code sites) and **both must keep booking to the primary** — they are parent-facing surfaces.
  - [x] **`deferred-work.md` re-filed TWO coupled items onto this story, saying "both are the same question and should be answered once."** The second is absent from the earlier draft and is required here: **`reflect-pre` bills a subagent's edits to the primary, and because the reflex dedupe state file is keyed by session id, a subagent consumes the parent's once-per-anchor marker — so the parent then edits the same file and gets no reflex at all.** Confirmed in code: `reflectFromPayload` resolves via `resolveSessionId(store, cwd, options)` with no identity, and `statePath()` (`src/query/reflex.ts`) keys on `options.sessionId`. Either fix it here or record an explicit deferral **with an owner** — silently dropping re-filed scope is how it returns as an epic action item, which is the failure Task 7 cites `content_digests` for.
  - [x] Note the cost of fixing it: re-routing `reflect-*` changes a rendered surface on every `Edit` and `Write`, so it needs the eval gate run and a considered decision, not a reflex.
  - [x] `cortex stats` renders session and scope blocks including `(incl. subagents)`; confirm corrected attribution *renders* sensibly rather than merely being stored correctly.

- [x] **Task 7 — Bound the new table's growth at its source** (AC: #1)
  - [x] Add a GC rule in `src/db/gc.ts` for consumed and long-expired captures. Not optional: `pruneContentDigests`' own docstring records that `content_digests` *"shipped in Story 3.1 with **no** GC rule at all… it grew monotonically for the life of a project"* and became an action item a later story had to absorb.
  - [x] This is the **growth** bound only. The **correctness** bound — a capture too old to be paired — belongs in the pairing query (Task 2), because GC runs at most once per 24 hours.
  - [x] Any `CORTEX_*` option parses with **`Number`, never `parseInt`** — five incidents, the most recent being Story 5.1's SQL `CAST` reproducing the same prefix-parsing trap through a different door. Guard the digits explicitly.

- [x] **Task 8 — Tests** (AC: #1, #2, #3, #4)
  - [x] **Fixture repair, which this story does need.** Adding a seventh `REQUIRED_WIRING` entry breaks both "complete, passing installation" fixtures: `tests/doctor.test.ts`'s `buildFixture` and `tests/cli.test.ts`'s `seedSandboxHome` each **hand-write** their `PreToolUse` block, so `missingWiring` goes non-empty, `hook-wiring` fails and `report.ok` is false across many unrelated tests. Story 5.1's guard covers a new *script* (it throws when `HOOK_SCRIPTS` gains an entry without a `TEMPLATE_BODIES` stand-in) and does nothing for a new *wiring entry*. Add the `PreToolUse (Agent)` entry to both fixtures — and consider deriving them from `REQUIRED_WIRING` so the eighth entry is not a third repair.
  - [x] Pairing: one capture + one matching start → briefed and consumed. Same `agent_type` but a **different `session_id`** → not consumed (the two-windows case). Same type, **different `prompt_id`** → not consumed (the stale-capture case). Two captures matching the full key → oldest consumed, ambiguity counted. Zero captures → nothing emitted. A capture older than the pairing horizon → not consumed.
  - [x] Concurrency: two `SubagentStart` calls against one capture yield exactly one consumption — assert on the conditional-update row count, not a read-then-write sequence.
  - [x] AC #2: a topic with no matching memory emits **nothing**, and the test must fail if the implementation emits `No context found` — that is the trap. Also assert **no retrieval-log row** is written on that path, which is what forces the check ahead of `brief()`.
  - [x] AC #1 budget: the emitted brief is within 150 estimated tokens **at a binding size** — seed enough memory that the budget genuinely trims. `docs/invariants.md` records that a cap above the seeded content can never fire and is decoration.
  - [x] AC #3: a prompt containing the brief suppresses it; a prompt without it does not; a whitespace-and-newline-differing paste still suppresses.
  - [x] AC #4: a throwing store, a throwing brief generator and an unreadable capture each produce silence and exit 0 — not a stack trace, not a blank line.
  - [x] `dispatch-pre` returns `''` and does **not** produce reflex JSON (the fallthrough guard from Task 1).
  - [x] Billing: the injection books to the **child**; the consult gate still books to the primary. Mutation-check both.
  - [x] Installer: with `PreToolUse` wired in a second settings file, the new entry is **still written** (the `wiredElsewhere` fix).
  - [x] Standard store fixture exactly (`:memory:` → `pragma('foreign_keys = ON')` → `applySchema` → `initializeMeta` → `new CortexStore(db)`). Import specifiers end in `.js`. **`npm run lint` does not typecheck `tests/`.**

- [x] **Task 9 — Documentation is part of the change** (AC: all)
  - [x] `docs/invariants.md`: the `(session_id, prompt_id, agent_type)` pairing key and what each part buys; FIFO-over-silence for same-turn fan-out, with its counter; the `brief()`-never-returns-empty trap and why the check precedes the call; the 150 ruling; the billing fix; the `wiredElsewhere` per-event defect; the two-horizon expiry rule.
  - [x] `README.md`: the hook wiring table gains a `PreToolUse (Agent)` row; Subagent attribution gains what a subagent is now *told*, and that silence is the default.
  - [x] `CLAUDE.md`: Current Model and Core Files.
  - [x] `sprint-status.yaml` at each transition.
  - [x] **Every written claim must be true of the shipped code.** The earlier draft of *this story* shipped three false claims that validation caught — a precedent that did not exist, a fixture claim that was inverted, and an eval-gate expectation contradicted by `find_referencing_symbols`. All three were plausible statements about shared code written without asking the symbol tools. Cite symbols and files, not line numbers.

## Dev Notes

### What Story 5.1 already built, and what it left

`hooks/claude/cortex-subagent.sh` is wired at `SubagentStart`, guards on engagement,
validates its own action argument, and **carries no default action** — that absence is
load-bearing: `install` and `doctor` share `REQUIRED_WIRING`, so a defaulted action would make
a wiring `doctor` refuses actually work. The `case` was shaped for this story to append an arm.

`subagentStart` (`src/transports/hook-entry.ts`) creates the child session and returns `''`.
It already refuses to act without an `agent_id`, refuses with no active primary, and wraps its
body so nothing escapes onto the turn. This story changes its **return value**, not its guards.

`recordSubagentStart` (`src/scope/runtime.ts`) and `CortexStore.incrementMetaCounter` are the
observability precedent: a marker written once, a counter incremented inside **one** SQL
statement, and a conditional `doctor` row that stays silent until the path has fired.

### Three traps specific to this story

1. **`brief()` never returns empty**, and emitting its output unconditionally puts
   `No context found for "…"` at the top of a fresh subagent context on every dispatch — worse
   than silence, because it spends tokens to announce there is nothing. It also logs a
   retrieval on that path, so the check must come *before* the call.
2. **A missing `handleHookPayload` branch is type-clean.** The function falls through to
   `reflectFromPayload`, `main()` casts `argv[2]` unchecked, and there is no exhaustive switch —
   so forgetting the branch silently injects reflex context into the **parent** on every
   dispatch.
3. **Two `REQUIRED_WIRING` entries on one event is new**, and `wiredElsewhere` is keyed by
   event name, so the installer will skip the second one wherever `PreToolUse` is already
   wired in another merged settings file.

### Constraints binding this story

- **N-1** — silence by default, and here it is the primary correctness property, not politeness. No key match, stale capture, empty brief, any failure: emit nothing.
- **SM-C3** — telling an agent something untrue is the worst failure this product can produce. The strong pairing key exists to make a *dangerous* mispairing (unrelated turn, other window) impossible; the residual is confined to siblings of one fan-out, whose contexts are genuinely related.
- **AD-12 / N-3** — degrade silently on the hook path, but the *rate* must be visible in `doctor`, or a permanently-silent feature is indistinguishable from a quiet week.
- **AD-11 / P-5** — `SCHEMA_VERSION` stays **6**; append to `V5_TABLES`.
- **AD-4 / AD-5** — the capture table is a lookup structure, projects nothing into `memory_items`, carries no fixture obligation. If that changes, the locked fixture ships in the same change.
- **AD-1** — layer direction `transports/` → `query/` → `memory/` + `scope/` → `db/`. Story 5.1's marker keys had to move out of `transports/` for exactly this reason.
- **N-4 / AD-2** — no Node per **tool call**. `PreToolUse` on `Agent` is per *dispatch* (56 in four days here, against 4,881 captured commands) — the same frequency argument that carried `SubagentStart`. `cortex-capture.sh` stays untouched and a test asserts it.
- **N-7** — replay produces identical state; a capture consumed twice must brief once.
- **The `SubagentStart` cost ruling (ShuromiU, 2026-08-06)** accepted the measured figure with the **structural clause normative**: one Node spawn per dispatch, one `jq`, no SQLite in bash, no network, nothing blocking on a file. This story adds a second hook on a second event — the same clause applies, and the end-to-end figure is re-measured rather than inherited.

### Verification

```bash
npm run build
npm run lint
npx vitest run
npm run gate
node dist/transports/cli.js doctor
```

**The eval gate is expected at ZERO delta.** (Correcting this story's own earlier draft, which
told the dev to expect movement — that was wrong and wrong in the dangerous direction, because
it pre-authorised a moved gate as "a finding to explain".) `brief()` has **no eval-harness
caller**: `find_referencing_symbols` returns only `src/transports/mcp.ts` and the
`src/index.ts` barrel. The gate's `brief` surface renders from `buildSessionBrief`, which this
story does not touch. **Any movement means the change reached `session-brief.ts` or retrieval
scoring, and must be explained before proceeding.** Regenerating a baseline is never how a red
gate goes green.

Then: byte-scan every touched file for stray control characters, and run a mutation campaign
proving each new guard is load-bearing — mutate `src/` and `hooks/`, never `dist/`; prove each
mutation applied by sha; restore byte-identically; and make the campaign **EOL-aware**, because
several sources here are CRLF and Story 5.1's first run reported 5 of 10 anchors "not found"
for exactly that reason. A surviving mutation is a missing test, not a tolerable gap.

**Verification order — three ordered gates (ruling, ShuromiU, 2026-08-06).** `dist/` in this
checkout is the live installation for the whole machine. (1) Build and prove in a sandboxed
`CORTEX_HOME` plus a temp project — the real rendered hook against a real store, just not the
live one. (2) Run the three-layer review. (3) Only then `cortex install` to wire it
machine-wide.

Live proof, at gate 3, **both halves required**: dispatch a real subagent into a topic with
seeded memory and show it receiving the brief; dispatch one into a topic with none and show it
receiving **nothing**. The silent case is the one that regresses invisibly. A same-message
fan-out of two same-type agents is also worth dispatching, since that is the residual Task 2
accepts.

**One store is not a sample.** Verify against at least two real projects.

### Project Structure Notes

| File | Change |
|---|---|
| `hooks/claude/cortex-subagent.sh` | new `dispatch-pre` arm (the `subagent-start` arm already passes stdout through) |
| `src/transports/hook-entry.ts` | `HookAction`, `handleHookPayload` branch, capture handler, `subagentStart` emits, `toHookJson` widened, `bookHookInjection` attribution |
| `src/db/schema.ts` | new table appended to `V5_TABLES`; index on the pairing key |
| `src/db/store.ts` | capture insert, conditional consume, counters |
| `src/db/gc.ts` | prune consumed and long-expired captures |
| `src/query/install.ts` | `wiredElsewhere` keyed by event + discriminator |
| `src/query/doctor.ts` | `REQUIRED_WIRING` entry; ambiguity reporting |
| new caller in `src/transports/hook-entry.ts` | retrieve-then-brief, so emptiness is known before `brief()` runs — **`src/query/brief.ts` itself is not modified** |
| `docs/invariants.md`, `README.md`, `CLAUDE.md` | per Task 9 |
| `tests/{doctor,cli,hook-entry,capture-hook,install}.test.ts` | per Task 8 |

No new dependency. Conventional Commits, lowercase subject — `feat:`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-5.2] — ACs and the 2026-08-06 amendments, verbatim
- [Source: _bmad-output/implementation-artifacts/5-1-link-subagent-sessions-to-their-parent.md] — Appendix A (host contract), the hook script, the observability precedent, and the review findings this story must not repeat
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — the two coupled items re-filed onto this story
- [Source: _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md#FR-18] — automatic subagent brief; §Glossary; §10 budgets
- [Source: docs/invariants.md] — N-1, SM-C3, AD-4/AD-5, AD-11, AD-12, the `content_digests` GC lesson, the rendered-string-as-data lesson, the installer/diagnostic agreement rule
- [Source: _bmad-output/project-context.md] — 41 binding implementation rules
- Probe log: `…/scratchpad/rebase-probe.log` (2026-08-06)

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

- Gate 1 sandbox proof: `…/scratchpad/sandbox-proof.mjs` — real rendered hook, sandboxed `CORTEX_HOME` + temp git project, 15/15 checks.
- Mutation campaign: `…/scratchpad/mutate-52.mjs` — 27 anchors, EOL-aware, sha-proven applied and restored byte-identically.

### Completion Notes List

**What shipped.** `PreToolUse` on the `Agent` tool captures the dispatch; `SubagentStart`
pairs with it on `(session_id, prompt_id, agent_type)` and injects a ≤150-token brief through
`hookSpecificOutput.additionalContext`, billed to the child session. Silence is the default and
is the common case. One new table appended to `V5_TABLES`, `SCHEMA_VERSION` unchanged at 6.

**Per-AC outcome.**

| AC | Outcome |
|---|---|
| **#1** | **MET** as amended. Description captured at `PreToolUse(Agent)`, consumed at `SubagentStart`, envelope not stdout, budget 150. The pairing is unambiguous-or-counted; exact verification against the sidecar's `toolUseId` stays deferred to 5.3, as the story stated up front. |
| **#2** | **MET.** The emptiness check runs before `brief()`, decided structurally from the retrieval result count. A no-match dispatch emits nothing and writes **no** retrieval-log row — both asserted. |
| **#3** | **MET, with its residuals stated.** Suppression compares `renderMemoryLine(item, 2)` for every matched item against a normalized 8,192-character prompt prefix. A paraphrase is not detected; neither is a brief pasted past the bound. `prompt_chars` records the full length so the bound is observable rather than implied (AD-6). |
| **#4** | **MET, both halves.** Two independently guarded halves at `SubagentStart` (the session survives a throwing brief), a guarded `dispatch-pre`, and the billing defect fixed — the brief books to the child, the two parent-facing callers still book to the primary, and both directions are mutation-checked. |

**Three decisions worth naming.**

1. **An automatic brief REINFORCES the memory it delivered.** `brief()` calls `logRetrieval`
   → `touchMemoryItems`, which moves hotness and therefore ranking on every future retrieval
   surface — so this is a retrieval-quality decision, not a reporting one. Kept, because the
   emptiness pre-check means `brief()` is reached only when memory actually matched *and* was
   delivered into an agent's context, which is the event hotness exists to record; suppressing it
   would make a real usage channel invisible to decay. Residual stated in `docs/invariants.md`.
2. **A dispatch with no explicit `subagent_type` is not captured, rather than defaulted.** The
   host's default agent name is a host detail — this machine's own agent list names its catch-all
   `claude`, not `general-purpose` — and a wrong guess does not merely fail to pair: it puts a
   foreign row into the queue for a type that IS dispatched, where FIFO hands it to a legitimate
   subagent. SM-C3 bought for a convenience. Refusing costs one brief.
3. **The re-filed `reflect-pre` defect was FIXED here, not deferred again.** `deferred-work.md`
   said both halves were the same question and should be answered once. The cost the note feared
   did not materialise: `reflectMemory` uses the session id only for the dedupe state-file path and
   the ledger row, so nothing rendered depends on it — gate 9/9 at zero delta.

**Two defects found and fixed that the story did not predict.**

- **The `wiredElsewhere` fix needed a companion.** `install`'s matcher repair runs once per
  required wiring over the same event array, so a hand-written record packing BOTH `PreToolUse`
  commands under one matcher would be repaired twice, each pass overwriting the other's matcher and
  leaving one hook firing on the wrong tool — silently, because `hook-wiring` never inspects a
  matcher. Guarded by `matcherIsContested`, and `doctor` gained a `Dispatch matcher` row for the
  same reason `capture-matcher` exists.
- **The first-fire marker was stamped one millisecond AFTER the child it describes**, so `doctor`'s
  `started_at >= marker` window excluded the very first child of every store and the row printed a
  count one too low, permanently. Found by the **sandbox proof**, not by any unit test — "4 fired,
  3 recorded" against four real children. A Story 5.1 defect surfaced by extending its row; fixed
  by recording the fire before creating the session, which also fails in the safe direction. The
  first test written for it **survived** the mutation campaign (in memory both land in the same
  millisecond); it now asserts the order of operations instead.

**Observability, and what it deliberately does not warn about.** `doctor`'s `Subagent sessions`
row gained `captured / paired / briefed`, plus the ambiguity count. Ambiguity is **reported, never
warned on**: N same-type agents in one message is routine — this repository's own review workflow
does exactly that — so a warn would fire on a healthy install every time the feature worked, which
is the cries-wolf half of AD-12. The one new warn is captures accumulating with **zero** pairings
ever, thresholded at three rather than one so a denied `Agent` call or a `doctor` run racing a live
dispatch cannot trip it.

**Verification, in the ruled order.**

- Gate 1 — **sandbox**: `cortex install` into a sandboxed HOME, then the **real rendered
  `cortex-subagent.sh`** run under bash against a real store in a temp git project. 15/15: both
  `PreToolUse` entries written with their own matchers, `dispatch-pre` silent, `SubagentStart`
  emitting the envelope, a no-memory dispatch emitting **nothing**, a two-agent same-message fan-out
  briefing both, disengagement silencing everything, every brief billed to a child, and `doctor`
  18/18 with the new rows rendering.
- `npm run build`, `npm run lint`, `npx vitest run` → **1703 passed, 1 skipped** (47 files),
  `npm run gate` → **9/9 at zero delta**, exactly as the story predicted (`brief()` has no
  eval-harness caller).
- `node dist/transports/cli.js doctor` on the live install: two failures, both expected before
  gate 3 and both naming `cortex install` — `PreToolUse (subagent dispatch)` unwired and
  `cortex-subagent.sh` stale against the new template. Loud with a named fix, never silent.
- Byte scan: 111 files across `src/`, `hooks/`, `tests/`, `docs/`, `README.md`, `CLAUDE.md` —
  **0 control-byte offenders**. One was introduced and caught by the suite's own guard: `wiringKey`
  was first written with a raw NUL separator, the exact hazard Story 4.5 removed.
- Mutation campaign: **27/27 KILLED**, every mutation sha-proven applied and restored
  byte-identically, EOL-aware. One survivor on the first run (M18, above) closed by strengthening
  its test rather than by accepting the gap.
- Gate 3 (`cortex install` machine-wide) is **not yet run** — it comes after the three-layer review,
  per the 2026-08-06 ruling.

**Stated limits carried forward.**

- The sandbox is not the host: `agent_type` at `SubagentStart` is assumed equal to
  `tool_input.subagent_type` at `PreToolUse`. That equality is the pairing's third key part and is
  the one thing gate 3's live proof must confirm; if the host disagrees, the failure mode is a miss
  (no brief), never a wrong brief.
- The probe behind the FIFO residual did not record whether the dispatches were
  `run_in_background`. A host that queues backgrounded dispatches could land two captures before
  either start — which is what the ambiguity counter exists to expose.

### File List

**Source**

- `src/db/schema.ts` — `subagent_dispatches` appended to `V5_TABLES`; two indexes added to `INDEXES`
- `src/db/store.ts` — dispatch row/parsed types, `insertSubagentDispatch`, `getSubagentDispatch`, `countPendingSubagentDispatches`, `consumeSubagentDispatch`
- `src/db/gc.ts` — `dispatchDays` option, `pruneSubagentDispatches`, `subagent_dispatches` in `GcReport`
- `src/scope/runtime.ts` — dispatch marker/counter keys, `recordSubagentDispatch`, `recordSubagentPairing`
- `src/query/subagent-brief.ts` — **new**: horizon, prompt summary, suppression, retrieve-then-brief
- `src/query/doctor.ts` — `PreToolUse (subagent dispatch)` wiring, `wiringKey`, `metaCount`, dispatch counters in `Subagent sessions`, new `Dispatch matcher` row
- `src/query/install.ts` — `wiredElsewhere` keyed by `wiringKey`, `matcherIsContested`
- `src/transports/hook-entry.ts` — `dispatch-pre` action/branch/handler, `subagentStart` emits, `renderSubagentBrief`, `toHookJson` widened, `bookHookInjection` session argument, `reflectFromPayload` identity, marker ordering
- `src/index.ts` — new exports
- `hooks/claude/cortex-subagent.sh` — `dispatch-pre` arm

**Tests**

- `tests/subagent-brief.test.ts` — **new** (31)
- `tests/hook-entry.test.ts` — dispatch-pre, the brief, billing, reflex attribution, marker ordering
- `tests/doctor.test.ts` — fixture derived from `REQUIRED_WIRING`; dispatch counters; dispatch matcher
- `tests/install.test.ts` — per-wiring de-duplication, the two-settings-file case, two wirings on one event
- `tests/cli.test.ts` — `seedSandboxHome` derived from `REQUIRED_WIRING`
- `tests/capture-hook.test.ts` — one Node invocation per arm; arms matched against `REQUIRED_WIRING`

**Documentation**

- `docs/invariants.md` — 20 FR-18 bullets
- `README.md` — hook table row; "What a subagent is told"
- `CLAUDE.md` — Current Model, Core Files, invariants coverage
- `_bmad-output/implementation-artifacts/deferred-work.md` — the re-filed `reflect-pre` item closed
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Review Findings (three-layer, 2026-08-07)

Blind Hunter, Edge Case Hunter and Acceptance Auditor ran in parallel against
`c0df4b0..b3ebebd`. **The seven most consequential findings were re-verified
against the built `dist/` before any of them was acted on** — 7/7 confirmed
(`scratchpad/verify-review.mjs`). Nothing below is taken from a reviewer's word.

### Two rulings (ShuromiU, 2026-08-07)

**R1 — More than one candidate means say nothing.** The story shipped FIFO and
justified it with "refusing would silence exactly the fan-out case". **Measured
false.** The host ordering is strictly interleaved (`PreToolUse(a) → Start(a) →
PreToolUse(b) → Start(b)`), so a genuine same-message fan-out never has two
captures pending at a start — the ambiguity counter was booking **zero** for it,
while my test and my sandbox driver both dispatched BOTH before starting either,
which is not what the host does. That artifact is what made FIFO look like the
fan-out's friend. What FIFO actually resolved was the broken shapes, wrongly:
an `Agent` call the user DENIES leaves an orphan, the assistant re-dispatches in
the same turn, and the real subagent is handed the orphan. Reproduced — a
subagent sent to audit the read ledger opened with `Decision [kafka pipeline]`.
Refusing costs the fan-out nothing and closes the SM-C3 case.
Rejected: keep FIFO; withdraw the feature pending 5.3's verification.

**R2 — The reflex whisper stays per participant.** Re-routing `reflect-pre`
through agent identity turned "once per anchor" into "once per anchor per
session": measured, a parent and three subagents editing one file produce four
whispers where one fired before. Kept, because each subagent has a fresh context
and genuinely has not seen it. Rejected: whispers to the primary only — a
subagent about to edit a specific file would get no warning about a decision
attached to that file, since its dispatch brief is built from a job description.

### Three HIGH defects, all reproduced, all fixed

1. **The 150-token cap was not a cap.** `assembleBudgeted` keeps its first
   evidence line unconditionally and `renderMemoryLine` does not truncate note
   text: one 3,436-character note rendered **895 tokens**. Four documents
   asserted the cap as fact. The budget test could not see it — twelve SHORT
   notes, so trimming binds before any single line does. Fixed with
   `enforceBriefBudget` on this surface only (the shared trimmer is pulled by
   agents who asked and can ask for less; this one pushes unprompted), plus a
   test seeded with ONE LARGE item.
2. **`CORTEX_SUBAGENT_BRIEF=off` did not stop the capture.** Rows accumulated
   unconsumed and `doctor` then warned FOREVER on a deliberately configured
   install, naming a fix that repairs nothing — the cries-wolf half of AD-12
   arriving through the one switch documented to prevent all of this.
3. **A re-fired start stole a sibling's capture.** Alpha briefed twice (the
   second time with bravo's topic), bravo silent, both billed to alpha. Fixed by
   recording `consumed_by_agent_id` and refusing a repeat inside the same atomic
   `UPDATE`; the column is added by `ensureColumn`, because
   `CREATE TABLE IF NOT EXISTS` does nothing to a table the first build created.

### Also fixed

- **`matcherIsContested` reintroduced the disagreement it was written to
  prevent.** It declined to repair even when the matcher was WRONG, so `doctor`
  warned and named `cortex install` as the fix that had just refused. Worse, a
  shared matcher containing `Agent` made `reflect-pre` fire on every dispatch and
  woke the `agent` reflex INTO THE PARENT — the dormant path Task 1 forbids
  waking — with every row green. Now `install` SPLITS the record. My first split
  computed the removal and then discarded it, passing its own test while
  changing nothing; the test now asserts each wiring sits alone under its own
  matcher and that a second run is byte-identical.
- **A throwing brief consumed the row and booked no pairing.** The pairing is now
  booked at the claim.
- **An asymmetric corrupt counter manufactured the never-paired warn.** The old
  test seeded BOTH keys corrupt, so the predicate could never fire.
- **`reflect-pre` could mint a primary from a subagent's cwd** and create children
  with no fire behind them. Identity is dropped when no primary is active.
- **`doctor` printed "all 7 events wired" on a six-event install.**
- **Tests that asserted less than their names claimed:** the sibling-ordering test
  passed under LIFO (both seeded notes matched both topics — now disjoint
  vocabularies); the suppression test seeded ONE note, so "every item present"
  degenerated; `cli.test.ts`'s fixture never exercised a real matcher shape;
  `tool_use_id` was written and never asserted; no test checked that a shell arm
  passes its OWN action token.
- **Prose:** `CLAUDE.md`'s "the `SubagentStart` bridge … emits nothing" (both
  clauses false), its hook-action list, two stale Story 5.1 invariants, `gc.ts`'s
  "consumed about 800 ms after it is written" (true only on the happy path),
  `prompt_chars` as the NORMALIZED length, and "two lines when `forAgent` is set"
  (it can be more).

### The measurement the story bound itself to and the first build skipped

Through the rendered hooks under bash, quiescent, real repo and real store, 40
runs after 5 warmup, work asserted (45 captured, 45 paired, 45 children, 45/45
briefed): `dispatch-pre` **min 573.0 / median 606.1 / p95 698.4 ms**,
`subagent-start` **min 578.9 / median 622.2 / p95 703.1 ms**, together **median
1272.8 / p95 1343.9 ms** per dispatch, against a bash floor of median 69.1 ms.

**A fact the Story 5.1 ruling did not cover: `PreToolUse` GATES the tool call,
where `SubagentStart` cannot block the subagent.** So ~600 ms now sits in front
of every dispatch. The comparison that makes it tolerable is `reflect-pre`, which
carries the same Node-startup cost on every `Edit` and `Write` and has shipped
all release; a dispatch is orders of magnitude rarer (56 in four days here
against 4,881 captured commands). Priced honestly too: the briefed path runs
retrieval TWICE — the pre-check, then inside `brief()` — roughly 5% of the path
against a ~480 ms Node floor, and the direct cost of the ordering that keeps
`No context found` out of a fresh subagent's context. **Brought as a fact, not
resolved: no budget covers either event.**

### Deferred, with owners

- **Reflex dedupe state files now proliferate per subagent** in `os.tmpdir()`
  with no cleanup in `reflex.ts` or `gc.ts` — ~14 per project per day at this
  repo's cited rate. NEW growth this change created. Owner: whichever story next
  touches `reflex.ts`; recorded in `deferred-work.md`.
- **The first-fire marker repair is forward-only.** Eleven live stores keep a
  marker one millisecond past their first child and keep under-reporting by one,
  silently, as a `pass`. Recorded rather than migrated.
- **`subagent_dispatches.scope_key` is written and read by nothing**, and the
  `!primary?.scope_key` guard costs a real miss to populate it.
- **No `reflex-matcher` doctor row** (pre-existing gap, newly reachable).
- **A backwards clock jump ≥ the GC window re-opens old orphans.**

### What reproduced clean, and what all three layers verified

The Auditor re-ran every number in the first Dev Agent Record and **all
reproduced exactly**. Its sharpest correction stands: "27/27 KILLED describes a
chosen anchor set, not guard coverage" — which is why round two added anchors for
every guard the review created, and why `tool_use_id`, the shell arm token and
the no-primary guard each gained the test they never had.

Symbol-tool verifications, each naming its tool: `find_referencing_symbols(brief)`
returns only `mcp.ts`, the barrel and `subagent-brief.ts` — no eval-harness
caller, so the gate's zero delta is a real signal; `bookHookInjection` has exactly
three callers, each booking correctly; `upsertMemoryItem` plus
`certify_refs("subagent_dispatches")` confirm no `memory_items` writer, so there
is no AD-5 obligation; `reflectMemory` uses `options.sessionId` in exactly two
places, neither rendered. `UPDATE … RETURNING` was probed directly on
better-sqlite3 12.8.0 and is atomic. `SCHEMA_VERSION` stays 6; AD-1, N-4 and
`Number`-never-`parseInt` all hold.

### Verification after the round

- `npm run build`, `npm run lint`, `npx vitest run` → **1716 passed, 1 skipped**
  (47 files), `npm run gate` → **9/9 at zero delta**.
- Mutation campaign round 2 → **35/35 KILLED**, sha-proven and restored
  byte-identically, EOL-aware. One survivor on the first pass (the no-primary
  guard, which had only a manual probe) closed by writing the test.
- Sandbox proof → **16/16**, now including a denied-dispatch case and a fan-out
  driven in the MEASURED interleaving rather than the artifact ordering.
- Byte scan → 111 files, **0 offenders**.
- Live `doctor` → the same two expected pre-install failures, both naming
  `cortex install`.
- Gate 3 (`cortex install` machine-wide) still **not run**.


### Change Log

| Date | Change |
| --- | --- |
| 2026-08-06 | Story created against `453e7f2`, on ACs re-based against measurement beforehand rather than discovered during implementation. Independent validation then found seven issues in the first draft, all folded in: the pairing key was rebuilt on `(session_id, prompt_id, agent_type)` — both ids were in the measured payloads, transcribed into the story, and not mined — which converts most of the refuse-to-guess machinery into a narrow, counted residual; the installer cannot currently write a second `REQUIRED_WIRING` entry on one event (`wiredElsewhere` is keyed by event name), and the "reflect-pre / reflect-prompt precedent" cited for it does not exist; both test fixtures DO need repair, the opposite of what the draft claimed; a missing `handleHookPayload` branch is type-clean and would inject reflex context into the parent; the eval-gate expectation was inverted and pre-authorised a moved gate; `logRetrieval` reinforces memory, making an auto-brief a ranking decision rather than a reporting one; and a second re-filed defect had been dropped. One AC clause (exact pairing verification via the sidecar's `toolUseId`) is now explicitly deferred to Story 5.3 rather than quietly narrowed. Status → ready-for-dev. |
| 2026-08-07 | Dev complete. All four ACs met as amended. Two unpredicted defects found and fixed: `install`'s matcher repair would overwrite itself across two wirings on one event, and Story 5.1's first-fire marker was stamped one millisecond after the child it describes so `doctor` under-counted by one, permanently — found by the sandbox proof, not by any test. The re-filed `reflect-pre` defect was fixed rather than deferred again, and the cost the note feared did not materialise (nothing rendered depends on the session id; gate unmoved). Reinforcement, the strict `subagent_type`, and the report-don't-warn treatment of pairing ambiguity are stated decisions with their residuals recorded. 1703 tests / 1 skipped, gate 9/9 zero delta, mutation campaign 27/27 killed after strengthening one test that survived, byte scan clean across 111 files, sandbox proof 15/15 against the real rendered hook. Gate 3 (`cortex install` machine-wide) deliberately not run — it follows the three-layer review. Status → review. |
| 2026-08-07 | THREE-LAYER REVIEW RECONCILED. Seven headline findings re-verified against the built `dist/` before any was acted on — 7/7 confirmed. TWO RULINGS (ShuromiU): (a) more than one candidate capture means SAY NOTHING — the story's FIFO premise was measured false, because the host ordering is strictly interleaved so a genuine fan-out never looks ambiguous, while FIFO was reproducibly handing a DENIED dispatch's context to the next same-type subagent (SM-C3); (b) the reflex whisper stays per participant, with its measured fan-out cost stated. THREE HIGH DEFECTS, all reproduced and fixed: the 150-token cap was not a cap (one 3,436-char note rendered 895 tokens; four documents asserted it as fact; the budget test seeded twelve SHORT notes so trimming bound first); `CORTEX_SUBAGENT_BRIEF=off` did not stop the capture, so rows accumulated and `doctor` warned forever on a deliberately configured install; and a re-fired start stole a sibling's capture, briefing one agent twice and the other never. ALSO FIXED: `matcherIsContested` reintroduced the very installer/diagnostic disagreement it was written to prevent, and its first split computed a removal then discarded it — passing its own test while changing nothing; a throwing brief consumed the row and booked no pairing; an asymmetric corrupt counter manufactured the never-paired warn; `reflect-pre` could mint a primary from a subagent's cwd; `doctor` printed "all 7 events wired" on six events; five tests asserted less than their names claimed. THE SKIPPED MEASUREMENT WAS TAKEN: `dispatch-pre` median 606.1 / p95 698.4 ms, `subagent-start` median 622.2 / p95 703.1 ms, together median 1272.8 ms per dispatch — and a fact Story 5.1's ruling did not cover, that `PreToolUse` GATES the tool call. 1716 tests, gate 9/9 zero delta, mutation campaign 35/35 killed after writing the one test a survivor exposed, sandbox 16/16 including the denied-dispatch case, byte scan clean. Status stays `review` pending ShuromiU's read; gate 3 not run. |
