import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleCmdEvent, handleReadEvent } from '../src/capture/hooks.js';
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

  it('does not use command-only activity as the branch snapshot summary', () => {
    const store = new CortexStore(createTestDb());
    const payments = branchScope('feature/payments');

    const session = ensureScopedSession(store, '/repo', {
      resolveScope: () => payments,
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'intent',
      subject: 'payments',
      content: 'Resume Stripe payment intent refactor',
    });

    handleCmdEvent(store, session.id, {});
    handleCmdEvent(store, session.id, {});

    const snapshot = store.getBranchSnapshot(payments.scopeKey);
    expect(snapshot).toBeDefined();
    expect(snapshot?.summary).toContain('Resume Stripe payment intent refactor');
    expect(snapshot?.summary).not.toContain('Command (cmd): exit ?');
    expect(snapshot?.summary).not.toContain('Command (git): exit ?');
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

describe('scope runtime — agent identity (AD-9)', () => {
  it('resolves to the primary session when no agent id is supplied', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    const first = ensureScopedSession(store, '/repo', { resolveScope: () => main });
    const second = ensureScopedSession(store, '/repo', { resolveScope: () => main });

    expect(second.id).toBe(first.id);
    expect(second.agent_id).toBeNull();
    expect(second.agent_type).toBe('primary');
    expect(second.parent_session_id).toBeNull();
  });

  it('creates a child session on demand for a payload carrying an agent id', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    const primary = ensureScopedSession(store, '/repo', { resolveScope: () => main });
    const child = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
      agentType: 'Explore',
    });

    expect(child.id).not.toBe(primary.id);
    expect(child.parent_session_id).toBe(primary.id);
    expect(child.agent_id).toBe('agent-1');
    expect(child.agent_type).toBe('Explore');
    expect(child.scope_key).toBe(main.scopeKey);
    expect(child.branch_ref).toBe(main.branchRef);
    expect(child.git_root).toBe(main.gitRoot);
  });

  it('creates the primary session first when a subagent payload arrives before any primary', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    const child = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
    });

    expect(child.parent_session_id).toBeTruthy();
    expect(child.agent_type).toBe('subagent');
    const primary = store.getSession(child.parent_session_id!);
    expect(primary?.agent_id).toBeNull();
    expect(store.getCurrentSession()?.id).toBe(primary?.id);
  });

  it('resolves distinct agent ids to distinct child sessions', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    ensureScopedSession(store, '/repo', { resolveScope: () => main });
    const first = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
    });
    const second = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-2',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.parent_session_id).toBe(second.parent_session_id);
  });

  it('reuses an existing child session for a repeated agent id', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    ensureScopedSession(store, '/repo', { resolveScope: () => main });
    const first = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
    });
    const again = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
    });

    expect(again.id).toBe(first.id);
    expect(store.getChildSessions(first.parent_session_id!).length).toBe(1);
  });

  it('does not rotate or end the primary session when resolving a child', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    const primary = ensureScopedSession(store, '/repo', { resolveScope: () => main });
    ensureScopedSession(store, '/repo', { resolveScope: () => main, agentId: 'agent-1' });

    expect(store.getSession(primary.id)?.status).toBe('active');
    expect(store.getCurrentSession()?.id).toBe(primary.id);
  });

  it('keeps subagent activity out of the branch snapshot', () => {
    const store = new CortexStore(createTestDb());
    const main = branchScope('main');

    const primary = ensureScopedSession(store, '/repo', { resolveScope: () => main });
    store.insertState({
      sessionId: primary.id,
      layer: 'session',
      content: 'Primary session summary that owns the branch snapshot.',
    });
    handleReadEvent(store, primary.id, { file: 'src/primary.ts' });

    const child = ensureScopedSession(store, '/repo', {
      resolveScope: () => main,
      agentId: 'agent-1',
    });
    handleReadEvent(store, child.id, { file: 'src/subagent-only.ts' });

    const snapshot = store.getBranchSnapshot(main.scopeKey);
    expect(snapshot?.recent_files).toContain('src/primary.ts');
    expect(snapshot?.recent_files).not.toContain('src/subagent-only.ts');
    expect(snapshot?.last_session_id).toBe(primary.id);
  });
});
