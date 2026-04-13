import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { buildHeader, buildFullState, formatTokens } from '../src/query/state.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function makeStore(): CortexStore {
  return new CortexStore(createTestDb());
}

describe('formatTokens', () => {
  it('formats values below 1000 as plain number', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats values at 1000+ as Nk', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(10000)).toBe('10k');
  });
});

describe('buildHeader - empty', () => {
  it('returns no-prior-sessions message when no sessions exist', () => {
    const store = makeStore();
    expect(buildHeader(store)).toBe('Cortex: working memory active | no prior sessions yet');
  });
});

describe('buildHeader - provisional (unconsolidated sessions)', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    store = makeStore();
    const session = store.createSession({ focus: 'auth' });
    sessionId = session.id;
    store.endSession(sessionId);
  });

  it('returns provisional header for unconsolidated ended session', () => {
    const header = buildHeader(store);
    expect(header).toContain('Cortex [provisional]');
    expect(header).toContain('auth');
    expect(header).toContain('1 session');
    expect(header).toContain('-> Call cortex_state for full briefing');
  });

  it('shows file activity with reads and edits counts', () => {
    store.insertEvent({ sessionId, type: 'read', target: 'auth.ts' });
    store.insertEvent({ sessionId, type: 'read', target: 'auth.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'auth.ts' });
    store.insertEvent({ sessionId, type: 'read', target: 'middleware.ts' });

    const header = buildHeader(store);
    expect(header).toContain('Touched:');
    expect(header).toContain('auth.ts');
    expect(header).toContain('2 reads');
    expect(header).toContain('1 edit');
    expect(header).toContain('middleware.ts');
    expect(header).toContain('1 read');
  });

  it('shows command count and active notes count', () => {
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'build' } });
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'test' } });
    store.insertNote({ sessionId, kind: 'insight', content: 'learned something' });
    store.insertNote({ sessionId, kind: 'decision', subject: 'auth', content: 'use JWT' });

    const header = buildHeader(store);
    expect(header).toContain('Commands: 2');
    expect(header).toContain('Active notes: 2');
  });

  it('shows top 5 files by total activity', () => {
    for (let i = 1; i <= 6; i++) {
      store.insertEvent({ sessionId, type: 'read', target: `file${i}.ts` });
    }
    store.insertEvent({ sessionId, type: 'edit', target: 'file1.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'file1.ts' });

    const header = buildHeader(store);
    expect(header).not.toContain('file6.ts');
  });
});

describe('buildHeader - consolidated session state', () => {
  it('uses session-level state from most recent ended session', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'refactor' });
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Refactored auth module.' });

    const header = buildHeader(store);
    expect(header).toContain('Cortex: refactor');
    expect(header).toContain('Refactored auth module.');
    expect(header).not.toContain('[provisional]');
  });

  it('does not include [provisional] when session state exists', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'deploy' });
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Deployed v2.' });

    const header = buildHeader(store);
    expect(header).not.toContain('[provisional]');
  });
});

describe('buildHeader - token savings', () => {
  it('includes savings when saved tokens > 0', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertLedgerEntry({ sessionId: session.id, type: 'consolidation', direction: 'saved', tokens: 1500 });
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Done.' });

    const header = buildHeader(store);
    expect(header).toContain('~1.5k tokens saved');
  });

  it('omits savings when saved tokens is 0', () => {
    const store = makeStore();
    const session = store.createSession();
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Done.' });

    const header = buildHeader(store);
    expect(header).not.toContain('tokens saved');
  });
});

describe('buildHeader - project state', () => {
  it('uses project state when available', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'feature-x' });
    store.endSession(session.id);
    store.insertState({ layer: 'project', content: 'Project is in good shape. Focus on perf.' });

    const header = buildHeader(store);
    expect(header).toContain('Cortex: feature-x');
    expect(header).toContain('Project is in good shape. Focus on perf.');
  });

  it('prefers project state over session state', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'feature-x' });
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Session notes.' });
    store.insertState({ layer: 'project', content: 'Project notes.' });

    const header = buildHeader(store);
    expect(header).toContain('Project notes.');
    expect(header).not.toContain('Session notes.');
  });
});

describe('buildFullState - notes and events', () => {
  it('returns empty string when no notes and no events', () => {
    const store = makeStore();
    expect(buildFullState(store)).toBe('');
  });

  it('renders active notes grouped by kind in correct order', () => {
    const store = makeStore();
    const session = store.createSession();

    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'CSS vars are useful' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'refactor', content: 'extract helpers' });
    store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'deploy', content: 'missing env var' });

    const state = buildFullState(store);
    const intentIdx = state.indexOf('Intents:');
    const decisionIdx = state.indexOf('Decisions:');
    const blockerIdx = state.indexOf('Blockers:');
    const insightIdx = state.indexOf('Insights:');

    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThan(intentIdx);
    expect(blockerIdx).toBeGreaterThan(decisionIdx);
    expect(insightIdx).toBeGreaterThan(blockerIdx);
  });

  it('formats notes with subject brackets', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });

    const state = buildFullState(store);
    expect(state).toContain('[auth] use JWT');
  });

  it('shows conflict flag for conflicted notes', () => {
    const store = makeStore();
    const session = store.createSession();
    const note = store.insertNote({ sessionId: session.id, kind: 'insight', content: 'conflicting' });
    store.markConflict(note.id);

    const state = buildFullState(store);
    expect(state).toContain('[conflict]');
  });

  it('does not render superseded notes', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use sessions' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });

    const state = buildFullState(store);
    expect(state).toContain('use JWT');
    expect(state).not.toContain('use sessions');
  });
});

describe('buildFullState - groups by topic', () => {
  it('includes session activity from recent sessions', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'perf' });
    store.insertEvent({ sessionId: session.id, type: 'read', target: 'server.ts' });
    store.insertEvent({ sessionId: session.id, type: 'edit', target: 'server.ts' });

    const state = buildFullState(store);
    expect(state).toContain('server.ts');
  });

  it('includes project state when available', () => {
    const store = makeStore();
    store.insertState({ layer: 'project', content: 'Overall direction: microservices.' });
    const session = store.createSession();
    store.endSession(session.id);

    const state = buildFullState(store);
    expect(state).toContain('Overall direction: microservices.');
  });
});
