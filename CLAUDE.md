# Cortex

Persistent working memory for coding agents.

## Current Model
- Cortex is now retrieval-first, not transcript-first.
- Sessions are branch/worktree-aware.
- `memory_items` is the canonical search/retrieval layer.
- Default state starts with current-session load-bearing notes, then uses the scored working set.
- Cortex tracks a lightweight current app graph and validates file/path references extracted from memory before treating old notes as current.
- Memory decays through `hot`, `warm`, `cold`, `archived`; recalled/touched memory is reinforced.
- Note-backed recall, brief, state, and reflex output includes compact UTC timestamps.
- Retrieval quality can be benchmarked with fixture suites, and optional semantic retrieval is gated by `CORTEX_SEMANTIC_MODE=off|shadow|rank`.

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
- `src/memory/references.ts` — file/path reference extraction from memory text
- `src/query/retrieval.ts` — retrieval/reranking
- `src/query/reference-validation.ts` — current-checkout validation and stale-reference scoring
- `src/query/validate-memory.ts` — diagnostic memory validation reports
- `src/query/reflex.ts` — focus-shift memory reflex for hook `additionalContext`
- `src/query/state.ts` — startup/default working-set rendering
- `src/query/recall.ts` — `cortex_recall` search
- `src/query/brief.ts` — `cortex_brief` topical context
- `src/query/summarize.ts` — `cortex_summarize` session wrap-up
- `src/query/suggest-notes.ts` — non-mutating note suggestions
- `src/query/scope.ts` — branch/worktree session scoping
- `src/transports/cli.ts` — `inject-header`, `route`, `reflect`, CLI logging, evaluation
- `src/transports/hook-entry.ts` — JSON hook bridge for Codex/Claude wrappers
- `src/transports/mcp.ts` — MCP tools used by Claude
- `~/.codex/AGENTS.md` — global Codex guidance that must stay aligned with Cortex consult policy for new projects outside this repo

## Expected Behavior
- `inject-header --quiet` is wired to SessionStart for ambient capture. It creates a scoped session and flips the engagement file to `enabled=true` without dumping a large header.
- `cortex reflect` is hook-facing and emits short `additionalContext` only for high-confidence remembered focus shifts; silence is the default.
- `cortex_route` / `cortex route` are the cold-callable capability map.
- `cortex_state` should show current-session load-bearing notes first, then the current working set, not a full historical dump.
- Empty `cortex_state` should return actionable fallback guidance, not an empty string.
- `cortex_recall` and `cortex_brief` should search notes, snapshots, summaries, and command/episode memory.
- Retrieval should rank current-valid memories above memories pointing at missing files, and stale memories should be labeled rather than silently trusted.
- Note renderers should preserve `Kind [YYYY-MM-DD HH:mmZ]: ...` timestamp format for agent-readable chronology.
- Retrieval should expose score breakdowns for quality evaluation and respect temporal terms such as latest/current, old/history, resolved, and when.
- Semantic ranking must remain optional; `off` is default, `shadow` must not change returned results, and `rank` must be tested with deterministic fake providers.
- Branch switches should restore the matching snapshot.
- Branch snapshot summaries and recent-session tails should not be raw command-only hook activity.
- Stale notes should decay out of the default state unless reinforced by actual retrieval/use.
- Resolved notes should remain cold even when retrieved, and should not trigger reflex `additionalContext`.
- Prompt and PreToolUse hooks repeat a fact-silent Cortex consult gate for memory-relevant work until route/state/recall/brief/engage or topic-based validate-memory is called.
- Prompt reflex should not inject memory facts from UserPromptSubmit text.

## When To Use Cortex

**Cortex is ambient for trivial new work.** For non-trivial familiar work, recurring bugs, resumed features, and systems with prior decisions, consult Cortex before planning or tool use. This is not an always-call-`cortex_state` ritual: prefer `cortex_recall(topic)` for a known area, `cortex_state` for broad resumptions, and `cortex_route` when you need the capability map.

