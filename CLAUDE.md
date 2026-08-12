# Cortex

A trust, freshness, and economy layer for coding-agent memory, not a transcript store. A remembered item carries whether it is still agreed (`[contested]`, `(superseded)`), whether it still describes the checkout (`[stale:`, `[moved:`), and what it cost (every retrieval channel budgeted; `cortex stats` reports injected/saved/net and a floored ratio for the session and the scope, plus retrieval health, and the credit side is **evidence-only** — the consolidation estimate that produced it is withdrawn, and the one mechanism that books real credit is verified read substitution, which is off until `cortex substitution on`). `README.md` carries the positioning and the honest comparison against platform auto-memory; the invariants log lives in `docs/invariants.md`.

## Current Model
- Cortex is retrieval-first, not transcript-first, and pull-based, not push-based: a tiny validated session brief at startup plus the high-confidence reflex are the memory channels; coercion is reduced to one one-line hint per session.
- Sessions are branch/worktree-aware. A dispatched subagent gets its own child session **at `SubagentStart`**, before it does anything, so a subagent that only thinks is still attributable; its captured tool activity then files under that same session.
- A dispatched subagent is **briefed automatically** from its dispatch description (FR-18): the description is captured at `PreToolUse` on the `Agent` tool, paired at `SubagentStart` on `(session_id, prompt_id, agent_type)`, and injected as a ≤150-token `additionalContext` brief billed to the child session. The cap is enforced on this surface rather than inherited — `assembleBudgeted` keeps its first line whatever its size. **More than one candidate means say nothing** (ruling, ShuromiU, 2026-08-07): the story's FIFO premise was measured false, and FIFO's real effect was handing a denied dispatch's context to the next same-type subagent. Silence is the default throughout — no matching memory, no unambiguous pairing, a brief the parent already pasted, or any failure emits nothing. `CORTEX_SUBAGENT_BRIEF=off` disables both the brief and the capture.
- **What a subagent concluded survives it (FR-19, Story 5.3).** At `SubagentStop` its final answer is written as a `subagent_conclusion` episode on the CHILD, into `episode.summary` — the ordering is a requirement, not a detail: `collectEvidence` reads episode summaries, events and command runs and never `last_assistant_message`, and for a child the other two are near-empty, so a subagent that only thinks produced nothing without it. The episode projects (episodes are captured); anything note-shaped stays a **suggestion** the parent chooses to write (AD-4). Each conclusion is offered ONCE, marked on the episode, because `getSessionTreeIds` is unfiltered and the primary rarely rotates. This hook is the only one in the epic that can block a subagent, so it swallows its own errors and honours `stop_hook_active`. `SubagentStop` also closes Story 5.2's deferred pairing audit against the host's per-agent sidecar — absent is not failed, and the mispairing count is the one counter here that warns.
- **A subagent may not retire, rewrite or delete memory from an earlier session (FR-19 AC #3).** Enforced at `PreToolUse` on `cortex_note`, `cortex_resolve` and `Bash`, because the MCP server cannot see a caller id and `PreToolUse` can deny. "Its own session" means its own session TREE (ruling (a)) — no note is ever stamped with a subagent's id. The guard runs `insertNote`'s own decision phase via `previewNoteWrite` rather than a copy of it, covers all three auto-supersede routes plus the shell, screens `Bash` in pure shell before Node (N-4), and **fails OPEN everywhere**. The parent is exempt: it is the acceptance path.
- `memory_items` is the canonical search/retrieval layer.
- Default state starts with current-session load-bearing notes, then uses the scored working set, within a token budget.
- Cortex tracks a lightweight current app graph, validates file/path references extracted from memory, and resolves renamed files through a git rename map (`[moved:]`) instead of treating them as missing.
- Memory decays through `hot`, `warm`, `cold`; recalled/touched memory is reinforced; `archived` is a preserved legacy tier (pre-1.4 supersedes) that no current path produces, still honored by every query filter and collected by GC. `cortex gc` bounds growth of derived data (dry-run by default).
- Ambient capture is spooled (`.cortex.spool.jsonl`, bash append, batch flush at turn end / 256 KiB / next session start) instead of spawning Node per tool call; engagement state lives in `<project>/.cortex.state`.
- Note-backed recall, brief, state, and reflex output includes compact UTC timestamps; recall/brief are answer-shaped and budgeted.
- Retrieval quality is benchmarked with hermetic seeded fixture suites in `eval/suites/` (reference results in `eval/baselines/`); optional semantic retrieval is gated by `CORTEX_SEMANTIC_MODE=off|shadow|rank`.

## What Matters In This Repo
- Keep the global Claude integration working: MCP server path, `inject-header`, and hook compatibility matter as much as the library code.
- When changing memory capture or retrieval, verify both the local API and the user-level Claude runtime path.
- If behavior changes, update:
  - `README.md`
  - `docs/invariants.md` (the invariants log)
  - this file
  - any consumer `CLAUDE.md` files that actually rely on Cortex workflows

## Agent Tooling
- **Workflow routing:** Treat the installed skill catalog and live `bmad-help` output as capability sources of truth. Inherit the user-wide Light → Lean, Medium → current BMad Quick Flow, Heavy → Full BMad fallbacks, and C4 boundary lens; these repo rules constrain execution rather than forcing a lane. Honor explicitly named installed skills, reconsider routing when evidence changes, and never use Superpowers.
- **Deferred MCP schemas:** Tool discovery failures are not service failures by default. Use callable-name discovery (`ToolSearch` query `cortex_recall`, or `select:mcp__cortex__cortex_recall`) or server-name bootstrap (`Cortex`).
- **Enumerate symbols with a language-server-backed tool, not with text search — this repo is the proof, not the illustration.** `findDbPath` had four copies before Story 2.4, and text search could not see one of them: `src/transports/hook-entry.ts` carried a raw NUL byte, so ripgrep and grep both classified the file as binary and skipped it **silently** (`rg -n` found two, `rg -na` three). A grep-only enumeration of that symbol returned a confident, complete-looking, wrong answer. **Story 4.5 removed the cause**: all four raw NULs (in `hook-entry.ts`, `reference-validation.ts` and — found by that story's byte-scan, contradicting the recorded set of two — `capture/spool.ts`) were composite-key separators and are now the six-character escape, identical at runtime. A test walks `src/`, `hooks/` and `tests/` and fails on any control byte other than tab, LF or CR, so the enumeration is no longer hand-maintained. The *rule* stands regardless: grep-invisibility was only one of the ways a text enumeration is wrong, and re-exports and aliased imports are the others.
- **Triggers.** Before any rename, signature change, or deletion in `src/db/store.ts`, `src/query/*.ts`, or `src/memory/*.ts`, enumerate every reference with a symbol-aware tool and act on the returned list — never on grep alone, and never on recall. Watch for identifiers that are **string literals backed by a differently-named symbol**: MCP tool names (`cortex_recall`), `source_table` values, hook action arguments, and `REQUIRED_WIRING` command strings are all dispatched by literal and cannot be linked to their handlers by any language server, so they need a text pass as well. Both methods finding sites the other missed is the normal case, and is itself the finding.
- **Delegation.** When handing review, refactor, or impact work to a subagent, bind the enumeration into the check itself rather than listing available tools — a toolkit preamble does not survive contact with grep-then-read. An answer about callers or blast radius that does not name the tool that produced it is incomplete: send it back or verify it yourself. An enumerated command list (build/test/gate/doctor) bounds verification, not exploration.
- **Context7:** For current external library/framework/API/CLI/cloud documentation, invoke the installed Context7 skill and follow its current instructions; repository truth wins for local Cortex behavior.
- **Specialists:** Compose the best current design, accessibility, review, debugging, research, or framework skill with the selected delivery lane when its trigger applies; no fixed list here overrides the live catalog.

## Core Files
- `src/db/schema.ts` — schema, migrations, FTS setup
- `src/db/store.ts` — canonical persistence/query surface
- `src/db/gc.ts` — derived-data pruning, ledger rollup, VACUUM policy, and the per-scope command-history bound applied at its SOURCE (FR-16)
- `src/memory/items.ts` — memory-item text/state shaping
- `src/memory/hotness.ts` — decay/reinforcement scoring
- `src/memory/kind-weights.ts` — single source of truth for kind weighting (retrieval vs working-set profiles)
- `src/memory/references.ts` — file/path reference extraction from memory text; keeps the tilde on home-relative paths (see the home-relative invariant in `docs/invariants.md`)
- `src/memory/text.ts` — `TOKEN_PATTERN` + `stemLite`, the text primitives shared by the write path and the rerank layer
- `src/memory/conflict.ts` — deterministic contradiction detection over note content
- `src/query/tokenize.ts` — topic tokenization for the rerank layer; re-exports the `memory/text.ts` primitives
- `src/query/render.ts` — shared memory-line rendering; owns the `[contested]` marker, contested-pair grouping, and the `already rejected:` alternatives line
- `src/query/retrieval.ts` — retrieval/reranking
- `src/query/reference-validation.ts` — `ReferenceValidator` (memoized, batched), rename/moved resolution, graduated stale scoring, and home-relative (`~/…`) expansion at the one branch that touches disk
- `src/query/validate-memory.ts` — diagnostic memory validation reports
- `src/query/inspect.ts` — `list-memory` / `inspect-memory` (FR-21); owns the page-size cap and the only read of `notes.conflict` that does not go through projected text
- `src/query/correct.ts` — `edit-memory` / `delete-memory` (FR-22); preview-before-delete and the contested-pair clearing rule
- `src/query/doctor.ts` — `doctor` (FR-23); installation diagnostics, the hook-template digest, PATH-based interpreter resolution, and `REQUIRED_WIRING`
- `src/query/install.ts` — `install` (FR-26); idempotent hook/settings/MCP/ignore installation and edited-script detection
- `src/query/read-ledger.ts` — the read-ledger query (FR-6): four verdicts, AD-16 eligibility, per-file token budget
- `src/query/search-ledger.ts` — the negative-cache query (FR-13)
- `src/capture/search-query.ts` — search identity + certifiability gates (FR-12)
- `src/capture/census.ts` — the working-tree fingerprint behind the negative cache
- `src/capture/transcript.ts` — the command-outcome oracle (FR-14): the host transcript is the ONLY place a command's pass/fail is observable, because the Bash hook payload carries no exit code and a host-failed command fires no hook at all
- `src/eval/harness.ts` — evaluation surfaces and metrics; owns the surface-assertion hook (FR-7 era) that lets `brief`/`header`/`full_state` gate
- `src/query/reflex.ts` — focus-shift memory reflex for hook `additionalContext`
- `src/query/state.ts` — startup/default working-set rendering (budgeted)
- `src/query/session-brief.ts` — the SessionStart pull channel (validated ≤150-token brief)
- `src/query/subagent-brief.ts` — the automatic subagent brief (FR-18): the pairing horizon, the prompt summary kept for AC #3, and the retrieve-then-brief order that keeps `brief()`'s `No context found` off a fresh subagent's context
- `src/query/subagent-conclusion.ts` — subagent write-back (FR-19): the conclusion's bound and its transcript fallback, the `surfaced_at` marker that stops the Stop nudge re-offering it forever, and the host sidecar reader behind the pairing audit
- `src/query/memory-guard.ts` — the `PreToolUse` refusal (FR-19 AC #3): the three guarded routes plus the shell, `MEMORY_GUARD_MATCHER`, `SHELL_MEMORY_COMMANDS` (mirrored in the hook script's `case`), and the fail-open contract
- `src/query/command-tokens.ts` — the one shell-ish tokenizer, shared by `doctor` and the memory guard; `doctor` re-exports it
- `src/query/stats.ts` — the P&L report behind `cortex stats` (FR-9): session/scope token blocks, floored ratio, retrieval health; read-only by contract
- `src/query/recall.ts` — `cortex_recall` search (answer-shaped, budgeted); owns `assembleBudgeted` and its two-pass `BudgetedEvidence` contract, shared with `brief`
- `src/query/brief.ts` — `cortex_brief` topical context
- `src/query/summarize.ts` — `cortex_summarize` session wrap-up
- `src/query/suggest-notes.ts` — non-mutating note suggestions with confidence
- `src/query/scope.ts` — branch/worktree session scoping
- `src/scope/identity.ts` — store identity (FR-24/AD-10): git-common-dir realpath hash, `CORTEX_HOME`, the lazy root-commit anchor
- `src/scope/store-migration.ts` — `openProjectStore` (the one path every transport opens through), `VACUUM INTO` migration, copy verification, adoption
- `src/capture/spool.ts` — JSONL capture spool: append, atomic claim, idempotent flush
- `src/capture/digest.ts` — content hashing, the oversize ceiling, and the per-batch digest memo (FR-5)
- `src/capture/digest-index.ts` — the flat, greppable digest index the hot path reads (AD-3)
- `src/capture/substitution.ts` — the cold-path/hot-path contract for verified read substitution (FR-6, Story 4.5): the enable flag, the turn marker, the `.cortex.state` keys the hook reads, and the size bounds
- `src/eval/seed.ts` — hermetic scenario seeding for quality suites
- `src/eval/gate.ts` — the locked retrieval-quality gate (suite discovery, comparison, AD-5 kind coverage, baseline regeneration)
- `src/transports/cli.ts` — `inject-header`, `route`, `reflect`, `flush-spool`, `gc`, `install` (alias `install-hooks`), `doctor`, `substitution`, evaluation
- `src/transports/hook-entry.ts` — JSON hook bridge (reflex, one-shot consult hint, `dispatch-pre`, `subagent-start`, `end-of-turn`)
- `src/transports/mcp.ts` — MCP tools used by Claude (incl. engagement state at `<project>/.cortex.state`)
- `hooks/claude/cortex-subagent.sh` — the subagent bridge (FR-17 + FR-18 + FR-19), on FOUR wirings: engagement guard, action validation, one Node spawn per arm and one arm per fire. `dispatch-pre` (`PreToolUse` on `Agent`) records the dispatch and prints nothing; `subagent-start` (`SubagentStart`) creates the child session and may emit the brief envelope; `subagent-stop` (`SubagentStop`) records the conclusion and prints nothing, ever; `guard-memory` (`PreToolUse` on the two memory-writing MCP tools and `Bash`) is the only arm that can deny, and the only one that screens in pure shell first — its matcher includes `Bash`, so it fires on every command
- `hooks/claude/*.sh` — canonical hook script templates installed by `cortex install-hooks`; each carries a `# cortex-hook-template:` stamp that `doctor` recompares
- `eval/suites/` + `eval/baselines/` — locked retrieval-quality fixtures and reference results
- `~/.claude/CLAUDE.md` — global user guidance that must stay aligned with Cortex consult policy for new projects outside this repo

## Invariants — read docs/invariants.md before touching what it covers

The full behavioral-invariants log (formerly the `Expected Behavior` section of this file) lives in
[docs/invariants.md](docs/invariants.md) — every measured failure, veto rule, transaction discipline
and budget ruling, verbatim. It is deliberately not auto-loaded: at ~45k tokens it consumed a
quarter of every session's context before work began.

**Consult it before changing anything it covers, and update it in the same change that alters
behavior.** Coverage: session identity and subagent child sessions; retrieval, rerank and trust
labels; conflict detection, the supersede veto and demotion (FR-4/AD-17); `[contested]` /
`(superseded)` / alternatives rendering and the trailer-scoped readers; list/inspect/edit/delete
memory (FR-21/22) and cascade deletion; schema versioning and the newer-store refusal (P-5/AD-12);
content digests, the flat index and the read ledger (FR-5/FR-6); the session brief and gate
surfaces (FR-7); verified read substitution and the B-4a budgets; the negative search cache
(FR-12/FR-13); the command-outcome oracle, its transcript source and its never-executed gate
(FR-14; FR-15 withdrawn); the token ledger (FR-8/FR-9); the subagent brief — its dispatch
capture, its `(session_id, prompt_id, agent_type)` pairing key, the FIFO fan-out residual and its
counter, the two expiry horizons, the 150-token ruling, and the child-session billing (FR-18); and
subagent write-back — the episode-before-suggestion ordering, the episode/suggestion line, the
once-only nudge marker, the memory guard's session-TREE rule and its fail-open contract, the
pairing audit's absent-is-not-failed rule, and the `promoteSubagentNotes` deletion (FR-19).
Grep it by FR/AD number, symbol name, or file path.

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
- `cortex_read_ledger(paths)` — before re-reading files, ask whether you already read them and whether they changed. Four verdicts, produced by re-hashing; a read by a sibling or descendant session is reported and attributed, never as "you read it".
- `cortex_search_ledger(queries)` — before repeating a search, ask whether it already returned zero results and provably still would (rules in docs/invariants.md).
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
- Run `cortex doctor` (built) for the live installation — it checks the wiring, hook currency, store and MCP registration in one command and exits non-zero on any failure
- **Windows-green is not green, and the suite cannot tell you (ruling, 2026-08-08).** CI (ubuntu-latest + windows-latest, node 20 and 22) is the only place Linux is exercised, and it had gone unrun for two weeks: 1,785 tests passed locally while 8 failed on ubuntu and 7 on windows, including three real product defects. Reproduce Linux **before** pushing:
  - `docker run -d --name cortex-linux -v "<repo>:/repo:ro" node:20-bookworm sleep infinity`, then **`git clone /repo /work` inside the container**. Never `cp`/`tar` from the Windows working tree — it carries CRLF, and a CRLF `hooks/*.sh` fails to parse under bash (`$'\r': command not found`), injecting a failure CI does not have and masking the ones it does.
  - `apt-get install jq` in the container. Without it 61 hook tests **skip silently** and the run still reads green.
  - The hooks must also run on **bash 3.2**, which is what stock macOS ships at `/bin/bash` and what `cortex install` names. `docker run --rm -v <hooks>:/h:ro bash:3.2 bash -n /h/x.sh` checks parsing — but parsing is not the test: `${x,,}` parses clean on 3.2 and fails only when reached. Grep for bash-4 constructs as well.
- **A story that changes unattended behaviour runs three ordered gates (ruling, ShuromiU, 2026-08-06): sandbox → review → install.** `dist/` here is the live installation for the whole machine, so "review before the rebuild that ships it" and "prove it live" cannot both be satisfied by building. (1) Build and prove in a sandboxed `CORTEX_HOME` plus a temp project — the real rendered hook against a real store, just not the live one. (2) Run the three-layer review. (3) Only then `cortex install` to wire it machine-wide. The residual is stated, not wished away: a sandbox cannot catch what only appears against the real host, which is why gate 3 is a real install — Story 5.1's most valuable finding came from a live probe.
- **An epic is not done until every project on this machine has picked it up and the guidance makes it used (standing rule, ShuromiU, 2026-08-02).** The checkout is the live installation, so code ships globally on rebuild — but shipped is not used. After each epic: (1) rebuild, `cortex doctor`; (2) re-run `cortex install` if any hook template or wiring changed; (3) survey `~/.cortex/projects` read-only and open every live store once (`cortex status`) so schema/data migrations run proactively, then verify the epic's surfaces render there (`cortex stats`, or the epic's own commands); (4) sweep every workspace repo's `.gitignore` against `IGNORE_ENTRIES` — mind globs (`.cortex*` already covers everything) and that `.cortex.spool.jsonl` does not match `.processing`; (5) update `~/.claude/CLAUDE.md` § "Memory — Cortex" (the hub), the workspace `CLAUDE.md`, and each consumer `CLAUDE.md`'s "In short" reflex line (the spokes) so agents everywhere are *told* to use the new surfaces — stale guidance is capability without adoption, the exact gap `Unrealized` exists to expose; (6) prove use end-to-end in at least one non-cortex project. Epic 3's rollout (2026-08-02) is the template: three v5 stores migrated proactively (umbrella, repo-b, repo-f), five `.gitignore`s appended, hub + six spokes updated.
- If the change affects real Claude usage, verify:
  - `~/.claude/settings.json`
  - `~/.claude/hooks/cortex-capture.sh`, `cortex-reflect.sh`, `cortex-end-of-turn.sh` (installed via `cortex install-hooks --claude`)
  - the live path Claude uses for the Cortex MCP server
