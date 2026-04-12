import * as path from 'node:path';
import type { CortexStore, ParsedEvent, ParsedNote } from '../db/store.js';
import { consolidateLevel1 } from '../capture/consolidate.js';

// ── Helpers ──────────────────────────────────────────────────────────

interface FileActivity {
  created: boolean;
  edits: number;
  reads: number;
}

function groupFileActivity(events: ParsedEvent[]): Map<string, FileActivity> {
  const files = new Map<string, FileActivity>();
  for (const ev of events) {
    if (!ev.target) continue;
    if (ev.type !== 'read' && ev.type !== 'edit' && ev.type !== 'write') continue;

    const entry = files.get(ev.target) ?? { created: false, edits: 0, reads: 0 };
    if (ev.type === 'write') {
      entry.created = true;
    } else if (ev.type === 'edit') {
      entry.edits++;
    } else {
      entry.reads++;
    }
    files.set(ev.target, entry);
  }
  return files;
}

function extractDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const fp of filePaths) {
    const dir = path.dirname(fp);
    if (dir && dir !== '.') dirs.add(dir);
  }
  return Array.from(dirs).sort();
}

interface CommandStats {
  total: number;
  failures: number;
  byCategory: Map<string, { total: number; failures: number }>;
}

function groupCommands(events: ParsedEvent[]): CommandStats {
  const stats: CommandStats = { total: 0, failures: 0, byCategory: new Map() };
  for (const ev of events) {
    if (ev.type !== 'cmd') continue;
    stats.total++;

    const exitCode = typeof ev.metadata['exit_code'] === 'number' ? ev.metadata['exit_code'] as number : 0;
    if (exitCode !== 0) stats.failures++;

    const category = typeof ev.metadata['category'] === 'string' ? ev.metadata['category'] as string : 'other';
    const cat = stats.byCategory.get(category) ?? { total: 0, failures: 0 };
    cat.total++;
    if (exitCode !== 0) cat.failures++;
    stats.byCategory.set(category, cat);
  }
  return stats;
}

function getSubagents(events: ParsedEvent[]): string[] {
  const descs: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'agent') continue;
    const desc = typeof ev.metadata['description'] === 'string' ? ev.metadata['description'] as string : '';
    if (desc) descs.push(desc);
  }
  return descs;
}

function countTestCycles(store: CortexStore, sessionId: string): number {
  const compressed = consolidateLevel1(store, sessionId);
  return compressed.filter(ev => ev.type === 'test_cycle').length;
}

// ── Public API ───────────────────────────────────────────────────────

export function buildSessionSummary(store: CortexStore, userDescription?: string): string {
  const session = store.getCurrentSession();
  if (!session) return 'No active session.';

  const sessionId = session.id;
  const events = store.getEventsBySession(sessionId);
  const notes = store.getNotesBySession(sessionId);

  if (events.length === 0 && notes.length === 0) {
    return userDescription
      ? `## Session Summary\n${userDescription}\n\nNo tracked activity.`
      : 'No tracked activity this session.';
  }

  const lines: string[] = [];

  // Header
  lines.push('## Session Summary');
  if (userDescription) {
    lines.push(userDescription);
  }

  // Files
  const fileActivity = groupFileActivity(events);
  const createdFiles: string[] = [];
  const editedFiles: [string, number][] = [];

  for (const [file, act] of fileActivity) {
    if (act.created) {
      createdFiles.push(file);
    } else if (act.edits > 0) {
      editedFiles.push([file, act.edits]);
    }
  }

  if (createdFiles.length > 0 || editedFiles.length > 0) {
    lines.push('');
    lines.push('### Files Modified');
    for (const file of createdFiles) {
      lines.push(`- ${file} (created)`);
    }
    for (const [file, count] of editedFiles) {
      lines.push(`- ${file} (${count} edit${count !== 1 ? 's' : ''})`);
    }
  }

  // Directories
  const allModifiedFiles = [
    ...createdFiles,
    ...editedFiles.map(([f]) => f),
  ];
  if (allModifiedFiles.length > 0) {
    const dirs = extractDirectories(allModifiedFiles);
    if (dirs.length > 0) {
      lines.push('');
      lines.push('### Directories');
      for (const dir of dirs) {
        lines.push(`- ${dir}`);
      }
    }
  }

  // Commands
  const cmdStats = groupCommands(events);
  if (cmdStats.total > 0) {
    lines.push('');
    lines.push('### Commands');
    for (const [category, cat] of cmdStats.byCategory) {
      const failStr = cat.failures > 0 ? ` (${cat.failures} failed)` : '';
      lines.push(`- ${cat.total} ${category}${failStr}`);
    }
  }

  // Test cycles
  const testCycles = countTestCycles(store, sessionId);
  if (testCycles > 0) {
    lines.push(`- ${testCycles} test-fix cycle${testCycles !== 1 ? 's' : ''}`);
  }

  // Subagents
  const subagents = getSubagents(events);
  if (subagents.length > 0) {
    lines.push('');
    lines.push('### Subagents');
    for (const desc of subagents) {
      lines.push(`- ${desc}`);
    }
  }

  // Notes
  const activeNotes = notes.filter(n => n.status === 'active');
  if (activeNotes.length > 0) {
    lines.push('');
    lines.push('### Decisions & Insights');
    for (const note of activeNotes) {
      const subject = note.subject ? `[${note.subject}] ` : '';
      lines.push(`- ${note.kind}: ${subject}${note.content}`);
    }
  }

  return lines.join('\n');
}
