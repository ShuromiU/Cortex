---
title: Cortex — The Context Economy
status: final
created: 2026-07-24
updated: 2026-07-24
---

# PRD: Cortex — The Context Economy

## 0. Document Purpose

This PRD is for the Cortex maintainer and every downstream BMad workflow that derives from it — architecture, epics and stories, and the story-level dev cycle. It covers a four-release roadmap that repositions Cortex from *"persistent memory for coding agents"* to *"the layer that makes long agent sessions measurably cheaper."*

It is structured Glossary-first: §3 defines every domain noun, and §4 groups capabilities into features with globally-numbered Functional Requirements nested underneath. Release boundaries are marked on each feature; FR numbering is stable and independent of release, so reorganizing the roadmap does not renumber requirements. Inferences the author made without confirmation are tagged `[ASSUMPTION]` inline and indexed in §16.

**Upstream inputs this PRD builds on and does not duplicate:**
- `_bmad-output/brainstorming/brainstorm-cortex-product-leverage-2026-07-24/.memlog.md` — 112-entry canonical record of the ideation session that produced this direction.
- `_bmad-output/project-context.md` — 41 implementation rules and repository invariants. Binding on all downstream work.
- `AGENTS.md` — repository invariants. `CLAUDE.md` — current observable-behavior contract.

Mechanism, transport, and schema decisions deliberately live in `addendum.md`, not here. This document states *what* and *why*; `bmad-architecture` owns *how*.

---

## 1. Vision

Coding agents pay for the same knowledge over and over. Every turn re-sends the full context — every file read, every command output, every error — as fresh input tokens. When history overflows the window it gets summarized or dropped, and the agent re-reads the file it already read, re-runs the test it already ran, re-greps the directory it already searched. The industry's answer so far has been to make repetition *cheaper* — prompt caching discounts the repeated portion, server-side compaction condenses history. Nobody has attacked the repetition itself.

Cortex already knows what the agent read, when it read it, and whether the file has changed since. It already validates memory against the current checkout and labels what has gone stale. It has, without naming it as such, most of the machinery required to answer a different and more valuable question than *"what do I remember?"* — namely **"what do you already know, and what would re-deriving it cost you?"**

The Context Economy release turns that latent capability into the product. A recall that hands back three notes is a cost. A recall that says *"that file is unchanged since you read it at 14:02"* is a refund — it deletes a four-thousand-token re-read for twenty tokens. Cortex will systematically prefer the second kind, keep an honest ledger of tokens injected versus tokens saved, and show the user the balance. Memory that pays for itself does not need to be nagged into use; an agent calls it because calling it is cheaper than not calling it. That reframe is the product, the adoption strategy, and the demo, all at once.

---

## 2. Target User

### 2.1 Jobs To Be Done

- **Functional — stop paying twice.** "My agent burned 40k tokens re-reading files it read ten minutes ago. Make that stop."
- **Functional — resume without re-explaining.** "I came back to this branch after a week. Tell me what I decided and why, without me reconstructing it from git log."
- **Functional — stop relitigating.** "The agent keeps proposing the approach we already rejected. Make the rejection stick."
- **Functional — don't let a subagent's work evaporate.** "I fanned out five agents, they each burned 200k tokens, and all I got back was five paragraphs."
- **Emotional — trust the memory.** "If it tells me something, I need to know whether it's still true, not just that it was once written down."
- **Social — hand the context to a teammate.** "The decisions live in my machine's SQLite file. They should live with the repo."
- **Contextual — Windows, local-first, no vendor.** "It has to work on my machine, offline, without shipping my code to anyone."

### 2.2 Non-Users (v1)

- **Teams wanting a hosted, multi-tenant memory service.** Cortex is local-first; sync is R3 and file-based, not a service.
- **Non-coding agent applications** — chat assistants, customer-support bots, general personalization. Mem0, Zep, and Letta serve that space well; Cortex's differentiator is repo-nativeness and is meaningless without a checkout.
- **Users wanting Cortex to write code.** It is a memory and economics layer, not an implementation agent.

### 2.3 Key User Journeys

*Scoped to Release 1 — the four moments R1 changes. Features §4.6 through §4.8 deliberately carry no journey yet; inventing them now would be theater, and they will be written when those releases are planned. Features reference journeys by ID inline.*

- **UJ-1. Dana stops paying for the same file four times.**
  Dana is refactoring a 900-line store module across a long afternoon session. Cortex is engaged; capture is ambient. Two hours in, the agent needs `store.ts` again — it read it at 14:02, and again at 14:47, and is about to read it a third time. Instead of a fourth full read, Cortex answers from the read ledger: *unchanged since 14:02, you edited lines 210–240 at 15:10, here is the file card.* The agent proceeds on 180 tokens instead of 4,100. At the end of the session Dana runs `cortex stats` and sees the session's balance: 2,100 tokens injected by Cortex, 47,000 saved. **Edge case:** if the file *has* changed since the last read, Cortex says so explicitly and does not substitute — a stale substitution is worse than a re-read.

- **UJ-2. Marcus is stopped from relitigating a settled decision.**
  Marcus returns to the auth subsystem after three weeks. The agent proposes session cookies. Cortex's recall on `auth` leads with the decision from three weeks ago — OIDC — and, critically, with the rejected alternatives attached to it: *already rejected: session cookies (no SSO path), JWT-in-localStorage (XSS surface)*. The agent drops the proposal in one turn instead of arguing it through five. **Edge case:** if the rejection rationale no longer holds because the code moved on, `cortex_validate_memory` surfaces the conflict rather than letting the old decision silently win.

- **UJ-3. Priya catches a contradiction before it ships.**
  Priya writes a note recording that the capture path will move to a worker thread. Cortex notices this contradicts an active decision on the same subject — *capture must never spawn a process per tool call* — and flags the conflict at write time, showing both notes side by side. Priya resolves it deliberately: supersede the old one with a note explaining the constraint still holds and the worker plan is dead. The contradiction never reaches an implementing agent. **Edge case:** flagging must be advisory, never blocking — a false positive that refuses a write would be worse than the contradiction.

- **UJ-4. Sam's fan-out stops throwing away its own findings.**
  Sam dispatches four subagents to audit four subsystems. Each inherits a scoped brief automatically — Sam pastes nothing. Each returns its findings, and Cortex captures the *conclusions* as episodes attached to the parent session, not just the summary text the parent happened to keep. Next week, a recall on any of those four subsystems surfaces what the audit found. **Edge case:** subagent memory is scoped read-mostly; a subagent cannot silently overwrite a parent decision.

---

## 3. Glossary

Downstream workflows must use these terms exactly. Introducing a synonym anywhere is a discipline violation.

