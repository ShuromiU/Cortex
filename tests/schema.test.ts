import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  openDatabase,
  applySchema,
  initializeMeta,
  ensureCortexSchema,
  getSchemaVersion,
  SCHEMA_VERSION,
} from '../src/db/schema.js';

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `cortex-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* ignore */
    }
  }
}

describe('Schema', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDb();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it('creates database with WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign keys', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('sets busy_timeout', () => {
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
  });

  it('applies schema without errors', () => {
    expect(() => applySchema(db)).not.toThrow();
  });

  it('creates all expected tables', () => {
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('meta');
    expect(names).toContain('sessions');
    expect(names).toContain('events');
    expect(names).toContain('notes');
    expect(names).toContain('state');
    expect(names).toContain('token_ledger');
    expect(names).toContain('command_runs');
    expect(names).toContain('episodes');
    expect(names).toContain('branch_snapshots');
    expect(names).toContain('project_snapshots');
    expect(names).toContain('memory_items');
    expect(names).toContain('memory_items_fts');
    expect(names).toContain('retrieval_log');
  });

  it('creates all expected indexes', () => {
    applySchema(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);

    expect(names).toContain('idx_events_session');
    expect(names).toContain('idx_events_type');
    expect(names).toContain('idx_events_timestamp');
    expect(names).toContain('idx_notes_session');
    expect(names).toContain('idx_notes_kind_subject');
    expect(names).toContain('idx_notes_status');
    expect(names).toContain('idx_state_session');
    expect(names).toContain('idx_state_layer');
    expect(names).toContain('idx_ledger_session');
    expect(names).toContain('idx_sessions_parent');
    expect(names).toContain('idx_sessions_status');
    expect(names).toContain('idx_sessions_scope');
    expect(names).toContain('idx_command_runs_session');
    expect(names).toContain('idx_command_runs_event');
    expect(names).toContain('idx_episodes_session');
    expect(names).toContain('idx_memory_items_scope');
    expect(names).toContain('idx_memory_items_kind');
    expect(names).toContain('idx_memory_items_source');
    expect(names).toContain('idx_retrieval_log_session');
  });

  it('is idempotent — applying schema twice is fine', () => {
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it('initializes meta with correct values', () => {
    applySchema(db);
    initializeMeta(db, '/test/root');

    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));

    const rootRow = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('root_path') as { value: string } | undefined;
    expect(rootRow?.value).toBe('/test/root');

    const createdRow = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('created_at') as { value: string } | undefined;
    expect(createdRow?.value).toBeTruthy();
  });

  it('initializeMeta stores a valid ISO timestamp in created_at', () => {
    applySchema(db);
    initializeMeta(db, '/test/root');

    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('created_at') as { value: string } | undefined;
    const ts = new Date(row!.value);
    expect(ts.getTime()).not.toBeNaN();
  });

  it('migrates a legacy v1 database to v2 and backfills retrieval tables', () => {
    db.exec(`
      DROP TABLE IF EXISTS retrieval_log;
      DROP TABLE IF EXISTS memory_items;
      DROP TABLE IF EXISTS project_snapshots;
      DROP TABLE IF EXISTS branch_snapshots;
      DROP TABLE IF EXISTS episodes;
      DROP TABLE IF EXISTS command_runs;
      DROP TABLE IF EXISTS token_ledger;
      DROP TABLE IF EXISTS state;
      DROP TABLE IF EXISTS notes;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS meta;

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id                TEXT PRIMARY KEY,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        focus             TEXT,
        agent_type        TEXT NOT NULL DEFAULT 'primary',
        status            TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        timestamp     TEXT NOT NULL,
        type          TEXT NOT NULL,
        target        TEXT,
        metadata_json TEXT
      );

      CREATE TABLE notes (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        timestamp    TEXT NOT NULL,
        kind         TEXT NOT NULL,
        subject      TEXT,
        content      TEXT NOT NULL,
        alternatives TEXT,
        status       TEXT NOT NULL DEFAULT 'active',
        conflict     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE state (
        id         TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        layer      TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE token_ledger (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        direction  TEXT NOT NULL,
        tokens     INTEGER NOT NULL,
        timestamp  TEXT NOT NULL
      );
    `);

    const sessionId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const sessionStateId = crypto.randomUUID();
    const projectStateId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('root_path', '/legacy/root');
    db.prepare(
      `INSERT INTO sessions (id, parent_session_id, started_at, ended_at, focus, agent_type, status)
       VALUES (?, NULL, ?, ?, ?, 'primary', 'ended')`,
    ).run(sessionId, now, now, 'legacy-focus');
    db.prepare(
      `INSERT INTO notes (id, session_id, timestamp, kind, subject, content, alternatives, status, conflict)
       VALUES (?, ?, ?, 'decision', 'auth', 'Use JWT', '["sessions"]', 'active', 0)`,
    ).run(noteId, sessionId, now);
    db.prepare(
      `INSERT INTO events (id, session_id, timestamp, type, target, metadata_json)
       VALUES (?, ?, ?, 'cmd', NULL, ?)`,
    ).run(
      eventId,
      sessionId,
      now,
      JSON.stringify({
        category: 'test',
        safe_summary: 'vitest run auth',
        exit_code: 1,
        files_touched: ['src/auth.ts'],
      }),
    );
    db.prepare(
      `INSERT INTO state (id, session_id, layer, content, created_at)
       VALUES (?, ?, 'session', ?, ?)`,
    ).run(sessionStateId, sessionId, 'Worked on auth middleware', now);
    db.prepare(
      `INSERT INTO state (id, session_id, layer, content, created_at)
       VALUES (?, NULL, 'project', ?, ?)`,
    ).run(projectStateId, 'Project summary', now);

    const result = ensureCortexSchema(db, '/legacy/root');
    expect(result.migrated).toBe(true);
    expect(getSchemaVersion(db)).toBe(2);

    const sessionColumns = db
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    const columnNames = sessionColumns.map(column => column.name);
    expect(columnNames).toContain('scope_type');
    expect(columnNames).toContain('scope_key');
    expect(columnNames).toContain('worktree_path');

    const counts = {
      commandRuns: (db.prepare('SELECT COUNT(*) as count FROM command_runs').get() as { count: number }).count,
      episodes: (db.prepare('SELECT COUNT(*) as count FROM episodes').get() as { count: number }).count,
      projectSnapshots: (db.prepare('SELECT COUNT(*) as count FROM project_snapshots').get() as { count: number }).count,
      memoryItems: (db.prepare('SELECT COUNT(*) as count FROM memory_items').get() as { count: number }).count,
    };
    expect(counts.commandRuns).toBe(1);
    expect(counts.episodes).toBe(1);
    expect(counts.projectSnapshots).toBe(1);
    expect(counts.memoryItems).toBeGreaterThanOrEqual(4);

    const commandRun = db
      .prepare('SELECT command_summary, exit_code FROM command_runs WHERE id = ?')
      .get(eventId) as { command_summary: string; exit_code: number } | undefined;
    expect(commandRun).toBeDefined();
    expect(commandRun!.command_summary).toBe('vitest run auth');
    expect(commandRun!.exit_code).toBe(1);

    const memoryItem = db
      .prepare('SELECT kind, text, state FROM memory_items WHERE source_table = ? AND source_id = ?')
      .get('notes', noteId) as { kind: string; text: string; state: string } | undefined;
    expect(memoryItem).toBeDefined();
    expect(memoryItem!.kind).toBe('note:decision');
    expect(memoryItem!.text).toContain('Use JWT');
    expect(memoryItem!.state).toBe('warm');

    const ftsHits = db
      .prepare(
        `SELECT COUNT(*) as count
         FROM memory_items_fts
         WHERE memory_items_fts MATCH 'jwt*'`,
      )
      .get() as { count: number };
    expect(ftsHits.count).toBeGreaterThan(0);
  });
});
