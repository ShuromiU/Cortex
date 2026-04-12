import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { buildSessionSummary } from '../src/query/summarize.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function createStore(): { store: CortexStore; sessionId: string } {
  const db = createTestDb();
  const store = new CortexStore(db);
  const session = store.createSession();
  return { store, sessionId: session.id };
}

// ── buildSessionSummary ──────────────────────────────────────────────

describe('buildSessionSummary', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    const result = createStore();
    store = result.store;
    sessionId = result.sessionId;
  });

  it('returns message for empty session', () => {
    const result = buildSessionSummary(store);
    expect(result).toContain('No tracked activity');
  });

  it('returns user description with empty activity message', () => {
    const result = buildSessionSummary(store, 'Setup project scaffolding');
    expect(result).toContain('Setup project scaffolding');
    expect(result).toContain('No tracked activity');
  });

  it('includes created files', () => {
    store.insertEvent({ sessionId, type: 'write', target: 'src/new-file.ts' });
    const result = buildSessionSummary(store);
    expect(result).toContain('src/new-file.ts (created)');
  });

  it('includes edited files with counts', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    const result = buildSessionSummary(store);
    expect(result).toContain('src/foo.ts (3 edits)');
  });

  it('includes single edit without plural', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/bar.ts' });
    const result = buildSessionSummary(store);
    expect(result).toContain('src/bar.ts (1 edit)');
  });

  it('extracts directories from modified files', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/query/recall.ts' });
    store.insertEvent({ sessionId, type: 'write', target: 'src/capture/new.ts' });
    const result = buildSessionSummary(store);
    expect(result).toContain('### Directories');
    expect(result).toContain('src/query');
    expect(result).toContain('src/capture');
  });

  it('includes command stats by category', () => {
    store.insertEvent({
      sessionId,
      type: 'cmd',
      metadata: { exit_code: 0, category: 'test' },
    });
    store.insertEvent({
      sessionId,
      type: 'cmd',
      metadata: { exit_code: 1, category: 'test' },
    });
    store.insertEvent({
      sessionId,
      type: 'cmd',
      metadata: { exit_code: 0, category: 'build' },
    });
    const result = buildSessionSummary(store);
    expect(result).toContain('2 test (1 failed)');
    expect(result).toContain('1 build');
  });

  it('includes subagent descriptions', () => {
    store.insertEvent({
      sessionId,
      type: 'agent',
      metadata: { description: 'Explore auth module' },
    });
    const result = buildSessionSummary(store);
    expect(result).toContain('### Subagents');
    expect(result).toContain('Explore auth module');
  });

  it('includes active notes in decisions section', () => {
    store.insertNote({
      sessionId,
      kind: 'decision',
      content: 'Use SQLite for storage',
      subject: 'database',
    });
    store.insertNote({
      sessionId,
      kind: 'insight',
      content: 'Performance is good enough',
    });
    const result = buildSessionSummary(store);
    expect(result).toContain('### Decisions & Insights');
    expect(result).toContain('Use SQLite for storage');
    expect(result).toContain('Performance is good enough');
  });

  it('does not include superseded notes', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      content: 'Old decision',
      subject: 'approach',
    });
    store.updateNoteStatus(note.id, 'superseded');
    store.insertNote({
      sessionId,
      kind: 'decision',
      content: 'New decision',
      subject: 'approach',
    });
    const result = buildSessionSummary(store);
    expect(result).not.toContain('Old decision');
    expect(result).toContain('New decision');
  });

  it('includes user description in header when provided', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/main.ts' });
    const result = buildSessionSummary(store, 'Refactored the auth middleware');
    expect(result).toContain('## Session Summary');
    expect(result).toContain('Refactored the auth middleware');
    expect(result).toContain('src/main.ts');
  });

  it('handles mixed activity correctly', () => {
    store.insertEvent({ sessionId, type: 'read', target: 'src/config.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'src/main.ts' });
    store.insertEvent({ sessionId, type: 'write', target: 'src/new.ts' });
    store.insertEvent({
      sessionId,
      type: 'cmd',
      metadata: { exit_code: 0, category: 'test' },
    });
    store.insertEvent({
      sessionId,
      type: 'agent',
      metadata: { description: 'Review code' },
    });
    store.insertNote({ sessionId, kind: 'insight', content: 'Code is clean' });

    const result = buildSessionSummary(store);
    expect(result).toContain('src/main.ts');
    expect(result).toContain('src/new.ts (created)');
    expect(result).toContain('1 test');
    expect(result).toContain('Review code');
    expect(result).toContain('Code is clean');
  });

  it('does not show directories section for read-only activity', () => {
    store.insertEvent({ sessionId, type: 'read', target: 'src/config.ts' });
    const result = buildSessionSummary(store);
    // Read-only files are not in "Files Modified", so no directories section
    expect(result).not.toContain('### Directories');
  });
});