- **Memory item** — the canonical retrieval unit, one row in `memory_items`. Every durable thing Cortex knows is projected into one. Has a *kind*, *scope*, *state*, and *importance*.
- **Load-bearing** — the bar a piece of information must clear to become durable memory: it changes what a future agent would do. Decisions with rejected alternatives, blockers, committed approaches, and non-obvious constraints are load-bearing. Progress updates, acknowledgments, and anything recoverable from code or git history are not.
- **Episode** — a derived memory item summarizing a bounded unit of activity — a command failure with its output, a test cycle, a subagent's findings. Distinct from a *note*: episodes are captured, notes are authored.
- **App graph** — the record of which files currently exist in a scope, refreshed from the working tree. The authority against which memory's file references are validated.
- **Kind** — the class of a memory item: `note:decision`, `note:blocker`, `note:intent`, `note:focus`, `note:insight`, plus derived kinds for episodes, command runs, snapshots, and summaries.
- **Scope** — the branch/worktree/project partition a memory item belongs to, identified by a *scope key*. Three scope types exist today (`project`, `branch`, `detached`); R3 adds `user`.
- **State** — a memory item's decay tier: `hot`, `warm`, `cold`, `archived`. Retrieval and use reinforce; neglect decays.
- **Trust label** — the current-truth verdict rendered alongside a retrieved memory: `refs OK`, `[stale: missing …]`, or `[moved: a → b]`. Derived from validation against the current checkout, never from the memory's own claims.
- **Reference validation** — the process of checking a memory item's extracted file/path references against the current app graph and rename map to produce a trust label.
- **Read ledger** — the per-session record of which files the agent has read, when, at what content hash, and whether they have changed since. New in R1.
- **Content digest** — a stored `sha256` of a file's bytes plus its path, size, mtime, and observed line ranges. Cortex stores digests, never raw file bytes.
- **File card** — a bounded, model-derived summary of a file (purpose, exported symbols, gotchas), regenerated only when the file's content digest changes. Substitutes for reading the file when the agent needs orientation rather than exact text.
- **Negative result** — a recorded search or lookup that returned nothing, keyed to the commit it was performed at. "No matches for `foo` under `src/` at HEAD abc."
- **Tool-output cache** — recorded outcomes of expensive deterministic commands, keyed by command, HEAD, and the set of dirty files.
- **Token P&L** — the per-session and cumulative accounting of *tokens injected* by Cortex against *tokens saved* by Cortex, with the difference reported as net.
- **Tokens injected** — tokens Cortex added to the agent's context: session brief, reflex, and the rendered output of every pull tool.
- **Tokens saved** — tokens the agent did not spend because Cortex answered instead. Only counted when a *specific avoided action* with an estimable cost is identified. Never estimated speculatively.
- **Refund** — a single recall whose tokens saved exceed its tokens injected.
- **Session brief** — the ≤150-token validated payload emitted at SessionStart. Silent on a cold start.
- **Reflex** — the rare mid-session `additionalContext` whisper emitted only on a high-confidence remembered focus shift.
- **Capture spool** — the append-only JSONL file (`.cortex.spool.jsonl`) that PostToolUse hooks write to, flushed in batches. Never spawns a process per tool call.
- **Trigger** — a stored condition-plus-message that fires when the condition is met in a future session. Prospective memory. New in R2.
- **Invariant note** — a note asserting a rule about the codebase that can be mechanically checked. New in R2.
- **Substrate** — the storage and scope layer. R3 extends it from per-project to per-project-plus-per-user.
- **Eval suite** — a locked hermetic retrieval-quality fixture in `eval/suites/`, scored against a reference result in `eval/baselines/`.

---

## 4. Features

FR IDs are global and stable. Release tags mark delivery, not dependency.

### 4.1 Trust Activation — `[R1]`

**Description:** Two schema columns have been written since v1 and read by nothing: `notes.conflict` and `notes.alternatives`. Activating them converts Cortex from a memory that reports what it holds into a memory that argues with itself. Contradiction detection surfaces when a new note opposes a live decision on the same subject. Rejected-alternative surfacing puts the *already-considered-and-dismissed* options in front of the agent at recall time, which is where relitigating actually happens. Realizes UJ-2, UJ-3.

**Functional Requirements:**

#### FR-1: Contradiction detection at write time

An agent or user writing a note can be told, at write time, that the note contradicts an active memory item on the same subject.

**Consequences (testable):**
- Writing a note whose subject matches an active `note:decision` and whose content opposes it returns a conflict payload naming the prior item's id, subject, timestamp, and text.
- The conflicting prior item's `notes.conflict` column is set to `1`; the new note's is set to `1`.
- The write **always succeeds**. Conflict is advisory metadata, never a rejection.
- Detection is deterministic and offline — no model call is required for the write path to complete.
- A note with no subject, or no active item on that subject, produces no conflict and no extra work.

**Out of Scope:**
- Automatic resolution. Choosing which side wins is the user's, via `cortex_resolve`.

#### FR-2: Conflict visibility in retrieval

An agent retrieving a memory item that carries an unresolved conflict is shown that the item is contested.

**Consequences (testable):**
- Retrieved items with `conflict = 1` render a `[contested]` marker in recall, brief, and state output.
- A contested item and its counterpart appear adjacently in recall output when both rank in the returned set.
- The marker costs ≤ 4 tokens per item and is subject to the same output budget as everything else.

#### FR-3: Rejected alternatives surfaced at recall

An agent recalling a topic sees the alternatives that were considered and rejected, not only the decision that won.

**Consequences (testable):**
- A `note:decision` with a non-empty `alternatives` array renders an `already rejected:` line listing them.
- The line is included whenever the parent decision is included and the budget permits; it drops before the decision itself drops.
- Decisions without alternatives render exactly as they do today — no formatting regression.

#### FR-4: Auto-demotion of superseded decisions

When a new decision lands on a subject that already has an active decision, the older one is demoted without requiring a manual close-out.

**Consequences (testable):**
- The older item's state moves at least one tier colder (`hot`→`warm`, `warm`→`cold`).
- The older item remains retrievable for historical and temporal queries (`what did we decide before`, `old`, `history`).
- Demotion never applies to items whose `kind` is `note:blocker` — an unresolved blocker is not superseded by a decision.

**Feature-specific NFRs:**
- Conflict detection adds ≤ 5 ms to a note write on a database with 10,000 memory items.

---

### 4.2 Read Ledger and Token P&L — `[R1]`

**Description:** Cortex's capture spool already records every `Read`, `Edit`, and `Write` with a file path. The read ledger extends that record with a content digest and exposes it as an answer surface: *what have you already read, and has it changed?* Alongside it, the long-dormant `token_ledger` table becomes a real accounting system — every injection debited, every avoided action credited, the net reported. This is the feature that makes the product's central claim falsifiable. Realizes UJ-1. `[ASSUMPTION: the existing token estimator is accurate enough for this accounting to be credible — see §16.]`

**Functional Requirements:**

#### FR-5: Content-digest capture on read

When the agent reads a file, Cortex records a content digest for it in the current scope.

**Consequences (testable):**
- The spool entry for a `Read` carries the file's `sha256`, byte size, and mtime alongside the existing path.
- Digest computation happens in the batched flush, not in the per-tool-call hook — the no-Node-per-tool-call invariant holds.
- Files above a configurable size ceiling (default 2 MiB) record path and size but no digest, and are marked `oversize`.
- Binary and non-UTF-8 files are digested but never carded.

#### FR-6: Read-ledger query

An agent can ask whether it has already read a file in this session and whether that file has changed since.

**Consequences (testable):**
- The query returns one of exactly four verdicts: `unread`, `unchanged-since <ts>`, `changed-since <ts>`, or `edited-by-you-since <ts>`.
- `unchanged` is asserted only when the current on-disk `sha256` matches the recorded one. Cortex re-hashes; it does not trust mtime alone.
- A verdict for a file that no longer exists is `changed-since` with a `missing` qualifier, never `unchanged`.
- Response is ≤ 30 tokens per file.

