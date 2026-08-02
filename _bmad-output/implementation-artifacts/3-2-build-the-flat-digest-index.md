<!-- Story 3.2 — created by bmad-create-story, 2026-08-02 -->
<!-- Epic 3: Read Ledger and Token P&L. Carries AD-3; no FR of its own. -->

# Story 3.2: Build the flat digest index

Status: done

## Story

As Cortex,
I want a flat, greppable projection of the digest records,
so that the hot path can answer freshness questions without opening SQLite or spawning Node.

## Acceptance Criteria

Verbatim from `epics.md:606-626`, numbered for reference.

1. **Given** digest records exist in the store **When** the cold-path flush completes **Then** it writes a line-oriented index file containing, per record, the path, `sha256`, byte size, recording session id, and `agent_id`.
2. **Given** the index file **When** the hot path looks up a path **Then** the record is locatable with `grep` alone, requiring no JSON parsing in the hook (AD-3).
3. **Given** the index file is deleted **When** Cortex next runs **Then** it is fully regenerated from SQLite and no memory is lost — the index is derived, never authoritative (AD-3).
4. **Given** the hot path is running **When** it interacts with the index **Then** it only ever reads; the cold path is the sole writer (AD-2).
5. **Given** the index grows across a long-lived project **When** a lookup runs **Then** it completes within the share of B-4a left after hashing — measured, not assumed, before Epic 4 depends on it.

---

## AC assessment — read this before writing code

### AC #5 rests on a budget that is already known to be unmeetable on this platform

B-4a is the ≤100 ms substitution path. There is an **open Epic-1 action item**
recording that B-4's hook budget was measured at **~400 ms against a ≤15 ms
target** on this Windows/Git Bash machine, and the 2026-07-28 replan states that
B-4a "inherits the same platform reality and may be unmeetable as written",
which is why Story 4.5 is *blocked* on a PRD amendment.

**This does not block 3.2**, because 3.2 only has to show that the *lookup* is
small relative to the rest. But do not report "within B-4a" as though the budget
were settled. The honest form of AC #5 is: measure the grep lookup at realistic
index sizes, measure the hashing it shares the budget with, and state both
numbers plus the platform's floor (process spawn alone). Report the lookup's
own cost as the deliverable and name the unresolved budget as unresolved. A
green claim against a budget that is under amendment is worse than no claim.

### AC #1 and AC #3 constrain each other, and the resolution is not obvious

AC #1 says the flush writes the index. AC #3 says a deleted index is "fully
regenerated from SQLite and no memory is lost". If the flush only ever *appends
what it just replayed*, a deleted index is regenerated as whatever the next
batch happened to contain — which satisfies "written" but not "fully
regenerated". The index must therefore be **rebuilt from the table**, not
accumulated from batches. Write it as a full projection of `content_digests`
for the project, and the delete/regenerate property follows by construction
rather than by a separate recovery path.

---

## The mechanism — read this before any code

### 1. The index file lives in the project root, and this is forced

Story 2.5 moved the store to `$CORTEX_HOME/projects/<label>-<id>/cortex.db`, but
recorded an explicit architectural floor:

> *"The spool, `.cortex.state` and `.cortex.agent-used` deliberately do not move.
> `cortex-capture.sh` computes them in pure bash from the payload's `$CWD`;
> relocating them means hashing a path inside `PostToolUse`, which needs either
> sha256 in bash or a Node process — and N-4 forbids a process per tool call.
> This is an architectural floor, not a deferral, and it is why `IGNORE_ENTRIES`
> does not shrink."*

The index is read by the hot path, so it is bound by exactly the same floor:
**`<project>/.cortex.index`**. Verified against the shipped scripts — every hook
resolves its files as `"$CWD/.cortex.*"` and nothing computes a store path.

Consequences that are easy to miss and are part of this story:

- **`IGNORE_ENTRIES` must gain `.cortex.index`** (`src/query/install.ts:74-82`).
  Without it, `cortex install` stops making a checkout clean and the file shows
  up in every `git status`. Add it to the repo's own `.gitignore` too.
  **Note the working tree already carries an unrelated user edit to `.gitignore`
  — do not stage that file wholesale.**
- The index is per **project root**, so a linked worktree gets its own file.
  That is correct: worktrees share a store but have different checkouts.

### 2. Line format

AD-3 requires greppable-without-a-parser. Tab-separated, one record per line,
`\n`-terminated, written **LF** (Story 2.4's finding: there is no `.gitattributes`,
so anything written with platform line endings breaks non-Windows bash):

