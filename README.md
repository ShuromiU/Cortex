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

## Core Behavior

- `SessionStart` quietly enables capture with `cortex inject-header --quiet`.
- `cortex reflect` can emit short hook `additionalContext` on high-confidence focus shifts.
- Cortex now supports branch-scoped restore: switching branches restores the right snapshot.
- `cortex_route` / `cortex route` provide the cold-callable capability map.
- `cortex_recall(topic)` searches notes, summaries, snapshots, and command/episode memory.
- `cortex_brief(topic)` returns a smaller, agent-friendly subset.
- `cortex_state` shows current-session load-bearing notes first, then branch snapshots and the scored working set.
- Branch snapshot summaries prefer session summaries, notes, and file/test/agent activity over raw command-only hook noise.
- touched and recalled memory stays hot; ignored memory decays out of the default state.
- resolved notes stay cold and do not trigger hook reflex whispers.
- UserPromptSubmit prompt hooks stay silent; edit and command reflexes still require high-confidence prior context.

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
| `cortex_state` | Return current-session notes first, then the scored working set |
| `cortex_note` | Record an `insight`, `decision`, `intent`, `blocker`, or `focus` |
| `cortex_recall` | Retrieve evidence for a topic from memory |
| `cortex_brief` | Return a smaller topical brief, optionally for an agent |
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

Retrieval is hybrid:
- FTS over `memory_items`
- scope-aware reranking
- recency/importance/access reinforcement
- hot/warm/cold decay

## Recommended Usage

Cortex should feel ambient. Let hooks capture activity and let the reflex stay silent unless it has high-confidence prior context.

- Use `cortex_route` when you need the capability map.
- Use `cortex_recall(topic)` or `cortex_state` only when you explicitly need more context than the reflex surfaced.
- Use `cortex_brief(topic)` before dispatching a subagent when topic history matters.
- Use `cortex_note(decision, alternatives=[...])`, `cortex_note(insight)`, or `cortex_note(blocker)` for load-bearing memory only.
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
