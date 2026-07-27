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
    expect(session.scope_type).toBe('project');
    expect(session.scope_key).toBeNull();
    expect(session.git_root).toBeNull();

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

  it('creates a session with explicit scope metadata', () => {
    const session = store.createSession({
      focus: 'fix auth',
      gitRoot: '/repo',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'abc123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo:feature/auth',
    });

    expect(session.git_root).toBe('/repo');
    expect(session.worktree_path).toBe('/repo');
    expect(session.branch_ref).toBe('feature/auth');
    expect(session.head_oid).toBe('abc123');
    expect(session.scope_type).toBe('branch');
    expect(session.scope_key).toBe('branch:/repo:feature/auth');
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

  it('records agent_id on a session and round-trips it', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    expect(primary.agent_id).toBeNull();

    const child = store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      agentType: 'Explore',
      scopeKey: 'project:/repo',
    });

    expect(child.agent_id).toBe('agent-abc');
    expect(child.agent_type).toBe('Explore');
    expect(child.parent_session_id).toBe(primary.id);
    expect(store.getSession(child.id)?.agent_id).toBe('agent-abc');
  });

  it('finds a session by (scope_key, agent_id)', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    const child = store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    expect(store.getSessionByAgentId('project:/repo', 'agent-abc')?.id).toBe(child.id);
    expect(store.getSessionByAgentId('project:/repo', 'agent-missing')).toBeUndefined();
  });

  it('does not resolve an agent_id across scope boundaries', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    expect(store.getSessionByAgentId('project:/other', 'agent-abc')).toBeUndefined();
  });

  it('finds a child by agent_id after its parent has ended', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    const child = store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });
    store.endSession(primary.id);

    expect(store.getSessionByAgentId('project:/repo', 'agent-abc')?.id).toBe(child.id);
  });

  it('getCurrentSession skips active child sessions', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    expect(store.getCurrentSession()?.id).toBe(primary.id);
  });

  it('rejects a duplicate (scope_key, agent_id) pair', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    expect(() =>
      store.createSession({
        parentSessionId: primary.id,
        agentId: 'agent-abc',
        scopeKey: 'project:/repo',
      }),
    ).toThrow();

    // Primary sessions carry a NULL agent_id and stay unconstrained.
    expect(() => store.createSession({ scopeKey: 'project:/repo' })).not.toThrow();
  });

  it('endSessionTree ends a session together with its active children', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    const child = store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    store.endSessionTree(primary.id);

    expect(store.getSession(primary.id)?.status).toBe('ended');
    expect(store.getSession(child.id)?.status).toBe('ended');
    expect(store.getSession(child.id)?.ended_at).toBeTruthy();
  });

  it('getRecentPrimarySessions excludes children that sort ahead of their parent', () => {
    const primary = store.createSession({ scopeKey: 'project:/repo' });
    store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeKey: 'project:/repo',
    });

    expect(store.getRecentSessions(1)[0]?.agent_id).toBe('agent-abc');
    expect(store.getRecentPrimarySessions(1)[0]?.id).toBe(primary.id);
  });

  it('excludes child sessions from scope listings and counts', () => {
    const primary = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:main',
      branchRef: 'main',
    });
    store.createSession({
      parentSessionId: primary.id,
      agentId: 'agent-abc',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:main',
      branchRef: 'main',
    });

    const recent = store.getRecentSessionsByScope('branch:/repo/.git:/repo:main', 10);
    expect(recent.map(session => session.id)).toEqual([primary.id]);
    expect(store.getSessionCountByScope('branch:/repo/.git:/repo:main')).toBe(1);
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

  it('lists recent sessions within a scope', () => {
    const main1 = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:main',
      branchRef: 'main',
    });
    store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
      branchRef: 'feature/auth',
    });
    const main2 = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:main',
      branchRef: 'main',
    });

    const recent = store.getRecentSessionsByScope('branch:/repo/.git:/repo:main', 10);
    expect(recent.length).toBe(2);
    expect(recent[0]!.id).toBe(main2.id);
    expect(recent[1]!.id).toBe(main1.id);
    expect(store.getSessionCountByScope('branch:/repo/.git:/repo:main')).toBe(2);
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

  it('returns counts for core, v2, and current-truth tables', () => {
    const counts = store.getTableCounts();
    expect(counts.sessions).toBe(0);
    expect(counts.command_runs).toBe(0);
    expect(counts.episodes).toBe(0);
    expect(counts.branch_snapshots).toBe(0);
    expect(counts.project_snapshots).toBe(0);
    expect(counts.memory_items).toBe(0);
    expect(counts.memory_item_semantics).toBe(0);
    expect(counts.current_app_graphs).toBe(0);
    expect(counts.memory_references).toBe(0);
    expect(counts.retrieval_log).toBe(0);
  });

  it('upserts and retrieves branch snapshots', () => {
    const snapshot = store.upsertBranchSnapshot({
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'abc123',
      focus: 'auth',
      summary: 'Auth branch summary',
      recentFiles: ['src/auth.ts'],
      intents: ['[auth] Finish the refactor'],
      blockers: ['[auth] Fix test failures'],
      lastSessionId: null,
    });

    expect(snapshot.branch_ref).toBe('feature/auth');
    expect(snapshot.recent_files).toEqual(['src/auth.ts']);

    const updated = store.upsertBranchSnapshot({
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'def456',
      focus: 'auth',
      summary: 'Updated auth branch summary',
      recentFiles: ['src/auth.ts', 'src/session.ts'],
      intents: ['[auth] Finish the refactor'],
      blockers: [],
      lastSessionId: null,
    });

    expect(updated.summary).toContain('Updated');
    expect(updated.recent_files).toContain('src/session.ts');
    expect(store.getBranchSnapshot('branch:/repo/.git:/repo:feature/auth')?.head_oid).toBe('def456');
  });

  it('creates memory items for notes, command runs, episodes, and branch snapshots', () => {
    const session = store.createSession({
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'abc123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
    });

    const note = store.insertNote({
      sessionId: session.id,
      kind: 'blocker',
      subject: 'auth',
      content: 'Refresh tokens are failing in staging.',
    });
    const run = store.insertCommandRun({
      sessionId: session.id,
      category: 'test',
      commandSummary: 'vitest run auth',
      exitCode: 1,
      stderrTail: 'authorization denied',
    });
    const episode = store.insertEpisode({
      sessionId: session.id,
      kind: 'command_failure',
      summary: 'test failed: vitest run auth (exit 1)',
      metadata: { stderr_tail: 'authorization denied' },
    });
    const snapshot = store.upsertBranchSnapshot({
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'abc123',
      focus: 'auth',
      summary: 'Auth gateway work in progress',
      recentFiles: ['src/auth.ts'],
      intents: ['[auth] Finish refresh rotation'],
      blockers: ['[auth] Fix staging token failures'],
      lastSessionId: session.id,
    });

    expect(store.getMemoryItemBySource('notes', note.id)?.kind).toBe('note:blocker');
    expect(store.getMemoryItemBySource('command_runs', run.id)?.text).toContain('authorization denied');
    expect(store.getMemoryItemBySource('episodes', episode.id)?.state).toBe('hot');
    expect(store.getMemoryItemBySource('branch_snapshots', snapshot.id)?.text).toContain('Auth gateway work in progress');
  });

  it('inserts and retrieves command runs', () => {
    const session = store.createSession();
    const eventId = store.insertEvent({ sessionId: session.id, type: 'cmd' });
    const run = store.insertCommandRun({
      sessionId: session.id,
      eventId,
      category: 'test',
      commandSummary: 'vitest run',
      exitCode: 1,
      stdoutTail: 'stdout tail',
      stderrTail: 'stderr tail',
      filesTouched: ['src/auth.ts'],
    });

    expect(run.category).toBe('test');
    expect(run.files_touched).toEqual(['src/auth.ts']);
    expect(store.getCommandRunByEvent(eventId)?.stderr_tail).toBe('stderr tail');
    expect(store.getCommandRunsBySession(session.id)).toHaveLength(1);
  });

  it('inserts and retrieves episodes', () => {
    const session = store.createSession();
    const episode = store.insertEpisode({
      sessionId: session.id,
      kind: 'command_failure',
      summary: 'test failed: vitest run (exit 1)',
      target: 'src/auth.ts',
      metadata: { exit_code: 1 },
    });

    expect(episode.kind).toBe('command_failure');
    expect(episode.metadata.exit_code).toBe(1);
    expect(store.getEpisodesBySession(session.id)).toHaveLength(1);
  });

  it('searches and touches memory items through FTS', () => {
    const session = store.createSession({
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/reports',
      headOid: 'abc123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/reports',
    });
    const note = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'reports',
      content: 'Ship the reports rewrite behind a feature flag.',
    });

    const results = store.searchMemoryItems('reports* OR flag*', 5);
    expect(results.map(item => item.id)).toContain(`notes:${note.id}`);

    store.touchMemoryItems([`notes:${note.id}`]);
    expect(store.getMemoryItemBySource('notes', note.id)?.access_count).toBe(1);
  });

  it('records retrieval log entries', () => {
    const session = store.createSession();
    const log = store.insertRetrievalLog({
      sessionId: session.id,
      topic: 'auth',
      queryText: 'auth*',
      resultIds: ['notes:1'],
      totalCandidates: 3,
      returnedCount: 1,
      tokenEstimate: 42,
    });

    expect(log.topic).toBe('auth');
    expect(log.result_ids).toEqual(['notes:1']);
    expect(store.getRetrievalLogsBySession(session.id)).toHaveLength(1);
  });

  it('upserts and searches semantic metadata for memory items', () => {
    const session = store.createSession({
      scopeType: 'project',
      scopeKey: 'project:/repo',
    });
    const note = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      subject: 'auth cache',
      content: 'Memoize permission checks in the auth service.',
    });
    const memoryItemId = `notes:${note.id}`;

    const semantic = store.upsertMemoryItemSemantic({
      memoryItemId,
      summary: 'Authentication permission cache',
      concepts: ['authentication', 'authorization', 'cache'],
      entities: ['AuthService'],
      embeddingModel: 'fake-v1',
      embedding: [1, 0],
      sourceHash: 'hash-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(semantic.memory_item_id).toBe(memoryItemId);
    expect(semantic.concepts).toEqual(['authentication', 'authorization', 'cache']);
    expect(store.getMemoryItemSemantic(memoryItemId)?.embedding).toEqual([1, 0]);

    store.upsertMemoryItemSemantic({
      memoryItemId,
      summary: 'Updated authentication cache',
      concepts: ['authentication', 'cache'],
      entities: [],
      embeddingModel: 'fake-v1',
      embedding: [0.8, 0.2],
      sourceHash: 'hash-2',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });

    expect(store.getMemoryItemSemantic(memoryItemId)?.source_hash).toBe('hash-2');

    const results = store.searchMemoryItemSemantics([1, 0], 5);
    expect(results[0]?.id).toBe(memoryItemId);
    expect(results[0]?.semantic_score).toBeCloseTo(0.9701, 4);
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

  it('does not reheat resolved notes when touching memory items', () => {
    const blocker = store.insertNote({
      sessionId,
      kind: 'blocker',
      subject: 'npm-run-lint-broken',
      content: '`npm run lint` used to call next lint.',
    });
    store.updateNoteStatus(blocker.id, 'resolved');

    const item = store.getMemoryItemBySource('notes', blocker.id)!;
    expect(item.state).toBe('cold');

    store.touchMemoryItems([item.id], '2026-04-13T12:00:00.000Z');

    const touched = store.getMemoryItemBySource('notes', blocker.id)!;
    expect(touched.state).toBe('cold');
    expect(touched.access_count).toBe(item.access_count + 1);
    expect(touched.last_accessed_at).toBe('2026-04-13T12:00:00.000Z');
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

// ── Contradiction detection at write time (FR-1, story 1.1) ───────────

describe('CortexStore — contradiction detection on insertNote', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    sessionId = store.createSession().id;
  });

  function memoryStateFor(noteId: string): string | undefined {
    const row = db
      .prepare('SELECT state FROM memory_items WHERE source_id = ? AND source_table = ?')
      .get(noteId, 'notes') as { state: string } | undefined;
    return row?.state;
  }

  it('returns a payload naming the prior id, subject, timestamp and text', () => {
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });

    const next = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    expect(next.conflicts).toHaveLength(1);
    expect(next.conflicts![0]).toEqual({
      id: prior.id,
      subject: 'spool flush',
      timestamp: prior.timestamp,
      content: prior.content,
      signal: 'negation',
    });
  });

  it('sets conflict = 1 on both the prior and the new note', () => {
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });
    const next = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    expect(store.getNote(prior.id)!.conflict).toBe(true);
    expect(store.getNote(next.id)!.conflict).toBe(true);
  });

  it('vetoes the auto-supersede so the contested prior stays active (AD-17)', () => {
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    expect(store.getNote(prior.id)!.status).toBe('active');
  });

  it('keeps the contested prior out of the archived tier', () => {
    // The point of the veto: `memoryStateForNote` maps 'superseded' to
    // 'archived', which would bury one side of the contest at write time.
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    expect(memoryStateFor(prior.id)).not.toBe('archived');
  });

  it('still supersedes a non-contradicting decision on the same subject', () => {
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'use postgres for the primary store',
    });
    const next = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'use mysql for the primary store',
    });

    expect(next.conflicts).toBeUndefined();
    expect(store.getNote(prior.id)!.status).toBe('superseded');
    expect(memoryStateFor(prior.id)).toBe('archived');
  });

  it('detects a non-decision note contradicting a prior decision', () => {
    // AC #1 is asymmetric: the prior must be a decision, the incoming note
    // may be any kind.
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });
    const insight = store.insertNote({
      sessionId,
      kind: 'insight',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    expect(insight.conflicts).toHaveLength(1);
  });

  it('produces no conflict when the subject has no active decision', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brand new subject',
      content: 'we do not cache anything on this path',
    });
    expect(note.conflicts).toBeUndefined();
  });

  it('ignores superseded decisions as contradiction candidates', () => {
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'we cache the rendered brief between runs',
    });
    // Divergent choice — supersedes without contest.
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'use mysql for the primary store',
    });
    expect(store.getNote(first.id)!.status).toBe('superseded');

    // Contradicts the now-superseded note, but it is no longer active.
    const third = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'we do not cache the rendered brief between runs',
    });
    expect(third.conflicts).toBeUndefined();
  });

  it('issues no conflict query for a note written with no subject (AC #2)', () => {
    const prepared: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    // @ts-expect-error — narrowing the better-sqlite3 overloads is not worth it here
    db.prepare = (sql: string) => {
      prepared.push(sql);
      return originalPrepare(sql);
    };

    try {
      store.insertNote({ sessionId, kind: 'insight', content: 'a subjectless insight' });
    } finally {
      db.prepare = originalPrepare;
    }

    // Match on shape, not on the literal `kind = 'decision'`: parameterizing
    // the detection lookup would make a literal filter silently vacuous.
    const subjectLookups = prepared.filter(
      sql => /FROM notes/.test(sql) && sql.includes('subject = ?'),
    );
    expect(subjectLookups).toEqual([]);
  });

  it('issues exactly one conflict query for a subject-bearing decision', () => {
    // Guards the "reuse the lookup" requirement: detection and the supersede
    // veto must share a single round-trip, not take one each.
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });

    const prepared: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    // @ts-expect-error — narrowing the better-sqlite3 overloads is not worth it here
    db.prepare = (sql: string) => {
      prepared.push(sql);
      return originalPrepare(sql);
    };

    try {
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'the flush does not validate spooled entries before replay',
      });
    } finally {
      db.prepare = originalPrepare;
    }

    // Match on the shape rather than the literal `kind = 'decision'`: the
    // supersede lookup this must NOT issue is parameterized (`kind = ?`), so a
    // literal filter would let a second round-trip through unnoticed.
    const subjectLookups = prepared.filter(
      sql => /FROM notes/.test(sql) && sql.includes('subject = ?'),
    );
    expect(subjectLookups).toHaveLength(1);
  });
});

