---
stepsCompleted:
  ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/prd.md
  - _bmad-output/planning-artifacts/prds/prd-cortex-2026-07-24/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-cortex-2026-07-24/ARCHITECTURE-SPINE.md
  - _bmad-output/project-context.md
release: R1
---

# Cortex Context Economy - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Release 1 of the Cortex Context Economy, decomposing requirements from the PRD and the Architecture Spine into implementable stories.

**Scope:** R1 only — FR-1 through FR-26, plus FR-44 pulled forward from R4. FR-27 through FR-43 remain roadmap in the PRD and are not decomposed here.

**No UX design contract exists or is required.** Cortex is a CLI and MCP surface with no user interface. The equivalent "interface" concerns — output shape, token budgets, silence discipline — are captured as NFRs.

## Amendment — 2026-07-28 (competitive-research course correction)

Scope amended after a four-quadrant competitive research sweep; full rationale
and consequences in `replan-r1-2026-07-28.md` (same directory). Summary:

- **Withdrawn from R1:** Stories 4.1, 4.2 (file cards — commoditized by Aider
  repomap and peers; FR-10/FR-11 return to PRD roadmap) and Story 5.4 (sibling
  claims — shipped natively by Claude Code Agent Teams; FR-20 returns to PRD
  roadmap).
- **Epic 4 execution order:** 4.5 → 4.3 → 4.4 → 4.6. Story numbering unchanged
  (Epic 1 precedent). 4.5 is time-sensitive: the platform hook it needs
  (`updatedToolOutput` for built-in tools) shipped in Claude Code v2.1.121 and
  competitors ship partial mechanisms. ~~4.5 is blocked on the open B-4 re-base
  action item (Windows hook latency) before story creation.~~ **Resolved
  2026-08-02:** B-4 re-based to ≤500 ms p95 through the installed hook; B-4a
  split by outcome — miss ≤100 ms, hit ≤300 ms p95 (ruling recorded in the PRD
  §10 amendment notes). 4.5 is unblocked.
- **Added:** Story 2.7, a docs-only repositioning pass.
- Epics 0, 1, 3 and Stories 2.1–2.6, 5.1–5.3 are unchanged. Withdrawn story
  text below is retained for the future release that picks it back up.

R1 story count: 29 → 27.

## Requirements Inventory

### Functional Requirements

**§4.1 Trust Activation**
- FR-1: Contradiction detection at write time — writing a note that opposes an active memory item on the same subject returns a conflict payload; the write always succeeds.
- FR-2: Conflict visibility in retrieval — contested items render a `[contested]` marker; counterpart items appear adjacently.
- FR-3: Rejected alternatives surfaced at recall — decisions with alternatives render an `already rejected:` line.
- FR-4: Auto-demotion of superseded decisions — a newer decision on a subject cools the older one, which stays retrievable for historical queries.

**§4.2 Read Ledger and Token P&L**
- FR-5: Content-digest capture on read — spool carries `sha256`, byte size, mtime; digesting happens in the batched flush, never in the hook.
- FR-6: Read-ledger query — four verdicts only: `unread`, `unchanged-since`, `changed-since`, `edited-by-you-since`. Re-hash; never trust mtime.
- FR-7: Read ledger in the session brief — unchanged prior-session files named inside the ≤150-token budget.
- FR-8: Token accounting — every output debited, every avoided action credited with evidence.
- FR-9: `cortex stats` reporting — injected/saved/net/ratio, retrieval health, and unrealized savings.

**§4.3 Content Cache**
- FR-10: File card generation — bounded derived summary after a repeat-read threshold; invalidated on digest change.
- FR-11: File card retrieval — returns card plus read-ledger verdict; never a stale card.
- FR-12: Negative-result capture — zero-result searches recorded against `head_oid`.
- FR-13: Negative-result query — `no-matches-at <head>` only when provably unchanged; otherwise `unknown`.
- FR-14: Tool-output capture — deterministic commands only, keyed by command, `head_oid`, dirty-file set.
- FR-15: Tool-output query — hit only on full key match; any ambiguity resolves to a miss.
- FR-16: Cache eviction and bounds — `gc` prunes; size reported and capped; dry-run default.

**§4.4 Subagent Memory**
- FR-17: Inherited subagent session — child records `parent_session_id`, inherits scope, captures separately.
- FR-18: Automatic subagent brief — derived from dispatch description, no parent action, silent when empty.
- FR-19: Subagent conclusion write-back — findings recorded as episodes; note-shaped findings go to suggestions.
- FR-20: Parallel-agent claim record — sibling-visible, expires with the parent, never durable.

**§4.5 Operability**
- FR-21: Memory listing and inspection — filtered list and full single-item view, paginated.
- FR-22: Memory correction — edit re-extracts references; delete removes derived rows; every correction audited.
- FR-23: Installation diagnosis — checks engagement, hooks, `jq`, Node, database, spool, MCP; exits non-zero on failure.
- FR-24: Storage relocation — per-project directory under a user-level home; migrate by copy-and-verify.
- FR-25: Write-ahead-log management — checkpoint on close and at threshold; size reported.
- FR-26: Zero-config installation — one idempotent command; refuses to clobber user-modified hooks.

**§4.8 (pulled forward)**
- FR-44: Retrieval-quality regression gate — locked suites in CI; fail on negative `top1_hit`/`recall_at_3` or positive `output_tokens` delta.

### NonFunctional Requirements

