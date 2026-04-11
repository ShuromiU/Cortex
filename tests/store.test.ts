import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import {
  CortexStore,
  parseEventRow,
  parseNoteRow,
} from '../src/db/store.js';
import type { SessionRow, EventRow, NoteRow } from '../src/db/store.js';

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

// ── Note Tests ────────────────────────────────────────────────────────

describe('CortexStore — notes', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    const session = store.createSession();
    sessionId = session.id;
  });

  it('inserts a note and retrieves it', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'insight',
      content: 'This is an insight',
    });
    expect(note.id).toBeTruthy();
    expect(note.session_id).toBe(sessionId);
    expect(note.kind).toBe('insight');
    expect(note.content).toBe('This is an insight');
    expect(note.status).toBe('active');
    expect(note.conflict).toBe(false);
    expect(note.subject).toBeNull();
    expect(note.alternatives).toBeNull();

    const retrieved = store.getNote(note.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(note.id);
  });

  it('requires subject for decision notes', () => {
    expect(() =>
      store.insertNote({ sessionId, kind: 'decision', content: 'A decision' }),
    ).toThrow('Subject is required for decision');
  });

  it('requires subject for intent notes', () => {
    expect(() =>
      store.insertNote({ sessionId, kind: 'intent', content: 'An intent' }),
    ).toThrow('Subject is required for intent');
  });

  it('requires subject for blocker notes', () => {
    expect(() =>
      store.insertNote({ sessionId, kind: 'blocker', content: 'A blocker' }),
    ).toThrow('Subject is required for blocker');
  });

  it('auto-supersedes prior decision with same subject', () => {
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'Use JWT',
    });
    expect(first.status).toBe('active');

    const second = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'Use sessions',
    });
    expect(second.status).toBe('active');

    const superseded = store.getNote(first.id);
    expect(superseded!.status).toBe('superseded');
  });

  it('auto-supersedes prior intent with same subject', () => {
    const first = store.insertNote({
      sessionId,
      kind: 'intent',
      subject: 'database',
      content: 'Use PostgreSQL',
    });

    const second = store.insertNote({
      sessionId,
      kind: 'intent',
      subject: 'database',
      content: 'Use SQLite',
    });
    expect(second.status).toBe('active');

    const superseded = store.getNote(first.id);
    expect(superseded!.status).toBe('superseded');
  });

  it('normalizes subject (case and whitespace)', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: '  Auth Strategy  ',
      content: 'Use JWT',
    });
    expect(note.subject).toBe('auth strategy');
  });

  it('focus note updates session focus', () => {
    store.insertNote({
      sessionId,
      kind: 'focus',
      subject: 'implement login',
      content: 'Working on login feature',
    });
    const session = store.getSession(sessionId);
    expect(session!.focus).toBe('implement login');
  });

  it('first intent sets session focus if none set', () => {
    store.insertNote({
      sessionId,
      kind: 'intent',
      subject: 'refactor auth',
      content: 'Plan to refactor',
    });
    const session = store.getSession(sessionId);
    expect(session!.focus).toBe('refactor auth');
  });

  it('subsequent intent does not override existing focus', () => {
    store.createSession(); // unrelated
    const focusedSession = store.createSession({ focus: 'existing focus' });
    store.insertNote({
      sessionId: focusedSession.id,
      kind: 'intent',
      subject: 'new intent',
      content: 'Some intent',
    });
    const session = store.getSession(focusedSession.id);
    expect(session!.focus).toBe('existing focus');
  });

  it('stores alternatives for decision notes', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'framework',
      content: 'Use React',
      alternatives: ['Vue', 'Svelte'],
    });
    expect(note.alternatives).toEqual(['Vue', 'Svelte']);
  });

  it('gets active notes across sessions', () => {
    const session2 = store.createSession();

    store.insertNote({ sessionId, kind: 'insight', content: 'Insight 1' });
    store.insertNote({ sessionId: session2.id, kind: 'insight', content: 'Insight 2' });

    const activeNotes = store.getActiveNotes();
    expect(activeNotes.length).toBeGreaterThanOrEqual(2);
    expect(activeNotes.every((n) => n.status === 'active')).toBe(true);
  });

  it('filters active notes by session', () => {
    const session2 = store.createSession();

    store.insertNote({ sessionId, kind: 'insight', content: 'Insight for session 1' });
    store.insertNote({ sessionId: session2.id, kind: 'insight', content: 'Insight for session 2' });

    const session1Notes = store.getActiveNotes(sessionId);
    expect(session1Notes.length).toBe(1);
    expect(session1Notes[0]!.content).toBe('Insight for session 1');
  });

  it('resolves a blocker', () => {
    const blocker = store.insertNote({
      sessionId,
      kind: 'blocker',
      subject: 'auth issue',
      content: 'Cannot authenticate',
    });
    expect(blocker.status).toBe('active');

    store.updateNoteStatus(blocker.id, 'resolved');
    const resolved = store.getNote(blocker.id);
    expect(resolved!.status).toBe('resolved');
  });

  it('gets notes by status', () => {
    const note1 = store.insertNote({ sessionId, kind: 'insight', content: 'Insight 1' });
    store.insertNote({ sessionId, kind: 'insight', content: 'Insight 2' });
    store.updateNoteStatus(note1.id, 'resolved');

    const resolved = store.getNotesByStatus('resolved');
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.id).toBe(note1.id);
  });

  it('gets notes by kind and subject', () => {
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'DB Engine',
      content: 'First decision',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'DB Engine',
      content: 'Second decision',
    });
    // Different subject
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth',
      content: 'Auth decision',
    });

    const results = store.getNotesByKindAndSubject('decision', 'db engine');
    // The first gets superseded by the second, but both should be returned
    expect(results.length).toBe(2);
    expect(results.every((n) => n.kind === 'decision')).toBe(true);
    expect(results.every((n) => n.subject === 'db engine')).toBe(true);
  });

  it('marks a note as conflict', () => {
    const note = store.insertNote({ sessionId, kind: 'insight', content: 'Conflicting insight' });
    expect(note.conflict).toBe(false);

    store.markConflict(note.id);
    const updated = store.getNote(note.id);
    expect(updated!.conflict).toBe(true);
  });

  it('gets notes by session ordered by timestamp ASC', () => {
    const n1 = store.insertNote({ sessionId, kind: 'insight', content: 'First' });
    const n2 = store.insertNote({ sessionId, kind: 'insight', content: 'Second' });

    const notes = store.getNotesBySession(sessionId);
    expect(notes.length).toBe(2);
    expect(notes[0]!.id).toBe(n1.id);
    expect(notes[1]!.id).toBe(n2.id);
  });
});

