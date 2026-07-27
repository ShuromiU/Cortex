import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { computeMemoryHotness, refreshMemoryHotness } from '../src/memory/hotness.js';
import { buildHeader, buildFullState } from '../src/query/state.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');
  return db;
}

describe('memory hotness', () => {
  it('decays stale untouched items and preserves reinforced ones', () => {
    const store = new CortexStore(createTestDb());
    const session = store.createSession({ focus: 'auth' });

    const stale = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      content: 'Old CSS cleanup reminder',
    });
    const reinforced = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'auth',
      content: 'Use JWT rotation for auth sessions',
    });

    const staleItem = store.getMemoryItemBySource('notes', stale.id)!;
    store.upsertMemoryItem({
      id: staleItem.id,
      sessionId: staleItem.session_id,
      scopeType: staleItem.scope_type,
      scopeKey: staleItem.scope_key,
      kind: staleItem.kind,
      sourceTable: staleItem.source_table,
      sourceId: staleItem.source_id,
      subject: staleItem.subject,
      text: staleItem.text,
      state: 'warm',
      importance: staleItem.importance,
      accessCount: 0,
      createdAt: '2025-10-01T00:00:00.000Z',
    });

    const reinforcedItem = store.getMemoryItemBySource('notes', reinforced.id)!;
    store.upsertMemoryItem({
      id: reinforcedItem.id,
      sessionId: reinforcedItem.session_id,
      scopeType: reinforcedItem.scope_type,
      scopeKey: reinforcedItem.scope_key,
      kind: reinforcedItem.kind,
      sourceTable: reinforcedItem.source_table,
      sourceId: reinforcedItem.source_id,
      subject: reinforcedItem.subject,
      text: reinforcedItem.text,
      state: 'warm',
      importance: reinforcedItem.importance,
      accessCount: 3,
      lastAccessedAt: '2026-04-12T12:00:00.000Z',
      createdAt: reinforcedItem.created_at,
    });

    refreshMemoryHotness(store, [staleItem.scope_key], new Date('2026-04-13T12:00:00.000Z'));

    expect(store.getMemoryItemBySource('notes', stale.id)?.state).toBe('cold');
    expect(store.getMemoryItemBySource('notes', reinforced.id)?.state).toBe('hot');
  });

  it('keeps stale notes out of the default state while keeping hot notes in header and full state', () => {
    const store = new CortexStore(createTestDb());
    const session = store.createSession({ focus: 'auth' });

    const stale = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      content: 'Legacy CSS polish task',
    });
    const active = store.insertNote({
      sessionId: session.id,
      kind: 'blocker',
      subject: 'auth',
      content: 'Token refresh still fails in staging',
    });

    const staleItem = store.getMemoryItemBySource('notes', stale.id)!;
    store.upsertMemoryItem({
      id: staleItem.id,
      sessionId: staleItem.session_id,
      scopeType: staleItem.scope_type,
      scopeKey: staleItem.scope_key,
      kind: staleItem.kind,
      sourceTable: staleItem.source_table,
      sourceId: staleItem.source_id,
      subject: staleItem.subject,
      text: staleItem.text,
      state: 'warm',
      importance: staleItem.importance,
      accessCount: 0,
      createdAt: '2025-09-01T00:00:00.000Z',
    });

    store.touchMemoryItems([`notes:${active.id}`], '2026-04-13T09:00:00.000Z');

    const header = buildHeader(store);
    const fullState = buildFullState(store);

    expect(header).toContain('Hot:');
    expect(header).toContain('Token refresh still fails in staging');
    expect(header).not.toContain('Legacy CSS polish task');

    expect(fullState).toContain('Token refresh still fails in staging');
    expect(fullState).not.toContain('Legacy CSS polish task');
  });

  it('does not reheat resolved blocker notes during hotness refresh', () => {
    const store = new CortexStore(createTestDb());
    const session = store.createSession({ focus: 'auth' });

    const blocker = store.insertNote({
      sessionId: session.id,
      kind: 'blocker',
      subject: 'npm-run-lint-broken',
      content: '`npm run lint` used to call next lint.',
    });
    store.updateNoteStatus(blocker.id, 'resolved');

    const item = store.getMemoryItemBySource('notes', blocker.id)!;
    expect(item.state).toBe('cold');

    refreshMemoryHotness(store, [item.scope_key], new Date('2026-04-13T12:00:00.000Z'));

    expect(store.getMemoryItemBySource('notes', blocker.id)?.state).toBe('cold');
  });
});

