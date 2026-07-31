---
baseline_commit: bc1bab7
---

# Story 2.3: Diagnose the installation

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user whose Cortex silently stopped working,
I want a command that tells me why,
So that a broken hook does not masquerade as an empty memory.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.3 (lines 430-458). Do not reword, split, or extend. If one is wrong, stop and say so rather than implementing around it.

1. **Given** a project with Cortex installed
   **When** the diagnostic runs
   **Then** it checks and reports engagement state, hook script presence, placeholder substitution, hook version currency, `jq` availability, Node resolution, database reachability and schema version, spool size and staleness, and MCP server registration.

2. **Given** an installed hook script that is syntactically valid and correctly substituted but predates the template shipped by the running build
   **When** the diagnostic runs
   **Then** it reports the hook as out of date, names re-running the install command as the fix, and exits non-zero
   **And** this holds even though nothing about the stale hook is otherwise broken (Observation 2 — this criterion is what makes Epic 2 the owner of that risk).

3. **Given** any check fails
   **When** the report is rendered
   **Then** the failing check names the specific fix
   **And** the command exits non-zero so it can gate CI.

4. **Given** all checks pass
   **When** the diagnostic runs
   **Then** it completes within 3 seconds (B-7) and exits zero.

5. **Given** the diagnostic runs on Windows under Git Bash
   **When** it checks hook execution
   **Then** it verifies the actual configured interpreter path rather than assuming a POSIX default (N-6).

### AC assessment — all five are implementable as written

No AC defects. Two need a stated reading before code, and both readings are recorded here so the review can hold them:

- **AC #1's "hook script presence"** is read as covering *both* halves: the script exists on disk, **and** it is actually wired into a settings file. A script sitting unreferenced in `~/.claude/hooks` is precisely a Cortex that "silently stopped working" — the story's own premise sentence. Diagnosing only the on-disk half would pass an installation where the wiring was never merged, which is the single most likely way a new user lands here.
- **AC #3's "exits non-zero so it can gate CI"** forces a two-level severity model. Some conditions are deliberate user choices (`cortex_disengage` sets `enabled=false`), and exiting non-zero on those would make the command useless in CI — it would always fail. So: `fail` sets exit 1, `warn` does not. AC #2 settles the one case where the classification could be argued: a stale hook is explicitly a **fail**.

## The premise is live in this repository, right now

This story does not need a hypothetical. Measured on the dev machine at `bc1bab7`, against `~/.claude/hooks`:

| Script | Template | Installed | Placeholders left | Agent-identity block |
| --- | --- | --- | --- | --- |
| `cortex-capture.sh` | 69 lines | **56 lines** | 0 | **absent** |
| `cortex-reflect.sh` | 21 lines | 21 lines | 0 | n/a |
| `cortex-end-of-turn.sh` | 22 lines | 22 lines | 0 | n/a |

The installed `cortex-capture.sh` **predates Story 0.2**. It is syntactically valid, correctly substituted, executable, and wired — and it has been writing every subagent tool call to the primary session for the entire life of Epics 1 and 2, silently. That is AC #2's scenario verbatim, and it is the *current state of the machine this story is being written on*.

`README.md:142` already documents the symptom and the fix ("If you upgraded the package but subagent activity still lands on the parent, your installed `cortex-capture.sh` predates the change — re-run `cortex install-hooks --claude`"). What has never existed is any way to **detect** it. That detection is this story.

Consequence for the dev: when `cortex doctor` first runs after this story lands, it **must** report the local install as out of date. If it reports clean, the implementation is wrong. Pin that as an integration expectation, not a hope.

## The mechanism — read this before any code

### 1. Currency needs a stamp, because "compare the file" cannot work

The installed script is the template with three placeholders substituted for machine-specific absolute paths. Comparing installed bytes to template bytes always differs; reverse-substituting the concrete paths back into placeholders is guesswork that breaks the moment a path contains a substring of another.

So the installer **stamps** what it installed. Each template gains one line:

```sh
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
```