- N-1 Silence by default; cold starts emit nothing.
- N-2 Budgeted output on every surface; drop lowest-priority first.
- N-3 Never break the turn; any failure degrades to silence.
- N-4 No process per tool call.
- N-5 Offline and local; no production network path.
- N-6 Windows parity, verified not ported.
- N-7 Idempotent capture; replay produces identical state.
- N-8 Additive, idempotent migrations; no memory destroyed.
- N-9 Determinism where asserted; model-derived content always labeled.
- B-1..B-8 Performance budgets, including **B-4** (non-substituting PostToolUse ≤500 ms p95 through the installed hook; structurally pure-bash, no Node — amended 2026-08-02) and **B-4a** (Read substitution path, structural clause primary: no Node, index-only lookup, one added spawn on a miss / two more on a verified hit; end-to-end miss ≤600 ms / hit ≤800 ms p95 on the quiescent reference platform — amended 2026-08-02, re-based 2026-08-03; see PRD §10).
- P-1..P-6 Public-surface compatibility: MCP tools, CLI, hook protocol, schema versioning, deprecation policy.
- SM-C3 False-confidence rate must be **zero**; a single wrong assertion is a release blocker.

### Additional Requirements

**No starter template.** This is brownfield. The existing layered structure is ratified by AD-1 and is not re-scaffolded.

Architecture-derived constraints binding on stories:

- **AD-1** Layer direction one-way; new modules join existing layers.
- **AD-2** Cold path is sole SQLite writer; hot path is read-only, Node-free.
- **AD-3** Digest index is flat, greppable, derived, cold-write-only, fully regenerable.
- **AD-4** Only knowledge projects into `memory_items`; lookup structures do not.
- **AD-5** Any new `memory_items` kind ships with a locked eval fixture **in the same change**.
- **AD-6** Certainty requires evidence in hand; ambiguity resolves to a miss.
- **AD-7** Refunds are `PostToolUse` substitution only, digest-verified; never `PreToolUse` deny.
- **AD-8/AD-15** Ledger is double-entry and evidence-bearing; hot-path credits defer via spool, booked at flush.
- **AD-9** Session identity is `(scope_key, agent_id)`.
- **AD-10** One store per repository via `git-common-dir` hash, root-commit repair anchor.
- **AD-11** Migrations additive, idempotent, survive partial application; one `SCHEMA_VERSION` bump per release.
- **AD-12** Degradation silent and total.
- **AD-13** Model use opportunistic; deterministic path is the default.
- **AD-14** Derived content owned by its source, excluded from decay-driven deletion.
- **AD-16** Refund eligibility is per-session with ancestor rules, not per-scope.
- **AD-17** Conflict detection vetoes auto-demotion.

Repository conventions binding on every story (from `project-context.md`):

- Verification is `npm run build && npm run lint && npx vitest run`, plus the eval gate when retrieval is touched.
- `npm run lint` does **not** typecheck `tests/` — type errors there are invisible to both commands.
- Import specifiers use `.js` even from `.ts`; every new export added to `src/index.ts` in the same change.
- Temp dirs via `os.tmpdir()`, never a literal `/tmp`.
- Conventional Commits; docs updated in the same commit as behavior.

### UX Design Requirements

Not applicable — no user interface. See Overview.

### FR Coverage Map

| FR | Epic | Story |
| --- | --- | --- |
| — (defect) | 0 | 0.1, 0.2 |
| FR-1, FR-2 | 1 | 1.1, 1.2 |
| FR-3 | 1 | 1.3 |
| FR-4 | 1 | 1.4 |
| FR-44 | 1 | 1.5 |
| FR-21, FR-22 | 2 | 2.1, 2.2 |
| FR-23, FR-26 | 2 | 2.3, 2.4 |
| FR-24, FR-25 | 2 | 2.5, 2.6 |
| FR-5 | 3 | 3.1 |
| AD-3 (index) | 3 | 3.2 |
| FR-6 | 3 | 3.3 |
| FR-7 | 3 | 3.4 |
| FR-8 | 3 | 3.5 |
| FR-9 | 3 | 3.6 |
| FR-10, FR-11 | 4 | ~~4.1, 4.2~~ withdrawn from R1 (2026-07-28) |
| FR-12, FR-13 | 4 | 4.3 |
| FR-14, FR-15 | 4 | 4.4 |
| FR-6 (substitution) | 4 | 4.5 |
| FR-16 | 4 | 4.6 |
| FR-17 | 5 | 5.1 |
| FR-18 | 5 | 5.2 |
| FR-19 | 5 | 5.3 |
| FR-20 | 5 | ~~5.4~~ withdrawn from R1 (2026-07-28) |

