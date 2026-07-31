---
baseline_commit: 918dd1a
---

# Story 2.4: Install in one idempotent command

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a new user,
I want a single command to set Cortex up correctly,
So that the install cliff is not the adoption cliff.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.4 (lines 460-478). Do not reword, split, or extend. If one is wrong, flag it and say so rather than implementing around it.

1. **Given** a project with no Cortex configuration
   **When** the install command runs
   **Then** it writes hook scripts with correct placeholder substitutions, registers the MCP server, adds ignore entries, and runs the diagnostic.

2. **Given** Cortex is already installed and unmodified
   **When** the install command runs again
   **Then** the result is identical and it reports that nothing changed.

3. **Given** a hook script the user has modified
   **When** the install command would overwrite it
   **Then** it refuses without explicit confirmation.

### AC assessment — implementable, with one reading that has to be stated

**AC #3 needs a definition of "modified" that the code can actually establish, and the obvious one does not exist yet.** Story 2.3's stamp identifies *which template* a script came from, not whether it was edited afterwards — `deferred-work.md` records exactly this ("the stamp answers 'does this predate the shipped template', not 'has this been modified'"). So this story has to build the second test, and it can only reach three verdicts:

| Verdict | Established by | AC #3 treatment |
| --- | --- | --- |
| `unmodified` | stamp matches the current template **and** re-rendering that template with the paths recovered from the file reproduces it byte-for-byte | overwrite freely |
| `modified` | stamp matches, content differs | **refuse without confirmation** |
| `unknown` | no stamp, or a stamp from a template this build does not ship | see below |

`unknown` is the case the AC does not anticipate, and getting it wrong breaks Story 2.3. Every hook installed before 2.3 is unstamped, and `cortex doctor` prints **"Run `cortex install-hooks --claude`"** as the fix for exactly those. If install refuses on an unstamped script, the fix 2.3 prints stops working on the single most common installation in existence — a cross-story contradiction, not a safety win.

So `unknown` **backs the file up and overwrites, and says so.** Nothing is destroyed, the documented fix keeps working, and the user can diff the `.bak`. This is a deviation from the strictest reading of AC #3 and is recorded here rather than hidden: for `unknown` we cannot establish that the user modified anything, and treating "cannot prove innocent" as "guilty" would make the command useless for its main audience.

**AC #1's "registers the MCP server" means writing to a settings file the user owns.** That is the riskiest thing this story does and the constraint section below is mostly about it.

## The mechanism — read this before any code

### 1. `install-hooks` must keep working, by name

Eight fix strings in `src/query/doctor.ts` name `cortex install-hooks --claude`, and README documents it in four places. The new command is `cortex install`; `install-hooks` becomes an **alias for the same action**, not a separate code path and not a removal. Doctor's fix strings move to `cortex install`. Any test asserting the old string moves with them.

Renaming without the alias would leave 2.3's diagnostic naming a command that does not exist — the precise failure mode 2.3's own review flagged as "a named fix that is wrong is worse than a generic one".

### 2. Modification detection is a re-render, not a diff against the template

The installed file is the template with machine-specific absolute paths substituted, so comparing it to the template always differs. The check that works:

1. `extractBakedPaths(template, installed)` — Story 2.3 already recovers the substituted paths by anchoring on the template line each placeholder occupies.
2. Re-render the template with those recovered paths plus the stamp.
3. Compare to the installed bytes, line endings normalised.

Equal → this is exactly what the installer would have produced with these paths, so it is unmodified *whatever* the paths are. That last part matters: it means a user whose Node moved is still recognised as unmodified rather than as having edited the file.

Reuse `extractBakedPaths`. Do not write a second recovery routine — 2.3's review already caught one hand-rolled content pattern (`.jsonl` matching `.js`) in this exact area.

### 3. Writing a settings file the user owns

This is the part to be paranoid about. `~/.claude/settings.json` on the dev machine holds unrelated hooks, `mcpServers` for another project, `permissions`, plugin config, and `effortLevel`. Losing any of it is worse than not shipping the story.

Required properties, each one testable:

