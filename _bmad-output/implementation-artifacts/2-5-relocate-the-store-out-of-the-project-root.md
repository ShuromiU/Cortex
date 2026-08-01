---
baseline_commit: e01c116
---

# Story 2.5: Relocate the store out of the project root

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user whose repository should not contain a database,
I want Cortex's store addressed by repository identity outside my working tree,
So that worktrees share one store and my project root stays clean.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.5 (lines 480-507). Do not reword, split, or extend. If one is wrong, flag it and say so rather than implementing around it.

1. **Given** a git repository
   **When** store identity is computed
   **Then** it is a hash of the absolute realpath of `git rev-parse --git-common-dir` (AD-10)
   **And** every worktree of that repository resolves to the same store.

2. **Given** two separate clones of the same repository on one machine
   **When** identity is computed for each
   **Then** they resolve to two distinct stores.

3. **Given** an existing project-root database
   **When** the store is first opened after this change
   **Then** it is migrated by copy, verified, and the original is left in place until the user confirms removal.

4. **Given** a repository that has been moved or renamed, with no store at the computed path
   **When** Cortex starts
   **Then** a store whose recorded root-commit OID matches and whose recorded path no longer exists is offered for adoption rather than starting empty.

5. **Given** a directory that is not a git repository
   **When** identity is computed
   **Then** it falls back to a hash of the working directory realpath and reports the degradation.

### AC assessment — implementable, with one reading that must be stated up front

**AC #4's "offered for adoption" cannot mean "prompts", because the code path it names cannot prompt.** "When Cortex starts" is the SessionStart hook, and AD-12 is absolute: *any* failure or ambiguity degrades to producing nothing, hooks exit 0, no Cortex behaviour may block or annotate the user's turn. There is no TTY on that path and never will be.

So adoption splits in two, and the split is the whole design:

| Path | Behaviour on a matching orphan |
| --- | --- |
| Hooks / MCP / any ambient start | **Detect and record; never adopt, never block, never print.** Start empty as it would have, with the candidate stored for a surface that can ask. |
| `cortex doctor` | Reports the candidate, its recorded path, its root-commit match and its size, and names `cortex adopt` as the fix. |
| `cortex adopt` (new, explicit) | Performs it. This is the "offer" being accepted. |

The AC says "offered … rather than starting empty". Read literally against an ambient start that must stay silent, those two clauses conflict — you cannot offer anything without speaking. The reading taken here is that **the offer must exist and must be reachable, not that it must interrupt.** Ambient starts do start empty; what changes is that the memory is no longer *lost*, and the next `doctor` run says so. Recorded as a deviation rather than hidden, exactly as Story 2.4 recorded its `unknown` verdict.

**AC #3's "until the user confirms removal" means nothing in this story deletes the project-root database.** Not on success, not after verification, not ever. The confirmation surface is `cortex adopt --remove-original` / a `doctor` line — and if this story ships with no delete path at all, that is correct and complete, because the AC's requirement is that the original *survives*.

**Everything else is directly implementable.** ACs #1, #2 and #5 are AD-10's rule verbatim, and `detectGitScope` already runs `rev-parse --git-common-dir` today — the identity work is smaller than it looks.

## The mechanism — read this before any code

### 1. `path.resolve` is not a realpath, and the AC says realpath

`src/scope/git.ts:44` resolves git's answer with `path.resolve`, which normalises separators and `..` but **does not resolve symlinks**. AC #1 says *absolute realpath*. The difference is not academic:

- A repo reached through a symlink (`~/work/proj` → `/mnt/data/proj`) hashes to two identities depending on how the user `cd`'d in. One user, one repo, two stores, memory split invisibly between them.
- On Windows, `realpathSync.native` also canonicalises **drive-letter case** and resolves 8.3 short names. `c:\repo` and `C:\repo` are the same directory and must not be two stores. This is the N-6 case and it must be tested, not assumed.

Use `fs.realpathSync.native`, falling back to `fs.realpathSync`, falling back to `path.resolve` if the path does not exist. Do **not** change `detectGitScope`'s existing `scope_key` derivation to match — scope keys are already persisted in every row of the store, and re-deriving them would orphan every existing session. Store identity is a new, separate computation.

