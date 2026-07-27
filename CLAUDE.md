# Cortex

Persistent working memory for coding agents.

## Current Model
- Cortex is retrieval-first, not transcript-first, and pull-based, not push-based: a tiny validated session brief at startup plus the high-confidence reflex are the memory channels; coercion is reduced to one one-line hint per session.
- Sessions are branch/worktree-aware.
- `memory_items` is the canonical search/retrieval layer.
- Default state starts with current-session load-bearing notes, then uses the scored working set, within a token budget.
- Cortex tracks a lightweight current app graph, validates file/path references extracted from memory, and resolves renamed files through a git rename map (`[moved:]`) instead of treating them as missing.
- Memory decays through `hot`, `warm`, `cold`, `archived`; recalled/touched memory is reinforced; `cortex gc` bounds growth of derived data (dry-run by default).
- Ambient capture is spooled (`.cortex.spool.jsonl`, bash append, batch flush at turn end / 256 KiB / next session start) instead of spawning Node per tool call; engagement state lives in `<project>/.cortex.state`.
- Note-backed recall, brief, state, and reflex output includes compact UTC timestamps; recall/brief are answer-shaped and budgeted.
- Retrieval quality is benchmarked with hermetic seeded fixture suites in `eval/suites/` (reference results in `eval/baselines/`); optional semantic retrieval is gated by `CORTEX_SEMANTIC_MODE=off|shadow|rank`.

## What Matters In This Repo
- Keep the global Claude integration working: MCP server path, `inject-header`, and hook compatibility matter as much as the library code.
- When changing memory capture or retrieval, verify both the local API and the user-level Claude runtime path.
- If behavior changes, update:
  - `README.md`
  - this file
  - any consumer `CLAUDE.md` files that actually rely on Cortex workflows

## Agent Tooling
- **Deferred MCP schemas:** Tool discovery failures are not service failures by default. Prefer callable-name discovery (`ToolSearch`/`tool_search` query `refcertify_help`, `refcertify_outline`, `cortex_recall`) or server-name bootstrap (`RefCertify`, `Cortex`) as the primary path. Canonical Codex selectors such as `select:mcp__refcertify__refcertify_help` or `select:mcp__cortex__cortex_recall` are not authoritative on current Codex app-server builds and may return 0 even when MCP runtime calls are healthy.
- **Context7:** Use for current library/framework/SDK/API/CLI/cloud-service docs, setup, config, migrations, and code examples. First call `resolve-library-id` with the library name and full user question, choose the best match, then call `query-docs` with the selected ID and full question. Do not use it for local repo truth, business logic, code review, exact strings, logs, or general programming concepts.
- **BMAD:** Use for product/feature planning, PRDs, architecture, epics/stories, implementation readiness, sprint/story workflows, major scope changes, or explicit BMAD/persona requests. Start with `bmad-help` when unsure; prefer direct Claude/Codex flow for small well-scoped code changes.

## Core Files
- `src/db/schema.ts` — schema, migrations, FTS setup
- `src/db/store.ts` — canonical persistence/query surface
- `src/db/gc.ts` — derived-data pruning, ledger rollup, VACUUM policy
- `src/memory/items.ts` — memory-item text/state shaping
- `src/memory/hotness.ts` — decay/reinforcement scoring
- `src/memory/kind-weights.ts` — single source of truth for kind weighting (retrieval vs working-set profiles)
- `src/memory/references.ts` — file/path reference extraction from memory text
- `src/memory/text.ts` — `TOKEN_PATTERN` + `stemLite`, the text primitives shared by the write path and the rerank layer
- `src/memory/conflict.ts` — deterministic contradiction detection over note content
- `src/query/tokenize.ts` — topic tokenization for the rerank layer; re-exports the `memory/text.ts` primitives
- `src/query/retrieval.ts` — retrieval/reranking
- `src/query/reference-validation.ts` — `ReferenceValidator` (memoized, batched), rename/moved resolution, graduated stale scoring
- `src/query/validate-memory.ts` — diagnostic memory validation reports
- `src/query/reflex.ts` — focus-shift memory reflex for hook `additionalContext`
- `src/query/state.ts` — startup/default working-set rendering (budgeted)
- `src/query/session-brief.ts` — the SessionStart pull channel (validated ≤150-token brief)
- `src/query/recall.ts` — `cortex_recall` search (answer-shaped, budgeted)
- `src/query/brief.ts` — `cortex_brief` topical context
- `src/query/summarize.ts` — `cortex_summarize` session wrap-up
- `src/query/suggest-notes.ts` — non-mutating note suggestions with confidence
- `src/query/scope.ts` — branch/worktree session scoping
- `src/capture/spool.ts` — JSONL capture spool: append, atomic claim, idempotent flush
- `src/eval/seed.ts` — hermetic scenario seeding for quality suites
- `src/eval/gate.ts` — the locked retrieval-quality gate (suite discovery, comparison, AD-5 kind coverage, baseline regeneration)
- `src/transports/cli.ts` — `inject-header`, `route`, `reflect`, `flush-spool`, `gc`, `install-hooks`, evaluation
- `src/transports/hook-entry.ts` — JSON hook bridge (reflex, one-shot consult hint, `end-of-turn`)
- `src/transports/mcp.ts` — MCP tools used by Claude (incl. engagement state at `<project>/.cortex.state`)
- `hooks/claude/*.sh` — canonical hook script templates installed by `cortex install-hooks`
- `eval/suites/` + `eval/baselines/` — locked retrieval-quality fixtures and reference results
- `~/.codex/AGENTS.md` — global Codex guidance that must stay aligned with Cortex consult policy for new projects outside this repo

