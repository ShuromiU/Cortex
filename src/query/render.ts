import type { ParsedMemoryItem } from '../db/store.js';

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
    return `${label}: ${subject}${content}${resolved}`;
  }

  if (item.kind === 'session_state' || item.kind === 'episode:session_summary') {
    return `[session state] ${renderMemorySnippet(item.text, maxLines)}`;
  }

  if (item.kind === 'project_snapshot') {
    return `[project state] ${renderMemorySnippet(item.text, maxLines)}`;
  }

  const label = humanizeMemoryKind(item.kind);
  const subject = item.subject ? `[${item.subject}] ` : '';
  return `${label}: ${subject}${renderMemorySnippet(item.text, maxLines)}`;
}
