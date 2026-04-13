import type Database from 'better-sqlite3';
import { deriveProjectScopeKey } from '../scope/keys.js';
import {
  buildBranchSnapshotMemoryText,
  buildCommandMemoryText,
  buildEpisodeMemoryText,
  buildNoteMemoryText,
  buildProjectSnapshotMemoryText,
  commandRunImportance,
  commandRunState,
  episodeImportance,
  episodeState,
  memoryStateForNote,
  noteImportance,
  type MemoryItemState,
} from '../memory/items.js';

// ── Row types (raw DB rows) ───────────────────────────────────────────

export interface NoteRow {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  subject: string | null;
  content: string;
  alternatives: string | null; // JSON string
  status: string;
  conflict: number; // 0 or 1
}

export interface StateRow {
  id: string;
  session_id: string | null;
  layer: string;
  content: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  session_id: string;
  type: string;
  direction: string;
  tokens: number;
  timestamp: string;
}

export interface SessionRow {
  id: string;
  parent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  focus: string | null;
  agent_type: string;
  status: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  scope_type: string;
  scope_key: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  timestamp: string;
  type: string;
  target: string | null;
  metadata_json: string | null;
}

export interface ParsedEvent {
  id: string;
  session_id: string;
  timestamp: string;
  type: string;
  target: string | null;
  metadata: Record<string, unknown>;
}

export interface BranchSnapshotRow {
  id: string;
  scope_key: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  focus: string | null;
  summary: string;
  recent_files: string[];
  intents: string[];
  blockers: string[];
  last_session_id: string | null;
  updated_at: string;
}

export interface CommandRunRow {
  id: string;
  session_id: string;
  event_id: string | null;
  timestamp: string;
  category: string | null;
  command_summary: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  files_touched_json: string | null;
}

export interface ParsedCommandRun {
  id: string;
  session_id: string;
  event_id: string | null;
  timestamp: string;
  category: string | null;
  command_summary: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  files_touched: string[];
}

export interface EpisodeRow {
  id: string;
  session_id: string | null;
  kind: string;
  summary: string;
  target: string | null;
  metadata_json: string | null;
  source_state_id: string | null;
  created_at: string;
}

export interface ParsedEpisode {
  id: string;
  session_id: string | null;
  kind: string;
  summary: string;
  target: string | null;
  metadata: Record<string, unknown>;
  source_state_id: string | null;
  created_at: string;
}

export interface ProjectSnapshotRow {
  id: string;
  git_root: string | null;
  scope_key: string;
  summary: string;
  note_digest: string | null;
  updated_at: string;
}

