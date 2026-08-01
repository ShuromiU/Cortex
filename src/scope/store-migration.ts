import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import {
  ensureCortexSchema,
  getMetaValue,
  openDatabase,
  openDatabaseReadOnly,
  setMetaValue,
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
 * original to survive "until the user confirms removal", so this module has no
 * delete path at all; removal is a separate explicit command.
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
      if (now - fs.statSync(full).mtimeMs > STALE_TEMP_MS) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      /* a temp file we cannot stat or remove is not worth failing over */
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

  try {
    if (fs.existsSync(targetPath)) {
      return { ...base, action: 'destination-exists' };
    }

    const sourcePath = identity.legacyDbPaths.find(
      candidate => fs.existsSync(candidate) && looksLikeSqlite(candidate),
    );
    if (sourcePath === undefined) {
      return base;
    }

    fs.mkdirSync(identity.storeDir, { recursive: true });
    sweepStaleTempFiles(identity.storeDir, options.now ?? Date.now());

    const tempPath = path.join(
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
    return {
      ...base,
      action: 'failed',
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
  const anchor = identity.readRootCommitOid();
  if (anchor === null) {
    return [];
  }
  try {
    if (fs.existsSync(identity.dbPath)) {
      return [];
    }
  } catch {
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
 * A move, not a copy: leaving the source in place would keep it matching as a
 * candidate forever, so `doctor` would offer an adoption the user already
 * performed. The recorded path is rewritten so the store stops looking orphaned.
 */
export function adoptStore(
  identity: StoreIdentity,
  candidate: AdoptionCandidate,
): AdoptionOutcome {
  const targetPath = identity.dbPath;
  try {
    if (fs.existsSync(targetPath)) {
      return {
        action: 'destination-exists',
        candidate,
        targetPath,
        reason: 'a store already exists at the computed path',
      };
    }

    fs.mkdirSync(identity.storeDir, { recursive: true });

    try {
      fs.renameSync(candidate.dbPath, targetPath);
    } catch {
      // Different volume, or a lock: fall back to a verified copy and remove
      // the source only once the copy is proven good.
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
      fs.rmSync(candidate.dbPath, { force: true });
    }

    recordProjectMeta(targetPath, identity);
    removeDirectoryIfEmpty(candidate.storeDir);

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
 * Four copies of `findDbPath` is how three of them drift; this replaces all of
 * them. Resolution, directory creation and one-time migration happen here so a
 * caller only has to `openDatabase(dbPath)`.
 */
export function resolveProjectStore(
  startDir: string,
  options: ResolveStoreIdentityOptions = {},
): ResolvedProjectStore {
  const env = options.env ?? process.env;
  const cacheKey = JSON.stringify([path.resolve(startDir), env['CORTEX_HOME'] ?? '']);
  const cached = projectStoreCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const identity = resolveStoreIdentity(startDir, options);
  const migration = migrateLegacyStore(identity);
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
  projectStoreCache.set(cacheKey, resolved);
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
 * as the four `findDbPath` copies this story deleted.
 */
export function openProjectStore(
  startDir: string,
  options: ResolveStoreIdentityOptions = {},
): OpenedProjectStore {
  const resolved = resolveProjectStore(startDir, options);
  const db = openDatabase(resolved.dbPath);
  ensureCortexSchema(db, resolved.identity.projectRoot);
  recordStoreIdentityMeta(db, resolved.identity);
  return { ...resolved, db };
}
