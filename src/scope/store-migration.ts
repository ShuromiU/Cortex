import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import {
  checkpointWal,
  ensureCortexSchema,
  getMetaValue,
  openDatabase,
  openDatabaseReadOnly,
  setMetaValue,
  type WalCheckpointResult,
} from '../db/schema.js';
import {
  resolveStoreIdentity,
  STORE_FILENAME,
  type ResolveStoreIdentityOptions,
  type StoreIdentity,
} from './identity.js';

/**
 * Moving a store without losing it (FR-24 AC #3/#4, Risk R-4).
 *
 * The copy is `VACUUM INTO`, never a file copy. Measured on this machine
 * (better-sqlite3 12.x / SQLite 3.51.3): copying `.cortex.db` alone out of a
 * live WAL store produced a database in which the table did not exist —
 * everything was in the `-wal` sidecar the copy left behind. That is R-4
 * ("loses or orphans an existing user's memory") reachable in three obvious
 * lines. `VACUUM INTO` folds the WAL in, emits one clean file with no sidecars,
 * works from a read-only connection, and refuses to overwrite an existing
 * destination — a race guard SQLite gives us for free.
 *
 * Nothing here ever deletes a project-root database. AC #3 requires the
 * original to survive "until the user confirms removal", so no path in this
 * module touches it; removal is the user's own step. `adoptStore` does remove
 * the store it has just copied and verified — that is what makes adoption a
 * move rather than a duplication — and that is the only deletion in the file.
 */

/** Tables whose row counts must agree before a copy is trusted. */
export const VERIFIED_TABLES = [
  'memory_items',
  'notes',
  'sessions',
  'events',
] as const;

/** Temp files older than this are assumed abandoned and swept. */
const STALE_TEMP_MS = 60 * 60 * 1000;

const TEMP_PREFIX = '.migrating-';

export type MigrationAction =
  | 'none'
  | 'migrated'
  | 'destination-exists'
  | 'deferred-to-adoption'
  | 'failed';

export interface MigrationOutcome {
  action: MigrationAction;
  sourcePath: string | null;
  targetPath: string;
  /** Whether the copy passed integrity, schema-version and row-count checks. */
  verified: boolean;
  /** Set when `action` is `failed`, or when a migration was skipped for cause. */
  reason: string | null;
  /** Always true when a migration ran: AC #3 leaves the original in place. */
  originalRetained: boolean;
}