```
<scope_key>\t<path>\t<sha256>\t<byte_size>\t<session_id>\t<agent_id>
```

Field 1 is `scope_key` because **one project root holds several scopes** — the
store is partitioned by branch, and a worktree switches branches. The hot path
cannot call `git rev-parse` (a process per tool call), so it cannot filter by
scope cheaply; carrying the scope on the line lets a consumer disambiguate, and
lets a stale-branch line be *recognised* rather than silently trusted. This
answers the architecture's deferred question ("does the index need per-scope
partitioning") with one file plus a scope column — measure it (AC #5) and record
the answer.

`agent_id` is written as `-` when absent, so the column count is fixed and
`cut -f6` is meaningful. A missing field would shift every later column.

**Every field must be sanitised for tab and newline.** `path` is
author-controlled in the sense that it comes from whatever the agent read, and
`scope_key` embeds a branch ref, which git permits to contain almost anything.
A tab in a path forges a column; a newline forges a record. This is the same
discipline `renderedAlternatives` and `inspect-memory` already apply — reject or
percent-escape, and say which in the code.

### 3. Paths become relative to the scope root — this is the AC #5 fix from 3.1

Story 3.1 measured `content_digests` at **417.8 bytes/file for a 135-character
path with a real 74-character branch scope key — a failing AC #5** (the ceiling
is 400). Its recorded fix, and the action item carried into this story:

> *"The fix is to store the path relative to the scope root — the repo prefix is
> precisely what is redundant with `scope_key` — which Story 3.2 should adopt
> when it defines the flat index format (AD-3)."*

So this story changes `content_digests.path` to hold a **scope-root-relative**
path, and the index inherits it. Both get shorter, and 3.1's failing AC becomes
passing. Requirements:

- Relative when the file is under the scope root; **absolute otherwise**, with
  the two forms distinguishable (a leading `/` or a drive letter already
  distinguishes them on both platforms — assert it rather than assuming).
- Normalisation still runs (`normalizeFilePathKey`), and it stays **inside the
  store** so no caller can derive the key differently — 3.1's finding.
- **Existing rows must be migrated, not orphaned.** They are keyed absolute; a
  format change silently makes every one unreachable and the ledger reads
  "unread" for files that were read. The mapping is mechanical (strip the scope
  root, which `sessions.worktree_path` records). Do it in the migration, and
  test it against a store seeded with absolute rows.
- Update `tests/digest.test.ts`'s boundary test, which currently **asserts the
  135-character path FAILS**. When this story makes it pass, that assertion must
  change in the same commit — it exists precisely so the ceiling cannot move
  silently. Update `CLAUDE.md`'s footprint paragraph with the new measurement.

### 4. Writing it: atomic, cold-path only

- **Temp-file-plus-rename**, never a partial in-place write. The hot path reads
  this file concurrently, and `grep` over a half-written file yields a wrong
  answer rather than an error. `install.ts`'s `writeFileAtomic` is the existing
  precedent.
