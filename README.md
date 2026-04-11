# Cortex

Working memory for AI agents. Cortex gives Claude Code (and other MCP-compatible agents) persistent cognitive state across sessions -- decisions, intents, blockers, and insights survive context window resets.

## What it does

Every AI coding session starts from zero. Cortex fixes that by maintaining a per-project SQLite database that tracks:

- **Notes** -- decisions, intents, blockers, insights, and focus areas recorded by the agent
- **Events** -- file reads, edits, writes, commands, and sub-agent delegations
- **Session state** -- compressed summaries produced by 3-level consolidation
- **Token ledger** -- tracks tokens spent vs saved by compression

On each new session, Cortex injects a context header with the current project state so the agent picks up where it left off.

## Install

```bash
npm install -g cortex-memory
```

## Setup with Claude Code

### 1. Register the MCP server

Add to your `~/.claude/settings.json`:

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

### 2. Add session hooks

Add to the `hooks` section of your `~/.claude/settings.json`:

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

This runs `cortex inject-header` at the start of each session, which:
- Consolidates any unconsolidated previous sessions
- Merges older session states into project-level state
- Creates a new session
- Prints a context header for the agent

### 3. (Optional) Track file activity

To capture reads, edits, and commands as events, add a PostToolUse hook that calls `cortex log`. See the CLI commands below for the full set of event types.

## MCP Tools

When running as an MCP server (`cortex serve`), Cortex exposes 4 tools:

| Tool | Description |
|------|-------------|
| `cortex_state` | Get the full cognitive state: active notes, recent session activity, project state |
| `cortex_note` | Record a note (insight, decision, intent, blocker, or focus) to working memory |
| `cortex_recall` | Search notes and consolidated state for a topic |
| `cortex_brief` | Generate a focused briefing on a topic, optionally for a named agent |

## CLI Commands

```
cortex inject-header    Consolidate + start session + print context header
cortex status           Print DB status
cortex stats            Token savings dashboard
cortex consolidate      Manually trigger Level 1 consolidation
cortex serve            Start the MCP server (stdio transport)
cortex log read         Log a file read event
cortex log edit         Log a file edit event
cortex log write        Log a file write event
cortex log cmd          Log a command execution event
cortex log agent        Log a sub-agent delegation event
```

## How consolidation works

Cortex uses a 3-level compression pipeline to keep context small:

**Level 1 -- Rule-based compression** (per-session)
- Collapses repeated file access into counts with line ranges
- Detects test-fix cycles (fail, edit, fail, edit, pass) and compresses to "fixed after N iterations"
- Deduplicates consecutive events on the same target

**Level 2 -- Session summaries**
- Ended sessions get their raw events replaced with a compressed summary
- Sub-agent notes are promoted to the parent session with conflict detection

**Level 3 -- Cross-session merge**
- When session count exceeds a threshold, older session summaries merge into a single project-level state
- Active notes are preserved; stale context is truncated

## Programmatic API

```typescript
import { openDatabase, applySchema, CortexStore } from 'cortex-memory';

const db = openDatabase('.cortex.db');
applySchema(db);
const store = new CortexStore(db);

// Create a session
const session = store.createSession({ focus: 'auth-refactor' });

// Record a note
store.insertNote({
  sessionId: session.id,
  kind: 'decision',
  subject: 'auth',
  content: 'Use JWT with short-lived tokens + refresh token rotation',
  alternatives: ['Session cookies', 'OAuth2 only'],
});

// Query active notes
const notes = store.getActiveNotes();

// Build the full state for injection
import { buildFullState } from 'cortex-memory';
const state = buildFullState(store);
```

## Data storage

Cortex stores data in a `.cortex.db` SQLite file in the project root. Add it to `.gitignore`:

```
.cortex.db
```

## License

MIT
