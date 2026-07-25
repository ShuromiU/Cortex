# PRD Quality Review — Cortex: The Context Economy

*Rubric walk run by the parent (subagent dispatch prohibited in this session). Findings below were applied to `prd.md` unless marked deferred.*

## Overall verdict

The PRD has a real thesis and bets on it — every feature traces to "recall must refund tokens, not spend them," and the metric design is unusually honest for a self-authored roadmap (SM-C1 through SM-C4 actively work against the author's incentive to flatter the headline number). Done-ness is strong: 44 FRs, each with verifiable consequences, and the few soft spots are named rather than smoothed. The main risks are structural rather than substantive: the whole roadmap rests on one unresolved harness assumption (FR-17) and one unvalidated measurement primitive (`estimateTokens`), and if either resolves badly the shape of R1 changes materially. Both are flagged, neither is hidden.

---

## Decision-readiness — **strong**

Trade-offs are stated as decisions with what was given up, not as balanced considerations. The data-boundary choice names both rejected options and why (addendum A1.2). The scope choice names what a tighter release would have cost. FR-40 is deferred *against* its apparent popularity with a stated reason ("building on a hunch"), which is the kind of call PRDs usually dodge.

Open Questions are genuinely open — Q3 (interception vs. answering) has no answer anywhere in the document and materially changes SM-2's ceiling, which is exactly what an open question should look like.

### Findings
- **medium** Open Questions don't distinguish blockers from non-blockers (§15) — Q1 gates scheduling of an entire epic; Q7 is a nice-to-know. A reader cannot tell which stop work. *Fix: mark phase-blockers explicitly.* **Applied.**

## Substance over theater — **strong**

No persona theater: four UJs, each with a named protagonist doing a specific thing, each traced to a feature. No standalone persona section. No innovation theater — the competitive claim ("none is repo-native, none accounts for tokens") is grounded in dated research and recorded in the addendum rather than asserted in the Vision.

NFRs are product-specific with thresholds (§8, §10), not "must be scalable." The Vision could not swap into another PRD in this category — it names a specific mechanism and a specific opening.

### Findings
- None. The one section at risk of furniture — §13 Why Now — earns its place by naming the *specific* reason the gap exists (the category consolidated on conversational memory) rather than gesturing at momentum.

## Strategic coherence — **strong**

Thesis is explicit and load-bearing. Feature ordering follows it rather than following ease: §14 puts Operability second not because it is valuable but because everything after it needs to be debuggable, and puts P&L before the cache so the cache is measurable on arrival. Release gates are stated as evidence conditions, not dates.

Success metrics validate the thesis rather than measuring activity. Counter-metrics are present and adversarial — SM-C2 explicitly declares that growth in stored memory is *not* success, which cuts against the obvious vanity metric for a memory product.

### Findings
- **low** MVP scope kind is not named (§6) — it reads as problem-solving, but a reader has to infer it. *Deferred: the §14 ordering rationale makes the logic legible without the label.*

## Done-ness clarity — **adequate**

44 FRs, every one carrying testable consequences. Assertions that must never be wrong (FR-6, FR-13, FR-15) each state the failure-safe direction explicitly ("ambiguity resolves to a miss"), which is what story creation will need.

Three soft spots found:

### Findings
- **high** "Load-bearing" is undefined but load-bearing (FR-19, §4.4) — the term decides what a subagent writes back, and it appears nowhere in the Glossary despite being a term of art in this repo. *Fix: add to Glossary.* **Applied.**
- **medium** FR-30's predicate vocabulary is deferred inside the FR ("explicit and small") without an owner — that is a design decision escaping into implementation. *Fix: promote to an Open Question.* **Applied.**
- **low** FR-10's "gotchas derivable from notes referencing it" is softer than its neighbours. *Deferred: R2-adjacent, and the FR's other two consequences are hard enough to gate the story.*

## Scope honesty — **strong**

Non-Goals does real work — "Cortex does not block the user" and "does not require a model" each foreclose a whole class of scope creep that would otherwise arrive as a reasonable-sounding ticket. Deferrals carry reasons, and the resident daemon is deferred *with* an acknowledgment that it is a real win.

Open-items density: 7 Open Questions + 7 Assumptions + 2 `[NOTE FOR PM]` across a 4-release roadmap at launch stakes. Proportionate — and Q1 is correctly identified as gating rather than deferred silently.

### Findings
- **medium** Assumptions Index roundtrip fails (§16) — six of seven index entries have no corresponding inline `[ASSUMPTION]` tag, so a reader working through §4 does not encounter them at the point of risk. *Fix: tag inline at the FRs they qualify.* **Applied.**

## Downstream usability — **adequate**

FR IDs contiguous FR-1 → FR-44 with no gaps or duplicates. UJ-1 → UJ-4 all named. SM cross-references resolve. Sections stand alone.

### Findings
- **medium** Glossary gaps — *Episode* (used in FR-19 and §11.4) and *App graph* (used in FR-16 and the Reference-validation definition) are used as domain nouns but never defined. *Fix: add both.* **Applied.**
- **medium** UJ coverage stops at R1 (§2.3) — features §4.6 through §4.8 realize no journey, so an architecture or story workflow extracting from R2–R4 has no user narrative to anchor to. *Fix: state the R1 scoping explicitly rather than padding with invented journeys; add UJs when those releases are planned.* **Applied as an explicit note.**
- **low** FRs reference UJs at feature level rather than per-FR. *Deferred: feature-level mapping is unambiguous here because each feature maps to exactly one or two journeys.*

## Shape fit — **strong**

Correctly shaped as a developer-product / chain-top PRD: the Adapt-In clusters pulled in (Public Surface and Compatibility, Performance Budgets, Versioning, Dependency Policy) are the ones a published CLI/MCP package with durable schema actually needs. Brownfield handling is accurate — existing code references (`notes.conflict`, `notes.alternatives`, `token_ledger`, `SCHEMA_VERSION` at 4, the spool invariant) were verified against the checkout rather than assumed.

UJ density is right for the product: four journeys, not twelve, and they exist because this tool genuinely has distinguishable user moments — not because the template had a section.

### Findings
- None.

---

## Mechanical notes

- **ID continuity:** FR-1 → FR-44 contiguous across eight features; no gaps, no duplicates. UJ-1 → UJ-4. SM-1 → SM-7 plus SM-C1 → SM-C4. N-1 → N-9, P-1 → P-6, B-1 → B-8, R-1 → R-9. All resolve.
- **Glossary drift:** two undefined domain nouns found and added (*Episode*, *App graph*), plus *Load-bearing* promoted from repo jargon to defined term. No synonym drift found on the high-traffic terms (*trust label*, *tokens saved*, *content digest*, *file card*).
- **Assumptions roundtrip:** was 1-of-7 inline; now complete.
- **UJ protagonists:** all four named, context carried inline. No floating UJs.
- **Required sections:** present for launch-stakes developer product.