`install-hooks` substitutes it with a digest of the template's own bytes (placeholders intact, line endings normalised to `\n` first). `doctor` recomputes the digest from the template shipped by the running build and compares. Equal → current. Different → stale. **Absent → stale**, which is the case that matters: every hook installed before this story has no stamp, and every one of them genuinely does predate the current template.

Normalise `\r\n` → `\n` before hashing. Working files in this repo are CRLF and templates are checked out through git; without normalisation a fresh clone on a different `core.autocrlf` setting reports a false stale. False stale is the safe direction (the fix is idempotent) but it is still noise, and the normalisation is one line.

**Do not use a hand-maintained version number.** A number you must remember to bump fails in exactly the shape AC #2 describes — a hook that is stale while everything about it looks fine. The digest cannot be forgotten.

### 2. The database check must not open the database the normal way

`openCortexDb` → `ensureCortexSchema` → migrates the store and writes `schema_version = SCHEMA_VERSION` (`src/db/schema.ts:461-463`). A doctor that opens the DB that way **repairs the very thing it is checking** and can never report a version mismatch. `openDatabase` alone is no better: `new Database(path)` creates the file when missing, so "database reachable" would pass by creating an empty database next to a user who has none.

Required shape: `fs.existsSync` first, then a **read-only** connection (`{ readonly: true, fileMustExist: true }`), then `getSchemaVersion(db)` (`src/db/schema.ts:409`, already returns 0 when `meta` is absent). No pragmas that write — `journal_mode = WAL` on a readonly connection throws — so this cannot reuse `openDatabase`. Add a narrow `openDatabaseReadOnly` to `src/db/schema.ts`; opening databases belongs in `db/`, not `query/`.

This is the "assert instead of test" trap from the Epic 1 retro in its purest form: a check that passes because the checker fixed the problem is indistinguishable from a check that works.

### 3. N-6 is a real trap on this platform, not a theoretical one

Measured with Node on the dev machine:

```
node sees /usr/bin/bash            : false
node sees C:/Program Files/Git/usr/bin/bash.exe : true
```

`which bash` inside Git Bash returns `/usr/bin/bash`. Node resolves that against the drive root and finds nothing. So `fs.existsSync(interpreter)` — the obvious implementation — reports the interpreter **missing on the exact platform the user runs**, which is worse than not checking at all.

The configured command in the live settings is `bash ~/.claude/hooks/cortex-capture.sh`. Two things follow:

- The interpreter is the bare word `bash`, so it must be resolved **through PATH**, honouring `PATHEXT` on Windows (`.EXE` is what matches). Only an interpreter given as an absolute path is checked with `existsSync`.
- The script argument begins with `~`, which the shell expands and Node does not. Expand it against `os.homedir()` before any file check.

AC #5 says "verifies the actual configured interpreter path rather than assuming a POSIX default". Read that as the general rule for this whole command: **diagnose the configuration that exists, not the one the installer would have written.**

### 4. Resolve binaries on PATH; do not execute them

`jq` availability and interpreter resolution are both answered by locating the binary on `PATH`, not by spawning it. Three reasons, in order of weight:

1. **Testability.** A test can point `PATH` at a temp directory containing a fake `jq` and assert pass and fail deterministically. Executing needs a real binary and makes the negative case untestable.
2. **B-7.** `bash -c 'exit 0'` alone measured ~36 ms on this platform and a full hook invocation ~400 ms (deferred-work, Story 0.2 review). A spawn-free doctor makes the 3-second budget structural rather than tuned.
3. It does not execute arbitrary binaries found on a user's PATH while diagnosing.

State the limit honestly in the report and the docs: this resolves `jq` on PATH, it does not verify that `jq` runs. A present-but-broken `jq` is not detected.

### 5. Severity model

Three statuses. Only `fail` affects the exit code.