// ── parseNoteRow helper ───────────────────────────────────────────────

describe('parseNoteRow', () => {
  it('parses alternatives JSON', () => {
    const raw: NoteRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      kind: 'decision',
      subject: 'topic',
      content: 'The choice',
      alternatives: '["Option A","Option B"]',
      status: 'active',
      conflict: 0,
    };
    const parsed = parseNoteRow(raw);
    expect(parsed.alternatives).toEqual(['Option A', 'Option B']);
    expect(parsed.conflict).toBe(false);
  });

  it('returns null for null alternatives', () => {
    const raw: NoteRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      kind: 'insight',
      subject: null,
      content: 'An insight',
      alternatives: null,
      status: 'active',
      conflict: 0,
    };
    const parsed = parseNoteRow(raw);
    expect(parsed.alternatives).toBeNull();
    expect(parsed.conflict).toBe(false);
  });

  it('converts conflict integer to boolean', () => {
    const raw: NoteRow = {
      id: 'test-id',
      session_id: 'sess-id',
      timestamp: new Date().toISOString(),
      kind: 'insight',
      subject: null,
      content: 'Conflicting',
      alternatives: null,
      status: 'active',
      conflict: 1,
    };
    const parsed = parseNoteRow(raw);
    expect(parsed.conflict).toBe(true);
  });
});

// ── State Tests ───────────────────────────────────────────────────────

