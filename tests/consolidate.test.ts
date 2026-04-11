import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { consolidateLevel1, renderCompressed } from '../src/capture/consolidate.js';
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
