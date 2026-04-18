import Database from 'better-sqlite3';
import { deriveProjectScopeKey } from '../scope/keys.js';
import {
  buildCommandMemoryText as buildCommandMemoryTextValue,
  buildNoteMemoryText,
  noteImportance,
  memoryStateForNote,
} from '../memory/items.js';

export const SCHEMA_VERSION = 2;

const CORE_TABLES = `
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
  status            TEXT NOT NULL DEFAULT 'active',
  git_root          TEXT,
  worktree_path     TEXT,
  branch_ref        TEXT,
  head_oid          TEXT,
  scope_type        TEXT NOT NULL DEFAULT 'project',
  scope_key         TEXT
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

const V2_TABLES = `
CREATE TABLE IF NOT EXISTS command_runs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id          TEXT REFERENCES events(id) ON DELETE SET NULL,
  timestamp         TEXT NOT NULL,
  category          TEXT,
  command_summary   TEXT,
  exit_code         INTEGER,
  stdout_tail       TEXT,
  stderr_tail       TEXT,
  files_touched_json TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  target          TEXT,
  metadata_json   TEXT,
  source_state_id TEXT REFERENCES state(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_snapshots (
  id                TEXT PRIMARY KEY,
  scope_key         TEXT NOT NULL UNIQUE,
  git_root          TEXT,
  worktree_path     TEXT,
  branch_ref        TEXT,
  head_oid          TEXT,
  focus             TEXT,
  summary           TEXT NOT NULL,
  recent_files_json TEXT,
  intents_json      TEXT,
  blockers_json     TEXT,
  last_session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_snapshots (
  id          TEXT PRIMARY KEY,
  git_root    TEXT,
  scope_key   TEXT NOT NULL UNIQUE,
  summary     TEXT NOT NULL,
  note_digest TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  scope_type      TEXT NOT NULL,
  scope_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  source_table    TEXT,
  source_id       TEXT,
  subject         TEXT,
  text            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'warm',
  importance      REAL NOT NULL DEFAULT 0,
  access_count    INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id               TEXT PRIMARY KEY,
  session_id       TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  topic            TEXT NOT NULL,
  query_text       TEXT,
  result_ids_json  TEXT,
  total_candidates INTEGER NOT NULL DEFAULT 0,
  returned_count   INTEGER NOT NULL DEFAULT 0,
  token_estimate   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
`;

const V2_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
USING fts5(
  subject,
  text,
  tokenize = 'porter unicode61'
);

DROP TRIGGER IF EXISTS trg_memory_items_ai;
DROP TRIGGER IF EXISTS trg_memory_items_ad;
DROP TRIGGER IF EXISTS trg_memory_items_au;

CREATE TRIGGER trg_memory_items_ai
AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_items_fts (rowid, subject, text)
  VALUES (new.rowid, COALESCE(new.subject, ''), new.text);
END;

CREATE TRIGGER trg_memory_items_ad
AFTER DELETE ON memory_items BEGIN
  DELETE FROM memory_items_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER trg_memory_items_au
AFTER UPDATE ON memory_items BEGIN
  DELETE FROM memory_items_fts WHERE rowid = old.rowid;
  INSERT INTO memory_items_fts (rowid, subject, text)
  VALUES (new.rowid, COALESCE(new.subject, ''), new.text);
END;
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
CREATE INDEX IF NOT EXISTS idx_sessions_scope   ON sessions(scope_key, status, started_at);
CREATE INDEX IF NOT EXISTS idx_command_runs_session ON command_runs(session_id, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_command_runs_event ON command_runs(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope_key, state, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_items_kind ON memory_items(kind, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_source ON memory_items(source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retrieval_log_session ON retrieval_log(session_id, created_at);
`;

interface MetaRow {
  value: string;
}

interface LegacyCommandEventRow {
  id: string;
  session_id: string;
  timestamp: string;
  metadata_json: string | null;
}

interface LegacyNoteRow {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  subject: string | null;
  content: string;
  alternatives: string | null;
  status: string;
}

interface LegacyStateRow {
  id: string;
  session_id: string | null;
  layer: string;
  content: string;
  created_at: string;
}

interface SessionScopeRow {
  id: string;
  scope_type: string | null;
  scope_key: string | null;
}

interface CommandRunRow {
  id: string;
  session_id: string;
  timestamp: string;
  category: string | null;
  command_summary: string | null;
  exit_code: number | null;
  files_touched_json: string | null;
}

interface EpisodeRow {
  id: string;
  session_id: string | null;
  kind: string;
  summary: string;
  created_at: string;
}

interface ProjectSnapshotRow {
  id: string;
  scope_key: string;
  summary: string;
  updated_at: string;
}

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
 * Apply latest tables and indexes. Idempotent (IF NOT EXISTS).
 * For existing databases, use ensureCortexSchema() to run migrations as well.
 */
export function applySchema(db: Database.Database): void {
  db.exec(CORE_TABLES);
  db.exec(V2_TABLES);
  db.exec(V2_FTS);
  ensureSessionScopeColumns(db);
  db.exec(INDEXES);
}

/**
 * Initialize meta keys for a fresh database.
 */
export function initializeMeta(
  db: Database.Database,
  rootPath: string,
  schemaVersion: number = SCHEMA_VERSION,
): void {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  );

  const initTransaction = db.transaction(() => {
    upsert.run('schema_version', String(schemaVersion));
    upsert.run('root_path', rootPath);
    upsert.run('created_at', new Date().toISOString());
  });

  initTransaction();
}

export function getSchemaVersion(db: Database.Database): number {
  if (!tableExists(db, 'meta')) {
    return 0;
  }

  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('schema_version') as MetaRow | undefined;

  if (!row) {
    return 0;
  }

  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface EnsureSchemaResult {
  previousVersion: number;
  currentVersion: number;
  migrated: boolean;
  fresh: boolean;
}

export function ensureCortexSchema(
  db: Database.Database,
  rootPath: string,
): EnsureSchemaResult {
  applySchema(db);

  const previousVersion = getSchemaVersion(db);
  const hadLegacyData = previousVersion === 0 && legacyDatabaseHasData(db);
  const fresh = previousVersion === 0 && !hadLegacyData;

  if (previousVersion === 0) {
    initializeMeta(db, rootPath, hadLegacyData ? 1 : SCHEMA_VERSION);
  } else if (!getMetaValue(db, 'root_path')) {
    setMetaValue(db, 'root_path', rootPath);
  }

  let currentVersion = hadLegacyData ? 1 : previousVersion;
  if (currentVersion === 0) {
    currentVersion = SCHEMA_VERSION;
  }

  if (currentVersion < 2) {
    migrateV1ToV2(db, rootPath);
    currentVersion = 2;
  }

  backfillV2Artifacts(db, rootPath);

  if (currentVersion !== SCHEMA_VERSION) {
    setMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
    currentVersion = SCHEMA_VERSION;
  }

  return {
    previousVersion,
    currentVersion,
    migrated: hadLegacyData || (previousVersion > 0 && currentVersion !== previousVersion),
    fresh,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 as present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { present: number } | undefined;
  return row !== undefined;
}

function columnExists(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (columnExists(db, tableName, columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function ensureSessionScopeColumns(db: Database.Database): void {
  ensureColumn(db, 'sessions', 'git_root', 'git_root TEXT');
  ensureColumn(db, 'sessions', 'worktree_path', 'worktree_path TEXT');
  ensureColumn(db, 'sessions', 'branch_ref', 'branch_ref TEXT');
  ensureColumn(db, 'sessions', 'head_oid', 'head_oid TEXT');
  ensureColumn(
    db,
    'sessions',
    'scope_type',
    "scope_type TEXT NOT NULL DEFAULT 'project'",
  );
  ensureColumn(db, 'sessions', 'scope_key', 'scope_key TEXT');
}

function legacyDatabaseHasData(db: Database.Database): boolean {
  const tables = ['sessions', 'events', 'notes', 'state', 'token_ledger'];
  for (const tableName of tables) {
    if (!tableExists(db, tableName)) {
      continue;
    }

    const row = db
      .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
      .get() as { count: number };
    if (row.count > 0) {
      return true;
    }
  }

  return false;
}

function getMetaValue(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, 'meta')) {
    return undefined;
  }

  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as MetaRow | undefined;
  return row?.value;
}

function setMetaValue(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(key, value);
}

function migrateV1ToV2(db: Database.Database, rootPath: string): void {
  backfillSessionScopes(db, rootPath);
  backfillV2Artifacts(db, rootPath);
  setMetaValue(db, 'schema_version', '2');
  setMetaValue(db, 'migrated_to_v2_at', new Date().toISOString());
}

function backfillV2Artifacts(db: Database.Database, rootPath: string): void {
  backfillSessionScopes(db, rootPath);
  backfillCommandRuns(db);
  backfillEpisodes(db);
  backfillProjectSnapshots(db, rootPath);
  backfillMemoryItems(db, rootPath);
  ensureMemoryItemsFts(db);
}

function backfillSessionScopes(db: Database.Database, rootPath: string): void {
  const projectScopeKey = deriveProjectScopeKey(rootPath);
  db.prepare(
    `UPDATE sessions
     SET worktree_path = COALESCE(worktree_path, ?),
         scope_type = COALESCE(scope_type, 'project'),
         scope_key = COALESCE(scope_key, ?)
     WHERE worktree_path IS NULL OR scope_type IS NULL OR scope_key IS NULL`,
  ).run(rootPath, projectScopeKey);
}

function parseJsonObject(
  raw: string | null,
): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function backfillCommandRuns(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, timestamp, metadata_json
       FROM events
       WHERE type = 'cmd'
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all() as LegacyCommandEventRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO command_runs
     (id, session_id, event_id, timestamp, category, command_summary, exit_code, stdout_tail, stderr_tail, files_touched_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata_json);
      const category =
        typeof metadata['category'] === 'string' ? metadata['category'] : null;
      const commandSummary =
        typeof metadata['safe_summary'] === 'string'
          ? metadata['safe_summary']
          : null;
      const exitCode =
        typeof metadata['exit_code'] === 'number'
          ? metadata['exit_code']
          : null;
      const filesTouched = Array.isArray(metadata['files_touched'])
        ? (metadata['files_touched'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];

      insert.run(
        row.id,
        row.session_id,
        row.id,
        row.timestamp,
        category,
        commandSummary,
        exitCode,
        filesTouched.length > 0 ? JSON.stringify(filesTouched) : null,
      );
    }
  });

  tx();
}

function backfillEpisodes(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, layer, content, created_at
       FROM state
       WHERE layer = 'session'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as LegacyStateRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO episodes
     (id, session_id, kind, summary, target, metadata_json, source_state_id, created_at)
     VALUES (?, ?, 'session_summary', ?, NULL, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.session_id,
        row.content,
        JSON.stringify({ migrated_from: 'state', layer: row.layer }),
        row.id,
        row.created_at,
      );
    }
  });

  tx();
}

