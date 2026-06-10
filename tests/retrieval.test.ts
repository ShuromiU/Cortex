import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { recall } from '../src/query/recall.js';
import { brief } from '../src/query/brief.js';
import { buildRetrievalContext, retrieveMemory } from '../src/query/retrieval.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');
  return db;
}

describe('retrieval', () => {
  it('drops generic continuation prompt words before building a query', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    const context = buildRetrievalContext(store, 'Continue with the fix');

    expect(context.tokens).toEqual([]);
    expect(context.queryText).toBeNull();
  });

  it('keeps distinctive terms while dropping generic workflow words', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    const context = buildRetrievalContext(store, 'Continue Pulse all-project hub foundation fix');

    expect(context.tokens.map(token => token.raw)).toEqual([
      'pulse',
      'project',
      'hub',
      'foundation',
    ]);
    expect(context.queryText).toBe('"pulse" OR "project" OR "hub" OR "foundation"');
  });

  it('prefers branch-scoped memory over project-wide matches', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    const main = store.createSession({
      focus: 'auth',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'main',
      headOid: 'main123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:main',
    });
    store.insertNote({
      sessionId: main.id,
      kind: 'decision',
      subject: 'auth',
      content: 'Keep cookie sessions on main.',
    });
    store.endSession(main.id);

    const feature = store.createSession({
      focus: 'auth gateway',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'feat123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
    });
    store.insertNote({
      sessionId: feature.id,
      kind: 'blocker',
      subject: 'auth gateway',
      content: 'JWT rotation fails in the auth gateway when refresh tokens expire.',
    });

    const output = recall(store, 'auth gateway');
    const lines = output.split('\n');
    expect(lines[0]).toContain('Most relevant — Blocker [auth gateway]');
    expect(lines[1]).toContain('JWT rotation fails');
    expect(lines[1]).toContain('Blocker');
  });

  it('logs retrievals and bumps access counts for returned memory items', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    const session = store.createSession({
      focus: 'reporting',
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/reports',
      headOid: 'reports123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/reports',
    });
    const note = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'reports',
      content: 'Ship the V3 reports rewrite behind a feature flag.',
    });

    const output = brief(store, 'reports', 'worker-1');
    expect(output).toContain('Briefing for worker-1:');
    expect(output).toContain('Scope: feature/reports');
    expect(output).toContain('Focus: reporting');
    expect(output).toContain('feature flag');

    const memoryItem = store.getMemoryItemBySource('notes', note.id);
    expect(memoryItem?.access_count).toBe(1);

    const logs = store.getRetrievalLogsBySession(session.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.topic).toBe('reports');
    expect(logs[0]?.returned_count).toBeGreaterThan(0);
    expect(logs[0]?.result_ids).toContain(`notes:${note.id}`);
  });

  it('indexes command output tails through memory items', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    const session = store.createSession({
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'feat123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
    });

    const run = store.insertCommandRun({
      sessionId: session.id,
      category: 'test',
      commandSummary: 'vitest run auth',
      exitCode: 1,
      stderrTail: 'authorization denied for refresh token rotation',
      filesTouched: ['src/auth.ts'],
    });

    const results = store.searchMemoryItems('authorization*', 5);
    expect(results.map(item => item.id)).toContain(`command_runs:${run.id}`);
  });

  it('uses temporal intent to prefer old matching memory when requested', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
      scopeType: 'project',
      scopeKey: 'project:/repo',
    });

    store.upsertMemoryItem({
      id: 'old-auth-decision',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'old-auth-decision',
      subject: 'auth',
      text: 'decision: Use legacy cookie auth for the dashboard.',
      state: 'warm',
      importance: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    store.upsertMemoryItem({
      id: 'new-auth-decision',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'new-auth-decision',
      subject: 'auth',
      text: 'decision: Use OIDC auth for the dashboard.',
      state: 'warm',
      importance: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const latest = retrieveMemory(store, 'latest auth dashboard decision', 2);
    const old = retrieveMemory(store, 'old auth dashboard decision', 2);

    expect(latest.results[0]?.id).toBe('new-auth-decision');
    expect(old.results[0]?.id).toBe('old-auth-decision');
  });

  it('uses temporal intent to prefer resolved memory when requested', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
      scopeType: 'project',
      scopeKey: 'project:/repo',
    });

    store.upsertMemoryItem({
      id: 'active-deploy-blocker',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:blocker',
      sourceTable: 'notes',
      sourceId: 'active-deploy-blocker',
      subject: 'deploy',
      text: 'blocker: deploy is missing the current release key.',
      state: 'hot',
      importance: 1,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    store.upsertMemoryItem({
      id: 'resolved-deploy-blocker',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:blocker',
      sourceTable: 'notes',
      sourceId: 'resolved-deploy-blocker',
      subject: 'deploy',
      text: 'blocker: deploy was missing the old release key.\nStatus: resolved',
      state: 'cold',
      importance: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const retrieval = retrieveMemory(store, 'resolved deploy blocker', 2);

    expect(retrieval.results[0]?.id).toBe('resolved-deploy-blocker');
  });

  it('demotes stale notes whose referenced files are missing from the current app graph', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
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

    store.upsertMemoryItem({
      id: 'old-notes-portal',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'old-notes-portal',
      subject: 'notes portal',
      text: 'decision: Activity notes portal used components/board/ExpandedTaskCard.tsx and components/board/TaskCardPeekStrip.tsx.',
      state: 'hot',
      importance: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.upsertMemoryItem({
      id: 'current-activity-tab',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'current-activity-tab',
      subject: 'activity tab',
      text: 'decision: Activity notes now live in components/board/TaskCardNoteLog.tsx.',
      state: 'warm',
      importance: 0.6,
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const retrieval = retrieveMemory(store, 'Activity notes portal task card', 2);

    expect(retrieval.results[0]?.id).toBe('current-activity-tab');
    expect(retrieval.results.find(item => item.id === 'old-notes-portal')?.reference_validation.stale).toBe(true);
  });

  it('allows historical queries to return stale notes but marks them as stale', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
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
    store.upsertMemoryItem({
      id: 'old-notes-portal-history',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/repo',
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'old-notes-portal-history',
      subject: 'notes portal',
      text: 'decision: Previous Activity notes portal used components/board/ExpandedTaskCard.tsx.',
      state: 'warm',
      importance: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const output = recall(store, 'old Activity notes portal');

    expect(output).toContain('Previous Activity notes portal');
    expect(output).toContain('stale: missing components/board/ExpandedTaskCard.tsx');
    expect(store.getMemoryItem('old-notes-portal-history')?.state).toBe('warm');
  });

  it('keeps returned ranking lexical in shadow semantic mode', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'feat123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
    });
    const lexical = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'password reset',
      content: 'Keep password reset tokens short lived.',
    });
    const semantic = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      subject: 'account recovery',
      content: 'User identity proofing handles locked-out sign-in recovery.',
    });
    store.upsertMemoryItemSemantic({
      memoryItemId: `notes:${semantic.id}`,
      summary: 'Credential reset recovery flow',
      concepts: ['password reset', 'account recovery'],
      entities: [],
      embeddingModel: 'fake-v1',
      embedding: [1, 0],
      sourceHash: 'semantic-1',
    });

    const retrieval = retrieveMemory(store, 'password reset', 1, {
      semanticMode: 'shadow',
      semanticProvider: {
        embeddingModel: 'fake-v1',
        embed: () => [1, 0],
      },
    });

    expect(retrieval.results.map(item => item.id)).toEqual([`notes:${lexical.id}`]);
    expect(retrieval.semanticCandidates.map(item => item.id)).toContain(`notes:${semantic.id}`);
  });

  it('lifts high-confidence paraphrase matches in rank semantic mode', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({
      gitRoot: '/repo/.git',
      worktreePath: '/repo',
      branchRef: 'feature/auth',
      headOid: 'feat123',
      scopeType: 'branch',
      scopeKey: 'branch:/repo/.git:/repo:feature/auth',
    });
    const lexical = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'session refresh',
      content: 'Refresh browser session cookies after login.',
      importance: 0.1,
    });
    const semantic = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      subject: 'credential rotation',
      content: 'Credential renewal prevents stale authentication grants.',
      importance: 0.1,
    });
    store.upsertMemoryItemSemantic({
      memoryItemId: `notes:${semantic.id}`,
      summary: 'Refresh token rotation',
      concepts: ['refresh token rotation', 'credential renewal'],
      entities: [],
      embeddingModel: 'fake-v1',
      embedding: [1, 0],
      sourceHash: 'semantic-2',
    });

    const retrieval = retrieveMemory(store, 'session refresh', 1, {
      semanticMode: 'rank',
      semanticProvider: {
        embeddingModel: 'fake-v1',
        embed: () => [1, 0],
      },
      semanticRankThreshold: 0.9,
    });

    expect(retrieval.semanticCandidates[0]?.id).toBe(`notes:${semantic.id}`);
    expect(retrieval.results.map(item => item.id)).toEqual([`notes:${semantic.id}`]);
    expect(retrieval.results[0]?.semantic_score).toBe(1);
    expect(retrieval.results[0]?.semantic_rank_applied).toBe(true);
    expect(retrieval.candidates.map(item => item.id)).toContain(`notes:${lexical.id}`);
  });
});