export interface MemoryItemRow {
  id: string;
  session_id: string | null;
  scope_type: string;
  scope_key: string;
  kind: string;
  source_table: string | null;
  source_id: string | null;
  subject: string | null;
  text: string;
  state: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface ParsedMemoryItem {
  id: string;
  session_id: string | null;
  scope_type: string;
  scope_key: string;
  kind: string;
  source_table: string | null;
  source_id: string | null;
  subject: string | null;
  text: string;
  state: MemoryItemState;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface SearchMemoryItemResult extends ParsedMemoryItem {
  fts_rank: number;
}

export interface RetrievalLogRow {
  id: string;
  session_id: string | null;
  topic: string;
  query_text: string | null;
  result_ids_json: string | null;
  total_candidates: number;
  returned_count: number;
  token_estimate: number;
  created_at: string;
}

export interface ParsedRetrievalLog {
  id: string;
  session_id: string | null;
  topic: string;
  query_text: string | null;
  result_ids: string[];
  total_candidates: number;
  returned_count: number;
  token_estimate: number;
  created_at: string;
}

// ── Input types ───────────────────────────────────────────────────────

export interface CreateSessionOpts {
  parentSessionId?: string;
  agentType?: string;
  focus?: string;
  gitRoot?: string;
  worktreePath?: string;
  branchRef?: string;
  headOid?: string;
  scopeType?: string;
  scopeKey?: string;
}

export interface InsertEventOpts {
  sessionId: string;
  type: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface InsertNoteOpts {
  sessionId: string;
  kind: 'insight' | 'decision' | 'intent' | 'blocker' | 'focus';
  content: string;
  subject?: string;
  alternatives?: string[];
}

export interface ParsedNote {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  subject: string | null;
  content: string;
  alternatives: string[] | null; // parsed
  status: string;
  conflict: boolean; // parsed
}

export interface InsertStateOpts {
  sessionId?: string;
  layer: 'session' | 'project';
  content: string;
}

export interface InsertLedgerOpts {
  sessionId: string;
  type: string;
  direction: 'spent' | 'saved';
  tokens: number;
}

export interface InsertCommandRunOpts {
  id?: string;
  sessionId: string;
  eventId?: string | null;
  timestamp?: string;
  category?: string | null;
  commandSummary?: string | null;
  exitCode?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  filesTouched?: string[];
}

export interface InsertEpisodeOpts {
  id?: string;
  sessionId?: string | null;
  kind: string;
  summary: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
  sourceStateId?: string | null;
  createdAt?: string;
}

export interface UpsertBranchSnapshotOpts {
  scopeKey: string;
  gitRoot?: string | null;
  worktreePath?: string | null;
  branchRef?: string | null;
  headOid?: string | null;
  focus?: string | null;
  summary: string;
  recentFiles?: string[];
  intents?: string[];
  blockers?: string[];
  lastSessionId?: string | null;
  updatedAt?: string;
}

export interface UpsertProjectSnapshotOpts {
  id?: string;
  gitRoot?: string | null;
  scopeKey: string;
  summary: string;
  noteDigest?: string | null;
  updatedAt?: string;
}

export interface UpsertMemoryItemOpts {
  id?: string;
  sessionId?: string | null;
  scopeType: string;
  scopeKey: string;
  kind: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  subject?: string | null;
  text: string;
  state?: MemoryItemState;
  importance?: number;
  accessCount?: number;
  lastAccessedAt?: string | null;
  createdAt?: string;
}

export interface InsertRetrievalLogOpts {
  id?: string;
  sessionId?: string | null;
  topic: string;
  queryText?: string | null;
  resultIds?: string[];
  totalCandidates?: number;
  returnedCount?: number;
  tokenEstimate?: number;
  createdAt?: string;
}

export interface UpdateMemoryItemStateOpts {
  id: string;
  state: MemoryItemState;
}

export interface TableCounts {
  sessions: number;
  events: number;
  notes: number;
  state: number;
  token_ledger: number;
  command_runs: number;
  episodes: number;
  branch_snapshots: number;
  project_snapshots: number;
  memory_items: number;
  retrieval_log: number;
}

// ── Helper functions ──────────────────────────────────────────────────

export function parseNoteRow(row: NoteRow): ParsedNote {
  let alternatives: string[] | null = null;
  if (row.alternatives) {
    try {
      alternatives = JSON.parse(row.alternatives) as string[];
    } catch {
      alternatives = null;
    }
  }
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    kind: row.kind,
    subject: row.subject,
    content: row.content,
    alternatives,
    status: row.status,
    conflict: row.conflict === 1,
  };
}

export function parseEventRow(row: EventRow): ParsedEvent {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    type: row.type,
    target: row.target,
    metadata,
  };
}

export function parseCommandRunRow(row: CommandRunRow): ParsedCommandRun {
  return {
    id: row.id,
    session_id: row.session_id,
    event_id: row.event_id,
    timestamp: row.timestamp,
    category: row.category,
    command_summary: row.command_summary,
    exit_code: row.exit_code,
    stdout_tail: row.stdout_tail,
    stderr_tail: row.stderr_tail,
    files_touched: parseJsonStringArray(row.files_touched_json),
  };
}

export function parseEpisodeRow(row: EpisodeRow): ParsedEpisode {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    summary: row.summary,
    target: row.target,
    metadata: parseJsonObject(row.metadata_json),
    source_state_id: row.source_state_id,
    created_at: row.created_at,
  };
}

export function parseMemoryItemRow(row: MemoryItemRow): ParsedMemoryItem {
  return {
    id: row.id,
    session_id: row.session_id,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    kind: row.kind,
    source_table: row.source_table,
    source_id: row.source_id,
    subject: row.subject,
    text: row.text,
    state: row.state as MemoryItemState,
    importance: row.importance,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
  };
}

