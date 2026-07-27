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
  // 'cold', not 'archived' (FR-4): archived is excluded from retrieval by SQL,
  // so an archived predecessor is not merely demoted — it is invisible, and
  // "what did we decide before" cannot reach it. This is the fresh-projection
  // landing (backfill, or a sync with no pre-existing item); a live supersede
  // demotes the existing item one tier at the transition site instead.
  if (status !== 'active') {
    return 'cold';
  }

  if (kind === 'focus' || kind === 'intent' || kind === 'blocker') {
    return 'hot';
  }

  return 'warm';
}

/**
 * One tier colder (FR-4): hot→warm, warm→cold, floor at cold. The floor is the
 * point — demoting into `archived` would silently re-create the invisibility
 * this story removes. Pinned is explicit user intent and is never auto-demoted;
 * archived rows (pre-1.4 supersedes) stay where they were, forward-only.
 */
export function demoteMemoryState(state: MemoryItemState): MemoryItemState {
  switch (state) {
    case 'hot':
      return 'warm';
    case 'warm':
    case 'cold':
      return 'cold';
    default:
      return state;
  }
}

/**
 * The trailer `buildNoteMemoryText` appends after a note's content, in the
 * order it writes them. Each is optional; the order never varies.
 */
const NOTE_TRAILER_LABELS = ['Subject: ', 'Alternatives: ', 'Conflict: ', 'Status: '];

/**
 * The lines `buildNoteMemoryText` appended, separated from free-form content.
 *
 * Note content may contain newlines, so `text` is content lines followed by
 * the trailer with nothing marking the boundary. Walking back from the end and
 * requiring the labels to appear in their canonical order recovers it: a real
 * trailer line always sits after the content, while one typed *into* the
 * content sits before whatever trailer the projection appended. Matching is
 * exact-case because the projection only ever emits these literals —
 * lowercasing would admit shouted text from captured logs.
 *
 * Lives here rather than in `query/render.ts` (where Story 1.3 first built it)
 * because `memory/hotness.ts` needs trailer-scoped reads too and the layer
 * direction only permits `query/ → memory/`.
 */
export function noteTrailerLines(text: string): string[] {
  const lines = text.split('\n');
  const trailer: string[] = [];
  let maxLabel = NOTE_TRAILER_LABELS.length - 1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    const label = NOTE_TRAILER_LABELS.findIndex(candidate => line.startsWith(candidate));
    if (label < 0 || label > maxLabel) {
      break;
    }
    maxLabel = label;
    trailer.unshift(line);
  }

  return trailer;
}

/**
 * Whether projected note text carries the `Status: superseded` trailer line.
 *
 * Trailer-scoped, not merely line-exact — the lesson Story 1.3's review taught
 * for `Alternatives:` applies identically here: a note whose free-form content
 * contains its own `Status: superseded` line would otherwise read as retired
 * while `notes.status` is `active`, and nothing could ever clear it —
 * `cortex_resolve` writes columns while this reads text. The consequences here
 * are worse than a label: the demotion cap, the stale penalty, and exclusion
 * from the SessionStart brief and reflex. The trailer scan rejects a content
 * line because `Subject:` (mandatory for every kind but `insight`) always
 * follows content, and a `Status:` above a `Subject:` breaks canonical order.
 * The residual — a subject-less insight whose content *ends* with the line —
 * is the same bounded, documented exposure `renderedAlternatives` carries.
 *
 * The `touchMemoryItems` SQL CASE necessarily stays a substring LIKE — same
 * pre-existing divergence the resolved branch has; the derive layer re-settles
 * any disagreement on the next refresh.
 */
export function isSupersededMemoryText(text: string): boolean {
  return noteTrailerLines(text).some(line => line === 'Status: superseded');
}

/**
 * The predicate call sites should use: kind-guarded, because only notes have a
 * status at all. An episode's captured stderr can contain a `Status:
 * superseded` line (this repo's own test output does), and without the guard a
 * fresh command-failure episode — which exists precisely to land hot — would
 * be demote-capped and stale-penalized by its own log text.
 */
export function isSupersededMemoryItem(item: { kind: string; text: string }): boolean {
  return item.kind.startsWith('note:') && isSupersededMemoryText(item.text);
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
  // Joined onto one line, so an alternative carrying a newline would split the
  // projection into a second `Alternatives:` line — truncating the list at best
  // and, since the reader has to pick one of them, letting note content pose as
  // the real list at worst. Collapse the whitespace here rather than teaching
  // every reader to cope with it. Empty entries are dropped so a trailing one
  // cannot render as a dangling comma.
  const alternatives = (note.alternatives ?? [])
    .map(alternative => alternative.replace(/\s+/g, ' ').trim())
    .filter(alternative => alternative.length > 0);
  if (alternatives.length > 0) {
    lines.push(`Alternatives: ${alternatives.join(', ')}`);
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
