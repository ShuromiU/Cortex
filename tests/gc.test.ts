import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { runGc, shouldAutoGc } from '../src/db/gc.js';

function createDb(): { db: Database.Database; store: CortexStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/gc/root');
  return { db, store: new CortexStore(db) };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedConsolidatedSessionWithOldEvents(store: CortexStore, db: Database.Database): string {
  const session = store.createSession({ scopeType: 'project', scopeKey: 'project:/gc/root' });
  const eventId = store.insertEvent({ sessionId: session.id, type: 'read', target: 'src/a.ts' });
  // Age the event past the cutoff and consolidate the session.
  db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(isoDaysAgo(45), eventId);
  store.insertState({ sessionId: session.id, layer: 'session', content: 'summary' });
  store.endSession(session.id);
  return session.id;
}

describe('gc', () => {
  it('dry-run reports candidates without deleting', () => {
    const { db, store } = createDb();
    seedConsolidatedSessionWithOldEvents(store, db);

    const report = runGc(db, { dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(report.events.candidates).toBe(1);
    expect(report.events.deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM events').get()).toEqual({ c: 1 });
  });

  it('deletes old events of consolidated sessions but keeps unconsolidated ones', () => {
    const { db, store } = createDb();
    seedConsolidatedSessionWithOldEvents(store, db);
    const active = store.createSession({ scopeType: 'project', scopeKey: 'project:/gc/root' });
    const freshEvent = store.insertEvent({ sessionId: active.id, type: 'edit', target: 'src/b.ts' });
    db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(isoDaysAgo(45), freshEvent);

    const report = runGc(db, { dryRun: false, vacuum: 'never' });

    expect(report.events.deleted).toBe(1);
    const remaining = db.prepare('SELECT session_id FROM events').all() as Array<{ session_id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.session_id).toBe(active.id);
  });

  it('rolls up old ledger rows into one row per session and direction', () => {
    const { db, store } = createDb();
    const session = store.createSession({ scopeType: 'project', scopeKey: 'project:/gc/root' });
    store.insertLedgerEntry({ sessionId: session.id, type: 'recall', direction: 'spent', tokens: 100 });
    store.insertLedgerEntry({ sessionId: session.id, type: 'state', direction: 'spent', tokens: 50 });
    store.insertLedgerEntry({ sessionId: session.id, type: 'consolidation', direction: 'saved', tokens: 300 });
    db.prepare('UPDATE token_ledger SET timestamp = ?').run(isoDaysAgo(20));

    const before = store.getTotalTokens();
    const report = runGc(db, { dryRun: false, vacuum: 'never' });
    const after = store.getTotalTokens();

    expect(report.token_ledger.candidates).toBe(3);
    expect(report.token_ledger.deleted).toBe(3);
    expect(after).toEqual(before);
    const rows = db.prepare(`SELECT type, direction, tokens FROM token_ledger ORDER BY direction`).all();
    expect(rows).toEqual([
      { type: 'rollup', direction: 'saved', tokens: 300 },
      { type: 'rollup', direction: 'spent', tokens: 150 },
    ]);
  });

  it('deletes never-accessed archived items and caps command runs per scope', () => {
    const { db, store } = createDb();
    const session = store.createSession({ scopeType: 'project', scopeKey: 'project:/gc/root' });
    store.upsertMemoryItem({
      id: 'old-archived',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'project:/gc/root',
      kind: 'note:insight',
      subject: 'old',
      text: 'archived insight no one read',
      state: 'archived',
      importance: 1,
      createdAt: isoDaysAgo(120),
    });
    for (let i = 0; i < 5; i++) {
      store.upsertMemoryItem({
        id: `cmd-${i}`,
        sessionId: session.id,
        scopeType: 'project',
        scopeKey: 'project:/gc/root',
        kind: 'command_run',
        subject: null,
        text: `Command (test): npm test ${i}`,
        state: 'warm',
        importance: 0.6,
        createdAt: isoDaysAgo(5 - i),
      });
    }

    const report = runGc(db, { dryRun: false, vacuum: 'never', commandRunCapPerScope: 2 });

    expect(report.archived_memory_items.deleted).toBe(1);
    expect(report.command_run_items.deleted).toBe(3);
    expect(store.getMemoryItem('old-archived')).toBeUndefined();
    const kept = db
      .prepare(`SELECT id FROM memory_items WHERE kind = 'command_run' ORDER BY created_at DESC`)
      .all() as Array<{ id: string }>;
    expect(kept.map(row => row.id)).toEqual(['cmd-4', 'cmd-3']);
    // Cascade: references and FTS rows for deleted items are gone.
    expect(store.getMemoryReferences('old-archived')).toHaveLength(0);
  });

  it('tracks auto-gc cadence via last_gc_at', () => {
    const { db } = createDb();
    expect(shouldAutoGc(db)).toBe(true);

    runGc(db, { dryRun: false, vacuum: 'never' });
    expect(shouldAutoGc(db)).toBe(false);
    expect(shouldAutoGc(db, new Date(Date.now() + 25 * 60 * 60 * 1000))).toBe(true);
  });
});

// ── memory_corrections retention (FR-22) ──────────────────────────────
//
// `delete-memory` prints "kept in the audit trail until cortex gc prunes it"
// on every deletion. That sentence is only true if this rule exists.

describe('runGc — memory_corrections', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, '/repo');
  });

  afterEach(() => {
    db.close();
  });

  function seedCorrection(id: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO memory_corrections (id, memory_item_id, operation, prior_text, created_at)
       VALUES (?, 'item-1', 'delete', 'the deleted text', ?)`,
    ).run(id, createdAt);
  }

  it('prunes corrections past the retention window and keeps recent ones', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    seedCorrection('old', '2026-01-01T00:00:00.000Z');
    seedCorrection('recent', '2026-07-27T00:00:00.000Z');

    const report = runGc(db, { dryRun: false, vacuum: 'never', now });

    expect(report.memory_corrections.deleted).toBe(1);
    const ids = (
      db.prepare('SELECT id FROM memory_corrections').all() as Array<{ id: string }>
    ).map(row => row.id);
    expect(ids).toEqual(['recent']);
  });

  it('reports candidates without deleting on a dry run', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    seedCorrection('old', '2026-01-01T00:00:00.000Z');

    const report = runGc(db, { dryRun: true, vacuum: 'never', now });

    expect(report.memory_corrections.candidates).toBe(1);
    expect(report.memory_corrections.deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as n FROM memory_corrections').get()).toEqual({ n: 1 });
  });
});
