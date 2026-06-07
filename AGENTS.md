# Cortex

## Working Rules

- Cortex is ambient memory. SessionStart quietly enables capture, and the reflex may surface short prior context without a model ritual for trivial new work.
- Consult Cortex before non-trivial familiar or resumed work, recurring bugs, app/debugging sessions, or systems with prior decisions. Use `cortex_recall` for a known topic, `cortex_state` for the broader working set, `cortex_route` for the capability map, and `cortex_brief` before delegation when topic history matters.
- Use `cortex_validate_memory` when retrieved notes mention files, plans, or app structure that may be stale; repo truth beats memory.
- Write `cortex_note` entries for real decisions, blockers, and non-obvious discoveries.

## Repo Priorities

- Keep the retrieval-first memory model intact: `memory_items` is the canonical search layer and the default state is the scored working set.
- Keep current-checkout validation intact: memories can be historical evidence, but missing file/path references must be demoted or labeled before being returned as current guidance.
- Global integration paths matter as much as library code. Changes that affect startup, logging, or MCP behavior must keep Codex and Claude integrations coherent.
- Update `README.md` and `CLAUDE.md` when user-visible behavior changes.

## Verification

- Run `npm run build`.
- Run `npm run test`.
- Run `npm run lint`.
