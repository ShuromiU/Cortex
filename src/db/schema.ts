import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  focus             TEXT,
  agent_type        TEXT NOT NULL DEFAULT 'primary',
  status            TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timestamp     TEXT NOT NULL,
  type          TEXT NOT NULL,
  target        TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS notes (
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

CREATE TABLE IF NOT EXISTS state (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  layer      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  direction  TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  timestamp  TEXT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_notes_session    ON notes(session_id);
CREATE INDEX IF NOT EXISTS idx_notes_kind_subject ON notes(kind, subject);
CREATE INDEX IF NOT EXISTS idx_notes_status     ON notes(status);
CREATE INDEX IF NOT EXISTS idx_state_session    ON state(session_id);
CREATE INDEX IF NOT EXISTS idx_state_layer      ON state(layer);
CREATE INDEX IF NOT EXISTS idx_ledger_session   ON token_ledger(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent  ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
`;

/**
 * Open (or create) the SQLite database with WAL mode, foreign keys, and busy timeout.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  return db;
}

/**
 * Apply schema tables and indexes. Idempotent (IF NOT EXISTS).
 */
export function applySchema(db: Database.Database): void {
  db.exec(TABLES);
  db.exec(INDEXES);
}

/**
 * Initialize meta keys for a fresh database.
 */
export function initializeMeta(db: Database.Database, rootPath: string): void {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  );

  const initTransaction = db.transaction(() => {
    upsert.run('schema_version', String(SCHEMA_VERSION));
    upsert.run('root_path', rootPath);
    upsert.run('created_at', new Date().toISOString());
  });

  initTransaction();
}