Every R1 FR maps to at least one story *(amended 2026-07-28: FR-10, FR-11, and FR-20 returned to PRD roadmap with their stories' withdrawal)*. FR-6 appears twice by design: the query surface (3.3) and the substitution path built on it (4.5). Story 3.2 carries no FR — it exists because AD-3's flat digest index is required by Story 4.5 and was otherwise unowned; see Validation Finding 1.

## Validation Findings

Step-4 validation was run against the completed breakdown. Three findings; the first was a genuine gap and is now closed.

**Finding 1 — AD-3's flat digest index had no owning story.** Story 3.1 stores digest records in SQLite; Story 4.5 requires reading them from a flat, greppable, Node-free index. Nothing created that index. Both stories were individually complete and the gap sat between them — exactly the forward-dependency failure this validation exists to catch. **Closed** by adding Story 3.2, placed before the read-ledger query so both consumers build on it.

**Finding 2 — `SCHEMA_VERSION` bump discipline needs stating.** Four stories introduce new tables (3.1 `content_digests`, 4.1 `file_cards`, 4.3 `negative_results`, 4.4 `tool_outputs`). AD-11 mandates **one** `SCHEMA_VERSION` increment per release, not per table. A dev agent following "create tables in the story that needs them" would bump the version four times. **Binding rule for R1:** the first story to add a table bumps `SCHEMA_VERSION` 4 → 5 and creates the `V5_TABLES` constant; every later story **appends to that same constant** and does not touch the version. This is safe because `applySchema` runs the DDL unconditionally with `CREATE TABLE IF NOT EXISTS`, so a store already marked v5 still receives tables appended later.

**Finding 3 — two backward-compatible forward references, accepted.** Story 3.5's hot-path-credit criterion describes flush behavior for records that Story 4.5 will later produce, and Story 2.2's card-deletion criterion references cards introduced in Story 4.1. Both are conditional and vacuously satisfiable before their producer exists, and both are testable in isolation with a synthetic record. Accepted rather than reordered — moving them would put the ledger after the cache and break the "measurement before the measured" ordering that PRD §14 mandates.

**File-churn check.** Epics 1, 3, and 4 all touch `src/db/schema.ts` and `src/db/store.ts`; Epics 2, 3, and 4 all touch `src/transports/cli.ts`. The overlap was considered and the split retained: each epic has a distinct feedback loop, the ordering is dependency-driven rather than thematic, and consolidating them would produce one epic large enough to lose the measurement checkpoint between the ledger and the cache. Overlap is incidental to a small codebase, not a symptom of a bad split.

## Epic List

| # | Epic | Why here | FRs |
| --- | --- | --- | --- |
| **0** | Session Identity Correction | **Bug fix, not a feature.** Subagent tool calls are misattributed to the parent session today. Everything downstream reads sessions; building on misattributed data would bake the defect in. | AD-9 |
| **1** | Trust Activation | Smallest new surface, activates dormant schema, no new subsystems. Establishes the AD-5 fixture discipline on the cheapest possible change. | FR-1..FR-4, FR-44 |
| **2** | Operability | Everything after this needs to be debuggable and inspectable. Ships `doctor` before the subsystems that will need diagnosing. | FR-21..FR-26 |
| **3** | Read Ledger and Token P&L | Establishes the measurement the rest of the release is judged by, before the thing being measured exists. | FR-5..FR-9 |
| **4** | Content Cache | The largest new surface — and now measurable on arrival. | FR-12..FR-16, FR-6 substitution *(FR-10/FR-11 withdrawn 2026-07-28)* |
| **5** | Subagent Memory | Depends on Epic 0's session identity being correct. | FR-17..FR-19 *(FR-20 withdrawn 2026-07-28)* |

---

## Epic 0: Session Identity Correction

Fix the live defect where subagent tool calls are attributed to the parent session, so that every later epic reads correctly-attributed session data. Sessions become keyed by `(scope_key, agent_id)` per AD-9. This epic ships no user-visible feature; its value is that Epics 3–5 are not built on corrupt attribution.

### Story 0.1: Resolve sessions by agent identity

As a Cortex maintainer,
I want hook payloads carrying an `agent_id` to resolve to a child session rather than the parent,
So that subagent activity stops silently polluting the parent's timeline.

**Acceptance Criteria:**

**Given** a PostToolUse payload with no `agent_id`
**When** the session is resolved for the payload's `cwd`
**Then** it resolves to the scope's active primary session
**And** existing capture behavior is unchanged.

**Given** a PostToolUse payload carrying `agent_id` and `agent_type`
**When** the session is resolved
**Then** a child session is created on demand with `parent_session_id` set to the scope's active primary session, `agent_type` from the payload, and the scope's `scope_key`
**And** the event is attributed to the child, never the parent.

**Given** two payloads carrying different `agent_id` values in the same scope
**When** both are resolved
**Then** they resolve to two distinct child sessions
**And** neither is attributed to the other.

**Given** a payload whose `agent_id` matches an existing child session
**When** it is resolved
**Then** the existing child is reused rather than duplicated.

**Given** the spool carries entries recorded before this change with no `agent_id` field
**When** the flush replays them
**Then** they resolve to the primary session without error (N-7 idempotence preserved).

### Story 0.2: Carry agent identity through the capture spool

As a Cortex maintainer,
I want the capture spool to record `agent_id` and `agent_type` per entry,
So that attribution survives the gap between the hook firing and the batched flush.

**Acceptance Criteria:**

**Given** the PostToolUse hook fires for a subagent tool call
**When** it appends a spool line
**Then** the line carries `agent_id` and `agent_type`
**And** the hook spawns no Node process (N-4)
**And** the hook stays within budget B-4.

**Given** a spool batch containing entries from the primary session and two subagents
**When** the batch is flushed
**Then** each entry is written to the session matching its `agent_id`
**And** replaying the same batch produces identical state (N-7).

**Given** a spool line whose `agent_id` refers to a subagent whose parent session has since ended
**When** the flush replays it
**Then** the entry is still attributed to the correct child session
**And** no error surfaces to the user (AD-12).

---

## Epic 1: Trust Activation

Activate the two schema columns that have been written since v1 and read by nothing. Cortex stops merely reporting what it holds and starts noticing when it disagrees with itself. This epic also establishes the AD-5 fixture discipline on the cheapest possible change, and lands the CI gate that protects every later epic.

### Story 1.1: Detect contradictions at note write time

As an agent writing durable memory,
I want to be told when a new note opposes an active decision on the same subject,
So that contradictions surface before an implementing agent acts on the wrong one.

**Acceptance Criteria:**

**Given** an active `note:decision` on subject S
**When** a new note is written on subject S whose content opposes it
**Then** the write succeeds
**And** a conflict payload is returned naming the prior item's id, subject, timestamp, and text
**And** `notes.conflict` is set to `1` on both the prior and the new note.

**Given** a note written with no subject
**When** the write is processed
**Then** no conflict detection runs and no extra queries are issued.

**Given** a subject with no active item
**When** a note is written on it
**Then** no conflict is produced.

**Given** a database holding 10,000 memory items
**When** a note is written
**Then** conflict detection adds no more than 5 ms to the write.

**Given** conflict detection is running
**When** it evaluates a candidate pair
**Then** it completes deterministically and offline, with no model call on the write path.

### Story 1.2: Render contested items in retrieval

As an agent recalling a topic,
I want contested memories marked as contested,
So that I do not act on one side of an unresolved disagreement without knowing.

**Acceptance Criteria:**

**Given** a retrieved item with `conflict = 1`
**When** recall, brief, or state renders it
**Then** it carries a `[contested]` marker costing no more than 4 tokens.

**Given** both sides of a contested pair rank within the returned set
**When** results are rendered
**Then** the two appear adjacently.

**Given** the output budget binds
**When** contested items are rendered
**Then** the marker is subject to the same budget rules as all other content.

**Given** the locked eval suites
**When** this change is applied
**Then** no suite regresses on `top1_hit`, `recall_at_3`, or `output_tokens`.

### Story 1.3: Surface rejected alternatives at recall

As an agent proposing an approach,
I want to see which options were already considered and rejected,
So that I stop relitigating decisions that were settled before I arrived.

**Acceptance Criteria:**

**Given** a `note:decision` with a non-empty `alternatives` array
**When** it is included in recall output
**Then** an `already rejected:` line lists those alternatives.

**Given** the output budget binds
**When** rendering a decision with alternatives
**Then** the alternatives line drops before the decision itself drops.

**Given** a decision with no alternatives
**When** it is rendered
**Then** output is byte-identical to current behavior.

**Given** a new locked eval fixture exercising a decision that carries alternatives
**When** the suite runs
**Then** the fixture asserts the `already rejected:` line is present and within budget.

### Story 1.4: Auto-demote superseded decisions without resolving contests

As a user whose decisions evolve,
I want a newer decision to cool its predecessor automatically,
So that stale guidance stops surfacing without me closing every note by hand.

**Acceptance Criteria:**

**Given** an active decision on subject S in state `hot`
**When** a new, non-contradicting decision is written on subject S
**Then** the older item moves at least one tier colder
**And** it remains retrievable for temporal queries such as `old`, `history`, and `what did we decide before`.

**Given** a new decision on subject S that **contradicts** the active decision on S
**When** the write is processed
**Then** conflict detection marks both contested
**And** **neither** item's state changes (AD-17)
**And** demotion resumes only after the conflict is closed via `cortex_resolve`.

**Given** an active `note:blocker` on subject S
**When** a new decision is written on subject S
**Then** the blocker is not demoted.

### Story 1.5: Gate retrieval quality in CI

As a Cortex maintainer,
I want the locked eval suites to run automatically on retrieval-affecting changes,
So that ranking quality cannot regress silently.

**Acceptance Criteria:**

**Given** a change touching retrieval, ranking, tokenization, reference validation, or output shaping
**When** CI runs
**Then** every locked suite in `eval/suites/` is evaluated against its baseline.

**Given** a suite result with a negative `top1_hit` delta, a negative `recall_at_3` delta, or a positive `output_tokens` delta
**When** the gate evaluates it
**Then** the build fails and names the regressing suite and metric.

**Given** a contributor intends to regenerate a baseline
**When** they run the regeneration
**Then** it requires an explicit flag
**And** the change is rejected unless the commit body states the justification.

**Given** a change that introduces a new `kind` value into `memory_items`
**When** the gate evaluates it
**Then** the build fails unless a locked fixture exercising that kind is added in the same change (AD-5).

---

## Epic 2: Operability

Make Cortex inspectable, correctable, diagnosable, and safely installable — before shipping the subsystems that will need all four. Nothing here is glamorous and all of it gates trust.

### Story 2.1: List and inspect memory

As a user who does not trust what they cannot see,
I want to list and inspect stored memory,
So that I can verify what Cortex actually holds.

**Acceptance Criteria:**

**Given** a store with memory items across several scopes and kinds
**When** the listing command runs with scope, kind, and state filters
**Then** it returns matching items with ids, ordered by a stated criterion
**And** output is paginated and never dumps the whole store.

**Given** a memory item id
**When** the inspect command runs
**Then** it shows the full text, extracted references, trust label, conflict status, and access history.

**Given** an id that does not exist
**When** inspect runs
**Then** it reports that clearly and exits non-zero.

### Story 2.2: Correct and delete memory

As a user who found a wrong memory,
I want to edit or delete it,
So that a mistake is not permanent.

**Acceptance Criteria:**

**Given** an existing memory item
**When** its text is edited
**Then** references are re-extracted and the memory item is re-projected
**And** the correction is recorded in an audit trail that survives the correction.

**Given** an existing memory item
**When** deletion is requested
**Then** the user confirms before it runs
**And** the item and its derived rows are removed together in one transaction.

**Given** a deletion of an item with a derived file card
**When** the deletion runs
**Then** the card and its projection are removed with it (AD-14).

### Story 2.3: Diagnose the installation

As a user whose Cortex silently stopped working,
I want a command that tells me why,
So that a broken hook does not masquerade as an empty memory.

**Acceptance Criteria:**

**Given** a project with Cortex installed
**When** the diagnostic runs
**Then** it checks and reports engagement state, hook script presence, placeholder substitution, hook version currency, `jq` availability, Node resolution, database reachability and schema version, spool size and staleness, and MCP server registration.

**Given** an installed hook script that is syntactically valid and correctly substituted but predates the template shipped by the running build
**When** the diagnostic runs
**Then** it reports the hook as out of date, names re-running the install command as the fix, and exits non-zero
**And** this holds even though nothing about the stale hook is otherwise broken (Observation 2 — this criterion is what makes Epic 2 the owner of that risk).

**Given** any check fails
**When** the report is rendered
**Then** the failing check names the specific fix
**And** the command exits non-zero so it can gate CI.

**Given** all checks pass
**When** the diagnostic runs
**Then** it completes within 3 seconds (B-7) and exits zero.

**Given** the diagnostic runs on Windows under Git Bash
**When** it checks hook execution
**Then** it verifies the actual configured interpreter path rather than assuming a POSIX default (N-6).

### Story 2.4: Install in one idempotent command

As a new user,
I want a single command to set Cortex up correctly,
So that the install cliff is not the adoption cliff.

**Acceptance Criteria:**

**Given** a project with no Cortex configuration
**When** the install command runs
**Then** it writes hook scripts with correct placeholder substitutions, registers the MCP server, adds ignore entries, and runs the diagnostic.

**Given** Cortex is already installed and unmodified
**When** the install command runs again
**Then** the result is identical and it reports that nothing changed.

**Given** a hook script the user has modified
**When** the install command would overwrite it
**Then** it refuses without explicit confirmation.

### Story 2.5: Relocate the store out of the project root

As a user whose repository should not contain a database,
I want Cortex's store addressed by repository identity outside my working tree,
So that worktrees share one store and my project root stays clean.

**Acceptance Criteria:**

**Given** a git repository
**When** store identity is computed
**Then** it is a hash of the absolute realpath of `git rev-parse --git-common-dir` (AD-10)
**And** every worktree of that repository resolves to the same store.

**Given** two separate clones of the same repository on one machine
**When** identity is computed for each
**Then** they resolve to two distinct stores.

**Given** an existing project-root database
**When** the store is first opened after this change
**Then** it is migrated by copy, verified, and the original is left in place until the user confirms removal.

**Given** a repository that has been moved or renamed, with no store at the computed path
**When** Cortex starts
**Then** a store whose recorded root-commit OID matches and whose recorded path no longer exists is offered for adoption rather than starting empty.

**Given** a directory that is not a git repository
**When** identity is computed
**Then** it falls back to a hash of the working directory realpath and reports the degradation.

### Story 2.6: Bound the write-ahead log

As a user watching a database grow,
I want the WAL checkpointed and reported,
So that Cortex's footprint stays bounded and visible.

**Acceptance Criteria:**

**Given** a session ends
**When** the store is closed
**Then** a checkpoint runs.

**Given** the WAL crosses its configured threshold mid-session
**When** the threshold is detected
**Then** a checkpoint runs off the critical path and blocks no hook.

**Given** the stats command runs
**When** it reports footprint
**Then** it names database and WAL size separately.

### Story 2.7: Reposition the docs (added 2026-07-28)

As a maintainer,
I want the README and CLAUDE.md to lead with what is unique,
So that the project is not pitched into a category already owned by claude-mem's install base and Anthropic's default-on auto-memory.

**Acceptance Criteria:**

**Given** the README
**When** it introduces the project
**Then** it leads with the trust/freshness/economy framing — the layer that makes agent memory trustworthy and accountable — not "memory for Claude Code".

**Given** the comparison section
**When** it names alternatives
**Then** it honestly describes native auto-memory and claude-mem, and names the six capabilities unique here: branch/worktree scoping, subagent sessions, deterministic contradiction detection, checkout-freshness with rename resolution, enforced budgets, CI-gated retrieval quality.

**Given** the change ships
**When** it is reviewed
**Then** it contains no behavior changes, and docs land in one commit per repo convention.

---

## Epic 3: Read Ledger and Token P&L

Establish the measurement before the thing being measured. This epic makes the product's central claim falsifiable: every Cortex output is debited, every avoided action is credited with evidence, and the net is reportable.

### Story 3.1: Capture content digests on read

As Cortex,
I want a content digest recorded for every file the agent reads,
So that I can later tell whether that file has changed.

**Acceptance Criteria:**

**Given** the agent reads a file
**When** the spool batch is flushed
**Then** a digest record is stored carrying `sha256`, byte size, mtime, path, and `scope_key`
**And** the record identifies the reading session and its `agent_id` (AD-16).

**Given** the PostToolUse hook fires for a Read
**When** the spool line is appended
**Then** no Node process is spawned (N-4) and the hook stays within its budget.

**Given** a file larger than the configured size ceiling (default 2 MiB)
**When** it is read
**Then** path and size are recorded, no digest is computed, and the record is marked `oversize`.

**Given** a binary or non-UTF-8 file
**When** it is read
**Then** it is digested but never carded.

**Given** digest storage for a tracked file
**When** its footprint is measured
**Then** it costs no more than 400 bytes per file.

**Given** this is the first story in R1 to add a table
**When** the migration is authored
**Then** it bumps `SCHEMA_VERSION` 4 → 5 exactly once for the release and creates the `V5_TABLES` constant that later stories append to (AD-11, Validation Finding 2).

**Given** the migration runs against a store already at v5
**When** it is applied again
**Then** it completes without error and changes nothing — `CREATE TABLE IF NOT EXISTS` throughout, no destructive statement (AD-11, N-8).

**Given** the migration is interrupted at any statement boundary
**When** the store is reopened by either the current or the previous binary
**Then** it opens successfully and no user-authored memory is lost (AD-11).

**Given** a store written by a newer schema version
**When** an older binary opens it
**Then** it refuses clearly rather than corrupting it (P-5).

### Story 3.2: Build the flat digest index

As Cortex,
I want a flat, greppable projection of the digest records,
So that the hot path can answer freshness questions without opening SQLite or spawning Node.

**Acceptance Criteria:**

**Given** digest records exist in the store
**When** the cold-path flush completes
**Then** it writes a line-oriented index file containing, per record, the path, `sha256`, byte size, recording session id, and `agent_id`.

**Given** the index file
**When** the hot path looks up a path
**Then** the record is locatable with `grep` alone, requiring no JSON parsing in the hook (AD-3).

**Given** the index file is deleted
**When** Cortex next runs
**Then** it is fully regenerated from SQLite and no memory is lost — the index is derived, never authoritative (AD-3).

**Given** the hot path is running
**When** it interacts with the index
**Then** it only ever reads; the cold path is the sole writer (AD-2).

**Given** the index grows across a long-lived project
**When** a lookup runs
**Then** it completes within the share of B-4a left after hashing — measured, not assumed, before Epic 4 depends on it.

### Story 3.3: Answer the read-ledger question

As an agent about to read a file,
I want to know whether I have already read it and whether it has changed,
So that I can skip work I have already paid for.

**Acceptance Criteria:**

**Given** a file with no digest record in this scope
**When** the read ledger is queried
**Then** it returns `unread`.

**Given** a file whose current on-disk `sha256` matches the recorded digest
**When** the read ledger is queried
**Then** it returns `unchanged-since <ts>`
**And** the verdict was produced by re-hashing the file, not by comparing mtime.

**Given** a file whose content has changed since the recorded digest
**When** the read ledger is queried
**Then** it returns `changed-since <ts>`.

**Given** a file the requesting session edited after reading it
**When** the read ledger is queried
**Then** it returns `edited-by-you-since <ts>`.

**Given** a file that no longer exists
**When** the read ledger is queried
**Then** it returns `changed-since` qualified as `missing`, never `unchanged`.

**Given** a digest recorded by a sibling or descendant session
**When** the read ledger is queried by a session that is not the recorder or its descendant
**Then** the verdict reports the change fact but attributes it explicitly to the recording agent, and never says "you read it" (AD-16).

**Given** a database of 10,000 memory items
**When** the read ledger is queried
**Then** it responds within 20 ms at p95 and within 30 output tokens.

### Story 3.4: Surface the read ledger in the session brief

As an agent resuming work,
I want to know which files I already know about,
So that I do not re-read them to orient myself.

**Acceptance Criteria:**

**Given** a prior session in this scope read files that are still unchanged
**When** the session brief is built
**Then** it includes one line naming up to five of them, ordered by read frequency.

**Given** the ≤150-token brief budget binds
**When** the brief is assembled
**Then** the read-ledger line drops first.

**Given** a cold start with no prior session
**When** the brief is built
**Then** it emits nothing (N-1).

### Story 3.5: Account for tokens injected and saved

As a user judging whether Cortex earns its place,
I want an honest ledger of what Cortex cost and what it returned,
So that the product's central claim is falsifiable rather than asserted.

**Acceptance Criteria:**

**Given** any Cortex output surface renders
**When** the render completes
**Then** a ledger row is written with `direction: 'injected'` and the measured token count.

**Given** a specific avoided action with a recorded size
**When** the credit is booked
**Then** a ledger row is written with `direction: 'saved'` carrying the evidence — file and byte size for an avoided read, output size for an avoided command, result count for an avoided search.

**Given** an avoided action whose cost cannot be identified from recorded evidence
**When** accounting runs
**Then** no `saved` row is written. There is no modeled or counterfactual credit.

**Given** a cold-path operation
**When** its ledger row is written
**Then** the write shares the operation's transaction; a failed operation records nothing (AD-8).

**Given** a credit originating in the hot path
**When** it is recorded
**Then** it is emitted as a spool record carrying its own evidence and booked by the cold-path flush under exactly-once semantics (AD-15)
**And** a lost spool record results in no credit rather than a reconstructed one.

**Given** a surface was available and the agent did not use it
**When** accounting runs
**Then** the case is recorded as *unrealized*, separately from savings.

### Story 3.6: Report the P&L

As a user,
I want `cortex stats` to show what Cortex cost and returned,
So that I can judge it on a number rather than a claim.

**Acceptance Criteria:**

**Given** a session with ledger activity
**When** stats runs
**Then** it reports tokens injected, tokens saved, net, and ratio, for the session and cumulatively for the scope.

**Given** a store with memory items
**When** stats runs
**Then** it reports item counts by state, the count never retrieved, and the ten most-retrieved items.

**Given** unrealized savings exist
**When** stats runs
**Then** they are reported distinctly from realized savings, so the capability-versus-adoption gap is visible.

**Given** a database with 10,000 memory items
**When** stats runs
**Then** it completes within 200 ms (B-6).

---

## Epic 4: Content Cache

The largest new surface, and now measurable on arrival. Digests become answers: cards substitute for reading, negative results stop repeated fruitless searches, and cached command outcomes stop repeated expensive runs. Every assertion here is fenced by AD-6 — evidence in hand, ambiguity resolves to a miss.

**EXECUTION ORDER (amended 2026-07-28): 4.5 → 4.3 → 4.4 → 4.6.** Story
numbering unchanged (Epic 1 precedent). 4.5 leads because its platform
dependency (`updatedToolOutput` for built-in tools) shipped in Claude Code
v2.1.121 and partial competitor mechanisms exist — see
`replan-r1-2026-07-28.md`. 4.5 is blocked on the open B-4 re-base action item
before story creation. Stories 4.1 and 4.2 are withdrawn from R1.

### Story 4.1: Derive file cards deterministically — WITHDRAWN FROM R1 (2026-07-28)

*Withdrawn: file cards are the most commoditized item in the plan (Aider
repomap, tokensave symbol graphs, DeepWiki) and the weakest fit with the
determinism story. FR-10 returns to PRD roadmap. Text retained for a future
release. See `replan-r1-2026-07-28.md`.*

As an agent needing orientation on a file,
I want a bounded summary I can read instead of the file,
So that orientation costs 200 tokens instead of 4,000.

**Acceptance Criteria:**

**Given** a file read three or more times across two or more sessions in one scope
**When** the threshold is crossed
**Then** a card is generated stating the file's purpose, its exported symbols, and gotchas derivable from notes referencing it.

**Given** no model is available
**When** a card is generated
**Then** it is still produced from deterministic sources — AST or language-server symbols, the leading doc comment, and referencing notes (AD-13)
**And** nothing in the path blocks on a model.

**Given** a card exists and its source digest changes
**When** the change is detected
**Then** the card is invalidated immediately and is never served stale.

**Given** card generation is triggered
**When** it runs
**Then** it is asynchronous and blocks no read, flush, or turn.

**Given** a card is stored
**When** it is projected
**Then** it becomes a `memory_items` row of a new kind (AD-4)
**And** a locked eval fixture exercising that kind is added in the same change (AD-5)
**And** the card is excluded from decay-driven deletion (AD-14).

**Given** a card is 200 tokens or fewer
**When** it is rendered
**Then** it is labeled as derived content (N-9).

**Given** the optional model-enrichment path runs
**When** card generation completes
**Then** no network request was made by any production code path, and this is asserted by test rather than assumed (N-5, PRD §11.1).

### Story 4.2: Serve file cards with a freshness verdict — WITHDRAWN FROM R1 (2026-07-28)

*Withdrawn with Story 4.1 (FR-11 returns to PRD roadmap). Text retained for a
future release.*

As an agent,
I want a card returned together with its file's current state,
So that I know whether I am oriented on the current file or a past one.

**Acceptance Criteria:**

**Given** a card whose source digest matches the file on disk
**When** the card is requested
**Then** it is returned with the file's read-ledger verdict
**And** the response states the token cost of reading the full file, so the agent can choose.

**Given** a card whose source digest no longer matches
**When** the card is requested
**Then** nothing is returned — never a stale card.

**Given** a card is returned
**When** it renders
**Then** it explicitly identifies itself as a summary, not the file.

### Story 4.3: Remember searches that found nothing

As an agent about to repeat a fruitless search,
I want to be told it already returned nothing,
So that I stop paying full price for zero results.

**Acceptance Criteria:**

**Given** a search returns zero results
**When** it is captured
**Then** the record carries the query, the search root, the tool used, the `head_oid`, and the `scope_key`.

**Given** a recorded negative result whose search root is provably unchanged since capture, including uncommitted working-tree changes
**When** it is queried
**Then** it returns `no-matches-at <head>` in 25 tokens or fewer.

**Given** any file under the search root has changed since capture
**When** the negative result is queried
**Then** it is invalidated and returns a miss.

**Given** change status cannot be established
**When** the negative result is queried
**Then** it returns `unknown` — never a false negative (AD-6).

**Given** a negative result recorded in one scope
**When** queried from another scope
**Then** it is never asserted across the boundary.

### Story 4.4: Remember the outcome of expensive commands

As an agent about to re-run a test suite,
I want to know the prior outcome and whether it still applies,
So that I do not re-run work whose inputs have not moved.

**Acceptance Criteria:**

**Given** a command classified as deterministic-under-fixed-state (test, build, typecheck, lint)
**When** it completes
**Then** a record is stored carrying the normalized command, exit code, `head_oid`, the dirty-file set at run time, and the output size — reusing the existing command-run and redaction path so secrets never enter the cache.

**Given** a command with side effects
**When** it completes
**Then** it is never recorded.

**Given** a cached outcome whose `head_oid` matches, whose dirty-file set is unchanged, and none of whose recorded touched files have changed
**When** it is queried
**Then** it returns the prior exit code, when it ran, and the conditions under which it is being asserted.

**Given** any component of the cache key cannot be confirmed
**When** the outcome is queried
**Then** it returns a miss. A false "your tests pass" is the worst failure this product can produce (SM-C3).

### Story 4.5: Refund redundant reads through verified substitution

As an agent that just re-read a file it already knows,
I want the result replaced by a short equivalent,
So that the redundant read costs twenty tokens instead of four thousand.

**Acceptance Criteria:**

**Given** substitution is enabled and a Read completes
**When** the PostToolUse hook hashes the returned content and it matches the recorded digest for that path and session lineage
**Then** the hook returns `hookSpecificOutput.updatedToolOutput` with a short equivalent payload.

**Given** the hashed content does not match the recorded digest, or the file is oversize, or the digest belongs to a session that is not the requester or its ancestor
**When** the hook evaluates substitution
**Then** the original output passes through unchanged (AD-6, AD-16).

**Given** substitution occurs
**When** the payload renders
**Then** it names itself as a substitution, names the file, and states the token cost of the full content.

**Given** the same file is read a second time within one turn
**When** the hook evaluates substitution
**Then** the original output passes through unsubstituted.

**Given** the hook runs the substitution path
**When** it completes
**Then** it spawns no Node process (N-4), reads only the flat digest index (AD-3), and stays within B-4a as re-based 2026-08-03: the structural clause is primary — exactly one added spawn on a miss, two more on a verified hit, the hash strictly after the size and eligibility gates — with end-to-end ≤600 ms on a miss, ≤800 ms on a verified hit, at p95 through the installed hook on the quiescent reference platform.

**Given** substitution has never been explicitly enabled
**When** a Read completes
**Then** no substitution occurs.

**Given** `PreToolUse` fires for a Read
**When** the hook evaluates it
**Then** it never returns `permissionDecision: "deny"` for economic reasons (AD-7).

### Story 4.6: Bound and evict the derived cache

As a user on a large repository,
I want the derived cache bounded,
So that Cortex's footprint does not grow with my codebase.

**Acceptance Criteria:**

**Given** `gc` runs
**When** it prunes
**Then** it removes digests for files absent from the current app graph, negative results past the configured horizon, and tool outputs whose `head_oid` is no longer an ancestor of HEAD *(amended 2026-07-28: card pruning removed with Story 4.1's withdrawal; restore it when cards return)*.

**Given** the derived cache exceeds its configured ceiling
**When** eviction runs
**Then** the oldest, least-retrieved entries evict first.

**Given** `gc` is invoked without an explicit apply flag
**When** it runs
**Then** it reports what it would remove and changes nothing.

**Given** stats runs
**When** it reports footprint
**Then** derived-cache size is reported against its ceiling.

---

## Epic 5: Subagent Memory

Close the largest token hole in modern agent work. Subagents inherit context without the parent pasting it, and their conclusions survive them. Depends on Epic 0 for correct attribution.

### Story 5.1: Link subagent sessions to their parent

As a Cortex maintainer,
I want a dispatched subagent to operate in a session linked to its parent,
So that its work is attributable and its findings are recoverable.

**Acceptance Criteria:**

**Given** a subagent is dispatched from a Cortex-engaged session
**When** `SubagentStart` fires
**Then** a child session is created recording `parent_session_id`, `agent_id`, `agent_type`, and the parent's `scope_key`.

**Given** the child session captures activity
**When** the parent's timeline is rendered
**Then** the child's events are attributed to the child, not merged into the parent.

**Given** Cortex is disengaged for the project
**When** a subagent is dispatched
**Then** no child session is created and nothing is captured.

### Story 5.2: Brief subagents automatically

As a parent agent dispatching work,
I want the subagent to receive relevant prior context without my pasting it,
So that delegation stops discarding the memory the parent already has.

**Acceptance Criteria:**

**Given** a subagent is dispatched with a description matching memory in scope
**When** `SubagentStart` fires
**Then** a brief derived from the dispatch description is emitted on stdout and injected into the subagent's context
**And** it respects the standard brief budget.

**Given** no relevant memory exists for the dispatch description
**When** `SubagentStart` fires
**Then** nothing is emitted (N-1).

**Given** the parent also calls the brief tool explicitly for the same topic
**When** both paths run
**Then** context is not double-injected.

**Given** brief generation fails for any reason
**When** the subagent starts
**Then** it starts normally with no error surfaced (AD-12).

### Story 5.3: Write subagent conclusions back

As a user who paid for a subagent's investigation,
I want its conclusions to survive the subagent,
So that a 200k-token run leaves more than one paragraph behind.

**Acceptance Criteria:**

**Given** a subagent finishes
**When** `SubagentStop` fires
**Then** its `last_assistant_message` is captured and its load-bearing findings are recorded as episodes attached to the parent's scope.

**Given** a finding is note-shaped
**When** write-back runs
**Then** it is routed through the non-mutating suggestion path and projects into `memory_items` only once accepted (AD-4, FR-19).

**Given** a subagent attempts to modify or resolve a note authored outside its own session
**When** the operation is evaluated
**Then** it is refused.

**Given** a new episode kind is introduced by write-back
**When** the change ships
**Then** a locked eval fixture exercising that kind ships with it (AD-5).

### Story 5.4: Record sibling claims during fan-out — WITHDRAWN FROM R1 (2026-07-28)

*Withdrawn: Claude Code Agent Teams ships lock-and-claim natively at task
granularity; do not duplicate it. FR-20 returns to PRD roadmap. Post-R1
replacement direction: read native Agent Teams claim state and surface it in
the subagent brief rather than maintaining a parallel claim store. Text
retained below. See `replan-r1-2026-07-28.md`.*

As one of several agents working in parallel,
I want to see what my siblings have already covered,
So that a fan-out stops duplicating its own work.

**Acceptance Criteria:**

**Given** sibling sessions share a parent
**When** one records a claim
**Then** the claim names the agent, the area claimed, and the outcome, and is visible to siblings under the same parent.

**Given** the parent session ends
**When** claims are evaluated
**Then** they expire and never become durable memory.

**Given** an agent does not read claims
**When** it proceeds
**Then** it is never blocked waiting on one.
