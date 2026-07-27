import type { ParsedMemoryItem } from '../db/store.js';
import type { MemoryReferenceValidation } from './reference-validation.js';

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function humanizeMemoryKind(kind: string): string {
  if (kind.startsWith('note:')) {
    return titleCase(kind.slice('note:'.length));
  }

  if (kind.startsWith('episode:')) {
    return titleCase(kind.slice('episode:'.length).replace(/_/g, ' '));
  }

  if (kind === 'branch_snapshot') {
    return 'Snapshot';
  }

  if (kind === 'project_snapshot') {
    return 'Project';
  }

  if (kind === 'command_run') {
    return 'Command';
  }

  return titleCase(kind.replace(/_/g, ' '));
}

// ── Contested items (FR-2) ──────────────────────────────────────────────

/** Marker for an item in an unresolved contest. 12 chars → 3 tokens; AC caps it at 4. */
export const CONTESTED_MARKER = ' [contested]';

/**
 * A contest is recorded on `notes.conflict`, but `ParsedMemoryItem` carries no
 * such column — the signal survives projection only as the `Conflict: true`
 * line `buildNoteMemoryText` writes into the item text. Reading it back out is
 * forced rather than chosen: a real column needs a migration, and this release
 * spends its single `SCHEMA_VERSION` bump elsewhere.
 *
 * Two guards keep the sniff honest, both load-bearing:
 *
 * Only notes have a conflict column, so an episode or branch snapshot whose
 * captured stdout/stderr happens to carry the phrase is not in a contest — and
 * would otherwise be silently reordered by `groupContestedAdjacent` while
 * `renderMemoryLine` never marks it, leaving a reorder with no visible cause.
 *
 * The match is line-exact because `buildNoteMemoryText` always emits this as
 * its own line. A substring match makes a note that merely *discusses* the flag
 * ("insertNote sets conflict: true on both sides") render as contested — and
 * nothing could ever clear it, since `cortex_resolve` clears the column while
 * the marker is read from text.
 */
export function isContested(item: ParsedMemoryItem): boolean {
  if (!item.kind.startsWith('note:')) {
    return false;
  }

  return item.text
    .split('\n')
    .some(line => line.trim().toLowerCase() === 'conflict: true');
}

/**
 * Reorders results so both sides of a contest read together, pulling later
 * counterparts up to sit directly behind the highest-ranked side.
 *
 * Promoting the counterpart is the whole point, so items *do* move ahead of
 * where they ranked — only rank 0 is fixed. Two consequences follow and both
 * are intended: a budget that trims from the bottom now follows display order,
 * so a contested counterpart can be kept while a higher-ranked uncontested item
 * is dropped; and ranking metrics stay safe only because this runs in `recall`,
 * never inside `retrieveMemory`.
 *
 * Pairs on `(scope_key, subject)` because contradiction detection is
 * scope-keyed — the same subject on another branch is a different conversation,
 * not the other half of this one.
 */
export function groupContestedAdjacent<T extends ParsedMemoryItem>(items: T[]): T[] {
  const placed = new Set<number>();
  const ordered: T[] = [];

  for (let index = 0; index < items.length; index += 1) {
    if (placed.has(index)) {
      continue;
    }

    const item = items[index]!;
    placed.add(index);
    ordered.push(item);

    if (!item.subject || !isContested(item)) {
      continue;
    }

    for (let candidate = index + 1; candidate < items.length; candidate += 1) {
      if (placed.has(candidate)) {
        continue;
      }

      const other = items[candidate]!;
      if (
        other.subject === item.subject &&
        other.scope_key === item.scope_key &&
        isContested(other)
      ) {
        placed.add(candidate);
        ordered.push(other);
      }
    }
  }

  return ordered;
}

/**
 * Contested grouping confined to each run of equal kind, for surfaces that sort
 * by kind first. `brief` orders by `KIND_PRIORITY` and `state` renders
 * kind-headed sections; grouping across a kind boundary there would drag a
 * contested insight up into the decisions and destroy the primary ordering.
 * Within a bucket it costs nothing, and same-kind contests are the common case
 * — detection's prior is always a decision, so decisions contest decisions.
 * A cross-kind pair stays split on those surfaces; only `recall`, which is a
 * flat score-ordered list, can seat both sides together unconditionally.
 */
export function groupContestedWithinKind<T extends ParsedMemoryItem>(items: T[]): T[] {
  const ordered: T[] = [];

  let start = 0;
  while (start < items.length) {
    let end = start + 1;
    while (end < items.length && items[end]!.kind === items[start]!.kind) {
      end += 1;
    }
    ordered.push(...groupContestedAdjacent(items.slice(start, end)));
    start = end;
  }

  return ordered;
}

export function renderMemorySnippet(
  text: string,
  maxLines = 3,
  maxChars = 260,
): string {
  const trimmed = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, maxLines)
    .join(' | ');

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

export function formatMemoryTimestamp(createdAt: string): string | null {
  const parsed = new Date(createdAt);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function getReferenceValidation(
  item: ParsedMemoryItem,
): MemoryReferenceValidation | undefined {
  return (item as ParsedMemoryItem & {
    reference_validation?: MemoryReferenceValidation;
  }).reference_validation;
}

function renderReferenceLabel(item: ParsedMemoryItem): string {
  const validation = getReferenceValidation(item);
  return validation?.label ? ` [${validation.label}]` : '';
}

/** Compact relative age: 'today', 'Nd ago', or the ISO date past 30 days. */
export function formatAgeLabel(createdAt: string): string | null {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const days = Math.floor((Date.now() - parsed) / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    return 'today';
  }
  if (days <= 30) {
    return `${days}d ago`;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

/** One-word trust summary of an item's file references. */
export function describeValidity(item: ParsedMemoryItem): string {
  const validation = getReferenceValidation(item);
  if (!validation || validation.references.length === 0) {
    return 'no file refs';
  }
  if (validation.missing > 0) {
    return 'stale refs';
  }
  if (validation.moved > 0) {
    return 'refs moved';
  }
  if (validation.exists > 0) {
    return 'refs OK';
  }
  return 'refs unverified';
}

export function renderMemoryLine(item: ParsedMemoryItem, maxLines = 3): string {
  if (item.kind.startsWith('note:')) {
    const label = humanizeMemoryKind(item.kind);
    const lines = item.text.split('\n');
    const firstLine = lines[0] ?? '';
    const content = firstLine.includes(': ')
      ? firstLine.slice(firstLine.indexOf(': ') + 2)
      : firstLine;
    const subject = item.subject ? `[${item.subject}] ` : '';
    const contested = isContested(item) ? CONTESTED_MARKER : '';
    const resolved = item.text.toLowerCase().includes('status: resolved') ? ' (resolved)' : '';
    const timestamp = formatMemoryTimestamp(item.created_at);
    const timestampPart = timestamp ? ` [${timestamp}]` : '';
    return `${label}${timestampPart}: ${subject}${content}${contested}${resolved}${renderReferenceLabel(item)}`;
  }

  if (item.kind === 'session_state' || item.kind === 'episode:session_summary') {
    return `[session state] ${renderMemorySnippet(item.text, maxLines)}${renderReferenceLabel(item)}`;
  }

  if (item.kind === 'project_snapshot') {
    return `[project state] ${renderMemorySnippet(item.text, maxLines)}${renderReferenceLabel(item)}`;
  }

  const label = humanizeMemoryKind(item.kind);
  const subject = item.subject ? `[${item.subject}] ` : '';
  return `${label}: ${subject}${renderMemorySnippet(item.text, maxLines)}${renderReferenceLabel(item)}`;
}