// ── Superseded demotion is durable (FR-4, Story 1.4) ───────────────────

describe('memory hotness — superseded items', () => {
  function seededStore(): { store: CortexStore; sessionId: string; scopeKey: string } {
    const store = new CortexStore(createTestDb());
    const scopeKey = 'branch:/repo:main';
    const session = store.createSession({ scopeKey, focus: 'auth' });
    return { store, sessionId: session.id, scopeKey };
  }

  function itemState(store: CortexStore, noteId: string): string {
    return store.getMemoryItemBySource('notes', noteId)!.state;
  }

  it('the refresh cannot resurrect a demoted decision to hot', () => {
    const { store, sessionId, scopeKey } = seededStore();
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use OIDC for the auth strategy',
    });
    // Heat it and pre-assert the score is genuinely hot-range, so this test
    // fails loudly if the fixture stops being adversarial: without the
    // superseded branch in deriveMemoryItemState, the refresh recomputes state
    // from this score and flips the demotion straight back to hot.
    store.touchMemoryItems([`notes:${first.id}`]);
    const heated = refreshMemoryHotness(store, [scopeKey]);
    const heatedItem = heated.find(item => item.source_id === first.id)!;
    expect(heatedItem.hotness_score).toBeGreaterThanOrEqual(7);
    expect(itemState(store, first.id)).toBe('hot');

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use SAML for the auth strategy via the same gateway',
    });
    expect(itemState(store, first.id)).toBe('warm');

    // The load-bearing assertion: the refresh AGREES with the demotion
    // instead of overwriting it.
    refreshMemoryHotness(store, [scopeKey]);
    expect(itemState(store, first.id)).toBe('warm');
  });

  it('reinforcement caps at warm — touching a superseded item cannot reheat it to hot', () => {
    const { store, sessionId, scopeKey } = seededStore();
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use OIDC for the auth strategy',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use SAML for the auth strategy via the same gateway',
    });

    for (let index = 0; index < 6; index += 1) {
      store.touchMemoryItems([`notes:${first.id}`]);
    }
    expect(itemState(store, first.id)).not.toBe('hot');

    // And the refresh, seeing a heavily-reinforced (hot-scoring) superseded
    // item, still derives at most warm.
    refreshMemoryHotness(store, [scopeKey]);
    expect(['warm', 'cold']).toContain(itemState(store, first.id));
  });

  it('a superseded item keeps decaying — an aged one derives cold, not warm', () => {
    const { store, sessionId, scopeKey } = seededStore();
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use OIDC for the auth strategy',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use SAML for the auth strategy via the same gateway',
    });

    // Age it far past every recency bonus; score falls out of the hot range,
    // and the demote-after-derive floor keeps it cold and retrievable.
    const future = new Date(Date.now() + 200 * 24 * 3600 * 1000);
    refreshMemoryHotness(store, [scopeKey], future);
    expect(itemState(store, first.id)).toBe('cold');
  });

  it('archived rows from pre-1.4 supersedes are preserved, not resurrected', () => {
    const { store, sessionId, scopeKey } = seededStore();
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use OIDC for the auth strategy',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use SAML for the auth strategy via the same gateway',
    });
    const item = store.getMemoryItemBySource('notes', first.id)!;
    store.updateMemoryItemStates([{ id: item.id, state: 'archived' }]);

    refreshMemoryHotness(store, [scopeKey]);
    expect(itemState(store, first.id)).toBe('archived');
  });
});

describe('memory hotness — superseded stale penalty', () => {
  it('scores a superseded item below an otherwise identical active one', () => {
    const { store, sessionId } = (() => {
      const store = new CortexStore(createTestDb());
      const session = store.createSession({ scopeKey: 'branch:/repo:main' });
      return { store, sessionId: session.id };
    })();

    const active = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'queue engine',
      content: 'use kafka for the queue engine',
    });
    const retired = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'cache engine',
      content: 'use redis for the cache engine',
    });
    store.updateNoteStatus(retired.id, 'superseded');

    const activeItem = store.getMemoryItemBySource('notes', active.id)!;
    const retiredItem = store.getMemoryItemBySource('notes', retired.id)!;
    // Same kind, importance, age, access — only the status line differs, so
    // the gap is exactly the retired-guidance decay push.
    expect(computeMemoryHotness(retiredItem)).toBeLessThan(computeMemoryHotness(activeItem));
  });
});
