# Cortex

**A trust, freshness, and economy layer for coding-agent memory.**

Agent memory is no longer hard to come by — as of 2026-08-01 Claude Code ships it on by default and other agents ship comparable features. What none of them tell you is whether the thing they just remembered is still true.

Cortex answers three questions a storage layer normally leaves open:

- **Trust — is this still what we decided?** Writing a note that opposes an active decision on the same subject marks *both* sides `[contested]` on every **retrieval** surface — recall, brief, state, the SessionStart brief and the reflex — the last two mattering most, since they inject a lone remembered item as settled context. (The operator listing `cortex list-memory` shows neither marker; `cortex inspect-memory` reports the contest in full.) Neither side is quietly retired until you close the contest with `cortex_resolve`. When a decision is genuinely superseded it cools one tier instead of vanishing, and carries a `(superseded)` label so it can never read as live.
- **Freshness — does this still describe the checkout?** File references in memory are validated against the working tree. A memory pointing at a deleted file is penalised in ranking and renders `[stale: missing …]` rather than disappearing; a renamed file resolves through a git rename map to `[moved: a.ts → b.ts]`. The penalty is graduated and capped so stale memory stays reachable, which means the **label** is the guarantee, not the rank.
- **Economy — what did remembering cost?** Every channel carries a token budget it actually spends rather than treats as advice: **150** for the session brief, **450** for `cortex_brief`, **600** for `cortex_recall`, **800** for `cortex_state`. Recall and the brief drop evidence from the bottom; `cortex_state` drops whole sections. Output size is gated retrospectively too — `npm run gate` fails CI on any *rise* in `output_tokens` against a locked baseline, so recall getting more expensive is a build failure rather than something noticed later. `cortex stats` reports injected/saved/net and a floored `saved/injected` ratio — for the most recent session and cumulatively for the scope — plus retrieval health (items by state, the count never retrieved, the ten most-retrieved), and books credit only against recorded evidence, so the savings figure is falsifiable rather than modeled.

Under all three: memory is scoped to a branch and a worktree, capture is ambient and costs no process per tool call, and the default lexical ranking is locked against reference baselines that CI re-checks on every push. (The optional `CORTEX_SEMANTIC_MODE=rank` path is off by default and is *not* covered by those baselines.)

> **`Saved:` now reports zero, and that is the honest number.** It used to read 657.6k at 93% efficiency, derived from a single estimate: the difference between a session summary and pasting every captured event into the context as raw JSON. No agent would ever have done that, so the credit was against an action that was never going to be taken — and the quantity was not a context-token saving in the first place, since captured events are internal and never injected. That credit is withdrawn. Credit is now written **only** with recorded evidence — the file and byte size of a read that genuinely did not happen — and the mechanism that produces it (verified read substitution) has not shipped yet. A falsifiable zero is worth more than an unfalsifiable 93%.

## How this compares

Competitors move, so each claim below carries how it was checked. Treat the specifics as dated and the axis of difference as the durable part.

**Native auto-memory** writes plain Markdown into a per-project directory and reads it back at session start. It is better than Cortex at three real things: nothing to install, files you can read and edit by hand, and no database to migrate or corrupt. If what you want is an agent that remembers your preferences across sessions, it is enough, and Cortex is not competing for that job.