function backfillProjectSnapshots(
  db: Database.Database,
  rootPath: string,
): void {
  const rows = db
    .prepare(
      `SELECT id, session_id, layer, content, created_at
       FROM state
       WHERE layer = 'project' AND session_id IS NULL
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as LegacyStateRow[];

  if (rows.length === 0) {
    return;
  }

  const scopeKey = deriveProjectScopeKey(rootPath);
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO project_snapshots (id, git_root, scope_key, summary, note_digest, updated_at)
     VALUES (?, NULL, ?, ?, NULL, ?)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      upsert.run(row.id, scopeKey, row.content, row.created_at);
    }
  });

  tx();
}

function buildCommandMemoryText(row: CommandRunRow): string {
  return buildCommandMemoryTextValue({
    id: row.id,
    session_id: row.session_id,
    event_id: null,
    timestamp: row.timestamp,
    category: row.category,
    command_summary: row.command_summary,
    exit_code: row.exit_code,
    stdout_tail: null,
    stderr_tail: null,
    files_touched: parseJsonStringArray(row.files_touched_json),
  });
}

function backfillMemoryItems(db: Database.Database, rootPath: string): void {
  const defaultScopeKey = deriveProjectScopeKey(rootPath);

  const sessionScopes = db
    .prepare('SELECT id, scope_type, scope_key FROM sessions')
    .all() as SessionScopeRow[];
  const scopeBySession = new Map<
    string,
    { scopeType: string; scopeKey: string }
  >();
  for (const session of sessionScopes) {
    scopeBySession.set(session.id, {
      scopeType: session.scope_type ?? 'project',
      scopeKey: session.scope_key ?? defaultScopeKey,
    });
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_items
     (id, session_id, scope_type, scope_key, kind, source_table, source_id, subject, text, state, importance, access_count, last_accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  );

  const noteRows = db
    .prepare(
      `SELECT id, session_id, timestamp, kind, subject, content, alternatives, status
       FROM notes
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all() as LegacyNoteRow[];
  const episodeRows = db
    .prepare(
      `SELECT id, session_id, kind, summary, created_at
       FROM episodes
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as EpisodeRow[];
  const projectSnapshots = db
    .prepare(
      `SELECT id, scope_key, summary, updated_at
       FROM project_snapshots
       ORDER BY updated_at ASC, rowid ASC`,
    )
    .all() as ProjectSnapshotRow[];
  const commandRuns = db
    .prepare(
      `SELECT id, session_id, timestamp, category, command_summary, exit_code, files_touched_json
       FROM command_runs
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all() as CommandRunRow[];

  const tx = db.transaction(() => {
    for (const note of noteRows) {
      const scope = scopeBySession.get(note.session_id) ?? {
        scopeType: 'project',
        scopeKey: defaultScopeKey,
      };
      const parsedNote = {
        id: note.id,
        session_id: note.session_id,
        timestamp: note.timestamp,
        kind: note.kind,
        subject: note.subject,
        content: note.content,
        alternatives: parseJsonStringArray(note.alternatives),
        status: note.status,
        conflict: false,
      };
      insert.run(
        `notes:${note.id}`,
        note.session_id,
        scope.scopeType,
        scope.scopeKey,
        `note:${note.kind}`,
        'notes',
        note.id,
        note.subject,
        buildNoteMemoryText(parsedNote),
        memoryStateForNote(note.kind, note.status),
        noteImportance(note.kind),
        note.timestamp,
      );
    }

    for (const episode of episodeRows) {
      const scope = episode.session_id
        ? (scopeBySession.get(episode.session_id) ?? {
            scopeType: 'project',
            scopeKey: defaultScopeKey,
          })
        : { scopeType: 'project', scopeKey: defaultScopeKey };
      insert.run(
        `episodes:${episode.id}`,
        episode.session_id,
        scope.scopeType,
        scope.scopeKey,
        `episode:${episode.kind}`,
        'episodes',
        episode.id,
        null,
        episode.summary,
        'warm',
        0.6,
        episode.created_at,
      );
    }

    for (const snapshot of projectSnapshots) {
      insert.run(
        `project_snapshots:${snapshot.id}`,
        null,
        'project',
        snapshot.scope_key,
        'project_snapshot',
        'project_snapshots',
        snapshot.id,
        null,
        snapshot.summary,
        'warm',
        0.8,
        snapshot.updated_at,
      );
    }

    for (const commandRun of commandRuns) {
      const scope = scopeBySession.get(commandRun.session_id) ?? {
        scopeType: 'project',
        scopeKey: defaultScopeKey,
      };
      const failing =
        typeof commandRun.exit_code === 'number' && commandRun.exit_code !== 0;
      insert.run(
        `command_runs:${commandRun.id}`,
        commandRun.session_id,
        scope.scopeType,
        scope.scopeKey,
        'command_run',
        'command_runs',
        commandRun.id,
        null,
        buildCommandMemoryText(commandRun),
        failing ? 'warm' : 'cold',
        failing ? 0.7 : 0.35,
        commandRun.timestamp,
      );
    }
  });

  tx();
}

function ensureMemoryItemsFts(db: Database.Database): void {
  if (!tableExists(db, 'memory_items') || !tableExists(db, 'memory_items_fts')) {
    return;
  }

  const memoryItemCount = (
    db.prepare('SELECT COUNT(*) as count FROM memory_items').get() as { count: number }
  ).count;
  const ftsCount = (
    db.prepare('SELECT COUNT(*) as count FROM memory_items_fts').get() as { count: number }
  ).count;

  if (memoryItemCount === ftsCount) {
    return;
  }

  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM memory_items_fts').run();
    db.prepare(
      `INSERT INTO memory_items_fts (rowid, subject, text)
       SELECT rowid, COALESCE(subject, ''), text
       FROM memory_items`,
    ).run();
  });

  rebuild();
}