## Expected Behavior
- `inject-header --quiet` is wired to SessionStart. It flushes leftover spool lines into the session they belong to, creates a scoped session, flips `<project>/.cortex.state` to `enabled=true`, and prints the validated session brief (≤150 tokens) — or nothing on a cold start.
- `cortex reflect` is hook-facing and emits short `additionalContext` only for high-confidence remembered focus shifts; silence is the default.
- `cortex_route` / `cortex route` are the cold-callable capability map.
- Deferred tool discovery should use callable-name discovery (`ToolSearch`/`tool_search` query `cortex_recall`, `cortex_state`, or `cortex_route`) or server-name bootstrap (`Cortex`). Canonical `select:mcp__cortex__...` selectors may return 0 on current Codex app-server builds and are not proof Cortex is unavailable.
- `cortex_state` should show current-session load-bearing notes first, then the current working set, within its budget (default 800 tokens), never an empty `Branch snapshot:` header or duplicated evidence lines.
- Empty `cortex_state` should return actionable fallback guidance, not an empty string.
- `cortex_recall` and `cortex_brief` should search notes, snapshots, summaries, and command/episode memory, lead with a most-relevant line plus trust label, and respect their budgets.
- Retrieval should rank current-valid memories above memories pointing at missing files; stale memories stay reachable in top results with a `[stale: missing ...]` label (graduated capped penalty, never buried); renamed files resolve to `[moved: a → b]` via the rename map or unique-basename fallback.
- The rerank layer counts stemmed token hits (`testing` matches `test flake`); the FTS layer already stems via its porter tokenizer.
- Note renderers should preserve `Kind [YYYY-MM-DD HH:mmZ]: ...` timestamp format for agent-readable chronology.
- Retrieval should expose score breakdowns (`detail: 'scores'`) for quality evaluation and respect temporal terms such as latest/current, old/history, resolved, and when.
- Semantic ranking must remain optional; `off` is default, `shadow` must not change returned results, and `rank` must be tested with deterministic fake providers.
- Sessions are identified by `(scope_key, agent_id)`. A hook payload carrying `agent_id` resolves to a child session created on demand under the active primary — recording `parent_session_id` and `agent_type`, inheriting the primary's scope — and a payload without one resolves to the primary. A subagent payload never rotates or ends the primary it belongs to, whatever its own `cwd` resolves to. `reflect-*` and `end-of-turn` resolve to the primary by design.
- The PostToolUse hook writes `agent_id`/`agent_type` onto each spool line, omitting both when absent, and the flush resolves every entry to its own session — so subagent tool calls reach their own child session on the installed Claude path, not just through direct `hook-entry post` calls. Lines written by a hook installed before agent identity carry no such fields and still resolve to the primary; re-run `cortex install-hooks --claude` to update a stale script.
- The `command_failure` fold is scoped to the recording session: a repeated identical failure within one session bumps its occurrence count, but two sessions that each hit the same failure each keep their own episode. Unscoped, whichever session failed first owned the episode — so a subagent failing before its parent left the parent with none, and reheated the child's memory item on the parent's activity.
- Branch switches should restore the matching snapshot.
- Branch snapshot summaries and recent-session tails should not be raw command-only hook activity, and should not include child-session activity — scoped session listings and counts, and the scope anchor, read primary sessions only. Unscoped store totals (`cortex status`) still count every session.
- Ending a session ends its still-active children, so subagent sessions stay reachable by consolidation and event GC, both of which require `status = 'ended'`.
- Stale notes should decay out of the default state unless reinforced by actual retrieval/use.
- Resolved notes should remain cold even when retrieved, and should not trigger reflex `additionalContext`; `cortex_resolve` is the explicit close-out path.
- Writing a note whose content **opposes** an active `note:decision` on the same subject marks both sides `conflict = 1` and returns a payload naming the prior's id, subject, timestamp and text. The write always succeeds — a conflict is advisory metadata, never a rejection. A note with no subject issues no detection query at all.
- Detection is deterministic and offline: an explicit polarity flip over demonstrably shared context. A negation counts only when it **governs a predicate the other note also asserts** — "use postgres, not mysql" refines "use postgres" rather than contradicting it. Negators match raw surface forms, never stems (`stemLite('noted') === 'not'`), and a fragment of a compound is not a negator (`--no-verify`, `src/capture/no-op.ts`). An antonym flip additionally requires near-identical remaining content, so `required for rank mode` vs `optional for shadow mode` is not a contradiction. Overlap divides by the **larger** core, so a short note cannot be contained into a match.
- Contradiction detection is scope-keyed — a decision on another branch is not a contradiction of this one. Auto-supersede stays scope-blind, as it always was.
- Conflict detection runs **before** auto-supersede and vetoes it (AD-17): a contested prior stays `active` rather than being flipped to `superseded`, which `memoryStateForNote` would map to `archived` — burying one side of the contest at write time. The veto covers priors **already** carrying `conflict = 1`, not just those the incoming write contradicts; otherwise a later unrelated decision closes an open contest by archiving both sides. Non-contested priors supersede exactly as before.
- `cortex_resolve` closes a contest: resolving either side clears `conflict` on every note for that subject in scope, so the survivor stops rendering as contested. While a contest is open, resolving **by subject** is refused with both ids — the "one active note per (kind, subject)" invariant no longer holds, so `findActiveNoteBySubject` would otherwise silently resolve the newest and leave the retracted decision live. A `replacement` write skips detection; it is explicit resolution, not a new contest.
- The whole note write is one **IMMEDIATE** transaction. Detect → supersede → insert → mark is four statements, and a concurrent writer landing between them supersedes the row the write just decided to protect. Deferred is not sufficient: it takes the write lock lazily, so the read-then-write upgrade fails with `SQLITE_BUSY_SNAPSHOT`, which bypasses the busy handler — losing the veto *and* discarding the note.
- The supersede veto over contested priors is deliberately **not** scope-filtered, even though detection is. Auto-supersede is scope-blind, so scoping the veto would let a decision on one branch archive one side of an open contest on another.
- The UserPromptSubmit hook may add a one-line consult hint **at most once per session** for memory-relevant prompts; there is no PreToolUse gate. Route/state/recall/brief/engage or topic-based validate-memory suppresses it.
- The Stop hook nudges (`decision:block`) only when a subagent ran this turn AND suggest-notes returns high-confidence candidates, embedding them; otherwise it is silent. `CORTEX_STOP_NUDGE=off` disables it.
- Per-tool-call capture must not spawn Node: PostToolUse appends to the spool; flush happens at turn end, the 256 KiB threshold, or next session start, exactly once per batch (atomic claim + processed marker).
- Prompt reflex should not inject memory facts from UserPromptSubmit text.

