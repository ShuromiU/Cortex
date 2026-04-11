import type { CortexStore, ParsedEvent, SessionRow, InsertNoteOpts } from '../db/store.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface CompressedEvent {
  type: string;
  target?: string;
  count?: number;
  line_ranges?: [number, number][];
  iterations?: number;
  files?: string[];
  description?: string;
  exit_code?: number;
  category?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function getLineRange(event: ParsedEvent): [number, number] | null {
  const start = event.metadata['line_start'];
  const end = event.metadata['line_end'];
  if (typeof start === 'number' && typeof end === 'number') {
    return [start, end];
  }
  return null;
}

function isTestFail(event: ParsedEvent): boolean {
  return (
    event.type === 'cmd' &&
    typeof event.metadata['exit_code'] === 'number' &&
    (event.metadata['exit_code'] as number) !== 0 &&
    event.metadata['category'] === 'test'
  );
}

function isTestPass(event: ParsedEvent): boolean {
  return (
    event.type === 'cmd' &&
    typeof event.metadata['exit_code'] === 'number' &&
    (event.metadata['exit_code'] as number) === 0 &&
    event.metadata['category'] === 'test'
  );
}

// ── Pass 1: Collapse test cycles ──────────────────────────────────────

interface TestCycle {
  type: 'test_cycle';
  iterations: number;
  files: string[];
}

type Pass1Result =
  | { kind: 'test_cycle'; cycle: TestCycle }
  | { kind: 'passthrough'; event: ParsedEvent };

function collapseTestCycles(events: ParsedEvent[]): Pass1Result[] {
  const results: Pass1Result[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;

    if (isTestFail(event)) {
      // Try to find a cycle: fail → (edits) → [fail → (edits) →]* pass
      let j = i + 1;
      let iterations = 0;
      const editedFiles = new Set<string>();
      let cycleFound = false;

      while (j < events.length) {
        const curr = events[j]!;

        if (curr.type === 'edit' || curr.type === 'write') {
          if (curr.target) editedFiles.add(curr.target);
          j++;
        } else if (isTestFail(curr)) {
          // Another test failure — increment iterations counter and keep scanning
          iterations++;
          j++;
        } else if (isTestPass(curr)) {
          // Cycle complete
          iterations++;
          cycleFound = true;
          j++;
          break;
        } else {
          // Non-edit, non-test event — can't form a cycle
          break;
        }
      }

      if (cycleFound) {
        results.push({
          kind: 'test_cycle',
          cycle: {
            type: 'test_cycle',
            iterations,
            files: Array.from(editedFiles),
          },
        });
        i = j;
        continue;
      }
    }

    results.push({ kind: 'passthrough', event });
    i++;
  }

  return results;
}

// ── Pass 2: Dedup/merge file events ──────────────────────────────────

function deduplicateFileEvents(pass1: Pass1Result[]): CompressedEvent[] {
  const output: CompressedEvent[] = [];

  // We process in order; file events (read/edit/write) are grouped by type+target
  // but we want to preserve relative ordering with non-file events.
  // Strategy: flush accumulated file groups when a non-file event is encountered,
  // then emit the non-file event. At the end, flush remaining groups.

  // Map from "type\0target" → { count, line_ranges }
  type FileGroup = { type: string; target: string; count: number; ranges: [number, number][] };
  const groupOrder: string[] = []; // keys in insertion order
  const groups = new Map<string, FileGroup>();

  function flushGroups(): void {
    for (const key of groupOrder) {
      const g = groups.get(key)!;
      const compressed: CompressedEvent = {
        type: g.type,
        target: g.target,
        count: g.count,
      };
      if (g.ranges.length > 0) {
        compressed.line_ranges = g.ranges;
      }
      output.push(compressed);
    }
    groupOrder.length = 0;
    groups.clear();
  }

  for (const item of pass1) {
    if (item.kind === 'test_cycle') {
      flushGroups();
      output.push({
        type: 'test_cycle',
        iterations: item.cycle.iterations,
        files: item.cycle.files,
      });
      continue;
    }

    const event = item.event;

    if (
      (event.type === 'read' || event.type === 'edit' || event.type === 'write') &&
      event.target !== null
    ) {
      const key = `${event.type}\0${event.target}`;
      let group = groups.get(key);
      if (!group) {
        group = { type: event.type, target: event.target, count: 0, ranges: [] };
        groups.set(key, group);
        groupOrder.push(key);
      }
      group.count++;
      const range = getLineRange(event);
      if (range !== null) {
        group.ranges.push(range);
      }
    } else if (event.type === 'cmd') {
      flushGroups();
      const compressed: CompressedEvent = { type: 'cmd' };
      if (typeof event.metadata['exit_code'] === 'number') {
        compressed.exit_code = event.metadata['exit_code'] as number;
      }
      if (typeof event.metadata['category'] === 'string') {
        compressed.category = event.metadata['category'] as string;
      }
      output.push(compressed);
    } else if (event.type === 'agent') {
      flushGroups();
      const compressed: CompressedEvent = { type: 'agent' };
      if (typeof event.metadata['description'] === 'string') {
        compressed.description = event.metadata['description'] as string;
      }
      output.push(compressed);
    } else {
      // Unknown event type — pass through
      flushGroups();
      output.push({ type: event.type, ...(event.target ? { target: event.target } : {}) });
    }
  }

  flushGroups();
  return output;
}

