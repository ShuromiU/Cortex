# Cortex

## Working Rules

- Cortex is ambient memory. SessionStart quietly enables capture, and the reflex may surface short prior context without a model ritual.
- Use `cortex_route` when you need the Cortex capability map. Use `cortex_recall`, `cortex_state`, or `cortex_brief` only when you explicitly need more context than the reflex provides.
- Write `cortex_note` entries for real decisions, blockers, and non-obvious discoveries.

## Repo Priorities

- Keep the retrieval-first memory model intact: `memory_items` is the canonical search layer and the default state is the scored working set.
- Global integration paths matter as much as library code. Changes that affect startup, logging, or MCP behavior must keep Codex and Claude integrations coherent.
- Update `README.md` and `CLAUDE.md` when user-visible behavior changes.

## Verification

- Run `npm run build`.
- Run `npm run test`.
- Run `npm run lint`.
