import type { CortexStore, MemoryItemFilter, ParsedMemoryItem, ParsedNote } from '../db/store.js';
import { isSupersededMemoryItem } from '../memory/items.js';
import { describeValidity, isContested } from './render.js';
import {
  validateMemoryReferences,
  type MemoryReferenceValidation,
} from './reference-validation.js';

// ── Paging (FR-21: "never dumps the whole store") ─────────────────────

export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Hard ceiling on one page, applied by `listMemory` to every caller that goes
 * through it — which is every path that renders a page. This is the clause
 * that makes "never dumps the whole store" a property of the code rather than
 * a habit of its callers: a cap that lives inline in a CLI action is a cap
 * nobody can test across its boundary.
 *
 * It is not a ceiling on the *store* method. `listMemoryItemsFiltered`
 * deliberately treats an absent limit as unlimited (SQLite `LIMIT -1`) because
 * internal callers need that; the guarantee belongs to this layer, not below it.
 */
export const MAX_PAGE_LIMIT = 200;

/**
 * Stated ordering criterion, printed with every page (AC #1). It names the
 * tiebreaker as well as the sort key, because the tiebreaker is what makes the
 * order *total* — a script author paging this output needs to know that.
 */
export const MEMORY_LIST_ORDER = 'newest first (created_at DESC, rowid DESC)';

/** How many retrieval-log entries an inspection reports. */
export const ACCESS_HISTORY_LIMIT = 10;

/**
 * Commander hands options through as raw strings, so `parseInt` failures
 * arrive here as `NaN` rather than as an error. Anything not a usable page
 * size — absent, non-finite, zero, negative — falls back to the default
 * instead of reaching SQLite, where a negative LIMIT means "no limit" and
 * would dump the store the cap exists to bound.
 */
export function resolvePageLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_PAGE_LIMIT;
  }

  const floored = Math.floor(raw);
  if (floored < 1) {
    return DEFAULT_PAGE_LIMIT;
  }

  return Math.min(floored, MAX_PAGE_LIMIT);
}

/**
 * Offsets are clamped to a safe integer, not merely floored at zero.
 * better-sqlite3 refuses to bind a float beyond `Number.MAX_SAFE_INTEGER`, so
 * an offset like `9223372036854775807` — a plausible typo — otherwise reaches
 * the driver and surfaces as a raw `datatype mismatch` stack trace instead of
 * an empty page.
 */
export function resolvePageOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 0;
  }

  return Math.min(Math.max(0, Math.floor(raw)), Number.MAX_SAFE_INTEGER);
}

// ── Listing ───────────────────────────────────────────────────────────

export interface MemoryListOptions extends MemoryItemFilter {
  limit?: number;
  offset?: number;
}

export interface MemoryListPage {
  items: ParsedMemoryItem[];
  /** Items matching the filter, independent of this page's size. */
  total: number;
  limit: number;
  offset: number;
  order: string;
  filter: {
    scopeKeys: string[] | null;
    kinds: string[] | null;
    states: string[] | null;
  };
}

/**
 * One page of stored memory items (FR-21).
 *
 * No state filter is applied by default, `archived` included — every other
 * query surface excludes it, but this one exists to answer "what does Cortex
 * actually hold", and a listing that quietly omits rows cannot.
 */
export function listMemory(store: CortexStore, options: MemoryListOptions = {}): MemoryListPage {
  const limit = resolvePageLimit(options.limit);
  const offset = resolvePageOffset(options.offset);
  const filter: MemoryItemFilter = {
    ...(options.scopeKeys !== undefined ? { scopeKeys: options.scopeKeys } : {}),
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
    ...(options.states !== undefined ? { states: options.states } : {}),
  };

  // One snapshot for both queries. The shared WHERE builder guarantees the
  // same *filter*; only a transaction guarantees the same *store*. Capture
  // runs continuously in this repo, so a spool flush landing between the two
  // would print an `of N` that disagrees with the rows beneath it.
  const { items, total } = store.runInTransaction(() => ({
    items: store.listMemoryItemsFiltered({ ...filter, limit, offset }),
    total: store.countMemoryItemsFiltered(filter),
  }));

  return {
    items,
    total,
    limit,
    offset,
    order: MEMORY_LIST_ORDER,
    filter: {
      scopeKeys: options.scopeKeys ?? null,
      kinds: options.kinds ?? null,
      states: options.states ?? null,
    },
  };
}

// ── Inspection ────────────────────────────────────────────────────────

export interface MemoryReferenceDetail {
  raw_reference: string;
  normalized_path: string;
  status: string;
  moved_to: string | null;
}

export interface MemoryConflictCounterpart {
  id: string;
  kind: string;
  subject: string | null;
  timestamp: string;
}

export interface MemoryConflictStatus {
  /** `notes.conflict`, the authoritative column. Null when not note-backed. */
  conflict: boolean | null;
  /** `notes.status`, the authoritative column. Null when not note-backed. */
  note_status: string | null;
  /** What every *other* surface reads: the projected memory text. */
  projected_contested: boolean;
  projected_superseded: boolean;
  /** True when the column and the projection disagree about this item. */
  diverged: boolean;
  counterparts: MemoryConflictCounterpart[];
  alternatives: string[] | null;
}

export interface MemoryAccessRetrieval {
  topic: string;
  created_at: string;
  session_id: string | null;
}