### 2. The migration copy must not be a file copy

Measured on this machine, better-sqlite3 12.x / SQLite 3.51.3, a WAL store with 500 rows and a 2 MB WAL:

```
rows via naive fs.copyFileSync : ERR no such table: t
rows via VACUUM INTO           : 500 | integrity: ok
```

`fs.copyFileSync` of `.cortex.db` alone does not merely lose recent writes — it produced a database in which **the table did not exist**. Everything lived in the `-wal` sidecar that the copy left behind. This is Risk R-4 (*"Storage relocation loses or orphans an existing user's memory — unrecoverable trust damage"*) reachable by writing the obvious three lines.

Use `VACUUM INTO`, which is synchronous through better-sqlite3, folds the WAL in, and emits a single clean file with no sidecars. Then **verify before the original is trusted**: `PRAGMA integrity_check` = `ok`, `schema_version` matches the source, and the row counts of `memory_items`, `notes`, `sessions` and `events` match. Only then rename into place.

Copying the sidecars alongside the main file is *not* an acceptable alternative and must not be substituted during review: it is atomic-set copying of three files being written concurrently, which is the same bug with more steps.

### 3. Migration must be atomic against a second process

Two Claude sessions on one repo start at the same moment; both see no store at the computed path; both migrate. `VACUUM INTO` **fails if the destination exists**, which is a useful property, but the window between "check" and "vacuum" is still open.

Rule: `VACUUM INTO <target>/.migrating-<pid>-<counter>.db`, verify that file, then `fs.renameSync` into `cortex.db`. Rename is atomic within a filesystem. If the destination appeared meanwhile, discard the temp and use the winner — a migration that lost the race is a no-op, not an error. Sweep stale `.migrating-*` files on the next run.

### 4. Store home and layout

```
$CORTEX_HOME                    (override; default ~/.cortex)
  └── projects/
        └── <safe-basename>-<hash16>/
              └── cortex.db
```

- `hash16` = first 16 hex of `sha256(realpath of git-common-dir)`, matching `hookTemplateDigest`'s existing slice-16 convention in `src/query/doctor.ts`. It is the **only** authoritative part.
- `safe-basename` is cosmetic: the repo directory name, restricted to `[A-Za-z0-9._-]`, collapsed and capped at 32 chars. `~/.cortex/projects/a3f2b8c91d0e4f57/` is hostile the moment anything goes wrong. **No lookup may depend on the prefix** — the computed path is exact, and adoption scans directories and reads each store's `meta`, so the prefix is never parsed.
- Filename is `cortex.db`, not `.cortex.db`. Inside a dedicated directory the leading dot only forces `ls -a`.

**`CORTEX_HOME` is not a nicety — it is the test hermeticity boundary**, and Story 2.4's incident is the precedent: a test ran the real installer from the repo root and wrote to the real `~/.claude/settings.json` and the repo's own `.gitignore`. Every test in this story sets `CORTEX_HOME` to an `os.tmpdir()` mkdtemp path. A test that forgets it writes into the developer's actual memory store. Follow `CORTEX_SPOOL_DIR`'s existing shape in `src/capture/spool.ts:49` — override when non-empty, else default.

### 5. The root-commit anchor is not always one commit

`git rev-list --max-parents=0 HEAD` returns **every** root commit, and repositories with merged histories or grafts have several. Taking `[0]` is order-dependent and therefore not an identity. Rule: collect all, sort lexicographically, join with `,`. An empty repository has no `HEAD` and no anchor — record nothing, and adoption is simply unavailable for it. That is a silent degradation, not an error.

Store it in the existing `meta` table (`root_commit_oid`) alongside the `root_path` key that `initializeMeta` already writes (`src/db/schema.ts:415-425`). `root_path` is written once and never updated, which is exactly what AC #4 needs: *recorded* path, not current path. **No new table, and therefore no `V5_TABLES` change and no `SCHEMA_VERSION` bump** — AD-11 gives R1 one increment and Story 2.2 already owns it.

### 6. What does *not* move, and why it is not an oversight

