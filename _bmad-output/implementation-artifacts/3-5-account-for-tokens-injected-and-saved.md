# Story 3.5: Account for tokens injected and saved

**Epic:** 3 — Read Ledger and Token P&L
**FR:** FR-8
**Status:** in-progress

As a user judging whether Cortex earns its place,
I want an honest ledger of what Cortex cost and what it returned,
So that the product's central claim is falsifiable rather than asserted.

## Acceptance Criteria (verbatim from epics.md:685-716)

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

## What is actually here — run before designing

`cortex stats` on the live store, before any change:

```
Spent:         45.8k
Saved:         657.6k
Net:           611.8k
Efficiency:    93%
```

The ledger is **not** missing. `token_ledger(id, session_id, type, direction,
tokens, timestamp)` ships, `direction` is `'spent' | 'saved'`, and
`find_referencing_symbols` on `insertLedgerEntry` gives seven call sites: four
in `handleToolCall` (state ×2, recall, brief), one in `reflectMemory`, one in
`inject-header`, and one in `writeSessionSummary`.

**Every one of the first six writes `'spent'`. Exactly one writes `'saved'`,
and it is this:**

```ts
const savedTokens = Math.max(0,
  estimateTokens(JSON.stringify(events)) - estimateTokens(summary));
```

That single line is the entire 657.6k and the entire 93%. It reads: *had you
pasted the raw JSON of every captured event into the context, and instead you
got this summary, you saved the difference.* Nobody would ever have pasted raw
event JSON. There is no avoided action, no recorded size, and no evidence — it
is a counterfactual against a baseline that never existed.

**AC #3 forbids precisely this.** So the central act of this story is not to add
accounting; it is to *withdraw* a credit the product currently advertises, and
replace it with credit that can be checked. The headline number will collapse.
That is the deliverable, not a regression: "falsifiable rather than asserted"
is the story's own stated purpose, and a 93% efficiency figure derived from a
baseline nobody would have paid is exactly the assertion it names.

## Design decisions

### D1 — `spent` is renamed to `injected`, with a migration

AC #1 says `direction: 'injected'`; the column holds `'spent'`. They mean the
same thing — tokens Cortex put into the context — and Story 3.6 must *report*
"injected". Carrying two vocabularies for one concept is the drift that caused
the Story 2.7 error this epic already paid for, so the stored value moves.
`direction` has no CHECK constraint, so the migration is a plain `UPDATE`; it
must cover `type='rollup'` rows too, since `cortex gc` aggregates `GROUP BY
direction`.

### D2 — Evidence is columns, and `saved` without evidence is refused

AC #2 names three evidence shapes: file + byte size, output size, result count.
Stored as `evidence_kind` / `evidence_ref` / `evidence_size`, null for
`injected`. AC #3 is then enforceable rather than aspirational: `insertLedgerEntry`
**refuses** a `saved` row carrying no evidence.

Enforced in the store method rather than by a table CHECK, because adding a
CHECK to a populated table means a full rebuild in SQLite.

**Correction (review):** the first version of this decision called
`insertLedgerEntry` "the single write path (seven call sites, all through it)"
and named a bypassing raw `INSERT` as a hypothetical. One already existed, in a
file this same story was editing: `src/db/gc.ts`'s ledger rollup has written
`INSERT INTO token_ledger` directly since before this change. That is not a
footnote — it is why the rollup had to be taught to carry evidence forward, and
why the guard is a *convention* enforced at one well-used door rather than a
property of the table. The evidence requirement is also a **shape** check, not a
provenance check: a caller that fabricates an evidence object passes it. The
consolidation credit is kept out by a test naming that specific case, not by the
guard.

Since review, the amount is checked against the evidence as well — a read or
command credit may not claim more tokens than `ceil(bytes / 4)`, because a
credit whose *size* is unchecked is unfalsifiable in exactly the way an
unevidenced one is.

### D3 — The legacy credit is reclassified, not deleted

Existing `type='consolidation'` rows migrate to `direction: 'estimated'`. They
stay readable — deleting them would destroy audit history, and this repo's rule
is that a correction preserves the prior — but they stop counting as savings.
The `README` already warned this figure was consolidation-derived; the migration
makes the warning structural instead of a footnote next to a number that
contradicts it.

### D4 — Unrealized is an offer the agent declined, and it must be observable

AC #6's "a surface was available and the agent did not use it" is only honest if
Cortex can *see* the decline. The observable case: the read ledger answered
`unchanged-since` and refund-eligible for a path, and the agent read that file
anyway. The offer and the read are both recorded, so the decline is evidence,
not inference. Booked as `direction: 'unrealized'` with the same evidence
columns, so 3.6 can show the capability-versus-adoption gap.

### D4b — Why the DECLINE is booked and the ACCEPT is not

Raised in review as the sharpest open question, and it deserves an answer
rather than the silence it originally got.

`queryReadLedger` already computes exactly the evidence AC #2 names for an
avoided read — the file, its recorded byte size, `unchanged-since`, and
refund-eligibility. This story wires that into the *decline* path (an
`unrealized` row) and books nothing on the *accept* path. That asymmetry is the
whole reason `Saved` reads 0, so it needs a defense.

**The two cases are not symmetrically observable.** A decline is an event: a
read happened after Cortex said the content was already held. An accept is the
*absence* of an event, and absence has no timestamp. To credit it you must pick
a moment to declare "they were never going to read it" — and the only candidates
are a timeout or the end of a session, neither of which is evidence about the
agent's intent. An offer expiring unconsumed is indistinguishable from an agent
that simply never needed the file: crediting it would pay Cortex for reads that
were never going to happen, which is the counterfactual baseline of the
consolidation credit relocated one layer down. That is the specific thing AC #3
forbids, and it is why the offer lives in `read_offers` and is *deleted* on
expiry rather than converted into a saving.

**What a real accept looks like, and where it lands.** Verified read
substitution (Story 4.5) makes the accept an event too: the hook returns cached
content *instead of* performing the read, so a read that would have occurred
demonstrably did not. That is an observed avoided action with a recorded size,
and it books `saved` through the AD-15 spool path this story built. The credit
side is empty because that producer is blocked on the B-4a amendment — not
because the accounting cannot express it.

So the asymmetry is deliberate: **Cortex counts what it can observe, and an
unread file is not an observation.**

### D5 — Hot-path credit ships with no production producer yet, and says so

AD-15's path (spool record → cold-path flush → exactly-once) is built and
tested, because the accounting layer is what this story owns. But the actual
substitution that would *produce* hot-path credit is Story 4.5, which is blocked
on the B-4a amendment. So the mechanism has tests and no live producer, and that
is recorded rather than left to look like coverage.

## Verification

- `npm run build`, `npm run lint`, `npx vitest run`, `npm run gate`
- `cortex doctor`, and `cortex stats` before/after with the numbers recorded
- Mutation campaign over every new assertion, each mutation proven applied
