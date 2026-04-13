import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { buildHeader, buildFullState } from '../src/query/state.js';
import { ensureScopedSession } from '../src/scope/runtime.js';
import { deriveBranchScopeKey } from '../src/scope/keys.js';
import type { GitScopeIdentity } from '../src/scope/git.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function branchScope(branchRef: string): GitScopeIdentity {
  const gitRoot = '/repo/.git';
  const worktreePath = '/repo';
  return {
    gitRoot,
    worktreePath,
    branchRef,
    headOid: `${branchRef.replace(/[^a-z]/gi, '').slice(0, 7) || 'abcdef0'}123456789`,
    scopeType: 'branch',
    scopeKey: deriveBranchScopeKey(gitRoot, worktreePath, branchRef),
    scopeLabel: branchRef,
  };
}

describe('scope runtime', () => {
  it('rotates sessions and persists a branch snapshot on scope change', () => {
    const store = new CortexStore(createTestDb());
    const payments = branchScope('feature/payments');
    const hotfix = branchScope('main');

    const sessionA = ensureScopedSession(store, '/repo', {
      resolveScope: () => payments,
    });
    store.insertEvent({ sessionId: sessionA.id, type: 'edit', target: 'src/payments.ts' });
    store.insertNote({
      sessionId: sessionA.id,
      kind: 'intent',
      subject: 'payments',
      content: 'Finish the payments branch flow',
    });
    store.insertNote({
      sessionId: sessionA.id,
      kind: 'blocker',
      subject: 'payments webhook',
      content: 'Webhook signature mismatch is blocking validation',
    });
    store.insertState({
      sessionId: sessionA.id,
      layer: 'session',
      content: 'Worked on payments flow and narrowed the webhook failure.',
    });

    ensureScopedSession(store, '/repo', {
      resolveScope: () => hotfix,
    });

    expect(store.getSession(sessionA.id)?.status).toBe('ended');

    const snapshot = store.getBranchSnapshot(payments.scopeKey);
    expect(snapshot).toBeDefined();
    expect(snapshot?.summary).toContain('payments flow');
    expect(snapshot?.recent_files).toContain('src/payments.ts');
    expect(snapshot?.intents[0]).toContain('Finish the payments branch flow');
    expect(snapshot?.blockers[0]).toContain('Webhook signature mismatch');
  });

  it('restores the matching branch state without leaking notes from another branch', () => {
    const store = new CortexStore(createTestDb());
    const payments = branchScope('feature/payments');
    const hotfix = branchScope('main');

    const paymentsSession = ensureScopedSession(store, '/repo', {
      resolveScope: () => payments,
    });
    store.insertEvent({ sessionId: paymentsSession.id, type: 'edit', target: 'src/payments.ts' });
    store.insertNote({
      sessionId: paymentsSession.id,
      kind: 'intent',
      subject: 'payments',
      content: 'Resume Stripe payment intent refactor',
    });
    store.insertState({
      sessionId: paymentsSession.id,
      layer: 'session',
      content: 'Payments branch is mid-refactor with Stripe intent work in progress.',
    });

    const hotfixSession = ensureScopedSession(store, '/repo', {
      resolveScope: () => hotfix,
    });
    store.insertNote({
      sessionId: hotfixSession.id,
      kind: 'insight',
      content: 'Main branch hotfix note that should not leak back into payments',
    });

    ensureScopedSession(store, '/repo', {
      resolveScope: () => payments,
    });

    const header = buildHeader(store);
    expect(header).toContain('feature/payments');
    expect(header).toContain('Stripe intent work in progress');

    const fullState = buildFullState(store);
    expect(fullState).toContain('Branch snapshot');
    expect(fullState).toContain('Stored intents: [payments] Resume Stripe payment intent refactor');
    expect(fullState).not.toContain('hotfix note');
  });
});
