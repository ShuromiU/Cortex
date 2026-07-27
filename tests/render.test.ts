import { describe, it, expect } from 'vitest';
import type { ParsedMemoryItem } from '../src/db/store.js';
import {
  CONTESTED_MARKER,
  groupContestedAdjacent,
  isContested,
  renderMemoryLine,
} from '../src/query/render.js';
import { estimateTokens } from '../src/query/retrieval.js';

// ── Helpers ────────────────────────────────────────────────────────────

let counter = 0;

function makeItem(overrides: Partial<ParsedMemoryItem> = {}): ParsedMemoryItem {
  counter += 1;
  return {
    id: `item-${counter}`,
    session_id: 'session-1',
    scope_type: 'branch',
    scope_key: 'repo@main',
    kind: 'note:decision',
    source_table: 'notes',
    source_id: `note-${counter}`,
    subject: 'spool flush',
    text: 'decision: flush the spool at turn end',
    state: 'warm',
    importance: 0.9,
    access_count: 0,
    last_accessed_at: null,
    created_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

/** A note whose projected text carries the conflict marker written by buildNoteMemoryText. */
function contestedItem(overrides: Partial<ParsedMemoryItem> = {}): ParsedMemoryItem {
  const base = makeItem(overrides);
  return { ...base, text: `${base.text}\nSubject: ${base.subject}\nConflict: true` };
}

function idsOf(items: ParsedMemoryItem[]): string[] {
  return items.map(item => item.id);
}

// ── isContested ────────────────────────────────────────────────────────

describe('isContested', () => {
  it('is true when the projected text carries the conflict line', () => {
    expect(isContested(contestedItem())).toBe(true);
  });

  it('is false for an ordinary note', () => {
    expect(isContested(makeItem())).toBe(false);
  });

  it('matches case-insensitively, as the projection is not case-guaranteed', () => {
    expect(isContested(makeItem({ text: 'decision: x\nCONFLICT: TRUE' }))).toBe(true);
  });

  it('does not fire on a resolved-only note', () => {
    expect(isContested(makeItem({ text: 'decision: x\nStatus: resolved' }))).toBe(false);
  });
});

// ── CONTESTED_MARKER ───────────────────────────────────────────────────

describe('CONTESTED_MARKER', () => {
  // AC #1 caps the marker at 4 tokens. Assert the AC's number, not today's value,
  // so shortening the marker stays legal and lengthening it past the cap does not.
  it('costs no more than 4 tokens', () => {
    expect(estimateTokens(CONTESTED_MARKER)).toBeLessThanOrEqual(4);
  });

  it('reads as [contested], not the pre-1.2 [conflict]', () => {
    expect(CONTESTED_MARKER).toContain('[contested]');
    expect(CONTESTED_MARKER).not.toContain('[conflict]');
  });
});

// ── renderMemoryLine ───────────────────────────────────────────────────

describe('renderMemoryLine — contested marker', () => {
  it('marks a contested note', () => {
    expect(renderMemoryLine(contestedItem())).toContain('[contested]');
  });

  it('leaves an uncontested note unmarked', () => {
    expect(renderMemoryLine(makeItem())).not.toContain('[contested]');
  });

  it('orders the marker before (resolved) when both apply', () => {
    const item = makeItem({
      text: 'decision: flush the spool at turn end\nConflict: true\nStatus: resolved',
    });
    const line = renderMemoryLine(item);
    expect(line.indexOf('[contested]')).toBeGreaterThan(-1);
    expect(line.indexOf('[contested]')).toBeLessThan(line.indexOf('(resolved)'));
  });

  it('keeps the marker inside the note content, ahead of any reference label', () => {
    const line = renderMemoryLine(contestedItem());
    expect(line).toMatch(/flush the spool at turn end\s*\[contested\]/);
  });

  it('never emits the pre-1.2 [conflict] marker', () => {
    expect(renderMemoryLine(contestedItem())).not.toContain('[conflict]');
  });
});

// ── groupContestedAdjacent ─────────────────────────────────────────────

describe('groupContestedAdjacent', () => {
  it('pulls a split contested pair back together', () => {
    const a = contestedItem({ id: 'a', subject: 'spool flush' });
    const noise = makeItem({ id: 'noise', subject: 'unrelated' });
    const b = contestedItem({ id: 'b', subject: 'spool flush' });

    expect(idsOf(groupContestedAdjacent([a, noise, b]))).toEqual(['a', 'b', 'noise']);
  });

  it('never changes rank 0', () => {
    const top = makeItem({ id: 'top', subject: 'unrelated' });
    const a = contestedItem({ id: 'a', subject: 'spool flush' });
    const noise = makeItem({ id: 'noise', subject: 'other' });
    const b = contestedItem({ id: 'b', subject: 'spool flush' });

    const result = groupContestedAdjacent([top, a, noise, b]);
    expect(result[0]!.id).toBe('top');
    expect(idsOf(result)).toEqual(['top', 'a', 'b', 'noise']);
  });

  it('does not pair the same subject across different scopes', () => {
    const a = contestedItem({ id: 'a', subject: 'spool flush', scope_key: 'repo@main' });
    const noise = makeItem({ id: 'noise', subject: 'unrelated' });
    const b = contestedItem({ id: 'b', subject: 'spool flush', scope_key: 'repo@feature' });

    expect(idsOf(groupContestedAdjacent([a, noise, b]))).toEqual(['a', 'noise', 'b']);
  });

  it('does not pull up an uncontested item sharing the subject', () => {
    const a = contestedItem({ id: 'a', subject: 'spool flush' });
    const noise = makeItem({ id: 'noise', subject: 'unrelated' });
    const sameSubject = makeItem({ id: 'plain', subject: 'spool flush' });

    expect(idsOf(groupContestedAdjacent([a, noise, sameSubject]))).toEqual([
      'a',
      'noise',
      'plain',
    ]);
  });

  it('leaves a contested item whose counterpart is absent where it ranked', () => {
    const top = makeItem({ id: 'top', subject: 'unrelated' });
    const lonely = contestedItem({ id: 'lonely', subject: 'spool flush' });

    expect(idsOf(groupContestedAdjacent([top, lonely]))).toEqual(['top', 'lonely']);
  });

  it('groups a three-way contest together', () => {
    const a = contestedItem({ id: 'a', subject: 'spool flush' });
    const noise = makeItem({ id: 'noise', subject: 'unrelated' });
    const b = contestedItem({ id: 'b', subject: 'spool flush' });
    const other = makeItem({ id: 'other', subject: 'something' });
    const c = contestedItem({ id: 'c', subject: 'spool flush' });

    expect(idsOf(groupContestedAdjacent([a, noise, b, other, c]))).toEqual([
      'a',
      'b',
      'c',
      'noise',
      'other',
    ]);
  });

  it('preserves input order when nothing is contested', () => {
    const items = [
      makeItem({ id: 'x' }),
      makeItem({ id: 'y' }),
      makeItem({ id: 'z' }),
    ];
    expect(idsOf(groupContestedAdjacent(items))).toEqual(['x', 'y', 'z']);
  });

  it('ignores contested items with no subject — there is nothing to pair on', () => {
    const a = contestedItem({ id: 'a', subject: null });
    const noise = makeItem({ id: 'noise', subject: 'unrelated' });
    const b = contestedItem({ id: 'b', subject: null });

    expect(idsOf(groupContestedAdjacent([a, noise, b]))).toEqual(['a', 'noise', 'b']);
  });

  it('does not mutate its input', () => {
    const items = [
      contestedItem({ id: 'a', subject: 'spool flush' }),
      makeItem({ id: 'noise', subject: 'unrelated' }),
      contestedItem({ id: 'b', subject: 'spool flush' }),
    ];
    const before = idsOf(items);
    groupContestedAdjacent(items);
    expect(idsOf(items)).toEqual(before);
  });
});
