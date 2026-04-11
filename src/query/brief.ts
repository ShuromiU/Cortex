import type { CortexStore } from '../db/store.js';

// ── Kind priority ─────────────────────────────────────────────────────

const KIND_PRIORITY: Record<string, number> = {
  decision: 0,
  intent: 1,
  blocker: 2,
  insight: 3,
};

function kindPriority(kind: string): number {
  return KIND_PRIORITY[kind] ?? 99;
}

function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// ── brief ─────────────────────────────────────────────────────────────

export function brief(store: CortexStore, topic: string, forAgent?: string): string {
  const lowerTopic = topic.toLowerCase();

  const lines: string[] = [];

  if (forAgent) {
    lines.push(`Briefing for ${forAgent}:`);
  }

  // Current session focus
  const currentSession = store.getCurrentSession();
  if (currentSession?.focus) {
    lines.push(`Focus: ${currentSession.focus}`);
  }

  // Filter active notes matching topic in subject or content
  const activeNotes = store.getActiveNotes();
  const relevant = activeNotes.filter(note => {
    const inSubject = (note.subject ?? '').toLowerCase().includes(lowerTopic);
    const inContent = note.content.toLowerCase().includes(lowerTopic);
    return inSubject || inContent;
  });

  // Sort by kind priority
  relevant.sort((a, b) => kindPriority(a.kind) - kindPriority(b.kind));

  // Max 5
  const topNotes = relevant.slice(0, 5);

  for (const note of topNotes) {
    const label = kindLabel(note.kind);
    const subject = note.subject ? `[${note.subject}] ` : '';
    lines.push(`${label}: ${subject}${note.content}`);
  }

  if (topNotes.length === 0) {
    lines.push(`No context found for "${topic}".`);
  }

  return lines.join('\n');
}