// ── Public API ────────────────────────────────────────────────────────

export function consolidateLevel1(
  store: CortexStore,
  sessionId: string,
): CompressedEvent[] {
  const events = store.getEventsBySession(sessionId);
  if (events.length === 0) return [];

  const pass1 = collapseTestCycles(events);
  return deduplicateFileEvents(pass1);
}

// ── Level 2: Session consolidation & subagent promotion ──────────────

/**
 * Returns sessions that have ended but have no session-layer state yet.
 */
export function getPendingConsolidation(store: CortexStore): SessionRow[] {
  return store.getUnconsolidatedSessions();
}

/**
 * Write a session summary to the state table (layer='session'),
 * then prune raw events for that session.
 */
export function writeSessionSummary(
  store: CortexStore,
  sessionId: string,
  summary: string,
): void {
  store.insertState({ sessionId, layer: 'session', content: summary });
  store.deleteEventsBySession(sessionId);
}

/**
 * Promote notes from child sessions into the parent session.
 * - Exact duplicates (same kind + subject + content) are skipped.
 * - Conflicts (same kind + subject, different content, non-null subject) → promote AND mark both as conflict.
 * - Otherwise → promote (insert copy into parent session).
 */
export function promoteSubagentNotes(
  store: CortexStore,
  parentSessionId: string,
): void {
  const children = store.getChildSessions(parentSessionId);

  for (const child of children) {
    const childNotes = store.getActiveNotes(child.id);
    // Include superseded notes too — child insertions may have already superseded parent notes
    const parentNotes = store.getNotesBySession(parentSessionId);

    for (const childNote of childNotes) {
      // Check for exact duplicate: same kind + subject + content (in any status)
      const exactDup = parentNotes.find(
        p =>
          p.kind === childNote.kind &&
          p.subject === childNote.subject &&
          p.content === childNote.content,
      );
      if (exactDup) continue;

      // Check for conflict: same kind + subject (non-null), different content
      const conflictNote =
        childNote.subject !== null
          ? parentNotes.find(
              p =>
                p.kind === childNote.kind &&
                p.subject === childNote.subject &&
                p.content !== childNote.content,
            )
          : undefined;

      if (conflictNote) {
        // Promote the child note — insertNote may auto-supersede the conflicting parent note
        const promoted = store.insertNote({
          sessionId: parentSessionId,
          kind: childNote.kind as InsertNoteOpts['kind'],
          content: childNote.content,
          ...(childNote.subject !== null ? { subject: childNote.subject } : {}),
          ...(childNote.alternatives !== null ? { alternatives: childNote.alternatives } : {}),
        });
        // Re-activate the original conflict note if auto-superseded, then mark both as conflict
        store.updateNoteStatus(conflictNote.id, 'active');
        store.markConflict(conflictNote.id);
        store.markConflict(promoted.id);
      } else {
        // Normal promotion
        store.insertNote({
          sessionId: parentSessionId,
          kind: childNote.kind as InsertNoteOpts['kind'],
          content: childNote.content,
          ...(childNote.subject !== null ? { subject: childNote.subject } : {}),
          ...(childNote.alternatives !== null ? { alternatives: childNote.alternatives } : {}),
        });
      }
    }
  }
}

