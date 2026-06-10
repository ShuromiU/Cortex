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
    const resolved = item.text.toLowerCase().includes('status: resolved') ? ' (resolved)' : '';
    const timestamp = formatMemoryTimestamp(item.created_at);
    const timestampPart = timestamp ? ` [${timestamp}]` : '';
    return `${label}${timestampPart}: ${subject}${content}${resolved}${renderReferenceLabel(item)}`;
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
