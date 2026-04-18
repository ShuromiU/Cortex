import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { recall } from '../src/query/recall.js';
import { brief } from '../src/query/brief.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');
  return db;
}

describe('retrieval', () => {
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
    const firstLine = output.split('\n')[0] ?? '';
    expect(firstLine).toContain('JWT rotation fails');
    expect(firstLine).toContain('Blocker:');
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
});
