import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MEMORY_LIST_ORDER,
  inspectMemory,
  listMemory,
  resolvePageLimit,
  resolvePageOffset,
} from '../src/query/inspect.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createStore(): { db: Database.Database; store: CortexStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');
  return { db, store: new CortexStore(db) };
}

// ── resolvePageLimit / resolvePageOffset ──────────────────────────────

describe('resolvePageLimit', () => {
  it('defaults, floors, and caps', () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, DEFAULT_PAGE_LIMIT],
      [Number.NaN, DEFAULT_PAGE_LIMIT],
      [Number.POSITIVE_INFINITY, DEFAULT_PAGE_LIMIT],
      [0, DEFAULT_PAGE_LIMIT],
      [-1, DEFAULT_PAGE_LIMIT],
      [1, 1],
      [19, 19],
      [MAX_PAGE_LIMIT - 1, MAX_PAGE_LIMIT - 1],
      [MAX_PAGE_LIMIT, MAX_PAGE_LIMIT],
      [MAX_PAGE_LIMIT + 1, MAX_PAGE_LIMIT],
      [9999, MAX_PAGE_LIMIT],
      [7.9, 7],
    ];

    for (const [raw, expected] of cases) {
      expect(resolvePageLimit(raw), `resolvePageLimit(${String(raw)})`).toBe(expected);
    }
  });

  it('caps below any value a caller could ask for', () => {
    expect(resolvePageLimit(Number.MAX_SAFE_INTEGER)).toBe(MAX_PAGE_LIMIT);
    expect(MAX_PAGE_LIMIT).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('resolvePageOffset', () => {
  it('defaults to zero and never goes negative', () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [-5, 0],
      [0, 0],
      [3, 3],
      [3.7, 3],
    ];

    for (const [raw, expected] of cases) {
      expect(resolvePageOffset(raw), `resolvePageOffset(${String(raw)})`).toBe(expected);
    }
  });
});

// ── listMemory ────────────────────────────────────────────────────────

