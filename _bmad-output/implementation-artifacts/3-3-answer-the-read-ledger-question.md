# Story 3.3: Answer the read-ledger question

Status: in-progress
Epic: 3 — Read Ledger and Token P&L
FR: FR-6 (query surface; the substitution path built on it is Story 4.5)
ADs in scope: AD-6 (certainty requires evidence in hand), AD-16 (refund eligibility is
per-session), AD-2 (hot path never writes), AD-12 (ambient edges degrade to silence)

## Story

As an agent about to read a file,
I want to know whether I have already read it and whether it has changed,
So that I can skip work I have already paid for.

## Acceptance Criteria (verbatim, epics.md:628-663)

1. **Given** a file with no digest record in this scope **When** the read ledger is queried
   **Then** it returns `unread`.
2. **Given** a file whose current on-disk `sha256` matches the recorded digest **When** the
   read ledger is queried **Then** it returns `unchanged-since <ts>` **And** the verdict was
   produced by re-hashing the file, not by comparing mtime.
3. **Given** a file whose content has changed since the recorded digest **When** the read
   ledger is queried **Then** it returns `changed-since <ts>`.
4. **Given** a file the requesting session edited after reading it **When** the read ledger is
   queried **Then** it returns `edited-by-you-since <ts>`.
5. **Given** a file that no longer exists **When** the read ledger is queried **Then** it
   returns `changed-since` qualified as `missing`, never `unchanged`.
6. **Given** a digest recorded by a sibling or descendant session **When** the read ledger is
   queried by a session that is not the recorder or its descendant **Then** the verdict reports
   the change fact but attributes it explicitly to the recording agent, and never says "you read
   it" (AD-16).
7. **Given** a database of 10,000 memory items **When** the read ledger is queried **Then** it
   responds within 20 ms at p95 and within 30 output tokens.

## Previous-story intelligence

Carried forward from 3.1 and 3.2 — these are facts, not guesses, and each one is a defect this
story can reintroduce:

- **The digest describes flush time, not read time.** 3.1 recorded this as a bounded imprecision
  and named this story as the inheritor. A file changed by something *outside* Cortex between the
  read and the flush records the changed bytes and will later read as `unchanged-since`. Nothing
  here can repair that; it must be *documented*, not silently absorbed.
- **The write and the read must derive the key by the same rule.** `upsertContentDigest` and
  `getContentDigest` both resolve the scope root through `store.scopeRootFor`. Passing a
  per-session root at either end made two worktrees sharing one `scope_key` write under one key
  and look up under another. This story adds a third consumer; it must go through
  `getContentDigest`, never hand-roll `toScopeRelativeKey`.
- **`events.target` is the RAW path** the tool reported. `content_digests.path` is normalized and
  scope-root-relative. Any join between them (AC #4 needs one) must normalize the event side or
  it silently never matches — a false `changed-since` in place of `edited-by-you-since`.
- **`scopeRootFor` never caches `null`.** A key written while the root was unknown is stored
  absolute. The lookup must tolerate both forms.
- **`sha256` is NULL for an oversize row.** 3.1 records path and size only past the 2 MiB ceiling.
  There is no recorded hash to compare, so `unchanged` is *unassertable* for those files.
- **A test that exercises a helper is not a test of the transport.** M14 in 3.1 survived because
  `computeFileDigest` was tested directly and never through `handleReadEvent`. Every verdict here
  gets at least one assertion through the actual query surface, not only through the core.

## Design decisions

### D1 — Module and surfaces

`src/query/read-ledger.ts`, per the architecture spine's component map (FR-5..FR-7 →
`query/read-ledger.ts`). Three surfaces, one core:

- `queryReadLedger(store, opts)` — the core; returns a structured verdict, renders nothing.
- `cortex_read_ledger` MCP tool — the agent-facing path FR-6 describes ("an agent can ask").
- `cortex read-ledger <path...>` CLI — hook/script consumers and the measurement harness.

The core returns structure and the surfaces render. That split is what lets AC #7's token budget
be asserted against the renderer and AC #1-#6 against the verdict, instead of parsing prose.

### D2 — The four verdicts, and where qualifiers are allowed

