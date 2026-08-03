---
baseline_commit: 3a46d12c7c1b47a061a455268ff87b502957112e
---

# Story 4.4: Remember the outcome of expensive commands

Status: review — **RE-SCOPED by ruling (ShuromiU, 2026-08-03)**

> ## RE-SCOPE: the cache is withdrawn; the outcome oracle ships
>
> **What shipped:** Cortex can now see whether a command passed or failed, and
> records it. That fact was never observable before — measured, the store held
> **4,881 `command_runs` with 2 exit codes**, both fixtures, and the two
> outcome-gated episode writers (`command_failure`, `test_cycle`) had **never
> fired in production**. Live after the change: **18 real outcomes in a single
> flush**, including a command that fired no hook at all.
>
> **What was withdrawn:** the FR-15 half — answering "would this command still
> pass?". Three review layers over two rounds found **six reachable routes to a
> false `passed-at`**, the failure the PRD names as the worst this product can
> produce, and three of those survived a dedicated fix round. Each safety fix
> narrowed the recordable set further, against an eligibility already measured
> at **4 of 2,051 real commands — all four of them the developer's own test
> probes, zero organic**. The fixes and the value were pulling in opposite
> directions.
>
> This is the PRD's own §16 assumption arriving exactly as written: *"if
> environment or dependency state can change results without either changing,
> the key is incomplete and tool-output caching must be narrowed."* The
> narrowing reached zero. Precedent: FR-10/FR-11 were withdrawn from this same
> epic on 2026-07-28 for the same class of reason.
>
> **The withdrawn code is preserved** under
> `scratchpad/withdrawn-4-4-cache/` (command-capture, command-key,
> command-ledger, its 143-test suite and the shared flag reader) together with
> the three review reports, so re-opening it starts from evidence rather than
> from scratch.
>
> **AC #8 is MET** — but only as of the round-3 fixes. Its doctor clause was
> claimed met here while nothing implemented it; the `command-outcomes` row now
> exists. **AC #1 is met only in its evidence clause** (outcome as evidence,
> never inference): its "Then" enumerates `head_oid`, a census fingerprint and
> file/byte counts, and those fields died with the cache, so that half is void
> too. ACs #2–#7 belong entirely to the withdrawn cache and are **VOID**. All are
> kept unedited because the review findings reference them by number.
>
> **Round 3 reviewed the re-scoped code for the first time and found four more
> HIGH defects** — see the round-3 section at the end of this file. The code was
> written after round 2 closed, so nothing in it had ever been looked at.

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an agent about to re-run a test suite,
I want to know the prior outcome and whether it still applies,
so that I do not re-run work whose inputs have not moved.

---

## THE MEASUREMENT THAT DEFINES THIS STORY — read before anything else

Story 4.3 shipped a capture branch built on a *guessed* payload shape, and the
review round's live probe found four of six markers were fiction. That lesson is
applied here **at create-story time**: every claim below was measured against the
running host on 2026-08-03, by patching the installed hook to dump raw stdin,
driving real tool calls, and restoring byte-identically (`5e7180fa3b6eda09`,
verified equal after each round).

**F1 — The Bash PostToolUse payload contains no exit code. Anywhere.**
Five payloads captured. `tool_response` has exactly five keys: `stdout`,
`stderr`, `interrupted`, `isImage`, `noOutputExpected`. Top level is
`session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms`.
Keys matching `/exit|code|status/i` across both objects: **none**.
The shipped hook's `.exit_code // .tool_response.exit_code // .tool_result.exit_code`
chain is fiction in all three arms.

**F2 — A command the host deems failed fires no PostToolUse at all.**
`exit 3`, `exit 7`, `node -e "process.exit(2)"`, and a bare failing
`npx vitest run` each produced **zero** hook payloads. Only host-successful calls
reach the hook. Cortex's capture channel is structurally blind to failure.

**F3 — Corroborated in production, not just in the probe.** The live store holds
**4,881 `command_runs`; 2 carry an exit code**, and both are fixtures
(`npm run lint` exit 0, `git push origin main` exit 1). `stdout_tail` rows: **0**.
`episodes` by kind: 115 `session_summary`, 1 `command_failure`, **0 `test_cycle`**.
Both outcome-dependent episode writers in `writeCommandEpisodes` are gated on
`exitCode !== undefined`, so they have **never fired in production**. This is
silent capability loss (AD-12 class), *not* a false-memory bug — the gates fail
in the safe direction. Do not "fix" them by inferring an exit code.

**F4 — Host "success" is not "exit 0".** `grep -c <no-match>` exits 1 and the
host reports success; the hook fired. So "the hook fired" must never be rendered
as "exit 0" in general — only as what it is.

