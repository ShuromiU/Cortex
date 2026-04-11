import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import {
  CortexStore,
  parseEventRow,
} from '../src/db/store.js';
import type { SessionRow, EventRow } from '../src/db/store.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

// ── Session Tests ─────────────────────────────────────────────────────

describe('CortexStore — sessions', () => {
  let db: Database.Database;
  let store: CortexStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
  });

  it('creates a session and retrieves it', () => {
    const session = store.createSession();
    expect(session.id).toBeTruthy();
    expect(session.status).toBe('active');
    expect(session.agent_type).toBe('primary');
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
    expect(session.focus).toBeNull();
    expect(session.parent_session_id).toBeNull();

    const retrieved = store.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('creates a subagent session with a parent', () => {
    const parent = store.createSession({ agentType: 'primary' });
    const child = store.createSession({
      parentSessionId: parent.id,
      agentType: 'subagent',
    });

    expect(child.parent_session_id).toBe(parent.id);
    expect(child.agent_type).toBe('subagent');
  });

  it('creates a session with focus', () => {
    const session = store.createSession({ focus: 'implement feature X' });
    expect(session.focus).toBe('implement feature X');
  });

  it('updates session focus', () => {
    const session = store.createSession();
    store.updateSessionFocus(session.id, 'new focus');

    const updated = store.getSession(session.id);
    expect(updated!.focus).toBe('new focus');
  });

  it('ends a session', () => {
    const session = store.createSession();
    store.endSession(session.id);

    const ended = store.getSession(session.id);
    expect(ended!.status).toBe('ended');
    expect(ended!.ended_at).toBeTruthy();
  });

  it('returns undefined for non-existent session', () => {
    const result = store.getSession('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('gets the current (most recent active) session', () => {
    store.createSession(); // older
    const latest = store.createSession(); // most recent

    const current = store.getCurrentSession();
    expect(current).toBeDefined();
    expect(current!.id).toBe(latest.id);
  });

  it('getCurrentSession returns undefined when no active sessions', () => {
    const session = store.createSession();
    store.endSession(session.id);

    const current = store.getCurrentSession();
    expect(current).toBeUndefined();
  });

  it('lists recent sessions ordered by started_at DESC', () => {
    const s1 = store.createSession();
    const s2 = store.createSession();
    const s3 = store.createSession();

    const recent = store.getRecentSessions(10);
    expect(recent.length).toBe(3);
    // Most recent first
    expect(recent[0]!.id).toBe(s3.id);
    expect(recent[1]!.id).toBe(s2.id);
    expect(recent[2]!.id).toBe(s1.id);
  });

  it('respects limit in getRecentSessions', () => {
    store.createSession();
    store.createSession();
    store.createSession();

    const recent = store.getRecentSessions(2);
    expect(recent.length).toBe(2);
  });

  it('gets unconsolidated sessions', () => {
    const active = store.createSession();
    const ended = store.createSession();
    store.endSession(ended.id);

    // ended without state entry => unconsolidated
    const unconsolidated = store.getUnconsolidatedSessions();
    expect(unconsolidated.some((s: SessionRow) => s.id === ended.id)).toBe(true);
    // active sessions are NOT unconsolidated
    expect(unconsolidated.some((s: SessionRow) => s.id === active.id)).toBe(false);
  });

  it('excludes consolidated sessions (those with session-layer state) from unconsolidated list', () => {
    const session = store.createSession();
    store.endSession(session.id);

    // Add a 'session' layer state to mark it as consolidated
    db.prepare(
      `INSERT INTO state (id, session_id, layer, content, created_at)
       VALUES (?, ?, 'session', ?, ?)`,
    ).run(crypto.randomUUID(), session.id, '{}', new Date().toISOString());

    const unconsolidated = store.getUnconsolidatedSessions();
    expect(unconsolidated.some((s: SessionRow) => s.id === session.id)).toBe(false);
  });

  it('gets child sessions by parent id', () => {
    const parent = store.createSession();
    const child1 = store.createSession({ parentSessionId: parent.id });
    const child2 = store.createSession({ parentSessionId: parent.id });
    store.createSession(); // unrelated session

    const children = store.getChildSessions(parent.id);
    expect(children.length).toBe(2);
    const childIds = children.map((s: SessionRow) => s.id);
    expect(childIds).toContain(child1.id);
    expect(childIds).toContain(child2.id);
  });

  it('counts sessions', () => {
    expect(store.getSessionCount()).toBe(0);
    store.createSession();
    store.createSession();
    expect(store.getSessionCount()).toBe(2);
  });
});

// ── Event Tests ───────────────────────────────────────────────────────

describe('CortexStore — events', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    const session = store.createSession();
    sessionId = session.id;
  });

  it('inserts and retrieves events', () => {
    store.insertEvent({ sessionId, type: 'tool_call', target: 'readFile' });
    store.insertEvent({ sessionId, type: 'tool_result', target: 'readFile' });

    const events = store.getEventsBySession(sessionId);
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('tool_call');
    expect(events[1]!.type).toBe('tool_result');
  });

  it('generates UUID and timestamp for each event', () => {
    store.insertEvent({ sessionId, type: 'tool_call' });
    const events = store.getEventsBySession(sessionId);

    expect(events[0]!.id).toBeTruthy();
    expect(events[0]!.timestamp).toBeTruthy();
    const ts = new Date(events[0]!.timestamp);
    expect(ts.getTime()).not.toBeNaN();
  });

  it('stores and parses event metadata', () => {
    const metadata = { tool: 'readFile', path: '/foo/bar.ts', success: true };
    store.insertEvent({ sessionId, type: 'tool_call', metadata });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual(metadata);
  });

  it('handles events with no metadata (defaults to empty object)', () => {
    store.insertEvent({ sessionId, type: 'milestone' });
    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({});
  });

  it('filters events by type', () => {
    store.insertEvent({ sessionId, type: 'tool_call', target: 'read' });
    store.insertEvent({ sessionId, type: 'tool_result', target: 'read' });
    store.insertEvent({ sessionId, type: 'tool_call', target: 'write' });

    const calls = store.getEventsByType(sessionId, 'tool_call');
    expect(calls.length).toBe(2);
    expect(calls.every((e) => e.type === 'tool_call')).toBe(true);
  });

  it('counts events in a session', () => {
    expect(store.getEventCount(sessionId)).toBe(0);
    store.insertEvent({ sessionId, type: 'tool_call' });
    store.insertEvent({ sessionId, type: 'tool_call' });
    expect(store.getEventCount(sessionId)).toBe(2);
  });

  it('deletes all events for a session', () => {
    store.insertEvent({ sessionId, type: 'tool_call' });
    store.insertEvent({ sessionId, type: 'tool_result' });
    expect(store.getEventCount(sessionId)).toBe(2);

    store.deleteEventsBySession(sessionId);
    expect(store.getEventCount(sessionId)).toBe(0);
  });

  it('cascades event deletion when session is deleted', () => {
    store.insertEvent({ sessionId, type: 'tool_call' });

    // Directly delete the session row to trigger CASCADE
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    const count = db
      .prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?')
      .get(sessionId) as { count: number };
    expect(count.count).toBe(0);
  });
});

