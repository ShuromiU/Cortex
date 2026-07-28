import { DELETABLE_SOURCE_TABLES } from '../db/store.js';
import type { CortexStore, ParsedMemoryItem, ParsedNote } from '../db/store.js';
import type { MemoryReferenceDetail } from './inspect.js';

// ── Shared resolution ─────────────────────────────────────────────────

/**
 * Resolve by memory-item id, falling back to the id of the note behind it —
 * the same two-step `inspectMemory` uses, so an id copied out of `list-memory`
 * or out of an inspection's conflict section works in all three commands.
 */
function resolveItem(store: CortexStore, id: string): ParsedMemoryItem | undefined {
  return store.getMemoryItem(id) ?? store.getMemoryItemBySource('notes', id);
}

function referenceDetails(store: CortexStore, itemId: string): MemoryReferenceDetail[] {
  return store.getMemoryReferences(itemId).map(reference => ({
    raw_reference: reference.raw_reference,
    normalized_path: reference.normalized_path,
    status: reference.status,
    moved_to: reference.moved_to,
  }));
}

function sourceNote(store: CortexStore, item: ParsedMemoryItem): ParsedNote | undefined {
  if (item.source_table !== 'notes' || !item.source_id) {
    return undefined;
  }

  return store.getNote(item.source_id);
}

// ── Editing (FR-22) ───────────────────────────────────────────────────

export interface EditMemoryResult {
  item: ParsedMemoryItem;
  prior_text: string;
  references: MemoryReferenceDetail[];
  correction_id: string;
}

/**
 * Replace an item's text, re-extract its references and re-project it.
 *
 * The store performs the update, the reference re-extraction and the audit
 * write in one transaction; this layer only resolves the id and reports the
 * result. Returns null when the id resolves to nothing.
 */
export function editMemory(
  store: CortexStore,
  id: string,
  text: string,
): EditMemoryResult | null {
  const item = resolveItem(store, id);
  if (!item) {
    return null;
  }

  const priorText = item.text;
  if (!store.updateMemoryItemText(item.id, text)) {
    return null;
  }

  const updated = store.getMemoryItem(item.id);
  if (!updated) {
    return null;
  }

  const [correction] = store.getMemoryCorrections(item.id);

  return {
    item: updated,
    prior_text: priorText,
    references: referenceDetails(store, item.id),
    correction_id: correction?.id ?? '',
  };
}

// ── Deletion (FR-22, AD-14) ───────────────────────────────────────────

export interface DeletionCounterpart {
  id: string;
  subject: string | null;
}

export interface MemoryDeletionPreview {
  item: ParsedMemoryItem;
  source_table: string | null;
  source_id: string | null;
  /** False when no deletion rule exists for `source_table`; the delete refuses. */
  deletable: boolean;
  /** The table the source row would be rebuilt from, if any. */
  upstream_table: string | null;
  reference_count: number;
  /** True when the item is one side of an open contest. */
  contested: boolean;
  /** The other side(s), whose contest this deletion will clear. */
  counterparts: DeletionCounterpart[];
  /** Set when the source row holds more than this item's text. */
  aggregate_warning: string | null;
}

/** What each second-order source row is re-derived from. See `deleteUpstreamOf`. */
const UPSTREAM_OF: Readonly<Record<string, string>> = {
  command_runs: 'events',
  episodes: 'state',
  project_snapshots: 'state',
};

/** Source rows that carry more than the one item's text. */
const AGGREGATE_SOURCES: Readonly<Record<string, string>> = {
  branch_snapshots:
    'the whole branch snapshot goes — focus, intents, blockers, recent files and last session for this scope',
  project_snapshots: 'the whole project snapshot goes, not just this item',
  state: 'the session summary goes, and its twin episode projection with it',
};

/**
 * What a deletion would remove, without removing it.
 *
 * Destructive commands in this repo preview by default — `cortex gc` is
 * dry-run unless `--apply`, and `project-context.md` makes that the standing
 * convention. This is the read half of that pairing, and it is also the
 * confirmation AC #2 requires: the user sees the item before affirming.
 */
export function previewMemoryDeletion(
  store: CortexStore,
  id: string,
): MemoryDeletionPreview | null {
  const item = resolveItem(store, id);
  if (!item) {
    return null;
  }

  const note = sourceNote(store, item);
  const contested = Boolean(note?.conflict);
  // Scope must be compared the way the *delete* compares it. `clearConflictsForSubject`
  // matches `sessions.scope_key IS ?` — session join against session join — while
  // `item.scope_key` is the memory_items column, which `resolveSessionScope`
  // fills with a derived project key when the session's own is NULL. Comparing
  // against the column made the preview report zero counterparts for a contest
  // the delete then cleared: the confirmation surface understating its own blast
  // radius, which is the one thing it must not do.
  const noteScopeKey = note ? store.getScopeKeyForNote(note.id) : null;
  const counterparts: DeletionCounterpart[] =
    contested && note?.subject
      ? store
          .getActiveNotesBySubject(note.subject)
          .filter(other => other.id !== note.id && other.conflict)
          // Detection is scope-keyed, so the counterpart search must be too.
          .filter(other => store.getScopeKeyForNote(other.id) === noteScopeKey)
          .map(other => ({ id: other.id, subject: other.subject }))
      : [];

  const sourceTable = item.source_table;

  return {
    item,
    source_table: sourceTable,
    source_id: item.source_id,
    deletable: sourceTable === null || DELETABLE_SOURCE_TABLES.has(sourceTable),
    upstream_table: sourceTable ? (UPSTREAM_OF[sourceTable] ?? null) : null,
    reference_count: store.getMemoryReferences(item.id).length,
    contested,
    counterparts,
    aggregate_warning: sourceTable ? (AGGREGATE_SOURCES[sourceTable] ?? null) : null,
  };
}

export interface MemoryDeletionResult {
  deleted: boolean;
  item: ParsedMemoryItem;
  source_table: string | null;
  source_id: string | null;
  /** Notes whose contest was closed because this side went away. */
  cleared_contest_for: string | null;
}

/**
 * Delete an item, its source row and everything derived from it, in one
 * transaction. Returns null when the id resolves to nothing.
 */
export function deleteMemory(store: CortexStore, id: string): MemoryDeletionResult | null {
  // Preview and cascade run as one atomic unit. Read separately, the row could
  // vanish between them and the caller would be handed a result describing a
  // deletion that never happened — source row, cleared contest and all. The
  // store's own transaction nests into this one as a savepoint.
  return store.runInImmediateTransaction(() => {
    const preview = previewMemoryDeletion(store, id);
    if (!preview) {
      return null;
    }

    const note = sourceNote(store, preview.item);
    const deleted = store.deleteMemoryItemCascade(preview.item.id);

    return {
      deleted,
      item: preview.item,
      source_table: preview.source_table,
      source_id: preview.source_id,
      cleared_contest_for: preview.contested ? (note?.subject ?? null) : null,
    };
  });
}
