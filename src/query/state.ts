import type { BranchSnapshotRow, CortexStore, ParsedMemoryItem } from '../db/store.js';
import { consolidateLevel1, renderCompressed } from '../capture/consolidate.js';
import { selectWorkingMemoryItems } from '../memory/hotness.js';
import { deriveProjectScopeKey } from '../scope/keys.js';
import { getPreferredScope } from './scope.js';
import { validateMemoryReferences } from './reference-validation.js';
import {
  formatMemoryTimestamp,
  humanizeMemoryKind,
  renderMemoryLine,
  renderMemorySnippet,
} from './render.js';

const LOAD_BEARING_NOTE_KINDS = new Set([
  'intent',
  'focus',
  'decision',
  'blocker',
  'insight',
]);

const EMPTY_FULL_STATE_FALLBACK = [
  'Cortex state: no current working memory for this scope.',
  'Use cortex_route for the capability map, or cortex_recall(topic) if you are resuming a known area.',
].join('\n');

export function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    const formatted = k % 1 === 0 ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `${formatted}k`;
  }
  return String(n);
}

function trimSummary(summary: string, maxLines: number = 3): string {
  return summary
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, maxLines)
    .join('\n');
}

function renderHeaderSnapshot(snapshot: BranchSnapshotRow): string {
  const lines: string[] = [];

  if (snapshot.summary) {
    lines.push(trimSummary(snapshot.summary));
  }

  if (snapshot.blockers.length > 0) {
    lines.push(`Blockers: ${snapshot.blockers.slice(0, 2).join(' | ')}`);
  }

  if (snapshot.recent_files.length > 0) {
    lines.push(`Recent files: ${snapshot.recent_files.slice(0, 4).join(', ')}`);
  }

  return lines.join('\n');
}

function resolveProjectScopeKey(store: CortexStore): string {
  const rootPath = store.getMeta('root_path');
  return rootPath ? deriveProjectScopeKey(rootPath) : 'project:default';
}

function resolveWorkingScopeKeys(store: CortexStore): string[] {
  const preferredScope = getPreferredScope(store);
  const scopeKeys: string[] = [];

  if (preferredScope?.scopeKey) {
    scopeKeys.push(preferredScope.scopeKey);
  }

  const projectScopeKey = resolveProjectScopeKey(store);
  if (!scopeKeys.includes(projectScopeKey)) {
    scopeKeys.push(projectScopeKey);
  }

  return scopeKeys;
}

function resolveWorkingSet(store: CortexStore, limit: number): ParsedMemoryItem[] {
  const preferredScope = getPreferredScope(store);
  const scopeKeys = resolveWorkingScopeKeys(store);
  if (scopeKeys.length === 0) {
    return [];
  }

  return selectWorkingMemoryItems(
    store,
    scopeKeys,
    preferredScope?.scopeKey ?? projectScopeKey(store),
    Math.max(limit * 4, limit + 20),
  )
    .filter(item => !validateMemoryReferences(store, item).stale)
    .slice(0, limit);
}

function projectScopeKey(store: CortexStore): string {
  return resolveProjectScopeKey(store);
}

function renderHeaderHighlights(items: ParsedMemoryItem[]): string | null {
  const highlights = items
    .filter(item => item.state === 'hot' || item.state === 'pinned')
    .filter(item =>
      item.kind.startsWith('note:') ||
      item.kind === 'episode:command_failure' ||
      item.kind === 'episode:test_cycle',
    )
    .slice(0, 2)
    .map(item => renderMemorySnippet(renderMemoryLine(item, 1), 1, 110));

  if (highlights.length === 0) {
    return null;
  }

  return `Hot: ${highlights.join(' | ')}`;
}

type UsagePolicyMode = 'fresh' | 'selective' | 'resume';

function renderUsagePolicy(mode: UsagePolicyMode): string[] {
  switch (mode) {
    case 'fresh':
      return [
        'Cortex is ambient: capture is on after SessionStart, and reflex whispers only when prior context is high-confidence.',
        'Use cortex_route for memory capabilities; keep cortex_note for durable decisions, blockers, and non-obvious discoveries.',
      ];

    case 'resume':
      return [
        'Cortex is ambient: prior context may surface automatically as short reflex whispers on focus shifts.',
        'Use cortex_recall(topic) proactively before non-trivial familiar work; use cortex_state for broad resumptions and cortex_brief before delegation.',
      ];

    case 'selective':
      return [
        'Cortex is ambient: no startup ritual is required, and silence is normal when no high-confidence memory matches.',
        'Use cortex_route for help, cortex_recall(topic) when prior work may matter, and cortex_note for durable decisions, blockers, and insights.',
      ];
  }

  throw new Error(`Unknown usage policy mode: ${mode}`);
}

