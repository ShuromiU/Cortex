# Cortex

Persistent working memory for coding agents.

## Current Model
- Cortex is now retrieval-first, not transcript-first.
- Sessions are branch/worktree-aware.
- `memory_items` is the canonical search/retrieval layer.
- Default state is a scored working set, not “all active notes”.
- Memory decays through `hot`, `warm`, `cold`, `archived`; recalled/touched memory is reinforced.

## What Matters In This Repo
- Keep the global Claude integration working: MCP server path, `inject-header`, and hook compatibility matter as much as the library code.
- When changing memory capture or retrieval, verify both the local API and the user-level Claude runtime path.
- If behavior changes, update:
  - `README.md`
  - this file
  - any consumer `CLAUDE.md` files that actually rely on Cortex workflows

## Core Files
- `src/db/schema.ts` — schema, migrations, FTS setup
- `src/db/store.ts` — canonical persistence/query surface
- `src/memory/items.ts` — memory-item text/state shaping
- `src/memory/hotness.ts` — decay/reinforcement scoring
- `src/query/retrieval.ts` — retrieval/reranking
- `src/query/state.ts` — startup/default working-set rendering
- `src/transports/cli.ts` — `inject-header`, CLI logging, evaluation
- `src/transports/mcp.ts` — MCP tools used by Claude

## Expected Behavior
- `inject-header` should create a scoped session, print a small header, and auto-engage Cortex.
- `cortex_state` should show the current working set, not a full historical dump.
- `cortex_recall` and `cortex_brief` should search notes, snapshots, summaries, and command/episode memory.
- Branch switches should restore the matching snapshot.
- Stale notes should decay out of the default state unless reinforced by actual retrieval/use.

## Verification
- Run `npm run build`
- Run `npm run lint`
- Run `npx vitest run`
- If the change affects real Claude usage, verify:
  - `~/.claude/settings.json`
  - `~/.claude/hooks/cortex-hook.sh`
  - the live path Claude uses for the Cortex MCP server
