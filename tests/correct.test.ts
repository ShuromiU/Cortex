import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { editMemory, deleteMemory, previewMemoryDeletion } from '../src/query/correct.js';
import { inspectMemory } from '../src/query/inspect.js';
import { handleCmdEvent } from '../src/capture/hooks.js';

function createStore(): { db: Database.Database; store: CortexStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');
  return { db, store: new CortexStore(db) };
}

describe('editMemory', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    ({ db, store } = createStore());
    sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
  });

  it('returns null for an id that does not exist', () => {
    expect(editMemory(store, 'no-such-id', 'anything')).toBeNull();
  });

  it('re-projects the item and records the prior text', () => {
    store.upsertMemoryItem({
      id: 'item',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      text: 'the bug is in src/old.ts',
    });

    const result = editMemory(store, 'item', 'the bug is in src/new.ts')!;

    expect(result.prior_text).toBe('the bug is in src/old.ts');
    expect(result.item.text).toBe('the bug is in src/new.ts');
    expect(result.references.map(r => r.normalized_path)).toEqual(['src/new.ts']);

    const [audit] = store.getMemoryCorrections('item');
    expect(audit).toMatchObject({
      operation: 'edit',
      prior_text: 'the bug is in src/old.ts',
      new_text: 'the bug is in src/new.ts',
    });
  });

  it('resolves a note id as well as a memory item id', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth',
      content: 'use OIDC',
    });

    const result = editMemory(store, note.id, 'use OIDC with refresh rotation')!;

    expect(result.item.source_id).toBe(note.id);
    expect(store.getNote(note.id)!.content).toBe('use OIDC with refresh rotation');
  });

  it('leaves the projection consistent with its columns after a note edit', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth',
      content: 'use OIDC',
      alternatives: ['saml'],
    });

    editMemory(store, note.id, 'use OIDC with refresh rotation');

    // Hand-patching memory_items.text would desynchronise the trailer from the
    // columns — the drift inspect-memory reports as `diverged`, introduced by
    // the command meant to repair memory.
    const inspection = inspectMemory(store, note.id)!;
    expect(inspection.conflict.diverged).toBe(false);
    expect(inspection.conflict.alternatives).toEqual(['saml']);
    expect(inspection.text).toContain('use OIDC with refresh rotation');
  });
});