function withUsagePolicy(lines: string[], mode: UsagePolicyMode): string {
  return [...lines.filter(line => line.length > 0), ...renderUsagePolicy(mode)].join('\n');
}

function renderResumeCandidate(items: ParsedMemoryItem[]): string | null {
  const candidate = items
    .filter(item => item.state === 'hot' || item.state === 'pinned')
    .find(item => item.kind === 'note:intent' || item.kind === 'note:focus');
  if (!candidate) {
    return null;
  }
  const subjectPart = candidate.subject ? `[${candidate.subject}] ` : '';
  const content = renderMemorySnippet(extractNoteContent(candidate), 1, 100);
  if (!content) {
    return null;
  }
  return `Resume: ${subjectPart}${content}`;
}

function renderSnapshotSection(snapshot: BranchSnapshotRow): string {
  const lines: string[] = [];

  if (snapshot.focus) {
    lines.push(`Last focus: ${snapshot.focus}`);
  }

  const summary = filterRenderedCommandNoise(snapshot.summary);
  if (summary) {
    lines.push(summary);
  }

  if (snapshot.intents.length > 0) {
    lines.push(`Stored intents: ${snapshot.intents.join(' | ')}`);
  }

  if (snapshot.blockers.length > 0) {
    lines.push(`Stored blockers: ${snapshot.blockers.join(' | ')}`);
  }

  if (snapshot.recent_files.length > 0) {
    lines.push(`Recent files: ${snapshot.recent_files.join(', ')}`);
  }

  return lines.join('\n');
}

function isRenderedCommandNoise(line: string): boolean {
  return /^Command \([^)]+\): exit \??\d*$/.test(line.trim());
}

function filterRenderedCommandNoise(summary: string): string {
  return summary
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !isRenderedCommandNoise(line))
    .join('\n');
}

function resolveRecentSessions(store: CortexStore, scopeKey: string | null, limit: number) {
  return scopeKey
    ? store.getRecentSessionsByScope(scopeKey, limit)
    : store.getRecentSessions(limit);
}

function resolveUnconsolidatedSessions(store: CortexStore, scopeKey: string | null) {
  return scopeKey
    ? store.getUnconsolidatedSessionsByScope(scopeKey)
    : store.getUnconsolidatedSessions();
}

function resolveActiveNotes(store: CortexStore, scopeKey: string | null) {
  return scopeKey
    ? store.getActiveNotesByScope(scopeKey)
    : store.getActiveNotes();
}

function extractNoteContent(item: ParsedMemoryItem): string {
  const firstLine = item.text.split('\n')[0] ?? '';
  const marker = ': ';
  const markerIndex = firstLine.indexOf(marker);
  if (markerIndex >= 0) {
    return firstLine.slice(markerIndex + marker.length);
  }
  return firstLine;
}

function renderNoteBullet(item: ParsedMemoryItem): string {
  const subject = item.subject ? `[${item.subject}] ` : '';
  const conflict = item.text.toLowerCase().includes('conflict: true') ? ' [conflict]' : '';
  const resolved = item.text.toLowerCase().includes('status: resolved') ? ' (resolved)' : '';
  const timestamp = formatMemoryTimestamp(item.created_at);
  const timestampPart = timestamp ? ` [${timestamp}]` : '';
  return `- ${humanizeMemoryKind(item.kind)}${timestampPart}: ${subject}${extractNoteContent(item)}${conflict}${resolved}`;
}

function renderWorkingNotes(items: ParsedMemoryItem[]): string[] {
  const sections: string[] = [];
  const order = ['note:intent', 'note:focus', 'note:decision', 'note:blocker', 'note:insight'];
  const labels: Record<string, string> = {
    'note:intent': 'Intents',
    'note:focus': 'Focus',
    'note:decision': 'Decisions',
    'note:blocker': 'Blockers',
    'note:insight': 'Insights',
  };

  for (const kind of order) {
    const notes = items.filter(item => item.kind === kind);
    if (notes.length === 0) {
      continue;
    }

    sections.push(`${labels[kind]}:\n${notes.map(renderNoteBullet).join('\n')}`);
  }

  return sections;
}

function noteDedupeKey(item: ParsedMemoryItem): string {
  return item.source_table === 'notes' && item.source_id
    ? `notes:${item.source_id}`
    : item.id;
}