#### FR-7: Read ledger in the session brief

A resuming agent is shown which files it already knows about without having to ask.

**Consequences (testable):**
- When a prior session in the same scope read files that are still unchanged, the brief includes a single line naming up to five of them, ordered by read frequency.
- The line is inside the existing ≤150-token brief budget and drops first when the budget binds.
- A cold start still emits nothing.

#### FR-8: Token accounting

Every Cortex output is debited and every avoided action is credited to the session's token ledger.

**Consequences (testable):**
- Each rendered output surface (session brief, reflex, and every pull tool) writes a `direction: 'injected'` ledger row with its measured token count.
- Each avoided action writes a `direction: 'saved'` row carrying the *evidence* of what was avoided: the file and its recorded byte size for an avoided read, the recorded output size for an avoided command, the recorded result count for an avoided search.
- Saved tokens are **only** recorded where a specific avoided action is identified. There is no speculative or modeled credit.
- Ledger writes are inside the same transaction as the operation they describe; a failed operation records nothing.

#### FR-9: `cortex stats` reporting

A user can see what Cortex has cost and what it has returned.

**Consequences (testable):**
- Reports, for the current session and cumulatively for the scope: tokens injected, tokens saved, net, and the ratio.
- Reports retrieval health: number of memory items by state, count never retrieved, and the ten most-retrieved items.
- Distinguishes measured savings from *unrealized* savings (a digest was available but the agent read the file anyway) so the gap between capability and adoption is visible.
- Runs in under 200 ms on a database with 10,000 memory items.

**Notes:** `[NOTE FOR PM]` The injected/saved ratio is the single number this product will be judged on. It must be conservative by construction — under-reporting savings is acceptable, over-reporting is fatal to trust.

---

### 4.3 Content Cache — `[R1]`

**Description:** With digests in place, Cortex can answer questions that today force an expensive tool call. File cards substitute a bounded summary for a full read when the agent needs orientation. The negative cache remembers searches that found nothing — the single most wasteful category of repeated work, because a zero-result grep costs full price and teaches nothing. The tool-output cache remembers the outcomes of expensive deterministic commands. Realizes UJ-1.

**Data boundary — binding:** Cortex stores content **hashes and model-derived summaries only**. It never stores raw file bytes. This is a product constraint, not an implementation preference; see §11.

**Functional Requirements:**

#### FR-10: File card generation

A file the agent reads repeatedly acquires a bounded derived summary. `[ASSUMPTION: a model is reachable for card generation in at least one supported configuration — see §16.]`

**Consequences (testable):**
- A card is generated only after a file crosses a repeat-read threshold (default: read 3+ times across 2+ sessions in the same scope).
- A card is ≤ 200 tokens and states: the file's purpose, its exported symbols, and any gotchas derivable from notes referencing it.
- A card is invalidated the moment its source digest changes, and is never served stale.
- Card generation is asynchronous and never blocks a read, a flush, or a turn.
- If no model is available to generate a card, the feature degrades to digest-only. Cards are an enhancement, not a dependency.

#### FR-11: File card retrieval

An agent can request orientation on a file without reading it.

**Consequences (testable):**
- Returns the card plus the file's current read-ledger verdict.
- Returns nothing (not a stale card) when the digest does not match.
- The response explicitly states that it is a summary and names the token cost of the full read, so the agent can choose.

#### FR-12: Negative-result capture

Searches that return no results are recorded against the commit at which they were run.

**Consequences (testable):**
- A recorded negative result carries the query, the search root, the tool used, and the `head_oid`.
- A negative result is invalidated when any file under the search root has changed since the recorded `head_oid`, including uncommitted working-tree changes.
- Negative results are never asserted across a scope boundary.

#### FR-13: Negative-result query

An agent about to repeat a search that previously found nothing is told so.

**Consequences (testable):**
- Returns `no-matches-at <head>` only when the search root is provably unchanged since capture.
- Returns `unknown` — never a false negative — when change status cannot be established.
- Response is ≤ 25 tokens.

#### FR-14: Tool-output capture

Outcomes of expensive deterministic commands are recorded with the state they were run against.

**Consequences (testable):**
- A recorded outcome carries the normalized command, exit code, the `head_oid`, the dirty-file set at run time, and the output size — but not the full output beyond the existing tail limits.
- Only commands classified as deterministic-under-fixed-state (test, build, typecheck, lint) are recorded. Commands with side effects are never cached.
- Recording reuses the existing command-run and redaction path; secrets never enter the cache.

#### FR-15: Tool-output query

An agent can learn the result of a command without running it. `[ASSUMPTION: dirty-file set plus head_oid is a sufficient cache key for deterministic commands — see §16.]`

**Consequences (testable):**
- Returns a hit only when `head_oid` matches **and** the dirty-file set is unchanged **and** no file in the recorded touched-file set has changed.
- A hit reports the prior exit code, when it ran, and the conditions under which it is being asserted.
- Any ambiguity resolves to a miss. A false "your tests pass" is the worst failure this product can produce.

#### FR-16: Cache eviction and bounds

Cached derived data cannot grow without bound.

**Consequences (testable):**
- `cortex gc` prunes digests for files absent from the current app graph, cards whose source digest is gone, negative results older than a configurable horizon, and tool outputs whose `head_oid` is no longer an ancestor of HEAD.
- Total derived-cache size is reported by `cortex stats` and capped by a configurable ceiling; the oldest, least-retrieved entries evict first.
- `gc` remains dry-run by default.

**Feature-specific NFRs:**
- A read-ledger or negative-result query returns in under 20 ms at p95 on a 10,000-item database.
- Digest storage costs ≤ 400 bytes per tracked file.

---

### 4.4 Subagent Memory — `[R1]`

**Description:** Today `cortex_brief` requires the *parent* to call it and paste the result into a subagent prompt, and a subagent's findings return only as whatever prose the parent chose to keep. Both halves leak. Subagents get an inherited brief without parent effort, and their conclusions are captured as durable episodes. Realizes UJ-4.

**Functional Requirements:**

#### FR-17: Inherited subagent session

A subagent dispatched from a Cortex-engaged session operates in a scoped session linked to its parent.

**Consequences (testable):**
- The child session records `parent_session_id` and inherits the parent's scope key.
- The child's capture is attributed to the child session, not merged into the parent's timeline.
- A subagent running where Cortex is disengaged inherits nothing and captures nothing.

#### FR-18: Automatic subagent brief

A subagent receives topical context without the parent pasting it.

**Consequences (testable):**
- The brief is derived from the dispatch description and is subject to the standard brief budget.
- When no relevant memory exists, the subagent receives nothing — silence is the default, as everywhere else.
- The parent may still call `cortex_brief` explicitly; the two paths must not double-inject.

#### FR-19: Subagent conclusion write-back

A subagent's findings survive the subagent.

**Consequences (testable):**
- On child-session close, its load-bearing findings are recorded as episodes attached to the parent's scope.
- Write-back uses the existing non-mutating suggestion path for note-shaped findings: subagents propose, they do not silently author decisions.
- A subagent cannot modify or resolve a note authored outside its own session.

#### FR-20: Parallel-agent claim record