describe('CortexStore — state', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    const session = store.createSession();
    sessionId = session.id;
  });

  it('inserts and retrieves session state', () => {
    store.insertState({ sessionId, layer: 'session', content: '{"key":"value"}' });
    const state = store.getSessionState(sessionId);
    expect(state).toBeDefined();
    expect(state!.session_id).toBe(sessionId);
    expect(state!.layer).toBe('session');
    expect(state!.content).toBe('{"key":"value"}');
    expect(state!.id).toBeTruthy();
    expect(state!.created_at).toBeTruthy();
  });

  it('inserts and retrieves project-level state (session_id null)', () => {
    store.insertState({ layer: 'project', content: '{"project":"data"}' });
    const state = store.getProjectState();
    expect(state).toBeDefined();
    expect(state!.session_id).toBeNull();
    expect(state!.layer).toBe('project');
    expect(state!.content).toBe('{"project":"data"}');
  });

  it('replaces project state', () => {
    store.insertState({ layer: 'project', content: 'old content' });
    store.insertState({ layer: 'project', content: 'another old content' });
    store.replaceProjectState('new content');

    const state = store.getProjectState();
    expect(state!.content).toBe('new content');

    // Verify old entries are gone
    const allProjectStates = db
      .prepare(`SELECT * FROM state WHERE layer = 'project' AND session_id IS NULL`)
      .all();
    expect(allProjectStates.length).toBe(1);
  });

  it('lists recent session-layer states', () => {
    const session2 = store.createSession();
    store.insertState({ sessionId, layer: 'session', content: 'state 1' });
    store.insertState({ sessionId: session2.id, layer: 'session', content: 'state 2' });
    // Project-layer state should NOT be included
    store.insertState({ layer: 'project', content: 'project state' });

    const recent = store.getRecentStates(10);
    expect(recent.length).toBe(2);
    expect(recent.every((s) => s.layer === 'session')).toBe(true);
  });

  it('respects limit in getRecentStates', () => {
    const session2 = store.createSession();
    const session3 = store.createSession();
    store.insertState({ sessionId, layer: 'session', content: 'state 1' });
    store.insertState({ sessionId: session2.id, layer: 'session', content: 'state 2' });
    store.insertState({ sessionId: session3.id, layer: 'session', content: 'state 3' });

    const recent = store.getRecentStates(2);
    expect(recent.length).toBe(2);
  });

  it('returns undefined for missing session state', () => {
    const state = store.getSessionState('nonexistent');
    expect(state).toBeUndefined();
  });

  it('returns undefined for missing project state', () => {
    const state = store.getProjectState();
    expect(state).toBeUndefined();
  });
});

// ── Token Ledger Tests ────────────────────────────────────────────────

describe('CortexStore — token ledger', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    const session = store.createSession();
    sessionId = session.id;
  });

  it('records a ledger entry and retrieves by session', () => {
    store.insertLedgerEntry({
      sessionId,
      type: 'tool_call',
      direction: 'spent',
      tokens: 150,
    });

    const entries = store.getLedgerBySession(sessionId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.session_id).toBe(sessionId);
    expect(entries[0]!.type).toBe('tool_call');
    expect(entries[0]!.direction).toBe('spent');
    expect(entries[0]!.tokens).toBe(150);
    expect(entries[0]!.id).toBeTruthy();
    expect(entries[0]!.timestamp).toBeTruthy();
  });

  it('computes total tokens spent and saved', () => {
    const session2 = store.createSession();

    store.insertLedgerEntry({ sessionId, type: 'tool_call', direction: 'spent', tokens: 100 });
    store.insertLedgerEntry({ sessionId, type: 'cache', direction: 'saved', tokens: 300 });
    store.insertLedgerEntry({ sessionId: session2.id, type: 'tool_call', direction: 'spent', tokens: 50 });

    const totals = store.getTotalTokens();
    expect(totals.spent).toBe(150);
    expect(totals.saved).toBe(300);
  });

  it('returns zero totals when no entries exist', () => {
    const totals = store.getTotalTokens();
    expect(totals.spent).toBe(0);
    expect(totals.saved).toBe(0);
  });

  it('computes ledger stats with per-type breakdown', () => {
    store.insertLedgerEntry({ sessionId, type: 'tool_call', direction: 'spent', tokens: 100 });
    store.insertLedgerEntry({ sessionId, type: 'tool_call', direction: 'spent', tokens: 50 });
    store.insertLedgerEntry({ sessionId, type: 'cache', direction: 'saved', tokens: 400 });
    store.insertLedgerEntry({ sessionId, type: 'prompt', direction: 'spent', tokens: 200 });

    const stats = store.getLedgerStats();
    expect(stats.spent).toBe(350);
    expect(stats.saved).toBe(400);
    expect(stats.byType['tool_call']!.spent).toBe(150);
    expect(stats.byType['tool_call']!.saved).toBe(0);
    expect(stats.byType['cache']!.saved).toBe(400);
    expect(stats.byType['cache']!.spent).toBe(0);
    expect(stats.byType['prompt']!.spent).toBe(200);
  });

  it('gets empty ledger for session with no entries', () => {
    const entries = store.getLedgerBySession(sessionId);
    expect(entries).toEqual([]);
  });
});