function resolveCurrentSessionNotes(
  store: CortexStore,
  sessionId: string | null | undefined,
): ParsedMemoryItem[] {
  if (!sessionId) {
    return [];
  }

  return store.getActiveNotes(sessionId)
    .filter(note => LOAD_BEARING_NOTE_KINDS.has(note.kind))
    .map(note => store.getMemoryItemBySource('notes', note.id))
    .filter((item): item is ParsedMemoryItem => item !== undefined)
    .filter(item => item.state !== 'archived' && item.state !== 'cold')
    .filter(item => !validateMemoryReferences(store, item).stale)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 5);
}

function renderCurrentSessionNotes(items: ParsedMemoryItem[]): string | null {
  if (items.length === 0) {
    return null;
  }

  return `Current session:\n${items.map(renderNoteBullet).join('\n')}`;
}

function renderEvidenceSection(items: ParsedMemoryItem[]): string | null {
  const evidence = items
    .filter(item =>
      item.kind === 'episode:command_failure' ||
      item.kind === 'episode:test_cycle' ||
      item.kind === 'episode:session_summary' ||
      item.kind === 'session_state' ||
      item.kind === 'command_run',
    )
    .slice(0, 4);

  if (evidence.length === 0) {
    return null;
  }

  const lines = evidence.map(item => `- ${renderMemoryLine(item, 2)}`);
  return `Recent evidence:\n${lines.join('\n')}`;
}

export function buildHeader(store: CortexStore): string {
  const preferredScope = getPreferredScope(store);
  const count = preferredScope?.scopeKey
    ? store.getSessionCountByScope(preferredScope.scopeKey)
    : store.getSessionCount();

  if (count === 0) {
    return withUsagePolicy(
      ['Cortex: ambient memory active | no prior sessions yet'],
      'fresh',
    );
  }

  const { saved } = store.getTotalTokens();
  const savingsStr = saved > 0 ? ` | ~${formatTokens(saved)} tokens saved` : '';

  const recentSessions = resolveRecentSessions(store, preferredScope?.scopeKey ?? null, 10);
  const workingSet = resolveWorkingSet(store, 8);
  const headerHighlights = renderHeaderHighlights(workingSet);
  const resumeLine = renderResumeCandidate(workingSet);
  let focus = 'unfocused';
  for (const session of recentSessions) {
    if (session.focus !== null) {
      focus = session.focus;
      break;
    }
  }

  const scopeSuffix =
    preferredScope && preferredScope.scopeType !== 'project'
      ? ` on ${preferredScope.scopeLabel}`
      : '';
  const countSessions = `${count} session${count !== 1 ? 's' : ''}${scopeSuffix}`;

  if (preferredScope?.scopeKey) {
    const snapshot = store.getBranchSnapshot(preferredScope.scopeKey);
    if (snapshot) {
      const lines = [
        `Cortex: ${focus} | ${countSessions}${savingsStr}`,
        renderHeaderSnapshot(snapshot),
      ];
      if (headerHighlights) {
        lines.push(headerHighlights);
      }
      if (resumeLine) {
        lines.push(resumeLine);
      }
      return withUsagePolicy(lines, 'resume');
    }
  }

  const projectState = store.getProjectState();
  if (projectState && (!preferredScope || preferredScope.scopeType === 'project')) {
    const lines = [
      `Cortex: ${focus} | ${countSessions}${savingsStr}`,
      projectState.content,
    ];
    if (headerHighlights) {
      lines.push(headerHighlights);
    }
    if (resumeLine) {
      lines.push(resumeLine);
    }
    return withUsagePolicy(lines, 'resume');
  }

  const endedSessions = recentSessions.filter(session => session.status === 'ended');
  for (const session of endedSessions) {
    const sessionState = store.getSessionState(session.id);
    if (sessionState) {
      const lines = [
        `Cortex: ${focus} | ${countSessions}${savingsStr}`,
        sessionState.content,
      ];
      if (headerHighlights) {
        lines.push(headerHighlights);
      }
      if (resumeLine) {
        lines.push(resumeLine);
      }
      return withUsagePolicy(lines, 'resume');
    }
  }

  const unconsolidated = resolveUnconsolidatedSessions(store, preferredScope?.scopeKey ?? null);
  if (unconsolidated.length > 0) {
    return buildProvisionalHeader(store, focus, countSessions, savingsStr, unconsolidated);
  }

  const fallback: string[] = [`Cortex: ${focus} | ${countSessions}${savingsStr}`];
  if (headerHighlights) {
    fallback.push(headerHighlights);
  }
  if (resumeLine) {
    fallback.push(resumeLine);
  }
  if (fallback.length === 1) {
    fallback.push(
      'No memory on this scope yet.',
    );
  }
  return withUsagePolicy(fallback, resumeLine || headerHighlights ? 'resume' : 'selective');
}