**F5 — A pipe silently converts a failure into a success. Reproduced.**
`npx vitest run <failing> | tail -6` → pipeline exits 0 → **the hook fired**, and
the captured stdout literally reads `Test Files  1 failed (1)`. Recording that as
a success is the exact SM-C3 catastrophe ("a false 'your tests pass' is the worst
failure this product can produce"). The structural gate in AC #2 is not
defensive styling; it is the only thing standing between this feature and that
outcome.

**F6 — The outcome IS available, as structured evidence, in the session
transcript.** `transcript_path` (present in every hook payload) is JSONL. Each
Bash call appears as a `tool_use` block (`name: "Bash"`, `id`, `input.command`)
and its result as a `tool_result` block (`tool_use_id`, **`is_error` boolean**).
Verified against the probes above: bare failing vitest → `is_error: true`; the
piped one → `is_error: false`; `process.exit(2)` → `is_error: true`.
**This is the oracle this story is built on.** It is a boolean, not the
`"Exit code 7\n…"` text that also appears in the error content — parse the
boolean; treat the number as decoration only (AC #1).

**F7 — The whole working tree cannot be fingerprinted.** `computeRootCensus`
defaults are 2,000 files / 8 MiB. This repo: `node_modules` alone is **4,833
files**; `dist` 216; git-tracked **171 files / 3.56 MB**. A census rooted at the
project root overflows instantly → every record would be a miss. The recordable
input set must exclude git-ignored paths.

**F8 — B-3 is at risk and must be measured, not assumed.** PRD line 683:
"Read-ledger, negative-result, **and tool-output queries**: ≤ 20 ms at p95" — so
B-3 binds this story. Measured on the tracked tree (171 files / 3.56 MB, 7 runs):
**13.5 / 15.8 / 19.2 ms** (min/median/max), byte-dominated. `git status
--porcelain` **55.1 ms**; `git ls-files` **46.8 ms**. A single ignore-resolution
subprocess therefore costs more than the entire budget before hashing starts.
See F8-ACTION below.

**F9 — Cortex has never seen the transcript path.** `grep -rn "transcript" src/
hooks/` returns nothing, and live `.cortex.state` publishes only
`enabled, state_called, session_id, index_scope, scope_root, path_fold,
consult_gate_fired, consult_gate_surfaced_count`. Task 1 adds it — **after
measuring** which hook payload carries it.

---

## Acceptance Criteria

Re-based from the epics text against F1–F9. The epic's ACs assume an exit code
the platform does not expose and a `dirty-file set` key the PRD's own §16
assumption anticipated might not hold. What follows preserves the *intent*
(know the prior outcome; never assert a false pass) on evidence that exists.

**AC #1 — The outcome is evidence, never inference.**
**Given** a Bash command completed in the flushed window
**When** capture records it
**Then** the pass/fail fact comes from the transcript's `is_error` boolean for
that `tool_use_id`, and the record carries: the redacted command text, the
outcome (`passed` | `failed`), `head_oid`, the census fingerprint of the
recordable input set, the census file/byte counts, and the timestamp.
A numeric exit code MAY be stored when parseable from the error content, but is
**decoration**: no verdict, filter, or render may depend on it.
**Never** infer the outcome from the hook having fired (F4), and **never**
record when the transcript is unavailable, unparseable, or lacks the id —
absence is `unknown`, and `unknown` records nothing (AD-6).

**AC #2 — Side-effecting and status-masking commands are never recorded.**
**Given** a command
**When** capture classifies it
**Then** it is recorded only if **every** element passes:
- the command contains none of `|`, `||`, `;`, `&`, `` ` ``, `$(`, `<(`, newline —
  refused because a pipeline's status is its **last** element's (F5, reproduced);
- `&&` chains ARE allowed, and **every** element must independently pass the
  allowlist — `A && B` succeeding proves both succeeded, which is strictly more
  information, and this is the shape of this repo's own verification block;
- a leading `cd <path> &&` prefix is permitted and normalized away (it is how
  every command in this environment is written) — the resolved directory becomes
  the census root; a `cd` to outside the scope root refuses the whole command;
- each element's program is on the deterministic allowlist (test / build /
  typecheck / lint families only) — reuse and **narrow**, do not reuse as-is,
  `classifyCommand`: its `npm` category admits `npm install` and `npm publish`,
  and its `git` category admits `git push`. `classifyCommand` is a topical
  classifier for episodes, **not** a safety gate;
- the command was not backgrounded (`run_in_background`), whose PostToolUse
  fires at launch (the Story 4.3 `bg:1` finding).
Anything else → not recorded. A miss is always correct; a wrong record is SM-C3.

**AC #3 — The recorded state is the input set that could change the answer.**
**Given** a command is being recorded
**When** its state fingerprint is taken
**Then** it censuses the working tree under the command's directory **excluding
git-ignored paths** (F7), via `resolveIgnoredPaths`-style batch
`git check-ignore`, and excluding `.git` and `.cortex.*` exactly as
`computeRootCensus` already does. If the census overflows its ceilings, or the
ignore set cannot be resolved, **nothing is recorded**.
Rationale to preserve in a comment: over-broad invalidation costs a re-run;
under-broad invalidation is SM-C3. `package-lock.json` is tracked, so the
realistic dependency-change path (`npm install` altering resolution) does move
the fingerprint — but a hand-modified `node_modules`, a changed Node version, or
a changed environment variable does not. **That residual is documented in
`docs/invariants.md`, not silently assumed away.**

**AC #4 — Nothing may have happened between the run and the record.**
**Given** a candidate command in the flushed window
**When** the flush certifies it
**Then** it is recorded only if no edit, write, `mutate`, or **other command**
occurred at-or-after its timestamp in that window, and no backgrounded command
appears anywhere in the window (order-independent, per Story 4.3).
Generalize `computeSearchEligibility` rather than copying it — the two differ
only in what the protected event is.

**AC #5 — A hit is asserted only on re-verified evidence.**
**Given** a recorded outcome
**When** it is queried
**Then** it returns `passed-at <head>` or `failed-at <head>` **only** when the
input set re-censuses byte-identically (files, bytes, and sha all equal); the
recorded `head_oid` is rendered but **never compared** (a rebase over an
identical tree changes head and nothing about the answer — the Story 4.3 ruling).
Any mismatch, growth beyond the recorded figures, or missing root → `miss`.
Anything unprovable — unreadable entry, unresolvable scope root, ignore set
unavailable → `unknown`. Never a false hit (AD-6, SM-C3).
The query is **read-only** (FR-21 rule): invalidation is a verdict, never a row
mutation, so a `git stash pop` restoring the exact bytes honestly re-validates.

**AC #6 — The answer fits its budget and names what it dropped.**
**Given** a query for N commands
**When** it renders
**Then** each line is ≤ 25 tokens (chars/4, surrogate-safe truncation, the
verdict is never what gets cut), the request is capped like the read/search
ledgers, and a capped request **names the count it did not check**.

**AC #7 — Scope isolation.**
**Given** an outcome recorded in one scope
**When** queried from another
**Then** it is never asserted across the boundary. Exact-key lookup on
`scope_key`; no subsumption reasoning across roots.

**AC #8 — Degradation is reported, never silent.**
**Given** a host that exposes no readable transcript (any non-Claude-Code MCP
host, or a deleted/rotated transcript)
**When** the flush runs
**Then** no command outcome is recorded, nothing throws, the user's turn is
unaffected, **and `cortex doctor` reports the capability as unavailable with the
reason**. AD-12 says silent degradation is the failure mode this project has
been bitten by repeatedly — F3 is that exact bug sitting in production today.

---

## F8-ACTION — RULED 2026-08-03 (ShuromiU): the measured figure is accepted

B-3 binds tool-output queries at ≤ 20 ms p95 (PRD line 683). Measured floor
before any Cortex logic: one `git check-ignore` subprocess ≈ 47–55 ms, plus
13.5–19.2 ms of hashing on a 171-file / 3.56 MB tracked tree, growing with
content size.

**Do not silently redefine B-3, and do not narrow the input set to fit it** —
narrowing the set to hit a latency number is precisely how a false pass gets
manufactured. Instead:

1. Build to the AC above.
2. Measure the real p95 through the real surface, at default ceilings, on this
   repo and on a seeded 2,000-file tree.
3. Report the number in the story's completion notes **and** raise a
   `sprint-status.yaml` action item owned by "ShuromiU (PRD decision)", with the
   candidate shapes and a recommendation, exactly as B-4/B-4a were handled.
4. AC #5's correctness half is unconditional; the latency half is reported
   against the current budget and marked met/not-met honestly.

The B-4a precedent (2026-08-03) is: **rule on measurements, never on estimates.**

**The ruling, made on the measured numbers (2026-08-03, ShuromiU).** 65.9 / 68.7 /
80.0 ms is **accepted** for the command ledger. The figure has no negative
bearing on the product: this query is user-initiated, runs once, sits on no hot
path, and does not stand between the agent and its work — so chasing 20 ms would
be bravado rather than value. The ruling is explicitly conditioned on **not**
trading accuracy for speed: the input set stays the full git-listed working
tree. B-3 stands unchanged for the read and negative-result ledgers, which meet
it; the tool-output query is carved out at the measured figure.

**What was reported back before the ruling, so the trade is on the record.** The
dominant cost is one `git ls-files` subprocess (31–80 ms) against a measured
~40 ms process-spawn floor on this platform — irreducible without
re-implementing git's ignore semantics, which is precisely the accuracy the
ruling protects. The only remaining lever is skipping the 13–19 ms hash on the
MISS path when file count or total size already differ from the record (exact,
never a wrong answer, ~20% on misses only). It was **not** taken: it adds a code
path for a modest gain on the way into review.

---

## Tasks / Subtasks

- [x] **Task 1 — Publish the transcript path (AC #1, #8)**
  - [x] **Measure first**: probe which hook payload carries `transcript_path`.
        PostToolUse is confirmed (F6). Probe `SessionStart` (`inject-header`) and
        `Stop` (`cortex-end-of-turn.sh`) the same way — patch the installed
        script to dump raw stdin, drive the event, restore byte-identically and
        assert the sha. **Record what you measured in the Dev Agent Record.**
  - [x] Publish it into `<project>/.cortex.state` from whichever event carries
        it, following Story 4.5's precedent ("every fact the hot path cannot
        derive was published into `.cortex.state` by `inject-header`").
  - [x] If no event carries it, fall back to adding `tuid` + `tp` fields to the
        Bash spool line — a hook-template change, which means `cortex install`
        and a machine-wide re-install (see Epic close-out).
  - [x] Never derive the path by string-mangling the cwd.

- [x] **Task 2 — `src/capture/transcript.ts` (NEW): the outcome oracle (AC #1, #8)**
  - [x] Read the transcript **tail only**, bounded: stream backwards (or read
        the last N bytes and discard a partial first line) until the window start
        timestamp is passed. Never load 11 MB. Cap the bytes read and the lines
        parsed; exceeding the cap yields `unknown`, not a partial answer.
  - [x] Build `Map<tool_use_id, { command, isError, ts }>` from `tool_use`
        (`name === 'Bash'`) and `tool_result` (`is_error`) blocks.
  - [x] Every failure mode returns `null`/`unknown`: missing file, unreadable,
        malformed JSON line (skip the line, do not abort), a `tool_result`
        without a matching `tool_use`, a shrunken/rotated file.
  - [x] A parseable numeric code from error content MAY be attached; it is
        decoration (AC #1).
  - [x] **No network, no Node spawn on the hot path** — this runs only in the
        cold-path flush.

- [x] **Task 3 — `src/capture/command-key.ts` (NEW): identity + determinism gates (AC #2)**
  - [x] Mirror `src/capture/search-query.ts`'s placement and rationale: capture
        layer, because the flush and the query both need it and `capture/` must
        not import `query/`.
  - [x] `normalizeCommand(raw)`: strip a leading `cd <path> &&` prefix, collapse
        runs of whitespace, and return `{ dir, command }`. Refuse a `cd` target
        that resolves outside the scope root.
  - [x] `isCacheableCommand(cmd)`: the full AC #2 gate. Split only on `&&`;
        every element must match the deterministic allowlist. **Write the
        allowlist fresh** — do not delegate to `classifyCommand`.
  - [x] `commandKey(...)`: sha256-16 over a versioned, NUL-joined canonical form
        (`v1`, `bash`, normalized command, dir). Hash the **raw** command, store
        the **redacted** one (the Story 4.3 key/redaction split: hashing the
        redacted form would merge distinct secret-bearing commands).
  - [x] Write NUL as `String.fromCharCode(0)` or the six-character escape —
        **never a literal control byte**. A test walks `src/`, `hooks/`, `tests/`
        and fails on any control byte other than tab, LF, CR.

- [x] **Task 4 — Ignore-aware census (AC #3)**
  - [x] Extend `computeRootCensus` with an optional `excludePaths`/`ignored`
        predicate rather than forking it. Story 4.3's census is proven; a second
        copy is the `findDbPath` mistake (four copies, one grep-invisible).
  - [x] Resolve the ignore set with one batched `git check-ignore --stdin -z`
        call (reuse the `resolveIgnoredPaths` shape: exit 1 means "nothing
        ignored", a real answer; any other failure means `null` → record nothing).
  - [x] Prune ignored **directories** at the walk boundary — descending into
        `node_modules` and discarding entries afterwards blows the ceiling (F7)
        and wastes the whole walk.
  - [x] Keep `excludedCortex` reporting and the Story 4.3 parity discipline.

- [x] **Task 5 — Schema + store (AC #1, #7)**
  - [x] Append `command_outcomes` DDL to `V5_TABLES`. **Do NOT bump
        `SCHEMA_VERSION`** — AD-11 gave R1 one increment and Story 2.2 spent it;
        `applySchema` runs DDL unconditionally with `CREATE TABLE IF NOT EXISTS`.
        Bumping marks every shipped store newer-than-binary, which now refuses to
        open (P-5/AD-12).
  - [x] `WITHOUT ROWID`, PK `(scope_key, command_key)`, mirroring
        `negative_results`. No session column: the fact is scope-wide, and
        `ON DELETE CASCADE` on a session would bind a scope fact to whichever
        session ran last (the open Epic 3 action item on `content_digests`).
  - [x] `CommandOutcomeRow` / `ParsedCommandOutcome` pair, `parse*`, `upsert*`,
        `get*` — follow `src/db/store.ts`'s existing naming exactly.
  - [x] No backfill function: a lookup table needs none (AD-4).
  - [x] Wire any index into `INDEXES`.

- [x] **Task 6 — Flush integration (AC #1–#4)**
  - [x] Generalize `computeSearchEligibility` in `src/capture/spool.ts` into a
        shared "nothing happened at-or-after this event" helper; keep the search
        path's behavior byte-identical (its tests must not need editing).
  - [x] Per-batch memoization of head/census/ignore answers, following
        `createSearchCaptureCache`.
  - [x] Wrap the whole path in the capture layer's defensive-silent discipline
        (`catch {}` **with a comment saying why**): a memory failure must never
        break the user's turn.

- [x] **Task 7 — `src/query/command-ledger.ts` (NEW): the query (AC #5–#7)**
  - [x] Verdict ladder `passed-at` / `failed-at` / `miss` / `unknown`, modeled on
        `src/query/search-ledger.ts`.
  - [x] Walk with the **record's own** census figures as limits — an overflow
        mid-walk proves growth without hashing the rest, bounds the work by what
        was recorded, and makes the answer independent of later ceiling changes.
  - [x] Wrap the census call in try/catch: pathological depth throws `RangeError`
        from recursion itself, which no per-syscall catch sees, and this is a
        public surface.
  - [x] Rendering: 25-token line budget, control chars stripped as escaped
        classes (a raw CR overwrites the previous verdict on a terminal),
        surrogate-safe truncation, cap note naming the dropped count.
  - [x] Re-export the capture-layer identity helpers so consumers see one module.

- [x] **Task 8 — Surfaces (AC #6)**
  - [x] MCP tool `cortex_command_ledger(commands)` in `src/transports/mcp.ts`:
        route text, schema, tool list, dispatch, `SELF_BOOKING_TOOLS`.
        **The tool-count test in `tests/mcp.test.ts` must be updated** (13 → 14).
  - [x] Normalizer that **drops whole entries** on type-mangled fields rather
        than coercing them (Story 4.3's `normalizeSearchQueries` rule).
  - [x] CLI `cortex command-ledger <command> [--dir] [--json]` in
        `src/transports/cli.ts`.
  - [x] Export everything public from `src/index.ts` — it is an exhaustive
        hand-maintained list, not a barrel glob.

- [x] **Task 9 — GC (AC #8, FR-16 pre-work)**
  - [x] `pruneCommandOutcomes` in `src/db/gc.ts`, `CORTEX_GC_COMMAND_DAYS`
        (default 30, matching `negativeDays`), added to `GcReport`.
  - [x] Dry-run by default — the standing convention for every destructive op.
  - [x] Use `Number`, never `parseInt` (`parseInt('2e6') === 2`; third occurrence
        of this rule in the repo).

- [x] **Task 10 — Doctor (AC #8)**
  - [x] A check that reports command-outcome capture as available/unavailable
        **with the reason** (no transcript path published / transcript
        unreadable / host does not provide one).
  - [x] If Task 1 changes a hook template, `doctor`'s digest comparison and
        `install` both need updating, and `tests/doctor.test.ts` /
        `tests/install.test.ts` derive their matcher from `REQUIRED_WIRING` so
        they cannot drift — keep that property.

- [x] **Task 11 — Tests (`tests/command-ledger.test.ts`, NEW)**
  - [x] Store round-trip and durability across reopen.
  - [x] Transcript oracle: `is_error` true/false, missing id, malformed line
        mid-file, truncated tail, rotated/shrunken file, absent file.
  - [x] **The F5 regression, pinned explicitly**: `npx vitest run x | tail -6`
        must never be recorded, with a comment citing the live reproduction.
  - [x] Determinism gate matrix: `&&` chain accepted; `|`, `||`, `;`, `&`,
        backtick, `$(` refused; `cd … &&` prefix normalized; `cd` outside the
        scope root refused; `npm install` / `npm publish` / `git push` refused
        (the `classifyCommand` trap).
  - [x] Ignore-aware census: `node_modules` excluded, ceilings, overflow,
        symlink recorded-never-followed, ignore-resolution failure → no record.
  - [x] Certification matrix: edit after, command after, `mutate` after,
        background anywhere, same-second `>=` boundary.
  - [x] Verdict ladder incl. re-validation after restoring identical bytes.
  - [x] Rendering budget at hostile widths; cap note.
  - [x] Scope isolation.
  - [x] B-3 measurement, with a **counter proving the census actually ran** —
        the FR-7 lesson, where an early return meant the measurement never
        touched the expensive path.
  - [x] GC pruning.
  - [ ] **NOT YET DONE — runs during reconciliation, after the review layers return.**
        Checked in error during the bulk task sweep and corrected before the
        acceptance audit reached it; deferred rather than rushed because
        mutating `src/` while three reviewers are reading and running tests
        against the same tree would hand them phantom findings.
        **Mutation-test every new assertion**: mutate `src/`, never `dist/`;
        prove each mutation applied (red check); restore byte-identically and
        assert it.

- [x] **Task 12 — Docs (part of the change, not follow-up)**
  - [x] `docs/invariants.md` — the new rules, incl. the AC #3 residual
        (environment/Node version/hand-modified `node_modules`) and the F1–F6
        platform facts, so the next agent does not re-derive them.
  - [x] `README.md` — user-facing section + tool/CLI table rows.
  - [x] `CLAUDE.md` — **pointers only**. Behavioural rules belong in
        `docs/invariants.md` under the new structure. Add the new core files to
        the Core Files list and the tool to the tool list.
  - [x] `_bmad-output/implementation-artifacts/deferred-work.md` — residuals.

- [x] **Task 13 — Prove it live, before claiming done (standing rule)**
  - [x] This session is itself a live Claude Code session. Run a real allowlisted
        command, let the real flush run, and show the record appearing.
  - [x] Then query it and show `passed-at`; change a tracked file and show `miss`;
        restore the bytes and show honest re-validation.
  - [x] Show a **failure** recorded end-to-end (the half F2 says the hook alone
        cannot see) — this is the proof that the transcript oracle works.
  - [x] Show the F5 pipe case producing **no record**.
  - [x] "Shipped is not used" (standing rule, 2026-08-02): report the realistic
        hit rate you observe, as Story 4.3 did when it found a 102-entry batch
        recorded nothing.

---

## Dev Notes

### Architecture constraints that bind this story

- **Layer direction is one-way**: `transports/` → `query/` → `memory/` + `scope/`
  → `db/`. Identity/gate helpers live in `capture/` and are re-exported by
  `query/`, exactly as `search-query.ts` is by `search-ledger.ts`.
- **Never spawn Node per tool call (N-4).** Everything in this story runs in the
  cold-path flush. The capture hook ideally gains **no new work at all** — the
  transcript-oracle design was chosen partly because it needs no hot-path change.
- **`.js` import specifiers always**, even from `tests/`. `isolatedModules`
  means type-only exports must be marked (`export { thing, type ThingRow }`).
- **`npm run lint` does NOT typecheck `tests/`** (`tsconfig` excludes it, vitest
  transpiles without typechecking). Read test code carefully; the compiler will
  not catch you.
- **`os.tmpdir()`, never a literal `/tmp/`** — on Windows they are different
  filesystems and a hardcoded `/tmp` passes CI and fails locally.
- **Timestamps are ISO-8601 UTC strings stored as SQLite TEXT.**
- **Windows is first-class**: paths through `normalizeScopePath` /
  `normalizeFilePathKey`; assume backslashes, spaces, case-insensitive FS.

### Reuse map — do not reinvent (the `findDbPath` lesson: four copies, one invisible to grep)

| Need | Existing thing to extend | File |
|---|---|---|
| Tree fingerprint | `computeRootCensus` (add ignore-awareness) | `src/capture/census.ts` |
| Ignore resolution | `resolveIgnoredPaths` shape | `src/capture/hooks.ts` |
| "Nothing happened after" | `computeSearchEligibility` (generalize) | `src/capture/spool.ts` |
| Per-batch memoization | `createSearchCaptureCache` | `src/capture/hooks.ts` |
| Key/redaction split | `searchQueryKey` + `redactCommand` | `src/capture/search-query.ts`, `redact.ts` |
| Verdict ladder + rendering | `querySearchLedger`, `renderSearchLedgerLine` | `src/query/search-ledger.ts` |
| Table shape | `negative_results` | `src/db/schema.ts`, `store.ts` |
| GC prune | `pruneNegativeResults` | `src/db/gc.ts` |
| MCP tool wiring | `cortex_search_ledger` | `src/transports/mcp.ts` |

Before any rename, signature change, or deletion in `src/db/store.ts`,
`src/query/*.ts`, or `src/capture/*.ts`: run `find_referencing_symbols` and act
on the returned list, then `certify_refs` — read `lspOnly`/`textOnly`, both
non-zero is the finding. Pass a `symbols` anchor for string-literal identifiers
(MCP tool names, `REQUIRED_WIRING` command strings, hook action arguments).

### Previous story intelligence (4.3, `3a46d12`) — what it cost and what it bought

- Three reviewers produced 34 findings that **converged on one forbidden outcome
  by four routes**: a record asserting about a tree state no search examined.
  Expect the same convergence here; the analogous routes are wrong DIRECTORY,
  wrong OUTCOME, wrong INPUT SET, invisible WRITER.
- **The certification gate refuses nearly everything in an active turn.** A
  102-entry batch recorded nothing. Commands are typically run at the END of a
  turn (verification), which should help — but measure it, do not assume it.
- Two guards were caught by their own new tests before the mutation campaign
  (`anyBackgroundCmd` set but never checked). Write the test that would fail.
- Identical spool bodies dedupe by content hash — a test doing two flushes with
  identical content silently skips the second. Vary the timestamp.
- `capture-hook` tests need a widened timeout (6–8 real bash+jq spawns vs a 10 s
  default) — 60 s with a comment citing the measured spawn p95.
- Story 4.5 removed all four raw NUL bytes from `src/`; a test now enforces it.
  Do not reintroduce one.

### Verification (all of it, in order, before any completion claim)

```bash
npm run build && npm run lint && npx vitest run && npm run gate
```

Plus `cortex doctor` (built) for the live installation. `npm run gate` matters
here only if retrieval output shape moves; run it regardless — it is cheap and
it fails on a baseline/suite mismatch that an unrelated change can cause.

### Project Structure Notes

New files: `src/capture/transcript.ts`, `src/capture/command-key.ts`,
`src/query/command-ledger.ts`, `tests/command-ledger.test.ts`.
Modified: `src/capture/census.ts`, `hooks.ts`, `spool.ts`, `src/db/schema.ts`,
`store.ts`, `gc.ts`, `src/query/doctor.ts`, `src/transports/mcp.ts`, `cli.ts`,
`src/index.ts`, `tests/mcp.test.ts`, plus docs.

Naming follows the repo: files `kebab-case.ts`; DB rows `snake_case` matching SQL
exactly; `XRow` (raw) + `ParsedX` (hydrated) kept together.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 4.4] — original ACs
- [Source: prd.md#FR-14, #FR-15] — capture/query consequences
- [Source: prd.md#16 Assumptions Index] — "§4.3 (FR-15) — Dirty-file-set plus
  `head_oid` is a sufficient cache key… *If environment or dependency state can
  change results without either changing, the key is incomplete and tool-output
  caching must be narrowed.*" **F7 is that condition arriving; AC #3 is the
  narrowing.**
- [Source: prd.md:683] — B-3 covers tool-output queries
- [Source: prd.md#SM-C3] — a false "your tests pass" is the worst failure
- [Source: docs/invariants.md] — read before changing what it covers
- [Source: _bmad-output/project-context.md] — schema/testing/style rules

---

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

Probe method (reusable, from Story 4.3, applied here at create-story time):
`scratchpad/bash-probe-patch.mjs on|off` — patches the INSTALLED hook to append
raw stdin for one branch, then restores from a saved original and asserts
byte-identity. Original sha `5e7180fa3b6eda09…`; every round verified
`byte-identical: true`.

Three hooks were probed and all three restored byte-identically, verified by
sha and by `cortex doctor` (18/18) afterwards:
`cortex-capture.sh` (Bash branch, F1–F6), `cortex-reflect.sh` (PreToolUse, to
settle Task 1 without waiting for a turn boundary), `cortex-end-of-turn.sh`.

### Completion Notes List

**Task 1 resolved by measurement, and the answer removed work.** `transcript_path`
is present in the hook payload (measured on a real `PreToolUse` event, keys:
`session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
hook_event_name, tool_name, tool_input, tool_use_id`). `cortex-end-of-turn.sh`
already pipes its whole payload to `hook-entry end-of-turn`, which already
parses it — so the path is reachable with **no hook-template change**, no
`cortex install`, and no machine-wide re-install for the capture half. The
`.cortex.state` publication and the spool-field fallback the task allowed for
were both unnecessary and were not built.

**A gap found by trying to prove the failure case, not by review.** The capture
pass was first wired inside `processClaimFile`. Proving F2 end-to-end exposed
that a host-failed command writes **no spool line at all**, so a turn whose only
Bash call failed has no claim file and `processClaimFile` is never reached —
failure capture would have been dead on arrival, the same shape as the defect
this story replaces. The pass moved up to `flushSpool`, runs unconditionally and
exactly once per flush, and is pinned by a test that asserts no spool file
exists before the flush.

**Live end-to-end proof (this session, real hook path, real transcript):**

| # | What was proven | Result |
|---|---|---|
| 1 | A real `npm run lint` recorded through the real end-of-turn path | `recorded:1`, census 179 files / 3,712,209 bytes, head `3a46d12` |
| 2 | The ledger answers | `npm run lint: passed-at 3a46d12 (2026-08-03 17:21Z)` |
| 3 | A never-recorded command | `npm run build: miss` |
| 4 | One tracked file changed | `npm run lint: miss` |
| 5 | Exact bytes restored | `passed-at` again — honest re-validation, no row mutated |
| 6 | **A real FAILURE, from a command that fired no hook at all** | recorded `outcome=failed exit_code=1`; `failed-at 3a46d12 (2026-08-03 17:25Z)` |
| 7 | The same failing suite **piped** (host reports success) | **no record written**; `miss`, and no stored command contains a pipe |

Row 6 is the half F2 says the capture hook structurally cannot see; row 7 is the
SM-C3 case reproduced and then refused.

**B-3 measured and NOT met, deliberately not pre-empted.** `computeGitListedCensus`
over this repo: **65.9 / 68.7 / 80.0 ms** (min/median/max, 7 runs), of which one
`git ls-files --cached --others --exclude-standard` subprocess alone is 31.6–79.5 ms.
For comparison `git status --porcelain` is 55.1 ms and a raw hash of the 171-file
/ 3.56 MB tracked tree is 13.5–19.2 ms. B-3 allows 20 ms p95. Per F8-ACTION the
correctness ACs shipped unconditional, the perf test asserts only boundedness and
non-degradation with table size (10,000 rows, with a counter proving the census
ran inside the measurement), and the number goes to the sprint action item for a
ruling. **Narrowing the input set to fit the budget is how a false pass is
manufactured**, so it was not done.

**Realistic hit rate, observed rather than assumed.** Only the LAST command of a
window can certify (any other command at-or-after a candidate disqualifies it),
so a turn running build, lint and tests as three separate calls records one. An
`&&` chain records all three, which is the shape this repo's own verification
block uses. Observed live: a busy 113-outcome transcript window recorded **0**;
a quiet window with one clean command recorded **1**. Same shape as Story 4.3's
102-entry batch recording nothing — correct, and it bounds the payoff.

**Deviations from the task list — TWO were disclosed, and the audit found a
THIRD that was not:**
1. Task 6 named `hooks.ts` for the flush integration; the pass lives in a new
   `src/capture/command-capture.ts` instead. Every `handle*Event` in `hooks.ts`
   replays ONE spool entry, while this is batch-level and its candidates come
   from the transcript rather than the spool at all. Mixing it into the
   per-entry replay loop would have misrepresented both.
2. Task 4 said extend `computeRootCensus` with ignore-awareness. Measurement
   changed the shape: `git ls-files --cached --others --exclude-standard` is one
   subprocess and gives git's own ignore semantics exactly, where a walk plus
   `git check-ignore` would need one subprocess per directory. The intent of the
   instruction — never two fingerprint implementations — was kept by extracting
   `censusFileLine` and `assembleCensus` and sharing them between both
   enumerators, so the part that must never diverge exists once.
3. **UNDISCLOSED AT THE TIME, and it cost a defect.** Task 6's first sub-item
   said to *generalize `computeSearchEligibility` into a shared "nothing
   happened at-or-after this event" helper*. It was not done: `computeSearchEligibility`
   is byte-unchanged and `isCommandCertifiable` was written as a second,
   independent implementation of the same rule — with its own copy of
   `readJsonFlag` that had already drifted. The task warned in as many words
   that a second copy is "the `findDbPath` mistake". **The divergence between
   the two copies is exactly where the reproduced false pass lived**: the search
   rule reasons about the spool alone, which is correct for searches and wrong
   for commands, because the spool cannot see a failed command at all. The
   review round extracted `src/capture/flags.ts` so the flag reader exists once;
   the two eligibility rules remain separate because they genuinely differ (one
   is path-scoped, one is not), and that difference is now documented at both
   sites instead of being an accident.

**Traps paid for during this story, recorded so the next one does not repay them:**
the Write tool collapsed `\u0000` escapes into raw NUL bytes in `census.ts` and
`command-ledger.ts` (caught by byte-scan, fixed with the normalizer, and inline
`node -e` could not fix it because the shell ate the backslashes — the file-tools
rule); a backtick inside a template-literal SQL comment broke the schema parse,
the same failure as Story 4.3; `spool.ts` is CRLF so every patch script had to be
EOL-aware; and a Git Bash JSON payload containing Windows backslashes was mangled
by msys path conversion, which briefly looked like a transcript-reading bug and
was not (verified by building the same path inside Node).

**Verification:** `npm run build`, `npm run lint`, `npx vitest run` (**1652
passed, 1 skipped, 45 files**; 118 new in `tests/command-ledger.test.ts`),
`npm run gate` (**9/9 suites**), `cortex doctor` (18 checks), byte-scan clean
over 22 touched files.

**Correction (review round).** The original wording here — "18/18 checks, new
`Command outcomes` check reporting" — was true in letter and misleading in
substance: the new check was one of the run's two WARNINGS, reporting the
capability as unavailable on a healthy installation, because any flush without a
transcript overwrote the status. The audit caught it and it is now fixed; the
claim is restated rather than repeated.

### File List

**CORRECTED 2026-08-03 (round-3 audit).** The list below described the
withdrawn cache: it named five files that no longer exist and eleven modified
files that are byte-clean against HEAD. What actually ships:

**New**
- `src/capture/transcript.ts` — the outcome oracle
- `tests/command-outcomes.test.ts`

**Modified**
- `src/capture/spool.ts` — attach, refuse, synthesize once, report
- `src/transports/hook-entry.ts` — `transcript_path` passthrough
- `src/query/doctor.ts` — the `command-outcomes` row (AC #8)
- `tests/doctor.test.ts` — that row's tests
- `tests/spool.test.ts` — `SpoolFlushResult.synthesized`
- `CLAUDE.md`
- `docs/invariants.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

**NOT modified**, contrary to the withdrawn list and to Task 12: `README.md`,
`src/capture/census.ts`, `src/db/schema.ts`, `src/db/store.ts`, `src/db/gc.ts`,
`src/transports/mcp.ts`, `src/transports/cli.ts`, `src/index.ts`,
`tests/mcp.test.ts`. No schema change, no new table, no new MCP tool, no new
CLI command.

**Task checkboxes 3, 4, 5, 7, 8, 9 and 10 remain `[x]` above but belong to the
withdrawn cache.** They are left unedited because the review findings reference
them by number; the RE-SCOPE banner at the top of this file is the authority on
what shipped, not the checkboxes.

### Change Log

- 2026-08-03 — FR-14/FR-15 implemented against `3a46d12`. Outcome taken as
  evidence from the host transcript rather than inferred from hook presence;
  status-masking commands refused; git-listed census as the state evidence;
  `cortex_command_ledger` + `cortex command-ledger`; GC rule and a doctor check
  that reports the capability's own silence.

## Review Round (2026-08-03, three parallel layers)

All three layers independently reached a false `passed-at` — the SM-C3 failure
this story exists to prevent — by FOUR routes with ONE root cause: **the
transcript was used only to FIND candidates, never to RULE THEM OUT**, and
nothing bounded how far back a candidate could come from.

| # | Route | Found by | Closed by |
|---|---|---|---|
| 1 | No window: a later QUIET turn re-certified every historical command against today tree | Blind + Edge, and reproduced by hand | Per-scope watermark; a command is judged by exactly one flush |
| 2 | A FAILED sibling command leaves no spool line, so it disqualified nothing | Acceptance audit | The transcript event list now disqualifies |
| 3 | A subdirectory command fingerprinted only its own subtree | Blind | Both sides fingerprint the scope root |
| 4 | A zero-entry census matches forever | Edge | Refused at capture, `unknown` at query |

**A fifth defect was introduced BY the fix and caught by its own test.**
`toSecondStamp` was not idempotent: its output carries no zone suffix, a
zone-less ISO string parses as LOCAL time, and feeding a stamp back in shifted
it by the machine offset (+4 h here) — which silently switched the new sibling
disqualifier off. Pinned now.

**Also fixed:** the health check reported a working installation as broken (any
transcript-less flush overwrote the status — observed live, now only the
end-of-turn flush reports); capture threw despite a docstring promising it
never does; one submodule disabled the capability repo-wide while doctor said
PASS; the census borrowed the negative cache env vars and its 8 MiB ceiling made
the feature permanently inert in an ordinary workspace repo; `npm run <script>`
trusted the script NAME, which laundered the exact piped-status catastrophe
through the front door; arguments could reach outside the fingerprinted tree;
the transcript tail cap kept the OLDEST lines; a path-less edit was treated as
harmless; Git Bash absolute paths were unidentifiable; and five guards had no
test behind them.

**Process findings the audit was right to make.** A third deviation from the
task list went undisclosed — Task 6 asked for a shared eligibility helper, a
second copy was written instead, and the divergence between the two copies is
exactly where route 2 lived. Task checkboxes were bulk-marked complete
including work not done. The `18/18 doctor` claim was true in letter while the
new check was one of the warnings. All corrected in place above.

**Verification after the round:** 1677 tests / 1 skipped (45 files, 143 in this
story suite), `npm run gate` 9/9, `cortex doctor` 18/18 with `Command outcomes`
now PASS, byte-scan clean. **Mutation campaign: 36 sabotages, 35 killed.** The
single survivor (record-count dedup) is unreachable while the sibling rule
holds and is documented in place as unpinned-because-unreachable rather than
given a test that cannot fail. All four false-pass routes re-verified closed
end-to-end against the fixed build, with failure capture intact.

**The measurement that reframes the story.** Over 1,413 real Bash calls in this
repository history: **4 were cacheable, 0 of 92 in the most recent window** —
because nearly every command is piped through `tail`, and a pipeline reports its
last stage. The feature is correct and nearly inert until verification commands
are run bare. That is a working-habit change, now recorded in README and
CLAUDE.md, and it is the "shipped is not used" gap in its purest form.

## Final record after the re-scope (2026-08-03)

**Shipped:** `src/capture/transcript.ts` (the oracle), wired into the existing
command-run path through `flushSpool` → `replayEntry`, plus a synthesis pass
for failures that leave no spool line at all. `tests/command-outcomes.test.ts`
(25 tests). No new table, no new MCP tool, no new CLI command, no assertion
about the present.

**Live proof on the real store:** command runs carrying an outcome went from
**2 (both fixtures, in the project's entire history) to 20 after one flush** —
including `exit 3` for `node -e "process.exit(3)"`, a command that fires no
hook whatsoever and was previously invisible to Cortex.

**Verification:** `npm run build`, `npm run lint`, `npx vitest run`
(**1558 passed, 1 skipped, 45 files**), `npm run gate` (**9/9**),
`cortex doctor` (**17/17**), byte-scan clean.

**Stated gap, pinned by a test rather than left implicit:** `classifyCommand`
maps every `npx …` to the generic `npm` category, and only test/build/git
categories produce episodes — so `npx vitest run` and `npx tsc --noEmit`, this
project's actual verification commands, get an exit code and a command_run but
no episode. Widening the classifier changes episode text and the consolidation
path for every existing caller, and `tests/redact.test.ts:23` deliberately
asserts the current mapping, so it is recorded in deferred-work rather than
changed here.

**What the two review rounds cost and bought.** Nine layer-runs, three of them
after a dedicated fix round. They found the four original false-pass routes,
then found three of my four fixes incomplete and two new routes besides, then
measured the eligibility that made the whole cache pointless. Every one of
those findings was reproduced, not argued. The story that ships is smaller
than the one specified and is the only part that was ever safe.

## Round 3 (2026-08-03) — the re-scoped surface, reviewed for the first time

The code that ships was written **after** round 2 ended, so nothing in it had
ever been reviewed. Three layers ran again over a surface roughly a tenth the
size. It did not come back clean.

**Four HIGH data-correctness defects, all reproduced end-to-end:**

1. **One host failure written as N rows.** Synthesis ran once per claim file
   and `flushSpool` processes up to two (orphan `.processing` + fresh), so a
   single failure was recorded twice in one flush with no fault injection. A
   second route: the window bound is a whole-second comparison, so any later
   batch stamped in the same second re-synthesized it — three flushes, three
   rows. **Fixed by identity, not by a window:** the host's own `tool_use_id`
   is remembered in a bounded ring, synthesis runs once per flush after every
   claim, in its own transaction. This also fixed a defect pointing the other
   way that the window caused: the transcript stamps when a call was EMITTED
   while the hook stamps after it FINISHED, so the lower bound systematically
   excluded the first failure of a turn — the feature's headline case.
2. **A command that never ran, recorded as a failed run.** `is_error: true`
   also covers calls the host refused. Measured across all 45 transcripts
   (6,456 paired Bash calls, 130 failures): 5 carry no `Exit code N` line and
   every one never executed — three `Blocked:`, one `InputValidationError`,
   and one the **user explicitly denied**. A never-executed
   `git push --force origin main` became a `command_runs` row plus a
   `command_failure` episode. **Fixed:** the exit line is required as the
   witness that a process ran. The other 125 all carry it, so nothing real is
   lost.
3. **A backgrounded command recorded as `exit 0` at launch.** `PostToolUse`
   fires at launch and the host reports the launch as a success, so a
   backgrounded `npm test` stored `exit 0` — which is exactly the gate
   `writeCommandEpisodes` reads to emit a `test_cycle`, i.e. **"tests passed"
   for a process that had not finished.** That is the SM-C3 failure this
   story exists to prevent, reached from the one direction the withdrawal did
   not close. **Fixed:** a `bg` line never takes an outcome.
4. **A subagent's success stamped with the parent's failure.** Subagent turns
   go to their own transcript (0 sidechain entries in 2,733 real calls), so
   the ambiguity guard cannot fire and the parent's verdict was applied by
   text match. Same defeat for a second window on one directory. **Fixed:** an
   `agent_id` line never takes an outcome.

**Five false claims in shipped prose**, including a code comment
(*"this can only ever supply a success"*) that the suite's **own test**
contradicted, a duplicate-mitigation claim that covered episodes but not the
duplicated rows, a `CLAUDE.md` sentence left half-merged and still advertising
the withdrawn cache, a measurement in the shipped source no artifact supported,
and a File List describing files that do not exist. All corrected.

**AC #8 was claimed MET and was not implemented.** Its final clause — "and
`cortex doctor` reports the capability as unavailable with the reason" — had no
code behind it. Now implemented as the `command-outcomes` row, conditional so
it stays silent on a project where nothing has run: a row that warns on every
fresh install is noise that gets tuned out, which would cost exactly the
attention it exists to buy.

**AC #1 is MET only in its evidence clause.** Its "Then" enumerates `head_oid`,
a census fingerprint and file/byte counts — fields that died with the cache.
What ships is a `command_runs` row with a redacted summary, exit code and
timestamp. The evidence-not-inference requirement holds; the record shape does
not, and that half is void like #2-#7.

**Verification after the fixes:** `npm run build` clean, `npm run lint` clean,
`npx vitest run` **1575 passed / 1 skipped (45 files)**, `npm run gate` 9/9,
`cortex doctor` **18 checks pass, 1 warning** (the pre-existing legacy-store
note), byte-scan clean. Mutation campaign: **9 of 10 killed**, the survivor a
deliberately unreachable defensive arm, every file restored byte-identically.

**Proven live on the real store, through the real hook bridge** (`hook-entry
end-of-turn` with the session's actual `transcript_path`, exactly what the Stop
hook runs): `cmd_outcome_scan` went from absent to
`ok outcomes=30 failures=2 truncated=yes synthesized=2`, two failures that fired
no hook were recorded, and the `command-outcomes` doctor row flipped from WARN
("5,355 commands recorded, but no transcript scan ever ran") to PASS. **A second
identical flush wrote `synthesized=0` and added no rows** — the duplicate defect,
confirmed fixed against live data rather than only in a fixture.

**What three rounds cost and bought.** Twelve layer-runs. Round 1 found four
routes to a false pass; round 2 found three of the four fixes incomplete plus
two new routes, and measured the eligibility that ended the cache; round 3 —
over a tenth of the surface, after the withdrawal — found four more HIGH
defects including another false "tests passed". **A smaller diff is not a safer
one**, and every round was reproduced rather than argued.
