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
- branch/worktree-aware sessions and snapshots
- live `memory_items` retrieval layer with FTS search
- command failures and test cycles captured as durable episodes
- hot/warm/cold decay with reinforcement from actual use
- default state built from a scored working set, not “all active notes”
- timestamped note output, current-checkout reference validation, fixture-backed retrieval evaluation, and optional semantic shadow/rank retrieval

## Core Behavior

- `SessionStart` quietly enables capture with `cortex inject-header --quiet`.
- `cortex reflect` can emit short hook `additionalContext` on high-confidence focus shifts.
- Cortex now supports branch-scoped restore: switching branches restores the right snapshot.
- `cortex_route` / `cortex route` provide the cold-callable capability map.
- `cortex_recall(topic)` searches notes, summaries, snapshots, and command/episode memory.
- `cortex_brief(topic)` returns a smaller, agent-friendly subset.
- `cortex_state` shows current-session load-bearing notes first, then branch snapshots and the scored working set.
- When that state is empty, `cortex_state` returns fallback guidance instead of an empty string.
- Note-backed outputs include compact UTC timestamps, for example `Decision [2026-06-06 05:18Z]: [auth] use OIDC`.
- Cortex tracks a lightweight current app graph for the active scope and validates file/path references extracted from memory.
- Missing file references demote retrieved memories and render as `Stale references: missing ...`; historical queries can still surface them as history.
- Branch snapshot summaries and recent-session tails prefer notes and file/test/agent activity over raw command-only hook noise.
- touched and recalled memory stays hot; ignored memory decays out of the default state.
- resolved notes stay cold and do not trigger hook reflex whispers.
- UserPromptSubmit prompt hooks may emit a once-per-session route-level Cortex hint, but do not inject memory facts from prompt text; edit and command reflexes still require high-confidence prior context.
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

### PostToolUse Hook

To capture file, command, and agent activity:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|Bash|Agent",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/cortex-hook.sh"
          }
        ]
      }
    ]
  }
}
```

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

The wrapper calls `cortex inject-header --quiet` for SessionStart and `dist/transports/hook-entry.js` for hook JSON parsing. If Codex asks to trust the new hook entries, approve them through Codex's normal trusted-hash flow.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cortex_route` | Explain ambient memory behavior and route to the right Cortex tool |
| `cortex_state` | Return current-session notes first, then the scored working set; empty state returns next-step guidance |
| `cortex_note` | Record an `insight`, `decision`, `intent`, `blocker`, or `focus` |
| `cortex_recall` | Retrieve evidence for a topic from memory |
| `cortex_brief` | Return a smaller topical brief, optionally for an agent |
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
cortex evaluate --suite quality-suite.json --compare previous-eval.json
cortex suggest-notes
cortex validate-memory --topic "Activity notes portal"
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

## Recommended Usage

Cortex should feel ambient. Let hooks capture activity and let the reflex stay silent unless it has high-confidence prior context.

- Use `cortex_route` when you need the capability map.
- Use `cortex_recall(topic)` proactively before non-trivial work in familiar areas, recurring bugs, resumed features, or systems with prior decisions; use `cortex_state` when you need the broader working set.
- Use `cortex_brief(topic)` before dispatching a subagent when topic history matters.
- Use `cortex_note(decision, alternatives=[...])`, `cortex_note(insight)`, or `cortex_note(blocker)` for load-bearing memory only.
- Use `cortex_suggest_notes` / `cortex suggest-notes` to review possible load-bearing notes before explicitly saving them.
- Use `cortex_validate_memory` / `cortex validate-memory --topic ...` when a memory mentions files, plans, or app structure that may have changed.
- Use `cortex_summarize` at the end of a dense work session so the next one resumes gracefully.

Anti-patterns: don't add startup rituals to agent instructions, don't note routine acknowledgments, don't tell subagents to call `cortex_brief` themselves, don't re-call `cortex_state` multiple times per session, and don't summarize throwaway sessions.

## Data

Cortex stores memory in `.cortex.db` in the repo root.

Add to `.gitignore`:

```text
.cortex.db
```

## License

MIT
