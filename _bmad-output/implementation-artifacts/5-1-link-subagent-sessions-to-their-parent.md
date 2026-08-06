---
baseline_commit: a3e5d48572d9e1c377930bdbe8e30fba6b42ffde
---

# Story 5.1: Link subagent sessions to their parent

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Cortex maintainer,
I want a dispatched subagent to operate in a session linked to its parent,
so that its work is attributable and its findings are recoverable.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 5 → Story 5.1. Do not
reword, split, or extend these. If one is wrong, stop and say so rather than implementing
around it.

1. **Given** a subagent is dispatched from a Cortex-engaged session
   **When** `SubagentStart` fires
   **Then** a child session is created recording `parent_session_id`, `agent_id`, `agent_type`, and the parent's `scope_key`.

2. **Given** the child session captures activity
   **When** the parent's timeline is rendered
   **Then** the child's events are attributed to the child, not merged into the parent.

3. **Given** Cortex is disengaged for the project
   **When** a subagent is dispatched
   **Then** no child session is created and nothing is captured.

### Per-AC status established from the code, not assumed

The 2026-07-28 replan narrowed this story ("Epic 0 already resolves hook payloads carrying
`agent_id` to child sessions. Remaining scope is only the `SubagentStart`-driven proactive
creation path and the disengaged-project guard. **Verify against Epic 0's code before
writing new machinery.**"). That verification is done and recorded here so the dev agent
neither re-derives it nor, worse, re-implements it.

| AC | Status entering this story | Evidence |
|---|---|---|
| **#1** | **NOT MET — this is the story's real work.** | `certify_refs("SubagentStart")` → **`textSource: 0`**: zero hits under `src/`, `hooks/`, `tests/`; every site is a planning artifact. (`coverage.lsp` reads `unavailable` — symbol coverage is *absent*, not zero, because a host event name is not a symbol. `textSource: 0` is the number that carries the claim.) `REQUIRED_WIRING` (`src/query/doctor.ts:163-189`) declares **five** events, none a subagent event. `HOOK_SCRIPTS` (`doctor.ts:115-119`) is **three** scripts. `HookAction` (`src/transports/hook-entry.ts:44-51`) is a closed seven-member union with no subagent member. |
| **#2** | **ALREADY MET by Epic 0 — pin it, do not rebuild it.** | Story 0.1 Task 6 made `getRecentSessionsByScope` and `getSessionCountByScope` primary-only and made `syncBranchSnapshotForSession` a no-op for a child; Story 0.2 made the flush resolve **each spool entry** to its own session (`resolveEntrySession`, `src/capture/spool.ts:663`). `docs/invariants.md:27` states the contract. **Live proof, 2026-08-06:** 56 child sessions across two live stores carry 196 `command_runs` / 276 `memory_items` / 47 `content_digests` (cortex store) attributed to children. **But the enumeration behind "met" is narrower than it looks — see § Which surfaces actually filter on parentage.** |
| **#3** | **PARTIALLY INHERITED — the new path needs its own bash guard.** | `isEnabled` (`hook-entry.ts:119-126`) is called at `handleHookPayload:534`, **before** `parsePayload`, so every Node action inherits it. The bash half does not come free: each shipped script carries its own `grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null \|\| exit 0` (`cortex-reflect.sh:11`, `cortex-end-of-turn.sh:11`, `cortex-capture.sh:14` — byte-identical, verified). Without it a disengaged project spawns Node on every dispatch to do nothing. |

**Deliverable:** one new hook script, one new hook action, the wiring/diagnostic surface that
must move with them, a disposal rule for the rows this story creates, an observability row
that does not cry wolf, tests that **pin** AC #2 rather than re-implement it, and the
invariants this repo does not yet have for any of it.

## Tasks / Subtasks

- [x] **Task 1 — New hook script template `hooks/claude/cortex-subagent.sh`** (AC: #1, #3)
  - [x] Model it on `hooks/claude/cortex-reflect.sh` — the closest analogue (action argument, engagement guard, pipe into Node). **Not** on `cortex-capture.sh`, which is the pure-bash hot path.
  - [x] Line 2 must be exactly `# cortex-hook-template: __CORTEX_TEMPLATE_ID__`. `hookTemplateDigest` (`doctor.ts:231-234`) hashes the template *including* that placeholder; `renderHookScript` (`install.ts:114-128`) substitutes it.
  - [x] `ACTION="${1:-subagent-start}"` — the `cortex-reflect.sh:6` idiom. One script serves both subagent events; Story 5.3 adds the `SubagentStop` arm. **Wire only `subagent-start` here**, but shape the `case` so 5.3 appends rather than rewrites.
  - [x] `INPUT=$(cat)`; `CWD=$(echo "$INPUT" | jq -r '.cwd // empty')`; `[ -z "$CWD" ] && exit 0`.
  - [x] **AC #3, bash half:** the engagement `grep` line above, byte-identical, placed **before** the `case` so disengagement turns this off with everything else (the `docs/invariants.md:115` ordering precedent).
  - [x] `printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" subagent-start`; terminal `exit 0`.
  - [x] **Emit nothing** (N-1). The script is a pure pipe and Node returns `''` in this story.
  - [x] **LF line endings, not CRLF.** `docs/invariants.md:164`: there is no `.gitattributes`, a CRLF script was once written and reported fully current because every validator normalises before comparing, and `package.json` ships `hooks/`.
  - [x] No `set -e`, no `timeout`, no backgrounding, no lock file — match the two existing Node-spawning scripts exactly.

- [x] **Task 2 — New `subagent-start` hook action** (AC: #1, #3)
  - [x] Add `'subagent-start'` to `HookAction` (`hook-entry.ts:44-51`) and a branch in `handleHookPayload` **after** the existing `isEnabled` gate (do not duplicate that gate), returning `''`.
  - [x] Write `subagentStart(store, payload, cwd, options): void`:
    - Read identity with the existing `agentIdentity(payload)` (`hook-entry.ts:100-108`). It already accepts both `agent_id`/`agentId` and `agent_type`/`agentType` — the host-drift tolerance this story inherits rather than re-invents.
    - **If there is no `agentId`, do nothing at all and return.** This is the one place a bare `resolveSessionId` would be actively wrong: `resolveSessionId(store, cwd, {})` (`hook-entry.ts:110-117`) falls through to `ensureScopedSession(store, cwd, {})` → `ensurePrimarySession` → `createSession` (`runtime.ts:275`), manufacturing a primary as a side effect of a subagent event — and rotating the real one if the subagent's `cwd` resolves elsewhere.
    - Otherwise call `ensureScopedSession(store, cwd, identity)`. **Use the existing exported function; add no new export** — `ensureAgentSession` and `findAgentSession` are module-private by design.
    - Record the observability marker (Task 4) on the same path.
  - [x] **Handle the no-active-primary branch explicitly.** `ensureScopedSession` (`runtime.ts:236-238`) reads `const primary = active?.scope_key ? active : ensurePrimarySession(store, cwd, options)`. With no active primary it runs `detectGitScope(cwd)` — a `git` subprocess, on the path Task 6 budgets — and mints a primary from the **subagent's** `cwd`. AC #1 says the child records *"the parent's `scope_key`"*; in that branch there is no parent and the scope comes from the subagent. Decide and state the behaviour, and cover it in Task 5 — `tests/hook-entry.test.ts`'s `createTestStore()` always creates a primary first, so the case is structurally untested today.
  - [x] **Nothing may escape onto the turn** (AD-12 / N-3). Note the live gap: `main()` swallows `UnopenableStoreError` and returns (`hook-entry.ts:579-581`) but **rethrows anything else** (`:582`), which on this event means a non-zero exit and a host-rendered hook-error notice on every dispatch. `SubagentStart` cannot block a subagent, so the damage is noise rather than breakage — but "print nothing, exit 0 always" has to be true, so the new action's body must not rely on that outer handler.
  - [x] **Do not** thread agent identity into any other action. `reflect-*` and `end-of-turn` stay on the primary by design (`docs/invariants.md:23`).

- [x] **Task 3 — Wiring, installer and diagnostic** (AC: #1)
  - [x] Append `'cortex-subagent.sh'` to `HOOK_SCRIPTS` (`doctor.ts:115-119`). This drives the installer's script-writing loop (`install.ts:536-625`) and `doctor`'s `hook-scripts` / `hook-substitution` / `hook-currency` checks — those are **not** driven by `REQUIRED_WIRING`.
  - [x] Append to `REQUIRED_WIRING` (`doctor.ts:163-189`):
    `{ event: 'SubagentStart', label: 'SubagentStart (subagent session)', script: 'cortex-subagent.sh', action: 'subagent-start' }`.
    **No `matcher` key** — matchers on this event match the *agent type*, and Cortex must capture every subagent. This follows the `Stop` / `SessionStart` precedent.
  - [x] **Verify the installer can actually write it, and assert it with a test.** `wiringCommand` (`install.ts:337-351`) returns `null` for any entry with neither a `script` nor `token === 'inject-header'`, and `mergeHookWiring` does `if (command === null) continue;` at **`install.ts:263`**. Such an entry is silently skipped by the installer while `doctor` still demands it — a permanently failing `hook-wiring` row whose printed fix is a no-op. Our entry carries `script`, so it is fine; the failure is silent, so pin it.
  - [x] Do **not** set `actionOptionalUnless`. That field exists only because `cortex-reflect.sh` defaults its action and two events share it. Here the default and the only wired action coincide, and the escape hatch would let a future `subagent-stop` wiring satisfy the `SubagentStart` requirement once Story 5.3 lands.
  - [x] `mergeHookWiring`'s `wiredElsewhere` scan (`install.ts:631-647`) picks the new event up automatically — it iterates `REQUIRED_WIRING`. This matters: Claude Code merges three settings files and **both entries fire** if two exist (`docs/invariants.md:162`), so a duplicated `SubagentStart` would create the session twice per dispatch.
  - [x] **`tests/doctor.test.ts` will CRASH IN ITS FIXTURE, not merely go red — fix it as part of this task.** `TEMPLATE_BODIES` (`tests/doctor.test.ts:62-81`) is a hand-written `Record<string, string>` with exactly three keys, consumed as `TEMPLATE_BODIES[script]!` inside `for (const script of HOOK_SCRIPTS)` (`:106-115`). A fourth `HOOK_SCRIPTS` entry makes that `undefined` and `template.replaceAll(...)` throws, killing **every test in the file** inside `buildFixture()`. The fixture's settings.json (`:117-133`) also hand-enumerates the five events, so its stated baseline of "a complete, passing installation" becomes false. Add a `cortex-subagent.sh` stand-in template and the `SubagentStart` wiring to that fixture. **Note the correction to a plausible assumption: `doctor.test.ts` does *not* iterate `REQUIRED_WIRING`** — line 14 is an import and line 30 is a `.find()` for the capture matcher; there is no `for…of` over it anywhere in that file.
  - [x] `tests/install.test.ts` **does** genuinely iterate `REQUIRED_WIRING` (`:151`, `:280`) and uses the **real shipped templates** (`templateDir: path.resolve('hooks','claude')`, `:340`), so it extends automatically once the script exists. Its red is the intended gate.

- [x] **Task 4 — Make it observable, without crying wolf** (AC: #1)
  - [x] `docs/invariants.md:223` names the failure this must not repeat — *"wired, running, dead, with nothing saying so"*: 4,881 `command_runs` with 2 exit codes and two episode writers that had never fired. A `SubagentStart` path that silently stops firing (stale script, lost wiring, renamed host field) would look exactly like "this project dispatches no subagents".
  - [x] Record a marker in the store's `meta` table on the `subagent-start` path. Precedent: `cmd_outcome_scan` — written via `store.setMeta` (`spool.ts:1010-1011`), read via `getMetaValue` inside `doctor`'s read-only open (`doctor.ts:1152`). **`meta` already exists (`store.ts:1326` `getMeta`, `:1333` `setMeta`), so this story adds no table and no column and does not touch `SCHEMA_VERSION`** (AD-11 — the R1 increment is spent; `SCHEMA_VERSION` is **6** at `schema.ts:35`, the constant is still named `V5_TABLES` at `schema.ts:363`).
  - [x] **Do not** put the marker in `.cortex.state`. `writeEngagement` (`src/transports/mcp.ts:102-130`) is a read-modify-write of the whole file; two subagents starting ~800 ms apart (measured) would race it, and `inject-header` rewrites the same file wholesale.
  - [x] Conditional `doctor` row, following the `command-outcomes` shape (`docs/invariants.md:230`):
    - **absent** on a project with no subagent history and no marker;
    - **warn** when subagents are demonstrably running but the path is not firing;
    - **pass** otherwise;
    - **never `fail`** — *"a row that warns on every fresh install is noise that gets tuned out, which would cost exactly the attention the check exists to buy."*
  - [x] **The obvious warn condition is wrong and would misfire on day one.** "Child sessions exist but no marker" warns immediately on every store with subagent history: measured now, the cortex store holds 40 children and repo-c 16, and neither has a marker because the marker does not exist yet. That is the same self-inflicted flap `docs/invariants.md:241` records from the Epic 4 rollout, where a `doctor` row swung PASS/WARN on healthy installs. Gate the warn on subagent activity observed **after** the marker was introduced — e.g. compare against the marker's own first-seen timestamp, or against child sessions started after it — so a pre-existing history cannot trigger it.
  - [x] `docs/invariants.md:241` states the governing rule as *"Only a transcript-aware caller may write the command-outcome scan status"*; the generalisation it teaches is that only a caller structurally able to know the truth may write a health status. Only the `subagent-start` action may write this marker.
  - [x] **B-7** (`cortex doctor` cold ≤ 3 s) covers the diagnostic. The added work is one `meta` read plus one `COUNT(*)`, inside the existing read-only open (`doctor.ts:1147-1168`) — cheap, but state it rather than assume it.

- [x] **Task 5 — Dispose of the rows this story creates** (AC: #1)
  - [x] Story 0.1's review set the precedent in this story's own lineage: *"This story creates the rows, so it owns their disposal."*
  - [x] The mechanism: `getUnconsolidatedSessions` (`store.ts:1542-1554`) selects every `status='ended'` session with no `state` row at `layer='session'`, with **no parentage filter**. `inject-header` loops that set on **every SessionStart** calling `consolidateLevel1` per row (`cli.ts:832-838`), and `consolidateLevel1` returns `[]` when the session has no `events` (`consolidate.ts:206-216`) — so `writeSessionSummary` is never called and the row stays in the set **forever**. `src/db/gc.ts` never deletes `sessions` rows.
  - [x] **Measured, so the decision is informed rather than alarmed** (read-only sweep of all 36 live stores, 2026-08-06):
    - The permanent-unconsolidated pool is **pre-existing and large**: **1,423 of 1,952 sessions (73%)** machine-wide; worst case `ShuromiU` at **950 of 951**; cortex 107/252; repo-b 133/341.
    - **No child session is in it today: 0 of 56.** Every existing child captured something, got a summary, and its raw events were later collected — `childNoEvents = 56` with `childUnconsolidated = 0` is that history, not a leak.
    - So the row this story newly creates is exactly the capability it advertises: **a subagent that captures nothing**, which is impossible today and permanently unconsolidated tomorrow.
  - [x] Decide and implement one of: write an empty session summary when an ended child has no events, so it consolidates and leaves the set; or add a GC rule for ended childless-and-eventless child sessions; or state the growth explicitly with **B-8** (≤ 50 MB database + WAL) arithmetic and a named owner. Silence is the one option this repo's own history rules out.
  - [x] Whatever is chosen must not change behaviour for the 1,423 pre-existing rows — that pool is not this story's to clear, and quietly clearing it would be an unreviewed data change on a path that runs at every SessionStart.

- [x] **Task 6 — Tests** (AC: #1, #2, #3)
  - [x] `tests/hook-entry.test.ts` — AC #1: a `subagent-start` payload with `agent_id`/`agent_type` creates a child whose `parent_session_id` is the active primary, whose `agent_type` is the payload's, and whose `scope_key` equals the parent's. Same payload twice → **one** child. Two `agent_id`s → two. **No `agent_id` → nothing at all**: assert the total session count is unchanged, including that no primary was created.
  - [x] `tests/hook-entry.test.ts` — the no-active-primary branch from Task 2, asserting whatever behaviour that task decides.
  - [x] `tests/hook-entry.test.ts` — AC #3, Node half: with engagement absent or false, no session is created and the action returns `''`. Isolated temp cwd — engagement state is global module state (commit `22530d8`).
  - [x] **Convergence test — the highest-value one, and easy to miss.** `resolveAgentSessionId` is exported (`runtime.ts:208`) and already live from the spool flush (`spool.ts:663`). After this story two independent writers find-or-create the same child. Assert that a `subagent-start` followed by a spooled entry for the same `agent_id` yields exactly **one** session row. That is the real N-7 assertion for this change.
  - [x] `tests/capture-hook.test.ts` — AC #3, bash half. Note the existing harness runs the **raw template** (`SCRIPT = …/hooks/claude/cortex-capture.sh`) under `describe.skipIf(!canRun)`, not a rendered copy — and unrendered is the stronger test here, because the surviving `__CORTEX_NODE__` placeholder guarantees a spawn failure if the guard ever leaks. Assert: disengaged → exit 0, no Node spawn, no output. Resolve POSIX tools absolutely via `tests/posix-tools.ts`; `docs/invariants.md:101` records seven tests self-skipping and seven failing with a spawn error while the run reported green.
  - [x] **AC #2 must be PINNED, mutation-checked, against a named anchor.** Story 0.1's review found three tests that "assert less than they claim", including one that passed byte-identically with its guard deleted — because the value under test was *already* filtered upstream. Target the filter itself: **deleting `AND parent_session_id IS NULL` from `getRecentSessionsByScope` (`store.ts:1527`) or `getSessionCountByScope` (`store.ts:1537`) must turn the pin red.** If a proposed test survives that mutation, it is not a test — say so and replace it.
  - [x] `tests/doctor.test.ts` — the fixture repair from Task 3, the sixth wiring entry, and the new row's three states (absent / warn / pass) asserted on the rendered report, including the day-one case that must **not** warn.
  - [x] `tests/install.test.ts` — the new script is written and stamped, the wiring entry is produced (`wiringCommand` non-null), and a second run is byte-identical: all three come free because those tests already loop `HOOK_SCRIPTS` and `REQUIRED_WIRING`. **Two corrections after audit:** "executable" is asserted nowhere (the only `chmod` is `install.ts`'s `0o755`, a no-op on Windows, and no test reads a file mode) — the claim is withdrawn rather than faked; and the de-duplication test was hardcoded to `Stop`, so `SubagentStart` had no coverage at all. That test is now `it.each` over `REQUIRED_WIRING`, which covers all six events and cannot silently exempt the next one.
  - [x] Standard store fixture, replicated exactly (`:memory:` → `pragma('foreign_keys = ON')` → `applySchema` → `initializeMeta` → `new CortexStore(db)`). `foreign_keys` is off by default and `sessions.parent_session_id` is an FK.
  - [x] Import specifiers end in `.js`, including in `tests/`. **`npm run lint` does not typecheck `tests/`.**

- [x] **Task 7 — The budget this event does not have** (AC: #1)
  - [x] **Normative, build to it unconditionally and pin it by test: one Node process per subagent *dispatch*, never per tool call.** N-4 is untouched — `cortex-capture.sh` is not edited by this story and a test should assert that. No SQLite in bash, no network, no blocking wait on any file.
  - [x] **No existing budget covers `SubagentStart`.** B-4 is scoped in PRD §10 to the non-substituting `PostToolUse` path (`Edit`, `Write`, `Bash`, `Agent`); B-4a covers `Read` substitution; B-1 the session brief; B-3 queries; B-7 `doctor`. Epic 5 must state one rather than quietly borrow another.
  - [x] Measure end-to-end p95 through the **installed** hook and report it honestly, met or not — the B-3 / B-4a precedent. Quiescent measurement is part of the protocol: `docs/invariants.md:136` records the identical script measuring ~40% higher under concurrent agent load. Do not narrow the work to fit a number; that is how a false pass is manufactured.
  - [x] Context for the reading, not a substitute for it: this platform's floor is a bash spawn at median 36.9 / p95 83.9 ms plus `jq` at ~100 ms; the shipped hooks measure ~400–500 ms end to end; the host's timeout for this event is **60 s**; and it fires **once per subagent** (56 dispatches in four days on this repo, against 4,881 captured commands). If the number is uncomfortable, bring it to the user as a ruling rather than trimming the story.

- [x] **Task 8 — Documentation is part of the change** (AC: #1, #2, #3)
  - [x] **`docs/invariants.md` — this story ADDS invariants; it does not merely comply.** The file is **silent** on `SubagentStart` and `SubagentStop` (0 occurrences of either), on subagent briefing and on write-back; its only forward reference is line 118, *"a decision about subagent context inheritance (Story 5.2 territory)"*. Add at minimum: how a subagent session comes into existence proactively; that the path creates nothing without an `agent_id`; the engagement guard's ordering; the disposal rule from Task 5; the observability row and why it warns rather than fails; and the budget from Task 7. Stay consistent with line 23 (a subagent payload never rotates or ends the primary), line 115 (the engagement guard precedes the tool `case`, so disengage turns everything off with it) and lines 91/118 (a fresh subagent context must never be told it already holds something).
  - [x] **`README.md` — four surfaces go stale, not one.** The hook wiring table (`README.md:136-141`) enumerates the wired events and will be missing `SubagentStart`; the section heading (`:132`, "Capture, Reflex, and Stop Hooks"); the "Subagent attribution" section (`:146-150`), which describes attribution as capture-driven; and differentiator bullet 2 (`:32`), which says subagent sessions come from spool lines carrying `agent_id`.
  - [x] `CLAUDE.md` — the behaviour contract, and the Core Files list if a new module appears.
  - [x] **`_bmad-output/implementation-artifacts/deferred-work.md` — re-file the items that name this story.** Line 29 reads *"Epic 5 owns child-timeline rendering (**Story 5.1 AC 2**)"*; line 27 assigns parent/child reflex routing to Epic 5 (Task 2 scopes it out without naming a new owner); line 39 assigns `promoteSubagentNotes`' re-activation defect to Epic 5. AC #2 as literally written is met by Epic 0, so these belong on 5.2/5.3 — move them, or 5.1 closes leaving deferred entries whose named owner is a closed story. That is exactly the stale-guidance failure the standing rollout rule exists to prevent.
  - [x] Flip `_bmad-output/implementation-artifacts/sprint-status.yaml` (`:125`) at each transition.
  - [x] **Every written claim must be true of the shipped code.** Epic 4's audits caught false claims in shipped comments, a comment the suite's own test contradicted, task boxes ticked for work not done, and a File List naming files that did not exist. Tick a box only when the work behind it is done; list only files that exist; quote only text that is actually there.

## Review Findings

Three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) against baseline
`a3e5d48`. Every finding below was independently reproduced before being rated; the layers'
own severities were discarded. Two findings were reported by two layers each.

**Fixed — both HIGH, both reproduced, both would have produced the same false alarm the
observability row exists to prevent.**

- [x] **The first-fire marker was stamped with the resolved child's `started_at`, not with now** [blind+edge] — and a fire can *find* a child rather than create one, because `getSessionByAgentId` is unfiltered by parent and status (deliberately: Story 0.2 AC #3). A recycled `agent_id` therefore back-dated the marker to an old row's birthday and swept the entire pre-feature history into `doctor`'s window. Reproduced: marker `2026-01-01`, 1 fire, **21 children in window**, verdict WARN with a fix that repairs nothing — the day-one flap this row was designed around, entering by a different door. The irony is that the story's own "Known limits" section documents the binding hazard and then feeds its output straight into the marker. Fixed: stamp `new Date().toISOString()`. Pinned by a test that seeds an old child and asserts the marker is fresh; mutation M11.

- [x] **The fire counter was a read-modify-write across independent hook processes** [blind+edge] — `getMeta` → compute → `setMeta`, two statements, no transaction. `busy_timeout` serialises writes but does not make read-then-write atomic, so two hooks can both read 5 and both write 6. Reproduced: two fires from 5 landed on **6**. Every loss is permanent, because the marker is write-once and the count never re-baselines, so **one** occurrence latches the row to warn for the life of the store — with a printed fix (`cortex install`) that cannot repair it. Fixed with `CortexStore.incrementMetaCounter`, one SQL statement. This also **contradicted this story's own Dev Notes**, which asserted "the race is already handled" — true of session creation, false of the counter this story added; that section is corrected in place.

- [x] **The counter fix reintroduced the `parseInt` trap through SQL** — caught by the test suite during the fix round, not by a reviewer. A bare `CAST(value AS INTEGER)` parses a numeric **prefix**: `'12 fires'` → 12, exactly the fail-forward behaviour `parseInt` was banned for after four incidents. The first version of the fix shipped that, with a comment claiming it was "still never `parseInt`" — a false claim in shipped prose. Now guarded with an all-digits `GLOB` test so only a clean integer counts; pinned across seven corrupt values; mutation M3.

- [x] **A new test would have gone red on every fresh checkout, and guarded nothing** [blind] — `expect(raw).not.toContain('\r')` on the template. There is no `.gitattributes` and `core.autocrlf` is on, so a Windows checkout legitimately has CRLF templates (`git ls-files --eol` already reports `i/lf w/crlf` for `cortex-capture.sh`). It also protected nothing: `renderHookScript` normalises CRLF to LF **before** substituting, which is the guarantee that matters. Replaced with a test that renders both an LF and a CRLF template and asserts the *installed* output is LF — the property that actually ships.

- [x] **The script defaulted its action argument, making a wiring `doctor` refuses actually work** [blind] — `${1:-subagent-start}` against a `REQUIRED_WIRING` entry with no `actionOptionalUnless`. `install` and `doctor` share that constant precisely so what one writes is what the other checks; the default broke the agreement, so an arg-less hand-wiring would run fine while `doctor` called the installation unwired and `install` appended a **second** entry beside it — two Node spawns per dispatch, invisible to a row that only warns on a shortfall. Fixed: no default. Every bash test now passes the action explicitly, because that is the only form that ships; mutation M14.

- [x] **`subagentStart` let a store failure escape onto the turn** [auditor+blind] — Task 2 ticked a box promising nothing would, and the wrapper script's header promises it prints nothing and exits 0, but only the advisory marker write was guarded. `main()` wraps just `openCortexDb` and rethrows everything else, so a throw reached the turn as a stack trace on stderr with a non-zero exit. Reachable: `ensureAgentSession` rethrows when it loses the create race and the re-find misses, and `SQLITE_BUSY` from a second hook lands in the same place. Fixed by wrapping the body; pinned by a test with a throwing store; mutation M13.

- [x] **Three structure tests sat inside `describe.skipIf(!canRun)`** [auditor] — the LF/N-4/capture-untouched assertions read files and need no shell, so on a machine where bash cannot be resolved they would skip silently while the run reported green. That is the exact shape `docs/invariants.md:101` records. Moved into their own unconditional block.

- [x] **A ticked Task 6 box claimed two `install` assertions that did not exist** [auditor] — "executable" is asserted nowhere (the only `chmod` is a no-op on Windows and no test reads a mode), and the de-duplication test was hardcoded to `Stop`, so `SubagentStart` had **no** coverage. The false claim is withdrawn rather than faked, and the de-dup test is now `it.each` over `REQUIRED_WIRING` — all six events, and the next one cannot be silently exempt.

- [x] **The measured pool figure was internally impossible and is now partly false** [auditor] — `1,428 of 1,952` mixed a numerator from one reading with a denominator from an earlier one, and the companion "worst store 953 of 954" contradicted it. Re-measured 2026-08-06: **1,433 of 1,971, 100% eventless**. And "zero are children" was true when written and is now false — **this story's own live proof created the first one**, exactly the row it exists to make attributable. All four surfaces corrected, dated, and the count marked as drifting; the durable finding is the shape, not the number.

- [x] **`file:line` citations were systematically off by one within a day of being written** [auditor] — because every edit above them shifts the count. All symbol citations in the story, `docs/invariants.md` and `deferred-work.md` now name the **symbol and file**, not the line, with the reason stated in place.

- [x] **Three smaller prose corrections** [auditor+blind] — `.cortex.state` is not written only by `inject-header` (the MCP `cortex_state` and `cortex_engage` paths write it too, though the conclusion still holds and is restated more precisely); the `promoteSubagentNotes` re-filing understated its own enumeration and contradicted the entry below it; and the deferred item named a role rather than an owner, now **ShuromiU**, because it is a data change across every store rather than a code cleanup.

- [x] **The write-once mutation anchor was flaky and is now deterministic** [auditor] — "fire twice, assert the marker did not move" can pass with the guard deleted, because `toISOString()` has millisecond resolution and two back-to-back fires can stamp the same value. The auditor predicted it; the campaign then confirmed it, with M4 **surviving** on the second run. Rewritten to seed a distant marker and assert it is untouched.

**Deferred — real, reproduced, and not this story's to fix.** All three are now recorded in
`deferred-work.md` and `docs/invariants.md`, which is what was missing.

- [x] [Defer] **`SubagentStart` adopts whatever primary is active in the STORE, not necessarily the one for the payload's `cwd`** [edge] — one store is shared by every worktree and `getCurrentSession` is not scope-filtered, so with two engaged windows a dispatch from worktree A can be parented to B's primary and inherit B's scope key; A's later flush then creates a second child. Reproduced. Not fixed because this is `ensureScopedSession`'s deliberate Epic 0 contract — resolving scope from a subagent's `cwd` is exactly what rotated the parent mid-turn before Story 0.1's review — and the cheap alternative is a `git` subprocess on a hook path whose structural clause forbids one. Same family as Story 4.5's two-windows item; a real fix is per-window session identity at the scope layer.
- [x] [Defer] **A re-fire for a recycled `agent_id` after the tree ended lands on the ended child** [edge] — reproduced. Bounded by the host issuing per-dispatch UUIDs, and already logged as "agent-id uniqueness across primaries is a load-bearing host assumption". Fixing it contradicts the AC that keeps a child findable after its parent ends, so it needs that item's owner, not a patch here.
- [x] [Defer] **`cortex stats` reports `Focus: unfocused` after ten dispatches** [blind] — `getRecentSessions(10)` is not parentage-filtered and children carry no focus. Pre-existing shape, but this story made it far easier to reach: previously ten subagents each had to make a captured tool call to fill that window, now every dispatch does. The honest fix filters that query on parentage, a rendering decision that belongs with child-timeline surfacing (5.3).

**Dismissed (2).** *"Nested dispatches are flattened to the primary"* — true, already stated in Dev Notes as a known limit, and now also in the README and invariants; it is documentation, not a defect. *"'this scope' should read 'this store'"* — the comment is imprecise but both the marker and `doctor`'s count are store-wide and consistent, so the arithmetic is right; reworded rather than treated as a finding.

**Raised and put to the user as a ruling (1) — now closed.** The auditor noted the machine-wide rebuild happened **before** this review, against the story's own "review it before the rebuild that ships it". Real, and the story was self-contradictory: it also mandates live end-to-end proof, unobtainable without building, because this checkout's `dist/` *is* the live installation.

**RULING (ShuromiU, 2026-08-06): three ordered gates — sandbox → review → install.** Build and prove in a sandboxed `CORTEX_HOME` plus a temp project (the real rendered hook against a real store, just not the live one); then review; then `cortex install` machine-wide. Rejected: reviewing the working copy before installing (cheapest, but leaves unreviewed code running here), and sandbox-only (would have missed this epic's most valuable finding — that the host writes a subagent's dispatch description strictly *after* the hook returns, which only a live probe could show). Recorded in `docs/invariants.md` and `CLAUDE.md` § Verification so the next story inherits it.

**Second ruling, closing the story's one open budget question. RULING (ShuromiU, 2026-08-06): the measured figure is ACCEPTED**, on the B-3 precedent rather than by naming a ceiling. `SubagentStart` fires once per subagent, cannot block or delay it, and sits ~100× inside the host's own 60 s timeout, so a tighter number would be effort spent where nobody experiences it. The structural clause stays normative and CI-pinned. Rejected: a formal 800 ms B-9, and deferring to 5.2/5.3.

## Dev Notes

### What Epic 0 already built — use it, do not rebuild it

`ensureScopedSession(store, cwd, options)` (`src/scope/runtime.ts:222-239`) is the whole
resolver and is already correct for this story's needs:

```ts
if (!options.agentId) { return ensurePrimarySession(store, cwd, options); }
const active = store.getCurrentSession();
const primary = active?.scope_key ? active : ensurePrimarySession(store, cwd, options);
return ensureAgentSession(store, primary, options.agentId, options.agentType);
```

- `getCurrentSession()` is `WHERE status = 'active' AND parent_session_id IS NULL` — a child
  can never be mistaken for the primary.
- The active primary is **adopted, not resolved**, so a subagent whose `cwd` differs (a
  worktree-isolated agent, a nested repo, a submodule) cannot end and rotate the parent
  mid-turn. Story 0.1's review found and fixed that exact defect.
- `ensureAgentSession` (private, `runtime.ts:148-197`) find-or-creates by
  `(scope_key, agent_id)`, upgrades `agent_type` when the host reports a better one, inherits
  every scope field from the primary, and ends a child immediately if its primary is already
  ended.
- `ScopeSessionOptions` (`runtime.ts:5-11`) already carries `agentId?` and `agentType?`.
  Nothing new is needed on the type.

### Which surfaces actually filter on parentage

AC #2 is met, but the guard is narrower than "children are excluded everywhere". Enumerated
with `find_referencing_symbols`, not grep:

Cited by symbol rather than by line: every edit in these files shifts the line numbers, and
an audit of this story's first draft found the citations already off by one within a day.

**Parentage-filtered — AC #2 holds here** (`src/db/store.ts` unless noted):
`getCurrentSession` · `getRecentPrimarySessions` · `getRecentSessionsByScope` ·
`getSessionCountByScope` · `syncBranchSnapshotForSession` (`src/scope/runtime.ts`, no-ops
for a child).

**NOT parentage-filtered — a child is visible:** `getRecentSessions` · `getSessionCount` ·
`getUnconsolidatedSessions` · `getUnconsolidatedSessionsByScope` · `scopeRootFor` ·
`scopeKeysForRoot` (`src/capture/digest-index.ts`).

Consumers of the unfiltered set, in `src/transports/cli.ts`: `cortex status`,
`cortex stats`, the `inject-header` action, `cortex consolidate`; plus `cortex_state`
(`src/query/state.ts`), `src/capture/consolidate.ts` and `src/eval/harness.ts`. The consult
gate (`src/transports/hook-entry.ts`) is safe — it uses the scoped filtered variant whenever
a `scope_key` exists.

Task 6's AC #2 pin must assert against the filtered surfaces and must not claim the
unfiltered ones exclude children, because they do not.

### The race is already handled for SESSIONS — and was not, for the counter this story added

**Corrected after review.** The section below is true of session creation and was written as
if it covered everything this story touches. It did not: the fire counter introduced by
Task 4 was a read-modify-write across independent hook processes, and `busy_timeout`
serialises writes without making read-then-write atomic. Reproduced — two fires from 5
landed on 6, and because the marker is write-once and the count never re-baselines, one lost
increment latches `doctor` to a warn for the life of the store. Fixed with
`incrementMetaCounter`, which does it in one SQL statement. Read the paragraph below as
being about sessions only.

Two subagents starting ~800 ms apart is measured, and each hook is its own OS process on its
own SQLite connection. Epic 0 built for this: `ensureSessionAgentIndex`
(`src/db/schema.ts:1064-1075`) creates a **partial** unique index
`ON sessions(scope_key, agent_id) WHERE agent_id IS NOT NULL`, and `ensureAgentSession`
wraps its `createSession` in `try/catch`, re-running the lookup and returning the winner on
throw. **Known degradation, stated rather than patched:** that index creation has a `catch`
fallback to a *non-unique* index so a store already holding duplicates still opens (AD-11);
on such a store the lost-race guard cannot fire. Do not "fix" it here.

### Known limits to state, not fix

- **Session trees are one level deep by construction.** `ensureScopedSession` parents every
  child to `getCurrentSession()`, which is primary-only, so a subagent that itself dispatches
  a subagent (`spawnDepth > 1`) is parented to the primary, flattening the tree.
  `endSessionTree` and `getSessionTreeIds` are likewise single-level, and
  `docs/invariants.md:93` records that AD-16's ancestry walk assumes depth 2 "by construction
  today". This story produces exactly the parentage the lazy path already does — say so, do
  not deepen it.
- **`cortex status` and `cortex stats` count children.** `getSessionCount` (`store.ts:1689`)
  and `getRecentSessions` (`:1495`) are unfiltered. Separately, `cortex stats` derives its
  `focus` by walking only the ten most recent sessions and taking the first non-null `focus`
  (`cli.ts:1047-1054`); children carry none, so ten or more dispatches since the last primary
  makes it report `unfocused`. Both are true today — this story makes them fire on *every*
  dispatch rather than only capturing ones.
- **The same `agent_id` in one scope can bind to a previous primary's ended child.**
  `getSessionByAgentId` filters by neither parent nor status, deliberately, because Story
  0.2's third AC requires a child to stay findable after its parent ends. Logged in
  `deferred-work.md`; "fixing" it breaks that AC.
- **A refused or absent store changes AC #1 silently.** Under P-5 (`UnopenableStoreError`)
  `main()` returns and **no child session is created** — AC #1 does not hold and nothing says
  so, which is the correct hook-side degradation but worth stating. Conversely
  `openProjectStore` *creates* a store when absent, so `SubagentStart` becomes a new
  store-creation trigger. In practice that is bounded because the engagement guard requires
  `.cortex.state` to exist and say `enabled=true` — written by `inject-header` and also by
  the MCP `cortex_state` and `cortex_engage` paths, all of which already open the store, so
  a `SubagentStart` can never be the *first* thing to create one.
- **`bookHookInjection` (`hook-entry.ts:163-181`) books against `getCurrentSession()`, which
  is primary-only.** Any token injected into a subagent would today be charged to the parent.
  That is **Story 5.2's** defect — named here because it is the strongest reason the child
  session must exist *before* anything is injected, which is what this story delivers.

### Constraints binding this story

- **AD-9** — session identity is `(scope_key, agent_id)`. Note precisely: the *label* `AD-9`
  appears nowhere in `docs/invariants.md`; line 23 states the same identity without naming
  the AD. The label is defined in `epics.md:117`. Do not "add the missing rule" — it is
  there, unlabelled.
- **AD-11 / P-5** — `SCHEMA_VERSION` is **6** and the R1 increment is spent. This story adds
  no table and no column. If that changes, append to `V5_TABLES` and leave the version alone;
  bumping it marks every shipped store newer-than-binary, which a v6 binary then refuses.
- **AD-12 / N-3** — hooks degrade to silence, user-invoked commands are loud. A memory
  failure must never break the turn.
- **N-1** — silence by default. This hook prints nothing, ever.
- **N-4 / AD-2** — no Node per **tool call**. This event is per *dispatch*;
  `cortex-capture.sh` is untouched and a test should assert that.
- **N-7** — replay produces identical state. Two `SubagentStart` fires for one `agent_id`
  yield one child, and so does a `SubagentStart` plus a spooled entry (Task 6).
- **AD-4 / AD-5** — nothing new projects into `memory_items` and no new kind is introduced,
  so there is **no** locked-fixture obligation. If that changes, the fixture ships in the
  same change.
- **AD-6** — evidence in hand, never a proxy. If Task 7's budget is unmet, report it unmet
  with the number.
- **B-1** (brief ≤150 ms), **B-7** (`doctor` ≤3 s), **B-8** (≤50 MB db+WAL) are the budgets
  this story's side effects touch. Name them in the measurements.
- **Time** — ISO-8601 UTC strings in `TEXT`. Ids are `crypto.randomUUID()`.
- **Windows is first-class.** Hooks run under Git Bash and depend on `jq`.
  `docs/invariants.md:139`: `jq` emits CRLF here and command substitution strips only the
  final trailing CR, so any field read from *multi-line* `jq` output needs `${v%$'\r'}`. This
  script reads one field, so the single-field form is safe — do not extend it to multi-field
  output without the strip.

### Testing standards

- Store fixture exactly as above; `foreign_keys = ON` is not optional.
- `os.tmpdir()`, never a literal `/tmp`.
- Import specifiers end in `.js`, including in `tests/`.
- Tests touching engagement state need an isolated temp cwd (`22530d8`).
- Assert observable behaviour — rendered strings, row contents — not implementation shape.
- **Control characters are written as `\uXXXX` escapes, never literal bytes.** A test walks
  `src/`, `hooks/` and `tests/` and fails on any control byte but tab, LF and CR
  (`docs/invariants.md:92`).

### Verification

All of these, in order, before any claim of completion:

```bash
npm run build
npm run lint
npx vitest run
npm run gate
node dist/transports/cli.js doctor
```

The eval gate is expected at zero delta — this story touches no ranking, tokenization,
reference-validation or output-shaping code. If any rendered surface moves, that assumption
is void: run the suites and reject on any negative `top1_hit`/`recall_at_3` delta or positive
`output_tokens` delta. **Never regenerate a baseline to turn a red gate green.**

Then: byte-scan every touched file for stray control characters, and run a mutation campaign
proving each new guard is load-bearing — mutate `src/`, never `dist/`; prove each mutation
applied by sha; restore byte-identically; treat a skipped anchor as an untested guard rather
than a pass. Named anchor for the AC #2 pin: `store.ts:1527` / `store.ts:1537`.

**`dist/` in this checkout IS the live installation for the whole machine.** `npm run build`
ships to every project on it, and this story changes unattended behaviour on every subagent
dispatch — **review it before the rebuild that ships it.** A broken auto-cleanup reached 3 of
36 live stores that way during Epic 4 before review caught it.

**Live end-to-end proof is required and is cheap here**, because this session is itself a
Claude Code session. Wire the hook — either through `cortex install`, the product's own path,
or by editing `~/.claude/settings.json` directly (this is permitted and was done during this
story's payload probe; back the file up first and restore it byte-identically afterwards,
verified by sha256). Then dispatch a real subagent and show the child session appearing **at
dispatch rather than at first tool call**, including one subagent that makes no captured tool
call at all — the case that is impossible today.

**One store is not a sample** (`docs/invariants.md:237`). Verify against at least two real
projects. The Epic 4 rollout found a case-folding defect, an absolute-path defect and a
43-second scan that were all invisible in the single store they were measured on.

### Project Structure Notes

| File | Change |
|---|---|
| `hooks/claude/cortex-subagent.sh` | **NEW** — the only new file |
| `src/transports/hook-entry.ts` | `HookAction` member, `handleHookPayload` branch, `subagentStart` |
| `src/query/doctor.ts` | `HOOK_SCRIPTS`, `REQUIRED_WIRING`, the new conditional row |
| `src/query/install.ts` | only if the script loop or `wiringCommand` needs it — verify first |
| `src/capture/consolidate.ts` or `src/db/gc.ts` | whichever Task 5's disposal decision lands in |
| `docs/invariants.md` | new invariants (the file is silent on this territory) |
| `README.md`, `CLAUDE.md`, `deferred-work.md`, `sprint-status.yaml` | per Task 8 |
| `tests/{hook-entry,capture-hook,doctor,install}.test.ts` | per Task 6 |

No new dependency. Conventional Commits, lowercase subject — `feat:`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-5-Subagent-Memory] — story statement and all three ACs, verbatim (checked character by character against `epics.md:955-983`)
- [Source: _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md#FR-17] — inherited subagent session; §15 Q1 resolution; §10 budgets B-1…B-8
- [Source: _bmad-output/planning-artifacts/replan-r1-2026-07-28.md#Epic-5] — the reduced scope and the instruction to verify against Epic 0's code first
- [Source: _bmad-output/implementation-artifacts/0-1-resolve-sessions-by-agent-identity.md] — the resolver, its review findings, the rotation defect, and "this story creates the rows, so it owns their disposal"
- [Source: _bmad-output/implementation-artifacts/0-2-carry-agent-identity-through-the-capture-spool.md] — the live capture path and what it left to Epic 5
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — lines 27, 29, 39 name Epic 5 / Story 5.1 as owner and must be re-filed (Task 8)
- [Source: docs/invariants.md] — lines 23, 24, 27, 28, 74, 91, 92, 93, 101, 115, 118, 136, 139, 157, 162, 164, 172, 194, 197, 198, 199, 205, 210, 211, 223, 230, 237, 241
- [Source: _bmad-output/planning-artifacts/architecture/architecture-cortex-2026-07-24/ARCHITECTURE-SPINE.md] — AD-4, AD-9, AD-11, AD-12; line 272 names `cortex-subagent.sh` for both subagent events
- [Source: _bmad-output/project-context.md] — 41 binding implementation rules; the verification block
- Appendix A below — the measured host contract

---

## Appendix A — Host contract, measured

Everything here was measured on 2026-08-06 against the installed host
(`~/.local/bin/claude`, build dated 2026-08-04) by wiring a real probe hook into
`~/.claude/settings.json`, dispatching four subagents (including two of the **same type in
one assistant message**), and restoring the settings file byte-identically (sha256
`d4d66a3b…` before and after). Probe log and script preserved at
`…/scratchpad/subagent-probe-D.log` and `…/scratchpad/cortex-subagent-probe.sh`.
Corroborated by reading the single payload-construction site in the host binary and
cross-checked against the published hook documentation.

**Only the first two sections bind Story 5.1.** The rest is recorded here so Stories 5.2 and
5.3 start from evidence rather than from the plan, which is wrong in one place.

### A.1 The `SubagentStart` payload — exactly seven fields

```
{"session_id":"…","transcript_path":"…","cwd":"C:\\Claude Code\\cortex",
 "prompt_id":"…","agent_id":"adfbf233fd1b7ccdf","agent_type":"Explore",
 "hook_event_name":"SubagentStart"}
```

Key set: `agent_id, agent_type, cwd, hook_event_name, prompt_id, session_id,
transcript_path`. There is exactly one `hook_event_name:"SubagentStart"` construction site
in the host binary, and the host's own help string reads *"Input to command is JSON with
agent_id and agent_type."*

- `cwd` is present — the `.cortex.state` engagement guard works exactly as in the three
  existing scripts, with no new mechanism.
- `session_id` is the **host's** parent session id, not Cortex's. Cortex resolves its own
  parent from its own store, as everywhere else.
- `permission_mode` and `effort` are **absent** here although present on `PreToolUse` and
  `SubagentStop`. Do not depend on them.
- **Documented-vs-measured disagreement — read defensively, never require.** The published
  documentation lists `tool_name` (*"if triggered by tool"*) and `tool_input` among this
  event's input schema. Neither was present in any of the four measured dispatches, all via
  the `Agent` tool, and the binary's construction site contains no tool fields at all. If a
  future host build supplies `tool_input`, that is a widening that makes Story 5.2 trivial.

### A.2 Host behaviours that bind the implementation

| Fact | Source | Consequence |
|---|---|---|
| `SubagentStart` **cannot block**; exit 2 renders a hook-error notice and the subagent proceeds. | Documented | We cannot break a subagent, but we can print noise. Print nothing, exit 0 always. |
| `hookSpecificOutput.additionalContext` **is** documented for this event. | Documented | The channel Story 5.2 needs exists. `toHookJson` (`hook-entry.ts:35`) is typed to `'UserPromptSubmit' \| 'PreToolUse'`; widening it is **5.2's** change. |
| Default timeout for agent-type hooks is **60 s**, per-hook configurable. | Documented | Huge headroom against this platform's ~400–500 ms hook cost. Latency is not the risk; a hang would be, so the script must not block on anything. |
| Matchers on `SubagentStart` match the **agent type** (`""` or `"*"` = all). | Documented | Cortex must capture every subagent, so the wiring carries no `matcher` key. |
| All matching hooks for one event run **in parallel**; output combination is undocumented. | Documented / not documented | This machine already wires `serena-bootstrap-reminder.sh subagent` at `SubagentStart`. Cortex's script must coexist and must not assume it is alone — another reason this story emits nothing. |
| Two subagents can start ~800 ms apart, each spawning its own hook process. | Measured | Concurrent `ensureAgentSession` calls are possible; Epic 0's partial unique index already handles it. |

### A.3 For Story 5.2 — nothing at `SubagentStart` carries the dispatch description

- **The per-agent sidecar is unreachable at start.** The host writes
  `<session dir>/subagents/agent-<agent_id>.meta.json` carrying
  `{"agentType","description","toolUseId","spawnDepth"}`. At `SubagentStart` it does not
  exist, and a **5,259 ms bounded poll inside the hook never saw it** — its write is ordered
  strictly *after* every `SubagentStart` hook returns. Waiting is not slow, it is impossible.
- **Reading the parent transcript at start is a race, reproduced.** With two `Explore`
  agents dispatched in one message, the **first** agent's `SubagentStart` saw a parent
  transcript not yet containing its own dispatch block; the second, 797 ms later, saw both.
  A transcript read here is an AD-12 trap: right most of the time, wrong exactly when a
  fan-out starts.
- **The only reliable source is `PreToolUse` on the `Agent` tool**, whose payload carries
  `tool_input: {description, prompt, subagent_type, run_in_background}` **and**
  `tool_use_id`. Measured order, even for two same-type agents dispatched together, is
  strictly interleaved: `PreToolUse(alpha) 17:04:38.743 → SubagentStart(alpha) 39.530 →
  PreToolUse(bravo) 39.982 → SubagentStart(bravo) 41.069`, each pairing confirmed by that
  agent's own `SubagentStop` sidecar. The documented lifecycle order agrees.
- **A self-audit is available and 5.2 should be required to use it:**
  `PreToolUse.tool_use_id` **equals** the sidecar's `toolUseId` (verified: both
  `toolu_01CBQEJUNqDMv7YWzupfeCZk`), so a start-time pairing guess can be checked exactly at
  `SubagentStop` and mispairings counted instead of being invisible.

### A.4 For Story 5.3 — the `SubagentStop` payload

Measured key set: `agent_id, agent_transcript_path, agent_type, background_tasks, cwd,
effort, hook_event_name, last_assistant_message, permission_mode, prompt_id, session_crons,
session_id, stop_hook_active, transcript_path`. `last_assistant_message` is documented and
was measured carrying the subagent's actual answer; `agent_transcript_path` and
`stop_hook_active` are **measured but not documented**. `SubagentStop` *can* block (exit 2 →
the subagent does not stop). **Do not wire `SubagentStop` in this story.**

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

- **RED gate, measured not asserted.** The 11 subagent tests written before any implementation were run first: **9 failed, 2 passed**. Both passers were vacuous and were strengthened rather than kept — the disengaged case passed because the action did not exist at all, and the marker test compared `undefined === undefined`, so it gained a `expect(first).toBeDefined()` that fails with the feature deleted.
- **Verification after implementation:** `npm run build` ✅ · `npm run lint` ✅ · `npx vitest run` ✅ **1623 passed / 1 skipped** · `npm run gate` ✅ 9/9 · `doctor` ✅ 19/19. 32 tests added at that point.
- **Verification after the review fix round (the numbers that stand):** `npm run build` ✅ · `npm run lint` ✅ · `npx vitest run` ✅ **1634 passed / 1 skipped (1635 total, 46 files)** · `npm run gate` ✅ **9/9 suites, zero delta on every metric** · `node dist/transports/cli.js doctor` ✅ **19/19 checks pass, exit 0**, with `Subagent sessions — SubagentStart fired 5 times … 5 subagent sessions recorded`.
- **Mutation campaign after the fix round: 14/14 killed** (10 original anchors plus 4 for the new guards — marker-stamped-now, atomic counter, error containment, no action default). Two anchors had to be repaired before they killed, and both repairs were findings in their own right: **M12 survived** because the atomic-counter test called the store method directly and nothing proved `recordSubagentStart` *used* it (closed by pinning the observable difference — a JS `Number('3.7')` continues from 4, the SQL digit guard restarts at 1), and **M4 survived** because the write-once test compared two same-millisecond stamps. Earlier campaign: 10/10.
- **Mutation campaign (first round): 10/10 killed.** Every mutation was applied to `src/` or `hooks/` — never `dist/` — proven applied by sha256 before/after, and restored byte-identically with the sha re-verified (`git status` confirms `src/db/store.ts` unmodified after M9/M10). Anchors: the `agentId` guard, the active-primary guard, `Number`-not-`parseInt`, the write-once marker, the doctor warn condition, the doctor since-marker window, the bash engagement guard, the bash action validation, and both halves of AC #2's filter (`getRecentSessionsByScope`, `getSessionCountByScope`).
- **The campaign's first run reported 5 of 10 anchors NOT FOUND, and that was the harness working.** Several sources here are CRLF and the multi-line anchors were written with `\n`. The harness refused to count a missing anchor as a pass and reported `ANCHOR NOT FOUND — GUARD UNTESTED`; making it EOL-aware turned all five into kills. A campaign that silently skipped them would have reported 5/5 and called every guard tested.
- **Budget measured through the rendered hook** (60 runs after 5 warmup, quiescent, real git repo + real store, `CORTEX_HOME` sandboxed): **min 480.7 / median 514.8 / p95 587.4 ms**, against a bash spawn floor of median 37.4 / p95 57.5 ms. The benchmark asserts the work actually happened rather than timing a no-op — 65 dispatches produced 65 child sessions and 65 fires, exactly 1:1.
- **Live end-to-end on the real installation.** `cortex install` wired the sixth event (preview showed exactly one new script and one new event; nothing else touched). A `general-purpose` subagent was then dispatched with `tool_uses: 0` and left a child session `a405daca2e28c9e31` with `events=0 cmds=0` — **the case that was impossible before this story** — with the marker set and `doctor` reporting `Subagent sessions … fired 1 time … 1 subagent session recorded`.
- **Second store, per "one store is not a sample".** `repo-c` (16 pre-existing children, no marker): `Hook wiring — all 6 events wired`, the `Subagent sessions` row correctly **absent**, 18/18 checks pass. The day-one silence is verified on real data in two stores, not reasoned about.

### Completion Notes List

- **AC #1 is delivered by the new path; AC #2 was already met and is now pinned; AC #3's Node half was inherited and its bash half is new.** Nothing in Epic 0 was rebuilt: `ensureScopedSession` already adopts the active primary instead of resolving one, already find-or-creates behind the partial unique index, and already handles the lost race. This story is a hook, an action, wiring, a health row, and tests.
- **Two guards that look like belt-and-braces are the whole safety of the change.** A `SubagentStart` with no `agent_id` creates nothing, and a `SubagentStart` with no active primary creates nothing. Without the first, `resolveSessionId` would manufacture a primary as a side effect of a subagent event; without the second, `ensureScopedSession` falls through to `ensurePrimarySession` and mints a primary from the **subagent's** `cwd`, attaching the child to a scope the parent never had. The second was found by writing the test, not by reading the code — the original test asserted the child would exist and it did, under the wrong scope.
- **The bash script validates its own action argument.** `handleHookPayload` routes an unknown action to the reflex path, which resolves — and can create — a primary, so a mis-wired argument would rotate the parent's session on every dispatch. `cortex-subagent.sh` dispatches only on `subagent-start`. Mutation-proven (M8).
- **The marker keys live in `src/scope/runtime.ts`, not in `transports/`.** They were written there first; `doctor` needs to read them and AD-1 forbids a query importing a transport. Moving them also put the write next to the session logic it describes, which Story 5.3 can reuse.
- **The observability row's obvious warn condition was wrong and would have misfired on day one.** "Child sessions exist but this never ran" warns immediately on every store with subagent history predating the feature — 40 children here, 16 in repo-c. That is the `command-outcomes` flap repeated. The row is therefore silent until the path fires once, and warns only when fires fall short of the children created **since** that first fire. An unwired event is `hook-wiring`'s job, and it fails on it by name.
- **The disposal question was answered with measurement, not assertion, and the answer is "not here".** An eventless ended session never leaves `getUnconsolidatedSessions`, and `inject-header` walks that set every SessionStart. Measured across all live stores: **1,428 of 1,952 sessions are already in that pool, 100% eventless, 0 children** — it is a pre-existing, general condition, not one children introduce. The loop costs **10.0 ms median for 953 sessions on the largest real store** against B-1's 150 ms, and a session row is **172 bytes** against B-8's 50 MB. A correct fix is general and would rewrite consolidation state for 1,428 existing rows on the SessionStart path — an unattended data change of exactly the shape Epic 4's rollout warns about. Recorded in `deferred-work.md` with the numbers and an owner; the lifecycle that *is* this story's (a child ends with its parent, or immediately if the parent already ended) is pinned by test. Also noted there, because the naive fix is wrong: `writeSessionSummary` inserts a `session_summary` **episode**, which projects into `memory_items`, so an "empty summary" would seed retrieval with empty items.
- **No schema change.** `SCHEMA_VERSION` stays **6**; both markers are `meta` rows, the same mechanism `cmd_outcome_scan` uses.
- **Two test fixtures had to be repaired, and one of them would have taken the whole file down.** `tests/doctor.test.ts`'s `TEMPLATE_BODIES` is a hand-written three-key record consumed over `HOOK_SCRIPTS`, so a fourth script made it `undefined` and every test in the file died inside `buildFixture()` — not a useful red. It now carries a stand-in plus an explicit guard that throws with a named message if a future script is missing one. `tests/cli.test.ts` had two hardcoded three-script loops and a hardcoded settings block; the loops now derive from `HOOK_SCRIPTS`, so the next script Cortex ships is not silently exempt from the install↔doctor round trip.
- **Correction to the story's own prose, made before implementing:** the story asserted `tests/doctor.test.ts` iterates `REQUIRED_WIRING`. It does not — line 14 is an import and line 30 is a `.find()`. `tests/install.test.ts` does iterate it, and does use the real shipped templates.
- **N-4 is untouched and asserted, not assumed.** `cortex-capture.sh` is unmodified, and a test fails if it ever mentions `subagent-start` or `SubagentStart`. The new hook spawns Node once per *dispatch*.
- **Open, and needing a ruling rather than a code change: `SubagentStart` has no budget.** B-4 covers the non-substituting `PostToolUse` path, B-4a `Read` substitution, B-1 the brief, B-3 queries, B-7 `doctor` — none of them this event. Measured p95 is **587.4 ms**, dominated by Node startup exactly as `reflect-pre` is, for a path that fires once per subagent (56 dispatches in four days here, against 4,881 captured commands), cannot block the subagent, and sits inside a host timeout of 60 s. The structural clause is built and CI-pinned; the wall-clock number is reported, not claimed met against a budget that does not exist. Logged as a sprint action item.

### File List

- `hooks/claude/cortex-subagent.sh` — added
- `src/transports/hook-entry.ts` — modified
- `src/scope/runtime.ts` — modified
- `src/query/doctor.ts` — modified
- `src/db/store.ts` — modified (review fix: `incrementMetaCounter`)
- `tests/install.test.ts` — modified (review fix: per-event de-duplication coverage)
- `tests/hook-entry.test.ts` — modified
- `tests/doctor.test.ts` — modified
- `tests/capture-hook.test.ts` — modified
- `tests/cli.test.ts` — modified
- `docs/invariants.md` — modified
- `README.md` — modified
- `CLAUDE.md` — modified
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified

### Change Log

| Date | Change |
| --- | --- |
| 2026-08-06 | Code review, three parallel layers. 12 findings fixed, 3 deferred with records, 2 dismissed, 1 put to the user as a ruling. Two HIGH defects, each found independently by two layers and each producing the same false alarm the observability row exists to prevent: the first-fire marker was stamped with a *reused* child's birthday (reproduced: 21 children swept into the window, verdict WARN), and the fire counter was a read-modify-write across hook processes (reproduced: two fires from 5 landed on 6, permanently). The fix for the second reintroduced the `parseInt` prefix trap through SQL and was caught by the suite mid-round. Also fixed: a new test that would have gone red on every fresh Windows checkout while guarding nothing, an action default that made a wiring `doctor` refuses actually work, an unguarded throw that could reach the turn, three structure tests hiding inside a `skipIf`, a ticked box claiming two assertions that did not exist, and a pool figure that was arithmetically impossible. Suite 1634 green, gate 9/9 at zero delta, doctor 19/19, mutation campaign **14/14 killed** after repairing two anchors that survived. Re-proven live post-fix: a subagent with `tool_uses: 0` left session `a88edf2cb30ba7287` with 0 events. |
| 2026-08-06 | Story implemented. `SubagentStart` is Cortex's sixth wired event: `cortex-subagent.sh` guards on engagement and its own action argument, then spawns Node once per dispatch to create the child session before the subagent does anything. Two silences that are the safety of the change — no `agent_id`, or no active primary, creates nothing. Observability via two `meta` markers and a conditional `doctor` row that stays silent until the path fires, so it cannot warn on pre-existing subagent history. No schema change. AC #2 pinned rather than rebuilt, mutation-checked against both halves of its filter. 32 tests added, suite 1623 green, gate 9/9 at zero delta, doctor 19/19, mutation campaign 10/10 killed. Budget measured at 587.4 ms p95 and reported — no budget covers this event; ruling logged as a sprint action item. Proven live: a subagent with `tool_uses: 0` now leaves a session, which was impossible before. Status → review. |
| 2026-08-06 | Story created against `a3e5d48`. Scope verified against Epic 0's shipped code before specifying: AC #2 already met and to be pinned rather than rebuilt, AC #3 half-inherited, AC #1 the real work. Host payload contract measured live with a real probe (four dispatches, two parallel same-type), settings restored byte-identically. Independent validation pass folded in: the `doctor.test.ts` fixture crash (`TEMPLATE_BODIES` is a hand-written three-key record consumed over `HOOK_SCRIPTS`), the disposal question for eventless child sessions (measured: 1,423 of 1,952 live sessions already permanently unconsolidated, 0 of 56 children — the row this story newly creates is exactly its advertised new capability), the day-one false warn in the observability row, the no-active-primary branch, the unfiltered session surfaces, and the `deferred-work.md` entries naming this story as owner. Status → ready-for-dev. |