export interface MemoryAccessHistory {
  /** Durable, and the figure to trust. */
  access_count: number;
  last_accessed_at: string | null;
  /**
   * Recent retrievals. `cortex gc` prunes `retrieval_log` to its newest rows,
   * so this list is bounded and lossy in a way `access_count` is not.
   */
  retrievals: MemoryAccessRetrieval[];
}

export interface MemoryCorrectionEntry {
  operation: string;
  created_at: string;
  prior_text: string;
  new_text: string | null;
}

export interface MemoryInspection {
  item: ParsedMemoryItem;
  /** Verbatim and untruncated — every other surface snippets, this one must not. */
  text: string;
  /** The same one-word trust summary retrieval prints (`describeValidity`). */
  trust: string;
  references: MemoryReferenceDetail[];
  conflict: MemoryConflictStatus;
  access: MemoryAccessHistory;
  /**
   * Prior versions recorded by `edit-memory` / `delete-memory` (FR-22).
   * Without this the audit trail is written and reachable only by hand-querying
   * SQLite — and `edit-memory` tells the user this command shows it.
   */
  corrections: MemoryCorrectionEntry[];
}

function sourceNote(store: CortexStore, item: ParsedMemoryItem): ParsedNote | undefined {
  if (item.source_table !== 'notes' || !item.source_id) {
    return undefined;
  }

  return store.getNote(item.source_id);
}

/**
 * The other side(s) of an open contest.
 *
 * Contradiction detection is scope-keyed, so the counterpart search must be
 * too: the same subject on another branch is a different conversation, not
 * the other half of this one. `getActiveNotesBySubject` applies no scope
 * filter, so it is applied here.
 */
function findCounterparts(
  store: CortexStore,
  item: ParsedMemoryItem,
  note: ParsedNote,
): MemoryConflictCounterpart[] {
  if (!note.subject || !note.conflict) {
    return [];
  }

  return store
    .getActiveNotesBySubject(note.subject)
    .filter(other => other.id !== note.id && other.conflict)
    .filter(other => store.getScopeKeyForNote(other.id) === item.scope_key)
    .map(other => ({
      id: other.id,
      kind: other.kind,
      subject: other.subject,
      timestamp: other.timestamp,
    }));
}

function conflictStatus(
  store: CortexStore,
  item: ParsedMemoryItem,
  note: ParsedNote | undefined,
): MemoryConflictStatus {
  const projectedContested = isContested(item);
  const projectedSuperseded = isSupersededMemoryItem(item);

  if (!note) {
    // Two different situations reach here and only one is unremarkable. An
    // item that was never note-backed has nothing to diverge from. An item
    // whose note row is *gone* has lost the column while its projection still
    // drives the demote cap, the stale penalty and the brief exclusion — the
    // one drift this surface exists to catch, and the one it cannot repair.
    const orphaned = item.source_table === 'notes';
    return {
      conflict: null,
      note_status: null,
      projected_contested: projectedContested,
      projected_superseded: projectedSuperseded,
      diverged: orphaned,
      counterparts: [],
      alternatives: null,
    };
  }

  return {
    conflict: note.conflict,
    note_status: note.status,
    projected_contested: projectedContested,
    projected_superseded: projectedSuperseded,
    // Inspect is the only surface that can compare the two. Reporting the
    // disagreement — rather than silently preferring either — is the point:
    // every other surface reads the projection, and a projection that has
    // drifted from its column is invisible everywhere else.
    diverged:
      note.conflict !== projectedContested ||
      (note.status === 'superseded') !== projectedSuperseded,
    counterparts: findCounterparts(store, item, note),
    alternatives: note.alternatives,
  };
}

/**
 * Everything stored about one memory item (FR-21), by memory-item id or by
 * the id of the note behind it. Returns null when neither resolves.
 *
 * Reads only: no `touchMemoryItems`, because a tool for revealing what
 * ranking holds must not change that ranking by being used. Reference
 * validation does persist corrected `memory_references` statuses, exactly as
 * it does on the retrieval path — that is repair of derived data, not
 * reinforcement.
 */
export function inspectMemory(store: CortexStore, id: string): MemoryInspection | null {
  const item = store.getMemoryItem(id) ?? store.getMemoryItemBySource('notes', id);
  if (!item) {
    return null;
  }

  const validation = validateMemoryReferences(store, item);
  const note = sourceNote(store, item);
  // `describeValidity` reads the validation off the item, the same way the
  // retrieval path feeds it. Attaching it here reuses retrieval's trust
  // vocabulary verbatim rather than growing a second one.
  const validated: ParsedMemoryItem & { reference_validation: MemoryReferenceValidation } = {
    ...item,
    reference_validation: validation,
  };

  return {
    item,
    text: item.text,
    trust: describeValidity(validated),
    references: validation.references.map(reference => ({
      raw_reference: reference.raw_reference,
      normalized_path: reference.normalized_path,
      status: reference.status,
      moved_to: reference.moved_to,
    })),
    conflict: conflictStatus(store, item, note),
    access: {
      access_count: item.access_count,
      last_accessed_at: item.last_accessed_at,
      retrievals: store.getRetrievalLogsForItem(item.id, ACCESS_HISTORY_LIMIT).map(log => ({
        topic: log.topic,
        created_at: log.created_at,
        session_id: log.session_id,
      })),
    },
    corrections: store.getMemoryCorrections(item.id).map(correction => ({
      operation: correction.operation,
      created_at: correction.created_at,
      prior_text: correction.prior_text,
      new_text: correction.new_text,
    })),
  };
}
