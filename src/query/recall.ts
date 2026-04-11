import type { CortexStore, ParsedNote } from '../db/store.js';

// ── Scoring ───────────────────────────────────────────────────────────

interface ScoredNote {
  note: ParsedNote;
  score: number;
}

function scoreNote(note: ParsedNote, topic: string, lowerTopic: string): number {
  let score = 0;
  const lowerSubject = (note.subject ?? '').toLowerCase();
  const lowerContent = note.content.toLowerCase();

  if (lowerSubject.includes(lowerTopic)) score += 5;
  if (lowerContent.includes(lowerTopic)) score += 3;
  if (note.kind === 'decision' || note.kind === 'intent' || note.kind === 'blocker') score += 1;

  return score;
}

function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// ── recall ────────────────────────────────────────────────────────────

export function recall(store: CortexStore, topic: string): string {
  const lowerTopic = topic.toLowerCase();

  // Current session for focus bias
  const currentSession = store.getCurrentSession();
  const currentFocus = currentSession?.focus?.toLowerCase() ?? null;

  const scored: ScoredNote[] = [];

  // Active notes — full weight
  const activeNotes = store.getActiveNotes();
  for (const note of activeNotes) {
    const base = scoreNote(note, topic, lowerTopic);
    if (base === 0) continue;

    let adjusted = base;
    // Focus bias: if current session has focus and note subject matches
    if (currentFocus && note.subject && note.subject.toLowerCase().includes(currentFocus)) {
      adjusted += 2;
    }
    scored.push({ note, score: adjusted });
  }

  // Resolved notes — 0.5x multiplier
  const resolvedNotes = store.getNotesByStatus('resolved');
  for (const note of resolvedNotes) {
    const base = scoreNote(note, topic, lowerTopic);
    if (base === 0) continue;

    let adjusted = base * 0.5;
    if (currentFocus && note.subject && note.subject.toLowerCase().includes(currentFocus)) {
      adjusted += 2;
    }
    scored.push({ note, score: adjusted });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Top 10
  const top = scored.slice(0, 10);

  const lines: string[] = top.map(({ note }) => {
    const label = kindLabel(note.kind);
    const subject = note.subject ? `[${note.subject}] ` : '';
    const statusSuffix = note.status !== 'active' ? ` (${note.status})` : '';
    return `${label}: ${subject}${note.content}${statusSuffix}`;
  });

  // Search consolidated states for topic
  const stateMatches: string[] = [];

  const recentStates = store.getRecentStates(5);
  for (const state of recentStates) {
    if (state.content.toLowerCase().includes(lowerTopic)) {
      stateMatches.push(`[session state] ${state.content}`);
    }
  }

  const projectState = store.getProjectState();
  if (projectState && projectState.content.toLowerCase().includes(lowerTopic)) {
    stateMatches.push(`[project state] ${projectState.content}`);
  }

  const allLines = [...lines, ...stateMatches];

  if (allLines.length === 0) {
    return `No matches for "${topic}".`;
  }

  return allLines.join('\n');
}
