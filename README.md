# Cortex

Persistent working memory for Claude Code and other MCP-compatible coding agents.

Cortex V2 is branch-aware, retrieval-first, and ambient by default. It stores decisions, blockers, command outcomes, snapshots, and session summaries in a local SQLite database, then quietly captures activity and surfaces short prior-context whispers only when a high-confidence focus shift matches memory.

## What Changed In V2

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

## What Changed In V3 (pull, not push)

- A tiny validated **session brief** (≤150 tokens: top branch-scoped decisions/blockers/intents plus a resume line) is the SessionStart payload; cold starts emit nothing.
- The consult gate shrank to **one line, at most once per session**; the PreToolUse gate is gone. The reflex whisper remains the only mid-session push.
- The Stop nudge fires **only** when a subagent ran this turn *and* suggest-notes has high-confidence candidates — and it embeds them. Disable with `CORTEX_STOP_NUDGE=off`.
- Ambient capture is **spooled**: PostToolUse hooks append a JSON line to `.cortex.spool.jsonl` (no Node spawn per tool call); one flush per turn replays the batch.
- Recall is **answer-shaped**: a lead line naming the most relevant memory and its trust level (`refs OK` / `stale refs` / `refs moved`), then timestamped evidence, within a token budget.
- Rerank matches stemmed terms (`testing` finds `test flake`), renamed files resolve to `moved:` labels via a git rename map, and stale memory is labeled and demoted gently instead of buried.
- `cortex_resolve` closes out notes; repeated command failures fold into one episode with an occurrence counter; `cortex gc` prunes derived data (dry-run by default).

## Core Behavior

- `SessionStart` quietly enables capture with `cortex inject-header --quiet` and prints the validated session brief (or nothing on a cold start).
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

`--scope project` writes `<project>/.claude/settings.json` and registers the server in `<project>/.mcp.json` instead. `--dry-run` reports every outcome and writes nothing. `--json` emits the result for scripting.

**Running it again changes nothing.** Not "rewrites the same content" — an unchanged installation produces byte-identical files, so mtimes, backups and your settings formatting are all left alone, and it says `Nothing changed`.

What it will not do without being told:

- **A hook script you edited is refused, not overwritten.** Cortex can tell the difference because each installed script carries a digest of the template it came from; if the file is not exactly what the installer would have written, it stops and names `--force`. With `--force`, your version is saved to `<script>.bak` first.
- **A script from an older Cortex is backed up and replaced**, not refused. Those predate the template stamp, and refusing them would break the repair path `cortex doctor` recommends. The previous copy is kept as `<script>.bak`.
- **An existing `cortex` MCP registration is left alone.** It may point at a checkout you prefer.
- **A settings file that does not parse is refused, never clobbered.** Fix the JSON and re-run.

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

Cortex stores memory in `.cortex.db` in the repo root, engagement state in `.cortex.state`, and pending capture in `.cortex.spool.jsonl`.

Add to `.gitignore`:

```text
.cortex.db
.cortex.state
.cortex.spool.jsonl
.cortex.spool.jsonl.processing
.cortex.agent-used
```

Growth is bounded: `cortex gc` (and the opt-in `CORTEX_GC_AUTO=apply` startup sweep, at most once per 24h) prunes events of consolidated sessions, trims the retrieval log, rolls up old ledger rows, deletes never-accessed archived items after 90 days, and caps stored `command_run` items per scope. Dry-run is the default; `--apply` deletes.

## License

MIT