Agents working concurrently in one scope can see what their siblings have already covered.

**Consequences (testable):**
- A claim records the agent, the area claimed, and the outcome, and is visible to sibling sessions within the same parent.
- Claims expire with the parent session and never persist as durable memory.
- Reading claims is optional; no agent is blocked waiting on one.

**Notes:** `[ASSUMPTION: the host harness exposes enough subagent-dispatch signal at the hook layer to link parent and child sessions. If it does not, FR-17 degrades to an explicit parent-side call and FR-18 becomes parent-initiated.]`

---

### 4.5 Operability — `[R1]`

**Description:** Cortex currently offers no way to see, correct, or diagnose its own memory. A wrong note is permanent; a broken hook is silent; the database sits in the project root growing a write-ahead log nobody checkpoints. None of this is glamorous and all of it gates trust.

**Functional Requirements:**

#### FR-21: Memory listing and inspection

A user can see what is in memory.

**Consequences (testable):**
- Lists memory items filtered by scope, kind, and state, ordered by a stated criterion, with ids.
- Shows a single item in full by id, including references, trust label, conflict status, and access history.
- Output is paginated and never dumps the whole store.

#### FR-22: Memory correction

A user can fix a wrong memory.

**Consequences (testable):**
- Editing an item's text re-extracts its references and re-projects its memory item.
- Deleting an item removes it and its derived rows, and is confirmed before it runs.
- Every correction is recorded in an audit trail that survives the correction itself.

#### FR-23: Installation diagnosis

A user can find out why Cortex is not working.

**Consequences (testable):**
- Checks and reports: engagement state, hook script presence and substitution correctness, `jq` availability, Node resolution, database reachability and schema version, spool size and staleness, and MCP server registration.
- Every failed check names the specific fix.
- Exits non-zero when any check fails, so it can gate CI.

#### FR-24: Storage relocation

Cortex's runtime artifacts stop living in the user's project root. `[ASSUMPTION: users will accept the database moving out of their project root — see §16.]`

**Consequences (testable):**
- The database and derived data move under a per-project directory in a user-level Cortex home, addressed by a stable project identity.
- An existing project-root database is migrated on first run, with the original left intact until the migration is verified.
- Worktrees of the same repository resolve to the same store without collision.

#### FR-25: Write-ahead-log management

The database does not accumulate an unbounded WAL.

**Consequences (testable):**
- A checkpoint runs on session close and when the WAL crosses a configurable threshold.
- `cortex stats` reports database and WAL size.
- Checkpointing never blocks a hook path.

#### FR-26: Zero-config installation

A new user can install Cortex in one command.

**Consequences (testable):**
- One command writes hook scripts with correct substitutions, registers the MCP server, adds ignore entries, and runs the diagnostic.
- Re-running is idempotent and reports what it changed.
- The command refuses to overwrite a user-modified hook script without confirmation.

---

### 4.6 Time-Shifted Memory — `[R2]`

**Description:** All of Cortex's memory today is retrospective and pull-based: it waits to be asked. An entire class of valuable knowledge is prospective — *when someone next does X, they need to know Y* — and has no home. Triggers give it one. Invariant notes go further: a rule stated once becomes a check that runs, turning a decision into a guardrail.

**Functional Requirements:**

#### FR-27: Trigger creation

A user or agent can attach a message to a future condition.

**Consequences (testable):**
- A trigger records its condition, message, author, creation time, and optional expiry.
- Supported condition types at minimum: a named file or glob is read, edited, or written; a named command is run; a branch is checked out.
- Creating a trigger on a condition that can never match is rejected with an explanation.

#### FR-28: Trigger firing

A trigger surfaces when its condition is met.

**Consequences (testable):**
- Fires through the existing reflex channel and obeys its budget and confidence discipline.
- Fires at most once per session per trigger.
- A fired trigger records the firing; a trigger that fires repeatedly without ever being acted on decays like any other memory.

#### FR-29: Trigger management

Triggers are visible and removable.

**Consequences (testable):**
- Listing shows all active triggers for the scope with their conditions and fire counts.
- Triggers are closed out through the same `cortex_resolve` path as notes.
- Expired triggers stop firing but remain in history.

#### FR-30: Invariant notes

A note can assert a mechanically checkable rule.

**Consequences (testable):**
- An invariant note carries a machine-readable predicate alongside its prose.
- The supported predicate vocabulary is explicit and small, and is fixed at R2 planning (Q5) rather than accreted during implementation; anything outside it is stored as an ordinary note with an explanation.
- An invariant note whose predicate cannot be evaluated is reported, never silently skipped.

#### FR-31: Invariant checking

Invariants can be checked against the working tree.

**Consequences (testable):**
- A command evaluates all invariants for the scope and reports violations with file and line.
- Exits non-zero on violation so it can gate CI or a pre-commit hook.
- Reports which invariants could not be evaluated and why.

#### FR-32: Decision-conflict reporting for changesets

A changeset can be checked against recorded decisions.

**Consequences (testable):**
- Given a diff, reports decisions and invariants the change appears to contradict, with the memory id and rationale.
- Output is machine-readable for CI consumption and human-readable for terminal use.
- Advisory only — it reports, it never blocks a commit on its own judgment.

---

### 4.7 Substrate — `[R3]`

**Description:** Cortex's memory is trapped in one repository and one machine. Knowledge that is about *the developer* rather than the project ("Node's `/tmp` is not Git Bash's `/tmp` on Windows") has no correct home and currently lives in a different memory system entirely. Meanwhile CLAUDE.md, AGENTS.md, and harness-level memory files are parallel memory systems with no shared substrate — that fragmentation is the actual user pain.

**Functional Requirements:**

#### FR-33: User-scope memory

Memory can be recorded as belonging to the user rather than the project.

**Consequences (testable):**
- A `user` scope type exists with its own store, addressable from any project.
- Retrieval merges project and user scopes; project-scoped items win ties.
- User-scope items are never written by ambient capture — only deliberately.

#### FR-34: Cross-project retrieval

A recall can surface relevant user-scope knowledge from other projects.

**Consequences (testable):**
- Cross-project results are labeled with their origin project and ranked below same-project results of equal relevance.
- A user can disable cross-project retrieval per project.
- No file-reference validation is asserted across project boundaries; cross-project items never claim `refs OK`.

#### FR-35: Adjacent memory-file import

Cortex can read the memory systems already present in a repository.

**Consequences (testable):**
- Imports from `CLAUDE.md`, `AGENTS.md`, and harness memory-index files, recording provenance and leaving the source untouched.
- Re-import is idempotent — unchanged sources produce no duplicates.
- Imported items are labeled as imported and are distinguishable from Cortex-authored memory in every output surface.

#### FR-36: Decision-document projection

Memory can be rendered as a git-tracked document.

**Consequences (testable):**
- Produces an ADR-style markdown file of active decisions with subjects, dates, rationale, and rejected alternatives.
- Regeneration is deterministic — identical memory produces a byte-identical file, so the diff is meaningful.
- The projection is derived and never read back as a source of truth.

#### FR-37: Memory export

Memory can leave the machine in a reviewable form.

**Consequences (testable):**
- Exports a selected scope and date range as JSONL with a stable schema and a content hash.
- Secrets and redacted content are excluded by the same rules that govern capture.
- The export names its schema version.

