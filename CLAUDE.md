# Cortex

Persistent working memory for coding agents.

## Current Model
- Cortex is now retrieval-first, not transcript-first.
- Sessions are branch/worktree-aware.
- `memory_items` is the canonical search/retrieval layer.
- Default state is a scored working set, not "all active notes".
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
- `src/query/recall.ts` — `cortex_recall` search
- `src/query/brief.ts` — `cortex_brief` topical context
- `src/query/summarize.ts` — `cortex_summarize` session wrap-up
- `src/query/scope.ts` — branch/worktree session scoping
- `src/transports/cli.ts` — `inject-header`, CLI logging, evaluation
- `src/transports/mcp.ts` — MCP tools used by Claude

## Expected Behavior
- `inject-header` is a manual CLI command. It is no longer wired to `SessionStart` — running it creates a scoped session, prints a decision-oriented header, and flips the engagement file to `enabled=true`, but Claude Code sessions do not trigger it automatically.
- `cortex_state` should show the current working set, not a full historical dump.
- `cortex_recall` and `cortex_brief` should search notes, snapshots, summaries, and command/episode memory.
- Branch switches should restore the matching snapshot.
- Stale notes should decay out of the default state unless reinforced by actual retrieval/use.

## When To Use Cortex

**Cortex is opt-in.** Do not call any `cortex_*` tool unless the user explicitly asks for Cortex, or has already called `cortex_engage` this session. No automatic startup calls, no "this feels non-trivial so I should load memory" reasoning.

When the user opts in (explicit request, or the engagement file shows `enabled=true`), the available tools are:

- `cortex_engage` — activate Cortex capture for the session and load the current working memory.
- `cortex_state` — working set: top-scored notes, decisions, branch snapshot, last-session tail.
- `cortex_note(kind, content, ...)` — durable memory. `kind` is one of `decision` (include `alternatives`), `insight`, `blocker`, `intent`, `focus`. Reserve for load-bearing items; skip routine progress.
- `cortex_recall(topic)` — search notes/snapshots/summaries/episodes before re-investigating familiar ground.
- `cortex_brief(topic)` — compact topical context to paste into a subagent prompt. Call it yourself; don't ask subagents to call it.
- `cortex_summarize` — checkpoint a dense session so the next one resumes gracefully.
- `cortex_disengage` — turn capture and enforcement back off.

Anti-patterns (still apply once engaged):
- Don't write notes for routine acknowledgments, task tracking, or anything obvious from code/git.
- Don't re-call `cortex_state` multiple times per session.
- Don't call `cortex_summarize` for throwaway sessions.
- Don't engage Cortex unprompted just because a task looks interesting.

## Verification
- Run `npm run build`
- Run `npm run lint`
- Run `npx vitest run`
- If the change affects real Claude usage, verify:
  - `~/.claude/settings.json`
  - `~/.claude/hooks/cortex-hook.sh`
  - the live path Claude uses for the Cortex MCP server

## Nexus — Codebase Index (use before Read/Grep on this repo)

Cortex's source lives at `C:\Claude Code\cortex` and is indexed by Nexus. Use Nexus MCP tools instead of Read/Grep when navigating the code. Every tool accepts `compact: true` (~50% smaller payloads).

**Workflow:** `nexus_outline` (file or array) → `nexus_source` (one symbol) → `nexus_slice` (symbol + referenced symbols) → `nexus_find` / `nexus_search` → `nexus_refs` → `nexus_deps` → `nexus_grep` → THEN Read.

**High-leverage tools for refactor work in this repo:**
- `nexus_callers(name)` — who calls a memory/retrieval function before you change its signature.
- `nexus_diff_outline(refA, refB?)` — semantic diff of changed symbols across refs (great for reviewing migrations to `memory_items` or hotness).
- `nexus_signatures([names])` — batch signature lookup when comparing query/* methods.
- `nexus_unused_exports({path: 'src/'})` — dead-code finder; flag pre-`memory_items`-era exports.
- `nexus_kind_index('interface', {path: 'src/db'})` — every type in a subtree.
- `nexus_pack(query, budget_tokens?)` — assemble a token-budgeted bundle for a question instead of guessing files.

**Grep is allowed only for non-code files** (markdown, JSON, yaml, config). The global `~/.claude/hooks/nexus-first.sh` enforces this.
