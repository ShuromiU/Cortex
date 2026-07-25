# PRD Addendum — Cortex Context Economy

Depth that belongs downstream (architecture, solution design) or earned a place but does not fit the PRD's narrative. **Not** an audit trail — that is `.memlog.md`.

---

## A1. Rejected alternatives, with rationale

### A1.1 Positioning: "memory" vs "context economy"

**Rejected: keep positioning on persistence.** Every competitor claims it, none can prove it, and — decisively — it gives the agent no reason to call the tool instead of just re-reading the file. Persistence is a feature; economics is a reason to call.

**Rejected: fix adoption with stronger consult hints.** Cortex already shrank this from a repeating gate to one line per session, which was the right direction. Escalating back would re-fight a settled decision (see the pull-based redesign, commit `43bf0d9`). A tool cheaper than the alternative does not need nudging.

### A1.2 Data boundary: what content gets stored

**Rejected: raw file bytes with redaction.** Maximum token savings — a re-read served verbatim from the database, zero disk I/O. Rejected because it makes `redact.ts` security-critical rather than merely careful, grows the database toward repo scale (requiring eviction policy, size caps, and a whole class of operational failure the current design is free of), and turns "should I let this tool run on my private repo?" into a question requiring a real answer. The bounded version delivers most of the value at a fraction of the risk.

**Rejected: hashes only, no derived summaries.** Safest possible surface, but limits Cortex to "skip the re-read" and forecloses substitution. File cards are where a large fraction of the savings live — orientation is the most common reason an agent opens a file it has already seen.

**Chosen: hashes + bounded derived summaries.** ~300–400 bytes per tracked file; no secrets at rest; substitution available where it pays.

### A1.3 Scope: what ships first

**Rejected: three-item build order only.** Tightest and fastest, but ships the *measurement* (P&L) without the thing being measured (the cache), which makes SM-1 uninteresting in R1.

**Rejected: R1-only PRD, defer the rest.** Would have hidden the dependency structure — R2 is gated on R1's SM-2, R3 on FR-24 field stability, R4 on FR-41 data. Those gates are the roadmap's actual content and only visible when all four are written down together.

### A1.4 Architecture options deferred to `bmad-architecture`

**Resident daemon** — a long-lived local process over a named pipe or unix socket would take recall latency from milliseconds to microseconds. Rejected for this roadmap: introduces process lifecycle, crash recovery, stale-lock handling, and version-skew between daemon and CLI. The current architecture has none of those failure modes and its measured latency is not a complaint. Revisit only against evidence.

**ANN index / sharding** — FTS5 plus linear rerank will not hold at 100k items across 50 repositories. Not a problem at current scale; the R3 user-scope work is the first thing that could plausibly create it. Flagged for architecture to leave room, not to solve now.

**Interception vs. answering** (Open Question 3) — whether Cortex can short-circuit a `Read` before it executes, or can only answer when asked, is the single highest-leverage unknown in the roadmap. Interception raises SM-2's ceiling dramatically; answering keeps Cortex purely additive and harness-independent. Architecture should design FR-6 so both are reachable from the same core.

---

## A2. Mechanism notes for architecture

### A2.1 Where digesting must happen

The no-process-per-tool-call invariant (N-4) means the PostToolUse hook cannot hash a file — it appends a spool line and returns. Hashing belongs in `flushSpool`, which already runs batched and off the critical path. Consequence: a digest is available one flush behind the read. For the same-session re-read case that is fine (flush happens at turn end). For the within-turn re-read case it is not, and architecture should decide whether that case is worth an in-hook fast path or is simply out of scope.

### A2.2 Cache-key completeness for tool outputs (FR-15)

`(normalized command, head_oid, dirty-file set)` is proposed. Known incompleteness: environment variables, lockfile state not reflected in the dirty set, and toolchain version drift can all change a command's result without changing the key. Architecture should either extend the key or narrow the set of cacheable commands until the key is sound. Given SM-C3 makes a single false assertion a release blocker, narrowing is the safer default.

### A2.3 Projecting new content into `memory_items`

Digests, cards, negative results, and tool outputs are *not* all memory items. Cards plausibly are (they are retrievable knowledge with a subject and a decay profile). Digests and negative results plausibly are not (they are lookup structures, not things to recall). Getting this wrong in either direction is costly: over-projecting floods retrieval and regresses the eval suites (Risk R-7); under-projecting makes cards unreachable by recall. Architecture owns this call, and it should be made before the §4.3 epic is written.

### A2.4 Schema shape

R1 needs, at minimum: content digests, file cards, negative results, tool-output records, and a materially extended use of `token_ledger`. Migrations are additive and idempotent per N-8. `SCHEMA_VERSION` currently sits at 4. Whether these land as one migration or several is an architecture call; the constraint is that a partially-applied migration must leave a working store.

### A2.5 The estimator question

SM-1's credibility rests entirely on `estimateTokens`. It is currently a heuristic. If it drifts materially from real tokenization, the headline metric is fiction. Architecture should decide whether to (a) validate the estimator against real counts and accept a stated error bar, (b) replace it with a real tokenizer, or (c) report savings in bytes and let the reader convert. Option (c) is the most honest and the least marketable; option (a) is probably correct.

### A2.6 Subagent linkage fallback

If Open Question 1 resolves negatively, FR-17/FR-18 degrade to: the parent calls an explicit brief-for-child tool that returns a paste-ready block, and the child's findings are captured only if the parent chooses to record them. That is roughly today's behavior with better ergonomics — real but much smaller value. The epic's size depends entirely on this answer, so it must be resolved before sprint planning, not during it.

---

## A3. Competitive positioning detail

The agent-memory category as of mid-2026 has consolidated around conversational memory: Mem0 (personalization, largest community), Zep/Graphiti (temporal fact-tracking, leads LongMemEval), Letta (self-managed agent state, MemGPT lineage), LangMem (LangGraph-native). All four answer variations of *"what did the user tell me, and when."*

None is repo-native. None validates memory against a working tree. None accounts for tokens. Cortex's differentiators — branch/worktree scoping, current-checkout reference validation with `[stale:]`/`[moved:]` labeling, locked retrieval-quality evaluation, and local-first zero-network operation — do not appear in that comparison set because they are not questions the category asks.

The token-cost problem is independently validated: agentic sessions re-send full context every turn, and the field's mitigations (prompt caching at roughly a 90% discount on the repeated portion; server-side context compaction) reduce the *price* of repetition rather than the repetition. That is the specific gap this roadmap targets.

**Implication for the PRD:** Cortex should not be benchmarked against Mem0/Zep/Letta on LongMemEval-style conversational recall — it would lose and the comparison is meaningless. The locked eval suites plus the token P&L are the right scoreboard, and they are ours to define.

---

## A4. Metric definitions in detail

**Tokens saved (FR-8)** is credited only against an identified avoided action:

| Avoided action | Credit basis | Evidence recorded |
|---|---|---|
| File re-read | Recorded byte size of the file at the digest, converted at the estimator's ratio | file path, digest id, byte size |
| Command re-run | Recorded output size of the prior run | command hash, prior run id, output bytes |
| Repeated zero-result search | Recorded result-count of zero and the tool's typical zero-result overhead | query, root, head_oid |
| Read replaced by card | Full-file estimate minus the card's measured token count | file path, card id, both sizes |

**Unrealized savings** is the same computation over cases where the surface was available and unused. The gap between the two is the adoption signal (SM-2), and reporting both is what keeps SM-1 honest.

**Not credited:** anything requiring a counterfactual judgment about what the agent "would have" done. If the avoided action is not observable, there is no credit.