#### FR-38: Memory import

Exported memory can be merged into another machine's store.

**Consequences (testable):**
- Import is idempotent by content hash; re-importing changes nothing.
- Conflicts against local memory on the same subject are reported through the FR-1 conflict path, never silently merged.
- A dry-run mode reports what would change without changing it.

---

### 4.8 Retrieval Depth — `[R4]`

**Description:** Cortex's ranking is lexical: FTS5 with a stemming rerank layer and a set of hand-tuned bonuses. It works, and the locked eval suites prove it works. But users are currently told to be *sparing* with what they save because items compete for retrieval — which means the memory is deliberately undersaturated. That is a ranking limitation wearing a usage guideline's clothing. Better ranking removes the guideline.

**Functional Requirements:**

#### FR-39: Symbol-level reference validation

Memory referencing code symbols is validated against symbols, not only files.

**Consequences (testable):**
- Extracted symbol references resolve through a language-server backend where one is available.
- A note referencing a deleted function is labeled stale even when its file still exists.
- Where no language server is available, behavior degrades to today's file-level validation and says so — it never guesses.

#### FR-40: Local semantic ranking

Semantic retrieval ships without requiring a network call or an API key. `[ASSUMPTION: a locally-executing embedding model of acceptable quality fits within the dependency policy — see §16.]`

**Consequences (testable):**
- Embeddings are produced by a locally-executing model; no production path makes a network request.
- `shadow` mode provably does not change returned results; `rank` mode changes them only above a stated threshold.
- Every locked eval suite is re-run under `off`, `shadow`, and `rank`, and `rank` must not regress any suite.

#### FR-41: Relevance feedback capture

Cortex records whether retrieved memory was actually used.

**Consequences (testable):**
- A retrieved item is marked used when a subsequent action in the same session references its subject or its files within a bounded window.
- Retrieved-and-ignored items decay faster than never-retrieved items.
- Feedback data is inspectable and exportable for offline ranking analysis.

#### FR-42: Two-stage retrieval

Recall can return handles before bodies.

**Consequences (testable):**
- A digest mode returns ids, subjects, kinds, dates, and trust labels only, at ≤ 15 tokens per item.
- Bodies are fetched by id in a follow-up call.
- The two-call path costs fewer total tokens than the single-call path whenever the agent expands fewer than half the returned items.

#### FR-43: Memory chunking

Items consistently retrieved together can be consolidated.

**Consequences (testable):**
- Co-retrieval above a threshold proposes a merged item for review; merging is never automatic.
- A merged item retains references to its constituents.
- Merging must not regress any locked eval suite.

#### FR-44: Retrieval-quality regression gate

Retrieval quality cannot silently regress.

**Consequences (testable):**
- All locked eval suites run in CI on every change touching retrieval, ranking, tokenization, validation, or output shaping.
- The build fails on any negative `top1_hit` delta, any negative `recall_at_3` delta, or any positive `output_tokens` delta.
- Regenerating a baseline requires an explicit flag and a justification recorded in the commit body.

---

## 5. Non-Goals (Explicit)

- **Cortex is not a hosted service.** No accounts, no server, no telemetry leaving the machine. R3 sharing is file-based export/import.
- **Cortex is not a general-purpose agent-memory framework.** It is repo-native and worthless without a checkout. Mem0, Zep, and Letta serve conversational memory; Cortex does not compete there.
- **Cortex does not store your source code.** Digests and derived summaries only. Not a code index, not a vector store of file contents, not an offline copy of the repository.
- **Cortex does not write code, review code, or make architectural judgments.** It surfaces prior decisions; it does not form new ones.
- **Cortex does not block the user.** No gate refuses a write, a commit, or a turn on Cortex's judgment. `cortex doctor` and the invariant checker exit non-zero for CI, which is the user opting in, not Cortex intervening.
  **Amended 2026-07-24 (Q3 resolution).** One narrow exception is now in scope: Cortex may replace the *result* of a `Read` with an equivalent shorter payload, via `PostToolUse` output substitution. This is not advisory — the agent sees Cortex's text instead of the file's — so it is fenced by four rules, all testable:
  1. Substitution happens only when the just-read content hashes to the recorded digest. Cortex holds the bytes it is making a claim about; it cannot assert falsely.
  2. The substituted payload states plainly that it is a substitution, names the file, and gives the token cost of the full content.
  3. A second read of the same file within the same turn always passes through unsubstituted — the agent asking twice is a signal it needs the real content.
  4. Substitution is disableable per project and globally, and is off until the user turns it on.
  Cortex still never denies a tool call, never blocks a write or a commit, and never uses `PreToolUse` denial for economics. Denial is a bet placed before the evidence exists; substitution is a claim made while holding it.
- **Cortex does not require a model.** Every core capability degrades cleanly to deterministic behavior when no model is available. Cards and distillation are enhancements.
- **Cortex is not becoming a multi-agent orchestrator.** R1 subagent support is memory plumbing, not scheduling.

---

## 6. MVP Scope

### 6.1 In Scope — Release 1

- §4.1 Trust Activation, complete (FR-1 → FR-4)
- §4.2 Read Ledger and Token P&L, complete (FR-5 → FR-9)
- §4.3 Content Cache, complete (FR-10 → FR-16)
- §4.4 Subagent Memory, complete (FR-17 → FR-20)
- §4.5 Operability, complete (FR-21 → FR-26)
- FR-44 (retrieval-quality regression gate) pulled forward from R4 — it protects every other change in R1 and costs little.

### 6.2 Out of Scope for MVP

- **All of §4.6 Time-Shifted Memory** → R2. Triggers are a new memory *class* with their own firing semantics; landing them alongside the cache work would couple two independent risk surfaces.
- **All of §4.7 Substrate** → R3. Depends on FR-24 storage relocation having settled in the field first — moving the store and then adding a second scope type simultaneously multiplies migration risk.
- **§4.8 Retrieval Depth except FR-44** → R4. `[NOTE FOR PM]` FR-40 local semantic ranking is the most-requested-sounding item and the one with the least evidence behind it. The locked eval suites do not currently show lexical ranking as the bottleneck. It stays in R4 until the R1 relevance data says otherwise — building it earlier would be building on a hunch.
- **Raw content caching** — permanently out; see §11.
- **A resident daemon** — deferred indefinitely. Real latency win, but it introduces process lifecycle, crash recovery, and stale-lock failure modes that the current architecture is free of. Revisit only if p95 query latency becomes a measured complaint.

---

## 7. Success Metrics

**Primary**

- **SM-1 — Net token position.** Median session-level `tokens_saved − tokens_injected` across sessions where Cortex was engaged for ≥ 20 tool calls. **Target: positive by end of R1; ≥ 5× injected by end of R2.** Measured from `token_ledger` via `cortex stats`. Validates FR-8, FR-9, and the entire §4.3 cache.
- **SM-2 — Realization rate.** Proportion of avoidable actions that were actually avoided — cases where a digest, card, negative result, or cached output was available and the agent used it, over all cases where one was available. **Target: ≥ 60% by end of R1.** Validates FR-6, FR-11, FR-13, FR-15. This is the honest adoption metric; SM-1 can look good on low volume, this cannot. `[ASSUMPTION: Cortex can observe the unrealized case — that an agent read a file for which a digest was available. Depends on Q3; see §16.]`
- **SM-3 — Retrieval quality holds.** No locked eval suite regresses on `top1_hit`, `recall_at_3`, or `output_tokens` across the entire roadmap. **Target: zero regressions, enforced in CI.** Validates FR-44.