- Written **only** where the cold path already runs: the spool flush, and the
  regeneration path. Never from a hook script (AC #4). Assert that no file under
  `hooks/claude/` writes it, the same shape as 3.1's N-4 assertion — legitimate
  there because the claim is about the scripts' text.
- The flush already holds a write transaction; build the file **after** the
  transaction commits, so a rollback cannot leave an index describing rows that
  do not exist.

### 5. Bounding it

`content_digests` has **no GC rule** — `certify_refs` returns zero hits in
`src/db/gc.ts` — and the index inherits that growth. It is one row per path per
scope, and every branch ever checked out mints a scope, so it grows
monotonically for the life of the project. Story 4.6 owns GC and bounds, but an
index the hot path greps on every read is where unbounded growth *hurts*, and
AC #5 is a latency AC. **Add the prune rule for `content_digests` here** — rows
whose scope has no session within the retention window, following `gc.ts`'s
existing category shape and its dry-run-by-default convention — and let 4.6
inherit a rule that already exists rather than a table that has never had one.

---

## Tasks / Subtasks

- [ ] **Relative-path key change** (AC #1; closes 3.1's AC #5 breach)
  - [ ] Store `content_digests.path` relative to the scope root; absolute fallback for files outside it.
  - [ ] Migrate existing absolute rows in `ensureCortexSchema`. Test against a seeded absolute-keyed store.
  - [ ] Re-measure the footprint; update the boundary test **and** `CLAUDE.md` together.
- [ ] **Index writer** (AC #1, #3, #4)
  - [ ] `src/capture/digest-index.ts` — **not** `index.ts`. The architecture's structural seed names `capture/index.ts`, but a module called `index` inside a package directory is the one name that changes how the directory resolves; the repo's own convention is "one module per concern, test file mirrors the name". Deviation recorded here deliberately.
  - [ ] Build the file as a **full projection of the table** for this project root, not an append of the batch — AC #3 falls out of that.
  - [ ] Atomic temp-file-plus-rename; LF line endings; fixed column count; tab/newline sanitised.
  - [ ] Call it after the flush transaction commits.
- [ ] **Regeneration** (AC #3)
  - [ ] Rebuild when absent or unreadable, on the next cold-path run. Assert byte-identical output to the pre-deletion file for the same rows.
- [ ] **Hot-path read contract** (AC #2, #4)
  - [ ] Prove the lookup with `grep` alone, from bash, with no `jq` and no Node — a real subprocess in the test, not a JS reimplementation of grep.
  - [ ] Assert no `hooks/claude/*.sh` writes the index.
- [ ] **Installation surface**
  - [ ] `.cortex.index` into `IGNORE_ENTRIES` and the repo `.gitignore`. Test that `install` writes it.
  - [ ] `cortex doctor`: the index is derived, so its absence is not a failure — but a **stale or unreadable** index is worth a `warn`. Decide and state which.
- [ ] **GC rule**
  - [ ] Prune `content_digests` (and therefore the index) in `src/db/gc.ts`, dry-run by default, reported in its category table.
- [ ] **Measurement** (AC #5)
  - [ ] Measure grep lookup at realistic sizes (1k / 10k / 50k records) on this platform. Measure the hashing it shares the budget with. Report both, and name B-4a as unresolved rather than claiming compliance.
- [ ] **Docs**
  - [ ] `CLAUDE.md`: index location and why it cannot move, line format, derived-not-authoritative, the corrected footprint numbers, the GC rule.
  - [ ] `README.md` only if user-observable.

---

## Dev Notes

### Previous story intelligence (3.1, and what its review cost)

3.1 passed build, lint, 1139 tests, 8 gate suites, a live `doctor`, **and a
13/14 mutation campaign** — and the three-layer review still found a silent
total feature kill plus three recorded-state defects. Directly applicable:

- **The "helper, not the transport" failure recurred three times in one story.**
  A unit-tested helper proves nothing about whether the shipping path calls it.
  Here the analogue is exact: an index *writer* that is unit-tested proves
  nothing about whether the flush ever writes the file. **Assert through a real
  flush**, and mutate the wiring, not the helper's internals — 3.1's campaign
  mutated cache internals (killed by the unit test) and the missing wiring
  survived.
- **A ceiling asserted at one point hides its own cliff.** 3.1's footprint test
  pinned one path length that passed. Measure a *range* here, for both index
  size and lookup latency.
- **Doc claims are assertions.** 3.1 shipped "0.93 bytes per character" and
  "breaches around 155" — both false, from interpolating a step function. Every
  number in prose must come from a measurement run in this story.
- **Windows first**: `os.tmpdir()` never literal `/tmp`; LF line endings written
  explicitly; a path may contain spaces and a drive letter.
- **`src/transports/hook-entry.ts` and `src/query/reference-validation.ts` carry
  a raw NUL byte** — grep/ripgrep skip them silently. Use `grep -a` or Serena.

### Constraints

- **AD-2:** cold path is the sole writer; hot path never opens SQLite.
- **AD-3:** derived, regenerable, flat, greppable. Losing it is never data loss.
- **N-4 / B-4:** nothing added to `PostToolUse` that spawns a process.
- **AD-12:** index write failures degrade to silence on ambient paths.
- Layer direction `transports/ → query/ → memory/ + scope/ → db/`.
- ESM `.js` specifiers; `npm run lint` does not typecheck `tests/`.
- No `SCHEMA_VERSION` bump. The path-format change is a data migration inside v5.

### Expected gate impact: exactly zero

Nothing here touches ranking, rendering or budgets. All 8 locked suites must
show zero delta. Baseline to reproduce first: **1148 passed / 1 skipped / 36
files**, 8 suites at exact zero delta.

### The traps this story is most likely to fail on

1. **Appending the batch instead of projecting the table**, which passes AC #1 and quietly fails AC #3.
2. **Writing the index from a hook script** to "keep it fresh" — violates AD-2 and N-4 at once.
3. **Non-atomic write**, giving a concurrent `grep` a torn line.
4. **Platform line endings**, breaking bash everywhere except Windows.
5. **Orphaning existing digest rows** when the path format changes.
6. **Forgetting `IGNORE_ENTRIES`**, so `install` no longer leaves a clean checkout.
7. **A tab or newline in a path or branch ref** forging a column or a record.
8. **Claiming AC #5 is met** against a budget that is formally under amendment.
9. **Testing the grep lookup in JavaScript**, which proves the format is parseable by JS, not by `grep`.

Mutate `src/` (never `dist/`), EOL-adaptive anchors, prove every mutation applied, and **include the wiring in the mutation list from the start**.

### Verification

```bash
npm run build && npm run lint && npx vitest run && npm run gate
```

Then, because this story adds a file the installer must ignore:
`cortex install` on the live installation must report the new ignore entry, and
`cortex doctor` must stay green. **Any change under `hooks/claude/` requires
re-running `cortex install` and verifying through the INSTALLED hook** — this
story should not need one; say so explicitly if it does not.

### Sources

[Source: `epics.md:600-626`] — ACs verbatim.
[Source: `ARCHITECTURE-SPINE.md:50,52` (AD-2, AD-3), `:253-255` (structural seed), `:296`] — index format left to story level; AD-3 fixes the properties.
[Source: `CLAUDE.md` Story 2.5 invariant] — the spool/state architectural floor that forces the index into the project root.
[Source: `hooks/claude/*.sh`] — verified: every hook resolves `"$CWD/.cortex.*"` in pure bash.
[Source: `src/query/install.ts:74-82`] — `IGNORE_ENTRIES`.
[Source: `3-1-capture-content-digests-on-read.md`] — the AC #5 breach measurement, the relative-path fix, and the three review findings carried here.
[Source: `sprint-status.yaml` action items, epic 3] — GC rule and the relative-path item.
[Source: `replan-r1-2026-07-28.md:95-99`] — B-4a is under PRD amendment.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Delivered

- `src/capture/digest-index.ts` — the flat index at `<project>/.cortex.index`, written as a **full projection** of `content_digests`, temp-file-plus-rename, LF, six tab-separated columns with `-` for an absent agent, every field percent-escaped.
- Digest paths are now **scope-root-relative**, with the store as the single choke point deriving the key on write and read alike, plus a migration converting Story 3.1's absolute rows.
- `content_digests` GC rule (`CORTEX_GC_DIGEST_DAYS`, default 60, dry-run by default) — the table shipped in 3.1 with none.
- `.cortex.index` and its temp file in `IGNORE_ENTRIES` and the repo `.gitignore`.
- A reporting-only `digest-index` check in `cortex doctor`.
- `tests/digest-index.test.ts` (47) plus extensions to `tests/digest.test.ts`. Suite **1195 passed / 1 skipped / 37 files**; gate 8 suites at exact zero delta.

### What the measurements changed

- **AC #5 from Story 3.1 is now met across this repository's real range.** Stripping the scope root moved this repo's longest path (135 ch) from **417.8 FAIL to 376.8 PASS**, and repo-b's (145 ch) likewise. First breach moved 130 → **152**.
- **And it is still breached for a subagent read of the longest paths.** `agent_id` shares the row budget, so with a real 17-character agent id the first breach is **135 — exactly this repo's maximum**. Both breach points are asserted by test. An earlier version of this record claimed the cliff was "beyond ~180 characters"; that was false precision from interpolating a step function, caught by review.
- **The lookup is cheap; the platform is not.** `grep -F` costs 41.0 ms @1k records, 45.5 @10k, 58.6 @50k, 100.5 @200k against a ~39–42 ms process-spawn floor — so the marginal scan is ~2 to ~61 ms. But `jq` alone is ~81 ms and a plausible 4.5 sequence measured **214.8 ms against B-4a's 100 ms**. **AC #5 is reported, not claimed met**: B-4a is formally under a PRD amendment and a green against an unsettled budget would be worthless.

### Review: three layers, and what a green build did not catch

Everything below survived build, lint, 1175 tests, the gate, a live `doctor`, and a 13/14 mutation campaign.

- **HIGH — the index was written for `cwd` but selected records by the git toplevel.** Any project root that is not the repository root (a monorepo package, by definition) matched zero scopes and wrote a **zero-byte index** while digests recorded correctly. It never self-healed, because `isFile()` is true for a zero-byte file. Story 3.3 would have grepped an empty file and concluded nothing was ever read — the AD-6 silent-wrong-answer.
- **HIGH — reads outside the spool never reached the index.** `hook-entry post` and `cli log read` both record digests the flush cannot see, so those files were permanently absent.
- **HIGH — the migration's `UPDATE OR REPLACE` destroyed the newer row.** SQLite's REPLACE deletes the *pre-existing* row, so a 2020 legacy digest survived and a current row lost its hash, size and accumulated reads — and regressed `recorded_at` six years, straight into the new GC window. Silent corruption inside the function whose job is preventing silent orphaning.
- **HIGH — write and read resolved the scope root by different rules.** The write used the reading session's `worktree_path`, the read used the newest session's. One scope spanning two worktrees wrote keys nothing would look up, and two distinct files collapsed onto one row.
- **The headline survivor: `processed > 0 ||` could be deleted and all 1178 tests still passed.** The index would be written once and never refreshed — a permanently stale freshness oracle. Every existing test started with no index, deleted it first, or called the writer directly, so none could see it. This is the "helper, not the transport" family in its *update-path* form.
- **`CORTEX_GC_DIGEST_DAYS` reintroduced the `parseInt` hazard** the repo has now paid for three times: `1e9` — the natural way to disable pruning — became a **one-day** window.
- Smaller, all fixed: a corrupt index was trusted forever; `sha256`/`byte_size` bypassed the escaping the docstring promised; an empty `byte_size` column parsed as 0; a trailing CR was absorbed into `agent_id`; `.` and `..` were not collapsed in relative keys, giving one file three rows; the temp file was not gitignored; `scopeRootFor` cached `null` and never re-resolved.

### Mutation campaign: 21/24 killed, every mutation proven applied

Three survivors, each **verified** equivalent-code rather than assumed:

- The migration's absolute-key guard is redundant with `toScopeRelativeKey`'s own.
- The zero-byte check is redundant with the corrupt-first-line check.
- `scopeRootFor`'s read guard is redundant with its write guard — **confirmed by removing both, which kills the test**, so the property is covered and neither single mutation can die.

Six mutations initially reported NOT-APPLIED after the repair round moved their anchors; those results were meaningless and were re-run against the current source rather than counted (6/6 killed).

### Deviations

- **`src/capture/digest-index.ts`, not the architecture's `capture/index.ts`.** A module named `index` inside a package directory changes how the directory resolves, and the repo's convention is one module per concern with a mirroring test file.
- **The GC rule keys on `recorded_at`, not the story's "scope has no session within the window".** The upsert refreshes `recorded_at` on every read, so an actively-used file is never pruned however old its first read was — a better rule than the one accepted, recorded here rather than silently substituted.
- **`cortex doctor` gained a reporting-only index check.** The story asked me to decide and state; three silent-by-design failure modes with no diagnostic is below this command's standard that every non-passing check names a fix. It never rebuilds, because a diagnostic must not repair what it observes.

### File List

- `src/capture/digest-index.ts` — **new**
- `src/capture/spool.ts`, `src/capture/hooks.ts` — modified; index rebuild after commit, scope-root derivation moved to the store
- `src/scope/keys.ts` — modified; `toScopeRelativeKey`, `isAbsoluteFileKey`, `normalizeRelativeKey`
- `src/db/store.ts` — modified; `scopeRootFor`, relative-key derivation
- `src/db/schema.ts` — modified; `migrateContentDigestPaths`, corrected AC #5 record
- `src/db/gc.ts` — modified; `pruneContentDigests`, `envDays`, `normalizeDays`
- `src/query/install.ts` — modified; two ignore entries
- `src/query/doctor.ts` — modified; `digest-index` check
- `src/transports/cli.ts`, `src/transports/hook-entry.ts` — modified; index rebuild on the non-spool cold paths and after a real GC
- `src/index.ts` — modified; exports
- `tests/digest-index.test.ts` — **new** (47); `tests/digest.test.ts`, `tests/install.test.ts`, `tests/doctor.test.ts` — modified
- `CLAUDE.md`, `.gitignore` — modified
- `hooks/claude/*` — **deliberately unchanged**, so no `cortex install` re-run is required