interface FileActivity {
  reads: number;
  edits: number;
}

function buildProvisionalHeader(
  store: CortexStore,
  focus: string,
  countSessions: string,
  savingsStr: string,
  unconsolidated: ReturnType<CortexStore['getUnconsolidatedSessions']>,
): string {
  const fileActivity = new Map<string, FileActivity>();
  let cmdCount = 0;
  let activeNoteCount = 0;

  for (const session of unconsolidated) {
    const events = store.getEventsBySession(session.id);
    for (const event of events) {
      if (event.type === 'cmd') {
        cmdCount++;
      } else if (
        (event.type === 'read' || event.type === 'edit' || event.type === 'write') &&
        event.target
      ) {
        const entry = fileActivity.get(event.target) ?? { reads: 0, edits: 0 };
        if (event.type === 'read') {
          entry.reads++;
        } else {
          entry.edits++;
        }
        fileActivity.set(event.target, entry);
      }
    }

    activeNoteCount += store.getActiveNotes(session.id).length;
  }

  const sortedFiles = Array.from(fileActivity.entries())
    .sort(([, left], [, right]) => (right.reads + right.edits) - (left.reads + left.edits))
    .slice(0, 5);

  const touchedParts = sortedFiles.map(([file, activity]) => {
    const parts: string[] = [];
    if (activity.reads > 0) {
      parts.push(`${activity.reads} read${activity.reads !== 1 ? 's' : ''}`);
    }
    if (activity.edits > 0) {
      parts.push(`${activity.edits} edit${activity.edits !== 1 ? 's' : ''}`);
    }
    return `${file} (${parts.join(', ')})`;
  });

  const lines: string[] = [`Cortex [provisional]: ${focus} | ${countSessions}${savingsStr}`];

  if (touchedParts.length > 0) {
    lines.push(`Touched: ${touchedParts.join(', ')}`);
  }

  lines.push(`Commands: ${cmdCount}`);
  lines.push(`Active notes: ${activeNoteCount}`);
  return withUsagePolicy(lines, 'resume');
}

export function buildFullState(store: CortexStore): string {
  const sections: string[] = [];
  const preferredScope = getPreferredScope(store);
  const workingSet = resolveWorkingSet(store, 12);
  const currentSessionNotes = resolveCurrentSessionNotes(
    store,
    preferredScope?.session.id,
  );
  const currentSessionNoteKeys = new Set(currentSessionNotes.map(noteDedupeKey));
  const workingNotes = workingSet.filter(item =>
    item.kind.startsWith('note:') && !currentSessionNoteKeys.has(noteDedupeKey(item)),
  );

  const currentSessionSection = renderCurrentSessionNotes(currentSessionNotes);
  if (currentSessionSection) {
    sections.push(currentSessionSection);
  }

  if (preferredScope?.scopeKey) {
    const snapshot = store.getBranchSnapshot(preferredScope.scopeKey);
    if (snapshot) {
      sections.push(`Branch snapshot:\n${renderSnapshotSection(snapshot)}`);
    }
  }

  for (const section of renderWorkingNotes(workingNotes)) {
    sections.push(section);
  }

  const evidenceSection = renderEvidenceSection(workingSet);
  if (evidenceSection) {
    sections.push(evidenceSection);
  }

  const recentSessions = resolveRecentSessions(store, preferredScope?.scopeKey ?? null, 3);
  for (const session of recentSessions) {
    const compressed = consolidateLevel1(store, session.id);
    const renderedEvents = compressed.filter(event => event.type !== 'cmd');
    if (renderedEvents.length === 0) {
      continue;
    }

    const rendered = renderCompressed(renderedEvents);
    const focusLabel = session.focus ? ` (focus: ${session.focus})` : '';
    sections.push(`Session${focusLabel}:\n${rendered}`);
  }

  const projectState = store.getProjectState();
  if (projectState && (!preferredScope || preferredScope.scopeType === 'project')) {
    sections.push(`Project state:\n${projectState.content}`);
  }

  if (sections.length === 0) {
    return EMPTY_FULL_STATE_FALLBACK;
  }

  return sections.join('\n\n');
}
