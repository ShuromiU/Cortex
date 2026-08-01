---
baseline_commit: 078d5a0
---

# Story 2.6: Bound the write-ahead log

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user watching a database grow,
I want the WAL checkpointed and reported,
So that Cortex's footprint stays bounded and visible.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.6 (lines 509-527). Do not reword, split, or extend. If one is wrong, flag it and say so rather than implementing around it.

1. **Given** a session ends
   **When** the store is closed
   **Then** a checkpoint runs.

2. **Given** the WAL crosses its configured threshold mid-session
   **When** the threshold is detected
   **Then** a checkpoint runs off the critical path and blocks no hook.

3. **Given** the stats command runs
   **When** it reports footprint
   **Then** it names database and WAL size separately.

### AC assessment — all three implementable, and the premise needs correcting first

**FR-25's headline is already true, and the story is not the one the title implies.** Measured on this machine (SQLite 3.51.3, better-sqlite3 12.x), with the *shipped* configuration:

```
autocheckpoint default  : 1000 pages          <- SQLite's own, ~4 MB at 4096-byte pages
WAL after 20k inserts   : 4128272
WAL after PASSIVE       : 4128272   <- what autocheckpoint runs; file NOT shrunk
WAL after TRUNCATE      : 0         <- file actually shrunk
WAL before close()      : 4128272
WAL after close()       : 0         <- close() already checkpoints and removes the sidecar
```

So the WAL is **not** unbounded today — `wal_autocheckpoint = 1000` already bounds it. The live store in this repository sits at `cortex.db 14,663,680` / `cortex.db-wal 4,132,392`, which is that bound working exactly as designed.

The real defect is narrower and worth stating plainly, because it changes what to build: **a passive checkpoint resets the WAL for reuse but never shrinks the file**, so the footprint stays parked at its high-water mark forever. Only `TRUNCATE` returns the space. That is the 4.13 MB sitting in the store right now.

**AC #1's gap is the close, not the checkpoint.** `db.close()` already checkpoints — measured above. What is missing is that **no ambient transport ever closes the store**. Enumerated with Serena over `openDatabase` plus every `.close()` site: `cli.ts` closes only in the two `gc` paths, and `mcp.ts` and `hook-entry.ts` never close at all. The process exits and the OS tears the handle down, which is not a checkpoint and does not remove the sidecar. So this AC is satisfied by adding a close path, and the checkpoint inside it should be `TRUNCATE` rather than relying on the implicit one, so the file actually shrinks.

**AC #2's "blocks no hook" is already structurally satisfied and must stay that way.** `PostToolUse` is pure bash and spawns no Node (N-4), so nothing on the hot path can checkpoint even if it wanted to. The threshold check therefore belongs where a Node process already runs and latency is not on the tool-call path — the spool flush and `end-of-turn`. The check itself must be one `fs.statSync` on the `-wal` file, not a query.

**All three ACs are implementable as written.** No AC is wrong.

## The mechanism — read this before any code

### 1. `TRUNCATE`, and it can legitimately fail

A concurrent reader in an open transaction blocks truncation. Measured:

```
TRUNCATE, reader mid-txn: {"busy":1,"log":565,"checkpointed":565}  WAL= 4132392
TRUNCATE, reader done   : {"busy":0,"log":0,"checkpointed":0}      WAL= 0
```

Note `busy: 1` **with `checkpointed: 565`** — the checkpoint did its work, it simply could not reclaim the file while a reader held it. So a `busy` result is not a failure to report loudly; it is the normal outcome when an MCP server is holding a read. Retrying immediately is pointless. Record it and move on.

This matters for Cortex specifically: the MCP server is a long-lived process holding a connection, so a checkpoint from a CLI invocation will frequently come back busy. A test that asserts `WAL === 0` after a checkpoint while another connection is open will be flaky, and that is the trap.

### 2. Where the close goes

Three transports, three lifetimes:

| Transport | Lifetime | Close point |
| --- | --- | --- |
| `cli.ts` | one command | after the action completes |
| `hook-entry.ts` | one hook fire | after the payload is handled |
| `mcp.ts` | long-lived server | on shutdown, and on the threshold path |

A single `closeProjectStore(db)` — checkpoint `TRUNCATE`, then `close()` — is the one function all three call, following `openProjectStore`'s precedent from story 2.5. Do **not** hand this to three call sites to remember; that is the defect shape 2.5's review spent its whole budget on.