`.cortex.state`, `.cortex.spool.jsonl` and `.cortex.agent-used` **stay in the project root.**

`hooks/claude/cortex-capture.sh` computes them in pure bash from the payload's `$CWD`:

```bash
grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0
SPOOL="$CWD/.cortex.spool.jsonl"
```

Relocating them means hashing a path in the PostToolUse hook. That requires either reimplementing sha256 in bash or spawning Node — and **N-4 forbids a process per tool call**, with B-4 the budget it protects. This is a hard architectural floor, not a deferral.

Consequence for Story 2.4's work: `IGNORE_ENTRIES` in `src/query/install.ts:73-80` **does not shrink**. The three project-local artifacts still need entries, and `.cortex.db` / `-wal` / `-shm` must stay too, because AC #3 leaves the original database in the project root indefinitely. Nothing about install's ignore handling changes; a reviewer expecting it to is reading FR-24's headline rather than this story's ACs.

**Stated plainly because the PRD's headline is broader than the story:** FR-24 opens with *"Cortex's runtime artifacts stop living in the user's project root"*, and after this story three of them still do. The PRD's own testable consequences say only *"The database and derived data move"*, which this story satisfies in full. Flagging the gap rather than silently satisfying the narrower text.

### 7. Four db-path derivation sites, and text search finds only three

```
src/transports/cli.ts:74          function findDbPath
src/transports/mcp.ts:130         function findDbPath
src/transports/hook-entry.ts:53   function findDbPath   <-- invisible to grep
src/query/doctor.ts:978           inline path.join
src/transports/cli.ts:915         --db option default '.cortex.db'
```

`src/transports/hook-entry.ts` contains a raw NUL byte at offset 11476 (a cache-key separator written as a literal `\0` rather than the escape), so **ripgrep, grep and `certify_refs`'s text pass all classify it as binary and skip it silently.** Verified both ways:

```
rg -n  "findDbPath" src/transports/   ->  cli.ts, mcp.ts        (2 files)
rg -na "findDbPath" src/transports/   ->  cli.ts, mcp.ts, hook-entry.ts
```