**Secondary**

- **SM-4 — Relitigation avoided.** Count of recalls that surfaced a rejected alternative, and of those, the proportion where the rejected option did not subsequently appear in the session's edits. **Target: measurable and reported by end of R1.** Validates FR-3.
- **SM-5 — Contradictions caught.** Number of conflicts detected at write time, and how many were subsequently resolved rather than ignored. **Target: resolution rate ≥ 50%.** Validates FR-1, FR-2.
- **SM-6 — Silent-failure elimination.** Proportion of installs where `cortex doctor` passes clean on first run. **Target: ≥ 95% on Windows and Unix.** Validates FR-23, FR-26.
- **SM-7 — Bounded footprint.** Derived-cache size stays under its configured ceiling; database plus WAL under 50 MB for a 12-month single-repo history. Validates FR-16, FR-25.

**Counter-metrics (do not optimize)**

- **SM-C1 — Injection volume.** Total tokens injected per session must *not* rise to make SM-1's ratio look better. Counterbalances SM-1. A larger brief that saves proportionally more is still a regression against the pull-based design.
- **SM-C2 — Memory item count.** Growth in stored items is not success. Counterbalances SM-4 and SM-5 — a system that writes more notes to report more activity has failed. Items never retrieved are a cost, and `cortex stats` reports them for that reason.
- **SM-C3 — False-confidence rate.** Any instance of Cortex asserting `unchanged`, `no matches`, or a cached command result that was wrong. **Target: zero. A single occurrence is a release blocker.** Counterbalances SM-2 — realization rate must never be bought with optimistic assertions.
- **SM-C4 — Hook path latency.** Per-tool-call hook overhead must not rise. Counterbalances FR-5; digesting must stay in the batched flush.

---

## 8. Cross-Cutting NFRs

- **N-1 Silence by default.** No output surface emits anything when it has nothing high-confidence to say. Cold starts stay silent.
- **N-2 Budgeted output.** Every user-facing surface takes a token budget and drops lowest-priority content first. No surface may exceed its budget.
- **N-3 Never break the turn.** Any Cortex failure — corrupt database, missing hook, unreadable spool, absent model — degrades to silence. A memory failure must never surface as an error in the user's session.
- **N-4 No process per tool call.** PostToolUse appends and returns. Any design requiring per-call process spawn is rejected.
- **N-5 Offline and local.** No production code path makes a network request. Model-assisted features use whatever local or host-provided model is available and degrade cleanly when none is.
- **N-6 Windows parity.** Every feature is verified on Windows and Unix. Path handling, hook execution, and file locking are first-class concerns, not ports.
- **N-7 Idempotent capture.** Replaying a spool batch produces identical state. Exactly-once semantics survive interruption.
- **N-8 Additive migrations.** Schema changes are additive and idempotent. No migration destroys user memory. Every migration is reversible or leaves the prior state recoverable.
- **N-9 Determinism where asserted.** Any output claiming certainty (`unchanged`, `no matches`, cached exit code) is derived deterministically. Model-derived content is always labeled as such.

---

## 9. Public Surface and Compatibility

- **P-1 The MCP tool set is the public API.** Tool names, input schemas, and the *shape* of returned text are a compatibility contract. Removing a tool or a required field is breaking.
- **P-2 Additive-first evolution.** New capability arrives as new tools or optional parameters. Existing tools keep working with existing arguments.
- **P-3 The CLI is public.** Command names, flags, and exit codes are contract. Machine-readable output modes are versioned separately from human-readable ones.
- **P-4 Hook protocol is contract.** Hook script names, their placeholder substitutions, and the JSON they exchange with the entry point are a compatibility surface for anyone who has installed them.
- **P-5 Schema versioning.** `SCHEMA_VERSION` increments per migration. A newer binary opens an older database and migrates it; an older binary opening a newer database refuses clearly rather than corrupting it.
- **P-6 Deprecation policy.** Anything to be removed is first marked deprecated in its own description and documented, remains functional for at least one minor release, and is removed only in a version whose notes name it.

---

## 10. Performance Budgets

- **B-1** Session brief generation: ≤ 150 ms at p95.
- **B-2** `cortex_recall` end-to-end: ≤ 250 ms at p95 on 10,000 memory items.
- **B-3** Read-ledger, negative-result, and tool-output queries: ≤ 20 ms at p95.
- **B-4** PostToolUse hook, non-substituting path (`Edit`, `Write`, `Bash`, `Agent`): ≤ 500 ms wall clock at p95 measured end-to-end through the installed hook on the reference platform; structurally, pure-bash append with no Node spawn and no SQLite. *Amended 2026-08-02 (ruling: ShuromiU) — the original ≤ 15 ms predates the platform measurement: on the reference Windows/Git-Bash configuration the process-spawn floor alone is ~39–42 ms and the full installed hook measured ~400 ms (Epic 0/1 action item). The structural clause is the durable intent — the hook does one bash append and backgrounds everything else — and the number now prices the platform's process cost rather than pretending it away. On platforms with cheap spawn the measured cost is expected to sit far under the ceiling.*
- **B-4a** PostToolUse hook, `Read` substitution path, split by outcome: **miss ≤ 100 ms, hit ≤ 300 ms**, wall clock at p95 measured end-to-end through the installed hook, no Node spawn. *Amended 2026-07-24 — measured `sha256sum` on a 57 KB payload costs ~54 ms on the target Windows/Git-Bash configuration, so the original 15 ms budget was not achievable for this path. The trade is explicit: ~50–80 ms of hook time to avoid a multi-thousand-token round trip. Architecture must keep the digest lookup Node-free — a flat, greppable digest index alongside the database, not a query — so N-4 still holds. A size ceiling above which substitution is skipped entirely is required.* *Amended 2026-08-02 (ruling: ShuromiU) — the flat 100 ms bound the wrong thing. Measured on the reference platform: spawn floor ~39–42 ms, `jq` alone ~81 ms, a plausible full substitution sequence 214.8 ms — the flat budget was unreachable by process-dieting, and the two paths buy different things. The **miss** path is the unconditional tax on every `Read` and must stay cheap: one `grep -F` against the AD-3 index measures 41–100 ms from 1k→200k records, inside 100 ms at realistic sizes. The **hit** path runs only when a verified refund is produced; it may spend up to 300 ms because it removes a multi-thousand-token payload from the turn — which is expected to reduce total turn latency, not add to it. Alternatives weighed and rejected: a flat ~250 ms re-base (taxes every read at the hit price), a localhost listener in the MCP server to keep 100 ms flat (a standing port/token surface, silent loss of substitution in headless sessions, and it orphans the AD-3 index), and deferring FR-6 from R1 (leaves `Saved` at 0 for the release and forfeits SM-1 in the window where the platform hook just shipped).* *Amended 2026-08-03 (ruling: ShuromiU) — re-based end-to-end with the structural clause primary, the same shape as B-4's amendment. Story 4.5 measured the path through the installed hook and found the 2026-08-02 figures structurally unreachable on the reference platform by any implementation: one bash spawn (p95 83.9 ms) plus one `jq` (~100 ms) exceeds the miss bound before any Cortex logic runs, and the totals are dominated by the hook's pre-existing three `jq` invocations (median 278.7 / p95 439.5 ms in isolation). What substitution itself adds is +1.9 ms on a miss and ~+65 ms on a verified hit. The durable intent is therefore the structural clause, now normative and pinned by CI test: no Node spawn, lookup confined to the flat AD-3 index, exactly one added process on a miss (`grep -F -m1`, scale-independent 50→59 ms across 1k→50k records) and two more on a verified hit (`wc -c`, then `sha256sum` strictly after the size and eligibility gates), everything else bash builtins. The end-to-end ceiling prices the platform: **miss ≤ 600 ms, hit ≤ 800 ms**, wall clock at p95 through the installed hook on a quiescent reference platform at default size bounds — measured 510.9 / 612.0 / 671.7 ms (miss / hit-64 KiB / hit-1 MiB) against a pre-4.5 baseline of 508.9 / 548.9 / 604.3 in the same paired runs, 15–19% headroom. Quiescent is part of the protocol: the identical script measured ~40% higher under concurrent agent load, which the ceiling deliberately does not price. The wall-clock figure is re-measured per change to the hook rather than CI-gated — a latency gate on a shared machine is a flake generator; the structural clause is what CI enforces. Alternatives weighed and rejected: defining B-4a as marginal-over-B-4 (requires widening B-4 to cover `Read`'s base cost, dismantling this section's own 2026-08-02 scoping), and requiring the three-jq→one-jq merge (~180 ms/read) before ruling (worth doing on its own merits since it benefits every budget, but it holds an AC hostage to an optimisation backlog).*
- **B-5** Spool flush of a 256 KiB batch: ≤ 2 s, off the critical path.
- **B-6** `cortex stats`: ≤ 200 ms.
- **B-7** Cold `cortex doctor`: ≤ 3 s including all checks.
- **B-8** Steady-state footprint: ≤ 50 MB database + WAL for a 12-month single-repository history.