// ── Level 3: Cross-session merge ─────────────────────────────────────

const MERGE_THRESHOLD = 5;
const TRUNCATE_LIMIT = 2000;

/**
 * Merge older session states into a project-level state when session count exceeds MERGE_THRESHOLD.
 * Returns true if a merge was performed, false otherwise.
 */
export function mergeProjectState(store: CortexStore): boolean {
  const recentStates = store.getRecentStates(100);

  if (recentStates.length <= MERGE_THRESHOLD) {
    return false;
  }

  // Keep the most recent 5 as-is; merge older ones
  const toKeep = recentStates.slice(0, MERGE_THRESHOLD);
  const toMerge = recentStates.slice(MERGE_THRESHOLD);

  // Build merged content
  const parts: string[] = [];

  // Existing project state (if any)
  const existingProject = store.getProjectState();
  if (existingProject) {
    parts.push(existingProject.content);
  }

  // Older session summaries
  for (const state of toMerge) {
    parts.push(state.content);
  }

  // Active notes summary (top 20)
  const activeNotes = store.getActiveNotes();
  const topNotes = activeNotes.slice(0, 20);
  if (topNotes.length > 0) {
    const notesText = topNotes
      .map(n => {
        const subject = n.subject ? `[${n.subject}] ` : '';
        return `- ${n.kind}: ${subject}${n.content}`;
      })
      .join('\n');
    parts.push(`Active notes:\n${notesText}`);
  }

  let merged = parts.join('\n\n');

  // Truncate to ~2000 chars if needed
  if (merged.length > TRUNCATE_LIMIT) {
    merged = merged.slice(0, TRUNCATE_LIMIT) + '\n[truncated]';
  }

  store.replaceProjectState(merged);

  // toKeep is referenced to avoid unused variable lint
  void toKeep;

  return true;
}

export function renderCompressed(events: CompressedEvent[]): string {
  const lines: string[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case 'read': {
        const target = ev.target ?? '(unknown)';
        const count = ev.count ?? 1;
        const countStr = count > 1 ? ` x${count}` : '';
        if (ev.line_ranges && ev.line_ranges.length > 0) {
          const ranges = ev.line_ranges.map(([s, e]) => `${s}-${e}`).join(', ');
          lines.push(`Read ${target}${countStr} (lines: ${ranges})`);
        } else {
          lines.push(`Read ${target}${countStr}`);
        }
        break;
      }
      case 'edit': {
        const target = ev.target ?? '(unknown)';
        const count = ev.count ?? 1;
        const countStr = count > 1 ? ` x${count}` : '';
        if (ev.line_ranges && ev.line_ranges.length > 0) {
          const ranges = ev.line_ranges.map(([s, e]) => `${s}-${e}`).join(', ');
          lines.push(`Edited ${target}${countStr} (lines: ${ranges})`);
        } else {
          lines.push(`Edited ${target}${countStr}`);
        }
        break;
      }
      case 'write': {
        const target = ev.target ?? '(unknown)';
        lines.push(`Created ${target}`);
        break;
      }
      case 'test_cycle': {
        const iters = ev.iterations ?? 1;
        const fileList = ev.files && ev.files.length > 0 ? ` (${ev.files.join(', ')})` : '';
        lines.push(`Test cycle: fixed after ${iters} iteration${iters !== 1 ? 's' : ''}${fileList}`);
        break;
      }
      case 'cmd': {
        const cat = ev.category ?? 'cmd';
        const exit = ev.exit_code !== undefined ? ev.exit_code : '?';
        lines.push(`Command (${cat}): exit ${exit}`);
        break;
      }
      case 'agent': {
        const desc = ev.description ?? '';
        lines.push(`Subagent: ${desc}`);
        break;
      }
      default: {
        lines.push(`${ev.type}${ev.target ? ` ${ev.target}` : ''}`);
        break;
      }
    }
  }

  return lines.join('\n');
}