function countRows(db: Database.Database, table: string): number | null {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM "${table}"`)
      .get() as { c: number } | undefined;
    return row ? row.c : null;
  } catch {
    // A table this build knows about may not exist in an older store.
    return null;
  }
}

function readSchemaVersion(db: Database.Database): string | null {
  try {
    return getMetaValue(db, 'schema_version') ?? null;
  } catch {
    return null;
  }
}

export interface CopyVerification {
  ok: boolean;
  reason: string | null;
}

/**
 * Verify a freshly written copy against its source.
 *
 * Both sides are read through their own connections. The destination is opened
 * fresh rather than reusing the connection that wrote it, because a count taken
 * through the writing connection verifies that connection's view, not the file.
 */
export function verifyStoreCopy(
  sourcePath: string,
  targetPath: string,
): CopyVerification {
  let source: Database.Database | null = null;
  let target: Database.Database | null = null;
  try {
    target = openDatabaseReadOnly(targetPath);
    const integrity = target.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    const verdict = integrity[0]?.integrity_check;
    if (verdict !== 'ok') {
      return { ok: false, reason: `integrity_check returned "${verdict ?? 'nothing'}"` };
    }

    source = openDatabaseReadOnly(sourcePath);
    const sourceVersion = readSchemaVersion(source);
    const targetVersion = readSchemaVersion(target);
    if (sourceVersion !== targetVersion) {
      return {
        ok: false,
        reason: `schema_version differs (source ${sourceVersion ?? 'absent'}, copy ${targetVersion ?? 'absent'})`,
      };
    }

    for (const table of VERIFIED_TABLES) {
      const before = countRows(source, table);
      const after = countRows(target, table);
      if (before !== after) {
        return {
          ok: false,
          reason: `${table} row count differs (source ${before ?? 'absent'}, copy ${after ?? 'absent'})`,
        };
      }
    }

    return { ok: true, reason: null };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      source?.close();
    } catch {
      /* verification must not throw on cleanup */
    }
    try {
      target?.close();
    } catch {
      /* verification must not throw on cleanup */
    }
  }
}

function sweepStaleTempFiles(dir: string, now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) {
      continue;
    }
    const full = path.join(dir, entry);
    try {
      // Absolute difference: a future mtime — clock skew, a restored backup, a
      // network filesystem — would otherwise never be swept, and the same
      // clamp is already applied to the spool check for the same reasons.
      if (Math.abs(now - fs.statSync(full).mtimeMs) > STALE_TEMP_MS) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      /* a temp file we cannot stat or remove is not worth failing over */
    }
  }
}

/**
 * A SQLite file is not enough; it has to be *a Cortex store*.
 *
 * `verifyStoreCopy` compares `schema_version` and four row counts, and every one
 * of those reads returns `null` when the table is absent — so for a source that
 * is some unrelated database, every comparison is `null === null` and the copy
 * verifies vacuously. Measured: an unrelated SQLite file placed at
 * `<project>/.cortex.db` was copied, reported `verified: true`, and installed as
 * the project's store, carrying the user's own table into it.
 */
function looksLikeCortexStore(filePath: string): boolean {
  if (!looksLikeSqlite(filePath)) {
    return false;
  }
  let db: Database.Database | null = null;
  try {
    db = openDatabaseReadOnly(filePath);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'memory_items', 'sessions')",
      )
      .get() as { c: number } | undefined;
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function looksLikeSqlite(filePath: string): boolean {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const read = fs.readSync(handle, header, 0, 16, 0);
    return read === 16 && header.toString('utf8', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface MigrateOptions {
  /** Injected for tests; defaults to `Date.now()`. */
  now?: number;
  /**
   * Injected for tests; defaults to `verifyStoreCopy`.
   *
   * A seam rather than a natural fixture because there is no way to construct a
   * source that `VACUUM INTO` copies successfully and verification then
   * rejects — SQLite either produces a faithful copy or fails outright. Without
   * it, replacing the whole verification call with `{ ok: true }` is a mutation
   * no test can catch: the failure it models is "the verdict is computed and
   * then ignored", which is about wiring, not about any input.
   */
  verify?: (sourcePath: string, targetPath: string) => CopyVerification;
}

/**
 * Migrate a project-root database into the per-project store directory.
 *
 * Idempotent (N-8): once the destination exists this is a no-op, so the second
 * of two concurrent sessions finds the winner's store and uses it. Never throws
 * — an ambient caller runs inside a hook where AD-12 requires silence.
 */
export function migrateLegacyStore(
  identity: StoreIdentity,
  options: MigrateOptions = {},
): MigrationOutcome {
  const targetPath = identity.dbPath;
  const base: MigrationOutcome = {
    action: 'none',
    sourcePath: null,
    targetPath,
    verified: false,
    reason: null,
    originalRetained: true,
  };

  // Declared outside the try so the outer catch can name the file that failed.
  // Spreading `base` there reported `sourcePath: null` for a failure caused by
  // a source it had already found — a failure that never names its own cause.
  let sourcePath: string | undefined;
  let tempPath: string | undefined;

  try {
    if (fs.existsSync(targetPath)) {
      return { ...base, action: 'destination-exists' };
    }

    sourcePath = identity.legacyDbPaths.find(
      candidate => fs.existsSync(candidate) && looksLikeCortexStore(candidate),
    );
    if (sourcePath === undefined) {
      return base;
    }

    fs.mkdirSync(identity.storeDir, { recursive: true });
    sweepStaleTempFiles(identity.storeDir, options.now ?? Date.now());

    tempPath = path.join(
      identity.storeDir,
      `${TEMP_PREFIX}${process.pid}-${Math.floor(Math.random() * 1e9)}.db`,
    );

    let source: Database.Database | null = null;
    try {
      source = openDatabaseReadOnly(sourcePath);
      source.prepare('VACUUM INTO ?').run(tempPath);
    } finally {
      try {
        source?.close();
      } catch {
        /* ignore */
      }
    }

    const verification = (options.verify ?? verifyStoreCopy)(sourcePath, tempPath);
    if (!verification.ok) {
      fs.rmSync(tempPath, { force: true });
      return {
        ...base,
        action: 'failed',
        sourcePath,
        reason: verification.reason,
      };
    }

    // Re-check immediately before the rename: another process may have finished
    // its own migration while this one was copying and verifying.
    if (fs.existsSync(targetPath)) {
      fs.rmSync(tempPath, { force: true });
      return { ...base, action: 'destination-exists', sourcePath };
    }

    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (fs.existsSync(targetPath)) {
        return { ...base, action: 'destination-exists', sourcePath };
      }
      return {
        ...base,
        action: 'failed',
        sourcePath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      action: 'migrated',
      sourcePath,
      targetPath,
      verified: true,
      reason: null,
      originalRetained: true,
    };
  } catch (error) {
    // A throw out of `VACUUM INTO` (corrupt source, disk full, I/O error) left
    // its partial temp file behind, and because the destination is never
    // created the next invocation retries and leaks another one — permanently,
    // since the sweep only collects files older than an hour.
    if (tempPath !== undefined) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* nothing further to do about it */
      }
    }
    return {
      ...base,
      action: 'failed',
      sourcePath: sourcePath ?? null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface AdoptionCandidate {
  storeDir: string;
  dbPath: string;
  /** `meta.root_path` — where this store believes its repository lives. */
  recordedPath: string | null;
  rootCommitOid: string | null;
  sizeBytes: number;
}

/**
 * Stores that look like this repository under a path that no longer exists.
 *
 * AC #4's repair anchor. Only consulted when there is no store at the computed
 * path — a repository that still resolves to its own store is not lost.
 * Detection is ambient and silent; acting on it is `cortex adopt`.
 */
export function findAdoptionCandidates(identity: StoreIdentity): AdoptionCandidate[] {
  // Cheap check first. `readRootCommitOid` spawns git, and this now runs on
  // every resolve — but a project that already has a store is normally not
  // looking for one, and that is the overwhelmingly common case. Resolving the
  // anchor before this test would put a subprocess on the hook path to answer a
  // question `existsSync` already settled, the same inversion
  // `recordStoreIdentityMeta` had.
  //
  // The exception is the whole of AC #4: an ambient start *opens* the store,
  // which creates the file, so "a store exists here" becomes true one hook
  // after the repository moved — and the offer would vanish forever. A store
  // that records a pending adoption keeps being asked.
  try {
    if (fs.existsSync(identity.dbPath) && !hasPendingAdoption(identity.dbPath)) {
      return [];
    }
  } catch {
    return [];
  }

  const anchor = identity.readRootCommitOid();
  if (anchor === null) {
    return [];
  }

  const projectsDir = path.join(identity.home, 'projects');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: AdoptionCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const storeDir = path.join(projectsDir, entry.name);
    if (path.resolve(storeDir) === path.resolve(identity.storeDir)) {
      continue;
    }
    const dbPath = path.join(storeDir, STORE_FILENAME);
    let db: Database.Database | null = null;
    try {
      if (!fs.existsSync(dbPath)) {
        continue;
      }
      db = openDatabaseReadOnly(dbPath);
      const rootCommitOid = getMetaValue(db, 'root_commit_oid') ?? null;
      if (rootCommitOid === null || rootCommitOid !== anchor) {
        continue;
      }
      const recordedPath = getMetaValue(db, 'root_path') ?? null;
      // A store whose recorded path still exists belongs to a live checkout.
      if (recordedPath !== null && fs.existsSync(recordedPath)) {
        continue;
      }
      candidates.push({
        storeDir,
        dbPath,
        recordedPath,
        rootCommitOid,
        sizeBytes: fs.statSync(dbPath).size,
      });
    } catch {
      // An unreadable or corrupt candidate is not a candidate.
      continue;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export interface AdoptionOutcome {
  action: 'adopted' | 'destination-exists' | 'failed';
  candidate: AdoptionCandidate;
  targetPath: string;
  reason: string | null;
}

/**
 * Attach an orphaned store to this repository's computed path.
 *
 * **`VACUUM INTO` and verify, exactly as migration does — never a rename.**
 * `fs.renameSync` moves `cortex.db` alone and leaves `-wal`/`-shm` behind, and a
 * store whose last writer did not close cleanly keeps its rows there. Measured:
 * a store killed mid-write read 50 rows in place and `no such table` after a
 * rename of the main file. That is total, silent loss on the one command whose
 * entire purpose is to rescue memory — and unrecoverable afterwards, because the
 * abandoned directory no longer holds a `cortex.db` for the scan to find.
 *
 * It is still a *move*: the source is removed once the copy is verified, because
 * leaving it would keep it matching as a candidate and `doctor` would go on
 * offering an adoption already performed. Verification is what makes the removal
 * safe, and it precedes it. The sidecars go with it — leaving them orphans a
 * `-wal` next to no database.
 */
export function adoptStore(
  identity: StoreIdentity,
  candidate: AdoptionCandidate,
): AdoptionOutcome {
  const targetPath = identity.dbPath;
  try {
    if (fs.existsSync(targetPath)) {
      // A store an ambient start created only to have something to open is a
      // placeholder, and replacing it is the point. One that has since
      // accumulated real memory is not — adopting over it would destroy work
      // done since the move, so it is refused with an explanation instead.
      const placeholder = describePlaceholder(targetPath);
      if (!placeholder.isPlaceholder) {
        return {
          action: 'destination-exists',
          candidate,
          targetPath,
          reason: placeholder.reason,
        };
      }
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${targetPath}${suffix}`, { force: true });
      }
    }

    fs.mkdirSync(identity.storeDir, { recursive: true });

    let source: Database.Database | null = null;
    try {
      source = openDatabaseReadOnly(candidate.dbPath);
      source.prepare('VACUUM INTO ?').run(targetPath);
    } finally {
      try {
        source?.close();
      } catch {
        /* ignore */
      }
    }

    const verification = verifyStoreCopy(candidate.dbPath, targetPath);
    if (!verification.ok) {
      fs.rmSync(targetPath, { force: true });
      return {
        action: 'failed',
        candidate,
        targetPath,
        reason: verification.reason,
      };
    }

    // The copy is proven good and in place from here on. Nothing below may turn
    // a successful adoption into a reported failure: on win32 a locked source
    // makes removal throw, and the old code let that `EBUSY` escape and print
    // "Could not adopt" over a store that had in fact been adopted.
    recordProjectMeta(targetPath, identity);
    removeAdoptedSource(candidate);

    return { action: 'adopted', candidate, targetPath, reason: null };
  } catch (error) {
    return {
      action: 'failed',
      candidate,
      targetPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Is the store at this path one Cortex created while an adoption was pending,
 * and still empty?
 */
function describePlaceholder(dbPath: string): {
  isPlaceholder: boolean;
  reason: string;
} {
  let db: Database.Database | null = null;
  try {
    db = openDatabaseReadOnly(dbPath);
    if ((getMetaValue(db, ADOPTION_PENDING_KEY) ?? '').length === 0) {
      return {
        isPlaceholder: false,
        reason: 'a store already exists at the computed path',
      };
    }
    if (storeHasAuthoredMemory(db)) {
      return {
        isPlaceholder: false,
        reason:
          'the store here was created while the adoption was pending but has since recorded notes of its own; adopting would discard them. Move it aside first if you want the orphaned store instead.',
      };
    }
    return { isPlaceholder: true, reason: '' };
  } catch {
    return {
      isPlaceholder: false,
      reason: 'a store already exists at the computed path and could not be read',
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove a store that has been copied elsewhere and verified.
 *
 * Best-effort by design: the adoption already succeeded, so a file that cannot
 * be deleted is untidiness, not failure. A source that survives is re-offered as
 * a candidate, which is recoverable; a successful adoption reported as failed is
 * not.
 */
function removeAdoptedSource(candidate: AdoptionCandidate): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${candidate.dbPath}${suffix}`, { force: true });
    } catch {
      /* see above */
    }
  }
  removeDirectoryIfEmpty(candidate.storeDir);
}

function removeDirectoryIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    /* leaving an empty directory behind is harmless */
  }
}

/**
 * Open the adopted store briefly to point its recorded path at this checkout.
 *
 * Without this the store keeps the dead path it was orphaned under, so it would
 * match as an adoption candidate again on the next run.
 */
function recordProjectMeta(dbPath: string, identity: StoreIdentity): void {
  let db: Database.Database | null = null;
  try {
    // A plain writable open: this runs only from the explicit `adopt` command,
    // never from an ambient path.
    db = openDatabase(dbPath);
    setMetaValue(db, 'root_path', identity.projectRoot);
    const rootCommitOid = identity.readRootCommitOid();
    if (rootCommitOid !== null) {
      setMetaValue(db, 'root_commit_oid', rootCommitOid);
    }
    // The adoption has happened; the store must stop advertising itself as
    // awaiting one, or every later scan keeps offering it.
    setMetaValue(db, ADOPTION_PENDING_KEY, '');
  } catch {
    // The move already succeeded; stale meta is a cosmetic follow-up, and the
    // next ambient open repairs it through `recordStoreIdentityMeta`.
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Persist the AD-10 repair anchor and the recorded checkout path.
 *
 * Written on open when absent or stale. `root_path` is deliberately the
 * worktree toplevel rather than the process cwd: it has to stop existing when
 * the repository moves, which is the entire signal AC #4 keys on.
 */
export function recordStoreIdentityMeta(
  db: Database.Database,
  identity: StoreIdentity,
): void {
  try {
    // Read the column before resolving the anchor, never the other way round.
    // `readRootCommitOid` spawns git, and this runs on *every* open — resolving
    // first would put a subprocess on the hook path to learn something already
    // recorded. An empty repository has no HEAD and so keeps retrying; that
    // lasts until its first commit and is not worth a sentinel row.
    if (getMetaValue(db, 'root_commit_oid') === undefined) {
      const rootCommitOid = identity.readRootCommitOid();
      if (rootCommitOid !== null) {
        setMetaValue(db, 'root_commit_oid', rootCommitOid);
      }
    }
    const recorded = getMetaValue(db, 'root_path');
    if (recorded === undefined || !fs.existsSync(recorded)) {
      setMetaValue(db, 'root_path', identity.projectRoot);
    }
  } catch {
    // Meta bookkeeping must never break an open.
  }
}

export interface ResolvedProjectStore {
  identity: StoreIdentity;
  dbPath: string;
  migration: MigrationOutcome;
}

/**
 * Per-process memo, so a command that asks twice pays for git once.
 *
 * Keyed on the home as well as the directory: tests point `CORTEX_HOME` at a
 * fresh temp directory per case, and a key of `startDir` alone would serve the
 * previous test's answer.
 */
const projectStoreCache = new Map<string, ResolvedProjectStore>();

/** Drop the memo. Tests that change `CORTEX_HOME` or the filesystem need this. */
export function clearProjectStoreCache(): void {
  projectStoreCache.clear();
}

/**
 * The single entry point every transport uses to find its database.
 *
 * Four scattered derivations is how three of them drift; this replaces all of
 * them. Resolution, directory creation and one-time migration happen here so a
 * caller only has to `openDatabase(dbPath)`.
 */
export function resolveProjectStore(
  startDir: string,
  options: ResolveStoreIdentityOptions = {},
): ResolvedProjectStore {
  const env = options.env ?? process.env;
  // An injected `runGit` bypasses the memo entirely rather than being folded
  // into the key: it is a test seam, functions have no value identity, and a
  // cached answer made the second injection silently inert — two callers for
  // one directory got the same object even when the second described a
  // different repository.
  const cacheable = options.runGit === undefined;
  const cacheKey = JSON.stringify([path.resolve(startDir), env['CORTEX_HOME'] ?? '']);
  const cached = cacheable ? projectStoreCache.get(cacheKey) : undefined;
  if (cached !== undefined) {
    return cached;
  }

  const identity = resolveStoreIdentity(startDir, options);

  // **Adoption outranks migration**, and the order is the whole correctness of
  // AC #4. AC #3 keeps the project-root original forever, so it travels with a
  // repository that is moved or renamed — and migrating that stale snapshot
  // creates a store at the computed path, which permanently suppresses the
  // offer of the real one. Measured before this guard: a 22-note store orphaned
  // and a 2-note snapshot installed in its place by one SessionStart hook.
  const migration = findAdoptionCandidates(identity).length > 0
    ? {
        action: 'deferred-to-adoption' as const,
        sourcePath: null,
        targetPath: identity.dbPath,
        verified: false,
        reason:
          'an orphaned store matching this repository is available for adoption; run `cortex adopt`',
        originalRetained: true,
      }
    : migrateLegacyStore(identity);

  try {
    fs.mkdirSync(identity.storeDir, { recursive: true });
  } catch {
    // Leave it to `openDatabase` to fail loudly if the directory is unusable.
  }

  const resolved: ResolvedProjectStore = {
    identity,
    dbPath: identity.dbPath,
    migration,
  };
  if (cacheable) {
    projectStoreCache.set(cacheKey, resolved);
  }
  return resolved;
}

export interface OpenedProjectStore extends ResolvedProjectStore {
  db: Database.Database;
}

/**
 * Resolve, migrate, open, and record the repair anchor — in that order.
 *
 * The four steps belong together because the third and fourth are only correct
 * as a pair: a store opened without `recordStoreIdentityMeta` never gets a
 * `root_commit_oid`, and AC #4's adoption matches on exactly that column. So a
 * caller that resolves and opens by hand produces a working store that can
 * never be recovered after a move — a failure invisible until the day it
 * matters. Leaving that to three transports to each remember is the same shape
 * as the scattered path derivations this story replaced.
 */
export function openProjectStore(
  startDir: string,
  options: ResolveStoreIdentityOptions = {},
): OpenedProjectStore {
  const resolved = resolveProjectStore(startDir, options);
  const db = openDatabase(resolved.dbPath);
  openStores.add(db);
  ensureCortexSchema(db, resolved.identity.projectRoot);
  recordStoreIdentityMeta(db, resolved.identity);
  recordMigrationOutcome(db, resolved.migration);
  try {
    // Opening created this file; without the marker its mere existence would
    // answer "does this project have a store?" with yes and retire the offer.
    if (resolved.migration.action === 'deferred-to-adoption') {
      setMetaValue(db, ADOPTION_PENDING_KEY, resolved.migration.reason ?? 'pending');
    }
  } catch {
    /* bookkeeping must never break an open */
  }
  return { ...resolved, db };
}

/**
 * Close a project store, checkpointing first (FR-25 AC #1).
 *
 * `db.close()` already checkpoints — measured, a 4,128,272-byte WAL becomes 0
 * and the sidecar is removed — so the value here is not the checkpoint but the
 * fact that **it is called at all**. Before this, no ambient transport closed
 * the store: `cli.ts` closed only in its two `gc` paths, and `mcp.ts` and
 * `hook-entry.ts` never did. The process exited and the OS tore the handle
 * down, which is not a checkpoint and leaves the sidecar on disk.
 *
 * The explicit `TRUNCATE` before closing is belt-and-braces and makes the
 * intent testable: the checkpoint result is observable, `close()`'s implicit
 * one is not. Idempotent and never throws — this runs on exit paths where a
 * failure has nothing left to report to.
 */
/**
 * Handles `openProjectStore` has handed out and that nothing has closed.
 *
 * A registry rather than three transports each remembering to hold onto their
 * database: `openCortexDb` returns a `CortexStore`, so the raw handle is not
 * even in the caller's hands at the point the process is ending.
 */
const openStores = new Set<Database.Database>();

/**
 * Close every store this process opened, checkpointing each (FR-25 AC #1).
 *
 * Wired to process exit in the CLI and hook transports, whose lifetime *is* the
 * command, and called on shutdown by the MCP server. Closing after each
 * individual command instead would break the in-process test suite, where one
 * vitest process runs many commands and win32 refuses to remove a file whose
 * handle is still open — the hazard story 2.5 hit and had to split a test for.
 */
export function closeAllProjectStores(): WalCheckpointResult[] {
  const results: WalCheckpointResult[] = [];
  for (const db of openStores) {
    const result = closeProjectStore(db);
    if (result !== null) {
      results.push(result);
    }
  }
  openStores.clear();
  return results;
}

/** Register the process-exit close exactly once per process. */
let exitHookInstalled = false;
export function installStoreCloseOnExit(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  const closeQuietly = (): void => {
    try {
      closeAllProjectStores();
    } catch {
      /* nothing left to report to */
    }
  };
  // `exit` only: better-sqlite3 is synchronous, so a checkpoint and close both
  // complete inside the handler. An async teardown could not.
  process.on('exit', closeQuietly);
  // `exit` alone is not enough on POSIX, and this is measured rather than
  // inferred. A signal with no JS listener leaves the kernel's default
  // disposition in place, so the process is torn down without Node emitting
  // `exit` at all: on linux/node 20 a SIGTERM'd MCP server left its entire
  // 78,312-byte WAL sidecar on disk, skipping the checkpoint FR-25 AC #1
  // promises on the ordinary path a host uses to end a session. Installing a
  // listener is what turns the signal into a real `process.exit()`, which does
  // emit `exit`; the close is repeated here so the signal path does not depend
  // on that. `128 + signo` is the wait status a POSIX shell reports.
  //
  // These are inert on win32 by design rather than skipped: `kill()` there is
  // `TerminateProcess`, the hard-kill analogue of SIGKILL, which runs no
  // handler of any kind. Windows' graceful stop is the host closing stdin,
  // which drains the loop into the `exit` listener above (verified).
  //
  // Registering a signal listener does not hold the event loop open, because
  // Node unrefs the handle, so a one-shot CLI or hook process still exits the
  // moment its work is done.
  const closeAndExit = (code: number) => (): void => {
    closeQuietly();
    process.exit(code);
  };
  process.on('SIGTERM', closeAndExit(128 + 15));
  process.on('SIGINT', closeAndExit(128 + 2));
  process.on('SIGHUP', closeAndExit(128 + 1));
}

export function closeProjectStore(db: Database.Database): WalCheckpointResult | null {
  openStores.delete(db);
  let result: WalCheckpointResult | null = null;
  try {
    if (db.open) {
      result = checkpointWal(db);
    }
  } catch {
    /* a checkpoint that cannot run must not prevent the close */
  }
  try {
    if (db.open) {
      db.close();
    }
  } catch {
    /* already closed, or closing under a lock; nothing further to do */
  }
  return result;
}

/** Meta keys carrying what happened to the migration, for `doctor` to read. */
export const MIGRATED_FROM_KEY = 'migrated_from';
export const MIGRATION_FAILED_KEY = 'migration_failed';

/**
 * Marks a store Cortex created only because it had to open *something*, while
 * an orphaned store matching this repository was waiting to be adopted.
 */
export const ADOPTION_PENDING_KEY = 'adoption_pending';

/** Does this store record that an adoption is still outstanding? */
export function hasPendingAdoption(dbPath: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = openDatabaseReadOnly(dbPath);
    return (getMetaValue(db, ADOPTION_PENDING_KEY) ?? '').length > 0;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Has the user written anything into this store?
 *
 * **Notes only, deliberately.** Any ambient start creates a session and a
 * branch snapshot, and the snapshot is projected into `memory_items` — so a
 * store that has merely been *opened* is never empty by those measures, and
 * testing them would refuse every adoption the moment a single hook fired.
 * Notes are the user-authored half; losing a session row recorded in a project
 * whose real memory was missing is a fair trade for recovering that memory,
 * and losing a note is not.
 */
function storeHasAuthoredMemory(db: Database.Database): boolean {
  const notes = countRows(db, 'notes');
  return notes !== null && notes > 0;
}

/**
 * Persist the migration verdict, because otherwise nothing ever reads it.
 *
 * `MigrationOutcome` was computed and discarded by every caller, so a migration
 * that failed produced a silent, permanently empty store: the destination now
 * exists, so the next run short-circuits to `destination-exists` and never
 * retries. Worse, `doctor` inferred "migrated" from the mere coexistence of a
 * legacy file and a store, and then told the user to delete the original — the
 * only surviving copy of their memory.
 *
 * Recording it makes the diagnosis evidence-based rather than inferred.
 */
function recordMigrationOutcome(
  db: Database.Database,
  migration: MigrationOutcome,
): void {
  try {
    if (migration.action === 'migrated' && migration.sourcePath !== null) {
      setMetaValue(db, MIGRATED_FROM_KEY, migration.sourcePath);
      setMetaValue(db, MIGRATION_FAILED_KEY, '');
      return;
    }
    if (migration.action === 'failed') {
      setMetaValue(
        db,
        MIGRATION_FAILED_KEY,
        `${migration.sourcePath ?? 'unknown source'}: ${migration.reason ?? 'unknown reason'}`,
      );
    }
  } catch {
    // Bookkeeping must never break an open.
  }
}