---

## 11. Constraints and Guardrails

### 11.1 Privacy

- **Raw file bytes are never stored.** Digests, metadata, and bounded derived summaries only. This bound is what makes the cache safe to ship without a security review per repository, and it is not negotiable within this roadmap.
- Existing redaction applies to every new capture path. Command tails, file cards, and negative-result queries all pass through it.
- Files matching secret-bearing patterns (`.env*`, `*.pem`, `*.key`, credential stores) are digested for change detection but never carded, never quoted, and never summarized.
- Nothing leaves the machine. Export (FR-37) is explicit, user-initiated, and inspectable before it moves.

### 11.2 Safety

- **Advisory, never authoritative.** Cortex reports; the user and the agent decide. No Cortex output blocks an action.
- **Certainty requires proof.** `unchanged`, `no matches`, and cached command results are asserted only from deterministic evidence. Ambiguity resolves to "unknown," never to the convenient answer. SM-C3 makes a violation a release blocker.
- **Derived content is labeled.** A file card is never presented as the file.
- Destructive operations are dry-run by default and confirm before running.

### 11.3 Cost

- Cortex must be net-positive on tokens or it has failed its own thesis. SM-1 is the gate.
- Model-assisted features (cards, distillation) have a per-session ceiling and degrade rather than exceed it.
- Injected context must be stable within a session; churn invalidates the host's prompt cache and is a hidden tax that local measurement will not catch.

### 11.4 Data Governance

- Retention is tiered: spool ephemeral, derived cache bounded by eviction and age, episodes horizon-bounded, notes permanent until the user resolves or deletes them.
- Deleting a memory item removes its derived rows.
- Every automated write is attributable to a session and a source.

---

## 12. Risk and Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | A cache asserts `unchanged` or `tests pass` incorrectly; the agent acts on it and is wrong. | **Fatal to trust.** Single occurrence is a release blocker. | Deterministic evidence only; ambiguity → miss; re-hash rather than trust mtime; SM-C3 tracked from day one; adversarial tests for every assertion path. |
| R-2 | Savings accounting flatters itself, and the headline number is not real. | Undermines the product's central claim. | Credit only against a specific identified avoided action with a recorded size; no modeled or speculative credit; report unrealized savings separately so the gap is visible. |
| R-3 | Subagent session linkage is not available from the host harness. | FR-17/FR-18 degrade to manual. | Explicitly assumed and flagged (§16); fallback defined in §4.4 Notes; validate against the live harness before the epic is scheduled. |
| R-4 | Storage relocation (FR-24) loses or orphans an existing user's memory. | Data loss — unrecoverable trust damage. | Migrate by copy, verify, and leave the original in place; dry-run first; `doctor` reports both locations until the user confirms. |
| R-5 | Contradiction detection produces false positives and becomes noise the user learns to ignore. | Feature dies quietly. | Advisory-only and never blocking; subject-scoped and conservative; SM-5 tracks resolution rate — a low rate means the detector is wrong, not that users are lazy. |
| R-6 | The derived cache grows unbounded on a large monorepo. | Footprint complaint; possible disk pressure. | Repeat-read threshold gates card generation; hard ceiling with LRU eviction; size reported in `stats`; `gc` prunes. |
| R-7 | Retrieval quality regresses under the weight of new memory kinds competing for the same result slots. | Silent degradation of the core feature. | FR-44 pulled into R1; every new kind requires a locked-suite run before merge; kind weighting stays single-sourced. |
| R-8 | Windows hook fragility (bash + `jq`) silently disables capture; the user thinks Cortex is working. | Invisible total failure. | FR-23 `doctor` checks every link in the chain and names the fix; SM-6 tracks first-run pass rate. |
| R-9 | Scope creep across four releases stalls delivery of any of them. | Nothing ships. | R1 is independently valuable and independently shippable; each later release has an explicit dependency on evidence from the prior one, not just on its code. |

---

## 13. Why Now

Three things converged. First, the cost problem is now measured and public — agentic sessions re-send full context every turn, and the industry's mitigations (prompt caching, server-side compaction) reduce the price of repetition without reducing repetition itself. Second, the agent-memory category has consolidated around *conversational* memory — Mem0 for personalization, Zep for temporal fact-tracking, Letta for self-managed agent state — leaving repo-native, checkout-validated memory for coding agents essentially unoccupied. Third, and most specific to Cortex: the hard part is already built. Reference validation, the current app graph, the rename map, the capture spool, and the eval harness were built to answer *"is this memory still true?"* The same machinery answers *"is this file still as I read it?"* The distance between where Cortex is and where this PRD points is far shorter than it looks.

---

## 14. Rollout

- **R1 gates on evidence, not calendar.** Ship when SM-1 is positive on the maintainer's own sessions, SM-3 shows zero eval regressions, and SM-C3 is zero.
- **Order within R1:** Trust Activation first (smallest, activates dormant schema, no new subsystems) → Operability (`doctor` and `ls`/`show` make everything after it debuggable) → Read Ledger and P&L (establishes the measurement the rest is judged by) → Content Cache (the largest new surface, now measurable) → Subagent Memory (depends on the harness assumption resolving).
- **R2 is gated on R1 field evidence**, specifically SM-2. If agents are not using the cheap surfaces, adding a new push channel is the wrong next move.
- **R3 is gated on FR-24 being stable in the field.**
- **R4 is gated on FR-41 relevance data** showing where ranking actually fails.
- Each release updates `README.md`, `CLAUDE.md`, and `AGENTS.md` in the same change that alters behavior.

