# Cortex

## Working Rules

- Start by calling `cortex_state` when the MCP server is available. Codex on Windows does not get Claude-style startup injection natively, so this is a required first step for substantial work.
- Use `cortex_recall` before repeating prior investigation and `cortex_brief` before delegating work to an agent.
- Write `cortex_note` entries for real decisions, blockers, and non-obvious discoveries.

## Repo Priorities

- Keep the retrieval-first memory model intact: `memory_items` is the canonical search layer and the default state is the scored working set.
- Global integration paths matter as much as library code. Changes that affect startup, logging, or MCP behavior must keep Codex and Claude integrations coherent.
- Update `README.md` and `CLAUDE.md` when user-visible behavior changes.

## Verification

- Run `npm run build`.
- Run `npm run test`.
- Run `npm run lint`.