| Condition | Status | Reason |
| --- | --- | --- |
| `.cortex.state` absent | `fail` | SessionStart has never run here — the silent-breakage symptom |
| `.cortex.state` has `enabled=false` | `warn` | `cortex_disengage` is a supported choice, not a defect |
| Hook wired but script missing on disk | `fail` | |
| Hook script present but not wired in any settings file | `fail` | |
| Placeholder `__CORTEX_*__` left in an installed script | `fail` | |
| Stamp missing or mismatched | `fail` | AC #2 says non-zero, explicitly |
| `jq` not on PATH | `fail` | every hook script begins with a `jq` call |
| Interpreter not resolvable | `fail` | |
| Baked Node / CLI / hook-entry path missing | `fail` | |
| Database missing or unopenable | `fail` | |
| `schema_version` ≠ `SCHEMA_VERSION` | `fail` | |
| Spool ≥ 256 KiB | `fail` | the threshold flush is not running |
| Spool non-empty and older than 1 hour | `warn` | end-of-turn flush may simply not have fired yet |
| No `cortex` MCP server registered | `fail` | |

Every non-`pass` row carries a `fix` string naming the concrete command or edit (AC #3). A `fix` that says "check your configuration" fails the AC; it must name the thing to run.

### 6. Where the wiring and the registration actually live

Settings, in the order Claude Code merges them — scan every one that exists:

- `<project>/.claude/settings.json`
- `<project>/.claude/settings.local.json`
- `~/.claude/settings.json`

Hook commands sit at `.hooks.<Event>[].hooks[].command`. The five wirings to look for, keyed by a substring of the command:

| Event | Needle |
| --- | --- |
| `SessionStart` | `inject-header` |
| `PostToolUse` | `cortex-capture.sh` |
| `PreToolUse` | `cortex-reflect.sh reflect-pre` |
| `UserPromptSubmit` | `cortex-reflect.sh reflect-prompt` |
| `Stop` | `cortex-end-of-turn.sh` |

MCP registration, any of:

- `<project>/.mcp.json` → `mcpServers.cortex`
- `~/.claude/settings.json` → `mcpServers.cortex`
- `~/.claude.json` → `mcpServers.cortex`, and `projects[<cwd>].mcpServers.cortex`

Both live forms are in play on this machine and both must pass: the project `.mcp.json` uses `{"command": "cortex", "args": ["serve"]}` while `~/.claude/settings.json` uses an absolute `node.exe` plus an absolute `cli.js` path. Match on the server **key**, not on a command substring, or the first form is missed.

A malformed JSON settings file must be reported as its own finding, not crash the command and not be silently treated as absent — "your settings.json does not parse" is one of the most useful things this command can say.

### 7. `hooks/` is not published — a defect this story depends on

`package.json` has `"files": ["dist", "LICENSE", "README.md"]`. The hook templates live in `hooks/claude/` and are **not** in the published tarball, so on an `npm install -g cortex-memory` install `install-hooks` throws `ENOENT` and `doctor`'s currency check has nothing to compare against. Only a local checkout works today.

Flagging rather than silently absorbing: the one-word fix (`"hooks"` in `files`) is **in scope**, because AC #2 is unimplementable in a published install without it. Nothing else about packaging is in scope.

## Tasks / Subtasks

1. **Stamp the templates.** Add the `# cortex-hook-template: __CORTEX_TEMPLATE_ID__` line to all three scripts in `hooks/claude/`. Add `"hooks"` to `package.json` `files`.
2. **Teach `install-hooks` to substitute the stamp** (`src/transports/cli.ts`), and export the digest helper so `doctor` uses the same function — one implementation, not two that must agree.
3. **`openDatabaseReadOnly`** in `src/db/schema.ts`.
4. **`src/query/doctor.ts`** — settings discovery, wiring extraction, `~` expansion, PATH resolution with `PATHEXT`, and the ten checks. Pure of process spawning. Returns a typed report; renders nothing.
5. **`cortex doctor`** in `src/transports/cli.ts` — human table by default, `--json` byte-faithful, exit 1 on any `fail`. `--hooks-dir` to override discovery for tests.
6. **Tests** (`tests/doctor.test.ts` + `tests/cli.test.ts`): every check green and red; the AC #2 stale-stamp case end to end; the missing-stamp case; the N-6 case with a bare-word interpreter and a `~` path; malformed settings JSON; DB-not-migrated-by-the-doctor (open a v4 store, run doctor, reopen and assert the version was **not** rewritten); the pagination-analogue trap — a doctor run must not create `.cortex.db`, `.cortex.state`, or a session; timing under 3 s.
7. **Docs in the same commit** — `README.md` (a `cortex doctor` section under Claude Code Setup, plus the CLI list), `CLAUDE.md` (Expected Behavior + Core Files), `deferred-work.md` for anything found and not fixed.

## Dev Notes

### Previous story intelligence

Carried forward from Stories 2.1 and 2.2, both of which needed a repair round after review. Plan build → review → repair.

- **Test the property, do not assert it.** 2.1's pagination test asserted that pages *union* to the full set, which passed with the `rowid DESC` tiebreaker removed. The doctor's analogue: a test that asserts "exit code is non-zero" passes against a doctor that fails for the *wrong reason*. Assert the specific check id and status, not just the exit code.
- **Fixtures must be genuinely adversarial, with preconditions pre-asserted inside the test.** 2.2 shipped a broken central guarantee because its fixtures used `insertCommandRun` directly and therefore *could not* fail. The analogue here is sharp: a currency test that writes a stale stamp by hand must first assert that the *unstamped* file it started from was reported current, or it proves nothing about the comparison.
- **Enumerate surfaces, not call sites.** 2.1's mutation campaign never reached `renderMemoryInspection` and 12 of 15 text mutations survived round 1. `doctor` has two output surfaces (human table, `--json`) and an exit code. Prove the campaign reached all three.
- **Mutate `src/`, never `dist/`; use EOL-adaptive anchors; reject any anchor matching more than once**; prove every mutation applied.
- **Doc claims are code.** Every sentence written into `README.md`/`CLAUDE.md` gets verified the way an assertion does. Four false doc sentences were caught at or after commit in 2.1/2.2.

### Constraints

- Layer direction is one-way: `transports/` → `query/` → `memory/` + `scope/` → `db/`. `doctor.ts` lives in `query/`, alongside `validate-memory.ts` and `inspect.ts`, which are its siblings in intent (operator surfaces that rank nothing and budget nothing).
- **A diagnostic must not mutate what it diagnoses.** No session creation, no `ensureCortexSchema`, no engagement write, no spool flush, no `touchMemoryItems` — the same rule 2.1 established for `list-memory`/`inspect-memory`, and it binds harder here.
- Import specifiers end in `.js`. Temp dirs via `os.tmpdir()`, never a literal `/tmp` — Node's `/tmp` and Git Bash's `/tmp` are different directories on Windows.
- `npm run lint` does not typecheck `tests/`.
- No new `memory_items` kind and no schema table, so AD-5 and AD-11 are not engaged. `SCHEMA_VERSION` stays 5.

### Expected gate impact: exactly zero

This story touches no retrieval, no rendering of memory, no scoring. All 8 locked suites must show a zero delta: `alternatives=237`, `budget=178`, `contested=117`, `kind-ordering=103`, `rename-moved=97`, `stale-label=164`, `stemming=93`, `superseded-history=192`. Baselines are locked artifacts; regenerating one is never how a red gate goes green.

### Verification

`npm run build && npm run lint && npx vitest run`, then `npm run gate`. Baseline to beat: 879 tests / 30 files green, 8 suites at zero delta.

Then run the real thing: `node dist/transports/cli.js doctor` in this repository. It must report `cortex-capture.sh` out of date, name `cortex install-hooks --claude` as the fix, and exit non-zero.

## Dev Agent Record

### Delivered

`cortex doctor` — twelve checks, three severities, human table and `--json`, exit 1 on any `fail`.

| File | Change |
| --- | --- |
| `src/query/doctor.ts` | new — discovery, the twelve checks, `hookTemplateDigest`, `resolveExecutable`, `extractBakedPaths`, `commandSatisfiesWiring` |
| `src/db/schema.ts` | `openDatabaseReadOnly` |
| `src/transports/cli.ts` | `doctor` command, `renderDoctorReport`, stamp substitution in `install-hooks` |
| `hooks/claude/*.sh` | `# cortex-hook-template:` line in all three |
| `package.json` | `hooks` added to `files` |
| `tests/doctor.test.ts` | new — 47 tests |
| `tests/cli.test.ts` | doctor CLI surface, renderer, install-hooks round trip |

**Tests 879 → 932 (31 files), all green. Gate: 8 suites, exact zero delta.** Real run on this repo: ~305 ms against the 3-second budget, and it reports the local `cortex-capture.sh` out of date exactly as the story predicted.

### Three defects found by running it rather than by reasoning about it

1. **`.jsonl` contains `.js`.** The first baked-path extractor matched any quoted token containing `node` or `.js`, which caught `SPOOL="$CWD/.cortex.spool.jsonl"` and reported the spool file as a missing Node installation. Rewritten to anchor on the template line each placeholder occupies, so the extraction is exact rather than pattern-guessed. Pinned by a test that names the `.jsonl` case.
2. **The wiring check did not match the wiring `install-hooks` prints.** The needle `cortex-reflect.sh reflect-pre` is a raw substring; the installer's own snippet emits `bash "…/cortex-reflect.sh" reflect-pre` with the path quoted. A correct installation would have been reported as unwired forever. Now matched on tokens. Found by the round-trip test, which exists for exactly this class.
3. **Two output-fidelity bugs**: `PATHEXT` is uppercase so `bash.exe` was reported as `bash.EXE`, and a settings file spelling the hooks path with forward slashes produced a forward-slash `hooks_dir` on Windows. Both are paths a user copies out of the report.

### Mutation campaign

**25 mutations, 25 killed, 0 unapplied.** Source and hook templates mutated (never `dist/`), EOL-adaptive anchors, every anchor required to match exactly once. Surfaces covered deliberately after 2.1's campaign missed `renderMemoryInspection`: the report object, the rendered table, the `--json` payload, the exit code, and the shipped `.sh` templates.

One survivor in round 1 — `if (!fs.existsSync(dbPath))` → `if (false)` — and it was a real weak assertion, not an equivalent mutant. `openDatabaseReadOnly` has `fileMustExist`, so the mutated code still failed and still created nothing; the test asserted only status and absence, so both paths satisfied it. But the two paths name **different fixes**, and telling someone with no store to check file permissions is a wrong answer that still exits non-zero. Assertion strengthened to pin the diagnosis and the fix; mutation re-run and killed.

### Deviations

- **AC #1 read as covering wiring, not only presence.** A script sitting unreferenced in `~/.claude/hooks` is the story's own premise sentence, so `hook-wiring` is a check of its own. Recorded in the story's AC assessment before implementation.
- **Two checks beyond the AC list**: `settings` (a settings file that does not parse is reported, not silently skipped) and `hook-interpreter` (AC #5's requirement, which needed a check to live in).
- **`package.json` `files` gained `hooks`** — flagged in the story as a defect AC #2 depends on, not silently absorbed. Without it the templates are absent from the published tarball and the currency check has nothing to compare against.

### Not done, and why

Four items in `deferred-work.md`: Codex wiring is not diagnosed; `install-hooks` still bakes paths without verifying them (Story 2.4 owns install correctness); hooks-directory discovery takes the first wired command; and the stamp answers "does this predate the shipped template", not "has the user modified this" — Story 2.4's AC #3 needs the second and will need content comparison.

## Senior Developer Review (AI)

Three parallel layers against `bc1bab7..bba4399`. All three completed; **~22 distinct findings after dedup, 25 patched, 1 dismissed.** Every layer independently ran the full verification suite and reproduced the story's numbers, so nothing below is caught by build, lint, tests or gate.

Two findings arrived from more than one layer independently — the WAL sidecars and the wiring/presence gap. Those two are also the most consequential.

### The three that mattered

**1. The central non-mutation claim was false.** `openDatabaseReadOnly` uses `readonly: true`, which prevents *content* writes — not sidecar creation. Reading a WAL database materialises `-shm` and `-wal`, measured `['.cortex.db']` → `['.cortex.db', '.cortex.db-shm', '.cortex.db-wal']`. README, CLAUDE.md and the module docstring all asserted otherwise.

The test hole is the story's own trap, repeated: the non-mutation test ran only against a project with **no store**, so the single code path that writes was the one path it never executed. Same shape as FR-4's "test against the refresh, not the write", which this story file quotes.

Fixed by telling the truth rather than by hiding it. Opening `immutable=1` would avoid the sidecars and read past the WAL — risking a stale `schema_version`, a wrong answer instead of a tidy one. The docs now state the exception and why; the test asserts the real sidecar set against a real WAL store, and a second test pins that the store's contents are unchanged.

**2. Wiring and presence never met on the same path.** Wiring matches a command by the script's **basename**; presence was checked only inside the directory derived from the *first* wired command. A hook wired to `/nonexistent/dir/cortex-end-of-turn.sh` reported `hook-wiring: PASS`, `hook-scripts: PASS`, `ok: true` — a green report for a hook that cannot run, contradicting this story's own severity table. Presence is now checked at every wired path.

**3. Three hooks gutted to `exit 0` passed everything that inspects them.** Only the stamp line is read from an installed script, so currency structurally cannot catch it, and `node` was graded `warn` when no path was baked at all — inverted, since no path is strictly worse than a missing one. Now: `extractBakedPaths` returning nothing for a script whose template contains `__CORTEX_NODE__` is the gutted-hook detector, and the no-path case is `fail`.

### AC #3 held; "specific" is weaker than "correct"

The Edge Case Hunter swept every reachable status combination and found **no non-passing check without a `fix`**. But four fixes were *present and wrong*, which the AC as written does not forbid:

- a store from a **newer** build was told to "run any `cortex` command to apply pending migrations" — the one action that rewrites `schema_version` **down**, destroying the evidence just reported;
- a corrupt store was blamed on file permissions;
- a template shipping without the stamp placeholder named a fix that is a no-op;
- a malformed `.mcp.json` was swallowed entirely, so a user whose registration sits inside the broken file was told to add one.

All four now name the correct action. Recorded as a gap in the AC, not a violation of it.

### Also fixed

`.cortex.state` as a directory threw `EISDIR` out of `runDoctor` and took the whole report with it · `hook-currency`/`hook-substitution` asserted positive facts about files that were never opened (two of AC #1's nine) · the `PostToolUse` matcher was never inspected, so a matcher missing `Agent` — the pre-0.2 value — reported "all 5 events wired", meaning the fix `doctor` prints could convert a detectable failure into an undetectable one · the SessionStart wiring's own Node and CLI paths were excluded, the exact case the README advertises · quoted `PATH` entries and an empty `PATHEXT` both resolved installed binaries to null · `~/.claude.json`'s project key was matched by exact string · `$CLAUDE_PROJECT_DIR` was not expanded · a spool mtime in the future produced a negative age · a directory at the spool path read as empty · `CORTEX_SPOOL_DIR` silently disabled the whole check · a wiring token with no directory reported `.` as the hooks directory · **every new public symbol was missing from `src/index.ts`**, which 2.1 and 2.2 both remembered.

### Dismissed (1)

`get_diagnostics_for_file` reports `Property 'replaceAll' does not exist` in both test files. `tsconfig.json` excludes `tests/`, so the language server falls back to a default `lib`; `target`/`lib` are `ES2022`, where `replaceAll` is valid, and it works at runtime. Not a defect — but worth knowing that this is the shape a *real* test-only type error would also take, since neither `npm run lint` nor vitest would report one.

### Verification after repair

**960 tests / 31 files green** (879 → 932 → 960). Lint clean. Gate: 8 suites, exact zero delta. Live run still reports the local install out of date and exits 1.

**Mutation campaigns: 45 mutations, 45 killed, 0 unapplied** (25 original + 20 over the repairs). Both repair-round survivors were real coverage gaps rather than equivalent mutants — the no-baked-path branch was reachable through the wiring the README documents but untested, and the `CORTEX_SPOOL_DIR` divergence warning I added had no test at all. Both closed, both mutations re-run and killed.
