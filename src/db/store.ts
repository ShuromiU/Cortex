import type Database from 'better-sqlite3';

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

    // Auto-supersede: for decision and intent kinds, supersede existing active notes with same kind+subject
    if ((opts.kind === 'decision' || opts.kind === 'intent') && subject !== null) {
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

    return this.getNote(id)!;
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

  updateNoteStatus(id: string, status: 'active' | 'superseded' | 'resolved'): void {
    this.db
      .prepare('UPDATE notes SET status = ? WHERE id = ?')
      .run(status, id);
  }

  markConflict(id: string): void {
    this.db
      .prepare('UPDATE notes SET conflict = 1 WHERE id = ?')
      .run(id);
  }

  // ── State ─────────────────────────────────────────────────────────

  insertState(opts: InsertStateOpts): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sessionId = opts.layer === 'project' ? null : (opts.sessionId ?? null);
    this.db
      .prepare(
        `INSERT INTO state (id, session_id, layer, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, opts.layer, opts.content, now);
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
