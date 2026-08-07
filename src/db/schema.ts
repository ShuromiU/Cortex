import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { deriveProjectScopeKey, isAbsoluteFileKey, toScopeRelativeKey } from '../scope/keys.js';
import {
  buildCommandMemoryText as buildCommandMemoryTextValue,
  buildNoteMemoryText,
  noteImportance,
  memoryStateForNote,
} from '../memory/items.js';
import { extractMemoryReferences } from '../memory/references.js';

/**
 * **6, and this is the deliberate exception to AD-11's one-bump-per-release.**
 *
 * That rule governs *additive* DDL: Story 2.2 took R1's increment, and 3.1
 * appended `content_digests` to `V5_TABLES` without touching the version,
 * because a table an older binary does not know about is a table it does not
 * read. Story 3.5 is a different class of change — it **rewrites the meaning of
 * existing values**. `direction` moves from `'spent'|'saved'` to
 * `'injected'|'saved'|'unrealized'|'estimated'`, and a pre-3.5 binary filtering
 * on `direction = 'spent'` then reports `Spent 0 / Saved 0 / Efficiency 0%`:
 * measured, and confidently wrong rather than absent.
 *
 * That is exactly the condition P-5's guard exists for, and this repository's
 * standing position is that a wrong answer is worse than a refusal — the same
 * argument that narrowed the downgrade guard to `<` so an old binary can never
 * silently rewrite a newer store. Without the bump, `NewerSchemaError` cannot
 * fire and the protection is unreachable for the one change that needs it.
 *
 * Cost, stated: any binary built before this story now refuses a store that has
 * been opened by it — loudly for user commands, silently and exit-0 for hooks
 * (AD-12). On this machine that is the `dist/`-lags-a-branch-switch case the
 * project docs already warn about, and a refusal there is the outcome we want.
 */
export const SCHEMA_VERSION = 6;

/**
 * P-5: an older binary opening a store written by a newer one must refuse
 * clearly rather than corrupt it.
 *
 * A distinct class rather than a bare `Error` because the ambient paths have to
 * tell this apart from an ordinary open failure: AD-12 says a hook degrades to
 * silence, but a user running `cortex status` deserves the message. Callers
 * discriminate with `instanceof`, so the wording can change without breaking
 * them.
 *
 * The fix deliberately never says "run a cortex command" — that is what
 * `doctor` already refuses to say for this case, because the command that
 * "fixes" it is the one that rewrites the version down.
 */
/**
 * A store this build must not operate on. The ambient paths catch this base
 * class, not each subclass, so a new unopenable condition degrades to hook
 * silence automatically instead of escaping as an unhandled throw the first
 * time it fires (AD-12).
 */
export class UnopenableStoreError extends Error {}

/**
 * The stored `schema_version` is present but not a version.
 *
 * Refusing rather than repairing, because `getSchemaVersion` parses with
 * `Number.parseInt` and reports an unparseable value as `0` — indistinguishable
 * from a fresh store. Measured: a store holding `schema_version = 'v6'` was
 * opened, rewritten to `'5'`, run through the v1→v2 migration path, and had its
 * `created_at` overwritten. That is exactly the "silently rewrote it down,
 * destroying the evidence" outcome `NewerSchemaError` exists to prevent,
 * reached through a corrupt value instead of a newer one. An *absent* row still
 * means a fresh store and still opens.
 */
export class CorruptSchemaVersionError extends UnopenableStoreError {
  readonly rawValue: string;

  constructor(rawValue: string) {
    super(
      `This Cortex store records an unreadable schema_version (${JSON.stringify(rawValue)}). ` +
        `Refusing to open it rather than overwrite it, because this build cannot tell whether ` +
        `the store is older or newer than it is. Run \`cortex doctor\` for the store path, and ` +
        `move the file aside only if you accept losing the memory it holds.`,
    );
    this.name = 'CorruptSchemaVersionError';
    this.rawValue = rawValue;
  }
}

/**
 * Whether the store's recorded version is absent (a fresh store), a clean
 * integer, or garbage. `getSchemaVersion` deliberately keeps its `number`
 * contract — many callers depend on `0` meaning "no version yet" — so the
 * distinction that matters for refusing lives here.
 */
function readStoredSchemaVersion(
  db: Database.Database,
): { kind: 'absent' } | { kind: 'ok'; version: number } | { kind: 'corrupt'; raw: string } {
  if (!tableExists(db, 'meta')) {
    return { kind: 'absent' };
  }
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined;
  if (!row) {
    return { kind: 'absent' };
  }
  const raw = String(row.value).trim();
  // Strict: a whole non-negative decimal integer and nothing else. `parseInt`
  // accepts a prefix, which is how 'v6' became 0 and '1e3' became 1.
  if (!/^\d+$/.test(raw)) {
    return { kind: 'corrupt', raw: String(row.value) };
  }
  return { kind: 'ok', version: Number(raw) };
}

