import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  consolidateLevel1,
  renderCompressed,
  getPendingConsolidation,
  writeSessionSummary,
  promoteSubagentNotes,
} from '../src/capture/consolidate.js';
import type { CompressedEvent } from '../src/capture/consolidate.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function makeStore(): { store: CortexStore; sessionId: string } {
  const db = createTestDb();
  const store = new CortexStore(db);
  const session = store.createSession();
  return { store, sessionId: session.id };
}

// ── consolidateLevel1 ─────────────────────────────────────────────────

describe('consolidateLevel1', () => {
  it('returns empty array for session with no events', () => {
    const { store, sessionId } = makeStore();
    const result = consolidateLevel1(store, sessionId);
    expect(result).toEqual([]);
  });

  it('deduplicates repeated reads of same file — with line ranges', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'read', target: 'auth.ts', metadata: { line_start: 1, line_end: 50 } });
    store.insertEvent({ sessionId, type: 'read', target: 'auth.ts', metadata: { line_start: 80, line_end: 120 } });
    store.insertEvent({ sessionId, type: 'read', target: 'auth.ts', metadata: { line_start: 1, line_end: 50 } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'read',
      target: 'auth.ts',
      count: 3,
      line_ranges: [[1, 50], [80, 120], [1, 50]],
    });
  });

  it('deduplicates reads without line ranges — degraded mode', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'read', target: 'utils.ts' });
    store.insertEvent({ sessionId, type: 'read', target: 'utils.ts' });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'read', target: 'utils.ts', count: 2 });
    expect(result[0]!.line_ranges).toBeUndefined();
  });

  it('merges sequential edits to same file — collecting line ranges', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'edit', target: 'auth.ts', metadata: { line_start: 10, line_end: 20 } });
    store.insertEvent({ sessionId, type: 'edit', target: 'auth.ts', metadata: { line_start: 15, line_end: 30 } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'edit',
      target: 'auth.ts',
      count: 2,
      line_ranges: [[10, 20], [15, 30]],
    });
  });

  it('keeps distinct files separate', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'read', target: 'a.ts' });
    store.insertEvent({ sessionId, type: 'read', target: 'b.ts' });
    store.insertEvent({ sessionId, type: 'read', target: 'a.ts' });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(2);
    const aEvent = result.find((e) => e.target === 'a.ts');
    const bEvent = result.find((e) => e.target === 'b.ts');
    expect(aEvent).toMatchObject({ type: 'read', target: 'a.ts', count: 2 });
    expect(bEvent).toMatchObject({ type: 'read', target: 'b.ts', count: 1 });
  });

  it('collapses test cycle: fail → edit → pass (1 iteration)', () => {
    const { store, sessionId } = makeStore();
    // Test fail
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'test' } });
    // Edit
    store.insertEvent({ sessionId, type: 'edit', target: 'auth.ts', metadata: { line_start: 10, line_end: 20 } });
    // Test pass
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'test' } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'test_cycle',
      iterations: 1,
      files: ['auth.ts'],
    });
  });

  it('collapses multi-iteration test cycle: fail → edit → fail → edit → pass (2 iterations)', () => {
    const { store, sessionId } = makeStore();
    // First fail
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'test' } });
    store.insertEvent({ sessionId, type: 'edit', target: 'auth.ts' });
    // Second fail
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 2, category: 'test' } });
    store.insertEvent({ sessionId, type: 'edit', target: 'helper.ts' });
    // Pass
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'test' } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'test_cycle',
      iterations: 2,
    });
    const files = (result[0] as CompressedEvent).files ?? [];
    expect(files).toContain('auth.ts');
    expect(files).toContain('helper.ts');
  });

  it('keeps agent events as-is with description', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'agent', metadata: { description: 'Exploring auth' } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'agent', description: 'Exploring auth' });
  });

  it('passes through non-test cmd events individually', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'npm' } });
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'git' } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'cmd', exit_code: 0, category: 'npm' });
    expect(result[1]).toMatchObject({ type: 'cmd', exit_code: 1, category: 'git' });
  });

  it('does not form a test cycle when intermediate event is non-edit', () => {
    const { store, sessionId } = makeStore();
    // Test fail
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'test' } });
    // Agent event interrupts — no cycle should form
    store.insertEvent({ sessionId, type: 'agent', metadata: { description: 'figuring out' } });
    // Test pass
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'test' } });

    const result = consolidateLevel1(store, sessionId);
    // Should NOT produce a test_cycle
    expect(result.some((e) => e.type === 'test_cycle')).toBe(false);
    // The fail cmd should pass through
    expect(result.some((e) => e.type === 'cmd')).toBe(true);
  });

  it('flushes file groups when cmd is encountered', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'read', target: 'a.ts' });
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'build' } });
    store.insertEvent({ sessionId, type: 'read', target: 'a.ts' });

    const result = consolidateLevel1(store, sessionId);
    // Two separate read groups (before and after cmd)
    const reads = result.filter((e) => e.type === 'read');
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ count: 1 });
    expect(reads[1]).toMatchObject({ count: 1 });
  });

  it('includes write events in test cycle file list', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 1, category: 'test' } });
    store.insertEvent({ sessionId, type: 'write', target: 'new-file.ts' });
    store.insertEvent({ sessionId, type: 'cmd', metadata: { exit_code: 0, category: 'test' } });

    const result = consolidateLevel1(store, sessionId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'test_cycle',
      iterations: 1,
      files: ['new-file.ts'],
    });
  });
});

