import type { CortexStore, ParsedNote } from '../db/store.js';
import { consolidateLevel1, renderCompressed } from '../capture/consolidate.js';

// ── Helpers ───────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // Show one decimal if not a whole number
    const formatted = k % 1 === 0 ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `${formatted}k`;
  }
  return String(n);
}

// ── buildHeader ───────────────────────────────────────────────────────

export function buildHeader(store: CortexStore): string {
  const count = store.getSessionCount();

  if (count === 0) {
    return 'Cortex: no prior sessions';
  }

  // Token savings
  const { saved } = store.getTotalTokens();
  const savingsStr = saved > 0 ? ` | ~${formatTokens(saved)} tokens saved` : '';

  // Focus: first recent session with a non-null focus
  const recentSessions = store.getRecentSessions(10);
  let focus = 'unfocused';
  for (const s of recentSessions) {
    if (s.focus !== null) {
      focus = s.focus;
      break;
    }
  }

  const countSessions = `${count} session${count !== 1 ? 's' : ''}`;

  // Project-level state
  const projectState = store.getProjectState();
  if (projectState) {
    return `Cortex: ${focus} | ${countSessions}${savingsStr}\n${projectState.content}`;
  }

  // Most recent ended session with a session-level state
  const endedSessions = recentSessions.filter(s => s.status === 'ended');
  for (const session of endedSessions) {
    const sessionState = store.getSessionState(session.id);
    if (sessionState) {
      return `Cortex: ${focus} | ${countSessions}${savingsStr}\n${sessionState.content}`;
    }
  }

  // Unconsolidated sessions — provisional header
  const unconsolidated = store.getUnconsolidatedSessions();
  if (unconsolidated.length > 0) {
    return buildProvisionalHeader(store, focus, countSessions, savingsStr, unconsolidated);
  }

  // Fallback
  return `Cortex: ${focus} | ${countSessions}${savingsStr}`;
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
    // Gather events
    const events = store.getEventsBySession(session.id);
    for (const ev of events) {
      if (ev.type === 'cmd') {
        cmdCount++;
      } else if ((ev.type === 'read' || ev.type === 'edit' || ev.type === 'write') && ev.target) {
        const entry = fileActivity.get(ev.target) ?? { reads: 0, edits: 0 };
        if (ev.type === 'read') {
          entry.reads++;
        } else {
          entry.edits++;
        }
        fileActivity.set(ev.target, entry);
      }
    }

    // Count active notes
    const notes = store.getActiveNotes(session.id);
    activeNoteCount += notes.length;
  }

  // Sort files by total activity, top 5
  const sortedFiles = Array.from(fileActivity.entries())
    .sort(([, a], [, b]) => (b.reads + b.edits) - (a.reads + a.edits))
    .slice(0, 5);

  const touchedParts = sortedFiles.map(([file, act]) => {
    const parts: string[] = [];
    if (act.reads > 0) parts.push(`${act.reads} read${act.reads !== 1 ? 's' : ''}`);
    if (act.edits > 0) parts.push(`${act.edits} edit${act.edits !== 1 ? 's' : ''}`);
    return `${file} (${parts.join(', ')})`;
  });

  const lines: string[] = [
    `Cortex [provisional]: ${focus} | ${countSessions}${savingsStr}`,
  ];

  if (touchedParts.length > 0) {
    lines.push(`Touched: ${touchedParts.join(', ')}`);
  }

  lines.push(`Commands: ${cmdCount}`);
  lines.push(`Active notes: ${activeNoteCount}`);
  lines.push(`→ Call cortex_state for full briefing`);

  return lines.join('\n');
}

// ── buildFullState ────────────────────────────────────────────────────

export function buildFullState(store: CortexStore): string {
  const sections: string[] = [];

  // 1. Active notes grouped by kind
  const activeNotes = store.getActiveNotes();
  const kindOrder: Array<ParsedNote['kind']> = ['intent', 'decision', 'blocker', 'insight'];
  const grouped = new Map<string, ParsedNote[]>();

  for (const note of activeNotes) {
    const list = grouped.get(note.kind) ?? [];
    list.push(note);
    grouped.set(note.kind, list);
  }

  for (const kind of kindOrder) {
    const notes = grouped.get(kind);
    if (!notes || notes.length === 0) continue;

    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    const lines = notes.map(n => {
      const subject = n.subject ? `[${n.subject}] ` : '';
      const conflict = n.conflict ? ' ⚠ conflict' : '';
      return `- ${subject}${n.content}${conflict}`;
    });
    sections.push(`${label}s:\n${lines.join('\n')}`);
  }

  // 2. Recent session activity (up to 3 sessions)
  const recentSessions = store.getRecentSessions(3);
  for (const session of recentSessions) {
    const compressed = consolidateLevel1(store, session.id);
    if (compressed.length > 0) {
      const rendered = renderCompressed(compressed);
      const focusLabel = session.focus ? ` (focus: ${session.focus})` : '';
      sections.push(`Session${focusLabel}:\n${rendered}`);
    }
  }

  // 3. Project state if available
  const projectState = store.getProjectState();
  if (projectState) {
    sections.push(`Project state:\n${projectState.content}`);
  }

  return sections.join('\n\n');
}