export function parseRetrievalLogRow(row: RetrievalLogRow): ParsedRetrievalLog {
  return {
    id: row.id,
    session_id: row.session_id,
    topic: row.topic,
    query_text: row.query_text,
    result_ids: parseJsonStringArray(row.result_ids_json),
    total_candidates: row.total_candidates,
    returned_count: row.returned_count,
    token_estimate: row.token_estimate,
    created_at: row.created_at,
  };
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
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

// ── Store ─────────────────────────────────────────────────────────────

export class CortexStore {
  constructor(private db: Database.Database) {}

  private resolveSessionScope(
    sessionId: string,
  ): { scopeType: string; scopeKey: string } | undefined {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }

    const scopeKey =
      session.scope_key ??
      (session.scope_type === 'project' ? this.getProjectScopeKey() : undefined);
    if (!scopeKey) {
      return undefined;
    }

    return {
      scopeType: session.scope_type,
      scopeKey,
    };
  }

  private getProjectScopeKey(): string | undefined {
    const rootPath = this.getMeta('root_path');
    return rootPath ? deriveProjectScopeKey(rootPath) : 'project:default';
  }

  private syncMemoryItemForNote(noteId: string): void {
    const note = this.getNote(noteId);
    if (!note) {
      return;
    }

    const scope = this.resolveSessionScope(note.session_id);
    if (!scope) {
      return;
    }

    this.upsertMemoryItem({
      id: `notes:${note.id}`,
      sessionId: note.session_id,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      kind: `note:${note.kind}`,
      sourceTable: 'notes',
      sourceId: note.id,
      subject: note.subject,
      text: buildNoteMemoryText(note),
      state: memoryStateForNote(note.kind, note.status),
      importance: noteImportance(note.kind),
      createdAt: note.timestamp,
    });
  }

  private syncMemoryItemForCommandRun(commandRunId: string): void {
    const run = this.getCommandRun(commandRunId);
    if (!run) {
      return;
    }

    const scope = this.resolveSessionScope(run.session_id);
    if (!scope) {
      return;
    }

    this.upsertMemoryItem({
      id: `command_runs:${run.id}`,
      sessionId: run.session_id,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      kind: 'command_run',
      sourceTable: 'command_runs',
      sourceId: run.id,
      text: buildCommandMemoryText(run),
      state: commandRunState(run),
      importance: commandRunImportance(run),
      createdAt: run.timestamp,
    });
  }

  private syncMemoryItemForEpisode(episodeId: string): void {
    const episode = this.getEpisode(episodeId);
    if (!episode) {
      return;
    }

    const scope = episode.session_id
      ? this.resolveSessionScope(episode.session_id)
      : undefined;
    const scopeType = scope?.scopeType ?? 'project';
    const scopeKey = scope?.scopeKey ?? this.getProjectScopeKey();
    if (!scopeKey) {
      return;
    }

    this.upsertMemoryItem({
      id: `episodes:${episode.id}`,
      sessionId: episode.session_id,
      scopeType,
      scopeKey,
      kind: `episode:${episode.kind}`,
      sourceTable: 'episodes',
      sourceId: episode.id,
      subject: episode.target,
      text: buildEpisodeMemoryText(episode),
      state: episodeState(episode.kind),
      importance: episodeImportance(episode.kind),
      createdAt: episode.created_at,
    });
  }

  private syncMemoryItemForBranchSnapshot(scopeKey: string): void {
    const snapshot = this.getBranchSnapshot(scopeKey);
    if (!snapshot) {
      return;
    }

    this.upsertMemoryItem({
      id: `branch_snapshots:${snapshot.id}`,
      sessionId: snapshot.last_session_id,
      scopeType: snapshot.branch_ref ? 'branch' : 'detached-head',
      scopeKey: snapshot.scope_key,
      kind: 'branch_snapshot',
      sourceTable: 'branch_snapshots',
      sourceId: snapshot.id,
      subject: snapshot.branch_ref ?? snapshot.focus,
      text: buildBranchSnapshotMemoryText(snapshot),
      state: 'hot',
      importance: 0.92,
      createdAt: snapshot.updated_at,
    });
  }

  private syncMemoryItemForProjectSnapshot(scopeKey: string): void {
    const snapshot = this.getProjectSnapshot(scopeKey);
    if (!snapshot) {
      return;
    }

    this.upsertMemoryItem({
      id: `project_snapshots:${snapshot.id}`,
      scopeType: 'project',
      scopeKey: snapshot.scope_key,
      kind: 'project_snapshot',
      sourceTable: 'project_snapshots',
      sourceId: snapshot.id,
      text: buildProjectSnapshotMemoryText(snapshot.summary, snapshot.note_digest),
      state: 'warm',
      importance: 0.8,
      createdAt: snapshot.updated_at,
    });
  }

  // ── Meta ──────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // ── Sessions ──────────────────────────────────────────────────────

  createSession(opts: CreateSessionOpts = {}): SessionRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (
           id,
           parent_session_id,
           started_at,
           focus,
           agent_type,
           status,
           git_root,
           worktree_path,
           branch_ref,
           head_oid,
           scope_type,
           scope_key
         )
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.parentSessionId ?? null,
        now,
        opts.focus ?? null,
        opts.agentType ?? 'primary',
        opts.gitRoot ?? null,
        opts.worktreePath ?? null,
        opts.branchRef ?? null,
        opts.headOid ?? null,
        opts.scopeType ?? 'project',
        opts.scopeKey ?? null,
      );

    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  getCurrentSession(): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE status = 'active'
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as SessionRow | undefined;
  }

  updateSessionFocus(id: string, focus: string): void {
    this.db
      .prepare('UPDATE sessions SET focus = ? WHERE id = ?')
      .run(focus, id);
  }

  updateSessionScope(
    id: string,
    scope: {
      gitRoot?: string | null;
      worktreePath?: string | null;
      branchRef?: string | null;
      headOid?: string | null;
      scopeType: string;
      scopeKey: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET git_root = ?,
             worktree_path = ?,
             branch_ref = ?,
             head_oid = ?,
             scope_type = ?,
             scope_key = ?
         WHERE id = ?`,
      )
      .run(
        scope.gitRoot ?? null,
        scope.worktreePath ?? null,
        scope.branchRef ?? null,
        scope.headOid ?? null,
        scope.scopeType,
        scope.scopeKey,
        id,
      );
  }

  endSession(id: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  getRecentSessions(limit: number): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(limit) as SessionRow[];
  }

  getRecentSessionsByScope(scopeKey: string, limit: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE scope_key = ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scopeKey, limit) as SessionRow[];
  }

  getSessionCountByScope(scopeKey: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM sessions WHERE scope_key = ?')
      .get(scopeKey) as { count: number };
    return row.count;
  }

  getUnconsolidatedSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.status = 'ended'
           AND NOT EXISTS (
             SELECT 1 FROM state st
             WHERE st.session_id = s.id AND st.layer = 'session'
           )
         ORDER BY s.started_at DESC`,
      )
      .all() as SessionRow[];
  }

  getUnconsolidatedSessionsByScope(scopeKey: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.scope_key = ?
           AND s.status = 'ended'
           AND NOT EXISTS (
             SELECT 1 FROM state st
             WHERE st.session_id = s.id AND st.layer = 'session'
           )
         ORDER BY s.started_at DESC`,
      )
      .all(scopeKey) as SessionRow[];
  }

  getChildSessions(parentId: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE parent_session_id = ?')
      .all(parentId) as SessionRow[];
  }

  getSessionCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM sessions')
      .get() as { count: number };
    return row.count;
  }

  getTableCounts(): TableCounts {
    const count = (tableName: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
        .get() as { count: number };
      return row.count;
    };

    return {
      sessions: count('sessions'),
      events: count('events'),
      notes: count('notes'),
      state: count('state'),
      token_ledger: count('token_ledger'),
      command_runs: count('command_runs'),
      episodes: count('episodes'),
      branch_snapshots: count('branch_snapshots'),
      project_snapshots: count('project_snapshots'),
      memory_items: count('memory_items'),
      retrieval_log: count('retrieval_log'),
    };
  }

  // ── Events ────────────────────────────────────────────────────────

  insertEvent(opts: InsertEventOpts): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadataJson =
      opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO events (id, session_id, timestamp, type, target, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.sessionId, now, opts.type, opts.target ?? null, metadataJson);

    return id;
  }

  getEventsBySession(sessionId: string): ParsedEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC')
      .all(sessionId) as EventRow[];
    return rows.map(parseEventRow);
  }

  getEventsByType(sessionId: string, type: string): ParsedEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY timestamp ASC',
      )
      .all(sessionId, type) as EventRow[];
    return rows.map(parseEventRow);
  }

  getEventCount(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?')
      .get(sessionId) as { count: number };
    return row.count;
  }

  deleteEventsBySession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM events WHERE session_id = ?')
      .run(sessionId);
  }

  insertCommandRun(opts: InsertCommandRunOpts): ParsedCommandRun {
    const id = opts.id ?? crypto.randomUUID();
    const timestamp = opts.timestamp ?? new Date().toISOString();
    const eventId = opts.eventId
      ? (this.db
          .prepare('SELECT id FROM events WHERE id = ?')
          .get(opts.eventId) as { id: string } | undefined)?.id ?? null
      : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO command_runs (
           id,
           session_id,
           event_id,
           timestamp,
           category,
           command_summary,
           exit_code,
           stdout_tail,
           stderr_tail,
           files_touched_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId,
        eventId,
        timestamp,
        opts.category ?? null,
        opts.commandSummary ?? null,
        opts.exitCode ?? null,
        opts.stdoutTail ?? null,
        opts.stderrTail ?? null,
        JSON.stringify(opts.filesTouched ?? []),
      );

    const run = this.getCommandRun(id)!;
    this.syncMemoryItemForCommandRun(id);
    return run;
  }

  getCommandRun(id: string): ParsedCommandRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_runs WHERE id = ?')
      .get(id) as CommandRunRow | undefined;
    return row ? parseCommandRunRow(row) : undefined;
  }

  getCommandRunsBySession(sessionId: string): ParsedCommandRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM command_runs WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
      )
      .all(sessionId) as CommandRunRow[];
    return rows.map(parseCommandRunRow);
  }

  getCommandRunByEvent(eventId: string): ParsedCommandRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_runs WHERE event_id = ?')
      .get(eventId) as CommandRunRow | undefined;
    return row ? parseCommandRunRow(row) : undefined;
  }

  insertEpisode(opts: InsertEpisodeOpts): ParsedEpisode {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();
    const metadataJson =
      opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodes (
           id,
           session_id,
           kind,
           summary,
           target,
           metadata_json,
           source_state_id,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.kind,
        opts.summary,
        opts.target ?? null,
        metadataJson,
        opts.sourceStateId ?? null,
        createdAt,
      );

    const episode = this.getEpisode(id)!;
    this.syncMemoryItemForEpisode(id);
    return episode;
  }

  getEpisode(id: string): ParsedEpisode | undefined {
    const row = this.db
      .prepare('SELECT * FROM episodes WHERE id = ?')
      .get(id) as EpisodeRow | undefined;
    return row ? parseEpisodeRow(row) : undefined;
  }

  getEpisodesBySession(sessionId: string): ParsedEpisode[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId) as EpisodeRow[];
    return rows.map(parseEpisodeRow);
  }

  // ── Notes ─────────────────────────────────────────────────────────

  insertNote(opts: InsertNoteOpts): ParsedNote {
    const kindsRequiringSubject = ['decision', 'intent', 'blocker', 'focus'];
    if (kindsRequiringSubject.includes(opts.kind) && !opts.subject) {
      throw new Error(`Subject is required for ${opts.kind} notes`);
    }

    const subject = opts.subject ? opts.subject.trim().toLowerCase() : null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const alternativesJson =
      opts.alternatives !== undefined ? JSON.stringify(opts.alternatives) : null;

    const supersededIds: string[] = [];

    // Auto-supersede: for decision and intent kinds, supersede existing active notes with same kind+subject
    if ((opts.kind === 'decision' || opts.kind === 'intent') && subject !== null) {
      const existing = this.db
        .prepare(
          `SELECT id FROM notes
           WHERE kind = ? AND subject = ? AND status = 'active'`,
        )
        .all(opts.kind, subject) as Array<{ id: string }>;
      supersededIds.push(...existing.map(row => row.id));
      this.db
        .prepare(
          `UPDATE notes SET status = 'superseded'
           WHERE kind = ? AND subject = ? AND status = 'active'`,
        )
        .run(opts.kind, subject);
    }

    this.db
      .prepare(
        `INSERT INTO notes (id, session_id, timestamp, kind, subject, content, alternatives, status, conflict)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      )
      .run(id, opts.sessionId, now, opts.kind, subject, opts.content, alternativesJson);

    // Side effects for focus updates
    if (opts.kind === 'focus' && subject !== null) {
      this.updateSessionFocus(opts.sessionId, subject);
    } else if (opts.kind === 'intent' && subject !== null) {
      const session = this.getSession(opts.sessionId);
      if (session && session.focus === null) {
        this.updateSessionFocus(opts.sessionId, subject);
      }
    }

    const note = this.getNote(id)!;
    for (const supersededId of supersededIds) {
      this.syncMemoryItemForNote(supersededId);
    }
    this.syncMemoryItemForNote(id);
    return note;
  }

  getNote(id: string): ParsedNote | undefined {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE id = ?')
      .get(id) as NoteRow | undefined;
    return row ? parseNoteRow(row) : undefined;
  }

  getNotesBySession(sessionId: string): ParsedNote[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getActiveNotes(sessionId?: string): ParsedNote[] {
    if (sessionId !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE status = 'active' AND session_id = ? ORDER BY timestamp ASC`,
        )
        .all(sessionId) as NoteRow[];
      return rows.map(parseNoteRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE status = 'active' ORDER BY timestamp ASC`)
      .all() as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getActiveNotesByScope(scopeKey: string): ParsedNote[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
         INNER JOIN sessions s ON s.id = n.session_id
         WHERE n.status = 'active' AND s.scope_key = ?
         ORDER BY n.timestamp ASC`,
      )
      .all(scopeKey) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByKindAndSubject(kind: string, subject: string): ParsedNote[] {
    const normalizedSubject = subject.trim().toLowerCase();
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE kind = ? AND subject = ? ORDER BY timestamp ASC')
      .all(kind, normalizedSubject) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByStatus(status: string): ParsedNote[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE status = ? ORDER BY timestamp ASC')
      .all(status) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByStatusAndScope(status: string, scopeKey: string): ParsedNote[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
         INNER JOIN sessions s ON s.id = n.session_id
         WHERE n.status = ? AND s.scope_key = ?
         ORDER BY n.timestamp ASC`,
      )
      .all(status, scopeKey) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  updateNoteStatus(id: string, status: 'active' | 'superseded' | 'resolved'): void {
    this.db
      .prepare('UPDATE notes SET status = ? WHERE id = ?')
      .run(status, id);
    this.syncMemoryItemForNote(id);
  }

  markConflict(id: string): void {
    this.db
      .prepare('UPDATE notes SET conflict = 1 WHERE id = ?')
      .run(id);
    this.syncMemoryItemForNote(id);
  }

  // ── State ─────────────────────────────────────────────────────────

  insertState(opts: InsertStateOpts): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sessionId = opts.layer === 'project' ? null : (opts.sessionId ?? null);
    this.db
      .prepare(
        `INSERT INTO state (id, session_id, layer, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, opts.layer, opts.content, now);

    if (opts.layer === 'project') {
      const scopeKey = this.getProjectScopeKey();
      if (scopeKey) {
        this.upsertProjectSnapshot({
          id,
          scopeKey,
          summary: opts.content,
          updatedAt: now,
        });
      }
    } else if (sessionId) {
      const scope = this.resolveSessionScope(sessionId);
      if (scope) {
        this.upsertMemoryItem({
          id: `state:${id}`,
          sessionId,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          kind: 'session_state',
          sourceTable: 'state',
          sourceId: id,
          text: opts.content,
          state: 'warm',
          importance: 0.68,
          createdAt: now,
        });
      }
    }

    return id;
  }

  getSessionState(sessionId: string): StateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM state
         WHERE session_id = ? AND layer = 'session'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as StateRow | undefined;
  }

  getProjectState(): StateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM state
         WHERE layer = 'project' AND session_id IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as StateRow | undefined;
  }

  replaceProjectState(content: string): void {
    this.db.prepare(`DELETE FROM state WHERE layer = 'project' AND session_id IS NULL`).run();
    this.insertState({ layer: 'project', content });
  }

  getRecentStates(limit: number): StateRow[] {
    return this.db
      .prepare(
        `SELECT * FROM state WHERE layer = 'session' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as StateRow[];
  }

  getRecentStatesByScope(scopeKey: string, limit: number): StateRow[] {
    return this.db
      .prepare(
        `SELECT st.* FROM state st
         INNER JOIN sessions s ON s.id = st.session_id
         WHERE st.layer = 'session' AND s.scope_key = ?
         ORDER BY st.created_at DESC LIMIT ?`,
      )
      .all(scopeKey, limit) as StateRow[];
  }

  getBranchSnapshot(scopeKey: string): BranchSnapshotRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM branch_snapshots WHERE scope_key = ?')
      .get(scopeKey) as
      | {
          id: string;
          scope_key: string;
          git_root: string | null;
          worktree_path: string | null;
          branch_ref: string | null;
          head_oid: string | null;
          focus: string | null;
          summary: string;
          recent_files_json: string | null;
          intents_json: string | null;
          blockers_json: string | null;
          last_session_id: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      scope_key: row.scope_key,
      git_root: row.git_root,
      worktree_path: row.worktree_path,
      branch_ref: row.branch_ref,
      head_oid: row.head_oid,
      focus: row.focus,
      summary: row.summary,
      recent_files: parseJsonStringArray(row.recent_files_json),
      intents: parseJsonStringArray(row.intents_json),
      blockers: parseJsonStringArray(row.blockers_json),
      last_session_id: row.last_session_id,
      updated_at: row.updated_at,
    };
  }

  upsertBranchSnapshot(opts: UpsertBranchSnapshotOpts): BranchSnapshotRow {
    const existing = this.getBranchSnapshot(opts.scopeKey);
    const id = existing?.id ?? crypto.randomUUID();
    const updatedAt = opts.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO branch_snapshots (
           id,
           scope_key,
           git_root,
           worktree_path,
           branch_ref,
           head_oid,
           focus,
           summary,
           recent_files_json,
           intents_json,
           blockers_json,
           last_session_id,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           git_root = excluded.git_root,
           worktree_path = excluded.worktree_path,
           branch_ref = excluded.branch_ref,
           head_oid = excluded.head_oid,
           focus = excluded.focus,
           summary = excluded.summary,
           recent_files_json = excluded.recent_files_json,
           intents_json = excluded.intents_json,
           blockers_json = excluded.blockers_json,
           last_session_id = excluded.last_session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        opts.scopeKey,
        opts.gitRoot ?? null,
        opts.worktreePath ?? null,
        opts.branchRef ?? null,
        opts.headOid ?? null,
        opts.focus ?? null,
        opts.summary,
        JSON.stringify(opts.recentFiles ?? []),
        JSON.stringify(opts.intents ?? []),
        JSON.stringify(opts.blockers ?? []),
        opts.lastSessionId ?? null,
        updatedAt,
      );

    const snapshot = this.getBranchSnapshot(opts.scopeKey)!;
    this.syncMemoryItemForBranchSnapshot(opts.scopeKey);
    return snapshot;
  }

  getProjectSnapshot(scopeKey: string): ProjectSnapshotRow | undefined {
    return this.db
      .prepare('SELECT * FROM project_snapshots WHERE scope_key = ?')
      .get(scopeKey) as ProjectSnapshotRow | undefined;
  }

  upsertProjectSnapshot(opts: UpsertProjectSnapshotOpts): ProjectSnapshotRow {
    const existing = this.getProjectSnapshot(opts.scopeKey);
    const id = opts.id ?? existing?.id ?? crypto.randomUUID();
    const updatedAt = opts.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO project_snapshots (
           id,
           git_root,
           scope_key,
           summary,
           note_digest,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           id = excluded.id,
           git_root = excluded.git_root,
           summary = excluded.summary,
           note_digest = excluded.note_digest,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        opts.gitRoot ?? null,
        opts.scopeKey,
        opts.summary,
        opts.noteDigest ?? null,
        updatedAt,
      );

    const snapshot = this.getProjectSnapshot(opts.scopeKey)!;
    this.syncMemoryItemForProjectSnapshot(opts.scopeKey);
    return snapshot;
  }

  upsertMemoryItem(opts: UpsertMemoryItemOpts): ParsedMemoryItem {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_items (
           id,
           session_id,
           scope_type,
           scope_key,
           kind,
           source_table,
           source_id,
           subject,
           text,
           state,
           importance,
           access_count,
           last_accessed_at,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           scope_type = excluded.scope_type,
           scope_key = excluded.scope_key,
           kind = excluded.kind,
           source_table = excluded.source_table,
           source_id = excluded.source_id,
           subject = excluded.subject,
           text = excluded.text,
           state = excluded.state,
           importance = excluded.importance,
           access_count = excluded.access_count,
           last_accessed_at = excluded.last_accessed_at,
           created_at = excluded.created_at`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.scopeType,
        opts.scopeKey,
        opts.kind,
        opts.sourceTable ?? null,
        opts.sourceId ?? null,
        opts.subject ?? null,
        opts.text,
        opts.state ?? 'warm',
        opts.importance ?? 0,
        opts.accessCount ?? 0,
        opts.lastAccessedAt ?? null,
        createdAt,
      );

    return this.getMemoryItem(id)!;
  }

  getMemoryItem(id: string): ParsedMemoryItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryItemRow | undefined;
    return row ? parseMemoryItemRow(row) : undefined;
  }

  getMemoryItemBySource(sourceTable: string, sourceId: string): ParsedMemoryItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE source_table = ? AND source_id = ?
         LIMIT 1`,
      )
      .get(sourceTable, sourceId) as MemoryItemRow | undefined;
    return row ? parseMemoryItemRow(row) : undefined;
  }

  listMemoryItemsByScopes(
    scopeKeys: string[],
    limit: number = 100,
    includeArchived: boolean = false,
  ): ParsedMemoryItem[] {
    if (scopeKeys.length === 0) {
      return [];
    }

    const placeholders = scopeKeys.map(() => '?').join(', ');
    const archivedClause = includeArchived ? '' : "AND state != 'archived'";
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE scope_key IN (${placeholders})
           ${archivedClause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...scopeKeys, limit) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  searchMemoryItems(queryText: string, limit: number): SearchMemoryItemResult[] {
    const rows = this.db
      .prepare(
        `SELECT mi.*, bm25(memory_items_fts, 8.0, 1.5) as fts_rank
         FROM memory_items_fts
         INNER JOIN memory_items mi ON mi.rowid = memory_items_fts.rowid
         WHERE memory_items_fts MATCH ?
           AND mi.state != 'archived'
         ORDER BY fts_rank ASC, mi.importance DESC, mi.created_at DESC
         LIMIT ?`,
      )
      .all(queryText, limit) as Array<MemoryItemRow & { fts_rank: number }>;

    return rows.map(row => ({
      ...parseMemoryItemRow(row),
      fts_rank: row.fts_rank,
    }));
  }

  listRecentMemoryItems(limit: number): ParsedMemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE state != 'archived'
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  updateMemoryItemStates(items: UpdateMemoryItemStateOpts[]): void {
    if (items.length === 0) {
      return;
    }

    const update = this.db.prepare(
      `UPDATE memory_items
       SET state = ?
       WHERE id = ?`,
    );

    const tx = this.db.transaction((updates: UpdateMemoryItemStateOpts[]) => {
      for (const item of updates) {
        update.run(item.state, item.id);
      }
    });

    tx(items);
  }

  touchMemoryItems(ids: string[], touchedAt: string = new Date().toISOString()): void {
    const touch = this.db.prepare(
      `UPDATE memory_items
       SET access_count = access_count + 1,
           last_accessed_at = ?,
           state = CASE
             WHEN state IN ('pinned', 'archived') THEN state
             ELSE 'hot'
           END
       WHERE id = ?`,
    );

    const tx = this.db.transaction((memoryIds: string[]) => {
      for (const id of memoryIds) {
        touch.run(touchedAt, id);
      }
    });

    tx(ids);
  }

  insertRetrievalLog(opts: InsertRetrievalLogOpts): ParsedRetrievalLog {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO retrieval_log (
           id,
           session_id,
           topic,
           query_text,
           result_ids_json,
           total_candidates,
           returned_count,
           token_estimate,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.topic,
        opts.queryText ?? null,
        JSON.stringify(opts.resultIds ?? []),
        opts.totalCandidates ?? 0,
        opts.returnedCount ?? 0,
        opts.tokenEstimate ?? 0,
        createdAt,
      );

    return this.getRetrievalLog(id)!;
  }

  getRetrievalLog(id: string): ParsedRetrievalLog | undefined {
    const row = this.db
      .prepare('SELECT * FROM retrieval_log WHERE id = ?')
      .get(id) as RetrievalLogRow | undefined;
    return row ? parseRetrievalLogRow(row) : undefined;
  }

  getRetrievalLogsBySession(sessionId: string): ParsedRetrievalLog[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM retrieval_log
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as RetrievalLogRow[];
    return rows.map(parseRetrievalLogRow);
  }

  // ── Token Ledger ──────────────────────────────────────────────────

  insertLedgerEntry(opts: InsertLedgerOpts): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO token_ledger (id, session_id, type, direction, tokens, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.sessionId, opts.type, opts.direction, opts.tokens, now);
  }

  getLedgerBySession(sessionId: string): LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM token_ledger WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as LedgerRow[];
  }

  getTotalTokens(): { spent: number; saved: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN direction = 'spent' THEN tokens ELSE 0 END) as spent,
           SUM(CASE WHEN direction = 'saved' THEN tokens ELSE 0 END) as saved
         FROM token_ledger`,
      )
      .get() as { spent: number | null; saved: number | null };
    return { spent: row.spent ?? 0, saved: row.saved ?? 0 };
  }

  getLedgerStats(): { spent: number; saved: number; byType: Record<string, { spent: number; saved: number }> } {
    const totals = this.getTotalTokens();
    const rows = this.db
      .prepare(
        `SELECT type, direction, SUM(tokens) as total
         FROM token_ledger
         GROUP BY type, direction`,
      )
      .all() as { type: string; direction: string; total: number }[];

    const byType: Record<string, { spent: number; saved: number }> = {};
    for (const row of rows) {
      if (!byType[row.type]) {
        byType[row.type] = { spent: 0, saved: 0 };
      }
      if (row.direction === 'spent') {
        byType[row.type]!.spent = row.total;
      } else if (row.direction === 'saved') {
        byType[row.type]!.saved = row.total;
      }
    }

    return { ...totals, byType };
  }

  // ── Transactions ──────────────────────────────────────────────────

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
