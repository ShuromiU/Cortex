import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    const header = buildHeader(store);
    expect(header).toContain('Cortex: ambient memory active | no prior sessions yet');
    expect(header).toContain('Cortex is ambient');
    expect(header).toContain('cortex_route');
    expect(header).toContain('Consult Cortex before non-trivial familiar or resumed work');
    expect(header).toContain('callable name');
    expect(header).toContain('cortex_recall');
    expect(header).toContain('server name');
    expect(header).toContain('select:mcp__cortex__');
    expect(header).toContain('not proof Cortex is unavailable');
    expect(header).not.toContain('Start with cortex_state');
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
    expect(header).toContain('Cortex is ambient');
    expect(header).toContain('cortex_recall(topic)');
    expect(header).toContain('Consult Cortex before non-trivial familiar or resumed work');
    expect(header).not.toContain('Start with cortex_state');
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
    expect(header).toContain('Cortex is ambient');
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

describe('buildHeader - live resume signals', () => {
  it('surfaces hot intent as a resume candidate', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'auth' });
    store.insertNote({
      sessionId: session.id,
      kind: 'intent',
      subject: 'auth',
      content: 'finish token rotation',
    });

    const header = buildHeader(store);
    expect(header).toContain('Resume: [auth] finish token rotation');
    expect(header).toContain('Cortex is ambient');
    expect(header).not.toContain('Start with cortex_state');
  });
});

