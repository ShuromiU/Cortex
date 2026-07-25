---
stepsCompleted:
  ['step-01-document-discovery', 'step-02-prd-analysis', 'step-03-epic-coverage-validation', 'step-04-ux-alignment', 'step-05-epic-quality-review', 'step-06-final-assessment']
date: 2026-07-24
release: R1
verdict: READY WITH CONDITIONS
---

# Implementation Readiness Report — Cortex Context Economy R1

## Verdict

**READY WITH CONDITIONS.** Functional coverage is complete and traceable. Two conditions must be closed before Epic 0 starts; both are now closed in `epics.md` and are recorded here for audit.

The planning chain is unusually tight on *functional* traceability and was measurably weaker on *non-functional* traceability — a pattern worth naming, because it is the predictable failure mode of FR-driven decomposition. FRs got stories; NFRs got prose.

## Document Discovery

| Document | Status | Notes |
| --- | --- | --- |
| PRD | ✅ final | 44 FRs; §15 phase-blockers all resolved and marked binding |
| PRD addendum | ✅ present | A2 mechanism notes consumed by the spine |
| Architecture Spine | ✅ final | 17 ADs; deterministic lint clean |
| Epics and Stories | ✅ complete | 6 epics, 29 stories, 128 ACs (122 at review, +5 from the two conditions, +1 from the Observation 2 amendment) |
| Project context | ✅ present | 41 binding implementation rules |
| UX design contract | ➖ N/A | No user interface. CLI + MCP surface only. Correctly absent, not missing. |

## Epic Coverage Validation

### Coverage statistics

- **R1 FRs in scope:** 27 (FR-1 → FR-26, plus FR-44 pulled forward from R4)
- **FRs covered by at least one story:** 27
- **Coverage: 100%**
- **FRs in epics but not in PRD:** 0
- **Stories carrying no FR:** 1 — Story 3.2 (flat digest index), which implements AD-3. Intentional and documented.

### Coverage matrix

| FR range | Epic | Stories | Status |
| --- | --- | --- | --- |
| FR-1 → FR-4 | 1 | 1.1–1.4 | ✅ Covered |
| FR-5 | 3 | 3.1 | ✅ Covered |
| FR-6 | 3, 4 | 3.3, 4.5 | ✅ Covered (query surface + substitution path) |
| FR-7 → FR-9 | 3 | 3.4–3.6 | ✅ Covered |
| FR-10 → FR-16 | 4 | 4.1–4.6 | ✅ Covered |
| FR-17 → FR-20 | 5 | 5.1–5.4 | ✅ Covered |
| FR-21 → FR-26 | 2 | 2.1–2.6 | ✅ Covered |
| FR-44 | 1 | 1.5 | ✅ Covered |
| FR-27 → FR-43 | — | — | ➖ Out of R1 scope by design (R2–R4 roadmap) |

**No missing FR coverage.**

## Architecture Alignment

13 of 17 ADs are cited directly in acceptance criteria. Four were not, and the four split into two very different categories:

| AD | Cited? | Assessment |
| --- | --- | --- |
| AD-1 Layer direction | ❌ | **Acceptable.** Universal ambient constraint applying to every story; per-story citation would be noise. Restated as a blanket constraint. |
| AD-8 Ledger double-entry | ❌ | **Citation gap only.** Story 3.5 carries all of AD-8's substance (evidence-bearing credits, no modeled credit, transaction sharing) but cites only AD-15, the amendment. Fixed. |
| AD-10 Store identity | ❌ | **Citation gap only.** Story 2.5's ACs are AD-10's content verbatim — common-dir hashing, worktree convergence, clone separation, repair anchor. Fixed. |
| AD-11 Migration safety | ❌ | **Substance gap — CONDITION 1.** See below. |

## Non-Functional Traceability

