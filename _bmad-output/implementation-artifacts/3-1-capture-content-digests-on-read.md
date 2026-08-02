<!-- Story 3.1 — created by bmad-create-story, 2026-08-01 -->
<!-- Epic 3: Read Ledger and Token P&L. First story in the epic. -->

# Story 3.1: Capture content digests on read

Status: done

## Story

As Cortex,
I want a content digest recorded for every file the agent reads,
so that I can later tell whether that file has changed.

## Acceptance Criteria

Verbatim from `epics.md:561-598`, numbered for reference.

1. **Given** the agent reads a file **When** the spool batch is flushed **Then** a digest record is stored carrying `sha256`, byte size, mtime, path, and `scope_key` **And** the record identifies the reading session and its `agent_id` (AD-16).
2. **Given** the PostToolUse hook fires for a Read **When** the spool line is appended **Then** no Node process is spawned (N-4) and the hook stays within its budget.
3. **Given** a file larger than the configured size ceiling (default 2 MiB) **When** it is read **Then** path and size are recorded, no digest is computed, and the record is marked `oversize`.
4. **Given** a binary or non-UTF-8 file **When** it is read **Then** it is digested but never carded.
5. **Given** digest storage for a tracked file **When** its footprint is measured **Then** it costs no more than 400 bytes per file.
6. **Given** this is the first story in R1 to add a table **When** the migration is authored **Then** it bumps `SCHEMA_VERSION` 4 → 5 exactly once for the release and creates the `V5_TABLES` constant that later stories append to (AD-11, Validation Finding 2).
7. **Given** the migration runs against a store already at v5 **When** it is applied again **Then** it completes without error and changes nothing — `CREATE TABLE IF NOT EXISTS` throughout, no destructive statement (AD-11, N-8).
8. **Given** the migration is interrupted at any statement boundary **When** the store is reopened by either the current or the previous binary **Then** it opens successfully and no user-authored memory is lost (AD-11).
9. **Given** a store written by a newer schema version **When** an older binary opens it **Then** it refuses clearly rather than corrupting it (P-5).

---

## AC assessment — read this before writing code

Three ACs do not mean what they appear to mean. Two are stale against what
shipped; one is vacuous in R1. None of them should be *implemented around* —
they should be recorded as assessed and the story built on the corrected reading.

### AC #6 is factually false and must not be executed

**It says** this story bumps `SCHEMA_VERSION` 4 → 5 and *creates* `V5_TABLES`.
**Measured against the checkout:** `SCHEMA_VERSION` is already `5`
(`src/db/schema.ts:12`) and `V5_TABLES` already exists (`src/db/schema.ts:211`),
created by Story 2.2 for `memory_corrections`.

The constant's own docstring already names this story as an appender:

> *"Story 2.2 is the first story in the release to add a table, so it owns the
> bump and this constant; Stories 3.1, 4.3 and 4.4 **append** their tables here
> and leave the version alone."*

The 2026-07-28 replan states the same thing and strikes the original text
(`replan-r1-2026-07-28.md:114-118`).

**Corrected obligation:** append `content_digests` to the existing `V5_TABLES`.
**Do not touch `SCHEMA_VERSION`.** Bumping it to 6 would mark every existing
store as newer-than-binary for anyone still on a v5 build — which, per AC #9
below, is precisely the condition that must refuse.

Note this staleness is systematic, not a one-off: `ARCHITECTURE-SPINE.md:263`
carries it too (`schema.ts # +V5_TABLES, SCHEMA_VERSION 4 -> 5`), and
`project-context.md:50` states the general rule *"Adding a schema table requires
… bump `SCHEMA_VERSION`"*, which contradicts AD-11's one-bump-per-release.
**Fix `project-context.md:50` as part of this story** — it is loaded as
persistent context by every BMad skill and will otherwise re-teach the error on
every future run. The architecture spine is a dated planning artifact and stays
as-is; the replan is its correction of record.

### AC #4's "never carded" is vacuous in R1 — satisfy it by construction