describe('buildFullState - notes and events', () => {
  it('returns actionable fallback guidance when no notes and no events exist', () => {
    const store = makeStore();
    const state = buildFullState(store);
    expect(state).toContain('Cortex state: no current working memory for this scope.');
    expect(state).toContain('cortex_route');
    expect(state).toContain('cortex_recall(topic)');
  });

  it('renders active notes grouped by kind in correct order', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'prior work' });

    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'CSS vars are useful' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'refactor', content: 'extract helpers' });
    store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'deploy', content: 'missing env var' });
    store.endSession(session.id);
    store.createSession({ focus: 'current work' });

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

  it('renders note timestamps in compact UTC form', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const store = makeStore();
      const session = store.createSession();
      store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });

      const state = buildFullState(store);

      expect(state).toContain('Decision [2026-06-06 05:18Z]: [auth] use JWT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the contested marker for conflicted notes', () => {
    const store = makeStore();
    const session = store.createSession();
    const note = store.insertNote({ sessionId: session.id, kind: 'insight', content: 'conflicting' });
    store.markConflict(note.id);

    const state = buildFullState(store);
    expect(state).toContain('[contested]');
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

  it('keeps unresolved current blockers ahead of resolved stale blockers', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'deploy' });
    const resolved = store.insertNote({
      sessionId: session.id,
      kind: 'blocker',
      subject: 'deploy',
      content: 'old deploy key was missing',
    });
    store.updateNoteStatus(resolved.id, 'resolved');
    store.insertNote({
      sessionId: session.id,
      kind: 'blocker',
      subject: 'deploy',
      content: 'current deploy key is missing',
    });

    const state = buildFullState(store);

    expect(state).toContain('Blocker');
    expect(state).toContain('current deploy key is missing');
    expect(state).not.toContain('old deploy key was missing');
  });

  it('excludes stale current-session notes that only point at missing files', () => {
    const store = makeStore();
    const session = store.createSession({
      focus: 'activity',
      worktreePath: '/repo',
      scopeType: 'project',
      scopeKey: 'project:/repo',
    });
    store.upsertCurrentAppGraph({
      scopeKey: 'project:/repo',
      scopeType: 'project',
      worktreePath: '/repo',
      files: ['components/board/TaskCardNoteLog.tsx'],
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'activity',
      content: 'Old activity UI lives in components/board/ExpandedTaskCard.tsx.',
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'activity',
      content: 'Current activity UI lives in components/board/TaskCardNoteLog.tsx.',
    });

    const state = buildFullState(store);

    expect(state).toContain('Current activity UI lives');
    expect(state).not.toContain('Old activity UI lives');
  });

  it('refills the state working set after filtering stale notes', () => {
    // Clock pinned: the fixture's createdAt values are absolute, and hotness
    // scoring reads the wall clock, so an unpinned run decays the valid note
    // out of the working set once it ages past the 14-day staleness penalty.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const store = makeStore();
      const session = store.createSession({
        focus: 'activity',
        worktreePath: '/repo',
        scopeType: 'project',
        scopeKey: 'project:/repo',
      });
      store.upsertCurrentAppGraph({
        scopeKey: 'project:/repo',
        scopeType: 'project',
        worktreePath: '/repo',
        files: ['src/current.ts'],
      });

      for (let i = 0; i < 12; i++) {
        store.upsertMemoryItem({
          id: `stale-${i}`,
          sessionId: session.id,
          scopeType: 'project',
          scopeKey: 'project:/repo',
          kind: 'note:decision',
          sourceTable: 'notes',
          sourceId: `stale-${i}`,
          subject: 'activity',
          text: `decision: stale high score uses src/missing-${i}.ts.`,
          state: 'pinned',
          importance: 5,
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        });
      }
      store.upsertMemoryItem({
        id: 'valid-lower-score',
        sessionId: session.id,
        scopeType: 'project',
        scopeKey: 'project:/repo',
        kind: 'note:decision',
        sourceTable: 'notes',
        sourceId: 'valid-lower-score',
        subject: 'activity',
        text: 'decision: valid lower score uses src/current.ts.',
        state: 'warm',
        importance: 0.1,
        createdAt: '2026-06-06T00:01:00.000Z',
      });

      const state = buildFullState(store);

      expect(state).toContain('valid lower score uses src/current.ts');
      expect(state).not.toContain('stale high score');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prioritizes current-session notes before older broad working context without duplicating them', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();

      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      const older = store.createSession({
        focus: 'repo-b',
        scopeType: 'project',
        scopeKey: 'project:default',
      });
      for (let i = 0; i < 8; i++) {
        const note = store.insertNote({
          sessionId: older.id,
          kind: 'intent',
          subject: `repo-b-${i}`,
          content: `older stored Repo-B intent ${i}`,
        });
        const item = store.getMemoryItemBySource('notes', note.id)!;
        store.upsertMemoryItem({
          id: item.id,
          sessionId: item.session_id,
          scopeType: item.scope_type,
          scopeKey: item.scope_key,
          kind: item.kind,
          sourceTable: item.source_table,
          sourceId: item.source_id,
          subject: item.subject,
          text: item.text,
          state: 'pinned',
          importance: 1,
          accessCount: item.access_count,
          lastAccessedAt: item.last_accessed_at,
          createdAt: item.created_at,
        });
      }
      store.endSession(older.id);

      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const current = store.createSession({
        focus: 'landing',
        scopeType: 'branch',
        scopeKey: 'branch:landing-proof',
        branchRef: 'landing-proof',
      });
      store.upsertBranchSnapshot({
        scopeKey: 'branch:landing-proof',
        branchRef: 'landing-proof',
        focus: 'old Repo-B cleanup',
        summary: 'Older Repo-B branch snapshot should stay below current notes.',
        intents: ['older stored Repo-B snapshot intent'],
        updatedAt: '2025-12-31T00:00:00.000Z',
      });

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      store.insertNote({
        sessionId: current.id,
        kind: 'decision',
        subject: 'landing',
        content: 'landing proof cleanup pushed',
      });

      const state = buildFullState(store);
      const currentIdx = state.indexOf('landing proof cleanup pushed');
      const snapshotIdx = state.indexOf('Older Repo-B branch snapshot');
      const olderIntentIdx = state.indexOf('older stored Repo-B intent 0');

      expect(currentIdx).toBeGreaterThanOrEqual(0);
      expect(snapshotIdx).toBeGreaterThanOrEqual(0);
      expect(olderIntentIdx).toBeGreaterThanOrEqual(0);
      expect(currentIdx).toBeLessThan(snapshotIdx);
      expect(currentIdx).toBeLessThan(olderIntentIdx);
      expect(state.match(/landing proof cleanup pushed/g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters persisted command-only branch snapshot summaries while keeping stored intents', () => {
    const store = makeStore();
    store.createSession({
      focus: 'activity-tab-note-log-ux-plan',
      scopeType: 'branch',
      scopeKey: 'branch:noisy-repo-b',
      branchRef: 'feature/noisy-repo-b',
    });
    store.upsertBranchSnapshot({
      scopeKey: 'branch:noisy-repo-b',
      branchRef: 'feature/noisy-repo-b',
      focus: 'activity-tab-note-log-ux-plan',
      summary: [
        'Command (other): exit ?',
        'Command (read): exit ?',
        'Command (git): exit ?',
      ].join('\n'),
      intents: ['[scaling-next-session-resume] Continue useful Repo-B plan'],
    });

    const state = buildFullState(store);
    expect(state).toContain('Branch snapshot');
    expect(state).toContain('Last focus: activity-tab-note-log-ux-plan');
    expect(state).toContain('Stored intents: [scaling-next-session-resume] Continue useful Repo-B plan');
    expect(state).not.toContain('Command (other): exit ?');
    expect(state).not.toContain('Command (read): exit ?');
    expect(state).not.toContain('Command (git): exit ?');
  });

  it('omits recent session tails that only contain command hook noise', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'activity-tab-note-log-ux-plan' });
    store.insertEvent({ sessionId: session.id, type: 'cmd', metadata: { category: 'other' } });
    store.insertEvent({ sessionId: session.id, type: 'cmd', metadata: { category: 'read' } });
    store.insertEvent({ sessionId: session.id, type: 'cmd', metadata: { category: 'git' } });

    const state = buildFullState(store);
    expect(state).not.toContain('Session (focus: activity-tab-note-log-ux-plan)');
    expect(state).not.toContain('Command (other): exit ?');
    expect(state).not.toContain('Command (read): exit ?');
    expect(state).not.toContain('Command (git): exit ?');
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

// ── Contested rendering (FR-2, Story 1.2) ─────────────────────────────

/** Seeds a real contest through the write path (Story 1.1's detector). */
function seedStateContest(store: CortexStore, sessionId: string): void {
  store.insertNote({
    sessionId,
    kind: 'decision',
    subject: 'spool flush',
    content: 'flush the spool at turn end',
  });
  const second = store.insertNote({
    sessionId,
    kind: 'decision',
    subject: 'spool flush',
    content: 'do not flush the spool at turn end',
  });
  expect(second.conflicts?.length ?? 0).toBeGreaterThan(0);
}

describe('buildFullState - contested notes', () => {
  it('marks contested notes in the Current session block', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'spool work' });
    seedStateContest(store, session.id);

    const state = buildFullState(store);
    expect(state).toContain('Current session:');
    const marked = state.split('\n').filter(line => line.includes('[contested]'));
    expect(marked.length).toBeGreaterThanOrEqual(2);
  });

  it('marks contested notes in the kind-grouped working set', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'prior work' });
    seedStateContest(store, session.id);
    store.endSession(session.id);
    store.createSession({ focus: 'current work' });

    const state = buildFullState(store);
    expect(state).toContain('Decisions:');
    const marked = state.split('\n').filter(line => line.includes('[contested]'));
    expect(marked.length).toBeGreaterThanOrEqual(2);
  });

  it('never renders the pre-1.2 [conflict] marker', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'spool work' });
    seedStateContest(store, session.id);

    expect(buildFullState(store)).not.toContain('[conflict]');
  });

  it('leaves uncontested notes unmarked', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'spool work' });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });

    expect(buildFullState(store)).not.toContain('[contested]');
  });
});