| NFR | Cited? | Assessment |
| --- | --- | --- |
| N-1 Silence by default | ✅ | Stories 3.4, 5.2 |
| N-2 Budgeted output | ⚠️ | Substance present (1.2, 3.3, 3.4), ID never cited. Acceptable. |
| N-3 Never break the turn | ⚠️ | Covered under AD-12, which is the same rule. See Observation 1. |
| N-4 No process per tool call | ✅ | Stories 0.2, 3.1, 4.5 |
| N-5 Offline and local | ❌ | **Substance gap — CONDITION 2.** See below. |
| N-6 Windows parity | ✅ | Story 2.3 |
| N-7 Idempotent capture | ✅ | Stories 0.1, 0.2 |
| N-8 Additive migrations | ❌ | Same gap as AD-11. Reinforces Condition 1. |
| N-9 Determinism where asserted | ✅ | Stories 4.1, 4.2 |
| B-4, B-4a, B-6, B-7 | ✅ | Cited with explicit thresholds |
| B-1, B-2, B-5, B-8 | ⚠️ | B-3's threshold appears in 3.3 without its ID; B-8 partially via 2.6/4.6. B-1/B-2 govern pre-existing surfaces this release does not change. Acceptable. |
| **P-1 → P-6 Public surface** | ❌ | **Zero citations across 29 stories.** See Observation 2 — the most consequential finding in this report. |

---

## Conditions

### CONDITION 1 — Migration safety has no acceptance criterion *(closed)*

Four stories create new tables (3.1 `content_digests`, 4.1 `file_cards`, 4.3 `negative_results`, 4.4 `tool_outputs`). AD-11 and N-8 require migrations to be additive, idempotent, and survivable at any statement boundary — and **no acceptance criterion in any of the 29 stories asserts any of that.**

The `epics.md` validation pass caught the adjacent issue (a dev agent would bump `SCHEMA_VERSION` four times) and stated the rule as prose in Validation Finding 2. Prose is not a test. A dev agent implementing Story 3.1 would satisfy every listed AC while shipping a migration that corrupts a store on interruption.

This is the highest-severity finding in the report because it is silent, it is data-loss class, and it is invisible to the existing verification block — `npm run build && npm run lint && npx vitest run` does not exercise interrupted migrations.

**Closed:** migration-safety criteria added to Story 3.1 as the first table-creating story, binding on every subsequent table addition.

### CONDITION 2 — No acceptance criterion asserts the no-network invariant *(closed)*

N-5 states that no production code path makes a network request. R1 introduces the first Cortex feature that plausibly *wants* one: file-card enrichment (Story 4.1). AD-13 makes the model path optional, and Story 4.1 asserts the deterministic path works without a model — but **nothing asserts that the enrichment path, when it does run, makes no network call**, and nothing prevents a future contributor from wiring an HTTP provider behind it.

Given the PRD sells "nothing leaves the machine" as a product guarantee (§11.1), an untested invariant here is a promise with no enforcement.

**Closed:** a no-network criterion added to Story 4.1.

---

## Observations (not blocking)

### Observation 1 — One constraint, two identities

**N-3** ("Never break the turn — any failure degrades to silence") and **AD-12** ("Degradation is silent and total") are the same rule expressed twice, in two artifacts, under two IDs. Nothing is wrong today; both are honored. But traceability tooling counting citations will report N-3 as uncovered forever, and a future amendment to one will not obviously propagate to the other.

Recommend collapsing at the next PRD or spine update — the spine should cite N-3 rather than restate it. Not worth a change now.

### Observation 2 — Public-surface compatibility is entirely uncited, and one story silently breaks a contract

P-1 → P-6 declare the MCP tool set, the CLI, **and the hook protocol** to be compatibility contracts. Across 29 stories, none is cited.

Mostly this is benign: R1 adds tools and commands additively, which P-2 explicitly permits. One case is not benign:

> **Story 0.2 changes the capture spool line format** by adding `agent_id` and `agent_type`. P-4 declares the hook protocol — including the JSON exchanged with the entry point — a compatibility surface *for anyone who has already installed the hooks*.

Story 0.2 handles the **data** direction correctly: its AC requires that pre-change spool entries lacking `agent_id` still resolve to the primary session. What is unhandled is the **script** direction — a user who upgrades the Node package but still has the old `cortex-capture.sh` installed will keep emitting old-format lines indefinitely, and subagent attribution will silently never work for them. They will see no error, because AD-12 mandates silence.