// ── parseEventRow helper ──────────────────────────────────────────────

describe('parseEventRow', () => {
  it('parses valid JSON metadata', () => {
    const raw: EventRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      type: 'tool_call',
      target: null,
      metadata_json: '{"key":"value","num":42}',
    };
    const parsed = parseEventRow(raw);
    expect(parsed.metadata).toEqual({ key: 'value', num: 42 });
  });

  it('returns empty object for null metadata_json', () => {
    const raw: EventRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      type: 'milestone',
      target: null,
      metadata_json: null,
    };
    const parsed = parseEventRow(raw);
    expect(parsed.metadata).toEqual({});
  });

  it('returns empty object for empty string metadata_json', () => {
    const raw: EventRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      type: 'milestone',
      target: null,
      metadata_json: '',
    };
    const parsed = parseEventRow(raw);
    expect(parsed.metadata).toEqual({});
  });
});

// ── Utility methods ───────────────────────────────────────────────────

describe('CortexStore — utility', () => {
  let db: Database.Database;
  let store: CortexStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
  });

  it('gets and sets meta values', () => {
    store.setMeta('my_key', 'my_value');
    expect(store.getMeta('my_key')).toBe('my_value');
  });

  it('returns undefined for missing meta key', () => {
    expect(store.getMeta('nonexistent')).toBeUndefined();
  });

  it('overwrites existing meta value', () => {
    store.setMeta('key', 'old');
    store.setMeta('key', 'new');
    expect(store.getMeta('key')).toBe('new');
  });

  it('runs operations in a transaction', () => {
    const session = store.createSession();
    const result = store.runInTransaction(() => {
      store.insertEvent({ sessionId: session.id, type: 'tool_call' });
      store.insertEvent({ sessionId: session.id, type: 'tool_result' });
      return store.getEventCount(session.id);
    });
    expect(result).toBe(2);
  });
});