## When To Use Cortex

**Cortex is ambient for trivial new work.** For non-trivial familiar work, recurring bugs, resumed features, and systems with prior decisions, consult Cortex before planning or tool use. This is not an always-call-`cortex_state` ritual: prefer `cortex_recall(topic)` for a known area, `cortex_state` for broad resumptions, and `cortex_route` when you need the capability map.

Available tools:

- `cortex_route` — compact capability map and routing guidance.
- `cortex_engage` — re-enable Cortex capture after `cortex_disengage`.
- `cortex_state` — explicit state: current-session load-bearing notes, top-scored notes, branch snapshot, last-session tail; empty state returns next-step guidance.
- `cortex_note(kind, content, ...)` — durable memory. `kind` is one of `decision` (include `alternatives`), `insight`, `blocker`, `intent`, `focus`. Reserve for load-bearing items; skip routine progress.
- `cortex_resolve(note_id | subject, status?, replacement?)` — close out a note as resolved/superseded; with `replacement`, supersede and write the updated note in one step.
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
- Run `npm run gate` — every locked suite against its baseline in one command, plus AD-5 kind coverage. Names the suite and metric and exits non-zero on: a negative `top1_hit`/`recall_at_3` delta, a positive `output_tokens` delta, a failing fixture assertion, a suite with no baseline, a **baseline with no suite** (a deleted suite must not silently stop gating), a baseline **missing** a metric (absent values compare as `NaN`, which would otherwise un-gate it), a suite that asserts nothing, or an unexercised registered kind. `noise_count` and `stale_count` are reported, not gated. CI runs it on every push. (`evaluate --suite … --compare …` remains the single-suite human view; it always exits 0 and is not a gate.)
- Baselines in `eval/baselines/` and `eval/kind-coverage.json` are locked artifacts. Change one via `cortex eval-gate --regenerate-baseline <suite>` with a `Baseline-Regenerated: <reason>` line in the body of the commit that makes the change; CI rejects it otherwise. Regenerating is never the way to turn a red gate green.
- A change introducing a new `memory_items` kind must add a locked fixture exercising it in the same change (AD-5). `eval/kind-coverage.json` grandfathers the kinds that predate the gate; adding to that list is not how to pass it.
- If the change affects real Claude usage, verify:
  - `~/.claude/settings.json`
  - `~/.claude/hooks/cortex-capture.sh`, `cortex-reflect.sh`, `cortex-end-of-turn.sh` (installed via `cortex install-hooks --claude`)
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