---

## 15. Open Questions

**Phase-blockers — ALL FOUR RESOLVED 2026-07-24** by empirical investigation against Claude Code v2.1.170 and the live checkout. Resolutions are binding on architecture.

1. **[§4.4] RESOLVED — YES, and more richly than assumed.** Every hook payload carries `agent_id` (subagent UUID) and `agent_type`. `PreToolUse`/`PostToolUse` fire for subagent tool calls, distinguished by `agent_id`. `SubagentStart` and `SubagentStop` both exist as hook events; `SubagentStop` carries the parent's `session_id`, the child's `agent_id`, and `last_assistant_message` — the subagent's conclusion, delivered for free. `SubagentStart` stdout is injected into the subagent's context, which is exactly the channel FR-18 needs.
   **Consequences:** §4.4 grows rather than shrinks. FR-17 linkage is near-trivial (`agent_id` + `session_id`). FR-18 needs no parent involvement at all. FR-19 write-back has a purpose-built payload.
   **Also uncovered — a live defect, not a gap:** subagent tool calls already fire `PostToolUse` today and are attributed to the *parent* session, because session resolution keys on `cwd`. Subagent activity has been silently polluting parent timelines. Empirically confirmed: 52 sessions in the working database, all `agent_type: 'primary'`, zero with `parent_session_id`. This must be its own story and it is a **bug fix, scheduled ahead of the feature work**.

2. **[§4.3] RESOLVED — the question dissolves; no model is required.** A file card's load-bearing content is deterministically derivable: exported symbols from the AST or an available language server, purpose from the file's leading doc comment, gotchas from existing notes that reference the file. Model enrichment becomes an *opportunistic* path — an MCP tool the agent may call to attach a richer card after it has already read the file — never a dependency.
   **Consequences:** FR-10 ships regardless of model availability. The §16 assumption is retired rather than resolved. Deterministic cards are also *verifiable* — an extracted symbol list cannot be wrong the way a generated summary can, which matters under SM-C3.

3. **[FR-6] RESOLVED — interception is available, and the safe mechanism is not the obvious one.** Three capabilities exist: `PreToolUse` → `permissionDecision: "deny"` (blocks the call, feeds the reason back to Claude); `PreToolUse` → `updatedInput` (rewrites tool arguments); and `PostToolUse` → `hookSpecificOutput.updatedToolOutput`, which **replaces the tool's result before Claude sees it**. The last was extended from MCP-only to all built-in tools in v2.1.121; this machine runs v2.1.170.
   **Decision: use `PostToolUse` substitution, not `PreToolUse` denial.** Denial is a guess made before the evidence exists — Cortex would have to bet the file is unchanged. Substitution happens with the actual bytes in hand: hash what was just read, compare to the recorded digest, and substitute *only* on a match. Under that design Cortex cannot assert falsely, because it is holding the content it is making a claim about. Disk I/O is spent either way; the tokens are what the refund is made of, and those are still saved. This satisfies SM-C3 by construction rather than by discipline.
   **Consequences:** SM-2's ceiling is no longer gated on the agent choosing to call a tool, and SM-2 becomes directly measurable — Cortex observes every read and knows whether a digest was available and whether it substituted. See §5 and §10 for the two constraints this forced open.

4. **[FR-24] RESOLVED — path-primary with a commit-anchored repair path.** Identity is a hash of the absolute realpath of `git rev-parse --git-common-dir`, with the root-commit OID stored alongside as a repair anchor. Verified on this machine, including a path containing a space.
   **Why:** `--git-common-dir` resolves every worktree of a repository to the same store, which is correct — Cortex already partitions worktrees internally by scope key. Separate clones get separate stores, which is also correct. Rejected: remote URL (breaks for local-only repos; makes a fork silently share upstream's memory), root-commit OID as *primary* (forks share a root commit; empty repos have none), and a committed id file (writing into a user's repository for our own bookkeeping is how tools get uninstalled).
   **Repair path for Risk R-4:** on a cold start with no store at the computed path, look for a store whose recorded root-commit OID matches the current repository and whose recorded path no longer exists — that is a moved repository, and adoption is offered rather than starting empty. Without git, fall back to a hash of the working directory's realpath and report the degradation.

**Non-blocking** — resolve before the release that needs them; logged with owner and revisit condition.

5. What is the supported predicate vocabulary for invariant notes (FR-30)? Deferring this into implementation would let a design decision escape into code. *Owner: architecture, at R2 planning.*
6. Should imported memory (FR-35) be writable by Cortex, or strictly read-only with the source file remaining authoritative? *Owner: architecture, at R3 planning.*
7. Does a stable, hash-addressed project directory conflict with the branch/worktree scoping model in any case not already handled? *Owner: architecture, alongside Q4.*
8. What is the token cost of the conflict marker and rejected-alternatives line at realistic recall sizes — does §4.1 pay for itself under SM-C1? *Owner: measurable during the §4.1 story; gate before §4.1 ships.*

---

## 16. Assumptions Index

- **§4.4 (FR-17)** — The host harness exposes subagent dispatch and completion at the hook layer with enough identity to link parent and child sessions. *Fallback defined; must be validated before scheduling.*
- **§4.3 (FR-10)** — A model is reachable for card generation in at least one supported configuration. *If not, cards degrade to digest-only and §4.3's savings drop to the digest, negative-result, and tool-output paths.*
- **§4.2 (FR-8)** — Token counts for injected output can be measured accurately enough with the existing estimator for accounting to be credible. *If the estimator drifts materially from real tokenization, SM-1 is unreliable and the estimator must be replaced before R1 ships.*
- **§4.3 (FR-15)** — Dirty-file-set plus `head_oid` is a sufficient cache key for deterministic commands. *If environment or dependency state can change results without either changing, the key is incomplete and tool-output caching must be narrowed.*
- **§4.5 (FR-24)** — Users will accept the database moving out of their project root. *If project-local storage turns out to be a valued property, relocation becomes opt-in and the WAL policy must land independently.*
- **§7 (SM-2)** — Realization rate is measurable — Cortex can observe that an agent read a file for which a digest was available. *Depends on Q3; if Cortex cannot observe the unrealized case, SM-2 degrades to a weaker proxy.*
- **§4.8 (FR-40)** — A locally-executing embedding model of acceptable quality can run within the dependency policy without adding heavyweight native dependencies. *If not, semantic ranking stays off and the roadmap's R4 shrinks.*

---

## 17. Dependencies

- **Host harness** (Claude Code, Codex, and other MCP hosts) — hook lifecycle, subagent signals, MCP tool transport. Cortex's ambient behavior is entirely dependent on hook wiring remaining stable.
- **`better-sqlite3`** — synchronous storage. FTS5 availability is a hard requirement.
- **`jq` and a POSIX shell** — current hook implementation. FR-23 makes the dependency visible; a future change may remove it.
- **Git** — scope derivation, rename mapping, and every cache key that references `head_oid`. Cortex degrades to project scope without it.
- **Language server (R4 only)** — FR-39 symbol validation. Optional; absence degrades to file-level.