export class NewerSchemaError extends UnopenableStoreError {
  readonly storeVersion: number;
  readonly binaryVersion: number;

  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `This Cortex store was written by a newer version (schema_version ${storeVersion}; ` +
        `this build expects ${binaryVersion}). Refusing to open it, because migrations are ` +
        `additive only and cannot downgrade a store. Upgrade the package ` +
        `(\`npm install -g cortex-memory\`) to read this memory.`,
    );
    this.name = 'NewerSchemaError';
    this.storeVersion = storeVersion;
    this.binaryVersion = binaryVersion;
  }
}

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
  agent_id          TEXT,
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
  timestamp  TEXT NOT NULL,
  evidence_kind TEXT,
  evidence_ref  TEXT,
  evidence_size INTEGER
);
`;

/**
 * `token_ledger.evidence_*` (FR-8, Story 3.5) — documented here rather than as
 * an inline SQL comment, for two reasons that both bit.
 *
 * Null for an `injected` row, which records what Cortex put into the context
 * and has nothing to evidence. Required for `saved` and `unrealized`, enforced
 * by `insertLedgerEntry` rather than by a CHECK, because adding a CHECK to a
 * populated table means a full rebuild in SQLite. Declared both here and in
 * `migrateTokenLedger`: the migration upgrades existing stores, this definition
 * is what a fresh store gets, and only one of the two runs for any database.
 *
 * **Why not an inline `--` comment in the DDL — and the rule is narrower and
 * stranger than "comments are unsafe".** SQLite stores the original `CREATE
 * TABLE` text and re-parses it during `ALTER TABLE … DROP COLUMN`. Measured on
 * 3.51.3, isolated one character at a time:
 *
 *     -- a plain note about the column        DROP COLUMN succeeds
 *     -- a note (with parens) and a; semicolon  succeeds
 *     -- a note, with a comma                 THROWS "incomplete input"
 *
 * **A comma inside the comment is the whole trigger** — the re-parse splits the
 * column list on commas without honouring comment boundaries, so the comment's
 * comma reads as a column separator and the definition ends mid-clause. Parens,
 * quotes, semicolons and periods are all fine. An earlier version of this note
 * claimed comments in general were fatal, which is false and was rightly
 * challenged; a reviewer who tested comment shapes *without* commas could not
 * reproduce it at all. Prose in a comment naturally contains commas, so the
 * practical rule stands even though the mechanism is narrow: column
 * documentation belongs in TypeScript, where a comma is just a comma.
 *
 * (Backticks are separately fatal here — the DDL lives in a template literal,
 * which Story 3.1 already paid to learn.)
 */
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

CREATE TABLE IF NOT EXISTS memory_item_semantics (
  memory_item_id  TEXT PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  concepts_json   TEXT NOT NULL DEFAULT '[]',
  entities_json   TEXT NOT NULL DEFAULT '[]',
  embedding_model TEXT NOT NULL,
  embedding_json  TEXT NOT NULL,
  source_hash     TEXT NOT NULL,
  updated_at      TEXT NOT NULL
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

const V3_TABLES = `
CREATE TABLE IF NOT EXISTS current_app_graphs (
  scope_key     TEXT PRIMARY KEY,
  scope_type    TEXT NOT NULL DEFAULT 'project',
  git_root      TEXT,
  worktree_path TEXT,
  branch_ref    TEXT,
  head_oid      TEXT,
  files_json    TEXT NOT NULL DEFAULT '[]',
  file_count    INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_references (
  id              TEXT PRIMARY KEY,
  memory_item_id  TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  reference_type  TEXT NOT NULL,
  raw_reference   TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown',
  checked_at      TEXT
);
`;

const V4_TABLES = `
CREATE TABLE IF NOT EXISTS file_renames (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,
  old_path    TEXT NOT NULL,
  new_path    TEXT NOT NULL,
  head_oid    TEXT,
  detected_at TEXT NOT NULL,
  UNIQUE (scope_key, old_path)
);
`;

/**
 * R1's single `SCHEMA_VERSION` increment (4 → 5), per AD-11's one-bump-per-release
 * rule. Story 2.2 is the first story in the release to add a table, so it owns the
 * bump and this constant; Stories 3.1, 4.3 and 4.4 **append** their tables
 * here and leave the version alone. Safe because `applySchema` runs the DDL
 * unconditionally with `CREATE TABLE IF NOT EXISTS`, so a store already marked v5
 * still receives tables appended later.
 */
const V5_TABLES = `
-- The audit trail for FR-22. memory_item_id carries NO foreign key on purpose:
-- ON DELETE CASCADE would destroy the trail together with the item, which is
-- exactly what "an audit trail that survives the correction" forbids, and a
-- non-cascading FK would make the delete fail outright. Absent, not forgotten.
CREATE TABLE IF NOT EXISTS memory_corrections (
  id             TEXT PRIMARY KEY,
  memory_item_id TEXT NOT NULL,
  source_table   TEXT,
  source_id      TEXT,
  scope_key      TEXT,
  operation      TEXT NOT NULL,
  prior_text     TEXT NOT NULL,
  new_text       TEXT,
  prior_subject  TEXT,
  created_at     TEXT NOT NULL
);

-- FR-5's read ledger (Story 3.1). A LOOKUP STRUCTURE, not knowledge: per AD-4
-- content digests deliberately do NOT project into memory_items, so there is
-- no backfill and no new retrieval kind. Keyed by (scope_key, path) — one row
-- per file per scope, upserted on each read, never one row per read.
--
-- session_id AND agent_id are both recorded because AD-16 makes refund
-- eligibility per-session with ancestor rules: a digest recorded by a sibling
-- or descendant session is a valid change-detection fact but is not
-- refund-eligible. A row that knows only its scope cannot answer that.
--
-- sha256 is NULL exactly when oversize is 1: past the ceiling the bytes are
-- never read, so there is nothing to hash. read_count exists because Story
-- 3.4 orders its brief line by read frequency, which a keyed upsert cannot
-- reconstruct after the fact.
-- WITHOUT ROWID, and (scope_key, path) is the real PRIMARY KEY rather than a
-- surrogate id. Both are footprint decisions forced by AC #5's 400 byte/file
-- ceiling, and every number here was measured, never estimated. Cost is a
-- page-granularity STEP function of the WHOLE row (scope_key + path + sha256 +
-- mtime + agent_id), not a linear function of path length — interpolating two
-- points overstates the headroom, which is how an earlier version of this
-- comment claimed a cliff 28 characters further out than it is.
--
-- A UUID id plus a separate unique index cost 639 b/file, a failing AC.
-- Dropping the surrogate and folding the row into the stated key fixed that,
-- but Story 3.1 still shipped keys ABSOLUTE and breached at 417.8 for this
-- repo's longest real path (135 ch) with the real 74-char branch scope key.
-- Story 3.2 stores the path RELATIVE to the scope root — the repo prefix is
-- exactly what is redundant with scope_key. Measured after, COUNT=500:
--
--   absLen                         no agent_id     with agent_id (17 ch)
--   44  (this repo's median read)   278.5 PASS       303.1 PASS
--   122 (p90)                       376.8 PASS       376.8 PASS
--   135 (this repo's max)           376.8 PASS       417.8 FAIL
--   145 (repo-b's max)           376.8 PASS       417.8 FAIL
--   first breach                    152              135
--
-- Stated plainly: the ceiling now holds for every real path in this repository
-- and in repo-b on a PRIMARY-session read, and is still breached for a
-- SUBAGENT read of the longest paths, because agent_id shares the same row
-- budget. Reducing it further means shortening scope_key, a scope-layer change.
--
-- The architecture already specified the key ("Digests keyed by (scope_key,
-- path)"), so this makes the storage match the stated key instead of adding one.
CREATE TABLE IF NOT EXISTS content_digests (
  scope_key   TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT,
  byte_size   INTEGER NOT NULL,
  mtime       TEXT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id    TEXT,
  oversize    INTEGER NOT NULL DEFAULT 0,
  read_count  INTEGER NOT NULL DEFAULT 1,
  recorded_at TEXT NOT NULL,
  refund_eligible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_key, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS read_offers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scope_key  TEXT NOT NULL,
  path       TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  tokens     INTEGER NOT NULL,
  offered_at TEXT NOT NULL,
  PRIMARY KEY (session_id, scope_key, path)
) WITHOUT ROWID;

-- FR-12's negative cache (Story 4.3). A LOOKUP STRUCTURE, not knowledge: per
-- AD-4 negative results do NOT project into memory_items — no backfill, no
-- retrieval kind, queried by key only. Keyed (scope_key, query_key), where
-- query_key is sha256-16 of the canonical query (tool + raw pattern + root +
-- matching-relevant params). The key hashes the RAW pattern while the stored
-- pattern column is redacted: distinct secret-bearing searches stay distinct
-- without persisting the secret, and the hash is one-way.
--
-- census_sha256 is the assertion's ENTIRE evidence (AD-6): a fingerprint of
-- the search root's working-tree bytes at flush time, re-derived and compared
-- at query time. head_oid is verdict METADATA — recorded per the AC, rendered
-- in the "no-matches-at <head>" verdict, never compared: a head that moved
-- over a byte-identical root does not change what the search would return,
-- and comparing it could only produce false misses. census_sha256 is NOT NULL
-- by design: a record whose census could not be computed (ceilings exceeded,
-- unreadable entry) is never stored at all, because it could never assert.
--
-- No session_id, deliberately: negatives are scope facts, not context facts —
-- any session in the scope may be told the tree provably still has no matches
-- — and omitting it also avoids binding a scope-wide fact to a session row's
-- ON DELETE CASCADE (the content_digests concern parked with Story 4.6).
CREATE TABLE IF NOT EXISTS negative_results (
  scope_key     TEXT NOT NULL,
  query_key     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  root          TEXT NOT NULL,
  params_json   TEXT,
  head_oid      TEXT,
  census_sha256 TEXT NOT NULL,
  census_files  INTEGER NOT NULL,
  census_bytes  INTEGER NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (scope_key, query_key)
) WITHOUT ROWID;

-- FR-18's dispatch capture (Story 5.2). A LOOKUP/STAGING structure, not
-- knowledge: per AD-4 it does NOT project into memory_items -- no backfill, no
-- retrieval kind, and therefore no AD-5 fixture obligation. Same standing as
-- content_digests and negative_results above.
--
-- WHY IT EXISTS AT ALL. SubagentStart carries exactly seven fields and none of
-- them is the dispatch description (measured 2026-08-06): the per-agent sidecar
-- that holds it is written strictly AFTER every SubagentStart hook returns, and
-- the parent transcript is racy at that instant. PreToolUse on the Agent tool
-- is the only event that carries the description, so it is captured one event
-- earlier and consumed when the subagent actually starts.
--
-- host_session_id and prompt_id are the HOST's identifiers, NOT Cortex session
-- ids. Named apart from session_id deliberately: every other table here means a
-- sessions.id by that name, and an FK-shaped name for a foreign concept is how
-- a later reader writes a join that silently returns nothing.
--
-- Together with agent_type they are the pairing key, and each part earns its
-- place: host_session_id separates two host windows open on one branch (they
-- share a scope_key, so scope alone does not divide them); prompt_id separates a
-- stale capture from an earlier turn, which is the mispairing that would hand a
-- subagent context from genuinely unrelated work; agent_type separates
-- concurrent dispatches of different types.
--
-- prompt_prefix is a NORMALIZED, bounded prefix used only to answer AC #3 -- did
-- the parent already paste this into the dispatch prompt -- and prompt_chars is
-- the full normalized length, so the suppression decision can state how much of
-- the prompt it actually saw rather than implying it saw all of it (AD-6). The
-- prompt is never stored verbatim: a dispatch prompt runs to tens of kilobytes
-- and this table is not a transcript.
--
-- A ROWID table, deliberately, where the neighbouring lookup tables are WITHOUT
-- ROWID: FIFO pairing needs a stable tiebreak between two captures recorded in
-- the same millisecond, and rowid is the only monotonic thing available.
CREATE TABLE IF NOT EXISTS subagent_dispatches (
  id              TEXT PRIMARY KEY,
  scope_key       TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  prompt_id       TEXT NOT NULL,
  agent_type      TEXT NOT NULL,
  tool_use_id     TEXT,
  description     TEXT NOT NULL,
  prompt_digest   TEXT,
  prompt_prefix   TEXT,
  prompt_chars    INTEGER NOT NULL DEFAULT 0,
  captured_at     TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_by_agent_id TEXT
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
CREATE INDEX IF NOT EXISTS idx_memory_items_state_created ON memory_items(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_renames_scope_old ON file_renames(scope_key, old_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_source ON memory_items(source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_item_semantics_hash ON memory_item_semantics(source_hash);
CREATE INDEX IF NOT EXISTS idx_current_app_graphs_updated ON current_app_graphs(updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_references_item ON memory_references(memory_item_id);
CREATE INDEX IF NOT EXISTS idx_memory_references_status ON memory_references(status);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_session ON retrieval_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_corrections_item ON memory_corrections(memory_item_id, created_at);
-- The pairing lookup (Story 5.2), column order matching the WHERE clause in
-- consumeSubagentDispatch. captured_at last so the same index also serves the
-- FIFO ordering. No backticks anywhere in this constant: it is a template
-- literal, so one ends the string and the file stops parsing.
CREATE INDEX IF NOT EXISTS idx_subagent_dispatches_pairing
  ON subagent_dispatches(host_session_id, prompt_id, agent_type, consumed_at, captured_at);
-- GC's horizon scan, which is keyed on age alone.
CREATE INDEX IF NOT EXISTS idx_subagent_dispatches_captured
  ON subagent_dispatches(captured_at);
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

interface MemoryItemReferenceBackfillRow {
  id: string;
  subject: string | null;
  text: string;
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
 * Open an existing database read-only, for callers that must observe the store
 * without changing it.
 *
 * Deliberately not `openDatabase`: that one creates the file when it is missing
 * and sets `journal_mode = WAL`, which is itself a write and throws on a
 * read-only connection. A diagnostic that opened the store the normal way would
 * create an empty database for a user who has none, and — via
 * `ensureCortexSchema` — migrate the schema it was asked to report on, so a
 * version mismatch could never be observed.
 *
 * Throws when the file does not exist (`fileMustExist`), so absence is a
 * distinguishable outcome rather than a silently fresh database.
 */
export function openDatabaseReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Default ceiling before a mid-session checkpoint is worth running (FR-25). */
export const DEFAULT_WAL_MAX_BYTES = 4 * 1024 * 1024;

/** One page. A ceiling below this would checkpoint on every single call. */
export const MIN_WAL_MAX_BYTES = 4096;

export interface WalCheckpointResult {
  /** A reader held the file, so the WAL could not be reclaimed. Not an error. */
  busy: boolean;
  /** Frames left in the WAL afterwards. */
  log: number;
  /** Frames moved into the main database. */
  checkpointed: number;
}

/** `<dbPath>-wal`. */
export function walPath(dbPath: string): string {
  return `${dbPath}-wal`;
}

/**
 * Size of the write-ahead log, or 0 when there is none.
 *
 * `statSync`, deliberately, not a query: opening the database to ask would
 * *create* the sidecar it is measuring — story 2.3's finding — and this is
 * called on paths that must stay cheap.
 */
export function walSizeBytes(dbPath: string): number {
  try {
    return fs.statSync(walPath(dbPath)).size;
  } catch {
    return 0;
  }
}

/** Size of the main database file, or 0 when it does not exist. */
export function databaseSizeBytes(dbPath: string): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}

/**
 * Checkpoint the WAL and return the space to the filesystem.
 *
 * **`TRUNCATE`, not the passive checkpoint SQLite runs on its own.** Measured
 * on SQLite 3.51.3: `wal_autocheckpoint` is 1000 pages by default and does bound
 * the WAL, but a passive checkpoint only resets it for reuse — the file stays
 * parked at its high-water mark (4,128,272 bytes before and after). Only
 * `TRUNCATE` shrinks it, and shrinking it is the whole of FR-25's footprint
 * claim.
 *
 * **It never waits, and that is not a detail.** `TRUNCATE` is RESTART plus a
 * truncate, and RESTART invokes SQLite's busy handler until no other connection
 * is inside a transaction. `openDatabase` sets `busy_timeout = 5000`, so
 * inheriting it made every checkpoint a potential five-second stall — measured
 * at 5518 ms against a concurrent reader and 5560 ms against a writer, both
 * returning `busy` with the WAL unchanged. Cortex checkpoints only on hook and
 * command paths, where blocking is the one thing it must not do, so the busy
 * timeout is dropped to zero for the duration: 7 ms instead of 5518 ms, and the
 * frames still move (`{busy:1, checkpointed:242}`).
 *
 * Never throws. A `busy` result is ordinary rather than a failure — it means
 * another Cortex process was mid-transaction, most often the spool flush that
 * `cortex-capture.sh` launches detached past its size threshold.
 */
export function checkpointWal(
  db: Database.Database,
  options: { waitMs?: number } = {},
): WalCheckpointResult | null {
  let previousTimeout: number | null = null;
  try {
    // Read it back rather than assuming `openDatabase`'s value: this is also
    // called on handles the caller configured.
    previousTimeout = db.pragma('busy_timeout', { simple: true }) as number;
    db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(options.waitMs ?? 0))}`);
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      busy: row.busy === 1,
      log: row.log,
      checkpointed: row.checkpointed,
    };
  } catch {
    // A checkpoint that cannot run is not a failure worth surfacing (AD-12).
    return null;
  } finally {
    if (previousTimeout !== null) {
      try {
        db.pragma(`busy_timeout = ${previousTimeout}`);
      } catch {
        // The handle is closing anyway; the restore is courtesy, not contract.
      }
    }
  }
}

/**
 * The configured mid-session ceiling.
 *
 * Parsed with `Number`, not `parseInt`. `gc`'s neighbouring `envNumber` uses
 * `parseInt`, which succeeds on a *prefix* — `4e6` becomes 4, silently turning a
 * 4 MB ceiling into a 4-byte one that checkpoints on every call. Same reasoning
 * as `resolvePageLimit` in story 2.1.
 *
 * Rejected as well as non-finite, zero and negative: fractions and anything
 * below one page. `Number` accepts `0.5` and `0x10` happily, and a sub-page
 * ceiling means every call checkpoints — cheap now that checkpoints do not
 * block, but still pointless I/O on every hook.
 */
export function resolveWalMaxBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['CORTEX_WAL_MAX_BYTES'];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WAL_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_WAL_MAX_BYTES) {
    return DEFAULT_WAL_MAX_BYTES;
  }
  return parsed;
}

/**
 * Checkpoint only when the WAL has crossed its ceiling (FR-25 AC #2).
 *
 * Callers must be off the tool-call path: `PostToolUse` is pure bash and spawns
 * no Node (N-4), so nothing on the hot path can reach this — the constraint is
 * kept by where it is *called*, and the call sites are the spool flush and
 * `end-of-turn`. Returns null when nothing was done.
 */
export function maybeCheckpointWal(
  db: Database.Database,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WalCheckpointResult | null {
  if (walSizeBytes(dbPath) <= resolveWalMaxBytes(env)) {
    return null;
  }
  return checkpointWal(db);
}

/**
 * Apply latest tables and indexes. Idempotent (IF NOT EXISTS).
 * For existing databases, use ensureCortexSchema() to run migrations as well.
 */
export function applySchema(db: Database.Database): void {
  db.exec(CORE_TABLES);
  db.exec(V2_TABLES);
  db.exec(V3_TABLES);
  db.exec(V4_TABLES);
  db.exec(V5_TABLES);
  db.exec(V2_FTS);
  ensureSessionScopeColumns(db);
  ensureMemoryReferenceColumns(db);
  ensureContentDigestColumns(db);
  ensureSubagentDispatchColumns(db);
  db.exec(INDEXES);
  ensureSessionAgentIndex(db);
}

/**
 * `consumed_by_agent_id`, added after the table shipped in Story 5.2's first
 * build (review round, 2026-08-07).
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * store that saw the first build keeps the old five-column shape — and the query
 * that reads this column would throw on every dispatch. `ensureColumn` is the
 * established answer (`memory_references.moved_to`, the `token_ledger` evidence
 * columns), and it costs one `PRAGMA table_info` per open.
 *
 * It records WHICH subagent consumed a capture, so a `SubagentStart` that fires
 * twice for one agent id cannot claim a second capture. Reproduced before the
 * fix: alpha briefed twice — the second time with bravo's topic — bravo silent,
 * and both injections billed to alpha.
 */
function ensureSubagentDispatchColumns(db: Database.Database): void {
  ensureColumn(db, 'subagent_dispatches', 'consumed_by_agent_id', 'consumed_by_agent_id TEXT');
}

/**
 * Story 4.5's review round (2026-08-03). Whether the digest provably describes
 * the bytes the recorded read RETURNED, not merely the bytes on disk at flush
 * time — the flush disqualifies a read that was followed in its batch by an
 * edit of the same path or by any command, because either can rewrite the file
 * before the digest is computed. Additive per AD-11; DEFAULT 0 so every row
 * recorded before the column existed is ineligible until refreshed by a clean
 * read — the safe direction, a missed refund rather than a false one.
 */
function ensureContentDigestColumns(db: Database.Database): void {
  ensureColumn(
    db,
    'content_digests',
    'refund_eligible',
    'refund_eligible INTEGER NOT NULL DEFAULT 0',
  );
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
  // P-5: refuse a store from a newer build BEFORE applySchema touches it.
  // Migrations are additive-only and this binary does not know the newer
  // build's invariants, so operating on it is corruption, not compatibility.
  // Checked first because applySchema would otherwise run its DDL against a
  // schema it cannot reason about.
  const stored = readStoredSchemaVersion(db);
  if (stored.kind === 'corrupt') {
    throw new CorruptSchemaVersionError(stored.raw);
  }
  if (stored.kind === 'ok' && stored.version > SCHEMA_VERSION) {
    throw new NewerSchemaError(stored.version, SCHEMA_VERSION);
  }

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

  // Upgrade-only. This was `!==`, which fires in both directions and silently
  // rewrote a newer store *down* to this build's version — destroying the only
  // evidence a downgrade happened, which is why `doctor`'s fix for a newer
  // store refuses to say "run any cortex command".
  //
  // Stated honestly: the refusal above is what actually prevents that now, so
  // this branch is unreachable for a newer store and `<` is belt-and-braces
  // rather than the fix. A mutation restoring `!==` therefore cannot be killed
  // by any test, and that survivor is expected — it is kept because it states
  // the intended direction and holds if the refusal is ever moved or relaxed.
  if (currentVersion < SCHEMA_VERSION) {
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

function ensureMemoryReferenceColumns(db: Database.Database): void {
  ensureColumn(db, 'memory_references', 'moved_to', 'moved_to TEXT');
}

/**
 * FR-8 evidence columns, and the `spent` → `injected` rename (Story 3.5).
 *
 * Added by `ALTER TABLE` rather than in `V1_TABLES`, because `token_ledger`
 * predates this release and every existing store already has the table. All
 * three are nullable: an `injected` row records what Cortex put into the
 * context and has nothing to evidence.
 *
 * **The rename is a data migration, not a schema-version change.** `direction`
 * carries no CHECK constraint, so the values are just text — and AC #1 names
 * `injected` while Story 3.6 must *report* it. Two vocabularies for one concept
 * is the drift that produced this epic's Story 2.7 error.
 *
 * `type = 'rollup'` rows are migrated too, and that is load-bearing: `cortex gc`
 * aggregates the ledger with `GROUP BY session_id, direction`, so a rollup left
 * on the old value would silently form a second, parallel total that no query
 * adds up.
 *
 * The consolidation credit moves to `estimated` rather than being deleted. It
 * is evidence-free — the difference between a summary and pasting every
 * captured event as raw JSON — so AC #3 forbids it counting as a saving, but
 * destroying audit history is not this repo's answer to a bad number.
 */
function migrateTokenLedger(db: Database.Database): void {
  if (!tableExists(db, 'token_ledger')) {
    return;
  }
  ensureColumn(db, 'token_ledger', 'evidence_kind', 'evidence_kind TEXT');
  ensureColumn(db, 'token_ledger', 'evidence_ref', 'evidence_ref TEXT');
  ensureColumn(db, 'token_ledger', 'evidence_size', 'evidence_size INTEGER');

  // Short-circuit before opening a write transaction. This runs on EVERY store
  // open — every CLI command and every hook fire — and unconditionally took the
  // write lock for two UPDATEs that match nothing once the migration has run:
  // measured 0.2 ms at 0 rows but 8.1 ms at 100k, paid forever. One indexed-free
  // COUNT over the three legacy shapes is cheap and read-only.
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM token_ledger
        WHERE direction = 'spent'
           OR type = 'offer:read'
           OR (direction = 'saved' AND evidence_kind IS NULL)`,
    )
    .get() as { n: number };
  if (pending.n === 0) {
    return;
  }

  db.transaction(() => {
    // Order matters: reclassify the evidence-free credit FIRST, then rename the
    // cost side. Renaming first is harmless here, but doing the credit pass on
    // `direction = 'saved'` after any future rename would silently match
    // nothing — and a migration that quietly does nothing is the failure mode
    // this file has already paid for once.
    db.prepare(
      `UPDATE token_ledger SET direction = 'estimated'
        WHERE direction = 'saved' AND evidence_kind IS NULL`,
    ).run();
    db.prepare(`UPDATE token_ledger SET direction = 'injected' WHERE direction = 'spent'`).run();
    // A pending OFFER is not an accounting fact and never belonged in the
    // ledger. Written there briefly during development, it counted as
    // `unrealized` the moment it was made — so an agent that adopted every
    // offer scored identically to one that ignored every offer, and the figure
    // labelled "offered, not taken" actually meant "offered". Offers now live
    // in `read_offers`; any that reached a store are removed rather than left
    // inflating the number this story exists to make honest.
    db.prepare(`DELETE FROM token_ledger WHERE type = 'offer:read'`).run();
  })();
}

/**
 * Unique on the AD-9 identity, partial so primary sessions (agent_id NULL) are
 * unconstrained. Uniqueness is the race guard: hook processes are independent
 * and resolve a child by read-then-insert, so without it two concurrent tool
 * calls from one subagent can create two child rows and strand the loser's
 * events. Guarded creation — a store that somehow already holds duplicates
 * must still open (AD-11), so it degrades to a plain lookup index.
 */
function ensureSessionAgentIndex(db: Database.Database): void {
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent
         ON sessions(scope_key, agent_id) WHERE agent_id IS NOT NULL`,
    );
  } catch {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(scope_key, agent_id)',
    );
  }
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
  // AD-9: session identity is (scope_key, agent_id). Nullable — a NULL agent_id
  // is a primary session, which is every session written before this column.
  ensureColumn(db, 'sessions', 'agent_id', 'agent_id TEXT');
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

export function getMetaValue(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, 'meta')) {
    return undefined;
  }

  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as MetaRow | undefined;
  return row?.value;
}

export function setMetaValue(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(key, value);
}

function migrateV1ToV2(db: Database.Database, rootPath: string): void {
  backfillSessionScopes(db, rootPath);
  backfillV2Artifacts(db, rootPath);
  setMetaValue(db, 'schema_version', '2');
  setMetaValue(db, 'migrated_to_v2_at', new Date().toISOString());
}

/**
 * Story 3.2 changed `content_digests.path` from an absolute key to one relative
 * to the scope root. Rows written by 3.1 are keyed absolute, and without this
 * every one of them becomes unreachable — the ledger would report "unread" for
 * files that were read, silently, with the rows still sitting in the table.
 *
 * The mapping is mechanical: `sessions.worktree_path` records each scope's root.
 * Rows whose file lives outside their scope root, and rows whose scope has no
 * session recording a root, keep their absolute key — which is the same thing
 * `toScopeRelativeKey` does for them going forward.
 *
 * Idempotent: a key that is already relative does not start with a root, so the
 * conversion is a no-op on a second run. Collisions are possible in principle
 * (an absolute and a relative row for one file), so the update is written as
 * INSERT OR REPLACE semantics via a delete-then-insert of the losing row.
 */
function migrateContentDigestPaths(db: Database.Database): void {
  if (!tableExists(db, 'content_digests')) {
    return;
  }

  // Must match `CortexStore.scopeRootFor` exactly: newest session wins. A bare
  // `GROUP BY scope_key` lets SQLite return an arbitrary row, and measured on a
  // scope with two worktrees it picked the OLDER one while the runtime picked
  // the newest — so the migration rewrote keys relative to a root that no read
  // or write would ever use, orphaning precisely the rows it exists to repair.
  const roots = db
    .prepare(
      `SELECT s.scope_key AS scope_key, s.worktree_path AS worktree_path
         FROM sessions s
         JOIN (
           SELECT scope_key, MAX(started_at) AS newest
             FROM sessions
            WHERE scope_key IS NOT NULL AND worktree_path IS NOT NULL
            GROUP BY scope_key
         ) newest_per_scope
           ON newest_per_scope.scope_key = s.scope_key
          AND newest_per_scope.newest = s.started_at
        WHERE s.worktree_path IS NOT NULL
        GROUP BY s.scope_key`,
    )
    .all() as { scope_key: string; worktree_path: string }[];
  if (roots.length === 0) {
    return;
  }

  const rootByScope = new Map(roots.map(r => [r.scope_key, r.worktree_path]));
  const rows = db
    .prepare('SELECT scope_key, path FROM content_digests')
    .all() as { scope_key: string; path: string }[];

  const update = db.prepare(
    'UPDATE content_digests SET path = ? WHERE scope_key = ? AND path = ?',
  );
  const dropLegacy = db.prepare(
    'DELETE FROM content_digests WHERE scope_key = ? AND path = ?',
  );
  const exists = db.prepare(
    'SELECT 1 FROM content_digests WHERE scope_key = ? AND path = ?',
  );
  db.transaction(() => {
    for (const row of rows) {
      // Only absolute keys are 3.1 rows needing conversion. Belt-and-braces
      // beside `toScopeRelativeKey`'s own guard: a relative key must never be
      // re-resolved, or it is anchored to whatever cwd this process has.
      if (!isAbsoluteFileKey(row.path)) {
        continue;
      }
      const root = rootByScope.get(row.scope_key);
      if (!root) {
        continue;
      }
      const next = toScopeRelativeKey(row.path, root);
      if (next === row.path) {
        continue;
      }
      // Collision: a current relative row already exists for this file. It was
      // written by the current code and is newer than the legacy absolute row
      // by construction, so the legacy row is dropped rather than promoted.
      //
      // `UPDATE OR REPLACE` did the opposite: SQLite's REPLACE deletes the
      // *pre-existing conflicting* row, so the 2020 legacy digest survived and
      // a 2026 row lost its sha256, byte size and 42 accumulated reads —
      // measured. Silent memory corruption inside the function whose whole job
      // is to prevent silent orphaning.
      if (exists.get(row.scope_key, next)) {
        dropLegacy.run(row.scope_key, row.path);
        continue;
      }
      update.run(next, row.scope_key, row.path);
    }
  })();
}

function backfillV2Artifacts(db: Database.Database, rootPath: string): void {
  backfillSessionScopes(db, rootPath);
  migrateContentDigestPaths(db);
  migrateTokenLedger(db);
  backfillCommandRuns(db);
  backfillEpisodes(db);
  backfillProjectSnapshots(db, rootPath);
  backfillMemoryItems(db, rootPath);
  backfillMemoryReferences(db);
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

function backfillMemoryReferences(db: Database.Database): void {
  if (!tableExists(db, 'memory_items') || !tableExists(db, 'memory_references')) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT mi.id, mi.subject, mi.text
       FROM memory_items mi
       LEFT JOIN memory_references mr ON mr.memory_item_id = mi.id
       WHERE mr.id IS NULL
       ORDER BY mi.created_at ASC, mi.rowid ASC`,
    )
    .all() as MemoryItemReferenceBackfillRow[];
  const insert = db.prepare(
    `INSERT INTO memory_references (
       id,
       memory_item_id,
       reference_type,
       raw_reference,
       normalized_path,
       status,
       checked_at
     )
     VALUES (?, ?, ?, ?, ?, 'unknown', NULL)`,
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      for (const ref of extractMemoryReferences(row.subject, row.text)) {
        insert.run(
          crypto.randomUUID(),
          row.id,
          ref.referenceType,
          ref.rawReference,
          ref.normalizedPath,
        );
      }
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
