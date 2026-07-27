import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { buildSessionBrief } from '../src/query/session-brief.js';

function createStore(): CortexStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/root');
  return new CortexStore(db);
}

function seedNote(
  store: CortexStore,
  sessionId: string,
  scopeKey: string,
  id: string,
  kind: string,
  subject: string,
  text: string,
  ageDays = 1,
): void {
  store.upsertMemoryItem({
    id,
    sessionId,
    scopeType: 'branch',
    scopeKey,
    kind,
    sourceTable: 'notes',
    sourceId: id,
    subject,
    text,
    state: 'hot',
    importance: 2.5,
    createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
  });
}

describe('buildSessionBrief', () => {
  it('emits nothing on a cold start', () => {
    const store = createStore();
    store.createSession({ scopeType: 'branch', scopeKey: 'branch:repo:main' });
    expect(buildSessionBrief(store)).toBe('');
  });

  it('leads with validated branch-scoped load-bearing notes and a recall pointer', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertCurrentAppGraph({
      scopeKey: 'branch:repo:main',
      scopeType: 'branch',
      files: ['src/auth/login.ts'],
    });
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-decision',
      'note:decision',
      'auth login',
      'decision: keep the login flow in src/auth/login.ts behind the session guard.',
    );
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-blocker',
      'note:blocker',
      'vitest teardown',
      'blocker: vitest hangs on db teardown until the handle closes.',
      2,
    );
    // An insight should not appear: brief is decisions/blockers/intents only.
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-insight',
      'note:insight',
      'misc',
      'insight: something minor.',
    );

    const brief = buildSessionBrief(store);
    const lines = brief.split('\n');

    expect(lines[0]).toBe('Cortex memory (main):');
    expect(lines[lines.length - 1]).toBe('More: cortex_recall(topic).');
    expect(brief).toContain('decision: [auth login] keep the login flow');
    expect(brief).toContain('blocker: [vitest teardown] vitest hangs on db teardown');
    expect(brief).not.toContain('something minor');
    expect(brief.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(4);
  });

  it('drops notes whose referenced files are all gone and labels partial staleness', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertCurrentAppGraph({
      scopeKey: 'branch:repo:main',
      scopeType: 'branch',
      files: ['src/kept.ts'],
    });
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-all-gone',
      'note:decision',
      'dead decision',
      'decision: everything lived in src/removed.ts before the rewrite.',
    );
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-partial',
      'note:decision',
      'partial decision',
      'decision: src/kept.ts stays but src/dropped.ts was folded in.',
    );

    const brief = buildSessionBrief(store);

    expect(brief).not.toContain('dead decision');
    expect(brief).toContain('partial decision');
    expect(brief).toContain('(refs: 1 missing)');
  });

  it('includes a resume line from a recent session summary', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertMemoryItem({
      id: 'brief-summary',
      sessionId: session.id,
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      kind: 'episode:session_summary',
      sourceTable: 'episodes',
      sourceId: 'brief-summary',
      subject: null,
      text: '## Session Summary | migrated the store reads to the new query layer',
      state: 'warm',
      importance: 1.4,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const brief = buildSessionBrief(store);

    expect(brief).toContain('- resume: Session Summary | migrated the store reads');
  });

  it('stays within the token budget by dropping bullets from the bottom', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    for (let i = 0; i < 3; i++) {
      seedNote(
        store,
        session.id,
        'branch:repo:main',
        `brief-long-${i}`,
        'note:decision',
        `subsystem ${i}`,
        `decision: subsystem ${i} adopts a long-winded multi-clause policy describing migration passes, rollout gates, fallback handling, and verification steps in detail.`,
        i + 1,
      );
    }

    const brief = buildSessionBrief(store, { budget: 60 });

    expect(brief).not.toBe('');
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(60);
    expect(brief.startsWith('Cortex memory (main):')).toBe(true);
    expect(brief).toContain('More: cortex_recall(topic).');
  });
});

// ── Contested marker (FR-2, review round 1) ───────────────────────────

describe('buildSessionBrief — contested notes', () => {
  it('marks a contested decision', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });

    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const second = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(second.conflicts?.length ?? 0).toBeGreaterThan(0);

    // This channel prints unprompted on every SessionStart and selects
    // note:decision in state 'warm' — exactly an active contested decision.
    // Unmarked, it presents one side of an open contest as settled memory.
    const brief = buildSessionBrief(store);
    expect(brief).toContain('decision:');
    expect(brief).toContain('[contested]');
  });

  it('leaves an uncontested decision unmarked', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });

    expect(buildSessionBrief(store)).not.toContain('[contested]');
  });

  it('stays inside its token budget with the marker present', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });

    const brief = buildSessionBrief(store);
    expect(brief).toContain('[contested]');
    // The SessionStart brief is capped at 150 tokens and must stay small.
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(150);
  });
});
