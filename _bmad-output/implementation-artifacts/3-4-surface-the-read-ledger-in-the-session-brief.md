# Story 3.4: Surface the read ledger in the session brief

**Epic:** 3 — Read Ledger and Token P&L
**FR:** FR-7
**Status:** in-progress

As an agent resuming work,
I want to know which files I already know about,
So that I do not re-read them to orient myself.

## Acceptance Criteria (verbatim from epics.md:665-683)

**Given** a prior session in this scope read files that are still unchanged
**When** the session brief is built
**Then** it includes one line naming up to five of them, ordered by read frequency.

**Given** the ≤150-token brief budget binds
**When** the brief is assembled
**Then** the read-ledger line drops first.

**Given** a cold start with no prior session
**When** the brief is built
**Then** it emits nothing (N-1).

## The surface this story changes is NOT covered by the gate

Stated first because it changes how every claim in this story must be read.

`npm run gate` compares `top1_hit`, `recall_at_3` and `output_tokens` from
topic-driven **recall** fixtures. `evaluateStore` already computes `header`
(`buildHeader`) and `full_state` (`buildFullState`) and puts them in the result
as text metrics — **and nothing asserts on them.** `buildSessionBrief`, the
surface this story edits, is not even computed by the harness.

So a regression here cannot go red, and a green gate is **not** evidence this
story is correct. That is the open Epic-1 action item ("Add header/full_state
assertion hooks to the eval harness so state-surface regressions gate"), and
Story 3.4 is the first story to change the brief since the gate landed.

**Decision: build the hook as part of this story** rather than ship a change
whose regression is invisible. Scope: teach the harness to compute the brief,
and add a fixture form that asserts on the three text surfaces. Retrieval
metrics and the existing baselines are untouched.

## Previous-story intelligence

Carried forward from 3.1–3.3, each earned:

- **A read is almost never "yours" here.** `inject-header` ends the session tree
  and creates a fresh primary on every SessionStart, so a session-scoped filter
  would leave this line permanently empty. It is scope-wide — and therefore must
  not use the second person. Story 3.3 measured 163 primary sessions against 9
  subagents on the live store and had to stop rendering `read by primary` for
  exactly this reason. "Files you already read" is a claim this line cannot make.
- **`read_count` exists for this story.** Story 3.1 recorded it deliberately:
  "read_count accumulates because Story 3.4 orders by read frequency, which a
  keyed upsert cannot reconstruct afterwards."
- **"Still unchanged" means re-hashing** (Story 3.3, AC #2). It is the expensive
  part, and this runs on the SessionStart path under **B-1 (≤150 ms p95)**.
- **`byte_size` is recorded**, so hashing cost can be bounded *before* paying it.
- **AD-12 binds this path to silence.** The brief currently touches no
  filesystem; adding hashing adds a throw surface to a hook. It must degrade to
  "no ledger line", never to a broken brief.
- **Test the surface, not the helper.** M14 in 3.1 and the transport gap in 3.3
  were both "the helper was tested and the caller was not".
- **Doc claims are assertions.** Three of mine were falsified in 3.3's review.

## Design decisions

### D1 — Scope-wide reads, and no second person

The line names files read *in this scope*, whoever read them, because a
per-session filter makes it dead on arrival (see above). It therefore describes
the files rather than the reader: `known unchanged: a.ts, b.ts`. No "you".

### D2 — Ordered by read frequency, bounded before hashing

`ORDER BY read_count DESC` per AC #1. Verification is what costs, so the
candidate window is bounded and verification stops as soon as five unchanged
files are found. `byte_size` from Story 3.1 bounds the hashing work *before* it
is paid, rather than discovering the cost while spending it.

### D3 — "Drops first" must be structural, not positional

The existing budget loop removes the last line before the footer. Appending the
ledger line there would satisfy AC #2 **by accident**, and any later reordering
would break it silently while every test still passed. The line is removed
explicitly, before the generic loop runs.

### D4 — A ledger line alone may carry the brief

If digests exist, a prior session existed, so this is not a cold start and N-1
does not apply. Emitting header + ledger + footer is the useful answer.

### D5 — What the harness hook asserts *(corrected: the shipped API differs)*

**As shipped**, a suite carries a top-level `surfaces` array:

```json
"surfaces": [{ "surface": "brief", "expect_contains": [...],
               "expect_excludes": [...], "max_tokens": 150, "budget": 44 }]
```

The original draft of this decision named `expect_brief_contains` /
`expect_brief_excludes` / `max_brief_tokens` as *fixture-level* keys. That
design was changed during implementation — surface assertions are per-surface,
not per-topic, so hanging them off a recall fixture would have forced an
arbitrary pairing — and this section was not updated. Recorded here rather than
silently rewritten, because a design decision that documents an API which never
existed is exactly the kind of doc claim this repo treats as code.

`budget` was added during the review round: without it the token budget cannot
be gated at all, since a seeded brief is 36–77 tokens against `max_tokens: 150`
and the assertion can never bind.

A suite that carries no `surfaces` block is unaffected, and every pre-existing
baseline stays byte-identical.

## Review outcomes

### The suite built to close a coverage gap shipped with its own assertions disabled

`brief-surface.json`'s recall fixture expected `"evict the cache by time-to-live
alone. (superseded)"` while the seeded text renders `"...time-to-live alone in
src/cache/policy.ts. (superseded)"` — the expectation dropped the path. The
fixture therefore failed on arrival, `regenerateBaseline` recorded
`passed: false`, and `findFixtureRegressions` skips any fixture the baseline
records as failing, on the documented grounds that "the author accepted it
deliberately". So every recall assertion in the new suite — including its
`top1_hit`, `recall_at_3`, `noise_count` and `stale_count` — was **permanently
un-gated**, on the suite added to end exactly this class of problem.

The systemic half is the part worth keeping: `regenerateBaseline` computes its
`accepted` list only when a **previous** baseline exists, so creating the first
baseline for a new suite reports `accepted: []` and warns about nothing. The
known-failing escape hatch was designed for the red→green authoring workflow;
here it silently swallowed a typo. A new baseline that bakes in a failing
fixture is now reported.

### The byte budget was disabled in exactly the state it exists for

`if (spent + row.byte_size > byteBudget && found.length > 0) break;` — the
ceiling could not fire until something had already been *found*, so when every
candidate is changed, all 24 are hashed regardless of size. That state is the
common one: the first SessionStart after a pull, rebase or branch switch.
Measured at the default ceiling, ~44 MiB hashed against a documented 1 MiB
budget, returning an empty line for the work; at a raised
`CORTEX_DIGEST_MAX_BYTES`, **184 ms against B-1's 150 ms**. The guard now keys on
`spent > 0`, which still always attempts the first candidate (so a single
oversized file is not skipped) and stops afterwards.

This also falsified the claim this story had already written into `CLAUDE.md` —
that a large candidate "cannot consume the budget and leave cheap files
unverified behind it". True for one large candidate, false for the all-changed
case. The published p95 of 18.0 ms was the happy path only.

### Other confirmed defects

- **Duplicate paths.** `resolveWorkingScopeKeys` returns both the preferred and
  the project scope key, and digest paths are scope-root-relative, so one file
  read under two scopes was named twice — burning slots in a five-slot line. The
  code's own comment anticipated the two-scope case for the *hash memo* and
  stopped there.
- **The token budget is not meaningfully gated.** The seeded briefs are 36–77
  tokens against `max_tokens: 150`, so those assertions cannot fire, and
  deleting the budget loop outright leaves the gate green. `SurfaceFixture`
  gains a `budget`, so a suite can render the brief at a binding budget and make
  AC #2's drop-order gateable rather than unit-tested only.
- **A `surfaces` entry asserting nothing passes forever** — `loadSuite` refuses
  `fixtures: []`, an empty `surfaces` array and an unknown surface name, but not
  a surface entry carrying no assertion at all. That is the module's own stated
  rule ("a gate that cannot fail is worse than no gate") unapplied to the new
  fixture type.
- **`candidateLimit` is unguarded**, and SQLite reads a negative `LIMIT` as *no
  limit* — the identical hazard `CLAUDE.md` already documents for
  `resolvePageLimit`.
- **`sessionId: ''`** is a sentinel that participates in AD-16 eligibility rather
  than sitting outside it, and makes `recorderOf` run a `getSession` per
  candidate whose result is discarded — dead work on the B-1 path.
- **Phrasing.** "unchanged since last read" has no subject and reads as "since
  *you* last read", on a line injected unprompted into a fresh session. The
  guard is a literal `\byou\b` match, which the phrasing passes trivially.

### Process note

Two review layers ran concurrently with a third that was instructed to mutate
`src/`. One layer observed `session-brief.ts` changing underneath it mid-run and
correctly discarded the affected result. That is an orchestration error, not a
finding: a mutation layer and a measurement layer must not share a working tree.

## Verification

- `npm run build`, `npm run lint`, `npx vitest run`, `npm run gate`
- `cortex doctor` (built) against the live installation
- B-1 measured, not assumed
- Mutation campaign over every new assertion, each mutation proven applied
