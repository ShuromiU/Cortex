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
- `inject-header` should create a scoped session, print a small decision-oriented header, and auto-engage Cortex without pretending `cortex_state` already ran.
- `cortex_state` should show the current working set, not a full historical dump.
- `cortex_recall` and `cortex_brief` should search notes, snapshots, summaries, and command/episode memory.
- Branch switches should restore the matching snapshot.
- Stale notes should decay out of the default state unless reinforced by actual retrieval/use.

## When To Use Cortex (Trigger Conditions)

Use Cortex selectively. Skip trivial one-shot work; reach for it when prior context is likely to matter.

Call these voluntarily when the trigger fires — don't wait to be told.

- `cortex_state` — at the start of resumed, branch-sensitive, or otherwise non-trivial work in this repo, or after a branch switch. Rarely need to re-call within a session.
- `cortex_note(kind=decision, alternatives=[...])` — after a design pivot or trade-off call. Always include what you rejected and why.
- `cortex_note(kind=insight)` — when you discover a concrete value, constraint, or gotcha easy to hallucinate later: real dimensions, exact constants, non-obvious API behavior, flaky-test triggers.
- `cortex_note(kind=blocker)` — when you hit a dead end you want your next self to skip.
- `cortex_note(kind=intent|focus)` — when you commit to an approach and want the next session to pick up from it.
- `cortex_recall(topic)` — before re-investigating something that feels familiar.
- `cortex_brief(topic)` — before dispatching a subagent on a non-trivial task with history in this repo. Paste the result into the agent's prompt yourself.
- `cortex_summarize` — at the end of a dense work session so the next one resumes gracefully.
- `cortex_disengage` — before running throwaway/destructive work you don't want memorialized, or while debugging Cortex itself. Pair with `cortex_engage` to resume.

Anti-patterns:
- Don't write notes for routine acknowledgments, task tracking, or anything obvious from code/git.
- Don't tell subagents to call `cortex_brief` — call it yourself and paste the result.
- Don't re-call `cortex_state` multiple times per session.
- Don't call `cortex_summarize` for throwaway sessions.

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