describe('listMemory', () => {
  let db: Database.Database;
  let store: CortexStore;

  beforeEach(() => {
    ({ db, store } = createStore());
  });

  function seed(id: string, overrides: Record<string, unknown> = {}): void {
    store.upsertMemoryItem({
      id,
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: `text for ${id}`,
      state: 'warm',
      createdAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    });
  }

  it('reports the total, the window, and the ordering criterion', () => {
    for (let i = 0; i < 25; i += 1) {
      seed(`i${String(i).padStart(2, '0')}`);
    }

    const page = listMemory(store, {});

    expect(page.total).toBe(25);
    expect(page.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(page.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(page.offset).toBe(0);
    expect(page.order).toBe(MEMORY_LIST_ORDER);
    expect(page.order).toMatch(/created_at/);
  });

  it('never returns more than the hard cap, whatever the caller asks for', () => {
    for (let i = 0; i < 30; i += 1) {
      seed(`i${String(i).padStart(2, '0')}`);
    }

    const page = listMemory(store, { limit: 100_000 });

    expect(page.limit).toBe(MAX_PAGE_LIMIT);
    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
    expect(page.total).toBe(30);
  });

  it('walks the whole store across pages without repeating or skipping', () => {
    for (let i = 0; i < 25; i += 1) {
      seed(`i${String(i).padStart(2, '0')}`);
    }

    const first = listMemory(store, { limit: 10, offset: 0 });
    const second = listMemory(store, { limit: 10, offset: 10 });
    const third = listMemory(store, { limit: 10, offset: 20 });

    const walked = [...first.items, ...second.items, ...third.items].map(item => item.id);
    expect(walked).toHaveLength(25);
    expect(new Set(walked).size).toBe(25);
    // Every item shares created_at, so only the tiebreaker fixes this order.
    expect(walked[0]).toBe('i24');
    expect(walked[24]).toBe('i00');
  });

  it('passes scope, kind and state filters through and echoes them back', () => {
    seed('a-hot-decision', { scopeKey: 'scope-a', kind: 'note:decision', state: 'hot' });
    seed('a-warm-insight', { scopeKey: 'scope-a', kind: 'note:insight', state: 'warm' });
    seed('b-hot-decision', { scopeKey: 'scope-b', kind: 'note:decision', state: 'hot' });

    // Adversarial precondition: unfiltered, the excluded ids really are present.
    expect(listMemory(store, {}).items.map(i => i.id).sort()).toEqual([
      'a-hot-decision',
      'a-warm-insight',
      'b-hot-decision',
    ]);

    const page = listMemory(store, {
      scopeKeys: ['scope-a'],
      kinds: ['note:decision'],
      states: ['hot'],
    });

    expect(page.items.map(i => i.id)).toEqual(['a-hot-decision']);
    expect(page.total).toBe(1);
    expect(page.filter).toEqual({
      scopeKeys: ['scope-a'],
      kinds: ['note:decision'],
      states: ['hot'],
    });
  });

  it('includes archived items by default so the listing cannot hide rows', () => {
    seed('live', { state: 'warm' });
    seed('buried', { state: 'archived' });

    expect(listMemory(store, {}).items.map(i => i.id).sort()).toEqual(['buried', 'live']);
    expect(listMemory(store, { states: ['archived'] }).items.map(i => i.id)).toEqual(['buried']);
  });

  it('reports total independently of the page size', () => {
    for (let i = 0; i < 12; i += 1) {
      seed(`i${i}`);
    }

    const page = listMemory(store, { limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(12);
  });

  it('leaves access counters untouched — inspecting memory must not reheat it', () => {
    seed('cool', { accessCount: 0 });

    listMemory(store, {});

    const item = store.getMemoryItem('cool')!;
    expect(item.access_count).toBe(0);
    expect(item.last_accessed_at).toBeNull();
    expect(item.state).toBe('warm');
  });
});

// ── inspectMemory ─────────────────────────────────────────────────────

describe('inspectMemory', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    ({ db, store } = createStore());
    sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
  });

  it('returns null for an id that does not exist', () => {
    expect(inspectMemory(store, 'no-such-id')).toBeNull();
  });

  it('resolves a note id as well as a memory item id', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'transport',
      content: 'use stdio for the MCP transport',
    });

    const byNoteId = inspectMemory(store, note.id);
    expect(byNoteId).not.toBeNull();
    expect(byNoteId!.item.source_table).toBe('notes');
    expect(byNoteId!.item.source_id).toBe(note.id);

    const byItemId = inspectMemory(store, byNoteId!.item.id);
    expect(byItemId!.item.id).toBe(byNoteId!.item.id);
  });

  it('returns the full text untruncated', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} of the stored memory text`);
    store.upsertMemoryItem({
      id: 'long',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      text: lines.join('\n'),
    });

    const inspection = inspectMemory(store, 'long')!;

    expect(inspection.text).toBe(lines.join('\n'));
    expect(inspection.text.split('\n')).toHaveLength(20);
    expect(inspection.text).not.toContain('…');
  });

  it('reports the trust label and per-reference status for present files', () => {
    store.upsertCurrentAppGraph({
      scopeKey: 'scope-a',
      scopeType: 'project',
      files: ['src/present.ts'],
    });
    store.upsertMemoryItem({
      id: 'refs-ok',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'the fix lives in src/present.ts',
    });

    const inspection = inspectMemory(store, 'refs-ok')!;

    expect(inspection.trust).toBe('refs OK');
    expect(inspection.references).toEqual([
      expect.objectContaining({ normalized_path: 'src/present.ts', status: 'exists' }),
    ]);
  });

  it('reports stale references', () => {
    store.upsertCurrentAppGraph({
      scopeKey: 'scope-a',
      scopeType: 'project',
      files: ['src/other.ts'],
    });
    store.upsertMemoryItem({
      id: 'refs-stale',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'the fix lives in src/deleted.ts',
    });

    const inspection = inspectMemory(store, 'refs-stale')!;

    expect(inspection.trust).toBe('stale refs');
    expect(inspection.references[0]).toMatchObject({
      normalized_path: 'src/deleted.ts',
      status: 'missing',
    });
  });

  it('reports moved references with their destination', () => {
    store.upsertCurrentAppGraph({
      scopeKey: 'scope-a',
      scopeType: 'project',
      files: ['src/new/moved.ts'],
    });
    store.insertFileRenames({
      scopeKey: 'scope-a',
      renames: [{ oldPath: 'src/old/moved.ts', newPath: 'src/new/moved.ts' }],
    });
    store.upsertMemoryItem({
      id: 'refs-moved',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'the fix lives in src/old/moved.ts',
    });

    const inspection = inspectMemory(store, 'refs-moved')!;

    expect(inspection.trust).toBe('refs moved');
    expect(inspection.references[0]).toMatchObject({
      normalized_path: 'src/old/moved.ts',
      status: 'moved',
      moved_to: 'src/new/moved.ts',
    });
  });

  it('reports "no file refs" when the text names no paths', () => {
    store.upsertMemoryItem({
      id: 'no-refs',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      text: 'prefer the smaller surface',
    });

    const inspection = inspectMemory(store, 'no-refs')!;

    expect(inspection.trust).toBe('no file refs');
    expect(inspection.references).toEqual([]);
  });

  it('reports both sides of a contest, each naming the other', () => {
    const first = store.insertNote({
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

    // Adversarial precondition: the write really did open a contest.
    expect(store.getNote(first.id)!.conflict).toBe(true);
    expect(store.getNote(second.id)!.conflict).toBe(true);

    const firstView = inspectMemory(store, first.id)!;
    const secondView = inspectMemory(store, second.id)!;

    expect(firstView.conflict.conflict).toBe(true);
    expect(firstView.conflict.projected_contested).toBe(true);
    expect(firstView.conflict.diverged).toBe(false);
    expect(firstView.conflict.counterparts.map(c => c.id)).toEqual([second.id]);
    expect(secondView.conflict.counterparts.map(c => c.id)).toEqual([first.id]);
  });

  it('excludes same-subject notes that are out of scope or not contested', () => {
    const otherScopeSession = store.createSession({
      scopeType: 'project',
      scopeKey: 'scope-b',
    }).id;

    const mine = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const contesting = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    // Same scope, same subject, active — but not part of any contest. Only the
    // conflict filter can exclude this one.
    const uncontested = store.insertNote({
      sessionId,
      kind: 'blocker',
      subject: 'spool flush',
      content: 'spool flush blocked on the jq dependency',
    });
    // Another scope, and contested *within that scope*, so its conflict flag is
    // set too. Only the scope filter can exclude these two.
    const foreign = store.insertNote({
      sessionId: otherScopeSession,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const foreignContesting = store.insertNote({
      sessionId: otherScopeSession,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });

    // Adversarial preconditions: every excluded note is active and same-subject,
    // the foreign pair genuinely carries conflict = 1, the blocker genuinely
    // does not, and the unfiltered candidate list really does contain them all.
    expect(store.getNote(uncontested.id)!.conflict).toBe(false);
    expect(store.getNote(foreign.id)!.conflict).toBe(true);
    expect(store.getNote(foreignContesting.id)!.conflict).toBe(true);
    const candidates = store.getActiveNotesBySubject('spool flush').map(n => n.id);
    expect(candidates).toContain(uncontested.id);
    expect(candidates).toContain(foreign.id);
    expect(candidates).toContain(foreignContesting.id);

    const view = inspectMemory(store, mine.id)!;

    expect(view.conflict.counterparts.map(c => c.id)).toEqual([contesting.id]);
  });

  it('reports the note column as authoritative and flags divergence from the text', () => {
    // A note whose *content* carries a "Conflict: true" line while the column
    // says otherwise. Every other surface reads the text and renders
    // [contested]; inspect reads the column and says the two disagree.
    const note = store.insertNote({
      sessionId,
      kind: 'insight',
      content: 'the projection writes\nConflict: true\nas its own line',
    });

    expect(store.getNote(note.id)!.conflict).toBe(false);

    const view = inspectMemory(store, note.id)!;

    expect(view.conflict.conflict).toBe(false);
    expect(view.conflict.projected_contested).toBe(true);
    expect(view.conflict.diverged).toBe(true);
  });

  it('reports a superseded status and its rejected alternatives', () => {
    const first = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'storage engine',
      content: 'use sqlite for storage',
      alternatives: ['postgres', 'leveldb'],
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'storage engine',
      content: 'use sqlite with wal for storage',
    });

    expect(store.getNote(first.id)!.status).toBe('superseded');

    const view = inspectMemory(store, first.id)!;

    expect(view.conflict.note_status).toBe('superseded');
    expect(view.conflict.projected_superseded).toBe(true);
    expect(view.conflict.diverged).toBe(false);
    expect(view.conflict.alternatives).toEqual(['postgres', 'leveldb']);
  });

  it('reports no conflict facts for an item with no note behind it', () => {
    store.upsertMemoryItem({
      id: 'plain',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'command_run',
      text: 'npm run build',
    });

    const view = inspectMemory(store, 'plain')!;

    expect(view.conflict.conflict).toBeNull();
    expect(view.conflict.note_status).toBeNull();
    expect(view.conflict.projected_contested).toBe(false);
    expect(view.conflict.diverged).toBe(false);
    expect(view.conflict.counterparts).toEqual([]);
    expect(view.conflict.alternatives).toBeNull();
  });

  it('reports access history from the durable counters and the retrieval log', () => {
    store.upsertMemoryItem({
      id: 'seen',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'a decision that has been retrieved',
      accessCount: 47,
      lastAccessedAt: '2026-07-20T10:00:00.000Z',
    });
    store.insertRetrievalLog({
      sessionId,
      topic: 'older topic',
      resultIds: ['seen'],
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    store.insertRetrievalLog({
      sessionId,
      topic: 'newer topic',
      resultIds: ['seen'],
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    store.insertRetrievalLog({
      sessionId,
      topic: 'unrelated',
      resultIds: ['someone-else'],
      createdAt: '2026-07-21T00:00:00.000Z',
    });

    const view = inspectMemory(store, 'seen')!;

    expect(view.access.access_count).toBe(47);
    expect(view.access.last_accessed_at).toBe('2026-07-20T10:00:00.000Z');
    expect(view.access.retrievals.map(r => r.topic)).toEqual(['newer topic', 'older topic']);
    expect(view.access.retrievals[0]).toMatchObject({ session_id: sessionId });
  });

  it('reports an empty access history rather than failing when nothing retrieved it', () => {
    store.upsertMemoryItem({
      id: 'unseen',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'never retrieved',
    });

    const view = inspectMemory(store, 'unseen')!;

    expect(view.access.access_count).toBe(0);
    expect(view.access.last_accessed_at).toBeNull();
    expect(view.access.retrievals).toEqual([]);
  });

  it('does not reheat the item it inspects', () => {
    store.upsertMemoryItem({
      id: 'cool',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:decision',
      text: 'a cold decision',
      state: 'cold',
      accessCount: 2,
      lastAccessedAt: '2026-07-01T00:00:00.000Z',
    });

    inspectMemory(store, 'cool');

    const after = store.getMemoryItem('cool')!;
    expect(after.state).toBe('cold');
    expect(after.access_count).toBe(2);
    expect(after.last_accessed_at).toBe('2026-07-01T00:00:00.000Z');
  });
});
