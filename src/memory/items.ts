import type {
  BranchSnapshotRow,
  ParsedCommandRun,
  ParsedEpisode,
  ParsedNote,
} from '../db/store.js';

export type MemoryItemState = 'pinned' | 'hot' | 'warm' | 'cold' | 'archived';

function pushLine(lines: string[], label: string, value?: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) {
    lines.push(`${label}: ${trimmed}`);
  }
}

export function memoryStateForNote(kind: string, status: string): MemoryItemState {
  if (status === 'superseded') {
    return 'archived';
  }

  if (status !== 'active') {
    return 'cold';
  }

  if (kind === 'focus' || kind === 'intent' || kind === 'blocker') {
    return 'hot';
  }

  return 'warm';
}

export function noteImportance(kind: string): number {
  switch (kind) {
    case 'focus':
      return 1.0;
    case 'blocker':
      return 0.95;
    case 'decision':
      return 0.9;
    case 'intent':
      return 0.85;
    case 'insight':
      return 0.7;
    default:
      return 0.5;
  }
}

export function buildNoteMemoryText(note: ParsedNote): string {
  const lines: string[] = [];
  lines.push(`${note.kind}: ${note.content}`);
  pushLine(lines, 'Subject', note.subject);
  if (note.alternatives && note.alternatives.length > 0) {
    lines.push(`Alternatives: ${note.alternatives.join(', ')}`);
  }
  if (note.conflict) {
    lines.push('Conflict: true');
  }
  if (note.status !== 'active') {
    lines.push(`Status: ${note.status}`);
  }
  return lines.join('\n');
}

export function commandRunState(run: ParsedCommandRun): MemoryItemState {
  if (typeof run.exit_code === 'number' && run.exit_code !== 0) {
    return 'warm';
  }
  return 'cold';
}

export function commandRunImportance(run: ParsedCommandRun): number {
  if (typeof run.exit_code === 'number' && run.exit_code !== 0) {
    return 0.72;
  }
  if (run.category === 'test' || run.category === 'build' || run.category === 'git') {
    return 0.45;
  }
  return 0.3;
}

export function buildCommandMemoryText(run: ParsedCommandRun): string {
  const lines: string[] = [];
  const prefix = run.category ? `[${run.category}] ` : '';
  const summary = run.command_summary ?? 'command run';
  const exitSuffix =
    typeof run.exit_code === 'number' ? ` (exit ${run.exit_code})` : '';
  lines.push(`${prefix}${summary}${exitSuffix}`.trim());

  if (run.files_touched.length > 0) {
    lines.push(`Files: ${run.files_touched.join(', ')}`);
  }
  pushLine(lines, 'Stdout', run.stdout_tail);
  pushLine(lines, 'Stderr', run.stderr_tail);

  return lines.join('\n');
}

export function episodeState(kind: string): MemoryItemState {
  if (kind === 'command_failure') {
    return 'hot';
  }
  return 'warm';
}

export function episodeImportance(kind: string): number {
  switch (kind) {
    case 'command_failure':
      return 0.88;
    case 'test_cycle':
      return 0.8;
    case 'session_summary':
      return 0.68;
    default:
      return 0.6;
  }
}

export function buildEpisodeMemoryText(episode: ParsedEpisode): string {
  const lines: string[] = [episode.summary];

  if (episode.target) {
    lines.push(`Target: ${episode.target}`);
  }

  const files = Array.isArray(episode.metadata['files'])
    ? (episode.metadata['files'] as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  if (files.length > 0) {
    lines.push(`Files: ${files.join(', ')}`);
  }

  const commandSummary = episode.metadata['command_summary'];
  if (typeof commandSummary === 'string' && commandSummary.trim().length > 0) {
    lines.push(`Command: ${commandSummary}`);
  }

  const stdoutTail = episode.metadata['stdout_tail'];
  if (typeof stdoutTail === 'string' && stdoutTail.trim().length > 0) {
    lines.push(`Stdout: ${stdoutTail}`);
  }

  const stderrTail = episode.metadata['stderr_tail'];
  if (typeof stderrTail === 'string' && stderrTail.trim().length > 0) {
    lines.push(`Stderr: ${stderrTail}`);
  }

  return lines.join('\n');
}

export function buildBranchSnapshotMemoryText(snapshot: BranchSnapshotRow): string {
  const lines: string[] = [];
  pushLine(lines, 'Focus', snapshot.focus);
  pushLine(lines, 'Summary', snapshot.summary);
  if (snapshot.intents.length > 0) {
    lines.push(`Intents: ${snapshot.intents.join(' | ')}`);
  }
  if (snapshot.blockers.length > 0) {
    lines.push(`Blockers: ${snapshot.blockers.join(' | ')}`);
  }
  if (snapshot.recent_files.length > 0) {
    lines.push(`Recent files: ${snapshot.recent_files.join(', ')}`);
  }
  return lines.join('\n');
}

export function buildProjectSnapshotMemoryText(
  summary: string,
  noteDigest?: string | null,
): string {
  const lines: string[] = [];
  pushLine(lines, 'Summary', summary);
  pushLine(lines, 'Notes', noteDigest);
  return lines.join('\n');
}