Its limit is structural rather than a missing feature: **the project key is the working-directory path**, mangled — `~/.claude/projects/<key>/memory/`. *(Observed directly, 2026-08-01: one repository's main checkout and its linked worktrees each hold a separate key, and only the main checkout had a `memory/` directory at all. That establishes the namespaces are separate; nothing was written in a worktree to test whether main can read it back, so read this as "separate by construction", not as a measured isolation test.)* The branch consequence follows from the same fact and needs no measurement: the key is a path, and `git switch` does not change a path, so a decision recorded while on a feature branch is served back on `main` as if it had been settled there. There is no branch dimension to have.

**claude-mem** is the established third-party option and shares Cortex's shape — hooks capture activity, SQLite stores it. The difference is what happens between capture and recall: it compresses sessions with an LLM, where Cortex projects them deterministically. Compression buys better prose about *what happened*; determinism buys the ability to say *why* a given answer was returned, to reproduce it, and to gate it in CI. Which you want depends on whether you are reconstructing a session or trusting a decision. It is also the more established of the two by a wide margin, which is worth something concrete: more people have hit its edges before you do. *(This paragraph is second-hand — from a 2026-07-28 survey, not from running it. Corrections welcome.)*

### The six things that are unique here

Each is a behavior you can go and check, not a label:

1. **Branch and worktree scoping.** Every worktree of a repository shares one store — the store id is a hash of the **absolute realpath** of `git rev-parse --git-common-dir`, and the realpath step is load-bearing rather than tidy: the raw output is `.git` in a main worktree and an absolute path in a linked one, so only the resolved form is identical across them. Memory inside that store is partitioned by a scope key carrying the worktree path *and* the branch ref. Switching branches restores the matching snapshot. See [Data](#data).
2. **Subagent sessions.** A session is identified by `(scope_key, agent_id)`. A subagent's reads, edits and commands are filed under a child session recording its `parent_session_id` and `agent_type`, instead of being merged into the timeline of the agent that dispatched it — and a tool call *carrying an `agent_id`* never rotates or ends its parent's session, whatever its own working directory resolves to. That precondition is load-bearing: a hook installed before agent identity existed sends no `agent_id`, and those lines take the ordinary primary-session path, which does rotate on a scope change. `cortex doctor` reports such a hook as out of date. See [Subagent attribution](#subagent-attribution).
3. **Deterministic contradiction detection.** Contradictions are found by an offline lexical rule — an explicit polarity flip over demonstrably shared context — with no model in the loop, so the same two notes always produce the same verdict. The rules are deliberately strict, because a detector that cries wolf gets ignored. See [Contradiction detection](#contradiction-detection).
4. **Checkout freshness with rename resolution.** Memory is scored against the current file inventory, with a graduated and capped penalty so stale items stay reachable and labeled instead of buried, and renames resolve to `[moved:]` rather than counting as missing.
5. **Enforced budgets.** The numbers above are spent, not advisory targets a caller is trusted to honour. Two edges, stated because a budget with undisclosed exceptions is only a suggestion: `cortex_recall` never drops its top-ranked result, so one oversized result overruns the budget rather than returning nothing; and `cortex_state` *skips* an over-large section and keeps walking rather than stopping, so a lower-priority section can outlive a higher-priority one. Continuation lines are charged only after every affordable primary line is placed, so adding them cannot change which decisions you see at any budget.
6. **CI-gated retrieval quality.** Hermetic seeded suites are locked against reference results; `npm run gate` fails on a drop in `top1_hit` or `recall_at_3` or a rise in `output_tokens`, and CI runs it on every push. Suites can also assert on whole rendered surfaces — the SessionStart brief, `cortex header`, `cortex_state` — so a change that quietly stops marking a contested decision, or starts leaking a superseded one into the brief, fails the build instead of passing it. Regenerating a baseline requires a `Baseline-Regenerated:` trailer on the commit that does it. See [Retrieval Quality Gate](#retrieval-quality-gate).

## How it works

Cortex is retrieval-first and pull-based. It stores decisions, blockers, command outcomes, snapshots, and session summaries in a local SQLite database, captures activity ambiently through hooks, and surfaces *remembered content* in exactly two channels you did not ask for: a validated session brief at startup, and a short whisper when a high-confidence focus shift matches memory. Two other hooks speak unprompted but inject no memory — a one-line consult hint, at most once per session, and a turn-end nudge when a subagent ran and there are high-confidence notes worth saving. Everything else you ask for.

## Core Behavior

- `SessionStart` quietly enables capture with `cortex inject-header --quiet` and prints the validated session brief (or nothing on a cold start). The brief also names up to five files this branch has already read that are **still unchanged**, most-read first, so a resuming agent does not re-read them to orient itself — verified by re-hashing, and phrased about the files rather than the reader, because a fresh session did not read them.
- `cortex reflect` can emit short hook `additionalContext` on high-confidence focus shifts.
- Cortex now supports branch-scoped restore: switching branches restores the right snapshot.
- `cortex_route` / `cortex route` provide the cold-callable capability map.
- Deferred tool discovery should use callable-name discovery (`ToolSearch`/`tool_search` query `cortex_recall`, `cortex_state`, or `cortex_route`) or server-name bootstrap (`Cortex`). Canonical `select:mcp__cortex__...` selectors may return 0 on current Codex app-server builds and are not proof Cortex is unavailable.
- `cortex_recall(topic)` searches notes, summaries, snapshots, and command/episode memory; output is answer-shaped and budgeted (`budget`, `detail: 'scores'`).
- `cortex_brief(topic)` returns a smaller, agent-friendly subset (decisions first, budgeted).
- `cortex_state` shows current-session load-bearing notes first, then branch snapshots and the scored working set, within a budget (default 800 tokens).
- When that state is empty, `cortex_state` returns fallback guidance instead of an empty string.
- Note-backed outputs include compact UTC timestamps, for example `Decision [2026-06-06 05:18Z]: [auth] use OIDC`.
- Cortex tracks a lightweight current app graph for the active scope and validates file/path references extracted from memory; head changes feed a git rename map.
- Missing file references demote retrieved memories gently (graduated, capped penalty) and render as `[stale: missing ...]`; renamed files render as `[moved: a.ts → b.ts]`; historical queries can still surface them as history.
- Branch snapshot summaries and recent-session tails prefer notes and file/test/agent activity over raw command-only hook noise.
- touched and recalled memory stays hot; ignored memory decays out of the default state.
- resolved notes stay cold and do not trigger hook reflex whispers; `cortex_resolve` closes them out explicitly.
- The UserPromptSubmit hook may add a one-line consult hint at most once per session for memory-relevant prompts; calling `cortex_route`, `cortex_recall(topic)`, `cortex_state`, `cortex_brief`, `cortex_engage`, or topic-based `cortex_validate_memory` suppresses it.
- Prompt hooks do not inject memory facts from prompt text; edit and command reflexes still require high-confidence prior context.
- Optional semantic retrieval is controlled by `CORTEX_SEMANTIC_MODE=off|shadow|rank`; default is `off`.

## Install

From npm:

```bash
npm install -g cortex-memory
```

From a local checkout:

```bash
npm install -g .
```

## Claude Code Setup

You do not need a `CLAUDE.md` in every repo just to make Cortex available.

Global Claude settings are enough to:
- register the MCP server
- inject Cortex on session start
- log tool activity through hooks

Use `CLAUDE.md` only when you want to teach project-specific workflow conventions such as “write blocker notes aggressively” or “brief agents with `cortex_brief` before delegation.”

### MCP Server

Add Cortex to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "cortex",
      "args": ["serve"]
    }
  }
}
```

### SessionStart Hook

Run Cortex quietly at the start of every Claude session:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cortex inject-header --quiet"
          }
        ]
      }
    ]
  }
}
```

`cortex inject-header` now:
- consolidates old unconsolidated sessions
- refreshes branch/project state
- starts a scoped session
- auto-engages Cortex for the new session without dumping a large header

Use `cortex inject-header` without `--quiet` only when you explicitly want to print the larger branch-aware working-memory header.

### Capture, Reflex, and Stop Hooks

`cortex install` writes these for you — see [Installing in one command](#installing-in-one-command). The wiring it produces:

| Event | Matcher | Script | Cost |
|---|---|---|---|
| `PostToolUse` | `Read\|Edit\|Write\|Bash\|Agent` | `cortex-capture.sh` | spool append only — no Node spawn |
| `PreToolUse` | `Edit\|Write` | `cortex-reflect.sh reflect-pre` | Node only when engaged |
| `UserPromptSubmit` | | `cortex-reflect.sh reflect-prompt` | Node only when engaged |
| `Stop` | | `cortex-end-of-turn.sh` | one Node spawn per turn: spool flush + conditional nudge |

The spool (`.cortex.spool.jsonl`) is flushed at turn end, at a 256 KiB threshold (detached `cortex flush-spool`), and at the next session start — leftover lines are never lost.

### Subagent attribution

A session is identified by `(scope_key, agent_id)`. Each spool line carries the `agent_id` and `agent_type` the host reported, so the flush files a subagent's reads, edits and commands under a child session of its own — recording `parent_session_id` and inheriting the parent's scope — instead of merging them into the parent's timeline. A line without an `agent_id`, including every line written by a hook installed before this existed, resolves to the primary session. A subagent's tool call never rotates or ends the session that dispatched it, and ending a session ends its children so they stay reachable by consolidation and GC.

Branch snapshots, scoped session listings and the recent-session tail read primary sessions only; child timelines are reached explicitly. If you upgraded the package but subagent activity still lands on the parent, one of two things is stale: the installed `cortex-capture.sh` predates the change, or the `PostToolUse` matcher in your settings no longer lists `Agent`. `cortex doctor` reports both — the first as a failing hook-currency check, the second as a capture-matcher warning. Running `cortex install` fixes both — it rewrites the script and writes the matcher.

## Installing in one command

```bash
cortex install
```

Writes the three hook scripts with your Node and Cortex paths baked in, merges the hook wiring into `~/.claude/settings.json`, registers the MCP server, and adds Cortex's runtime artifacts to `.gitignore` — then runs `cortex doctor` and exits with its verdict. `cortex install-hooks` is the same command under its old name.

`--scope project` writes `<project>/.claude/settings.json` and registers the server in `<project>/.mcp.json` instead; an unrecognised scope is rejected rather than silently treated as `user`. `--dry-run` reports every outcome and writes nothing, and does not run the diagnostic — it has nothing to diagnose. `--json` emits the result for scripting, with the diagnostic embedded, so a scripted caller can see why a run exited non-zero.

**Running it again changes nothing.** Not "rewrites the same content" — an unchanged installation produces byte-identical files, so mtimes, backups and your settings formatting are all left alone, and it says `Nothing changed`.

What it will not do without being told:

- **A hook script you edited is refused, not overwritten.** Each installed script carries a digest of the template it came from, and Cortex re-matches the whole template against the file: if it is not exactly what the installer would have written — with any paths — it stops and names `--force`. With `--force`, your version is saved to `<script>.bak` first.
- **A script whose stamp is not this build's is backed up and replaced**, not refused. That covers anything installed before stamping existed, and anything from a different version. Refusing would break the repair path `cortex doctor` recommends. **Any** overwrite of an existing script keeps a `<script>.bak`, including the ordinary case where only the baked-in paths changed.
- **An existing `cortex` MCP registration is left alone.** It may point at a checkout you prefer.
- **A settings file that does not parse is refused, never clobbered.** Fix the JSON and re-run.
- **A wiring another settings file already provides is not duplicated.** Claude Code merges `<project>/.claude/settings.json`, `settings.local.json` and `~/.claude/settings.json`, so a second entry would not replace the first — both would fire.
- **A hooks directory containing `$`, a backtick or a backslash is refused.** Those are expanded by the shell inside the quoted wiring, so the hook would resolve somewhere else while still looking correct. Spaces are fine.

It does **repair** what it finds: a `PostToolUse` matcher that has lost `Agent`, or a `SessionStart` command naming a Node that moved, are rewritten in place rather than left alone. Detecting that something is wired is not the same as checking that the wiring is right.

Two things it does change that are worth knowing: your settings file is **reformatted** to two-space JSON, because it is parsed and re-serialised (comments do not survive — a `.bak` is written before the first modification), and everything Cortex writes lands via a temp file and a rename, so a half-written `settings.json` is not possible.

`cortex install` does not create the memory store or engage Cortex for the project — those happen on your first session, or immediately with `cortex inject-header --quiet`. Until then the diagnostic reports two failures for that reason and says so.

## Diagnosing the installation

```bash
cortex doctor
```

Cortex fails quietly. A hook that never fires, a `jq` that fell off `PATH`, a Node that moved — each of them produces an empty memory rather than an error, and an empty memory is indistinguishable from a project you have not worked in yet. `cortex doctor` is how you tell the difference.

It reports which settings files were readable, engagement state, hook wiring, the `PostToolUse` capture matcher, hook script presence, placeholder substitution, hook version currency, the configured interpreter, `jq`, the Node and CLI paths the wiring will invoke, database reachability and schema version, spool size and staleness, and MCP server registration. Every non-passing check names a specific fix — usually a command to run, sometimes an edit to make (a JSON syntax error, a missing binary). `--json` emits the same report for scripting.

Exit codes: **1 if any check fails, 0 otherwise** — so it can gate CI. Warnings do not fail the run; a project you deliberately disengaged with `cortex_disengage` warns and exits 0.

The check worth knowing about is **hook version currency**. A hook script installed by an older version stays syntactically valid, correctly substituted, and wired — it simply no longer does what the current build expects. Nothing about it looks broken. `cortex install` therefore stamps each installed script with a digest of the template it rendered, and `doctor` recompares that against the template the running build ships. A script with an older stamp, or with no stamp at all, is reported out of date with `cortex install` as the fix, and fails the run.

Two limits, stated rather than implied:

- `jq` and the hook interpreter are **located on `PATH`, not executed**. A binary that is present but broken resolves and is reported available. This keeps the run under the 3-second budget without spawning a process per check.
- Hook scripts are read for their template stamp and their Node invocation, **not otherwise validated**. A script whose body was edited but which still carries a current stamp and still invokes Cortex is reported healthy. The currency check answers "does this predate the shipped template", not "has this been modified".
- The diagnostic reads Claude Code's settings files (`<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`, `~/.claude/settings.json`) and MCP registration from those plus `<project>/.mcp.json` and `~/.claude.json`. Codex wiring is not inspected.

`cortex doctor` changes nothing it reports on: no session, no engagement write, no schema migration, no spool flush, and no store created where none exists — running it against a project with no database reports the missing database rather than creating one.

It is not literally write-free, and the one exception is worth stating plainly: reading a **WAL-mode** database creates the `.cortex.db-shm` and `.cortex.db-wal` sidecars when they are absent. That is SQLite's requirement for reading WAL at all rather than a choice Cortex makes — a read-only connection prevents content writes, not sidecar creation. The alternative, opening the store as immutable, would read past the WAL and could report a stale `schema_version`; a wrong answer is worse than a tidy one. On a checkout where those files cannot be created, the database check reports the store as unopenable.

## Retrieval Quality Gate

Ranking is benchmarked by hermetic seeded suites in `eval/suites/`, each locked against a reference result in `eval/baselines/`. One command runs all of them:

```bash
npm run gate
```

It names the suite and the metric and exits non-zero on a negative `top1_hit` delta, a negative `recall_at_3` delta, or a positive `output_tokens` delta — accuracy must not fall and output must not get more expensive. `noise_count` and `stale_count` are reported for visibility but do not gate.

Everything ambiguous fails closed, because a gate that cannot fail is worse than none:

- a suite with no baseline, and a **baseline with no suite** — deleting a suite file must not silently stop gating it
- a baseline **missing** a metric — absent values compare as `NaN`, which would otherwise un-gate that metric while still printing plausible numbers
- a **fixture whose own assertions fail** — two suites exist only to lock `[stale:` and `[moved:` in the output, and losing a label shrinks the output, so the aggregate delta alone would read the regression as an improvement
- a suite with no fixtures or no seed, which would score zero on everything and pass forever
- an unreadable suite, baseline or manifest

Suites can also assert on a whole **rendered surface** rather than on a recall query, via a `surfaces` block naming `brief`, `header` or `full_state` with `expect_contains` / `expect_excludes` / `max_tokens`. This exists because those surfaces were previously unreachable: the harness computed `header` and `full_state` on every run and asserted on neither, and never built the session brief at all — so the guarantees Cortex publishes about the brief (a contested decision is always marked; a superseded one is never shown) held only by unit test and could regress without a red build. Surface assertions fail on their own terms rather than by a baseline delta, because rendered text is either right or it is not, and a baseline able to record a broken brief as acceptable would defeat the point. An unknown surface name is refused when the suite loads: it would read every assertion against nothing, so `contains` would fail loudly while `excludes` and the token budget passed vacuously.

A fixture may also supply its own `budget`, which is the only way the brief's token-budget enforcement is exercised at all: a seeded brief is well under 150 tokens, so a `max_tokens: 150` assertion has too much headroom to ever fire.

One limit worth stating: the brief's read-ledger line is deliberately **not** gated. It names files that must exist on disk with matching hashes, which a seeded in-memory scenario cannot stage, so leaving it on would make a suite pass or fail by whatever happens to be checked out. That line is covered by unit tests; everything else the brief renders now gates.

It also enforces AD-5: a `memory_items` kind that no fixture exercises is invisible to the suites rather than penalised by them, so a newly registered kind fails the gate until a fixture ships with it. `eval/kind-coverage.json` grandfathers the kinds that predate the gate — and a test pins that list to exactly the kinds no suite covers, so widening it means editing an assertion, not quietly appending to an array.

CI runs the gate on every push, after build, lint and tests.

Baselines are locked artifacts. Regenerating one is deliberate:

```bash
node dist/transports/cli.js eval-gate --regenerate-baseline budget
```

The command prints the regressions it is about to bake in, and CI rejects the change unless **the commit that makes it** carries a `Baseline-Regenerated: <reason>` line — a trailer elsewhere in the range cannot launder it, and a placeholder reason is rejected. `eval/kind-coverage.json` is guarded the same way. Regenerating is never the way to turn a red gate green.

## Codex Setup

Codex is the primary Cortex runtime. Use MCP for explicit tools and hooks for quiet capture/reflex behavior.

### Global MCP

Add Cortex to `~/.codex/config.toml`:

```toml
[mcp_servers.cortex]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Claude Code\\cortex\\dist\\transports\\cli.js", "serve"]
```

### Hooks

Enable Codex hooks and add quiet Cortex wiring to `~/.codex/config.toml`:

```toml
[features]
hooks = true

[[hooks.SessionStart]]
matcher = "^(startup|resume)$"

[[hooks.SessionStart.hooks]]
type = "command"
command = 'cmd.exe /d /s /c call "C:/Users/dev/.codex/cortex-hooks/cortex-hook.cmd" session-start'
timeout = 30

[[hooks.UserPromptSubmit]]
matcher = ".*"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'cmd.exe /d /s /c call "C:/Users/dev/.codex/cortex-hooks/cortex-hook.cmd" reflect-prompt'
timeout = 15

[[hooks.PreToolUse]]
matcher = "(apply_patch|shell_command|Bash|Agent)"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'cmd.exe /d /s /c call "C:/Users/dev/.codex/cortex-hooks/cortex-hook.cmd" reflect-pre'
timeout = 15

[[hooks.PostToolUse]]
matcher = "(apply_patch|shell_command|Bash|Agent)"

[[hooks.PostToolUse.hooks]]
type = "command"
command = 'cmd.exe /d /s /c call "C:/Users/dev/.codex/cortex-hooks/cortex-hook.cmd" post'
timeout = 15
```

The wrapper calls `cortex inject-header --quiet` for SessionStart and `dist/transports/hook-entry.js` for hook JSON parsing. The hook bridge owns the consult gate policy; the wrapper should stay a thin passthrough. If Codex asks to trust the new hook entries, approve them through Codex's normal trusted-hash flow.

For new projects, keep the global `~/.codex/AGENTS.md` Cortex section aligned with this consult policy. Codex loads that global guidance outside this repo, while the global hooks above enforce the same fact-silent gate for Cortex-enabled workspaces.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cortex_route` | Explain ambient memory behavior and route to the right Cortex tool |
| `cortex_state` | Return current-session notes first, then the scored working set, budgeted; empty state returns next-step guidance |
| `cortex_note` | Record an `insight`, `decision`, `intent`, `blocker`, or `focus`; reports any active decision the write contradicts |
| `cortex_resolve` | Mark a note resolved or superseded (optionally with replacement content) |
| `cortex_recall` | Retrieve evidence for a topic: lead line + timestamped, validity-labeled evidence within a budget |
| `cortex_brief` | Return a smaller topical brief, optionally for an agent, budgeted |
| `cortex_suggest_notes` | Suggest load-bearing notes from the current session without writing them |
| `cortex_validate_memory` | Audit memories against the current checkout without deleting notes |
| `cortex_read_ledger` | Ask whether files were already read in this scope and whether they changed since — four verdicts, produced by re-hashing |
| `cortex_search_ledger` | Ask whether a search already returned zero results and provably still would — `no-matches-at <head>`, `miss`, or `unknown` |
| `cortex_engage` | Re-enable Cortex if it was disengaged |
| `cortex_disengage` | Disable Cortex hooks for the current session |
| `cortex_summarize` | Force a session summary/checkpoint |

## CLI Commands

```text
cortex inject-header
cortex inject-header --quiet
cortex route
cortex reflect --event prompt --prompt "..."
cortex reflect --event edit --file src/file.ts
cortex reflect --event cmd --cmd "npm run test"
cortex status
cortex stats
cortex consolidate
cortex evaluate
cortex evaluate --suite eval/suites/stemming.json --compare eval/baselines/stemming.json
cortex suggest-notes
cortex validate-memory --topic "Activity notes portal"
cortex read-ledger src/db/store.ts src/query/recall.ts
cortex read-ledger src/db/store.ts --json
cortex search-ledger deriveReadKey --path src
cortex search-ledger plainword --glob "*.ts" -i --json
cortex list-memory
cortex list-memory --kind note:decision --state hot,warm --limit 50
cortex list-memory --scope "branch:c:/work/cortex/.git:c:/work/cortex:main" --offset 20 --json
cortex inspect-memory <id>
cortex inspect-memory <id> --json
cortex edit-memory <id> --text "the corrected text"
cortex edit-memory <id> --file correction.txt
cortex delete-memory <id>          # preview; deletes nothing
cortex delete-memory <id> --yes    # actually delete
cortex note-resolve --subject "auth transport" --status superseded
cortex flush-spool
cortex gc            # dry-run report
cortex gc --apply    # actually prune (+ VACUUM when fragmented)
cortex doctor
cortex doctor --json
cortex install
cortex install --dry-run
cortex install --scope project
cortex install --force
cortex serve
cortex log read
cortex log edit
cortex log write
cortex log cmd
cortex log agent
```

## Memory Model

Cortex stores:
- `notes` for structured assertions
- `events` for raw short-lived activity
- `command_runs` for commands plus optional output tails
- `episodes` for failures, test cycles, and summaries
- `branch_snapshots` and `project_snapshots` for restore points
- `memory_items` as the canonical retrieval/search layer
- `memory_item_semantics` for optional summaries, concepts/entities, and JSON-safe embeddings keyed by `memory_items.id`
- `current_app_graphs` for the current checkout's file inventory by scope
- `memory_references` for file/path references extracted from memory items

Retrieval is hybrid:
- FTS over `memory_items`
- scope-aware reranking
- recency/importance/access reinforcement
- hot/warm/cold decay
- temporal intent handling for prompts like `latest`, `old`, `resolved`, and `when`
- current-checkout reference validation so repo-valid memories beat memories pointing at deleted files or missing plans
- optional semantic shadow/rank candidates when a semantic provider is configured

### Contradiction detection

Writing a note whose content opposes an active `decision` on the same subject marks both sides contested and returns a payload naming the prior note. The write always succeeds — the conflict is advisory metadata, never a rejection, and choosing a winner stays yours via `cortex_resolve`.

Detection is deterministic and offline. It fires on an explicit polarity flip — a negation carried by exactly one side, or a curated antonym pair such as `enable`/`disable` — and only when the two notes demonstrably talk about the same thing. A detector that cries wolf gets ignored, so misses are the cheaper failure, and the rules are correspondingly strict:

- A negation must **govern something the other note also asserts**. "use postgres, not mysql" refines "use postgres" — the negation lands on `mysql`, which the other note never mentions.
- Negators are matched on their surface form, never on a stem. Stemming maps `noted` and `noting` onto `not`, which would make "as noted, we cache X" contradict "we cache X".
- A fragment of a compound is not a negation. `--no-verify` and `src/capture/no-op.ts` both contain `no`.
- An antonym flip needs near-identical remaining content. "required for rank mode" and "optional for shadow mode" are both true.
- Overlap is measured against the larger note, so a short one cannot be contained into a match.
- Detection is scope-keyed. Two branches holding opposite decisions is the ordinary reason branches exist.

Divergent choices (`use postgres` vs `use mysql`) and refinements (`use postgres` vs `use postgres with pooling`) are **not** contradictions.

A contested prior is **not** auto-superseded. Normally a new decision supersedes the old one on that subject, which demotes it one memory tier; suppressing that for contested pairs keeps both sides fully live until you resolve one. That exemption also covers notes already contested, so a later unrelated decision cannot quietly cool one side of an open contest.

### Superseded decisions cool instead of vanishing

When a new decision lands on a subject, its predecessor is demoted instead of being archived out of retrieval, as it was before. The durable rule lives in the decay layer: a superseded item always sits **one tier below what its activity score would grant** — a decision that would derive hot settles at warm, one that would derive warm settles at cold, floored at cold. The old decision stays reachable, demoted in rank below the current one in the ordinary case, and labeled so it cannot read as live:

```
Decision [2026-07-25 15:56Z]: [queue engine] use kafka for the queue engine.
Decision [2026-06-17 15:56Z]: [queue engine] use rabbitmq for the queue engine. (superseded)
```

Historical questions — `old queue decisions`, `queue engine history`, `what did we decide before` — reach it through ordinary recall. Blockers are never demoted by a decision: an unresolved blocker on the subject is not superseded guidance.

Because the tier is re-derived from the score on every refresh, recalling a superseded decision cannot reheat it past warm, and it keeps cooling as it ages. Two consequences worth knowing: a freshly superseded decision usually settles at warm (its score is still hot-range), so it can appear in the working set — labeled — until it decays; and the label, not the rank, is the guarantee, since heavy access to the old item can in principle rank it near the new one. The unprompted channels are stricter — the SessionStart brief and the reflex whisper never carry a superseded decision at all, because those channels present a single remembered item as settled context. Manual close-outs behave identically: `cortex_resolve(status='superseded')` demotes the same way, and pre-existing archived rows from before this behavior stay archived.

Resolving either side with `cortex_resolve` closes the contest and clears the marker on both. While a contest is open, resolving *by subject* is refused — picking one of two contested notes would be a guess, and guessing wrong leaves the retracted decision as the live one. Several uncontested notes on a subject (a decision plus a blocker, say) resolve by subject as they always have.

Known limit: token matching is ASCII-only, so non-Latin note content never conflicts. A silent miss rather than a wrong answer.

### Contested items in retrieval

A contested memory renders a `[contested]` marker on every surface that shows it — `cortex_recall`, `cortex_brief`, `cortex_state` (including its `Hot:` and `Resume:` lines), the SessionStart brief, and the reflex that injects remembered context automatically:

```
Decision [2026-07-25 15:56Z]: [spool flush policy] flush the spool at turn end. [contested]
Decision [2026-06-12 15:56Z]: [spool flush policy] do not flush the spool at turn end. [contested]
```

The unprompted channels matter most. A lone remembered decision injected at session start, or as a reflex, reads as settled fact; if it is one half of an open disagreement, that is precisely the failure the marker exists to prevent.

Both sides are seated together so they read as one disagreement rather than two unrelated claims separated by whatever happened to rank between them. `cortex_recall` is a flat ranked list and can always do this. `cortex_brief` and `cortex_state` sort by note kind first, so they group within a kind — the common case, since a contest always starts from a decision. A contest that spans two kinds stays split there, because seating them together would mean dismantling the kind ordering those surfaces exist to provide.

The marker costs three tokens and is trimmed with its line like any other content. Note that seating both sides together does reorder results: a contested counterpart is pulled up past whatever ranked between the two sides, so under a tight budget it can be kept while a higher-ranked uncontested item is dropped. That is the deliberate resolution of showing a whole disagreement versus showing strictly the best matches.

### Rejected alternatives in retrieval

A note written with `alternatives` renders them beneath the decision they lost to, so an agent about to re-propose one can see it was already considered:

```
Decision [2026-07-25 15:56Z]: [auth strategy] use OIDC with server-side sessions.
  already rejected: session cookies (no SSO path), JWT-in-localStorage (XSS surface)
```

This appears in `cortex_recall` and `cortex_brief` — the two surfaces where an agent asks a question before proposing an approach. It deliberately does **not** appear in `cortex_state`, the SessionStart brief, or the reflex whisper. Those channels budget whole sections or truncate to a fixed width, so an extra line there could not be dropped independently of the decision above it, which is the property the whole feature turns on.

**An alternatives line never costs you a decision.** Output is assembled in two passes: every decision line that fits is placed first, and only the budget left over buys alternatives. Adding alternatives to a result set therefore cannot change which decisions are rendered, at any budget — the line is charged only once every decision that fits is already on the page. In a two-decision recall the lines cost 47 tokens where there is room and nothing at all once the budget binds.

Two things that follow, and are easy to misread from the output alone. Results are still trimmed from the bottom for their own length, so you can see a decision trimmed *while* a higher-ranked decision shows its alternatives — the trim was not paid for by that line, and dropping it would not have bought the missing decision back. And because extra budget buys another decision line before it buys alternatives, raising the budget can replace an alternatives line you already had with a further result.

Written as `cortex_note(kind='decision', alternatives=['…'])`. Rationale you put in the strings travels with the rejection; internal whitespace is collapsed to keep each list on one line, and a list long enough to crowd out every other result is truncated.

## Inspecting what Cortex holds

Retrieval decides what you see. `list-memory` and `inspect-memory` show you everything else.

```text
$ cortex list-memory --limit 2
memory items 1-2 of 3 · newest first (created_at DESC, rowid DESC) · filters: none
notes:208ece98-638a-4c79-b649-ab326abe8ef9  warm  Insight   2026-07-28 04:23Z  insight: the porter tokenizer stems queries too
notes:73e34db9-e13c-4950-a6a4-281e917330e9  warm  Decision  2026-07-28 04:23Z  [auth strategy] decision: do not use OIDC with server-side sessions

next page: cortex list-memory --limit 2 --offset 2
```

Filter with `--kind` and `--state` (comma-separated) and `--scope` (repeat the flag for more than one). `--scope` is deliberately not comma-split: scope keys embed the worktree path and the branch ref — they look like `branch:c:/work/cortex/.git:c:/work/cortex:main` — and git permits commas in branch names, so splitting would shatter a legitimate key.

Two defaults are deliberate and differ from every other surface: **no state filter is applied, so `archived` items are listed too**, and **no scope filter is applied, so other branches' memory is visible**. A listing that quietly omits rows cannot answer "what does Cortex actually hold".

Pages are capped: 20 items by default, 200 at most, however large a `--limit` you pass. When more remain, the footer prints the next page's command with its filter values quoted, so it runs as printed even when a scope key contains spaces — which, on a path like `C:/Claude Code/cortex`, it does. The ordering criterion is printed in the header, tiebreaker included, rather than left implicit.

`inspect-memory <id>` takes a memory-item id or the id of the note behind it — including the counterpart ids that the conflict section prints — and shows the full stored text untruncated, alongside the four things retrieval only ever summarises:

```text
trust:      refs OK

conflict:   contested — an unresolved contradiction on this subject
status:     active
  contested with 73e34db9-e13c-4950-a6a4-281e917330e9 (decision, 2026-07-28 04:23Z)
  already rejected: session cookies (no SSO path), JWT-in-localStorage (XSS surface)

references:
  exists   src/transports/cli.ts

access history:
  count 0, last never
  2026-07-28 04:23Z  auth strategy
  (showing at most 10; cortex gc also prunes the retrieval log — the access count is the durable figure)
```

The trust label is the same one `cortex_recall` prints in its lead line. It describes the item's references against **its own scope's** recorded file inventory, which for another branch may be older than that branch's current checkout — so a cross-scope `stale refs` means "stale as of what Cortex last recorded there", not necessarily "missing on disk today".

The two halves of access history have different durability and can disagree for two separate reasons, both named in the trailer: the list is capped at the most recent 10, and `cortex gc` trims the retrieval log independently. `access_count` is the durable figure.

Stored text is printed verbatim except for terminal control characters, which are stripped: captured stderr can carry ESC and lone CR, and this is the first surface that prints text untruncated. `--json` stays byte-faithful.

**Inspect is the only surface that reads `notes.conflict` directly.** Every other renderer recovers the flag from the projected memory text, because `memory_items` has no conflict column. Inspect has the id, so it joins to the note itself — and when the column and the projection disagree, it says so rather than silently preferring one. That disagreement is invisible everywhere else.

Both commands are read-only in the sense that matters: neither creates a session, and neither touches access counts, so inspecting memory cannot change the ranking it exists to reveal. `--json` on either emits the same data as a structure; a missing id exits non-zero in both modes and `--json` gets a parseable `{"error":"not_found"}` rather than empty output.

Stored strings are author-supplied, so the renderer treats them as content rather than as its own output: alternatives and subjects are each collapsed onto a single line, and the alternatives payload is capped. Without that, an alternative containing a newline could print what looked like a counterpart line inside the conflict section of a note that has no contest at all.

## The read ledger

Cortex records a content digest for every file an agent reads. `cortex read-ledger` (and the
`cortex_read_ledger` tool) turns that into an answer to the question worth asking before a
re-read — *have I already got this, and is it still current?*

```text
$ cortex read-ledger src/scope/keys.ts src/capture/spool.ts src/db/store.ts docs/gone.md
src/scope/keys.ts: unchanged-since 2026-08-02 18:48Z
src/capture/spool.ts: unchanged-since 2026-08-02 18:48Z (read by subagent general-purpose)
src/db/store.ts: edited-by-you-since 2026-08-02 18:48Z
docs/gone.md: changed-since 2026-08-01 09:02Z (missing)
```

There are exactly four verdicts — `unread`, `unchanged-since`, `changed-since`,
`edited-by-you-since` — and three properties matter more than the list:

**`unchanged` is never inferred.** It is asserted only after re-hashing the file and matching the
current bytes against the recorded digest. Cortex does not trust mtime, in either direction: a
same-second edit keeps the old timestamp with different content, and a `git checkout` or a restore
rewrites the timestamp without changing a byte. Both cases are tested.

**Uncertainty resolves to a miss, never to the convenient answer.** A deleted file is
`changed-since (missing)`, never `unchanged`. A file that cannot be hashed — unreadable, now a
directory, or past the 2 MiB digest ceiling — is `changed-since (unverifiable)`, and so is a file
whose *record* was oversize and therefore carries no hash to compare. Each of those costs one
re-read. None of them can license a skip that turns out to be wrong.

**"You already have this" is session-bound, even though change detection is not.** A digest
recorded by a subagent is a perfectly good fact about the file, and it is reported — but attributed
to whoever actually read it, as in the `read by subagent general-purpose` line above. Cortex will
not tell you a file is unchanged *since you read it* when you never did. A read by your own session
or by one of its ancestors is yours; a sibling's or a descendant's is not. A read from an earlier
session of the same project is reported as `read in an earlier session` rather than being named,
because every non-subagent session carries the same role label and naming it would say nothing.

`edited-by-you-since` is checked **before** the content comparison, and that order matters more
than it looks. A digest describes the file as of the moment the capture spool was *flushed*, not
the moment it was read — so the ordinary sequence of reading a file and then editing it records
the **post-edit** bytes. The record then matches what is on disk while your context still holds
the old content. Comparing content first would answer `unchanged` there, which is exactly the
wrong skip. If your own edit sits between the record and the question, Cortex says so.

The same flush-time window is the one caveat worth stating plainly: a file changed by something
*outside* Cortex between the read and the flush records the changed bytes and will later read as
`unchanged`. The window is one flush interval, and nothing in the ledger can close it.

## Refunding a redundant read

The ledger answers a question you have to remember to ask. Substitution acts on the same evidence
without being asked: when a `Read` returns a file you already read in this session and the bytes on
disk still hash to what Cortex recorded, the PostToolUse hook replaces the tool's output with a
short line. A four-thousand-token re-read becomes about fifty.

**It is off until you turn it on**, per project:

```bash
cortex substitution on
```

`cortex substitution status` reports the current state, and `cortex substitution off` removes it.
Turning it on needs current hooks — run `cortex install` if `cortex doctor` reports the hook version
as out of date.

What you see in place of the file:

```text
[cortex] substituted: src/db/store.ts is byte-identical to the copy already in this session's
context (verified by sha256 just now). Full content ~4210 tokens. Read it again to get the real text.
```

That last sentence is load-bearing, not politeness. **Reading the same file a second time in one
turn is never substituted**, so a re-read is always the way back to the real bytes — which is what
makes replacing a tool result safe at all.

The conditions are deliberately narrow, and every one of them resolves to *no substitution* when it
cannot be established:

- **The record must prove what your read actually returned, not just what is on disk.** Digests are
  recorded when the capture spool flushes — after the turn — so a read that was followed in its
  turn by an edit of that file, or by *any* command (commands rewrite files invisibly: formatters,
  codegen, `git pull`), is never certified for refunds. A later clean read re-earns it. This is the
  guard against the worst failure this feature could have: telling you content is "already in your
  context" when what you read was different.
- **The file is re-hashed at the moment of the substitution** and must match the recorded digest —
  and its current size must match the recorded size before anything is hashed. Not mtime — the
  bytes. Cortex hashes the file rather than the returned text, because the text arrives with line
  endings normalised and would never match on a CRLF file.
- **Only a complete read.** A partial read, or a file long enough that `Read` truncated it, passes
  through: you hold part of the file and the digest describes all of it.
- **Only the primary session, in both directions.** The recorded read must be the primary's own,
  and the requester must be the primary — a subagent always receives real content, because it
  starts with a fresh context and holds nothing, whatever the parent read. A digest recorded by a
  subagent is a valid fact about the file but is never a refund.
- **Only files between 2 KiB and 1 MiB** (`CORTEX_SUBST_MIN_BYTES`, `CORTEX_SUBST_MAX_BYTES`),
  and only when the refund is worth more than the replacement line itself costs.

Each substitution books a `saved` row in the token ledger carrying its evidence — the file, its
verified size, and the tokens avoided — so `cortex stats` reports it as a measured number rather
than an estimate. It is the only mechanism in Cortex that produces credit. One stated limit of that
evidence: the credit records that a verified substitution payload was *emitted*; the hooks API has
no acknowledgement channel, so a Claude Code build that silently stopped honouring
`updatedToolOutput` would receive full files while credits still booked. `cortex doctor` verifies
the installed script; it cannot verify the host.

The hook does this in pure bash: one `grep` against the flat digest index on a miss, a `wc -c` and
a `sha256sum` more on a verified hit, no Node process and no database. `cortex doctor` reports the
substitution state, including the armed-but-inert case where no session facts are published yet.

## Remembering searches that found nothing

A zero-result search is the most wasteful category of repeated work: it costs full price and
teaches nothing. Cortex records searches that provably returned nothing, and `cortex search-ledger`
(and the `cortex_search_ledger` tool) answers the question worth asking before repeating one:

```
cortex search-ledger deriveReadKey --path src
deriveReadKey: no-matches-at 4ae5ac8 (2026-08-03 10:41Z)
```

Three verdicts, never a guess. `no-matches-at <head>` is asserted only when the search root's
working tree re-fingerprints **byte-identical** to the census recorded at capture — file content,
uncommitted changes and all, never mtime — so the assertion holds whatever HEAD did in between.
Any change under the root, or the root vanishing, answers `miss`; anything that cannot be
established either way answers `unknown`. Restore the exact bytes (`git stash pop`) and the record
honestly re-validates. A negative recorded on one branch is never asserted on another.

Capture is deliberately narrow, because a false "no matches" is the worst answer this feature
could produce. Only searches the runtime can vouch for are recorded: plain literal-ish patterns
(never anything that could be an invalid regex — some Claude Code versions answer those with a
zero-shaped response), no pagination, a bounded root (`CORTEX_NEGATIVE_MAX_FILES` /
`CORTEX_NEGATIVE_MAX_BYTES`, default 2,000 files / 8 MiB — a repo-root search over `node_modules`
is simply never cached), and nothing after the search in its turn that could have rewritten the
tree. Search patterns pass through the same secret redaction as command capture before storage.
Records expire after `CORTEX_GC_NEGATIVE_DAYS` (default 30) without a re-confirming search;
`cortex gc` prunes them dry-run-first like everything else.

## Correcting and deleting memory

`edit-memory` replaces an item's text, re-extracts its file references and re-projects it. A note-backed item is corrected *through its note*, so the projected trailer stays consistent with the columns it mirrors — `inspect-memory` will not start reporting a divergence on an item you just fixed. Access counts and decay state are left alone: a correction is not a new memory, and reheating one as a side effect of fixing a typo would change what retrieval surfaces for a reason you never asked for.

`delete-memory` previews by default and deletes only with `--yes`, the same shape `cortex gc` uses:

```text
$ cortex delete-memory notes:ed470662-a3ba-49aa-9867-bde32cdfccdc
preview only — nothing has been deleted.

id:         notes:ed470662-a3ba-49aa-9867-bde32cdfccdc
kind:       Decision (note:decision)
subject:    auth strategy
scope:      branch:c:/work/cortex/.git:c:/work/cortex:main
references: 0 will be removed with it
source row: notes/ed470662-a3ba-49aa-9867-bde32cdfccdc — deleted too
            (leaving it would resurrect this item on the next command)
contest:    open — deleting this side clears it for 1 counterpart(s)
            b98baa9f-aab4-44cd-aa13-fc78bd1cb444

text:
decision: use OIDC with server-side sessions
Subject: auth strategy
Conflict: true

to delete: cortex delete-memory ed470662-a3ba-49aa-9867-bde32cdfccdc --yes
```

That "would resurrect" line is literal. Memory items are re-projected from their source rows every time the schema is ensured, which is every command — so deleting the projection alone would undo itself on your next invocation. Deletion removes the source row, the item, and everything derived from it in one transaction.

**And three of those source rows are themselves derived.** `command_runs` is rebuilt from `events`, and both `episodes` and `project_snapshots` are rebuilt from `state`, each reusing the same id — so deleting one level up is still not enough, and the delete walks the chain. A source table with no deletion rule is refused outright rather than half-deleted; the preview says so before you commit to it.

Deleting one side of a contested pair clears the contest, so the surviving note stops rendering `[contested]` against a counterpart that no longer exists.

**Corrections are recorded, and the record outlives what it describes.** Both edits and deletes write the prior text to a `memory_corrections` row that carries no foreign key to the item — with one, the audit trail would be destroyed by the very deletion it exists to document. `cortex inspect-memory` shows the trail under `corrections:`, and `prior_text` records the value `edit-memory` *consumes*, so feeding it back restores the memory exactly.

The honest consequence: **text you delete remains readable in the audit trail** for 90 days, until `cortex gc` prunes it (`CORTEX_GC_CORRECTION_DAYS` sets the window; `cortex gc --apply` prunes on demand). If you are deleting something because it must not be readable, delete it and then run gc.

## Reliability Evaluation

`cortex evaluate` still reports table counts and output sizes. With `--suite`, it also runs retrieval-quality fixtures:

```json
{
  "fixtures": [
    {
      "topic": "latest auth decision",
      "expected_top": "auth",
      "allowed": ["oidc"],
      "forbidden": ["legacy sessions"],
      "max_output_tokens": 200,
      "fresh_after": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

The quality report includes `top1_hit`, `recall_at_3`, `noise_count`, `stale_count`, output tokens, and per-result score breakdowns. Pass `--compare previous-eval.json` to include aggregate deltas against an earlier run.

Suites can be hermetic: a `seed` block builds an in-memory store from declarative items, app graphs, and renames, so quality runs are deterministic and never touch your real `.cortex.db`. The repo ships locked suites in `eval/suites/` with reference results in `eval/baselines/`.

## Recommended Usage

Cortex leads with value instead of demands: the session brief shows validated prior context at startup, the reflex whispers on high-confidence focus shifts, and at most one one-line hint appears for memory-relevant prompts. Consult `cortex_recall(topic)` proactively for non-trivial familiar or resumed work.

- Use `cortex_route` when you need the capability map; if deferred discovery is needed, discover by callable name (`cortex_route`, `cortex_recall`, `cortex_state`) or by server name (`Cortex`).
- Use `cortex_recall(topic)` proactively before non-trivial work in familiar areas, recurring bugs, resumed features, or systems with prior decisions; use `cortex_state` when you need the broader working set.
- Use `cortex_brief(topic)` before dispatching a subagent when topic history matters.
- Use `cortex_note(decision, alternatives=[...])`, `cortex_note(insight)`, or `cortex_note(blocker)` for load-bearing memory only. If the note opposes an active decision on the same subject, the write still succeeds and the response names the note it contradicts — both sides are marked contested until you close one with `cortex_resolve`.
- Use `cortex_suggest_notes` / `cortex suggest-notes` to review possible load-bearing notes before explicitly saving them.
- Use `cortex_validate_memory` / `cortex validate-memory --topic ...` when a memory mentions files, plans, or app structure that may have changed.
- Use `cortex_summarize` at the end of a dense work session so the next one resumes gracefully.

Anti-patterns: don't add startup rituals to agent instructions, don't note routine acknowledgments, don't tell subagents to call `cortex_brief` themselves, don't re-call `cortex_state` multiple times per session, and don't summarize throwaway sessions.

## Data

Memory lives **outside your repository**, in a per-project directory under a user-level Cortex home:

```text
~/.cortex/projects/<repo-name>-<id>/cortex.db
```

`<id>` is a hash of the absolute realpath of `git rev-parse --git-common-dir`. Three consequences follow, and they are the point:

- **Every worktree of a repository shares one store.** Cortex already partitions worktrees internally by scope key, so splitting them across files only fragmented memory.
- **Two clones of the same repository get two stores.** Identity is the path, not the remote or the root commit — a fork does not inherit upstream's decisions.
- **Your project root stays clean.** Nothing about the database needs to be in a directory you commit.

Set `CORTEX_HOME` to move the whole tree elsewhere. Outside a git repository Cortex falls back to a hash of the working directory's realpath and says so in `cortex doctor`.

Run `cortex store` to see where the current project resolves, and why.

Three small files *do* stay in the project root, because the `PostToolUse` hook is pure bash and must not spawn a process per tool call: engagement state in `.cortex.state`, pending capture in `.cortex.spool.jsonl`, and `.cortex.agent-used`.

Add to `.gitignore` (`cortex install` does this for you):

```text
.cortex.db
.cortex.state
.cortex.spool.jsonl
.cortex.spool.jsonl.processing
.cortex.agent-used
```

`.cortex.db` stays on that list because migration deliberately leaves your original where it was.

### Migrating an existing store

The first Cortex command after upgrading copies `<project>/.cortex.db` into the new location, verifies the copy, and **leaves the original exactly where it is**. Nothing deletes it but you.

The copy is a SQLite `VACUUM INTO`, not a file copy. Copying `.cortex.db` on its own loses everything still in the `-wal` sidecar — measured here on a live store, a plain copy produced a database in which the tables did not exist. Verification then re-opens the copy from disk and checks `integrity_check`, the schema version, and the row counts of `memory_items`, `notes`, `sessions` and `events` before the new store is used.

`cortex doctor` reports both locations until you remove the original, and tells you the store is still at the pre-relocation path if the migration has not run yet.

One transition note: a Cortex MCP server that was already running resolved its path at startup and keeps using it. Restart it to pick up the new location.

### If you move or rename a repository

Moving a checkout changes its git common dir, so it computes a new identity and finds no store. Rather than starting empty, Cortex records the root-commit OID alongside each store as a repair anchor. When a store's anchor matches this repository and the path it recorded no longer exists, that store is offered for adoption:

```bash
cortex adopt
```

It previews by default and moves the store only with `--yes`. Ambient startup never adopts on its own — a hook has no way to ask you, and attaching a store you did not approve is not something to do silently. `cortex doctor` and `cortex store` both surface the offer, and it survives ordinary use: a session that starts before you adopt does not migrate the stale copy in your project root, and the store it opens is marked so the offer keeps being made.

Two things worth knowing before you accept one:

- **Check the recorded path the preview prints.** A clone or fork of the same repository shares a root commit, so a sibling checkout that happens to be unavailable right now — an unmounted share, a folder mid-rename — can match. Adoption moves the store.
- **Adopt before you do much work in the moved checkout.** If the new location has recorded notes of its own by then, adoption is refused rather than discarding them, and you have to move that store aside yourself to choose.

Growth is bounded: `cortex gc` — and, **on by default**, a startup sweep at most once per 24h (`CORTEX_GC_AUTO=off` opts out) — prunes events of consolidated sessions, trims the retrieval log, rolls up old ledger rows, deletes never-accessed archived items after 90 days, and caps command history per scope at its **source**: the `cmd` events and `command_runs` rows, not only the `memory_items` projection those are rebuilt from. Dry-run is the default for the command; the startup sweep applies. `cortex stats` reports `Last cleanup:` so an inert bound cannot look like a quiet one.

### The P&L

`cortex stats` reports what Cortex cost and returned — for the most recent session in your scope (its subagents included, and labeled when they contributed) and cumulatively for the scope — plus retrieval health over the whole store:

```text
Session:       started 2026-08-02 23:21Z
  Injected:    111
  Saved:       0
  Net:         -111
  Ratio:       0.00×
Scope:         cumulative over 2 scope keys
  Injected:    16k
  Saved:       0
  Net:         -16k
  Ratio:       0.00×
  Estimated:   558.9k (retired consolidation estimate, not counted)
               no verified savings yet: credit needs recorded evidence, and the
               mechanism that produces it (verified read substitution) is not shipped
Memory items:  4814 (pinned 0, hot 337, warm 138, cold 4339, archived 0)
  Never retrieved: 4661
  Most retrieved (by access count; ties: latest access, then rowid):
    43× Decision [2026-06-05 21:05Z]: decision: Implemented Cortex living-brain Phase 0 plus… — notes:86ab1231-…
    35× Decision [2026-05-12 17:22Z]: decision: For the next Cortex improvement plan, optimi… — notes:6167bc11-…
```

*(Abridged: the command prints all ten lines, full ids, plus the `Focus`/`Sessions`/`Active notes` header and the `Database`/`WAL` trailer.)*

The ratio is `saved / injected` — the number this product asks to be judged on — and it is conservative by construction: floored to hundredths rather than rounded (996 saved against 1000 injected reads 0.99×, never parity), with a `—` when nothing was injected, and `Unrealized` (a refund was offered and the agent read the file anyway) and `Estimated` (the retired pre-3.5 consolidation figure, kept for history) reported beside it but never counted into it. Scope attribution joins ledger rows through their sessions, so a subagent's injected brief lands in the session tree that dispatched it and GC rollups stay inside the totals; ledger rows no scope can reach (sessions predating scope records) render as one `Unattributed:` line rather than vanishing. Each most-retrieved line ends with the item's id — the handle into `cortex inspect-memory`. The report only reads: it creates no session, reinforces no item — the ten-most-retrieved list must not reorder itself by being looked at — and books nothing.

### The write-ahead log

`cortex stats` names the two files separately, because they grow for different reasons:

```text
Database:      14.0 MB
WAL:           96.6 KB
```

SQLite already bounds the WAL — `wal_autocheckpoint` moves its contents into the database every 1000 pages, so it does not grow without limit. What it does *not* do is give the space back: a passive checkpoint resets the log for reuse and leaves the file parked at its high-water mark, which on this repository's own store meant a permanent 4.1 MB.

So Cortex runs a **truncating** checkpoint, which returns the space, at two points: when a command's process exits, and mid-session once the log crosses `CORTEX_WAL_MAX_BYTES` (default 4 MiB). Neither is on the path of a tool call — the `PostToolUse` hook is pure bash and reaches the checkpoint only through a flush it launches detached and does not wait for.

A checkpoint can report `busy`, which is normal rather than a failure: another Cortex process was mid-transaction — most often the spool flush the capture hook launches in the background — so the frames moved into the database but the file could not be reclaimed yet. The next checkpoint gets it. An MCP server that is merely *connected* does not cause this; only one inside a transaction does. Checkpoints never wait for it, so a busy one costs milliseconds.

## Version history

Kept for readers upgrading from an earlier build. Nothing below is required
to use Cortex today.

### What Changed In V2

Before:
- mostly note/state dumps
- lexical recall over notes and recent summaries
- project memory behaved as mostly linear history
- stale notes stayed active forever

Now:
- branch/worktree-aware sessions and snapshots, identified by `(scope_key, agent_id)` so subagent work lands in its own session
- retrieval quality gated in CI against locked baselines, so ranking cannot regress silently
- live `memory_items` retrieval layer with FTS search
- command failures and test cycles captured as durable episodes
- hot/warm/cold decay with reinforcement from actual use
- default state built from a scored working set, not “all active notes”
- timestamped note output, current-checkout reference validation, fixture-backed retrieval evaluation, and optional semantic shadow/rank retrieval

### What Changed In V3 (pull, not push)

- A tiny validated **session brief** (≤150 tokens: top branch-scoped decisions/blockers/intents plus a resume line) is the SessionStart payload; cold starts emit nothing.
- The consult gate shrank to **one line, at most once per session**; the PreToolUse gate is gone. The reflex whisper remains the only mid-session push.
- The Stop nudge fires **only** when a subagent ran this turn *and* suggest-notes has high-confidence candidates — and it embeds them. Disable with `CORTEX_STOP_NUDGE=off`.
- Ambient capture is **spooled**: PostToolUse hooks append a JSON line to `.cortex.spool.jsonl` (no Node spawn per tool call); one flush per turn replays the batch.
- Recall is **answer-shaped**: a lead line naming the most relevant memory and its trust level (`refs OK` / `stale refs` / `refs moved`), then timestamped evidence, within a token budget.
- Rerank matches stemmed terms (`testing` finds `test flake`), renamed files resolve to `moved:` labels via a git rename map, and stale memory is labeled and demoted gently instead of buried.
- `cortex_resolve` closes out notes; repeated command failures fold into one episode with an occurrence counter; `cortex gc` prunes derived data (dry-run by default).

## License

MIT