FR-6 says *exactly four*: `unread`, `unchanged-since`, `changed-since`, `edited-by-you-since`.
AC #5 establishes that `changed-since` may carry a qualifier (`missing`). Two further states have
no recorded evidence and therefore cannot assert `unchanged` (AD-6: "an assertion path that cannot
produce its evidence must not make the assertion"):

- the recorded row is `oversize`, so there is no `sha256` to compare;
- the file exists but cannot be read or hashed now (permissions, a lock, now oversize).

Both resolve to `changed-since` qualified `unverifiable`. That is the *miss* direction AD-6
mandates: it costs a re-read and never licenses a false refund. It adds no fifth verdict — the
qualifier rides on `changed-since` exactly as `missing` does, and `ReadLedgerVerdict` stays a
compiler-enforced four-member union with `qualifier` in its own field.

**One condition on that, carried forward:** it holds only while no consumer *branches* on
`qualifier`. `--json` exposes it as a first-class field, so if Story 4.5's substitution path ever
treats `unverifiable` differently from `missing`, D2 becomes a fifth verdict retroactively. Worth
checking at 4.5's create-story, not worth blocking on here.

### D3 — your own edit is checked BEFORE the content comparison *(reversed after review)*

**The story originally decided the opposite, and it was wrong.** The original text argued that when
an edit round-trips to the recorded bytes, `unchanged-since` should win because "Cortex is holding
proof the content is identical". That proof is about the **record**, and the record is not
necessarily what was read.

Story 3.1 computes the digest at **flush** time, not read time. So the ordinary sequence — read a
file, edit it, ask in a later turn — replays the read spool line against **post-edit** bytes. The
record then equals the file on disk while the agent's context holds the pre-edit content, and a
content-first comparison answers `unchanged-since`, refund-eligible, for content the agent never
had. Reproduced end to end through the real spool flush and the real CLI. That is a false refund on
the commonest sequence there is, not an exotic tie-break — and `src/capture/digest.ts` had already
promised the opposite in writing: *"an edit replayed from the same spool wins the verdict (Story
3.3's `edited-by-you-since`)"*.

**Adopted rule:** if this session edited the file after the recorded read, the verdict is
`edited-by-you-since`, whether or not the current bytes match the record. It costs a re-read; the
alternative costs a wrong skip. `missing` and `unverifiable` still take precedence, since a file
that cannot be hashed is not a file you can be told anything confident about.

The eligibility conjunct is unchanged: `edited-by-you-since` says *you* twice over — you read it
(the record must be refund-eligible under AD-16) and you changed it (the edit must be this
session's own). An ancestor's edit is not yours.

### D4 — AD-16 eligibility, stated as a predicate

`refundEligible` ⟺ the recording session **is** the requesting session, **or** is an ancestor of
it. (AD-16: "the reading session is the requesting session itself, or a direct ancestor of it";
AC #6's contrapositive: not eligible when the requester "is not the recorder or its descendant".)

Consequences:

- `edited-by-you-since` requires eligibility. It says *you*, and a sibling's read is not yours.
- An ineligible verdict still reports the change fact — change detection is scope-wide — but the
  rendered line carries `read by <agent> …` and never the second person.
- The ancestor test **walks the chain with a visited-set**, rather than assuming the current
  one-level `parent_session_id ?? id` shape. Depth is 2 today by construction; a walk that is
  correct at any depth cannot silently break when that changes, and the cycle guard costs nothing.

### D5 — What AC #7's 20 ms is measured against

Measured against `queryReadLedger` **in-process**, which is the real cost on the agent-facing path
because the MCP server is long-lived. A *CLI* invocation cannot meet 20 ms and never could:
`cortex read-ledger` costs **532–573 ms** end to end, against ~48–52 ms for a bare `node -e 0`.
(An earlier draft cited "~40 ms", which was Story 3.2's process-spawn floor, not this command —
Node boot, the module graph and opening the store dominate it by an order of magnitude.)

**What the 20 ms covers, stated honestly:** one path over a small file, against a 10,000-item
store. Cost scales with **bytes**, not rows — hashing dominates, and a full-cap request is bounded
at `READ_LEDGER_MAX_PATHS × CORTEX_DIGEST_MAX_BYTES` = 40 MiB of synchronous hashing. A 20-path
request over large files measures in the tens to low hundreds of milliseconds. Both cases now have
tests; the cap case is pinned at a deliberately loose ceiling so a busy CI box does not turn a
platform figure into a red build.

The perf test also asserts the join **ran** during the measurement. Before D3 was reversed, a
matching digest returned before `sessionEditedPathAfter` — the query's only unbounded part — so
the budget was being measured against a path that skipped it.

### D6 — Not in this story

The session brief line is Story 3.4. Ledger rows for the query are Story 3.5. Substitution is
Story 4.5. This story writes no `token_ledger` row and touches no brief.

## Tasks

1. `src/query/read-ledger.ts`: verdict type, `queryReadLedger`, ancestor walk, renderer.
2. `CortexStore`: an ancestor-chain read and a "did this session edit this path after t" read.
3. MCP tool `cortex_read_ledger` + route line.
4. CLI `cortex read-ledger <path...>` (+ `--json`).
5. Tests: every AC, every qualifier, the AD-16 matrix, the mtime-not-trusted proof, the token
   budget, the p95 measurement at 10k items.
6. Docs: `CLAUDE.md` invariants + Core Files; README if the surface is user-facing.

## Verification

`npm run build` · `npm run lint` · `npx vitest run` · `npm run gate` · live `cortex doctor`.
Baseline entering this story: 1195 passed / 1 skipped / 37 files; gate 8 suites at exact zero
delta. No `hooks/claude/` change is planned, so no `cortex install` re-run should be required —
if that changes, it must be run and verified through the installed hook.