`certify_refs` on `.cortex.db` returned 17 union sites and did not include hook-entry.ts either. Enumerate with `-a` or via LSP for this story; a text-only sweep will miss the hook transport, which is the one that runs on every session start. Tracked separately in `deferred-work.md` — the NUL is pre-existing (committed in Epic 0's `1982226`), affects `src/query/reference-validation.ts` too, and fixing it is not this story's scope.

### 8. Doctor reports both locations

Risk R-4's mitigation names this explicitly: *"`doctor` reports both locations until the user confirms."* The `database` check gains the resolved store path, the project-root original when one still exists, and — when identity is degraded (AC #5) or an adoption candidate exists (AC #4) — says so with the fix. Reuse `REQUIRED_WIRING`'s discipline: the constant `doctor` reports from is the constant identity resolution returns.

## Tasks / Subtasks

- [ ] **1. `src/scope/identity.ts`** (new; ARCHITECTURE-SPINE:287 names this file for FR-21..FR-26). `resolveStoreIdentity(startDir, env)` → `{ storeId, storeDir, dbPath, gitCommonDir, rootCommitOid, degraded, degradedReason }`. Realpath per §1, multi-root anchor per §5, non-git fallback per AC #5. Pure and injectable — takes a `GitCommandRunner` like `detectGitScope` does, so tests need no real repos for the unit layer.
- [ ] **2. Migration** (`src/scope/store-migration.ts` or inside identity): detect a project-root `.cortex.db`, `VACUUM INTO` a temp name, verify (integrity + schema version + four row counts), atomic rename, leave the original. Race-safe per §3. Never deletes.
- [ ] **3. Adoption**: scan `$CORTEX_HOME/projects/*/cortex.db`, read `meta.root_commit_oid` and `meta.root_path`, return candidates whose OID matches and whose recorded path no longer exists. Detection is ambient and silent; `cortex adopt` performs it; `doctor` reports it.
- [ ] **4. Wire all four sites** from §7 plus the `--db` default. Every one must go through the single resolver — four copies of `findDbPath` is how three of them drift.
- [ ] **5. `meta.root_commit_oid`** written at init and backfilled on open when absent (the `root_path` pattern at `schema.ts:466` is the precedent). No new table, no version bump.
- [ ] **6. Doctor** per §8, and a `store` line naming the resolved path.
- [ ] **7. Tests** — see the trap list below. Real git repos via `git init` + `git worktree add` in `os.tmpdir()`; `CORTEX_HOME` sandboxed in every single one.
- [ ] **8. Docs** — `README.md` (the "stores memory in `.cortex.db` in the repo root" line at :558 becomes false and must change), `CLAUDE.md` (Core Files + Expected Behavior), `deferred-work.md`.

## Dev Notes

### Previous story intelligence (2.4, and the four before it)

**Every Epic 1 and Epic 2 story has needed a repair round. Plan build → review → repair; do not treat green tests as done.** 2.3 and 2.4 each surfaced ~25 defects *after* a green build, lint, full suite and gate.

Concretely inherited:

- **2.4's worst finding was that the command could not do the thing it was named for.** `commandSatisfiesWiring` answered *presence* while the story required *repair*, and the run reported success over a broken matcher. The analogue here: a resolver that computes the right path but leaves three transports pointing at the old one "works" in every test that only calls the resolver. **Test the transports, not the helper.**
- **2.4's second finding was scope-of-configuration, not code.** Idempotency was per-file while Claude Code merges three settings files. The analogue: identity is per-*repository*, and a test using one temp dir cannot see the worktree-convergence or two-clones ACs at all. Those two ACs require real `git worktree add` and real second clones.
- **A test that writes to the real environment is the incident to not repeat.** `CORTEX_HOME` in every test, always.
- **From 2.3: a check may not assert a positive fact about a file it never opened.** Doctor's new store lines must report `not checked` when identity is degraded, never a cheerful default.
- **From 2.1/2.2: test against the *refresh*, not the write.** The FR-4 and FR-22 analogues both bit. Here: a migration test that does not **reopen** the store from the new path proves nothing, and an adoption test that does not reopen proves less.
- **From 2.2: deleting a projection is not deleting** — `backfillMemoryItems` re-derives on every `ensureCortexSchema`. Relevant because migration verification counts rows: count *after* a clean reopen, or the numbers are whatever backfill just recreated.

### Constraints

- **Layer direction** (one-way, strict): `transports/` → `query/` → `memory/` + `scope/` → `db/`. `scope/identity.ts` may import from `db/` and node builtins. It may **not** import from `query/` or `transports/`. Doctor (in `query/`) importing `scope/identity.ts` is correct and with the grain.
- ESM: import specifiers end in `.js`. `npm run lint` does **not** typecheck `tests/`; `npx vitest run` is the only thing that does.
- Temp dirs via `os.tmpdir()`, never a literal `/tmp` — Node's `/tmp` and Git Bash's `/tmp` are different directories on this machine.
- AD-12: every failure degrades to silence on ambient paths. A missing `CORTEX_HOME` directory, an unwritable home, a corrupt candidate store — all degrade, none throw into a hook.
- AD-11: no `SCHEMA_VERSION` bump, no `V5_TABLES` change (§5).
- N-8: migration is additive and idempotent; re-running destroys nothing.

### Expected gate impact: exactly zero

This story changes **where the store lives**, not what retrieval returns or how it renders. All 8 locked suites must show zero delta on `top1_hit`, `recall_at_3` and `output_tokens`. Eval suites seed hermetic in-memory stores (`src/eval/seed.ts`) and never touch a real `.cortex.db`, so they should be structurally unaffected — if any suite moves, that is a real regression in retrieval, not a baseline to regenerate. Baselines are locked artifacts; regenerating is never how a red gate goes green.

No new `memory_items` kind, so AD-5 imposes no new fixture.

### The traps this story is most likely to fail on

Ranked by how plausible the wrong version looks:

1. **`fs.copyFileSync` for the migration.** Total data loss, three obvious lines, measured above.
2. **Counting rows before reopening.** Verification that reads the source connection's view, or the destination without a clean reopen, verifies nothing.
3. **`path.resolve` instead of realpath**, because `detectGitScope` next door already does it that way.
4. **Testing worktree convergence with two directories instead of a real `git worktree add`.** The AC is about git's common-dir, and only git can produce the condition.
5. **Leaving `hook-entry.ts` on the old path** because text search did not show it (§7).
6. **Auto-adopting on an ambient start**, which violates AD-12 and silently attaches a store the user never approved.
7. **Deleting the project-root original** after a successful migration, which AC #3 forbids in exactly those words.
8. **A test without `CORTEX_HOME` sandboxing**, which writes to the developer's real store.

Mutation-test every new assertion, mutate `src/` (never `dist/` — vitest imports `src/`), use EOL-adaptive anchors because working files are CRLF, and **prove each mutation actually applied** before claiming a kill.

### Verification

```
npm run build && npm run lint && npx vitest run && npm run gate
```

Then, on the live installation: `cortex doctor` must stay green, and it must name the new store location. Because this story moves the store the live path uses, verify the real `~/.claude` hook path end-to-end rather than trusting the unit layer — this is the first story since 2.2 that changes what every transport opens.

### Documentation is part of the change

`README.md:558` currently states *"Cortex stores memory in `.cortex.db` in the repo root"*. That sentence becomes false the moment this ships. Doc claims are code: every README and CLAUDE.md sentence written here must be verified the way an assertion is.

### Sources

[Source: `epics.md:480-507`] — ACs verbatim. [Source: `prd.md:376-383`] — FR-24's three testable consequences and the broader headline flagged in §6. [Source: `prd.md:771`] — Q4 RESOLVED, path-primary with commit-anchored repair; rejected alternatives (remote URL, root-commit as primary, committed id file). [Source: `ARCHITECTURE-SPINE.md:97-101`] — AD-10 verbatim. [Source: `ARCHITECTURE-SPINE.md:287`] — FR-21..FR-26 → `transports/cli.ts`, `scope/identity.ts`. [Source: `prd.md:730`] — Risk R-4 and its mitigation, including "doctor reports both locations". [Source: `src/scope/git.ts:37-49`] — `readGitPath`, already calling `--git-common-dir`, resolving with `path.resolve`. [Source: `src/db/schema.ts:415-425,466`] — `initializeMeta`, `root_path`, and the backfill-when-absent precedent. [Source: `src/capture/spool.ts:49`] — the env-override shape to follow. [Source: `hooks/claude/cortex-capture.sh:12-15`] — why the spool and state cannot move. [Source: `2-4-install-in-one-idempotent-command.md:157-230`] — the incident and the repair-round record. [Source: measured this session] — `VACUUM INTO` vs `copyFileSync` under WAL; the `rg` / `rg -a` divergence on `hook-entry.ts`.

## Dev Agent Record

### Delivered

- **`src/scope/identity.ts`** — `resolveStoreIdentity`, `resolveRealPath`, `cortexHome`, `computeStoreId`, `storeLabelFor`, `sanitizeLabel`, `readRootCommitOid`. Pure, injectable `runGit`, never throws.
- **`src/scope/store-migration.ts`** — `openProjectStore` (the one path every transport opens through), `resolveProjectStore`, `migrateLegacyStore`, `verifyStoreCopy`, `findAdoptionCandidates`, `adoptStore`, `recordStoreIdentityMeta`, `clearProjectStoreCache`.
- **Four db-path derivations collapsed to one.** `cli.ts`, `mcp.ts`, `hook-entry.ts` and `doctor.ts` all resolve through the shared path; `evaluate --db` lost its eager `.cortex.db` default.
- **`doctor`** gained `store`, plus conditional `store-legacy` and `store-adoption`, and now diagnoses the pre-relocation store when migration has not run.
- **`cortex store`** and **`cortex adopt`** (preview by default, `--yes` to move).
- **`tests/setup-cortex-home.ts` + `vitest.config.ts` `setupFiles`** — the suite-wide hermeticity guard, with `tests/hermeticity.test.ts` asserting it stays.
- 28 new tests in `tests/store-identity.test.ts` against **real** `git init` / `git worktree add` / `git clone`.

### Measured, not assumed

| Claim | Measurement |
| --- | --- |
| `copyFileSync` loses the WAL | source with 2 MB WAL → copy opens with **the table absent**; `VACUUM INTO` → 500/500 rows, `integrity_check ok` |
| `path.resolve` is not a realpath | win32: `c:\…` stays lower-case vs canonical `C:\…`; a junction resolves to the link, not the target |
| identity cost | 176 ms → **64 ms** by combining two `rev-parse` calls into one and deferring `rev-list` behind a memoized thunk |
| test leakage | **163 directories** written into the real `~/.cortex` by one suite run before the setup file existed |
| live migration | this repo: 13.7 MB + 4.2 MB hot WAL → 3136 memory_items / 35 notes / 133 sessions / 572 events **identical**, original intact |

### Four things the story's own design got wrong first

1. **The repair anchor was written by the transports, not by the shared resolver.** Adoption matches on `root_commit_oid`, so any caller that resolved-and-opened by hand produced a store that could never be recovered after a move. Found because the first adoption test returned zero candidates. Fixed by making `openProjectStore` do resolve → migrate → open → record as one unit; the three transports now have two-line bodies.
2. **`recordStoreIdentityMeta` resolved the anchor before reading the column** — a `git rev-list` on every store open, on the hook path. Now reads the column first.
3. **`doctor` reported `database does not exist` for an un-migrated store.** A red "your memory is gone" over a fully readable store sitting in the project root, at the exact moment nothing is wrong. It now diagnoses whichever store exists and says which.
4. **`doctor`'s docstring said "no process is spawned"** and I made that false by adding `git rev-parse`. Narrowed the bullet explicitly rather than leaving it standing.

### Mutation campaign

**21 mutations, 21 killed, 0 survived, 0 unapplied.** Four survived the first pass, and each was a test that did not test what it said:

- *copy verification skipped* — no fixture can make `VACUUM INTO` succeed and verification fail; SQLite copies faithfully or errors. Added an injectable `verify` seam, because the defect being modelled is "the verdict is computed and ignored", which is about wiring, not input.
- *destination guard removed* — masked by the second, pre-rename existence check. Now killed by corrupting the source before the second run: with the guard the answer stays `destination-exists`, without it the corrupt source changes it.
- *adoption ignores "recorded path still exists"* — the fixture used an unrelated repository, which the **anchor** check already excluded. Now a `git clone`, which shares the root commit, so only this rule separates them. That is also the "a fork must not inherit upstream's memory" property.
- *adopted store keeps its dead recorded path* — asserting the candidate list is empty proves nothing, since `findAdoptionCandidates` returns early once a store exists. Now asserts `meta.root_path` directly.

### Deviations

- **AC #4's "offered for adoption" is not a prompt.** The path it names is SessionStart, where AD-12 forbids blocking, printing or asking. Detection is silent; `doctor` and `cortex store` report; `cortex adopt` performs. Ambient starts do start empty — what changed is that the memory is no longer lost. Stated in the AC assessment above rather than hidden.
- **FR-24's headline is broader than this story.** It opens "Cortex's runtime artifacts stop living in the user's project root"; three still do (`.cortex.state`, `.cortex.spool.jsonl`, `.cortex.agent-used`), because `cortex-capture.sh` is pure bash and N-4 forbids a process per tool call. The PRD's own testable consequences name only the database and derived data, which this story satisfies in full.
- **`root_path` now records the worktree toplevel** rather than the process cwd. It is only written when absent, so existing stores are untouched; it needs to stop existing when the repository moves, which is the signal AC #4 keys on.

### Verification

`npm run build`, `npm run lint`, `npx vitest run` (**1064 passed / 34 files**), `npm run gate` (**8 suites, exact zero delta**).

Live installation: `cortex doctor` resolves `C:\Users\dev\.cortex\projects\cortex-3cfdcbfe1ad6e75b\cortex.db (id 3cfdcbfe1ad6e75b from C:\Claude Code\cortex\.git)`, warns that the original is retained, and reports the database reachable. The one pre-existing failure (`hook-currency`: hooks installed before 2.3's stamping) is untouched by this story.
