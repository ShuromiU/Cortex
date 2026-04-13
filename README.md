# Cortex

Persistent working memory for Claude Code and other MCP-compatible coding agents.

Cortex V2 is branch-aware, retrieval-first, and always-on friendly. It stores decisions, blockers, command outcomes, snapshots, and session summaries in a local SQLite database, then restores a small working set at session start and retrieves targeted context on demand.

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

- `SessionStart` can inject a Cortex header automatically.
- Cortex now supports branch-scoped restore: switching branches restores the right snapshot.
- `cortex_recall(topic)` searches notes, summaries, snapshots, and command/episode memory.
- `cortex_brief(topic)` returns a smaller, agent-friendly subset.
- touched and recalled memory stays hot; ignored memory decays out of the default state.

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

Run Cortex at the start of every Claude session:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cortex inject-header"
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
- prints a branch-aware header
- auto-engages Cortex for the new session

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

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cortex_state` | Return the current scored working set |
| `cortex_note` | Record an `insight`, `decision`, `intent`, `blocker`, or `focus` |
| `cortex_recall` | Retrieve evidence for a topic from memory |
| `cortex_brief` | Return a smaller topical brief, optionally for an agent |
| `cortex_engage` | Re-enable Cortex if it was disengaged |
| `cortex_disengage` | Disable Cortex hooks for the current session |
| `cortex_summarize` | Force a session summary/checkpoint |

## CLI Commands

```text
cortex inject-header
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

- let global settings start Cortex automatically
- write notes for real decisions, blockers, and non-obvious discoveries
- use `cortex_recall` before re-investigating prior work
- use `cortex_brief` before agent delegation when topic context matters
- use `cortex_summarize` when ending a dense work session and you want an explicit checkpoint

## Data

Cortex stores memory in `.cortex.db` in the repo root.

Add to `.gitignore`:

```text
.cortex.db
```

## License

MIT