// ── renderCompressed ──────────────────────────────────────────────────

describe('renderCompressed', () => {
  it('renders read with count and line ranges', () => {
    const events: CompressedEvent[] = [
      { type: 'read', target: 'auth.ts', count: 3, line_ranges: [[1, 50], [80, 120]] },
    ];
    expect(renderCompressed(events)).toBe('Read auth.ts x3 (lines: 1-50, 80-120)');
  });

  it('renders read with count but no line ranges', () => {
    const events: CompressedEvent[] = [
      { type: 'read', target: 'auth.ts', count: 3 },
    ];
    expect(renderCompressed(events)).toBe('Read auth.ts x3');
  });

  it('renders single read without multiplier', () => {
    const events: CompressedEvent[] = [
      { type: 'read', target: 'auth.ts', count: 1 },
    ];
    expect(renderCompressed(events)).toBe('Read auth.ts');
  });

  it('renders edit with count and line ranges', () => {
    const events: CompressedEvent[] = [
      { type: 'edit', target: 'auth.ts', count: 2, line_ranges: [[10, 20], [15, 30]] },
    ];
    expect(renderCompressed(events)).toBe('Edited auth.ts x2 (lines: 10-20, 15-30)');
  });

  it('renders write as Created', () => {
    const events: CompressedEvent[] = [
      { type: 'write', target: 'new-file.ts', count: 1 },
    ];
    expect(renderCompressed(events)).toBe('Created new-file.ts');
  });

  it('renders test_cycle with 1 iteration', () => {
    const events: CompressedEvent[] = [
      { type: 'test_cycle', iterations: 1, files: ['auth.ts'] },
    ];
    expect(renderCompressed(events)).toBe('Test cycle: fixed after 1 iteration (auth.ts)');
  });

  it('renders test_cycle with multiple iterations', () => {
    const events: CompressedEvent[] = [
      { type: 'test_cycle', iterations: 2, files: ['auth.ts', 'helper.ts'] },
    ];
    expect(renderCompressed(events)).toBe('Test cycle: fixed after 2 iterations (auth.ts, helper.ts)');
  });

  it('renders cmd with category and exit code', () => {
    const events: CompressedEvent[] = [
      { type: 'cmd', category: 'npm', exit_code: 0 },
    ];
    expect(renderCompressed(events)).toBe('Command (npm): exit 0');
  });

  it('renders agent with description', () => {
    const events: CompressedEvent[] = [
      { type: 'agent', description: 'Exploring auth' },
    ];
    expect(renderCompressed(events)).toBe('Subagent: Exploring auth');
  });

  it('renders multiple events separated by newlines', () => {
    const events: CompressedEvent[] = [
      { type: 'read', target: 'auth.ts', count: 1 },
      { type: 'cmd', category: 'npm', exit_code: 0 },
    ];
    expect(renderCompressed(events)).toBe('Read auth.ts\nCommand (npm): exit 0');
  });

  it('returns empty string for empty array', () => {
    expect(renderCompressed([])).toBe('');
  });
});

// ── Level 2: getPendingConsolidation ──────────────────────────────────