**The in-process test hazard is real and was hit in 2.5.** `tests/cli.test.ts` runs commands in the vitest process, so a close that fires per command changes what later assertions can open, and on win32 a still-open handle makes file removal fail. Prefer closing at the point the *process* is done rather than after every command, or make the close explicit and have the tests drive it. Whatever is chosen, the transports must genuinely close in production — assert that, not the helper.

### 3. Threshold

`CORTEX_WAL_MAX_BYTES`, default 4 MiB, following `CORTEX_GC_*`'s existing env-var shape in `src/db/gc.ts` (`envNumber`). Checked by `fs.statSync` on `<dbPath>-wal`, which costs nothing, at the two points a Node process is already running and not on a tool-call path: the spool flush and `end-of-turn`. Non-finite, zero and negative fall back to the default — the `resolvePageLimit` rule from story 2.1, for the same reason (`Number`, never `parseInt`).

### 4. Reporting

`cortex stats` names the two separately (AC #3). `doctor`'s store row is the natural second home for it, but AC #3 says "the stats command" and that is the requirement; adding it to `doctor` is optional and should not be smuggled in as if the AC asked. Report the `-shm` too only if it is free to do so — it is 32 KB and constant, so it is noise.

## Tasks / Subtasks

- [ ] **1. `checkpointWal(db)`** in `src/db/schema.ts` (it owns `openDatabase` and the WAL pragma): run `wal_checkpoint(TRUNCATE)`, return the `{busy, log, checkpointed}` row, never throw.
- [ ] **2. `closeProjectStore(db)`** in `src/scope/store-migration.ts` alongside `openProjectStore`: checkpoint then close, idempotent, never throws.
- [ ] **3. Wire the three transports** to close. Enumerate with `find_referencing_symbols` on `openProjectStore`, not grep — `hook-entry.ts` carries a NUL byte and text search skips it silently.
- [ ] **4. Threshold check** on the flush and `end-of-turn` paths only, `CORTEX_WAL_MAX_BYTES` (default 4 MiB), one `statSync`.
- [ ] **5. `cortex stats`** reports database and WAL size separately.
- [ ] **6. Tests** — see the trap list.
- [ ] **7. Docs** — `README.md` (the Data section states the footprint story), `CLAUDE.md`, `deferred-work.md` if anything is deferred.

## Dev Notes

### Previous story intelligence (2.5, and what its review cost)

**Every Epic 1 and Epic 2 story has needed a repair round. Plan build → review → repair.** 2.5's review found two defects that would have destroyed user memory, after a green build, lint, 1064 tests and 8 suites at zero delta.

Directly applicable here:

- **2.5's worst test failure: the helper, not the transports.** A test helper that tolerated both the old and new store path let all three transports be reverted with the whole suite green. Here the analogue is exact: a checkpoint helper that is unit-tested proves nothing about whether any transport ever calls it. **Assert the close happens through the transport.**
- **A mutation campaign proves only what it mutates.** 2.5's first campaign scored 21/21 while never touching a transport. Include the wiring in the mutation list from the start.
- **Measure the SQLite behaviour rather than assuming it.** Every claim in §1 above is measured, and two of them contradict the obvious assumption (`PASSIVE` does not shrink; `close()` already checkpoints).
- **In-process tests share one process and win32 locks open files.** 2.5 had to split a test for exactly this. Expect it here, because close is the subject.
- **From 2.3: a diagnostic must not repair what it observes.** If a WAL size lands in `doctor`, reading it must not checkpoint.

### Constraints

- **N-4 / B-4:** no process per tool call. Nothing added to `PostToolUse`. The threshold check runs only where Node already runs.
- **AD-12:** every failure degrades to silence on ambient paths. A `busy` checkpoint, an unreadable `-wal`, a locked file — none may surface or throw into a hook.
- Layer direction: `transports/` → `query/` → `memory/` + `scope/` → `db/`. `checkpointWal` in `db/`, `closeProjectStore` in `scope/`.
- ESM, import specifiers end in `.js`; `npm run lint` does not typecheck `tests/`; temp dirs via `os.tmpdir()`.
- No schema change, so no `SCHEMA_VERSION` bump (AD-11 gives R1 one, already spent by 2.2).

### Expected gate impact: exactly zero

This changes footprint management, not retrieval or rendering. All 8 locked suites must show zero delta on `top1_hit`, `recall_at_3` and `output_tokens`. Suites seed hermetic stores and never touch a real database. Any movement is a real regression, not a baseline to regenerate.

### The traps this story is most likely to fail on

1. **Asserting `WAL === 0` after a checkpoint while another connection is open.** Measured `busy: 1` above; this is the flake generator.
2. **Testing `checkpointWal` and calling the transports covered.** The 2.5 lesson, restated.
3. **Putting the threshold check somewhere on the tool-call path**, which breaks N-4 silently — nothing fails, the hook just gets slower.
4. **Closing after every CLI command** and breaking the in-process test suite, or worse, papering over it by making tests reopen.
5. **Reporting the WAL by querying it** rather than `statSync`, which both costs more and can itself create the sidecar (2.3's finding).
6. **Treating `busy` as an error** and surfacing it, violating AD-12.

Mutate `src/`, EOL-adaptive anchors, prove every mutation applied.

### Verification

```
npm run build && npm run lint && npx vitest run && npm run gate
```

Then on the live installation: `cortex doctor` stays green, `cortex stats` names both sizes, and the live store's 4.13 MB WAL measurably shrinks after a close.

### Sources

[Source: `epics.md:509-527`] — ACs verbatim. [Source: `prd.md:385-392`] — FR-25's three testable consequences. [Source: measured this session] — autocheckpoint default, PASSIVE vs TRUNCATE, `close()` checkpointing, `busy` with a live reader, and the live store's 14.66 MB / 4.13 MB split. [Source: `src/db/schema.ts:363`] — `journal_mode = WAL`, the only place it is set. [Source: `src/db/gc.ts:173-236`] — `freelistRatio` and the existing VACUUM policy, the closest precedent for a size-triggered maintenance rule. [Source: `src/db/gc.ts` `envNumber`] — env-var shape to follow. [Source: Serena `find_referencing_symbols` on `openDatabase` + every `.close()` site] — only `cli.ts` closes, in the two `gc` paths; `mcp.ts` and `hook-entry.ts` never do. [Source: `2-5-relocate-the-store-out-of-the-project-root.md`] — the helper-vs-transport lesson and the repair-round record.

## Dev Agent Record

### Delivered

- `checkpointWal` / `maybeCheckpointWal` / `walSizeBytes` / `databaseSizeBytes` / `resolveWalMaxBytes` in `src/db/schema.ts`.
- `closeProjectStore` / `closeAllProjectStores` / `installStoreCloseOnExit` in `src/scope/store-migration.ts`, beside `openProjectStore`.
- All three transports install the exit-path close. `CortexStore.db` became public `readonly` so a caller can checkpoint the file without opening a second connection.
- Threshold checkpoint on `end-of-turn` and `flush-spool` only.
- `cortex stats` names database and WAL separately.
- `tests/wal.test.ts` (15) plus CLI coverage of AC #3; 1098 tests, 35 files.

### What the measurements changed

The story was written after measuring, and two results contradicted the obvious reading:

- **`wal_autocheckpoint` already bounds the WAL** (1000 pages). FR-25's headline was satisfied before this story started. What was not satisfied is that a passive checkpoint never *shrinks* the file — 4,128,272 bytes before and after — so the footprint parks at its high-water mark. The story is the truncation.
- **`close()` already checkpoints.** AC #1's gap was that nothing called it.

Verified live: this repository's own store went from a 4,132,392-byte WAL to 0, with the database growing 24,576 bytes — most frames were already folded in by autocheckpoint, and only the file had never been reclaimed. `cortex stats` now prints `Database: 14.0 MB` / `WAL: 96.6 KB`.

### Deviations

**AC #2's "off the critical path" is satisfied structurally rather than by a latency budget.** `PostToolUse` is pure bash and only reaches `flush-spool` through a subshell it backgrounds and never waits for, so the checkpoint cannot be on a tool call by construction. `reflect-pre` is deliberately excluded even though it is a Node path, because it fires on every Edit and Write. This is stronger than the AC asks for and is recorded here rather than assumed.

**The close is registered on `process.on('exit')`, not after each command.** AC #1 says "when the store is closed"; per-command closing would satisfy it too, and breaks the in-process test suite on win32 where an open handle blocks file removal — the hazard Story 2.5 had to split a test for. Exit is the honest boundary for a CLI or hook process, whose lifetime *is* the command.

### One test claim I had to correct

The first version asserted the capture hook "spawns no process" and contained no `__CORTEX_NODE__`. That is false — it spawns one, detached, past the 256 KiB spool threshold. The assertion now checks the property that actually holds and matters: every Node invocation in that script is backgrounded (`&)`), so the hook returns immediately. A test asserting a stronger claim than the code makes is a test that will be deleted the first time someone reads it carefully.
