import type { CortexStore, ParsedEvent, SessionRow, InsertNoteOpts } from '../db/store.js';
import { estimateTokens } from '../query/retrieval.js';

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
  const stateId = store.insertState({ sessionId, layer: 'session', content: summary });
  store.insertEpisode({
    id: stateId,
    sessionId,
    kind: 'session_summary',
    summary,
    sourceStateId: stateId,
  });
  store.deleteEventsBySession(sessionId);
  // **No consolidation credit is booked, and its removal is the point of FR-8.**
  //
  // This wrote `estimateTokens(JSON.stringify(events)) - estimateTokens(summary)`
  // as `direction: 'saved'` — the difference between this summary and pasting
  // every captured event into the context as raw JSON. No agent would ever have
  // done that, so the baseline is a counterfactual and the credit is against an
  // action that was never going to be taken. AC #3: "an avoided action whose
  // cost cannot be identified from recorded evidence … no `saved` row is
  // written. There is no modeled or counterfactual credit."
  //
  // **The deeper reason, which matters more than the bad measurement:** the
  // quantity was never a token saving at all. `events` is internal capture. It
  // is never injected into a context window — the surfaces that inject
  // (`cortex_state`, `cortex_recall`, the brief, the reflex) render *memory
  // items*, not raw events. So consolidation compresses the DATABASE, and this
  // is a *token* ledger. Measuring the pruned bytes more carefully would have
  // produced a precise number for the wrong quantity; there is no better
  // estimator to reach for, because the thing being estimated does not belong
  // in this account. `cortex stats` reports database and WAL footprint
  // separately, which is where compression of storage legitimately shows up.
  //
  // Measured before removal on this repo's live store, that one line was the
  // whole of `Saved: 657.6k` and `Efficiency: 93%`. Consolidation does real
  // work; what it does not do is save context tokens, and a number that cannot
  // be checked is exactly what this story exists
  // to stop quoting. Existing rows are migrated to `estimated` rather than
  // deleted, so the history survives without counting.
}

/**
 * `promoteSubagentNotes` lived here and was DELETED in Story 5.3 (FR-19).
 *
 * It copied a child session's notes into the parent, and it MUTATED: on a
 * same-kind, same-subject collision it re-activated an arbitrary prior parent
 * note — the first `Array.prototype.find` hit over `getNotesBySession`, which
 * returns every status, including one superseded long before the child ran.
 * That was deterministic while only one note per (kind, subject) could be
 * active; the AD-17 veto ended that guarantee, so a promotion could leave three
 * active decisions on one subject. `deferred-work.md` carried the defect
 * through three epics.
 *
 * It is gone rather than fixed because AC #2 mandates the opposite shape:
 * a subagent's findings reach durable memory through the non-mutating
 * suggestion path, projecting only once the parent accepts them (AD-4, FR-19).
 * Story 5.3 is the only story that would ever have given this function a
 * caller, and giving it one would have contradicted the AC it sits next to.
 * It had zero runtime callers at deletion — `find_referencing_symbols` returned
 * only the `src/index.ts` barrel, and text search added only
 * `tests/consolidate.test.ts` (`lspOnly: 0`, every text-only hit a doc or that
 * test), so nothing on the live hook path changes.
 *
 * **The one thing to carry forward.** Story 1.1 recorded auto-supersede's
 * scope-blindness as load-bearing for two things: `cortex_resolve`, and this
 * function's reliance on `insertNote` superseding the parent note it then
 * re-activated. Only the second reason dies here. Scope-blind auto-supersede
 * remains load-bearing, and now for a third reason this story documents: it is
 * exactly why a subagent's `cortex_note` can retire a decision from another
 * session at all, which is what the Story 5.3 memory guard exists to refuse.
 */

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