- **Merge, never replace.** Every key the installer does not own is preserved byte-equivalent. Write with `JSON.stringify(value, null, 2)`.
- **Refuse a file that does not parse.** Do not clobber it, do not treat it as empty. Report it the way `doctor` does and exit non-zero.
- **Idempotent at the value level.** Running twice must not append a second copy of a wiring entry. Match an existing Cortex entry by the same token discipline `commandSatisfiesWiring` uses (basename + action), not by string equality — the user may have reordered or re-quoted it.
- **Atomic.** Write to a temp file in the same directory and `rename` over the target. A half-written `settings.json` is a broken Claude Code.
- **Back up before the first modification**, `.bak` next to the file. Do not back up when nothing changes, or every no-op run churns a backup.
- **Do not touch `permissions`, plugins, or any other key.** Only `hooks` and `mcpServers`.

Formatting is not preserved — `JSON.stringify` reformats the whole document and drops comments. State it in the output and in the README rather than pretending otherwise; the `.bak` is the mitigation.

### 4. Scope

`--scope user` (default) writes `~/.claude/settings.json`. `--scope project` writes `<project>/.claude/settings.json` and registers MCP in `<project>/.mcp.json`, which is where a project-scoped registration belongs and where `doctor` already looks. Hook scripts go to `~/.claude/hooks` either way — they are machine-level files with absolute paths baked in.

### 5. Ignore entries

The six runtime artifacts `project-context.md` names as things that must never enter the app graph: `.cortex.db`, `.cortex.db-wal`, `.cortex.db-shm`, `.cortex.spool.jsonl`, `.cortex.state`, `.cortex.agent-used` (plus `.cortex.spool.jsonl.processing`). Appended to `<project>/.gitignore` **only if absent** — matched line-exact after trimming, so an existing `.cortex.db` entry is not duplicated. If `.gitignore` does not exist, create it. If a pattern is already covered by a broader glob the user wrote (`*.db`), a duplicate specific line is harmless and simpler than glob evaluation; do not try to be clever.

This repository's own `.gitignore` already carries five of them, which makes it a live idempotency fixture.

### 6. "Runs the diagnostic"

Call `runDoctor` at the end and render it through the same renderer `cortex doctor` uses. The install's exit code is the diagnostic's: install can succeed in every action it owns and still leave a broken installation (no `jq`, a Node that moved), and reporting success there would undo the point of Story 2.3.

## Tasks / Subtasks

1. **`src/query/install.ts`** — `planInstall(options)` returning a typed plan of per-action outcomes (`created` / `updated` / `unchanged` / `refused`), and `applyInstall(plan)`. Pure of rendering. Modification detection lives here, reusing `extractBakedPaths`.
2. **Settings merge helpers** — parse, merge `hooks` and `mcpServers`, detect an equivalent existing entry, serialise, atomic write, backup.
3. **`cortex install`** in `src/transports/cli.ts` with `--scope`, `--force`, `--dry-run`, `--json`; `.alias('install-hooks')`; keep `--claude`/`--codex`/`--dir` accepted so the documented invocation still parses.
4. **Retarget doctor's fix strings** to `cortex install`, and the README with them.
5. **Tests** (`tests/install.test.ts`, plus CLI coverage): every AC; byte-identical second run; a modified script refused; `--force` overriding it; an unstamped script backed up and overwritten; unrelated settings keys preserved; a malformed settings file refused; no duplicate wiring on re-run; ignore entries not duplicated; atomic write leaves no temp file; `--dry-run` writes nothing at all.
6. **Docs in the same commit** — `README.md` (install section, the formatting caveat, the `unknown` behaviour), `CLAUDE.md` (Expected Behavior + Core Files), `deferred-work.md`.

## Dev Notes

### Previous story intelligence

Story 2.3 needed a 25-defect repair round. Its through-lines apply directly here, and two are about this exact code:

- **`install-hooks` had zero test coverage before 2.3 and still has almost none.** This story is where it gets tested. The round-trip test 2.3 added is the only thing standing on it.
- **"A check may not assert a positive fact about a file it never opened."** The install analogue: do not report `unchanged` for a file you did not read, and do not report `installed` for a write you did not verify.
- **"A named fix that is wrong is worse than a generic one."** Every refusal this command emits must name the flag or the file that resolves it.
- **Test the property, not a proxy.** "Idempotent" is proven by capturing the bytes of every file the installer touches, running again, and asserting equality — not by asserting the command printed "nothing changed".
- **Fixtures must be adversarial, with preconditions pre-asserted.** A modification test that starts from a file the installer never wrote proves nothing; write it, assert it is detected as unmodified, *then* edit it.
- **Mutate `src/`, EOL-adaptive anchors, reject anchors matching more than once, prove every mutation applied.** 45/45 killed across 2.3's two campaigns; hold that bar.
- **Doc claims are code.** 2.3 shipped "creates nothing and changes nothing" while creating two files. Every sentence written here gets verified by running something.

### Constraints

- Layer direction: `transports/` → `query/` → `memory/` + `scope/` → `db/`. `install.ts` belongs in `query/` next to `doctor.ts`, and may import from it.
- **Every new public symbol goes into `src/index.ts`** — 2.3 forgot, and the review caught it. It is a hand-maintained list, not a glob.
- Import specifiers end in `.js`; temp dirs via `os.tmpdir()`; `npm run lint` does not typecheck `tests/`.
- **Tests must never write to the real `~/.claude`.** Sandbox `HOME`/`USERPROFILE`, the way 2.3's `withSandbox` helper does, and prefer injecting paths as options over relying on env.
- No schema change: `SCHEMA_VERSION` stays 5. AD-5 and AD-11 are not engaged.

### Expected gate impact: exactly zero

Nothing here touches retrieval, ranking or memory rendering. All 8 locked suites must show zero delta: `alternatives=237`, `budget=178`, `contested=117`, `kind-ordering=103`, `rename-moved=97`, `stale-label=164`, `stemming=93`, `superseded-history=192`.

### Verification

`npm run build && npm run lint && npx vitest run`, then `npm run gate`. Baseline to beat: 960 tests / 31 files green, 8 suites at zero delta.

Then the live check, which this story makes newly meaningful: run `cortex install` against a sandboxed HOME, then `cortex doctor` against it, and confirm a green report — the first time the two commands close the loop.

## Dev Agent Record

### Delivered

`cortex install` — hook scripts, hook wiring, MCP registration, ignore entries, then the diagnostic. `install-hooks` is an alias for the same action. `--scope`, `--force`, `--dry-run`, `--json`.