This is not a defect in Story 0.2 so much as an **ordering tension**: the two mechanisms that would catch it — `cortex doctor` (Story 2.3) and idempotent re-install (Story 2.4) — both live in Epic 2, which ships *after* Epic 0.

Three options, none free:

1. **Accept it.** Epic 0's value is correct attribution going forward; a stale-hook user is no worse off than today. Cheapest, and the silent-failure window closes when Epic 2 lands.
2. **Move hook-version detection from Story 2.3 into Epic 0.** Smallest correct fix; costs Epic 0 its tight single-purpose scope.
3. **Reorder Epic 2 before Epic 0.** Rejected — Epic 2's own value depends on nothing, but Epic 0 is a live defect and delaying a correctness fix behind six operability stories inverts the priority.

**Recommendation: option 1**, with the caveat recorded here so it is a decision rather than an oversight. The window is bounded by Epic 2, and the failure mode is "a bug stays unfixed for one more epic," not "a new bug is introduced."

#### Amendment (sprint planning, 2026-07-24) — the named owner did not actually own it

The paragraph above assigns the mitigation to "`cortex doctor` (Story 2.3) and idempotent re-install (Story 2.4)." Re-read against Story 2.3's acceptance criteria as written, **that was wrong for 2.3.** Its check list was explicit — engagement state, hook presence, placeholder substitution, `jq`, Node, database, spool, MCP registration — and a stale-but-valid `cortex-capture.sh` passes every one of them. It is present. It is correctly substituted. It is simply old. The diagnostic would have reported a clean bill of health on exactly the machine that has the problem.

That left Story 2.4 as the sole mitigation, and 2.4 is user-initiated: it only helps someone who chooses to re-run the installer, which a user seeing no errors has no reason to do. The bound on this risk was therefore weaker than this report claimed.

**Closed:** a hook-version-currency check added to Story 2.3's first criterion, plus a dedicated criterion for the stale-but-valid case. Epic 2 now owns the risk in the acceptance criteria and not only in this report's prose. AC count 127 → 128. The accepted risk and its window are unchanged; what changed is that the mechanism closing the window now exists.

### Observation 3 — The verification block does not cover the new failure classes

`project-context.md` defines verification as build + lint + vitest, plus the eval gate for retrieval changes. R1 introduces three failure classes none of those catch: interrupted migrations (Condition 1), network egress (Condition 2), and hot-path budget regressions (B-4a). Story 1.5 lands the eval gate in CI; the other three want equivalent gates eventually.

Not blocking for R1 — flagged for the retrospective.

## Epic Quality Review

| Check | Result |
| --- | --- |
| Every story completable by a single dev agent | ✅ |
| Every story has testable acceptance criteria | ✅ 128 ACs (122 at review, +5 from the two conditions, +1 from the Observation 2 amendment), all in Given/When/Then form |
| No forward *epic* dependencies | ✅ Every epic builds only on earlier ones |
| Forward *story* dependencies | ⚠️ Two, both conditional and vacuously satisfiable; documented and accepted in `epics.md` |
| Epics deliver value, not technical milestones | ✅ With one deliberate exception: Epic 0 is explicitly a defect fix and says so |
| Tables created only when a story needs them | ✅ No upfront schema epic |
| No starter template required | ✅ Brownfield; AD-1 ratifies existing structure |
| File churn across epics | ✅ Considered and justified in `epics.md` |
| Story IDs contiguous | ✅ 0.1 → 5.4, no gaps after the 3.2 insertion and renumber |

## Final Assessment

| Dimension | Status |
| --- | --- |
| FR coverage | ✅ 100% (27/27) |
| Architecture alignment | ✅ after Condition 1 closed |
| NFR traceability | ✅ after Condition 2 closed |
| Story quality | ✅ |
| Dependency integrity | ✅ |
| Public-surface compatibility | ⚠️ Accepted risk, documented (Observation 2) |

**R1 is ready for sprint planning.** Both conditions are closed in `epics.md`. Observation 2 is an accepted, bounded risk with a named owner (Epic 2) rather than an unknown.
