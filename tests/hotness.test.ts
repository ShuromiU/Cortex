import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { refreshMemoryHotness } from '../src/memory/hotness.js';
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
});