File cards (Stories 4.1/4.2, FR-10/FR-11) are **withdrawn from R1**
(`replan-r1-2026-07-28.md:109-111`); `file_cards` is never appended to
`V5_TABLES` in this release. There is no carding path to suppress.

**Do not invent a `carded`/`no_card` column or flag to satisfy this.** The
implementable half is the first half: a binary or non-UTF-8 file **is digested**.
Hash bytes, not decoded text — read the file as a `Buffer` and never
`toString('utf8')` before hashing. Record in Dev Agent Record that the
"never carded" clause is satisfied by the absence of cards, not by a guard.

### AC #9 is real, unimplemented, and the largest piece of work here

I measured this rather than reading it. A store stamped `schema_version = 6`,
opened by this build:

```
this build SCHEMA_VERSION : 5
store version before open : 6
refused with error        : false
store version after open  : 5
```

`ensureCortexSchema` rewrites the version **down** and returns normally. The
guard at `src/db/schema.ts:634` is `if (currentVersion !== SCHEMA_VERSION)` —
an inequality, so it fires in both directions. A newer store is silently
downgraded, and its unknown tables are then operated on by a binary that does
not know their invariants.

This corroborates an already-recorded consequence in `CLAUDE.md`: `doctor`'s fix
string for a newer store deliberately says *upgrade the package*, never "run any
cortex command", because that path "rewrites `schema_version` **down**,
destroying the evidence just reported."

**Corrected obligation:** implement the refusal. Change the downgrade branch to
fire only when `currentVersion < SCHEMA_VERSION`, and add an explicit,
clearly-worded throw when `previousVersion > SCHEMA_VERSION`.

---

## The mechanism — read this before any code

### 1. The hot path needs no change at all

This is the most important finding in the story, and the one most likely to be
missed into an N-4 violation.

`cortex-capture.sh` already writes `file` on every `read` line, already carries
`agent_id`/`agent_type`, and already appends with one `jq` call and no Node
spawn. **The digest is computed at flush time, in the cold path.** AC #1 says
"when the spool batch **is flushed**"; AC #2 only constrains the append.

So AC #2 is satisfied **structurally, by not editing `hooks/claude/cortex-capture.sh` at all** —
the same shape as Story 2.6's AC #2 deviation. Do not add `sha256sum` to the
hook. It would be a process per tool call (B-4; ~400 ms measured on this
Windows/Git-Bash platform per the open Epic-1 action item), and AD-2 forbids the
hot path from doing anything but read the flat projection.

**Consequence to state honestly rather than hide:** the digest describes the
file *as of flush time*, not as of the read. A file read and then edited in the
same batch digests post-edit. This is safe only because Story 3.3's
`edited-by-you-since` verdict takes precedence for exactly that case — the edit
event is replayed from the same spool. A file changed by something *outside*
Cortex between read and flush records the changed digest and will later report
`unchanged-since`, which is wrong. That is a bounded, real imprecision; record
it in Dev Agent Record and carry it into 3.3 rather than claiming
read-time fidelity the design does not have.

### 2. Where the digest is computed

In the cold path, on replay of a `read` entry — `handleReadEvent`
(`src/capture/hooks.ts:168`) is the existing seam, reached from
`replayEntry` in `src/capture/spool.ts:117`. New module per the architecture's
structural seed: **`src/capture/digest.ts`** — "content hashing, oversize policy,
index line format" (`ARCHITECTURE-SPINE.md:253`).

Do **not** create `src/capture/index.ts` in this story. That file is Story 3.2's
(the flat index writer), and naming a module `index.ts` inside a package
directory has resolution consequences worth deciding deliberately rather than
inheriting. Flag it at 3.2 create-story time.

### 3. The table

Name is fixed by the architecture: **`content_digests`**
(`ARCHITECTURE-SPINE.md:207,218` — snake_case, plural, one noun). Appended to
the existing `V5_TABLES`.

Binding conventions from `ARCHITECTURE-SPINE.md:214-231`:

| Concern | Rule |
| --- | --- |
| Key | "Digests keyed by `(scope_key, path)`" (line 221) — a UNIQUE constraint, upsert on conflict. One row per file per scope, not one per read. |
| Scoping | `scope_key TEXT NOT NULL` (line 225). |
| Hashes | `sha256`, lowercase hex, full length in storage (line 223). |
| Time | ISO-8601 UTC `TEXT` (line 222). Never epoch numbers. |
| Ids | Application-generated string ids, never autoincrement (line 221). |
| Public surface | Every exported symbol added to `src/index.ts` in the same change (line 230). |
| Config | `CORTEX_`-prefixed env var, conservative default (line 229). |

AD-16 (`ARCHITECTURE-SPINE.md:133-137`) requires the row to record **who read
it** — the reading session's id *and* `agent_id` — because refund eligibility is
per-session with ancestor rules. `session_id` alone is not sufficient; store
both. This is the column 3.3's cross-session attribution AC depends on, and
adding it later means a migration this release cannot afford.

### 4. It does not project into `memory_items`

**AD-4 is explicit:** only *knowledge* projects (notes, episodes, command runs,
snapshots, summaries, cards). "LOOKUP STRUCTURES do not (content digests,
negative results, tool-output records)." `ARCHITECTURE-SPINE.md:64` repeats it:
read-ledger entries "live in dedicated tables with their own query paths and are
never retrieval candidates."

Two consequences: **no `backfill*` function** is needed (nothing to project),
and **no AD-5 kind-coverage obligation** — this story introduces no new
`memory_items` kind, so `eval/kind-coverage.json` is untouched and no locked
fixture is added. Expected gate impact is exactly zero (see below).

### 5. Oversize policy

Ceiling `CORTEX_DIGEST_MAX_BYTES`, default 2 MiB (2 × 1024 × 1024).

**Parse with `Number`, never `parseInt`.** This is a paid-for trap: Story 2.6's
`resolveWalMaxBytes` review found `parseInt('4e6') === 4`, turning a 4 MB ceiling
into a 4-byte one. `gc.ts`'s neighbouring `envNumber` still uses `parseInt` — do
not copy it. Reject non-finite, zero and negative to the default. Follow
`resolveWalMaxBytes` (`src/db/schema.ts`) as the precedent, and mirror its tests.

Oversize rows record path and byte size, set `sha256` to NULL, and mark
`oversize`. Decide size from `fs.statSync` **before** reading the bytes —
statting then reading a 500 MB file to discover it is oversize defeats the
ceiling entirely.

---

## Tasks / Subtasks

- [ ] **Schema** (AC: 1, 6-corrected, 7)
  - [ ] Append `content_digests` DDL to the existing `V5_TABLES` in `src/db/schema.ts`. `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` on `(scope_key, path)`.
  - [ ] Columns: `id` TEXT PK, `scope_key` TEXT NOT NULL, `path` TEXT NOT NULL, `sha256` TEXT (NULL when oversize), `byte_size` INTEGER NOT NULL, `mtime` TEXT, `session_id` TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, `agent_id` TEXT, `oversize` INTEGER NOT NULL DEFAULT 0, `recorded_at` TEXT NOT NULL, `read_count` INTEGER NOT NULL DEFAULT 1.
  - [ ] **Do not modify `SCHEMA_VERSION`.** Assert this in a test.
  - [ ] `read_count` exists because Story 3.4 orders its brief line "by read frequency" and cannot reconstruct it from a keyed-upsert table. Increment on upsert.
- [ ] **Newer-schema refusal** (AC: 9)
  - [ ] Narrow the `!==` guard at `src/db/schema.ts:634` to `<`.
  - [ ] Throw a clear, actionable error when `previousVersion > SCHEMA_VERSION`, naming the store version, the binary version, and "upgrade cortex" as the fix — never "run any cortex command".
  - [ ] Run `find_referencing_symbols` + `certify_refs` first: the refusal propagates through `openProjectStore`, the single path every transport opens through.
  - [ ] **Confirm hook edges degrade to silence (AD-12).** A throw reaching `inject-header`/`reflect`/`end-of-turn` must not break the user's turn. Verify each transport's existing catch, and add one where absent.
  - [ ] `doctor` must keep reporting the mismatch — it opens read-only and never calls `ensureCortexSchema`, so it should be unaffected. Verify, don't assume.
