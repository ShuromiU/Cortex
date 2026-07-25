# Reviewer Gate — Architecture Spine, Cortex Context Economy

Run by the parent (subagent dispatch prohibited this session). Deterministic lint: `ok: true`, 0 findings.

---

## Lens 1 — Was every committed decision reality-checked, or asserted from training data?

**Verdict: passes.** Every load-bearing claim in this spine traces to something executed or fetched during this run, not to recall.

| Claim | How it was checked |
| --- | --- |
| `updatedToolOutput` works for built-in tools | Docs fetched + independent web search; extension from MCP-only landed in v2.1.121. `claude --version` → **2.1.170** on this machine. |
| Hook payloads carry `agent_id` / `agent_type`; `SubagentStart`/`SubagentStop` exist | Hooks reference fetched from `code.claude.com/docs/en/hooks`. |
| `git rev-parse --git-common-dir` is worktree-invariant and survives spaces in paths | **Executed** in this checkout: returned `C:/Claude Code/cortex/.git`. |
| `sha256sum` cost in the hook path | **Measured**: ~54 ms on a 57 KB file, Windows/Git-Bash. Drove budget B-4a. |
| Eval gate compares five quality deltas, not table counts | **Read** `compareQuality` in `src/eval/harness.ts`. Corrected an earlier wrong claim. |
| `noise_count` is fixture-`forbidden`-relative | **Read** `noiseCount = countMatchingRefs(retrieval.results, forbidden)`. Inverted AD-5 from "don't project" to "never project without a fixture". |
| Dependency versions; no new runtime dep | Read from `package.json` at HEAD `ea56586`. |
| `memory_items` blast radius = 23 files, `lspOnly: 2`, `textOnly: 20` | `certify_refs` with LSP anchors. |

**One soft spot:** "SQLite FTS5 bundled with better-sqlite3" is asserted rather than version-checked. It is reality-checked in the weaker sense that the repo's FTS code already works. Low severity — not worth a story.

---

## Lens 2 — Adversarial: two compliant units that still collide

Four real holes. All closed below.

### HOLE 1 — Two owners of file-card lifecycle *(critical)*

**The collision.** The cards unit reads AD-4, files cards as `memory_items`, and inherits decay: `hot → warm → cold → archived`. The GC unit reads FR-16 and prunes "cards whose source digest is gone" — while `src/db/gc.ts` *already* deletes archived memory items via `ARCHIVED_ITEMS_WHERE`.

Both obey every AD. Result: a card that simply wasn't retrieved for a while decays to `archived` and is deleted by generic GC **while its source file is unchanged** — destroying derived work that must now be regenerated, and silently reducing SM-1. Or the reverse: card-eviction deletes the card row and orphans its `memory_items` projection.

**Root cause:** AD-4 grants cards memory-item status without saying who owns their lifecycle. Decay is a *relevance* mechanism; a card's validity is a *source* question. Two different clocks, one row.

→ **Closed by AD-14.**

### HOLE 2 — The refund is credited where it cannot be written *(critical)*

**The collision.** AD-8 requires every ledger row to share the transaction of the operation it describes. AD-2 forbids the hot path from writing SQLite. The read refund *happens in the hot path* — the bash hook performs the substitution. So the one credit that most justifies this product's thesis is generated in a context structurally unable to record it.

Two units obeying both ADs deadlock: the ledger unit waits for a transaction the hook can never open; the hook unit emits a refund no one books.

**Root cause:** AD-8's transactional rule was written for cold-path operations and silently assumed all credits originate there. It does not survive contact with AD-2.

→ **Closed by AD-15** (amends AD-8).

### HOLE 3 — Subagent digests can manufacture a false refund *(critical — SM-C3 class)*

**The collision.** The session unit implements AD-9: subagent activity belongs to a child session. The index unit implements AD-3: one flat digest index per store, keyed by `(scope_key, path)` — no session dimension, because AD-3 never mentions one.

Both compliant. Result: a subagent reads `store.ts`; its digest lands in the shared index. Later the **parent** reads `store.ts` for the first time and the hook substitutes *"unchanged since you read it at 14:02."* The parent never read it. That is exactly the false-confidence failure SM-C3 declares a release blocker, produced by two units that each followed the rules.

**Root cause:** the index is keyed by scope but refund eligibility is a per-*session* question, and no AD connected them.

→ **Closed by AD-16.**

### HOLE 4 — Contradiction detection and auto-demotion fight each other *(high)*

**The collision.** FR-1's unit flags a new note contradicting an active decision on the same subject: both get `conflict = 1`, and the posture is explicitly *"you decide"* (FR-1 forbids automatic resolution). FR-4's unit demotes the older decision a tier whenever a new decision lands on an existing subject.

A new decision that *contradicts* an old one on the same subject triggers both. The system simultaneously says "these disagree, resolve it" and quietly resolves it by demoting one side. FR-1's Out-of-Scope line — "Automatic resolution ... is the user's" — is violated by a mechanism FR-4 mandates.

→ **Closed by AD-17.**

### Minor — subagent conclusions: project, or suggest?

AD-4 lists subagent conclusions as projecting into `memory_items`; FR-19 routes them through "the existing non-mutating suggestion path." Suggestions are not memory items. Clarified inline in AD-4: *episodes* project automatically, *note-shaped* findings go to suggestions and project only once accepted.

---

## Outcome

Four `AD`s added (AD-14 → AD-17), AD-8 amended by AD-15, AD-4 clarified. Re-lint after edits: clean.
