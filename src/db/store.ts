import type Database from 'better-sqlite3';

// ── Row types (raw DB rows) ───────────────────────────────────────────

export interface SessionRow {
  id: string;
  parent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  focus: string | null;
  agent_type: string;
  status: string;
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

// ── Input types ───────────────────────────────────────────────────────

export interface CreateSessionOpts {
  parentSessionId?: string;
  agentType?: string;
  focus?: string;
}

export interface InsertEventOpts {
  sessionId: string;
  type: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

// ── Helper function ───────────────────────────────────────────────────

export function parseEventRow(row: EventRow): ParsedEvent {
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    type: row.type,
    target: row.target,
    metadata,
  };
}

// ── Store ─────────────────────────────────────────────────────────────

export class CortexStore {
  constructor(private db: Database.Database) {}

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
        `INSERT INTO sessions (id, parent_session_id, started_at, focus, agent_type, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        id,
        opts.parentSessionId ?? null,
        now,
        opts.focus ?? null,
        opts.agentType ?? 'primary',
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

  // ── Events ────────────────────────────────────────────────────────

  insertEvent(opts: InsertEventOpts): void {
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
  }

  getEventsBySession(sessionId: string): ParsedEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC')
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

  // ── Transactions ──────────────────────────────────────────────────

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