| File | Change |
| --- | --- |
| `src/query/install.ts` | new — `runInstall`, `installedMatchesTemplate`, `classifyInstalledScript`, `renderHookScript`, `mergeHookWiring`, `mergeMcpServer`, `mergeIgnoreEntries`, `writeFileAtomic` |
| `src/query/doctor.ts` | `REQUIRED_WIRING` exported and given per-event matchers; fix strings retargeted to `cortex install` |
| `src/transports/cli.ts` | `install` command with the `install-hooks` alias, `renderInstallResult` |
| `src/index.ts` | every new public symbol (the omission 2.3's review caught) |
| `tests/install.test.ts` | new — 39 tests |

**Tests 960 → 999 (32 files), lint clean, gate 8 suites at exact zero delta.**

The live loop closes: `cortex install` into a sandboxed HOME writes all five actions, a second run reports `unchanged=true` with byte-identical files, and `cortex doctor` then passes every check it can — wiring, matcher, scripts, substitution, currency, interpreter, jq, Node, MCP.

### The incident, and what it changed

**A test wrote to the real environment.** The Story 2.3 round-trip test called `install-hooks --dir <temp>` from the repository root. Aliasing that name to the full install silently widened its blast radius, so it ran against the developer's real `~/.claude` and this repository's `.gitignore` — which gained two lines. `settings.json` escaped only because the merge found every wiring already present; that is luck, not design.

Reverted the `.gitignore` write, and the test now sandboxes `HOME`/`USERPROFILE`/`PATH` and runs from a temp project. The general lesson is in the story constraints and is now enforced by construction: `runInstall` takes every path as an option, so the test suite never depends on the ambient environment.

This is also a real finding about the product, not only the test — it is logged in `deferred-work.md`.

### Three defects found by running it

1. **`defaultTemplateDir` used `new URL(...).pathname`**, which leaves paths percent-encoded — so a checkout under `C:\Claude Code\` resolved to a directory containing `%20` and every template read as missing. This is the exact bug 2.3 fixed in `doctor.ts` by switching to `fileURLToPath`, reintroduced by copying the older helper. Caught by the round-trip test.
2. **The ignore outcome was computed from `existsSync` *after* the write**, so a file this run created reported `updated`, and `--dry-run` disagreed with the real run. Same family as 2.3's "a check may not assert a positive fact about a file it never opened": an outcome must be read from state the action has not yet changed.
3. **Modification detection by re-render needed a mapping from recovered path to placeholder**, which is fragile in exactly the direction that matters — get it wrong and an untouched file reads as edited. Replaced with a single regex over the whole template, placeholders as capture groups and repeats as backreferences, which needs no mapping and additionally catches a script whose two Node references disagree.

### Mutation campaign

**22 mutations, 21 killed, 0 unapplied.** Both round-one survivors were real coverage gaps, and one of them guarded the contract with Story 2.3:

- `stamp-mismatch-treated-as-unmodified` — my tests covered the *unstamped* script but not the *stale-stamped* one. Without the guard, a hook from an older Cortex classifies as `modified`, so `cortex install` would refuse to perform the upgrade `cortex doctor` names it for. Test added for a script carrying a stamp that is not this build's.
- `sessionstart-command-not-quoted` — every fixture path was space-free. This repository lives at `C:\Claude Code\cortex` and Node at `C:\Program Files\nodejs`, so unquoted the shell splits the command and the hook never runs — while the wiring check still passes, because `inject-header` remains its own token. Test added that tokenizes the written command back to the two paths it was built from.

The remaining survivor is honest: `writeFileAtomic` replaced with a direct write leaves every assertion green, because atomicity is unobservable from a single process. Same class as the Story 2.2 IMMEDIATE-transaction item, logged with it rather than counted as a kill.

### Deviations

- **AC #3's `unknown` case is treated as back-up-and-overwrite, not refuse**, and the story says so before the code does. Every hook installed before 2.3 is unstamped, and `doctor` names this command as their fix; refusing would break the documented repair path for the most common installation there is. We cannot establish that the user modified anything, and treating "cannot prove innocent" as "guilty" would make the command useless for its main audience.
- **`install` does not create the store or engage Cortex.** AC #1 enumerates four actions and neither is among them, so a fresh project fails the diagnostic on `engagement` and `database`. Rather than widen scope silently, the command names the reason and the one-line fix. Flagged for a product decision in `deferred-work.md`.

## Senior Developer Review (AI)

Three parallel layers against `918dd1a..3c85a0b`. All three completed and each independently reproduced the verification baseline first — build, lint, 999 tests, 8 suites at the declared token counts — so **nothing below was caught by any verification command**. ~25 distinct findings after dedup; all repaired.

### The story's own purpose was broken in three places

**1. `install` could not repair anything.** `commandSatisfiesWiring` answers "is something here", never "is what is here correct", and the merge only ever *appended* when nothing matched. So a `PostToolUse` matcher that had lost `Agent` — the pre-Story-0.2 value — was left exactly as it was while the run reported `settings: updated`. Two layers found it independently; I reproduced it:

```
matcher after install: "Read|Edit|Write|Bash"
doctor's fix:          …or run `cortex install`, which writes it.
```

That fix string is one I wrote **in this story**, and the README carried the same claim. It is precisely the "a named fix that is wrong is worse than a generic one" rule from 2.3's review, broken one story later in the command the fix names. Same root cause left a `SessionStart` command naming a moved Node unrepaired, producing a permanent exit 1 whose named fix is the command itself.

Now: matcher and command are rewritten in place, and a second run converges to `unchanged`.

**2. Idempotency was per-file; Claude Code merges three.** A wiring already present in `settings.local.json` did not stop install writing another into `~/.claude/settings.json`. Both fire — double spool lines, double reflex, double flush — and `doctor` reports all-pass. The module docstring named this exact hazard and then guarded one file only. The merge now reads all three.

**3. AC #3 had a hole the size of the AC.** Captures were `([^\n]+?)` with no content restriction, so any edit leaving the surrounding literal text intact classified as `unmodified` — and `unmodified` overwrote **with no backup**. Verified by closing the quote inside the placeholder slot, adding a command, and reopening it:

```
cortex-capture.sh   matches=true  verdict=unmodified  outcome=updated  backup=false
```

The README said the opposite in as many words. Exposure was uneven and therefore hard to reason about: `cortex-reflect.sh` was safe only because it repeats `__CORTEX_NODE__`, so the backreference forced agreement. Fixed by excluding `"` from the capture — those placeholders always sit inside double-quoted strings — and by keeping a `.bak` on **every** overwrite of existing content, not only the `unknown` and `--force` paths.

### Three more that would have shipped broken installs

- **CRLF hook scripts, structurally invisible.** No `.gitattributes`, so a Windows checkout has CRLF templates; the renderer preserved them while every validator normalises before comparing. Measured: a script written with 70 CR bytes and reported fully current. Git Bash tolerates it, bash on Linux/macOS/WSL does not, and 2.3 added `hooks/` to `package.json` `files`, so `npm pack` from Windows published it. Now written LF.
- **`--codex` rewrote Claude Code's settings** to run its hooks out of `~/.codex/hooks`, because it redirected only the hooks directory while scope stayed `user`. Now refused with an explanation.
- **Shell metacharacters were interpolated unescaped.** Double quotes do not protect `$` or a backtick, so a hooks directory containing one produced a wiring that resolves elsewhere — while `doctor` reports it healthy, because it reads the literal string and finds the file at the literal path. `$(...)` would execute on every hook fire. Refused rather than escaped, because escaping correctly requires knowing which shell the host uses.

### And the reporting lied in four ways

An unguarded throw left a half-done install printing a bare errno with no path, under a summary claiming nothing was left half-done · `--dry-run` reported a `.bak` it had not written · the settings detail printed `REQUIRED_WIRING.length` unconditionally, so a run that wired one event said "wired 5 events" and a run that wired none said the same · `--json` exited 1 carrying `refusals: 0` and no diagnostic anywhere, for the one consumer that cannot read the table.

Also fixed: `--scope` typos silently fell back to `user`; `--dir` did not expand `~`; `cliEntry`/`hookEntry` defaulted to `''`, producing an install that skipped `SessionStart` silently and then **refused its own output** on the next run; a `.gitignore` created from nothing began with a blank line; the renderer was misaligned by one column; and three places in `CLAUDE.md` and `doctor.ts` still described the printed JSON snippet this story deleted.

### The test gap that let all of it through

**There was no CLI-level test for `install` at all.** A reviewer found 10 of 11 targeted mutations surviving there — including the story's own §6 contract that the exit code follows the diagnostic. Five findings lived in that gap and three more in the install→doctor composition the story is named for. The `.gitignore` test was also tautological: iterating `IGNORE_ENTRIES` and asserting each is present cannot fail for a missing entry, because it loops over the same constant the code used.

Added: CLI coverage for exit-code composition, `--scope`, `--codex`, `--json`, `--dry-run`, the renderer, and a home directory containing a space; and the ignore list pinned as a literal.

### Verification after repair

**1032 tests / 32 files green** (999 → 1032). Lint clean. Gate: 8 suites, exact zero delta. All four probes that proved the original findings now show the repaired behaviour.

**Repair mutation campaign: 26 mutations, 26 killed, 0 unapplied.** The single round-one survivor was the defensive half of a real fix — two placeholder regexes that must agree — and killing it needed a template with *adjacent* placeholders, which is the only shape where the broader pattern is reachable. My first attempt at that test did not reproduce the shape and the mutation survived again; the second did.

### Claims the reviewers confirmed

AC #2's byte-identity is genuinely proven, not proxied — one layer re-ran it and extended it to project scope, which my tests had not covered. `REQUIRED_WIRING` is a single declaration consumed by both commands, certified. All 16 public symbols reach `src/index.ts`. `renderHookScript` is the only substitution site. The 2.3 test that wrote the real environment is genuinely sandboxed. The `atomic-write-is-direct` survivor was independently judged honest.