describe('getPendingConsolidation', () => {
  it('detects sessions needing consolidation', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const s = store.createSession();
    store.endSession(s.id);

    const pending = getPendingConsolidation(store);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(s.id);
  });

  it('skips already-consolidated sessions', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const s = store.createSession();
    store.endSession(s.id);
    // Write a session-layer state → this session is now consolidated
    store.insertState({ sessionId: s.id, layer: 'session', content: 'done' });

    const pending = getPendingConsolidation(store);
    expect(pending).toHaveLength(0);
  });

  it('skips active sessions', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    store.createSession(); // active, never ended

    const pending = getPendingConsolidation(store);
    expect(pending).toHaveLength(0);
  });
});

// ── Level 2: writeSessionSummary ──────────────────────────────────────

describe('writeSessionSummary', () => {
  it('writes session summary and prunes events', () => {
    const { store, sessionId } = makeStore();
    store.insertEvent({ sessionId, type: 'read', target: 'a.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'b.ts' });

    expect(store.getEventCount(sessionId)).toBe(2);

    writeSessionSummary(store, sessionId, 'Worked on a.ts and b.ts');

    // State written
    const state = store.getSessionState(sessionId);
    expect(state).toBeDefined();
    expect(state!.content).toBe('Worked on a.ts and b.ts');
    expect(state!.layer).toBe('session');

    // Events pruned
    expect(store.getEventCount(sessionId)).toBe(0);
  });

  it('session appears consolidated after writeSessionSummary', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const s = store.createSession();
    store.endSession(s.id);

    writeSessionSummary(store, s.id, 'Summary text');

    const pending = getPendingConsolidation(store);
    expect(pending).toHaveLength(0);
  });
});

// ── Level 2: promoteSubagentNotes ─────────────────────────────────────

describe('promoteSubagentNotes', () => {
  it('promotes child session notes to parent', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const parent = store.createSession();
    const child = store.createSession({ parentSessionId: parent.id });

    store.insertNote({
      sessionId: child.id,
      kind: 'insight',
      content: 'Found something interesting',
    });

    promoteSubagentNotes(store, parent.id);

    const parentNotes = store.getActiveNotes(parent.id);
    expect(parentNotes).toHaveLength(1);
    expect(parentNotes[0]!.content).toBe('Found something interesting');
  });

  it('deduplicates identical notes on promotion', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const parent = store.createSession();
    const child = store.createSession({ parentSessionId: parent.id });

    // Same note in both parent and child
    store.insertNote({
      sessionId: parent.id,
      kind: 'insight',
      content: 'Duplicate insight',
    });
    store.insertNote({
      sessionId: child.id,
      kind: 'insight',
      content: 'Duplicate insight',
    });

    promoteSubagentNotes(store, parent.id);

    const parentNotes = store.getActiveNotes(parent.id);
    // Should still be only 1, not 2
    expect(parentNotes).toHaveLength(1);
  });

  it('flags conflicting notes (same kind+subject, different content)', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const parent = store.createSession();
    const child = store.createSession({ parentSessionId: parent.id });

    store.insertNote({
      sessionId: parent.id,
      kind: 'decision',
      subject: 'auth-strategy',
      content: 'Use JWT',
    });
    store.insertNote({
      sessionId: child.id,
      kind: 'decision',
      subject: 'auth-strategy',
      content: 'Use sessions instead',
    });

    promoteSubagentNotes(store, parent.id);

    const parentNotes = store.getActiveNotes(parent.id);
    // Should have 2 notes (original + promoted)
    expect(parentNotes).toHaveLength(2);

    // Both should be marked as conflict
    for (const note of parentNotes) {
      expect(note.conflict).toBe(true);
    }
  });

  it('promotes notes from multiple children', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const parent = store.createSession();
    const child1 = store.createSession({ parentSessionId: parent.id });
    const child2 = store.createSession({ parentSessionId: parent.id });

    store.insertNote({ sessionId: child1.id, kind: 'insight', content: 'Insight from child 1' });
    store.insertNote({ sessionId: child2.id, kind: 'insight', content: 'Insight from child 2' });

    promoteSubagentNotes(store, parent.id);

    const parentNotes = store.getActiveNotes(parent.id);
    expect(parentNotes).toHaveLength(2);
    const contents = parentNotes.map(n => n.content);
    expect(contents).toContain('Insight from child 1');
    expect(contents).toContain('Insight from child 2');
  });
});