- [ ] **Digest computation** (AC: 1, 3, 4)
  - [ ] New `src/capture/digest.ts`: `computeFileDigest(path)` → `{ sha256 | null, byteSize, mtime, oversize }`; `resolveDigestMaxBytes()` env parsing.
  - [ ] Hash the raw `Buffer`. Never decode to a string first (AC #4).
  - [ ] `statSync` before reading; skip the read entirely when oversize.
  - [ ] Missing/unreadable file: swallow and record nothing (AD-12 — capture edges never throw into a hook).
- [ ] **Store surface** (AC: 1)
  - [ ] `upsertContentDigest` on `CortexStore`, `ContentDigestRow` + `ParsedContentDigest`, `parseContentDigestRow`.
  - [ ] Add `content_digests` to `TableCounts` and the `tableExists`/count list at `src/db/schema.ts:727` if that list gates anything for this table.
  - [ ] Export everything new from `src/index.ts`.
- [ ] **Wire into the cold path** (AC: 1, 2)
  - [ ] Record the digest on `read` replay, carrying the resolved session id and the entry's `agent_id`.
  - [ ] `scope_key` comes from the resolved session, not from cwd.
  - [ ] **Do not edit `hooks/claude/cortex-capture.sh`.** Assert in a test that it contains no hashing invocation.
- [ ] **Footprint measurement** (AC: 5)
  - [ ] Measure real database growth across N inserted digests with realistic absolute Windows paths; divide. Assert ≤ 400 bytes/file against the measurement, not against a computed estimate of column widths.
- [ ] **Docs** (repo convention: documentation is part of the change)
  - [ ] `CLAUDE.md`: new invariants — cold-path digesting, the flush-time-not-read-time honesty note, the refusal, `content_digests` in Core Files.
  - [ ] `README.md` only if user-observable behavior changes.
  - [ ] `project-context.md:50` — correct the SCHEMA_VERSION rule. Also correct line 79 (names 5 gate suites; there are 8) and line 123 (*"`token_ledger` is written but never reported on"* — false; `cortex stats` reports it, measured this session).

---

## Dev Notes

### Previous story intelligence (2.6, and what its review cost)

**Every story in Epics 1 and 2 needed a repair round. Plan build → review → repair.**
2.6 passed build, lint, 1098 tests and 8 suites at zero delta, and its review
still found a five-second stall on a hook path the story had explicitly excluded
by design.

Directly applicable here:

- **Seven of seventeen mutations survived 2.6's first campaign**, including
  commenting out the wiring in all three transports — because the assertions were
  `expect(source(file)).toContain('installStoreCloseOnExit()')`. **A source-string
  check is not a wiring test; a commented-out call satisfies it.** This story has
  the identical hazard in "assert the capture hook contains no hashing" — that one
  is legitimately a source check because the claim *is* about the file's text, but
  the digest-on-replay wiring must be asserted behaviorally, through a real flush.
- **2.6 asserted two SQLite/OS claims without measuring and both were false.**
  Everything asserted here about the schema-version guard was measured (output
  reproduced above). Measure the 400-byte footprint the same way.
- **A test asserting a stronger claim than the code makes gets deleted.** 2.6's
  "the capture hook spawns no process" was false — it spawns one, detached, past
  the 256 KiB threshold. If a test here says "no process is spawned", scope it to
  *per tool call*, which is what N-4 actually claims.
- **From 2.5: the helper, not the transports.** A unit-tested `computeFileDigest`
  proves nothing about whether any replay path calls it.
- **win32 locks open files in the in-process suite**, and `dist/` goes stale
  against `src/`. If any test here spawns `dist/`, add the staleness guard 2.6
  had to build.

### Constraints

- **N-4 / B-4:** nothing added to `PostToolUse`. The hook is not edited.
- **AD-2:** cold path is the sole SQLite writer; hot path never opens SQLite.
- **AD-4:** no `memory_items` projection, no new kind, no AD-5 fixture.
- **AD-12:** capture and hook edges swallow with a comment saying why.
- **AD-11:** additive, idempotent DDL. No `SCHEMA_VERSION` change.
- Layer direction `transports/ → query/ → memory/ + scope/ → db/`. `digest.ts`
  lives in `capture/`, which already imports from `db/`.
- ESM: import specifiers end in `.js`. `npm run lint` does **not** typecheck
  `tests/`. Temp dirs via `os.tmpdir()`, never a literal `/tmp`.

### Expected gate impact: exactly zero

This adds a lookup table that no retrieval surface reads. All 8 locked suites
must show zero delta on `top1_hit`, `recall_at_3` and `output_tokens`. Suites
seed hermetic stores. **Any movement is a real regression, not a baseline to
regenerate.** Baseline to reproduce first: 1107 passed / 1 skipped / 35 files,
8 suites at exact zero delta.

### The traps this story is most likely to fail on

1. **Bumping `SCHEMA_VERSION` because AC #6 says so.** The single worst outcome
   available here — it marks every shipped store as newer-than-binary.
2. **Adding `sha256sum` to `cortex-capture.sh`** to satisfy AC #1 literally.
   Violates N-4/B-4 and AD-2, and AC #1 does not ask for it.
3. **Decoding to UTF-8 before hashing**, which corrupts binary digests (AC #4)
   and makes them non-reproducible against the same bytes.
4. **`parseInt` for the ceiling.** `parseInt('2e6') === 2`.
5. **Reading the file to discover it is oversize.**
6. **Inventing a carding flag** for a feature withdrawn from R1.
7. **Estimating the 400-byte footprint** from column widths instead of measuring
   database growth. SQLite page overhead and the UNIQUE index are the cost.
8. **A refusal that throws into a hook** and breaks the user's turn (AD-12).
9. **Keying on path alone**, losing scope isolation; or keying per-read, making
   the table grow unbounded and breaking 3.4's frequency ordering.

Mutate `src/` (never `dist/` — vitest imports `src/`), EOL-adaptive anchors,
and **prove every mutation applied** before claiming it was killed.

### Verification

```bash
npm run build && npm run lint && npx vitest run && npm run gate
```

Then, because this story changes store-open behavior on every transport:
`cortex doctor` stays green on the live installation, and `cortex stats` still
runs. No `hooks/claude/` change means **no `cortex install` re-run is required** —
state that explicitly rather than silently skipping it.

### Sources

[Source: `epics.md:555-598`] — ACs verbatim.
[Source: `replan-r1-2026-07-28.md:72-84,109-118`] — Epic 3 protected; AC #6 struck; 4.1/4.2 withdrawn.
[Source: `src/db/schema.ts:12,211,634`] — `SCHEMA_VERSION = 5`; `V5_TABLES` and its docstring; the `!==` guard.
[Source: measured this session] — a v6 store opened by this v5 build is silently rewritten to 5 and does not refuse.
[Source: `ARCHITECTURE-SPINE.md:50,52,64,133-137,207,214-231,253`] — AD-2, AD-3, AD-4, AD-16, table naming, conventions, structural seed.
[Source: `hooks/claude/cortex-capture.sh`] — the read line already carries `file`, `agent_id`, `agent_type`; one `jq` call, no Node spawn.
[Source: `src/capture/spool.ts:100-151`] — `isReplayable` / `replayEntry`, the cold-path seam.
[Source: Serena `find_referencing_symbols` on `ensureCortexSchema`] — reached from `openProjectStore`, `evaluateDatabase`, `cli.ts`, re-exported in `index.ts`.
[Source: `2-6-bound-the-write-ahead-log.md:105-116,182-232`] — repair-round record, the surviving-mutation findings, the source-string-check lesson.

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Delivered

- `content_digests` **appended** to the existing `V5_TABLES`. `SCHEMA_VERSION` untouched, pinned by a test.
- `src/capture/digest.ts` — `computeFileDigest`, `resolveDigestMaxBytes`, `createDigestCache`.
- `recordReadDigest` wired into `handleReadEvent`, so all three of its callers (spool replay, `cli log read`, `hook-entry post`) ledger a read. Per-batch memo created in the spool flush.
- `upsertContentDigest` / `getContentDigest` / row types on `CortexStore`; `content_digests` in `TableCounts`; everything exported from `src/index.ts`.
- `NewerSchemaError` + the P-5 refusal, with AD-12 silence on `inject-header`, `reflect`, `flush-spool` and every `hook-entry` action.
- `tests/digest.test.ts` — 32 tests. Suite: **1139 passed / 1 skipped / 36 files**; gate 8 suites at exact zero delta.

### What the measurements changed

Three results contradicted what the story or the ACs assumed, and each changed the implementation:

- **AC #9 was unimplemented, not merely untested.** A v6 store opened by this v5 build was silently rewritten **down** to 5 with no error — measured before writing any code. The guard was `!==`, which fires in both directions. Implementing the refusal, not testing an existing one, was the largest piece of work in the story.
- **AC #5 failed on the first implementation: 639 bytes/file against a 400-byte ceiling.** A surrogate UUID `id` plus a separate unique index was the cost. Dropping the surrogate so the architecture's stated key *is* the `PRIMARY KEY`, and making the table `WITHOUT ROWID`, gives **376.8 bytes/file** for a 130-character absolute Windows path and **278.5** for a typical repo-relative one. Measured across those two lengths the marginal cost is **0.93 bytes per path character**, so headroom runs out around a **155-character** path — recorded because it constrains Story 3.2.
- **The refusal broke AD-12 the moment it worked.** Measured against a real v6 store: `hook-entry reflect-pre` — a path that fires on **every Edit and Write** — dumped a raw `NewerSchemaError` stack trace and exited 1, and `inject-header` printed and exited 1 on SessionStart. Both now exit 0 silently while user-invoked commands still refuse loudly. `cortex doctor` was verified unaffected (it opens read-only and never calls `ensureCortexSchema`), which is what keeps the condition diagnosable.

Verified on the live installation rather than only in tests: after `flush-spool`, the real store holds digest rows with `read_count` accumulating correctly (`cli.ts` 5×, `schema.ts` 4×), including `src/transports/hook-entry.ts` — the NUL-byte file — at 16,609 bytes.

### Mutation campaign: 13/14 killed, every mutation proven applied

Mutations were applied to `src/` (never `dist/` — vitest imports `src/`), with EOL-adaptive anchors, and each was byte-verified on disk before its test ran; a mutation that fails to apply would otherwise report a false kill.

The first pass killed **10/14**. The four survivors were real test gaps, and three were repaired:

- **M12** — dropping `scope_key` from the digest lookup survived, because the isolation test asserted only `toBeDefined()` on both scopes, which a scope-blind query still satisfies. Rewritten so each scope reads back *its own bytes*.
- **M13** — removing the AD-12 hook guard survived: the silence had been measured by hand and never pinned. Replaced with real child-process runs of `dist/transports/cli.js` and `hook-entry.js` against a store stamped one version too new, plus a `dist/` staleness guard (2.6's lesson) and a precondition asserting the store really is newer.
- **M14** — hard-coding `oversize: false` at the call site survived, because the oversize test exercised `computeFileDigest` directly and never went through `handleReadEvent`. **This is Stories 2.5/2.6's "the helper, not the transport" finding recurring in this story's own tests.** Now asserted through the shipping path.

Second pass: **13/14**.

### Deviations

**AC #6 was not implemented as written, deliberately.** It says bump `SCHEMA_VERSION` 4 → 5 and create `V5_TABLES`. Both were already done by Story 2.2; the version is 5 and the constant's own docstring names 3.1 as an appender. Doing what the AC says would mark every shipped store as newer-than-binary — which, after AC #9 in this same story, now *refuses to open*. The two ACs are in direct contradiction and only one can be satisfied. See § AC assessment.

**AC #4's "never carded" is satisfied by construction, not by a guard.** File cards were withdrawn from R1, so no carding path exists. No flag or column was added to suppress something that cannot happen.

**AC #2 is satisfied structurally.** `hooks/claude/cortex-capture.sh` is byte-unchanged (verified with `git diff hooks/`), so no process was added to the tool-call path at all. Because nothing under `hooks/claude/` changed, **no `cortex install` re-run is required** — stated explicitly rather than skipped silently.

**One mutation survives on purpose.** Restoring the `!==` downgrade guard cannot be killed by any test: the refusal throws before that line is reachable for a newer store, so `<` and `!==` are equivalent there. `<` is kept because it states the intended direction and holds if the refusal is ever moved. Recorded in the code comment rather than left as an apparent coverage gap.

### Documentation

`CLAUDE.md` gained the digest, refusal, AD-12, footprint and cold-path invariants. `_bmad-output/project-context.md` had **three false claims** corrected — it is loaded as persistent context by every BMad skill, so each would have re-taught the error on every future run:

1. "Adding a schema table requires … bump `SCHEMA_VERSION`" — contradicts AD-11 and this story directly.
2. "Suites are budget, kind-ordering, rename-moved, stale-label, stemming" — there are eight, and the gap that the brief/state surfaces are ungated is now stated.
3. "`token_ledger` is written but never reported on" — **false**; `cortex stats` prints Spent/Saved/Net/Efficiency today. This is the claim that misled Story 2.7.

### File List

- `src/db/schema.ts` — modified; `content_digests` appended to `V5_TABLES`, `NewerSchemaError`, P-5 refusal, `<` guard
- `src/db/store.ts` — modified; digest row types, `upsertContentDigest`, `getContentDigest`, `TableCounts`
- `src/capture/digest.ts` — **new**
- `src/capture/hooks.ts` — modified; `recordReadDigest`, `ReadArgs.digestCache`
- `src/capture/spool.ts` — modified; per-batch digest cache
- `src/transports/cli.ts` — modified; `openCortexDbAmbient` + three ambient call sites
- `src/transports/hook-entry.ts` — modified; `main()` degrades to silence
- `src/index.ts` — modified; exports
- `tests/digest.test.ts` — **new**; 32 tests
- `CLAUDE.md`, `_bmad-output/project-context.md` — modified; invariants and three corrected claims
- `hooks/claude/cortex-capture.sh` — **deliberately unchanged**

## Senior Developer Review (AI)

Three layers — Blind Hunter, Edge Case Hunter, Acceptance Auditor — each
reproducing the baseline first (1139 passed / 1 skipped / 36 files, 8 suites at
zero delta). **Every defect below survived a green build, lint, full suite,
gate, live `doctor`, and a 13/14 mutation campaign.** The repair round was again
where the real defects were found.

### The story shipped a silent, total feature kill

`resolveDigestMaxBytes` checked `parsed <= 0` **before** `Math.floor`, so any
value in (0,1) survived the guard and floored to zero. Measured end-to-end:
`CORTEX_DIGEST_MAX_BYTES=0.5` recorded `sha256 NULL, oversize 1` for a 20-byte
file — every file oversize, nothing ever hashed. That is byte-for-byte the
failure this function's `Number`-not-`parseInt` choice exists to prevent,
reached by a different route, in code whose own comment explains the hazard.

### Three defects in what I recorded, not what I computed

- **AD-16 attribution was destroyed by last-writer-wins.** A parent's read
  followed by its own subagent's read of the same file left **zero rows
  attributable to the parent**, and the parent would later be told a subagent
  read a file it read itself. My comment justified the overwrite as "the newest
  reader is the one whose claim is strongest" — false in exactly the direction
  AD-16 cares about. Now the ancestor is preserved while content columns still
  update, which works because sessions nest one level.
- **The path key was unnormalized.** Measured: `C:/x/a.ts`, `C:\x\a.ts` and
  `c:\x\a.ts` produced **three rows for one file**, and a relative key was worse
  — the key was the literal string while the bytes came from the flushing
  process's cwd. Normalization now lives in `normalizeFilePathKey` and is applied
  **inside the store** on write and read alike, so Story 3.3 cannot derive the
  key differently. Case is folded on win32 *and darwin*; a reviewer caught that
  APFS is case-insensitive by default and my win32-only check would have left
  macOS with the bug.
- **The refusal was built on `parseInt` and therefore did not refuse.**
  `getSchemaVersion` reports an unparseable value as `0` — indistinguishable
  from a fresh store — so `schema_version = 'v6'` **opened, was rewritten to 5,
  ran the v1→v2 migration path, and overwrote `created_at`**. The
  "silently rewrote it down, destroying the evidence" outcome this story exists
  to prevent, reached through a corrupt value instead of a newer one. Now
  `CorruptSchemaVersionError`, under a shared `UnopenableStoreError` base so the
  AD-12 hook guards catch future conditions automatically rather than letting
  the first one escape as an unhandled throw.

### A TOCTOU window the design did not acknowledge

The ceiling was decided from `statSync` and never re-checked against the bytes
actually read. Reproduced with a concurrent writer: **36 of 17,147 calls hashed
a 6 MiB file under a 2 MiB ceiling, and 4.5% of rows ended with a `byte_size`
and a `sha256` describing different states of the file.** A row whose own two
columns disagree is worse than a missing row, because 3.3 would trust it. The
size is now re-checked post-read and `byteSize` comes from the bytes hashed.

### My mutation campaign gave false confidence exactly once

The Acceptance Auditor found a survivor mine missed: removing `digestCache` from
the flush left **all 32 tests passing**. My M8 mutated the *cache's internals*,
which the direct unit test kills — so the campaign looked complete while the
wiring was uncovered. The test that appeared to cover it was named "hashes a
path once per batch" and asserted only `readCount === 5`, a property of the SQL
upsert. **That is the third recurrence of the 2.5/2.6 "helper, not the
transport" finding in this story alone** — twice in my tests, once caught by me
(oversize), once only by review. ESM namespaces are not configurable so `vi.spyOn`
is unavailable; the replacement mutates the file between reads through an
injected `statSync` and asserts one stat for four reads.

### AC #5 does not hold at the tail, and the docs now say so

Re-measured with this branch's **real 74-character scope key**: median read path
(44 ch) 303.1 PASS, p90 (122 ch) 376.8 PASS, this repo's longest (135 ch)
**417.8 FAIL**, repo-b's longest (145 ch) **417.8 FAIL**. My "0.93 bytes per
character, breaches around 155" was false precision from interpolating two
points — the growth is a page-granularity **step function** of the whole row,
and `scope_key` shares the same budget, which I had not documented at all. The
ceiling test now pins the median and p90 as passing **and asserts the longest
real path fails**, so the boundary cannot be quietly forgotten. The fix is
relative-to-scope-root paths, which Story 3.2 should adopt when it defines the
index format.

### Repair campaign: 20/20 killed, every mutation proven applied

Including the wiring survivor and all seven repairs. The one known
equivalent-code mutation — restoring the `!==` guard — is excluded and
documented in source: the refusal throws before that line is reachable, so no
test can kill it.

### Recorded, not fixed — carried forward

- **`content_digests` has no GC rule** (`certify_refs`: zero hits in `gc.ts`).
  One row per path per scope, and every branch mints a scope, so it grows
  monotonically. Belongs to Story 4.6, which owns GC and bounds.
- **Under the P-5 refusal the spool never drains**, and past 256 KiB the capture
  hook keeps backgrounding a `flush-spool` that no-ops — an N-4 violation in
  exactly the state P-5 creates, persisting until the user upgrades.
- **`session_id ON DELETE CASCADE` binds a scope-wide fact to one session.**
  Latent — no `DELETE FROM sessions` exists in `src/` — but a future session GC
  would destroy change-detection facts other sessions still need.
- **`openProjectStore` refuses *after* `resolveProjectStore` has already run the
  legacy `VACUUM INTO`**, so a newer legacy store is copied to the new location
  and then refused, leaving it without `root_commit_oid` or `migrated_from`.
  Narrow (requires a newer pre-relocation store) but real.
- **`mcp.ts` deliberately does not swallow the refusal.** Two reviewers agreed
  this is the correct half of P-5 — a server is not a hook and has no turn to
  break. The weakness is only that the message reaches the user as "MCP server
  failed" unless they check logs.
- **The blanket `catch {}` in `recordReadDigest` makes a permanently dead ledger
  invisible** — with the table dropped, reads record nothing forever and no
  surface reports it.
