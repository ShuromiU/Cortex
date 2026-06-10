# Cortex

## Working Rules

- Cortex is ambient memory, pull-based: SessionStart quietly enables capture and prints a small validated brief of prior branch context when one exists; the reflex may surface short prior context on focus shifts. No model rituals for trivial new work.
- Consult Cortex before non-trivial familiar or resumed work, recurring bugs, app/debugging sessions, or systems with prior decisions. Use `cortex_recall` for a known topic, `cortex_state` for the broader working set, `cortex_route` for the capability map, and `cortex_brief` before delegation when topic history matters.
- Use `cortex_validate_memory` when retrieved notes mention files, plans, or app structure that may be stale; repo truth beats memory. Recall output labels stale (`[stale:]`) and renamed (`[moved:]`) references.
- Write `cortex_note` entries for real decisions, blockers, and non-obvious discoveries; close them out with `cortex_resolve` when they stop being true.

## RefCertify

- This repo is indexed by RefCertify. Use it for structural code questions (`refcertify_outline`, `refcertify_find`/`refcertify_search`, `refcertify_source`/`refcertify_slice`, `refcertify_refs`/`refcertify_deps`/`refcertify_callers`); raw `rg` or direct reads stay right for literals, configs, logs, and markdown.
- `refcertify_route` is an evidence-grounded advisor, not a gate; `refcertify_pack` is last resort and preflights itself (`force:true` only when broad context is intentional).
- RefCertify answers are root-bound: in a git worktree or second checkout, confirm the active root via `refcertify_stats`/`refcertify_workspace` and bind it with `refcertify_workspace {action:"use", path:"<git toplevel>"}`.

## Repo Priorities

- Keep the retrieval-first memory model intact: `memory_items` is the canonical search layer and the default state is the scored working set.
- Keep current-checkout validation intact: memories can be historical evidence, but missing file/path references must be demoted or labeled before being returned as current guidance.
- Global integration paths matter as much as library code. Changes that affect startup, logging, or MCP behavior must keep Codex and Claude integrations coherent.
- Update `README.md` and `CLAUDE.md` when user-visible behavior changes.

## Verification

- Run `npm run build`.
- Run `npm run test`.
- Run `npm run lint`.
