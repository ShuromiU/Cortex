import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  openDatabase,
  applySchema,
  initializeMeta,
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
});