describe('CortexStore — contradiction detection cost (AC #4)', () => {
  it('adds under 5 ms to a write against 10,000 memory items', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const sessionId = store.createSession().id;

    // Seed 10,000 memory items. `memory_items` is the table AC #4 names and the
    // one that actually grows; the notes lookup rides `idx_notes_kind_subject`
    // regardless of its size.
    const insertItem = db.prepare(
      `INSERT INTO memory_items (id, session_id, scope_type, scope_key, kind, text, state, importance, created_at)
       VALUES (?, ?, 'project', 'project:/perf', ?, ?, 'warm', 0.5, ?)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        insertItem.run(`perf:${i}`, sessionId, 'episode:command_failure', `filler item ${i}`, now);
      }
    })();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM memory_items').get() as { n: number };
    expect(n).toBeGreaterThanOrEqual(10_000);

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });

    // A/B on `insight`, which never auto-supersedes — so the only difference
    // between the two arms is contradiction detection itself. The subjectless
    // arm issues no conflict query at all (AC #2).
    const ITERATIONS = 60;
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };

    const withDetection: number[] = [];
    const withoutDetection: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      let start = performance.now();
      store.insertNote({
        sessionId,
        kind: 'insight',
        subject: 'spool flush',
        content: 'the flush does not validate spooled entries before replay',
      });
      withDetection.push(performance.now() - start);

      start = performance.now();
      store.insertNote({ sessionId, kind: 'insight', content: 'a subjectless insight' });
      withoutDetection.push(performance.now() - start);
    }

    const overhead = median(withDetection) - median(withoutDetection);
    expect(overhead).toBeLessThan(5);
  });
});

// ── Review regressions: write path (story 1.1, round 2) ──────────────

describe('CortexStore — the AD-17 veto holds over time', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    sessionId = store.createSession({ scopeKey: 'branch:/repo:main' }).id;
  });

  function memoryStateFor(noteId: string): string | undefined {
    const row = db
      .prepare('SELECT state FROM memory_items WHERE source_id = ? AND source_table = ?')
      .get(noteId, 'notes') as { state: string } | undefined;
    return row?.state;
  }

  function openContest(): { a: string; b: string } {
    const a = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const b = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    expect(b.conflicts).toHaveLength(1);
    return { a: a.id, b: b.id };
  }

  it('a later unrelated decision does not close an open contest', () => {
    // The veto set was built only from conflicts detected against the incoming
    // write, so an already-contested prior was unprotected: a third,
    // non-contradicting decision superseded and archived BOTH sides of the
    // open contest — the exact outcome the veto exists to prevent.
    const { a, b } = openContest();

    const third = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'use redis for storing rendered artifacts instead',
    });
    expect(third.conflicts).toBeUndefined();

    expect(store.getNote(a)!.status).toBe('active');
    expect(store.getNote(b)!.status).toBe('active');
    expect(memoryStateFor(a)).not.toBe('archived');
    expect(memoryStateFor(b)).not.toBe('archived');
  });

  it('survives a run of unrelated decisions, not just one', () => {
    const { a, b } = openContest();
    for (const content of [
      'use redis for storing rendered artifacts instead',
      'the artifact directory lives under the user home',
      'compression happens before the digest is taken',
    ]) {
      store.insertNote({ sessionId, kind: 'decision', subject: 'brief caching', content });
    }
    expect(store.getNote(a)!.status).toBe('active');
    expect(store.getNote(b)!.status).toBe('active');
  });

  it('still supersedes a non-contested prior', () => {
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'use postgres for the primary store',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'primary store',
      content: 'use mysql for the primary store',
    });
    expect(store.getNote(first.id)!.status).toBe('superseded');
    expect(memoryStateFor(first.id)).toBe('archived');
  });

  it('uses an IMMEDIATE transaction, not the deferred default', () => {
    // db.transaction() is deferred: it takes the write lock lazily, so a
    // read-then-write that reads before a concurrent writer commits fails the
    // upgrade with SQLITE_BUSY_SNAPSHOT — which bypasses the busy handler, so
    // busy_timeout never applies. That loses the veto AND discards the note.
    const modes: string[] = [];
    const originalTransaction = db.transaction.bind(db);
    // @ts-expect-error — narrowing better-sqlite3's overloads is not worth it here
    db.transaction = (fn: () => unknown) => {
      const tx = originalTransaction(fn);
      const wrapped = (...args: unknown[]) => {
        modes.push('deferred');
        return (tx as unknown as (...a: unknown[]) => unknown)(...args);
      };
      wrapped.immediate = (...args: unknown[]) => {
        modes.push('immediate');
        return (tx.immediate as unknown as (...a: unknown[]) => unknown)(...args);
      };
      return wrapped;
    };
    try {
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'brief caching',
        content: 'we cache the rendered session brief between runs',
      });
    } finally {
      db.transaction = originalTransaction;
    }
    // The OUTERMOST transaction must be immediate. Nested ones (the
    // memory_references upsert) become savepoints inside it and are unaffected.
    expect(modes[0]).toBe('immediate');
  });

  it('performs the note INSERT inside a transaction', () => {
    // Detect -> supersede -> insert -> mark are four statements. Without a
    // transaction a concurrent writer landing between the detection SELECT and
    // the supersede UPDATE supersedes the row this write just protected.
    // Asserting on `inTransaction` at the moment of the write tests the
    // property; counting `db.transaction` calls would only count nesting.
    const inTransactionAtInsert: boolean[] = [];
    const originalPrepare = db.prepare.bind(db);
    // @ts-expect-error — narrowing better-sqlite3's overloads is not worth it here
    db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (!/^\s*INSERT INTO notes/.test(sql)) return statement;
      const originalRun = statement.run.bind(statement);
      // @ts-expect-error — same
      statement.run = (...args: unknown[]) => {
        inTransactionAtInsert.push(db.inTransaction);
        return originalRun(...(args as []));
      };
      return statement;
    };
    try {
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'brief caching',
        content: 'we cache the rendered session brief between runs',
      });
    } finally {
      db.prepare = originalPrepare;
    }
    expect(inTransactionAtInsert).toEqual([true]);
  });
});

describe('CortexStore — skipConflictDetection', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    store = new CortexStore(createTestDb());
    sessionId = store.createSession({ scopeKey: 'branch:/repo:main' }).id;
  });

  it('suppresses detection entirely for an explicit resolution write', () => {
    // cortex_resolve(replacement) writes while the note being replaced is
    // still active, and a replacement that reverses its predecessor is the
    // common shape — so without this the resolution manufactures the very
    // contest it exists to close.
    const prior = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });

    const replacement = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
      skipConflictDetection: true,
    });

    expect(replacement.conflicts).toBeUndefined();
    expect(store.getNote(replacement.id)!.conflict).toBe(false);
    expect(store.getNote(prior.id)!.conflict).toBe(false);
  });

  it('the same write DOES contest without the flag', () => {
    // Pins that the flag is what suppresses it, not the content.
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const contested = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    expect(contested.conflicts).toHaveLength(1);
  });
});

describe('CortexStore — contradiction detection is scope-aware', () => {
  let db: Database.Database;
  let store: CortexStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
  });

  it('does not contest a decision made on another branch', () => {
    // Two branches holding opposite decisions is the ordinary reason branches
    // exist, and the contest marker would surface in the other branch's
    // working set.
    const main = store.createSession({ scopeKey: 'branch:/repo:main' });
    const feature = store.createSession({ scopeKey: 'branch:/repo:feature' });

    const onMain = store.insertNote({
      sessionId: main.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const onFeature = store.insertNote({
      sessionId: feature.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });

    expect(onFeature.conflicts).toBeUndefined();
    expect(store.getNote(onMain.id)!.conflict).toBe(false);
  });

  it('still contests within the same scope', () => {
    const first = store.createSession({ scopeKey: 'branch:/repo:main' });
    const second = store.createSession({ scopeKey: 'branch:/repo:main' });
    store.insertNote({
      sessionId: first.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const contested = store.insertNote({
      sessionId: second.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    expect(contested.conflicts).toHaveLength(1);
  });

  it('a decision on one branch cannot bury an open contest on another', () => {
    // The veto set is deliberately NOT scope-filtered even though detection is.
    // Auto-supersede is scope-blind, so without this a feature-branch decision
    // supersedes — and `memoryStateForNote` therefore archives — one side of a
    // contest main has not settled. The branch's own supersede chain still
    // works; only the other branch's contested notes are protected.
    const main = store.createSession({ scopeKey: 'branch:/repo:main' });
    const feature = store.createSession({ scopeKey: 'branch:/repo:feature' });

    store.insertNote({
      sessionId: main.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const contested = store.insertNote({
      sessionId: main.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    expect(contested.conflicts).toHaveLength(1);

    const onFeature = store.insertNote({
      sessionId: feature.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'store rendered artifacts under the user home directory',
    });
    store.insertNote({
      sessionId: feature.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'store rendered artifacts inside the repository cache folder',
    });

    // The feature branch's own chain still supersedes normally...
    expect(store.getNote(onFeature.id)!.status).toBe('superseded');
    // ...but main's open contest is untouched by it.
    expect(store.getNote(contested.conflicts![0]!.id)!.status).toBe('active');
    expect(store.getNote(contested.id)!.status).toBe('active');
  });

  it('leaves auto-supersede scope-blind, as it has always been', () => {
    // Scoping the supersede too would be a behavior change this story does not
    // own — and it broke the existing e2e workflow when tried.
    const main = store.createSession({ scopeKey: 'branch:/repo:main' });
    const other = store.createSession({ scopeKey: null });
    const first = store.insertNote({
      sessionId: main.id,
      kind: 'decision',
      subject: 'jwt-strategy',
      content: 'chose jwt over sessions',
    });
    store.insertNote({
      sessionId: other.id,
      kind: 'decision',
      subject: 'jwt-strategy',
      content: 'jwt with revocation via redis',
    });
    expect(store.getNote(first.id)!.status).toBe('superseded');
  });
});

describe('CortexStore — subject normalization', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    store = new CortexStore(createTestDb());
    sessionId = store.createSession().id;
  });

  it('rejects a whitespace-only subject on a kind that requires one', () => {
    // `!opts.subject` is false for "   ", so the guard passed and the subject
    // normalized to "" — not null — dropping every such note into one shared
    // bucket where unrelated notes contested each other.
    expect(() =>
      store.insertNote({ sessionId, kind: 'decision', subject: '   ', content: 'x' }),
    ).toThrow(/Subject is required/);
  });

  it('normalizes a whitespace-only subject to null on a kind that does not', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'insight',
      subject: '  ',
      content: 'a subjectless insight',
    });
    expect(store.getNote(note.id)!.subject).toBeNull();
  });
});

describe('CortexStore — clearing a contest', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    store = new CortexStore(createTestDb());
    sessionId = store.createSession({ scopeKey: 'branch:/repo:main' }).id;
  });

  it('clears the marker on every contested note for the subject', () => {
    // `markConflict` was the column's only writer, so a resolved pair rendered
    // [contested] forever and SM-5's resolution rate was unmeasurable.
    const a = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const b = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    expect(store.getNote(a.id)!.conflict).toBe(true);

    const cleared = store.clearConflictsForSubject('brief caching', 'branch:/repo:main');

    expect(cleared).toHaveLength(2);
    expect(store.getNote(a.id)!.conflict).toBe(false);
    expect(store.getNote(b.id)!.conflict).toBe(false);
  });

  it('does not reach into another scope', () => {
    const other = store.createSession({ scopeKey: 'branch:/repo:feature' });
    const a = store.insertNote({
      sessionId: other.id,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    store.markConflict(a.id);

    store.clearConflictsForSubject('brief caching', 'branch:/repo:main');
    expect(store.getNote(a.id)!.conflict).toBe(true);
  });
});

describe('CortexStore — one lookup per write, every kind', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new CortexStore(db);
    sessionId = store.createSession({ scopeKey: 'branch:/repo:main' }).id;
  });

  function countSubjectLookups(write: () => void): number {
    const prepared: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    // @ts-expect-error — narrowing better-sqlite3's overloads is not worth it here
    db.prepare = (sql: string) => {
      prepared.push(sql);
      return originalPrepare(sql);
    };
    try {
      write();
    } finally {
      db.prepare = originalPrepare;
    }
    return prepared.filter(sql => /FROM notes/.test(sql) && sql.includes('subject = ?')).length;
  }

  it('an intent write issues one subject lookup, not two', () => {
    // The detection lookup (kind='decision') and the supersede lookup
    // (kind=opts.kind) diverge for every kind except decision, so the original
    // "reuse the lookup" only held for the one kind the test covered.
    store.insertNote({
      sessionId,
      kind: 'intent',
      subject: 'ship r1',
      content: 'ship the context economy release',
    });
    const count = countSubjectLookups(() => {
      store.insertNote({
        sessionId,
        kind: 'intent',
        subject: 'ship r1',
        content: 'ship the context economy release in two parts',
      });
    });
    expect(count).toBe(1);
  });

  it('a decision write issues one subject lookup', () => {
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const count = countSubjectLookups(() => {
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'brief caching',
        content: 'we do not cache the rendered session brief between runs',
      });
    });
    expect(count).toBe(1);
  });
});
