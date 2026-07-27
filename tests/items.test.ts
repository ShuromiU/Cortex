import { describe, it, expect } from 'vitest';
import {
  buildNoteMemoryText,
  demoteMemoryState,
  isSupersededMemoryItem,
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

  it('matches the label exactly, never a shouted or lowercased lookalike', () => {
    // Exact-case, the renderedAlternatives discipline: buildNoteMemoryText only
    // ever emits `Status: superseded`, so case-insensitivity has no true
    // positive to gain and admits captured log text.
    for (const line of ['STATUS: SUPERSEDED', 'status: superseded', 'Status: SUPERSEDED']) {
      expect(isSupersededMemoryText(`decision: x\n${line}`)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace and CRLF on the projected line', () => {
    expect(isSupersededMemoryText('decision: x\n  Status: superseded  ')).toBe(true);
    expect(isSupersededMemoryText('decision: x\r\nStatus: superseded\r')).toBe(true);
  });

  it('does not fire on active or resolved notes', () => {
    expect(isSupersededMemoryText(buildNoteMemoryText(makeNote()))).toBe(false);
    expect(isSupersededMemoryText(buildNoteMemoryText(makeNote({ status: 'resolved' })))).toBe(
      false,
    );
  });

  it('is trailer-scoped — content quoting the line does not retire an active note', () => {
    // The 1.3 lesson, applied here where the stakes are higher: without the
    // trailer scan, this note would be demote-capped, stale-penalized, and
    // excluded from the SessionStart brief and reflex, unclearably — its
    // status is 'active' and cortex_resolve writes columns, not text.
    const projected = buildNoteMemoryText(
      makeNote({
        content: 'keep the old rabbitmq entry\nStatus: superseded\nfor the audit trail',
      }),
    );
    expect(projected).toContain('Status: superseded'); // the quote is really there
    expect(isSupersededMemoryText(projected)).toBe(false);
  });

  it('rejects a content line even at the end of content — Subject: follows it', () => {
    const projected = buildNoteMemoryText(
      makeNote({ content: 'the tracker now reads\nStatus: superseded' }),
    );
    // Projection order is content, Subject, [Status] — so the quoted line sits
    // ABOVE Subject:, which breaks canonical trailer order.
    expect(isSupersededMemoryText(projected)).toBe(false);
  });

  it('still fires on a genuinely superseded note whose content also quotes the line', () => {
    const projected = buildNoteMemoryText(
      makeNote({
        content: 'replaces the entry marked\nStatus: superseded\nin the tracker',
        status: 'superseded',
      }),
    );
    expect(isSupersededMemoryText(projected)).toBe(true);
  });

  it('documents the residual: a subject-less insight ending with the line', () => {
    // No Subject: line exists to separate content from trailer, so a trailing
    // quoted line is byte-identical to a real projection. Same bounded
    // exposure renderedAlternatives carries; unreachable for decision, intent,
    // blocker and focus, whose subjects are mandatory.
    expect(isSupersededMemoryText('insight: some prose\nStatus: superseded')).toBe(true);
  });
});

describe('isSupersededMemoryItem', () => {
  it('is false for kinds that have no status at all', () => {
    // An episode's captured stderr can carry the exact line — this repo's own
    // vitest failure output does. A fresh command failure exists to land hot;
    // its own log must not demote it.
    for (const kind of ['episode:command_failure', 'command_run', 'branch_snapshot']) {
      expect(isSupersededMemoryItem({ kind, text: 'boom\nStatus: superseded' })).toBe(false);
    }
  });

  it('is true for a superseded note item', () => {
    expect(
      isSupersededMemoryItem({
        kind: 'note:decision',
        text: buildNoteMemoryText(makeNote({ status: 'superseded' })),
      }),
    ).toBe(true);
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