Available tools:

- `cortex_route` — compact capability map and routing guidance.
- `cortex_engage` — re-enable Cortex capture after `cortex_disengage`.
- `cortex_state` — explicit state: current-session load-bearing notes, top-scored notes, branch snapshot, last-session tail; empty state returns next-step guidance.
- `cortex_note(kind, content, ...)` — durable memory. `kind` is one of `decision` (include `alternatives`), `insight`, `blocker`, `intent`, `focus`. Reserve for load-bearing items; skip routine progress.
- `cortex_suggest_notes` — review proposed load-bearing notes from the current session without writing them.
- `cortex_validate_memory(topic?)` — audit retrieved or recent memories against the current checkout without deleting notes. A topic-based call counts as Cortex consultation for hook gate suppression.
- `cortex_recall(topic)` — explicit search over notes/snapshots/summaries/episodes when prior work may matter; use proactively for familiar non-trivial areas, recurring bugs, resumed features, and systems with prior decisions.
- `cortex_brief(topic)` — compact topical context to paste into a subagent prompt. Call it yourself; don't ask subagents to call it.
- `cortex_summarize` — checkpoint a dense session so the next one resumes gracefully.
- `cortex_disengage` — turn capture and reflex off for the current session.

Anti-patterns (still apply once engaged):
- Don't write notes for routine acknowledgments, task tracking, or anything obvious from code/git.
- Don't re-call `cortex_state` multiple times per session.
- Don't call `cortex_summarize` for throwaway sessions.
- Don't tell the model to perform startup memory rituals; hook wiring owns ambient capture.

## Verification
- Run `npm run build`
- Run `npm run lint`
- Run `npx vitest run`
- For retrieval changes, run a fixture-backed `cortex evaluate --suite <path>` when a suitable suite exists.
- If the change affects real Claude usage, verify:
  - `~/.claude/settings.json`
  - `~/.claude/hooks/cortex-hook.sh`
  - the live path Claude uses for the Cortex MCP server

## RefCertify — Codebase Index

Cortex's source at `C:\Claude Code\cortex` is indexed by RefCertify. Strict Saver posture: use RefCertify when it improves quality per token; raw `rg`/`Read`/Grep stays right for literal strings, exact paths, configs, logs, markdown, and generated text. Hook nudges are advisory, not gates. Every tool accepts `compact: true` for smaller payloads.

**Tool picks:** `refcertify_outline` (file shape) · `refcertify_find`/`refcertify_search` (symbols) · `refcertify_source` (one exact symbol) · `refcertify_slice` (symbol + direct helpers) · `refcertify_grep` (scoped raw text) · `refcertify_refs`/`refcertify_deps`/`refcertify_callers` (impact). `refcertify_help` is the compact router; `refcertify_route` is an evidence-grounded advisor, not a gate — treat its recommendation as a hint.

**High-leverage tools for refactor work in this repo:**
- `refcertify_callers(name)` — who calls a memory/retrieval function before you change its signature.
- `refcertify_diff_outline(refA, refB?)` — semantic diff of changed symbols across refs (great for reviewing migrations to `memory_items` or hotness).
- `refcertify_signatures([names])` — batch signature lookup when comparing query/* methods.
- `refcertify_unused_exports({path: 'src/'})` — dead-code finder; flag pre-`memory_items`-era exports.
- `refcertify_kind_index('interface', {path: 'src/db'})` — every type in a subtree.

`refcertify_pack` is last resort for broad context. It runs governor preflight and refuses only on strong evidence (telemetry gate fail, zero index evidence, true literal/config needle, extreme budget); use `preflight:true` to inspect, `force:true` only when broad context is intentional.

**Worktree rule:** RefCertify answers are root-bound. In a git worktree or any checkout other than the session's start root, confirm the active root via `refcertify_stats`/`refcertify_workspace` and bind it with `refcertify_workspace {action:"use", path:"<toplevel>"}` before trusting answers.
