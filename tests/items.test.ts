import { describe, it, expect } from 'vitest';
import {
  buildNoteMemoryText,
  demoteMemoryState,
  isSupersededMemoryText,
  memoryStateForNote,
  type MemoryItemState,
} from '../src/memory/items.js';
import type { ParsedNote } from '../src/db/store.js';

function makeNote(overrides: Partial<ParsedNote> = {}): ParsedNote {
  return {
    id: 'note-1',
    session_id: 'session-1',
    timestamp: '2026-07-01T12:00:00.000Z',
    kind: 'decision',
    subject: 'auth strategy',
    content: 'use OIDC',
    alternatives: null,
    status: 'active',
    conflict: 0,
    ...overrides,
  };
}

// ── demoteMemoryState (FR-4, Story 1.4) ────────────────────────────────

describe('demoteMemoryState', () => {
  it('steps hot to warm and warm to cold', () => {
    expect(demoteMemoryState('hot')).toBe('warm');
    expect(demoteMemoryState('warm')).toBe('cold');
  });

  it('floors at cold — demotion never archives, or retrievability dies with it', () => {
    expect(demoteMemoryState('cold')).toBe('cold');
  });

  it('never touches pinned — a pin is explicit user intent', () => {
    expect(demoteMemoryState('pinned')).toBe('pinned');
  });

  it('leaves archived alone — pre-1.4 rows stay where they were', () => {
    expect(demoteMemoryState('archived')).toBe('archived');
  });

  it('is idempotent from the floor', () => {
    let state: MemoryItemState = 'hot';
    state = demoteMemoryState(state);
    state = demoteMemoryState(state);
    state = demoteMemoryState(state);
    expect(state).toBe('cold');
  });
});

// ── isSupersededMemoryText ─────────────────────────────────────────────

describe('isSupersededMemoryText', () => {
  it('fires on the projected status line', () => {
    const text = buildNoteMemoryText(makeNote({ status: 'superseded' }));
    expect(text).toContain('Status: superseded');
    expect(isSupersededMemoryText(text)).toBe(true);
  });

  it('is line-exact — a note that merely discusses the status does not fire', () => {
    expect(
      isSupersededMemoryText('decision: the old plan has status: superseded in the tracker'),
    ).toBe(false);
  });

  it('tolerates case and surrounding whitespace, as isContested does', () => {
    expect(isSupersededMemoryText('decision: x\n  STATUS: SUPERSEDED  ')).toBe(true);
  });

  it('does not fire on active or resolved notes', () => {
    expect(isSupersededMemoryText(buildNoteMemoryText(makeNote()))).toBe(false);
    expect(isSupersededMemoryText(buildNoteMemoryText(makeNote({ status: 'resolved' })))).toBe(
      false,
    );
  });
});

// ── memoryStateForNote — superseded lands cold, not archived ───────────

describe('memoryStateForNote — superseded (FR-4)', () => {
  it('maps superseded to cold so history stays retrievable', () => {
    // Pre-1.4 this was 'archived', which searchMemoryItems excludes by SQL —
    // a superseded decision was not merely cold, it was invisible.
    expect(memoryStateForNote('decision', 'superseded')).toBe('cold');
    expect(memoryStateForNote('intent', 'superseded')).toBe('cold');
  });

  it('leaves the other status mappings untouched', () => {
    expect(memoryStateForNote('decision', 'resolved')).toBe('cold');
    expect(memoryStateForNote('decision', 'active')).toBe('warm');
    expect(memoryStateForNote('focus', 'active')).toBe('hot');
    expect(memoryStateForNote('blocker', 'active')).toBe('hot');
  });
});