describe('previewMemoryDeletion', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    ({ db, store } = createStore());
    sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
  });

  it('returns null for an unknown id', () => {
    expect(previewMemoryDeletion(store, 'ghost')).toBeNull();
  });

  it('describes what would go without deleting anything', () => {
    store.upsertMemoryItem({
      id: 'doomed',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      text: 'a memory about src/a.ts and src/b.ts',
    });

    const preview = previewMemoryDeletion(store, 'doomed')!;

    expect(preview.item.id).toBe('doomed');
    expect(preview.reference_count).toBe(2);
    // The whole point of a preview.
    expect(store.getMemoryItem('doomed')).toBeTruthy();
  });

  it('warns that deleting one side of a contest will clear it', () => {
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
    expect(store.getNote(first.id)!.conflict).toBe(true);

    const preview = previewMemoryDeletion(store, first.id)!;

    expect(preview.contested).toBe(true);
    expect(preview.counterparts.map(c => c.id)).toEqual([second.id]);
    expect(store.getNote(first.id)).toBeTruthy();
  });

  it('does not list a contested note from another scope as a counterpart', () => {
    const otherScope = store.createSession({ scopeType: 'project', scopeKey: 'scope-b' }).id;
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
    // A contest of its own in another scope, on the same subject, so both of
    // its notes genuinely carry conflict = 1 and only the scope filter can
    // keep them out.
    const foreign = store.insertNote({
      sessionId: otherScope,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const foreignContesting = store.insertNote({
      sessionId: otherScope,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(store.getNote(foreign.id)!.conflict).toBe(true);
    expect(store.getNote(foreignContesting.id)!.conflict).toBe(true);
    expect(store.getActiveNotesBySubject('spool flush').map(n => n.id)).toContain(foreign.id);

    const preview = previewMemoryDeletion(store, mine.id)!;

    expect(preview.counterparts.map(c => c.id)).toEqual([contesting.id]);
  });
});

describe('deleteMemory', () => {
  let db: Database.Database;
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    ({ db, store } = createStore());
    sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
  });

  it('returns null for an unknown id', () => {
    expect(deleteMemory(store, 'ghost')).toBeNull();
  });

  it('removes the item and its source, and reports what went', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth',
      content: 'a decision that turned out wrong',
    });
    const itemId = store.getMemoryItemBySource('notes', note.id)!.id;

    const result = deleteMemory(store, itemId)!;

    expect(result.deleted).toBe(true);
    expect(result.item.id).toBe(itemId);
    expect(store.getMemoryItem(itemId)).toBeUndefined();
    expect(store.getNote(note.id)).toBeUndefined();
    expect(store.getMemoryCorrections(itemId)).toHaveLength(1);
  });

  it('takes a derived row down with the item (AD-14, standing in for a file card)', () => {
    // Story 4.1 introduces `file_cards`; the readiness report accepted this
    // forward reference and prescribed a synthetic record. `memory_item_semantics`
    // is a real memory_items-derived table with the same FK shape a card will
    // have, so it stands in for one without inventing Epic 4's schema.
    store.upsertMemoryItem({
      id: 'carded',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      text: 'an item with a derived projection',
    });
    store.upsertMemoryItemSemantic({
      memoryItemId: 'carded',
      summary: 'derived card stand-in',
      concepts: [],
      entities: [],
      embeddingModel: 'fake',
      embedding: [0.5],
      sourceHash: 'hash',
    });
    expect(store.getMemoryItemSemantic('carded')).toBeTruthy();

    deleteMemory(store, 'carded');

    expect(store.getMemoryItemSemantic('carded')).toBeUndefined();
    expect(store.getMemoryItem('carded')).toBeUndefined();
  });

  it('warns that the delete will be refused when no rule covers the source table', () => {
    store.upsertMemoryItem({
      id: 'foreign',
      scopeType: 'project',
      scopeKey: 'scope-a',
      kind: 'note:insight',
      sourceTable: 'file_cards',
      sourceId: 'card-1',
      text: 'an item from a table the cascade does not know',
    });

    const preview = previewMemoryDeletion(store, 'foreign')!;

    // The preview must promise exactly what the delete performs. Advertising
    // "deleted too" for a table the cascade skips would be a lie the user acts on.
    expect(preview.source_table).toBe('file_cards');
    expect(preview.deletable).toBe(false);
    expect(() => deleteMemory(store, 'foreign')).toThrow(/no deletion rule/);
  });

  it('names the upstream table that would otherwise rebuild the source row', () => {
    const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
    handleCmdEvent(store, sessionId, { exit: '1', cmd: 'npm run build', stderr: 'boom' });
    const item = store.listMemoryItemsFiltered({ kinds: ['command_run'] })[0]!;

    const preview = previewMemoryDeletion(store, item.id)!;

    expect(preview.upstream_table).toBe('events');
  });

  it('counts counterparts the way the delete does, for a session with no scope key', () => {
    // createSession() with no scopeKey leaves sessions.scope_key NULL, while
    // resolveSessionScope stamps the memory item with the derived project key.
    // Comparing counterparts against the item column instead of the session
    // column then reports zero — and the delete clears the contest anyway.
    const unscoped = store.createSession().id;
    const first = store.insertNote({
      sessionId: unscoped,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const second = store.insertNote({
      sessionId: unscoped,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(store.getScopeKeyForNote(first.id)).toBeNull();
    expect(store.getMemoryItemBySource('notes', first.id)!.scope_key).not.toBeNull();
    expect(store.getNote(first.id)!.conflict).toBe(true);

    const preview = previewMemoryDeletion(store, first.id)!;
    expect(preview.contested).toBe(true);
    // The preview is AC #2's confirmation surface; it must not understate what
    // the delete is about to do.
    expect(preview.counterparts.map(c => c.id)).toEqual([second.id]);

    deleteMemory(store, first.id);
    expect(store.getNote(second.id)!.conflict).toBe(false);
  });

  it('clears the contest for the survivor', () => {
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

    deleteMemory(store, first.id);

    expect(store.getNote(second.id)!.conflict).toBe(false);
    expect(inspectMemory(store, second.id)!.conflict.conflict).toBe(false);
  });
});
