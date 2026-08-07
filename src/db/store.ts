import type Database from 'better-sqlite3';
import { deriveProjectScopeKey, toScopeRelativeKey } from '../scope/keys.js';
import {
  buildBranchSnapshotMemoryText,
  buildCommandMemoryText,
  buildEpisodeMemoryText,
  buildNoteMemoryText,
  buildProjectSnapshotMemoryText,
  commandRunImportance,
  commandRunState,
  episodeImportance,
  episodeState,
  demoteMemoryState,
  memoryStateForNote,
  noteImportance,
  type MemoryItemState,
} from '../memory/items.js';
import { extractMemoryReferences, type ExtractedMemoryReference } from '../memory/references.js';
import { analyzeNote, compareAnalyzed } from '../memory/conflict.js';

/** Row shape the contradiction lookup selects; also feeds the supersede veto. */
interface NoteConflictCandidate {
  id: string;
  kind: string;
  subject: string;
  timestamp: string;
  content: string;
  conflict: number;
  scope_key: string | null;
}

// ── Row types (raw DB rows) ───────────────────────────────────────────

export interface NoteRow {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  subject: string | null;
  content: string;
  alternatives: string | null; // JSON string
  status: string;
  conflict: number; // 0 or 1
}

export interface StateRow {
  id: string;
  session_id: string | null;
  layer: string;
  content: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  session_id: string;
  type: string;
  direction: string;
  tokens: number;
  timestamp: string;
}

export interface SessionRow {
  id: string;
  parent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  focus: string | null;
  agent_type: string;
  agent_id: string | null;
  status: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  scope_type: string;
  scope_key: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  timestamp: string;
  type: string;
  target: string | null;
  metadata_json: string | null;
}

export interface ParsedEvent {
  id: string;
  session_id: string;
  timestamp: string;
  type: string;
  target: string | null;
  metadata: Record<string, unknown>;
}

export interface BranchSnapshotRow {
  id: string;
  scope_key: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  focus: string | null;
  summary: string;
  recent_files: string[];
  intents: string[];
  blockers: string[];
  last_session_id: string | null;
  updated_at: string;
}

export interface CommandRunRow {
  id: string;
  session_id: string;
  event_id: string | null;
  timestamp: string;
  category: string | null;
  command_summary: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  files_touched_json: string | null;
}

export interface ParsedCommandRun {
  id: string;
  session_id: string;
  event_id: string | null;
  timestamp: string;
  category: string | null;
  command_summary: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  files_touched: string[];
}

export interface EpisodeRow {
  id: string;
  session_id: string | null;
  kind: string;
  summary: string;
  target: string | null;
  metadata_json: string | null;
  source_state_id: string | null;
  created_at: string;
}

export interface ParsedEpisode {
  id: string;
  session_id: string | null;
  kind: string;
  summary: string;
  target: string | null;
  metadata: Record<string, unknown>;
  source_state_id: string | null;
  created_at: string;
}

export interface ProjectSnapshotRow {
  id: string;
  git_root: string | null;
  scope_key: string;
  summary: string;
  note_digest: string | null;
  updated_at: string;
}

export interface MemoryItemRow {
  id: string;
  session_id: string | null;
  scope_type: string;
  scope_key: string;
  kind: string;
  source_table: string | null;
  source_id: string | null;
  subject: string | null;
  text: string;
  state: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface MemoryItemSemanticRow {
  memory_item_id: string;
  summary: string;
  concepts_json: string;
  entities_json: string;
  embedding_model: string;
  embedding_json: string;
  source_hash: string;
  updated_at: string;
}

// ── Content digests (read ledger, FR-5) ──────────────────────────────────────

export interface ContentDigestRow {
  scope_key: string;
  path: string;
  sha256: string | null;
  byte_size: number;
  mtime: string | null;
  session_id: string;
  agent_id: string | null;
  oversize: number;
  read_count: number;
  recorded_at: string;
  refund_eligible: number;
}

export interface ParsedContentDigest {
  scopeKey: string;
  path: string;
  sha256: string | null;
  byteSize: number;
  mtime: string | null;
  sessionId: string;
  agentId: string | null;
  oversize: boolean;
  readCount: number;
  recordedAt: string;
  /**
   * Whether this digest provably describes the bytes the recorded read
   * RETURNED (Story 4.5 review round). False when the read was followed in its
   * flush batch by an edit of the same path or by any command — either can
   * rewrite the file before the flush hashes it, in which case the digest
   * describes bytes the reader never saw. A refund (substitution or a read
   * offer) may only be made from an eligible record; change detection uses the
   * digest regardless.
   */
  refundEligible: boolean;
}

export interface NegativeResultRow {
  scope_key: string;
  query_key: string;
  tool: string;
  pattern: string;
  root: string;
  params_json: string | null;
  head_oid: string | null;
  census_sha256: string;
  census_files: number;
  census_bytes: number;
  recorded_at: string;
}

/**
 * FR-12's negative cache (Story 4.3). `censusSha256` is the assertion's entire
 * evidence (AD-6): the search root's working-tree fingerprint at flush time,
 * re-derived and compared at query. `headOid` is verdict metadata — rendered
 * in `no-matches-at <head>`, never compared. `pattern` is stored redacted;
 * `queryKey` hashes the raw pattern, so distinct secret-bearing searches stay
 * distinct without the secret persisting.
 */
export interface ParsedNegativeResult {
  scopeKey: string;
  queryKey: string;
  tool: string;
  pattern: string;
  root: string;
  paramsJson: string | null;
  headOid: string | null;
  censusSha256: string;
  censusFiles: number;
  censusBytes: number;
  recordedAt: string;
}

export interface UpsertNegativeResultOpts {
  scopeKey: string;
  queryKey: string;
  tool: string;
  pattern: string;
  root: string;
  paramsJson?: string | null;
  headOid?: string | null;
  censusSha256: string;
  censusFiles: number;
  censusBytes: number;
  recordedAt?: string;
}

export interface SubagentDispatchRow {
  id: string;
  scope_key: string;
  host_session_id: string;
  prompt_id: string;
  agent_type: string;
  tool_use_id: string | null;
  description: string;
  prompt_digest: string | null;
  prompt_prefix: string | null;
  prompt_chars: number;
  captured_at: string;
  consumed_at: string | null;
}

/**
 * A subagent dispatch seen at `PreToolUse` on the `Agent` tool (FR-18, Story
 * 5.2), waiting to be consumed by the matching `SubagentStart`.
 *
 * `hostSessionId` and `promptId` are the HOST's identifiers, not Cortex session
 * ids — see the table's own docstring in `schema.ts` for why the names differ.
 */
export interface ParsedSubagentDispatch {
  id: string;
  scopeKey: string;
  hostSessionId: string;
  promptId: string;
  agentType: string;
  toolUseId: string | null;
  description: string;
  promptDigest: string | null;
  promptPrefix: string | null;
  promptChars: number;
  capturedAt: string;
  consumedAt: string | null;
}

export interface InsertSubagentDispatchOpts {
  scopeKey: string;
  hostSessionId: string;
  promptId: string;
  agentType: string;
  toolUseId?: string | null;
  description: string;
  promptDigest?: string | null;
  promptPrefix?: string | null;
  promptChars?: number;
  capturedAt?: string;
}

/** The pairing key (Story 5.2). Every part earns its place — see `schema.ts`. */
export interface SubagentDispatchKey {
  hostSessionId: string;
  promptId: string;
  agentType: string;
}

function parseSubagentDispatchRow(row: SubagentDispatchRow): ParsedSubagentDispatch {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    hostSessionId: row.host_session_id,
    promptId: row.prompt_id,
    agentType: row.agent_type,
    toolUseId: row.tool_use_id,
    description: row.description,
    promptDigest: row.prompt_digest,
    promptPrefix: row.prompt_prefix,
    promptChars: row.prompt_chars,
    capturedAt: row.captured_at,
    consumedAt: row.consumed_at,
  };
}

function parseNegativeResultRow(row: NegativeResultRow): ParsedNegativeResult {
  return {
    scopeKey: row.scope_key,
    queryKey: row.query_key,
    tool: row.tool,
    pattern: row.pattern,
    root: row.root,
    paramsJson: row.params_json,
    headOid: row.head_oid,
    censusSha256: row.census_sha256,
    censusFiles: row.census_files,
    censusBytes: row.census_bytes,
    recordedAt: row.recorded_at,
  };
}

export function parseContentDigestRow(row: ContentDigestRow): ParsedContentDigest {
  return {
    scopeKey: row.scope_key,
    path: row.path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    mtime: row.mtime,
    sessionId: row.session_id,
    agentId: row.agent_id,
    oversize: row.oversize === 1,
    readCount: row.read_count,
    recordedAt: row.recorded_at,
    refundEligible: row.refund_eligible === 1,
  };
}

export interface UpsertContentDigestOpts {
  scopeKey: string;
  path: string;
  sha256: string | null;
  byteSize: number;
  mtime?: string | null;
  sessionId: string;
  agentId?: string | null;
  oversize?: boolean;
  recordedAt?: string;
  /**
   * The reading session's parent, when it has one. Used to protect an
   * ancestor's recorded read from being erased by its own descendant — see
   * `upsertContentDigest`.
   */
  readerParentSessionId?: string | null;
  /**
   * See `ParsedContentDigest.refundEligible`. Defaults to TRUE, which is
   * correct for every direct caller (CLI `log read`, `hook-entry post`): those
   * compute the digest at event time, so nothing can have rewritten the file
   * between the read and the hash. The spool flush — the one caller whose
   * digests are computed a whole turn after the reads they describe — passes
   * the value its batch pre-pass computed.
   */
  refundEligible?: boolean;
  /**
   * The scope's worktree root. Paths under it are stored relative to it — the
   * repo prefix is redundant with `scope_key`, and carrying it twice breached
   * Story 3.1's 400 byte/file ceiling. Omit only when genuinely unknown.
   */
  scopeRoot?: string | null;
}

export interface CurrentAppGraphRow {
  scope_key: string;
  scope_type: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  files_json: string;
  file_count: number;
  updated_at: string;
}

export interface ParsedCurrentAppGraph {
  scope_key: string;
  scope_type: string;
  git_root: string | null;
  worktree_path: string | null;
  branch_ref: string | null;
  head_oid: string | null;
  files: string[];
  file_count: number;
  updated_at: string;
}

export type MemoryReferenceStatus = 'exists' | 'missing' | 'moved' | 'unknown' | 'external';

export interface MemoryReferenceRow {
  id: string;
  memory_item_id: string;
  reference_type: string;
  raw_reference: string;
  normalized_path: string;
  status: MemoryReferenceStatus;
  checked_at: string | null;
  moved_to: string | null;
}

export interface ParsedMemoryReference {
  id: string;
  memory_item_id: string;
  reference_type: string;
  raw_reference: string;
  normalized_path: string;
  status: MemoryReferenceStatus;
  checked_at: string | null;
  moved_to: string | null;
}

export interface FileRenameRow {
  id: string;
  scope_key: string;
  old_path: string;
  new_path: string;
  head_oid: string | null;
  detected_at: string;
}

export interface ParsedMemoryItem {
  id: string;
  session_id: string | null;
  scope_type: string;
  scope_key: string;
  kind: string;
  source_table: string | null;
  source_id: string | null;
  subject: string | null;
  text: string;
  state: MemoryItemState;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface SearchMemoryItemResult extends ParsedMemoryItem {
  fts_rank: number;
}

export interface ParsedMemoryItemSemantic {
  memory_item_id: string;
  summary: string;
  concepts: string[];
  entities: string[];
  embedding_model: string;
  embedding: number[];
  source_hash: string;
  updated_at: string;
}

export interface SemanticMemoryItemResult extends ParsedMemoryItem {
  semantic_score: number;
  semantic: ParsedMemoryItemSemantic;
}

export interface RetrievalLogRow {
  id: string;
  session_id: string | null;
  topic: string;
  query_text: string | null;
  result_ids_json: string | null;
  total_candidates: number;
  returned_count: number;
  token_estimate: number;
  created_at: string;
}

export interface ParsedRetrievalLog {
  id: string;
  session_id: string | null;
  topic: string;
  query_text: string | null;
  result_ids: string[];
  total_candidates: number;
  returned_count: number;
  token_estimate: number;
  created_at: string;
}

// ── Input types ───────────────────────────────────────────────────────

export interface CreateSessionOpts {
  parentSessionId?: string;
  agentType?: string;
  /** Host-provided subagent id; absent for a primary session (AD-9). */
  agentId?: string;
  focus?: string;
  gitRoot?: string;
  worktreePath?: string;
  branchRef?: string;
  headOid?: string;
  scopeType?: string;
  scopeKey?: string;
}

export interface InsertEventOpts {
  sessionId: string;
  type: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface InsertNoteOpts {
  sessionId: string;
  kind: 'insight' | 'decision' | 'intent' | 'blocker' | 'focus';
  content: string;
  subject?: string;
  alternatives?: string[];
  /**
   * Skip FR-1 contradiction detection for this write. Only for explicit user
   * resolution (`cortex_resolve` with a replacement), where the note being
   * replaced is still active and would otherwise contest its own replacement.
   */
  skipConflictDetection?: boolean;
}

export interface ParsedNote {
  id: string;
  session_id: string;
  timestamp: string;
  kind: string;
  subject: string | null;
  content: string;
  alternatives: string[] | null; // parsed
  status: string;
  conflict: boolean; // parsed
}

/** A prior note the incoming write was found to contradict (FR-1). */
export interface NoteConflict {
  id: string;
  subject: string;
  timestamp: string;
  content: string;
  /** Which detector fired — see `src/memory/conflict.ts`. */
  signal: 'negation' | 'antonym';
}

/**
 * `insertNote`'s return. Widened rather than replaced so every existing caller
 * that expects a `ParsedNote` keeps compiling. `conflicts` is present only when
 * the write actually contradicted something.
 */
export type InsertedNote = ParsedNote & { conflicts?: NoteConflict[] };

export interface InsertStateOpts {
  sessionId?: string;
  layer: 'session' | 'project';
  content: string;
}

/**
 * What a ledger row records (FR-8).
 *
 * `injected` is what Cortex put into the context; it was stored as `'spent'`
 * until Story 3.5 and is migrated. `saved` is credit for an action that did not
 * happen, and may only be written with evidence. `unrealized` is an offer the
 * agent declined — capability that existed and was not taken — which AC #6
 * requires be visible *separately* from savings rather than folded into them.
 * `estimated` is the retired, evidence-free consolidation credit: kept for
 * history, never counted as a saving.
 */
export type LedgerDirection = 'injected' | 'saved' | 'unrealized' | 'estimated';

/**
 * The evidence a `saved` or `unrealized` row must carry (AC #2).
 *
 * `size` is bytes for an avoided read, output size for an avoided command, and
 * result count for an avoided search — the three shapes the AC names. `ref`
 * identifies the thing avoided (a path, a command, a query).
 */
export interface LedgerEvidence {
  kind: 'read' | 'command' | 'search';
  ref: string;
  size: number;
}

export interface InsertLedgerOpts {
  sessionId: string;
  type: string;
  direction: LedgerDirection;
  tokens: number;
  evidence?: LedgerEvidence;
  /**
   * A caller-supplied stable id, so replaying the same fact is a no-op instead
   * of a second row. Used by the spool's credit replay; omitted elsewhere, in
   * which case a UUID is minted.
   */
  id?: string;
}

export interface LedgerTypeTotals {
  spent: number;
  saved: number;
  unrealized: number;
  estimated: number;
}

/**
 * Ledger sums keyed by the stored direction values (FR-9).
 *
 * `injected` here is the same quantity `getTotalTokens()` reports as `spent` —
 * that older field name is kept so existing readers compile (Story 3.5); new
 * FR-9 surfaces use the stored vocabulary and this comment states the mapping
 * once.
 */
export interface LedgerDirectionTotals {
  injected: number;
  saved: number;
  unrealized: number;
  estimated: number;
}

/** One session's ledger sum for one direction; feeds the FR-9 session block. */
export interface SessionLedgerTotalRow {
  session_id: string;
  direction: string;
  tokens: number;
}

export const LEDGER_DIRECTIONS: ReadonlySet<string> = new Set([
  'injected',
  'saved',
  'unrealized',
  'estimated',
]);

/**
 * The one direction fold (FR-9). Both aggregate readers and the stats layer
 * fold `{direction, tokens}` rows through this so a fifth direction added
 * later has exactly one place to be missed — and a miss is at least a shared
 * miss, not two folds drifting independently. Unknown directions cannot enter
 * through `insertLedgerEntry` (it throws), only through a raw INSERT — the
 * documented `cortex gc` bypass — and they fold to nothing here, an
 * undercount, the PM-preferred direction.
 */
export function foldLedgerDirectionTotals(
  rows: Array<{ direction: string; tokens: number }>,
): LedgerDirectionTotals {
  const totals: LedgerDirectionTotals = { injected: 0, saved: 0, unrealized: 0, estimated: 0 };
  for (const row of rows) {
    if (row.direction === 'injected') totals.injected += row.tokens;
    else if (row.direction === 'saved') totals.saved += row.tokens;
    else if (row.direction === 'unrealized') totals.unrealized += row.tokens;
    else if (row.direction === 'estimated') totals.estimated += row.tokens;
  }
  return totals;
}

/**
 * A credit must be evidenced, and its AMOUNT must be consistent with that
 * evidence.
 *
 * Requiring an evidence object to merely *exist* was not enough. Measured: a
 * spool credit line claiming 1,000,000 tokens against `does/not/exist.ts` with
 * `size: 0` was accepted, and two such lines produced `Saved: 2.0M`. The spool
 * is a plain JSONL file in the project root appended by a bash hook, so that is
 * a reachable input, and "credit that cannot be checked" is the one thing FR-8
 * exists to eliminate — an unchecked amount reintroduces it through the door
 * the evidence requirement was meant to close.
 *
 * The bound for a read or a command is arithmetic: you cannot save more tokens
 * than the avoided content contains, and `ceil(bytes / 4)` is the same ratio
 * `estimateTokens` uses. A search's evidence is a *result count*, not bytes, so
 * no such bound exists and only the reference is required — stated rather than
 * papered over with a fake ceiling.
 */
function assertCreditIsEvidenced(opts: InsertLedgerOpts): void {
  const { evidence, direction } = opts;
  if (!evidence) {
    throw new Error(
      `${direction} ledger row requires evidence (AC #3: no modeled or counterfactual credit)`,
    );
  }
  if (typeof evidence.ref !== 'string' || evidence.ref.trim().length === 0) {
    throw new Error(`${direction} ledger row requires a non-empty evidence ref`);
  }
  if (!Number.isSafeInteger(evidence.size) || evidence.size < 0) {
    throw new Error(`${direction} ledger row requires a whole non-negative evidence size`);
  }
  if (!Number.isSafeInteger(opts.tokens) || opts.tokens < 0) {
    throw new Error(`${direction} ledger row requires a whole non-negative token count`);
  }
  if (evidence.kind !== 'search') {
    const ceiling = Math.ceil(evidence.size / 4);
    if (opts.tokens > ceiling) {
      throw new Error(
        `${direction} ledger row claims ${opts.tokens} tokens against ${evidence.size} bytes of evidence (max ${ceiling})`,
      );
    }
  }
}

export interface InsertCommandRunOpts {
  id?: string;
  sessionId: string;
  eventId?: string | null;
  timestamp?: string;
  category?: string | null;
  commandSummary?: string | null;
  exitCode?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  filesTouched?: string[];
}

export interface InsertEpisodeOpts {
  id?: string;
  sessionId?: string | null;
  kind: string;
  summary: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
  sourceStateId?: string | null;
  createdAt?: string;
}

export interface UpsertBranchSnapshotOpts {
  scopeKey: string;
  gitRoot?: string | null;
  worktreePath?: string | null;
  branchRef?: string | null;
  headOid?: string | null;
  focus?: string | null;
  summary: string;
  recentFiles?: string[];
  intents?: string[];
  blockers?: string[];
  lastSessionId?: string | null;
  updatedAt?: string;
}

export interface UpsertProjectSnapshotOpts {
  id?: string;
  gitRoot?: string | null;
  scopeKey: string;
  summary: string;
  noteDigest?: string | null;
  updatedAt?: string;
}

export interface UpsertMemoryItemOpts {
  id?: string;
  sessionId?: string | null;
  scopeType: string;
  scopeKey: string;
  kind: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  subject?: string | null;
  text: string;
  state?: MemoryItemState;
  importance?: number;
  accessCount?: number;
  lastAccessedAt?: string | null;
  createdAt?: string;
}

/**
 * Source tables `deleteMemoryItemCascade` knows how to remove, including their
 * upstream producers. Exported so the deletion preview promises exactly what
 * the delete performs — a table missing here must not be advertised as "deleted
 * too", and a future source table must be added in both places at once.
 */
export const DELETABLE_SOURCE_TABLES: ReadonlySet<string> = new Set([
  'notes',
  'episodes',
  'command_runs',
  'project_snapshots',
  'branch_snapshots',
  'state',
]);

/** An audit-trail row (FR-22). Outlives the item it names — see the DDL. */
export interface ParsedMemoryCorrection {
  id: string;
  memory_item_id: string;
  source_table: string | null;
  source_id: string | null;
  scope_key: string | null;
  operation: string;
  prior_text: string;
  new_text: string | null;
  prior_subject: string | null;
  created_at: string;
}

export interface RecordMemoryCorrectionOpts {
  id?: string;
  memoryItemId: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  scopeKey?: string | null;
  operation: 'edit' | 'delete';
  priorText: string;
  newText?: string | null;
  priorSubject?: string | null;
  createdAt?: string;
}

/** Column filters for the memory-item listing (FR-21). Absent = unfiltered. */
export interface MemoryItemFilter {
  scopeKeys?: string[];
  kinds?: string[];
  states?: string[];
}

export interface ListMemoryItemsOpts extends MemoryItemFilter {
  limit?: number;
  offset?: number;
}

export interface UpsertMemoryItemSemanticOpts {
  memoryItemId: string;
  summary: string;
  concepts?: string[];
  entities?: string[];
  embeddingModel: string;
  embedding: number[];
  sourceHash: string;
  updatedAt?: string;
}

export interface UpsertCurrentAppGraphOpts {
  scopeKey: string;
  scopeType: string;
  gitRoot?: string | null;
  worktreePath?: string | null;
  branchRef?: string | null;
  headOid?: string | null;
  files: string[];
  updatedAt?: string;
}

export interface UpsertMemoryReferenceOpts extends ExtractedMemoryReference {
  status?: MemoryReferenceStatus;
  checkedAt?: string | null;
}

export interface InsertRetrievalLogOpts {
  id?: string;
  sessionId?: string | null;
  topic: string;
  queryText?: string | null;
  resultIds?: string[];
  totalCandidates?: number;
  returnedCount?: number;
  tokenEstimate?: number;
  createdAt?: string;
}

export interface UpdateMemoryItemStateOpts {
  id: string;
  state: MemoryItemState;
}

export interface TableCounts {
  sessions: number;
  events: number;
  notes: number;
  state: number;
  token_ledger: number;
  command_runs: number;
  episodes: number;
  branch_snapshots: number;
  project_snapshots: number;
  memory_items: number;
  memory_item_semantics: number;
  current_app_graphs: number;
  memory_references: number;
  retrieval_log: number;
  file_renames: number;
  content_digests: number;
}

// ── Helper functions ──────────────────────────────────────────────────

export function parseNoteRow(row: NoteRow): ParsedNote {
  let alternatives: string[] | null = null;
  if (row.alternatives) {
    try {
      alternatives = JSON.parse(row.alternatives) as string[];
    } catch {
      alternatives = null;
    }
  }
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    kind: row.kind,
    subject: row.subject,
    content: row.content,
    alternatives,
    status: row.status,
    conflict: row.conflict === 1,
  };
}

export function parseEventRow(row: EventRow): ParsedEvent {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    type: row.type,
    target: row.target,
    metadata,
  };
}

export function parseCommandRunRow(row: CommandRunRow): ParsedCommandRun {
  return {
    id: row.id,
    session_id: row.session_id,
    event_id: row.event_id,
    timestamp: row.timestamp,
    category: row.category,
    command_summary: row.command_summary,
    exit_code: row.exit_code,
    stdout_tail: row.stdout_tail,
    stderr_tail: row.stderr_tail,
    files_touched: parseJsonStringArray(row.files_touched_json),
  };
}

export function parseEpisodeRow(row: EpisodeRow): ParsedEpisode {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    summary: row.summary,
    target: row.target,
    metadata: parseJsonObject(row.metadata_json),
    source_state_id: row.source_state_id,
    created_at: row.created_at,
  };
}

export function parseMemoryItemRow(row: MemoryItemRow): ParsedMemoryItem {
  return {
    id: row.id,
    session_id: row.session_id,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    kind: row.kind,
    source_table: row.source_table,
    source_id: row.source_id,
    subject: row.subject,
    text: row.text,
    state: row.state as MemoryItemState,
    importance: row.importance,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
  };
}

export function parseMemoryItemSemanticRow(row: MemoryItemSemanticRow): ParsedMemoryItemSemantic {
  return {
    memory_item_id: row.memory_item_id,
    summary: row.summary,
    concepts: parseJsonStringArray(row.concepts_json),
    entities: parseJsonStringArray(row.entities_json),
    embedding_model: row.embedding_model,
    embedding: parseJsonNumberArray(row.embedding_json),
    source_hash: row.source_hash,
    updated_at: row.updated_at,
  };
}

export function parseCurrentAppGraphRow(row: CurrentAppGraphRow): ParsedCurrentAppGraph {
  const files = parseJsonStringArray(row.files_json);
  return {
    scope_key: row.scope_key,
    scope_type: row.scope_type,
    git_root: row.git_root,
    worktree_path: row.worktree_path,
    branch_ref: row.branch_ref,
    head_oid: row.head_oid,
    files,
    file_count: row.file_count,
    updated_at: row.updated_at,
  };
}

export function parseMemoryReferenceRow(row: MemoryReferenceRow): ParsedMemoryReference {
  return {
    id: row.id,
    memory_item_id: row.memory_item_id,
    reference_type: row.reference_type,
    raw_reference: row.raw_reference,
    normalized_path: row.normalized_path,
    status: row.status,
    checked_at: row.checked_at,
    moved_to: row.moved_to ?? null,
  };
}

export function parseRetrievalLogRow(row: RetrievalLogRow): ParsedRetrievalLog {
  return {
    id: row.id,
    session_id: row.session_id,
    topic: row.topic,
    query_text: row.query_text,
    result_ids: parseJsonStringArray(row.result_ids_json),
    total_candidates: row.total_candidates,
    returned_count: row.returned_count,
    token_estimate: row.token_estimate,
    created_at: row.created_at,
  };
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseJsonNumberArray(raw: string | null | undefined): number[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(value => typeof value === 'number' && Number.isFinite(value));
  } catch {
    return [];
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let i = 0; i < left.length; i += 1) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Shared WHERE builder for the filtered listing and its count, so the count
 * can never describe a different set than the page it labels.
 *
 * `undefined` means "no filter on this column"; an explicitly empty array
 * means "match nothing". The CLI never produces the latter, but the library
 * API can, and reinterpreting an empty selection as "everything" is how a
 * filter starts lying about what it filtered.
 */
function buildMemoryItemFilterClause(
  filter: MemoryItemFilter,
): { sql: string; params: string[] } {
  const columns: Array<[string, string[] | undefined]> = [
    ['scope_key', filter.scopeKeys],
    ['kind', filter.kinds],
    ['state', filter.states],
  ];

  const clauses: string[] = [];
  const params: string[] = [];

  for (const [column, values] of columns) {
    if (values === undefined) {
      continue;
    }
    if (values.length === 0) {
      return { sql: 'WHERE 1 = 0', params: [] };
    }
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// ── Store ─────────────────────────────────────────────────────────────

export class CortexStore {
  /**
   * The underlying handle.
   *
   * Public so callers that must operate on the *file* rather than its rows —
   * the WAL checkpoint of FR-25 — can do so without opening a second
   * connection.
   *
   * `readonly` is a **compile-time** annotation, not a runtime guarantee: this
   * package ships `dist/`, and a JavaScript consumer can reassign it or call
   * `close()` on it, after which every method here throws. Stated rather than
   * implied, because an earlier version of this comment claimed the annotation
   * prevented what it only discourages.
   */
  constructor(readonly db: Database.Database) {}

  private resolveSessionScope(
    sessionId: string,
  ): { scopeType: string; scopeKey: string } | undefined {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }

    const scopeKey =
      session.scope_key ??
      (session.scope_type === 'project' ? this.getProjectScopeKey() : undefined);
    if (!scopeKey) {
      return undefined;
    }

    return {
      scopeType: session.scope_type,
      scopeKey,
    };
  }

  private getProjectScopeKey(): string | undefined {
    const rootPath = this.getMeta('root_path');
    return rootPath ? deriveProjectScopeKey(rootPath) : 'project:default';
  }

  private syncMemoryItemForNote(noteId: string): void {
    const note = this.getNote(noteId);
    if (!note) {
      return;
    }

    const scope = this.resolveSessionScope(note.session_id);
    if (!scope) {
      return;
    }

    // A superseded note's tier is set exactly once, at the status transition
    // (FR-4). Re-syncs happen — markConflict, clearing a contest — and if each
    // re-derived the state here, the tier would step downward on every one.
    // Preserve the existing item's state instead; `memoryStateForNote` is only
    // the landing for a projection with no prior item (backfill, fresh seed).
    // This also keeps pre-1.4 rows archived: forward-only, no resurrection.
    // Read the existing projection unconditionally, not just for superseded
    // notes. `upsertMemoryItem`'s ON CONFLICT writes `access_count` and
    // `last_accessed_at` from the (defaulted) opts, so omitting them resets a
    // re-synced item's access history to 0/NULL and re-derives its tier —
    // silently reheating a cold memory, un-pinning a pinned one, and moving
    // both `computeHotness` inputs. Every re-sync path hits this: an edit
    // (FR-22), `markConflict`, and `clearConflictsForSubject`.
    const existing = this.getMemoryItemBySource('notes', note.id);

    this.upsertMemoryItem({
      id: `notes:${note.id}`,
      sessionId: note.session_id,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      kind: `note:${note.kind}`,
      sourceTable: 'notes',
      sourceId: note.id,
      subject: note.subject,
      text: buildNoteMemoryText(note),
      // Tier and counters are preserved on different rules.
      //
      // Tier: a `superseded` note's tier is set exactly once at the status
      // transition (FR-4), so preserve it. A `resolved` note must land cold —
      // that is the close-out contract, and re-deriving is what enforces it.
      // An `active` note keeps whatever tier it had, so a correction or a
      // conflict re-sync cannot reheat a decayed memory or un-pin a pinned one.
      state:
        existing && note.status !== 'resolved'
          ? existing.state
          : memoryStateForNote(note.kind, note.status),
      importance: noteImportance(note.kind),
      // Counters are preserved unconditionally: they are `computeHotness`
      // inputs and durable access history, and no status transition is a
      // reason to forget how often a memory was used.
      ...(existing ? { accessCount: existing.access_count } : {}),
      ...(existing ? { lastAccessedAt: existing.last_accessed_at } : {}),
      createdAt: note.timestamp,
    });
  }

  /**
   * The FR-4 demotion step: one tier colder, exactly once, at the moment a
   * note becomes superseded. Kept out of `syncMemoryItemForNote` so re-syncs
   * cannot repeat it.
   */
  private demoteMemoryItemForNote(noteId: string): void {
    const item = this.getMemoryItemBySource('notes', noteId);
    if (!item) {
      return;
    }
    const demoted = demoteMemoryState(item.state);
    if (demoted !== item.state) {
      this.updateMemoryItemStates([{ id: item.id, state: demoted }]);
    }
  }

  private syncMemoryItemForCommandRun(commandRunId: string): void {
    const run = this.getCommandRun(commandRunId);
    if (!run) {
      return;
    }

    const scope = this.resolveSessionScope(run.session_id);
    if (!scope) {
      return;
    }

    this.upsertMemoryItem({
      id: `command_runs:${run.id}`,
      sessionId: run.session_id,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      kind: 'command_run',
      sourceTable: 'command_runs',
      sourceId: run.id,
      text: buildCommandMemoryText(run),
      state: commandRunState(run),
      importance: commandRunImportance(run),
      createdAt: run.timestamp,
    });
  }

  private syncMemoryItemForEpisode(episodeId: string): void {
    const episode = this.getEpisode(episodeId);
    if (!episode) {
      return;
    }

    const scope = episode.session_id
      ? this.resolveSessionScope(episode.session_id)
      : undefined;
    const scopeType = scope?.scopeType ?? 'project';
    const scopeKey = scope?.scopeKey ?? this.getProjectScopeKey();
    if (!scopeKey) {
      return;
    }

    this.upsertMemoryItem({
      id: `episodes:${episode.id}`,
      sessionId: episode.session_id,
      scopeType,
      scopeKey,
      kind: `episode:${episode.kind}`,
      sourceTable: 'episodes',
      sourceId: episode.id,
      subject: episode.target,
      text: buildEpisodeMemoryText(episode),
      state: episodeState(episode.kind),
      importance: episodeImportance(episode.kind),
      createdAt: episode.created_at,
    });
  }

  private syncMemoryItemForBranchSnapshot(scopeKey: string): void {
    const snapshot = this.getBranchSnapshot(scopeKey);
    if (!snapshot) {
      return;
    }

    this.upsertMemoryItem({
      id: `branch_snapshots:${snapshot.id}`,
      sessionId: snapshot.last_session_id,
      scopeType: snapshot.branch_ref ? 'branch' : 'detached-head',
      scopeKey: snapshot.scope_key,
      kind: 'branch_snapshot',
      sourceTable: 'branch_snapshots',
      sourceId: snapshot.id,
      subject: snapshot.branch_ref ?? snapshot.focus,
      text: buildBranchSnapshotMemoryText(snapshot),
      state: 'hot',
      importance: 0.92,
      createdAt: snapshot.updated_at,
    });
  }

  private syncMemoryItemForProjectSnapshot(scopeKey: string): void {
    const snapshot = this.getProjectSnapshot(scopeKey);
    if (!snapshot) {
      return;
    }

    this.upsertMemoryItem({
      id: `project_snapshots:${snapshot.id}`,
      scopeType: 'project',
      scopeKey: snapshot.scope_key,
      kind: 'project_snapshot',
      sourceTable: 'project_snapshots',
      sourceId: snapshot.id,
      text: buildProjectSnapshotMemoryText(snapshot.summary, snapshot.note_digest),
      state: 'warm',
      importance: 0.8,
      createdAt: snapshot.updated_at,
    });
  }

  // ── Meta ──────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  /**
   * Increment a numeric `meta` counter in ONE statement.
   *
   * A read-modify-write across two connections loses updates even under
   * `busy_timeout`: that setting serialises writes, it does not make
   * read-then-write atomic, so two processes can both read `5` and both write
   * `6`. Hook processes are independent by construction, so any counter they
   * share needs the increment to happen inside the database.
   *
   * The digit guard is not decoration. A bare `CAST(value AS INTEGER)` parses a
   * numeric PREFIX — `'12 fires'` becomes 12 — which is precisely the
   * fail-forward behaviour `parseInt` was banned for after four incidents, just
   * arriving through SQL instead of JS. Only an all-digit value counts; anything
   * else restarts at 1, matching the `Number`-based readers that treat a corrupt
   * value as 0.
   */
  incrementMetaCounter(key: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(
           CASE WHEN value GLOB '[0-9]*' AND NOT value GLOB '*[^0-9]*'
                THEN CAST(value AS INTEGER)
                ELSE 0
           END + 1 AS TEXT)`,
      )
      .run(key);
  }

  // ── Sessions ──────────────────────────────────────────────────────

  createSession(opts: CreateSessionOpts = {}): SessionRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (
           id,
           parent_session_id,
           started_at,
           focus,
           agent_type,
           agent_id,
           status,
           git_root,
           worktree_path,
           branch_ref,
           head_oid,
           scope_type,
           scope_key
         )
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.parentSessionId ?? null,
        now,
        opts.focus ?? null,
        opts.agentType ?? 'primary',
        opts.agentId ?? null,
        opts.gitRoot ?? null,
        opts.worktreePath ?? null,
        opts.branchRef ?? null,
        opts.headOid ?? null,
        opts.scopeType ?? 'project',
        opts.scopeKey ?? null,
      );

    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  /**
   * The active *primary* session. Child sessions stay active for as long as
   * their subagent runs, so without the parentage filter the newest subagent
   * would become "the current session" and every primary-path caller would
   * start writing into it (AD-9).
   */
  getCurrentSession(): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'active' AND parent_session_id IS NULL
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as SessionRow | undefined;
  }

  /**
   * Resolve a child session by its AD-9 identity. Deliberately unfiltered by
   * status and parent: a subagent's entries can be replayed from the spool
   * after its parent has ended, and must still find their own session.
   */
  getSessionByAgentId(scopeKey: string, agentId: string): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE scope_key = ? AND agent_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(scopeKey, agentId) as SessionRow | undefined;
  }

  updateSessionAgentType(id: string, agentType: string): void {
    this.db
      .prepare('UPDATE sessions SET agent_type = ? WHERE id = ?')
      .run(agentType, id);
  }

  updateSessionFocus(id: string, focus: string): void {
    this.db
      .prepare('UPDATE sessions SET focus = ? WHERE id = ?')
      .run(focus, id);
  }

  updateSessionScope(
    id: string,
    scope: {
      gitRoot?: string | null;
      worktreePath?: string | null;
      branchRef?: string | null;
      headOid?: string | null;
      scopeType: string;
      scopeKey: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET git_root = ?,
             worktree_path = ?,
             branch_ref = ?,
             head_oid = ?,
             scope_type = ?,
             scope_key = ?
         WHERE id = ?`,
      )
      .run(
        scope.gitRoot ?? null,
        scope.worktreePath ?? null,
        scope.branchRef ?? null,
        scope.headOid ?? null,
        scope.scopeType,
        scope.scopeKey,
        id,
      );
  }

  endSession(id: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  /**
   * End a session together with its still-active children. Nothing else ends a
   * child — session rotation and `inject-header` both act on the active
   * primary — so without this a subagent's session stays `active` forever and
   * is structurally exempt from consolidation and event GC, both of which
   * require `status = 'ended'`.
   */
  endSessionTree(id: string): void {
    const now = new Date().toISOString();
    const end = this.db.prepare(
      `UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`,
    );

    this.runInTransaction(() => {
      for (const child of this.getChildSessions(id)) {
        if (child.status === 'active') {
          end.run(now, child.id);
        }
      }
      end.run(now, id);
    });
  }

  getRecentSessions(limit: number): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(limit) as SessionRow[];
  }

  /**
   * Recent primary sessions. Callers deriving "where am I working" must use
   * this rather than `getRecentSessions`: children sort ahead of their parent
   * (they are created later), so an orphaned child would otherwise become the
   * scope anchor once the primary has ended.
   */
  getRecentPrimarySessions(limit: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE parent_session_id IS NULL
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[];
  }

  /**
   * Primary sessions only. These feed branch snapshots, the recent-session
   * tail and the consult gate; a child inherits its parent's scope_key, so
   * without the filter subagent activity would surface as scope history.
   * Child timelines are reached explicitly via getChildSessions.
   */
  getRecentSessionsByScope(scopeKey: string, limit: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE scope_key = ? AND parent_session_id IS NULL
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scopeKey, limit) as SessionRow[];
  }

  getSessionCountByScope(scopeKey: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM sessions
         WHERE scope_key = ? AND parent_session_id IS NULL`,
      )
      .get(scopeKey) as { count: number };
    return row.count;
  }

  getUnconsolidatedSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.status = 'ended'
           AND NOT EXISTS (
             SELECT 1 FROM state st
             WHERE st.session_id = s.id AND st.layer = 'session'
           )
         ORDER BY s.started_at DESC`,
      )
      .all() as SessionRow[];
  }

  getUnconsolidatedSessionsByScope(scopeKey: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.scope_key = ?
           AND s.status = 'ended'
           AND NOT EXISTS (
             SELECT 1 FROM state st
             WHERE st.session_id = s.id AND st.layer = 'session'
           )
         ORDER BY s.started_at DESC`,
      )
      .all(scopeKey) as SessionRow[];
  }

  getChildSessions(parentId: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE parent_session_id = ?')
      .all(parentId) as SessionRow[];
  }

  /**
   * The session's own id followed by each ancestor, nearest first (AD-16).
   *
   * A read is refund-eligible when the recording session is the requester or an
   * *ancestor* of it, so this list is exactly the eligibility set — membership
   * is the whole predicate, which keeps the rule in one place instead of spread
   * across the caller.
   *
   * Walked rather than computed as `parent_session_id ?? id`. Depth is 2 today
   * by construction (a subagent's parent is the scope's active *primary*, never
   * another subagent), and the shorthand would be correct for exactly that
   * shape — which is why it is not used: a future nesting change would silently
   * start reporting a grandparent's read as someone else's, and the failure
   * mode of AD-16 is a wrong "you read it". The visited set is not decoration
   * either: `parent_session_id` carries no CHECK preventing a cycle, and a
   * cycle here would hang the query surface rather than answer it wrongly.
   */
  getSessionAncestorIds(sessionId: string, maxDepth = 32): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    const read = this.db.prepare(
      'SELECT parent_session_id FROM sessions WHERE id = ?',
    );

    let current: string | null = sessionId;
    while (current !== null && chain.length < maxDepth) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      chain.push(current);
      const row = read.get(current) as { parent_session_id: string | null } | undefined;
      // A session id that does not exist still contributes itself — the caller
      // asked about *that* session, and dropping it would make a digest recorded
      // by it look like someone else's read.
      current = row?.parent_session_id ?? null;
    }
    return chain;
  }

  /**
   * Whether `sessionId` edited or wrote the file behind `filePath` after `after`.
   *
   * The evidence behind Story 3.3's `edited-by-you-since`, and the reason it
   * lives in the store: `events.target` holds the **raw** path the tool
   * reported, while `content_digests.path` is normalized and scope-root-relative.
   * Comparing the two directly never matches, and the failure is silent — the
   * verdict degrades to a bare `changed-since` with nothing to indicate the
   * join was the problem.
   *
   * The SQL `LIKE` is a **prefilter only**, never the decision. It narrows to
   * events whose raw target ends in the same basename so a session with tens of
   * thousands of edits does not stream them all into JS; the exact answer is the
   * key comparison below, which is the same derivation the write used. A
   * prefilter that over-matches costs nothing; one that under-matches loses the
   * edit fact silently, degrading `edited-by-you-since` to a bare
   * `changed-since` with nothing to indicate why.
   *
   * **So it is applied only to a pure-ASCII basename.** An earlier version of
   * this comment claimed the prefilter could not under-match, because the
   * basename is invariant under every transformation `toScopeRelativeKey`
   * applies except case, and SQLite's `LIKE` is case-insensitive. That claim was
   * false and the code inherited the bug: SQLite's `LIKE` folds case for **ASCII
   * only**, while `normalizeFilePathKey` uses JavaScript `toLowerCase()`, which
   * folds the full Unicode range on win32 and darwin. Measured — `Unicode-Ü.ts`
   * normalises to the key `unicode-ü.ts`, the raw event target still holds `Ü`,
   * `LIKE` matched zero rows, and AC #4 was **unreachable for that file** on
   * both case-insensitive platforms while `Ascii.ts` passed. Skipping the
   * prefilter there costs a full scan of one session's edit events and always
   * returns the right answer; the ASCII path keeps the optimisation.
   */
  sessionEditedPathAfter(opts: {
    sessionId: string;
    scopeKey: string;
    path: string;
    after: string;
    scopeRoot?: string | null;
  }): boolean {
    const root = opts.scopeRoot ?? this.scopeRootFor(opts.scopeKey);
    const key = toScopeRelativeKey(opts.path, root);
    const basename = key.slice(key.lastIndexOf('/') + 1);
    // Only a pure-ASCII basename may be prefiltered — see the note above. The
    // test is on the KEY's basename, which is the case-folded form, so it is
    // the same string `LIKE` would have to match.
    // eslint-disable-next-line no-control-regex
    const asciiOnly = /^[\u0000-\u007F]*$/.test(basename);
    // `%` and `_` are LIKE wildcards and a filename may legally contain either;
    // unescaped, `a_b.ts` would also prefilter `axb.ts` (harmless) but a name
    // that is *only* wildcards would prefilter everything (slow, still correct).
    const escaped = basename.replace(/([\\%_])/g, '\\$1');

    const rows = this.db
      .prepare(
        `SELECT target
           FROM events
          WHERE session_id = ?
            AND type IN ('edit', 'write')
            AND timestamp > ?
            AND target IS NOT NULL
            AND (:skipPrefilter OR target LIKE :needle ESCAPE '\\')`,
      )
      .all(opts.sessionId, opts.after, {
        skipPrefilter: asciiOnly ? 0 : 1,
        needle: `%${escaped}`,
      }) as { target: string }[];

    return rows.some(row => toScopeRelativeKey(row.target, root) === key);
  }

  getSessionCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM sessions')
      .get() as { count: number };
    return row.count;
  }

  getTableCounts(): TableCounts {
    const count = (tableName: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
        .get() as { count: number };
      return row.count;
    };

    return {
      sessions: count('sessions'),
      events: count('events'),
      notes: count('notes'),
      state: count('state'),
      token_ledger: count('token_ledger'),
      command_runs: count('command_runs'),
      episodes: count('episodes'),
      branch_snapshots: count('branch_snapshots'),
      project_snapshots: count('project_snapshots'),
      memory_items: count('memory_items'),
      memory_item_semantics: count('memory_item_semantics'),
      current_app_graphs: count('current_app_graphs'),
      memory_references: count('memory_references'),
      retrieval_log: count('retrieval_log'),
      file_renames: count('file_renames'),
      content_digests: count('content_digests'),
    };
  }

  // ── Events ────────────────────────────────────────────────────────

  insertEvent(opts: InsertEventOpts): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadataJson =
      opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO events (id, session_id, timestamp, type, target, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.sessionId, now, opts.type, opts.target ?? null, metadataJson);

    return id;
  }

  getEventsBySession(sessionId: string): ParsedEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC')
      .all(sessionId) as EventRow[];
    return rows.map(parseEventRow);
  }

  getEventsByType(sessionId: string, type: string): ParsedEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY timestamp ASC',
      )
      .all(sessionId, type) as EventRow[];
    return rows.map(parseEventRow);
  }

  getEventCount(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?')
      .get(sessionId) as { count: number };
    return row.count;
  }

  deleteEventsBySession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM events WHERE session_id = ?')
      .run(sessionId);
  }

  insertCommandRun(opts: InsertCommandRunOpts): ParsedCommandRun {
    const id = opts.id ?? crypto.randomUUID();
    const timestamp = opts.timestamp ?? new Date().toISOString();
    const eventId = opts.eventId
      ? (this.db
          .prepare('SELECT id FROM events WHERE id = ?')
          .get(opts.eventId) as { id: string } | undefined)?.id ?? null
      : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO command_runs (
           id,
           session_id,
           event_id,
           timestamp,
           category,
           command_summary,
           exit_code,
           stdout_tail,
           stderr_tail,
           files_touched_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId,
        eventId,
        timestamp,
        opts.category ?? null,
        opts.commandSummary ?? null,
        opts.exitCode ?? null,
        opts.stdoutTail ?? null,
        opts.stderrTail ?? null,
        JSON.stringify(opts.filesTouched ?? []),
      );

    const run = this.getCommandRun(id)!;
    this.syncMemoryItemForCommandRun(id);
    return run;
  }

  getCommandRun(id: string): ParsedCommandRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_runs WHERE id = ?')
      .get(id) as CommandRunRow | undefined;
    return row ? parseCommandRunRow(row) : undefined;
  }

  getCommandRunsBySession(sessionId: string): ParsedCommandRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM command_runs WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
      )
      .all(sessionId) as CommandRunRow[];
    return rows.map(parseCommandRunRow);
  }

  getCommandRunByEvent(eventId: string): ParsedCommandRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_runs WHERE event_id = ?')
      .get(eventId) as CommandRunRow | undefined;
    return row ? parseCommandRunRow(row) : undefined;
  }

  insertEpisode(opts: InsertEpisodeOpts): ParsedEpisode {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();
    const metadataJson =
      opts.metadata !== undefined ? JSON.stringify(opts.metadata) : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodes (
           id,
           session_id,
           kind,
           summary,
           target,
           metadata_json,
           source_state_id,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.kind,
        opts.summary,
        opts.target ?? null,
        metadataJson,
        opts.sourceStateId ?? null,
        createdAt,
      );

    const episode = this.getEpisode(id)!;
    this.syncMemoryItemForEpisode(id);
    return episode;
  }

  /** Newest episode of a kind whose summary matches the base text (with or without a repeat suffix). */
  /**
   * A session and everyone it shares a primary with: the root primary plus all
   * of its children. Used to scope folds and evidence collection to one turn's
   * work without merging across unrelated sessions.
   */
  getSessionTreeIds(sessionId: string): string[] {
    const session = this.getSession(sessionId);
    if (!session) {
      return [sessionId];
    }

    const rootId = session.parent_session_id ?? session.id;
    return [rootId, ...this.getChildSessions(rootId).map(child => child.id)];
  }

  /**
   * Scoped to the recording session. The fold exists to collapse a retry loop
   * within one session, not to merge across sessions — unscoped, whichever
   * session hit an identical failure *first* owned the episode, so a subagent
   * failing before its parent left the parent with no episode at all and
   * reheated the child's row on the parent's activity. Two agents independently
   * hitting one failure are two observations and each keeps its own episode.
   */
  findRecentEpisodeBySummary(
    kind: string,
    baseSummary: string,
    sinceIso: string,
    sessionId: string,
  ): ParsedEpisode | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE kind = ?
           AND created_at >= ?
           AND (summary = ? OR summary LIKE ?)
           AND session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(kind, sinceIso, baseSummary, `${baseSummary} (seen %`, sessionId) as
      | EpisodeRow
      | undefined;
    return row ? parseEpisodeRow(row) : undefined;
  }

  /**
   * Fold a repeated occurrence into an existing episode: bump the counter,
   * refresh recency, and keep one searchable row instead of N duplicates.
   * The repeat count is itself retrieval signal.
   */
  bumpEpisodeOccurrence(id: string, baseSummary: string): ParsedEpisode | undefined {
    const episode = this.getEpisode(id);
    if (!episode) {
      return undefined;
    }

    const metadata = { ...(episode.metadata ?? {}) } as Record<string, unknown>;
    const previous = typeof metadata['occurrences'] === 'number' ? metadata['occurrences'] : 1;
    const occurrences = previous + 1;
    metadata['occurrences'] = occurrences;
    metadata['last_occurred_at'] = new Date().toISOString();

    const summary = `${baseSummary} (seen ${occurrences}x)`;
    this.db
      .prepare(
        `UPDATE episodes
         SET summary = ?, metadata_json = ?, created_at = ?
         WHERE id = ?`,
      )
      .run(summary, JSON.stringify(metadata), new Date().toISOString(), id);

    this.syncMemoryItemForEpisode(id);
    return this.getEpisode(id);
  }

  getEpisode(id: string): ParsedEpisode | undefined {
    const row = this.db
      .prepare('SELECT * FROM episodes WHERE id = ?')
      .get(id) as EpisodeRow | undefined;
    return row ? parseEpisodeRow(row) : undefined;
  }

  getEpisodesBySession(sessionId: string): ParsedEpisode[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId) as EpisodeRow[];
    return rows.map(parseEpisodeRow);
  }

  // ── Notes ─────────────────────────────────────────────────────────

  insertNote(opts: InsertNoteOpts): InsertedNote {
    const kindsRequiringSubject = ['decision', 'intent', 'blocker', 'focus'];
    // `!opts.subject` passes for "   ", which then normalizes to "" — not null.
    // That bypassed the guard and dropped every whitespace-subject note into one
    // shared "" bucket where unrelated notes contested each other.
    const trimmedSubject = opts.subject?.trim() ? opts.subject.trim() : undefined;
    if (kindsRequiringSubject.includes(opts.kind) && !trimmedSubject) {
      throw new Error(`Subject is required for ${opts.kind} notes`);
    }

    const subject = trimmedSubject ? trimmedSubject.toLowerCase() : null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const alternativesJson =
      opts.alternatives !== undefined ? JSON.stringify(opts.alternatives) : null;

    // The whole write is one transaction. Detect -> supersede -> insert -> mark
    // are four statements; without this a concurrent writer landing between the
    // detection SELECT and the supersede UPDATE supersedes the very row this
    // write just decided to protect, losing the AD-17 veto. Two Claude sessions
    // on one project share a database file, so this is reachable.
    const run = this.db.transaction((): { supersededIds: string[]; conflicts: NoteConflict[] } => {
      const supersededIds: string[] = [];
      const conflicts: NoteConflict[] = [];

      // FR-1 contradiction detection. AC #2: a subjectless note issues no query
      // at all, so everything below is gated on having a subject. AC #1 scopes
      // the *prior* to an active note:decision; the incoming may be any kind.
      let priors: NoteConflictCandidate[] = [];
      if (subject !== null) {
        // One lookup covers detection (kind='decision') and the supersede
        // candidates (kind=opts.kind); they are partitioned below rather than
        // asking twice. Deliberately NOT scope-filtered: auto-supersede has
        // always been scope-blind and changing that is not this story's to make.
        // The scope filter applies only to the contest decision below.
        priors = this.db
          .prepare(
            `SELECT n.id, n.kind, n.subject, n.timestamp, n.content, n.conflict, s.scope_key
               FROM notes n
               INNER JOIN sessions s ON s.id = n.session_id
              WHERE n.subject = ?
                AND n.status = 'active'
                AND (n.kind = 'decision' OR n.kind = ?)`,
          )
          .all(subject, opts.kind) as NoteConflictCandidate[];

        const writerScope = this.scopeKeyForSession(opts.sessionId);
        const incoming = analyzeNote(opts.content);
        for (const prior of priors) {
          if (opts.skipConflictDetection) break;
          if (prior.kind !== 'decision') continue;
          // A decision on another branch is not a contradiction of this one —
          // two branches holding opposite decisions is the ordinary reason
          // branches exist, and the contest marker would surface in the other
          // branch's working set.
          if (prior.scope_key !== writerScope) continue;
          const evidence = compareAnalyzed(analyzeNote(prior.content), incoming);
          if (evidence) {
            conflicts.push({
              id: prior.id,
              subject: prior.subject,
              timestamp: prior.timestamp,
              content: prior.content,
              signal: evidence.signal,
            });
          }
        }
      }

      // AD-17 veto set: what this write contradicts, PLUS anything already
      // contested. An unresolved contest is not closed by a later unrelated
      // write — without the second clause, a third non-contradicting decision
      // superseded and archived *both* sides of an open contest, which is the
      // exact outcome the veto exists to prevent.
      const contestedIds = new Set([
        ...conflicts.map(conflict => conflict.id),
        // Deliberately NOT scope-filtered, even though detection is. Auto-
        // supersede is scope-blind, so a decision written on one branch would
        // otherwise supersede — and therefore archive — one side of an open
        // contest on another branch, burying a question that branch has not
        // settled. Scoping this to the writer only looks symmetric with
        // detection; it hands an unrelated branch the power to close a contest.
        // The cost is that a contested note on another branch is never
        // auto-superseded, which is the conservative direction.
        ...priors.filter(prior => prior.conflict === 1).map(prior => prior.id),
      ]);

      if ((opts.kind === 'decision' || opts.kind === 'intent') && subject !== null) {
        supersededIds.push(
          ...priors
            .filter(prior => prior.kind === opts.kind && !contestedIds.has(prior.id))
            .map(prior => prior.id),
        );
        if (supersededIds.length > 0) {
          const placeholders = supersededIds.map(() => '?').join(', ');
          this.db
            .prepare(`UPDATE notes SET status = 'superseded' WHERE id IN (${placeholders})`)
            .run(...supersededIds);
        }
      }

      this.db
        .prepare(
          `INSERT INTO notes (id, session_id, timestamp, kind, subject, content, alternatives, status, conflict)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          opts.sessionId,
          now,
          opts.kind,
          subject,
          opts.content,
          alternativesJson,
          conflicts.length > 0 ? 1 : 0,
        );

      // Mark the prior side of each contested pair. `markConflict` re-syncs its
      // own memory item; the new note's projection is written below.
      for (const conflict of conflicts) {
        this.markConflict(conflict.id);
      }

      // Side effects for focus updates
      if (opts.kind === 'focus' && subject !== null) {
        this.updateSessionFocus(opts.sessionId, subject);
      } else if (opts.kind === 'intent' && subject !== null) {
        const session = this.getSession(opts.sessionId);
        if (session && session.focus === null) {
          this.updateSessionFocus(opts.sessionId, subject);
        }
      }

      for (const supersededId of supersededIds) {
        this.syncMemoryItemForNote(supersededId);
        // The status flip above is the transition, so the demotion happens
        // here and nowhere downstream (FR-4).
        this.demoteMemoryItemForNote(supersededId);
      }
      this.syncMemoryItemForNote(id);
      return { supersededIds, conflicts };
    });

    // `.immediate()`, not the default deferred mode. A deferred transaction
    // takes its write lock lazily, so a read-then-write that reads before a
    // concurrent writer commits fails the upgrade with SQLITE_BUSY_SNAPSHOT —
    // which bypasses the busy handler, so `busy_timeout` never applies. That
    // loses the veto *and* discards the note. IMMEDIATE takes the write lock up
    // front, so the second writer waits out `busy_timeout` instead.
    const { conflicts } = run.immediate();
    const note = this.getNote(id)!;
    return conflicts.length > 0 ? { ...note, conflicts } : note;
  }

  /** Scope key of a session, or null for an unscoped one. */
  private scopeKeyForSession(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT scope_key FROM sessions WHERE id = ?')
      .get(sessionId) as { scope_key: string | null } | undefined;
    return row?.scope_key ?? null;
  }

  getNote(id: string): ParsedNote | undefined {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE id = ?')
      .get(id) as NoteRow | undefined;
    return row ? parseNoteRow(row) : undefined;
  }

  getNotesBySession(sessionId: string): ParsedNote[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getActiveNotes(sessionId?: string): ParsedNote[] {
    if (sessionId !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE status = 'active' AND session_id = ? ORDER BY timestamp ASC`,
        )
        .all(sessionId) as NoteRow[];
      return rows.map(parseNoteRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE status = 'active' ORDER BY timestamp ASC`)
      .all() as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getActiveNotesByScope(scopeKey: string): ParsedNote[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
         INNER JOIN sessions s ON s.id = n.session_id
         WHERE n.status = 'active' AND s.scope_key = ?
         ORDER BY n.timestamp ASC`,
      )
      .all(scopeKey) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByKindAndSubject(kind: string, subject: string): ParsedNote[] {
    const normalizedSubject = subject.trim().toLowerCase();
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE kind = ? AND subject = ? ORDER BY timestamp ASC')
      .all(kind, normalizedSubject) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByStatus(status: string): ParsedNote[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE status = ? ORDER BY timestamp ASC')
      .all(status) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  getNotesByStatusAndScope(status: string, scopeKey: string): ParsedNote[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n
         INNER JOIN sessions s ON s.id = n.session_id
         WHERE n.status = ? AND s.scope_key = ?
         ORDER BY n.timestamp ASC`,
      )
      .all(status, scopeKey) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  updateNoteStatus(id: string, status: 'active' | 'superseded' | 'resolved'): void {
    // Transition-aware: a manual supersede (cortex_resolve) demotes exactly
    // like the automatic one, but writing 'superseded' onto an already-
    // superseded note is a re-assertion, not a transition, and must not step
    // the tier again (FR-4). One transaction for the same reason insertNote
    // uses one: two sessions share a database file, and a concurrent writer
    // between the read and the demote could double-step the tier or strand
    // the status flip without its demotion. Nested calls (the MCP resolve
    // flow) degrade to savepoints.
    const run = this.db.transaction(() => {
      const previous = this.getNote(id)?.status;
      this.db
        .prepare('UPDATE notes SET status = ? WHERE id = ?')
        .run(status, id);
      this.syncMemoryItemForNote(id);
      if (status === 'superseded' && previous !== 'superseded') {
        this.demoteMemoryItemForNote(id);
      }
    });
    run.immediate();
  }

  findActiveNoteBySubject(subject: string): ParsedNote | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM notes
         WHERE status = 'active' AND subject = ? COLLATE NOCASE
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(subject) as NoteRow | undefined;
    return row ? parseNoteRow(row) : undefined;
  }

  markConflict(id: string): void {
    this.db
      .prepare('UPDATE notes SET conflict = 1 WHERE id = ?')
      .run(id);
    this.syncMemoryItemForNote(id);
  }

  clearConflict(id: string): void {
    this.db
      .prepare('UPDATE notes SET conflict = 0 WHERE id = ?')
      .run(id);
    this.syncMemoryItemForNote(id);
  }

  /**
   * Close the contest on a subject once a side has been resolved.
   *
   * A contest is subject-scoped, so resolving one side settles it: every
   * remaining note on that subject drops its marker. Without this the flag was
   * write-only — `markConflict` was the column's only writer — so a resolved
   * pair kept rendering `[contested]` forever, `cortex_note`'s own advice to
   * "close it with cortex_resolve" was false, and SM-5's resolution rate was
   * unmeasurable because resolution left no trace. A later contradicting write
   * simply re-flags.
   */
  clearConflictsForSubject(subject: string, scopeKey: string | null): string[] {
    const normalized = subject.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT n.id FROM notes n
           INNER JOIN sessions s ON s.id = n.session_id
          WHERE n.subject = ? AND n.conflict = 1 AND s.scope_key IS ?`,
      )
      .all(normalized, scopeKey) as Array<{ id: string }>;
    for (const row of rows) {
      this.clearConflict(row.id);
    }
    return rows.map(row => row.id);
  }

  /**
   * Active notes on a subject, newest first. Deliberately scope-blind to match
   * `findActiveNoteBySubject`, which is what callers resolve through.
   */
  getActiveNotesBySubject(subject: string): ParsedNote[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notes
          WHERE subject = ? COLLATE NOCASE AND status = 'active'
          ORDER BY timestamp DESC`,
      )
      .all(subject.trim().toLowerCase()) as NoteRow[];
    return rows.map(parseNoteRow);
  }

  /** Scope key of the session that wrote a note, or null. */
  getScopeKeyForNote(noteId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT s.scope_key FROM notes n
           INNER JOIN sessions s ON s.id = n.session_id
          WHERE n.id = ?`,
      )
      .get(noteId) as { scope_key: string | null } | undefined;
    return row?.scope_key ?? null;
  }

  // ── State ─────────────────────────────────────────────────────────

  insertState(opts: InsertStateOpts): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sessionId = opts.layer === 'project' ? null : (opts.sessionId ?? null);
    this.db
      .prepare(
        `INSERT INTO state (id, session_id, layer, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, opts.layer, opts.content, now);

    if (opts.layer === 'project') {
      const scopeKey = this.getProjectScopeKey();
      if (scopeKey) {
        this.upsertProjectSnapshot({
          id,
          scopeKey,
          summary: opts.content,
          updatedAt: now,
        });
      }
    } else if (sessionId) {
      const scope = this.resolveSessionScope(sessionId);
      if (scope) {
        this.upsertMemoryItem({
          id: `state:${id}`,
          sessionId,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          kind: 'session_state',
          sourceTable: 'state',
          sourceId: id,
          text: opts.content,
          state: 'warm',
          importance: 0.68,
          createdAt: now,
        });
      }
    }

    return id;
  }

  getSessionState(sessionId: string): StateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM state
         WHERE session_id = ? AND layer = 'session'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as StateRow | undefined;
  }

  getProjectState(): StateRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM state
         WHERE layer = 'project' AND session_id IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as StateRow | undefined;
  }

  replaceProjectState(content: string): void {
    this.db.prepare(`DELETE FROM state WHERE layer = 'project' AND session_id IS NULL`).run();
    this.insertState({ layer: 'project', content });
  }

  getRecentStates(limit: number): StateRow[] {
    return this.db
      .prepare(
        `SELECT * FROM state WHERE layer = 'session' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as StateRow[];
  }

  getRecentStatesByScope(scopeKey: string, limit: number): StateRow[] {
    return this.db
      .prepare(
        `SELECT st.* FROM state st
         INNER JOIN sessions s ON s.id = st.session_id
         WHERE st.layer = 'session' AND s.scope_key = ?
         ORDER BY st.created_at DESC LIMIT ?`,
      )
      .all(scopeKey, limit) as StateRow[];
  }

  getBranchSnapshot(scopeKey: string): BranchSnapshotRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM branch_snapshots WHERE scope_key = ?')
      .get(scopeKey) as
      | {
          id: string;
          scope_key: string;
          git_root: string | null;
          worktree_path: string | null;
          branch_ref: string | null;
          head_oid: string | null;
          focus: string | null;
          summary: string;
          recent_files_json: string | null;
          intents_json: string | null;
          blockers_json: string | null;
          last_session_id: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      scope_key: row.scope_key,
      git_root: row.git_root,
      worktree_path: row.worktree_path,
      branch_ref: row.branch_ref,
      head_oid: row.head_oid,
      focus: row.focus,
      summary: row.summary,
      recent_files: parseJsonStringArray(row.recent_files_json),
      intents: parseJsonStringArray(row.intents_json),
      blockers: parseJsonStringArray(row.blockers_json),
      last_session_id: row.last_session_id,
      updated_at: row.updated_at,
    };
  }

  upsertBranchSnapshot(opts: UpsertBranchSnapshotOpts): BranchSnapshotRow {
    const existing = this.getBranchSnapshot(opts.scopeKey);
    const id = existing?.id ?? crypto.randomUUID();
    const updatedAt = opts.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO branch_snapshots (
           id,
           scope_key,
           git_root,
           worktree_path,
           branch_ref,
           head_oid,
           focus,
           summary,
           recent_files_json,
           intents_json,
           blockers_json,
           last_session_id,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           git_root = excluded.git_root,
           worktree_path = excluded.worktree_path,
           branch_ref = excluded.branch_ref,
           head_oid = excluded.head_oid,
           focus = excluded.focus,
           summary = excluded.summary,
           recent_files_json = excluded.recent_files_json,
           intents_json = excluded.intents_json,
           blockers_json = excluded.blockers_json,
           last_session_id = excluded.last_session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        opts.scopeKey,
        opts.gitRoot ?? null,
        opts.worktreePath ?? null,
        opts.branchRef ?? null,
        opts.headOid ?? null,
        opts.focus ?? null,
        opts.summary,
        JSON.stringify(opts.recentFiles ?? []),
        JSON.stringify(opts.intents ?? []),
        JSON.stringify(opts.blockers ?? []),
        opts.lastSessionId ?? null,
        updatedAt,
      );

    const snapshot = this.getBranchSnapshot(opts.scopeKey)!;
    this.syncMemoryItemForBranchSnapshot(opts.scopeKey);
    return snapshot;
  }

  getProjectSnapshot(scopeKey: string): ProjectSnapshotRow | undefined {
    return this.db
      .prepare('SELECT * FROM project_snapshots WHERE scope_key = ?')
      .get(scopeKey) as ProjectSnapshotRow | undefined;
  }

  upsertProjectSnapshot(opts: UpsertProjectSnapshotOpts): ProjectSnapshotRow {
    const existing = this.getProjectSnapshot(opts.scopeKey);
    const id = opts.id ?? existing?.id ?? crypto.randomUUID();
    const updatedAt = opts.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO project_snapshots (
           id,
           git_root,
           scope_key,
           summary,
           note_digest,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           id = excluded.id,
           git_root = excluded.git_root,
           summary = excluded.summary,
           note_digest = excluded.note_digest,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        opts.gitRoot ?? null,
        opts.scopeKey,
        opts.summary,
        opts.noteDigest ?? null,
        updatedAt,
      );

    const snapshot = this.getProjectSnapshot(opts.scopeKey)!;
    this.syncMemoryItemForProjectSnapshot(opts.scopeKey);
    return snapshot;
  }

  upsertMemoryItem(opts: UpsertMemoryItemOpts): ParsedMemoryItem {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_items (
           id,
           session_id,
           scope_type,
           scope_key,
           kind,
           source_table,
           source_id,
           subject,
           text,
           state,
           importance,
           access_count,
           last_accessed_at,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           scope_type = excluded.scope_type,
           scope_key = excluded.scope_key,
           kind = excluded.kind,
           source_table = excluded.source_table,
           source_id = excluded.source_id,
           subject = excluded.subject,
           text = excluded.text,
           state = excluded.state,
           importance = excluded.importance,
           access_count = excluded.access_count,
           last_accessed_at = excluded.last_accessed_at,
           created_at = excluded.created_at`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.scopeType,
        opts.scopeKey,
        opts.kind,
        opts.sourceTable ?? null,
        opts.sourceId ?? null,
        opts.subject ?? null,
        opts.text,
        opts.state ?? 'warm',
        opts.importance ?? 0,
        opts.accessCount ?? 0,
        opts.lastAccessedAt ?? null,
        createdAt,
      );

    this.replaceMemoryReferences(
      id,
      extractMemoryReferences(opts.subject, opts.text),
    );

    return this.getMemoryItem(id)!;
  }

  upsertMemoryItemSemantic(opts: UpsertMemoryItemSemanticOpts): ParsedMemoryItemSemantic {
    const updatedAt = opts.updatedAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_item_semantics (
           memory_item_id,
           summary,
           concepts_json,
           entities_json,
           embedding_model,
           embedding_json,
           source_hash,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_item_id) DO UPDATE SET
           summary = excluded.summary,
           concepts_json = excluded.concepts_json,
           entities_json = excluded.entities_json,
           embedding_model = excluded.embedding_model,
           embedding_json = excluded.embedding_json,
           source_hash = excluded.source_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        opts.memoryItemId,
        opts.summary,
        JSON.stringify(opts.concepts ?? []),
        JSON.stringify(opts.entities ?? []),
        opts.embeddingModel,
        JSON.stringify(opts.embedding),
        opts.sourceHash,
        updatedAt,
      );

    return this.getMemoryItemSemantic(opts.memoryItemId)!;
  }

  getMemoryItem(id: string): ParsedMemoryItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryItemRow | undefined;
    return row ? parseMemoryItemRow(row) : undefined;
  }

  getMemoryItemSemantic(memoryItemId: string): ParsedMemoryItemSemantic | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_item_semantics WHERE memory_item_id = ?')
      .get(memoryItemId) as MemoryItemSemanticRow | undefined;
    return row ? parseMemoryItemSemanticRow(row) : undefined;
  }

  upsertCurrentAppGraph(opts: UpsertCurrentAppGraphOpts): ParsedCurrentAppGraph {
    const updatedAt = opts.updatedAt ?? new Date().toISOString();
    const files = Array.from(new Set(opts.files)).sort();

    this.db
      .prepare(
        `INSERT INTO current_app_graphs (
           scope_key,
           scope_type,
           git_root,
           worktree_path,
           branch_ref,
           head_oid,
           files_json,
           file_count,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           scope_type = excluded.scope_type,
           git_root = excluded.git_root,
           worktree_path = excluded.worktree_path,
           branch_ref = excluded.branch_ref,
           head_oid = excluded.head_oid,
           files_json = excluded.files_json,
           file_count = excluded.file_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        opts.scopeKey,
        opts.scopeType,
        opts.gitRoot ?? null,
        opts.worktreePath ?? null,
        opts.branchRef ?? null,
        opts.headOid ?? null,
        JSON.stringify(files),
        files.length,
        updatedAt,
      );

    return this.getCurrentAppGraph(opts.scopeKey)!;
  }

  getCurrentAppGraph(scopeKey: string): ParsedCurrentAppGraph | undefined {
    const row = this.db
      .prepare('SELECT * FROM current_app_graphs WHERE scope_key = ?')
      .get(scopeKey) as CurrentAppGraphRow | undefined;
    return row ? parseCurrentAppGraphRow(row) : undefined;
  }

  replaceMemoryReferences(
    memoryItemId: string,
    references: UpsertMemoryReferenceOpts[],
  ): ParsedMemoryReference[] {
    const deleteExisting = this.db.prepare(
      'DELETE FROM memory_references WHERE memory_item_id = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO memory_references (
         id,
         memory_item_id,
         reference_type,
         raw_reference,
         normalized_path,
         status,
         checked_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((refs: UpsertMemoryReferenceOpts[]) => {
      deleteExisting.run(memoryItemId);
      for (const ref of refs) {
        insert.run(
          crypto.randomUUID(),
          memoryItemId,
          ref.referenceType,
          ref.rawReference,
          ref.normalizedPath,
          ref.status ?? 'unknown',
          ref.checkedAt ?? null,
        );
      }
    });

    tx(references);
    return this.getMemoryReferences(memoryItemId);
  }

  getMemoryReferences(memoryItemId: string): ParsedMemoryReference[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_references
         WHERE memory_item_id = ?
         ORDER BY rowid ASC`,
      )
      .all(memoryItemId) as MemoryReferenceRow[];
    return rows.map(parseMemoryReferenceRow);
  }

  getMemoryReferencesForItems(memoryItemIds: string[]): Map<string, ParsedMemoryReference[]> {
    const byId = new Map<string, ParsedMemoryReference[]>();
    if (memoryItemIds.length === 0) {
      return byId;
    }

    const placeholders = memoryItemIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_references
         WHERE memory_item_id IN (${placeholders})
         ORDER BY rowid ASC`,
      )
      .all(...memoryItemIds) as MemoryReferenceRow[];

    for (const row of rows.map(parseMemoryReferenceRow)) {
      const refs = byId.get(row.memory_item_id) ?? [];
      refs.push(row);
      byId.set(row.memory_item_id, refs);
    }
    return byId;
  }

  updateMemoryReferenceStatuses(
    updates: Array<{ id: string; status: MemoryReferenceStatus; checkedAt?: string; movedTo?: string | null }>,
  ): void {
    if (updates.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `UPDATE memory_references
       SET status = ?, checked_at = ?, moved_to = ?
       WHERE id = ?`,
    );
    const tx = this.db.transaction(
      (items: Array<{ id: string; status: MemoryReferenceStatus; checkedAt?: string; movedTo?: string | null }>) => {
        const now = new Date().toISOString();
        for (const update of items) {
          stmt.run(update.status, update.checkedAt ?? now, update.movedTo ?? null, update.id);
        }
      },
    );
    tx(updates);
  }

  // ── File renames ──────────────────────────────────────────────────

  insertFileRenames(opts: {
    scopeKey: string;
    renames: Array<{ oldPath: string; newPath: string }>;
    headOid?: string | null;
    detectedAt?: string;
  }): number {
    if (opts.renames.length === 0) {
      return 0;
    }

    const stmt = this.db.prepare(
      `INSERT INTO file_renames (id, scope_key, old_path, new_path, head_oid, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_key, old_path)
       DO UPDATE SET new_path = excluded.new_path,
                     head_oid = excluded.head_oid,
                     detected_at = excluded.detected_at`,
    );
    const detectedAt = opts.detectedAt ?? new Date().toISOString();
    const tx = this.db.transaction((renames: Array<{ oldPath: string; newPath: string }>) => {
      for (const rename of renames) {
        if (rename.oldPath === rename.newPath) {
          continue;
        }
        stmt.run(
          crypto.randomUUID(),
          opts.scopeKey,
          rename.oldPath,
          rename.newPath,
          opts.headOid ?? null,
          detectedAt,
        );
      }
    });
    tx(opts.renames);
    return opts.renames.length;
  }

  /** Follow the rename chain for a path within a scope (a -> b -> c resolves to c). */
  resolveFileRename(scopeKey: string, oldPath: string, maxHops = 5): string | null {
    const stmt = this.db.prepare(
      `SELECT new_path FROM file_renames WHERE scope_key = ? AND old_path = ?`,
    );

    let current = oldPath;
    let resolved: string | null = null;
    for (let hop = 0; hop < maxHops; hop++) {
      const row = stmt.get(scopeKey, current) as { new_path: string } | undefined;
      if (!row || row.new_path === current) {
        break;
      }
      resolved = row.new_path;
      current = row.new_path;
    }

    return resolved;
  }

  getFileRenames(scopeKey: string): FileRenameRow[] {
    return this.db
      .prepare(
        `SELECT * FROM file_renames WHERE scope_key = ? ORDER BY detected_at ASC, rowid ASC`,
      )
      .all(scopeKey) as FileRenameRow[];
  }

  getMemoryItemBySource(sourceTable: string, sourceId: string): ParsedMemoryItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE source_table = ? AND source_id = ?
         LIMIT 1`,
      )
      .get(sourceTable, sourceId) as MemoryItemRow | undefined;
    return row ? parseMemoryItemRow(row) : undefined;
  }

  listMemoryItemsByScopes(
    scopeKeys: string[],
    limit: number = 100,
    includeArchived: boolean = false,
  ): ParsedMemoryItem[] {
    if (scopeKeys.length === 0) {
      return [];
    }

    const placeholders = scopeKeys.map(() => '?').join(', ');
    const archivedClause = includeArchived ? '' : "AND state != 'archived'";
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE scope_key IN (${placeholders})
           ${archivedClause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...scopeKeys, limit) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  /**
   * Memory items matching every supplied filter, newest first (FR-21).
   *
   * Deliberately unlike `listMemoryItemsByScopes`, which hard-excludes
   * `archived`: this is the inspection path, and a listing that hides rows
   * cannot answer "what does Cortex actually hold". Callers narrow explicitly.
   *
   * `rowid DESC` is not decoration. Seeding and same-transaction projection
   * produce items sharing `created_at` to the millisecond, and `LIMIT`/`OFFSET`
   * over a non-total order silently repeats some rows and skips others.
   */
  listMemoryItemsFiltered(opts: ListMemoryItemsOpts = {}): ParsedMemoryItem[] {
    const { sql, params } = buildMemoryItemFilterClause(opts);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         ${sql}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
      )
      // LIMIT -1 is SQLite's "no limit", so an absent limit still supports OFFSET.
      .all(...params, opts.limit ?? -1, opts.offset ?? 0) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  /** How many items the same filter matches, ignoring limit/offset. */
  countMemoryItemsFiltered(filter: MemoryItemFilter = {}): number {
    const { sql, params } = buildMemoryItemFilterClause(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM memory_items ${sql}`)
      .get(...params) as { count: number };
    return row.count;
  }

  /**
   * Retrievals that returned this memory item, newest first (FR-21).
   *
   * `result_ids_json` is a JSON array, so the match goes through `json_each`
   * rather than `LIKE '%id%'` — a substring scan matches any id that merely
   * *contains* this one, and every id here is caller-supplied.
   *
   * Guarding malformed rows is load-bearing, not defensive noise: `json_each`
   * over a malformed or NULL value raises, and the raise takes the whole query
   * with it rather than skipping the row — one bad row would make access
   * history unreadable for every item in the store. The guard is applied
   * *inside* `json_each`'s argument rather than as a sibling `AND` term,
   * because SQLite does not contractually fix the evaluation order of WHERE
   * conjuncts; substituting an empty array cannot be reordered away.
   */
  getRetrievalLogsForItem(memoryItemId: string, limit: number): ParsedRetrievalLog[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM retrieval_log
         WHERE EXISTS (
           SELECT 1 FROM json_each(
             CASE WHEN json_valid(retrieval_log.result_ids_json)
                  THEN retrieval_log.result_ids_json
                  ELSE '[]' END
           )
            WHERE json_each.value = ?
         )
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(memoryItemId, limit) as RetrievalLogRow[];
    return rows.map(parseRetrievalLogRow);
  }

  searchMemoryItems(queryText: string, limit: number): SearchMemoryItemResult[] {
    const rows = this.db
      .prepare(
        `SELECT mi.*, bm25(memory_items_fts, 8.0, 1.5) as fts_rank
         FROM memory_items_fts
         INNER JOIN memory_items mi ON mi.rowid = memory_items_fts.rowid
         WHERE memory_items_fts MATCH ?
           AND mi.state != 'archived'
         ORDER BY fts_rank ASC, mi.importance DESC, mi.created_at DESC
         LIMIT ?`,
      )
      .all(queryText, limit) as Array<MemoryItemRow & { fts_rank: number }>;

    return rows.map(row => ({
      ...parseMemoryItemRow(row),
      fts_rank: row.fts_rank,
    }));
  }

  searchMemoryItemSemantics(
    embedding: number[],
    limit: number,
    embeddingModel?: string,
  ): SemanticMemoryItemResult[] {
    const modelClause = embeddingModel ? 'AND mis.embedding_model = ?' : '';
    const params = embeddingModel ? [embeddingModel] : [];
    const rows = this.db
      .prepare(
        `SELECT mi.*, mis.*
         FROM memory_item_semantics mis
         INNER JOIN memory_items mi ON mi.id = mis.memory_item_id
         WHERE mi.state != 'archived'
           ${modelClause}
         ORDER BY mi.importance DESC, mi.created_at DESC`,
      )
      .all(...params) as Array<MemoryItemRow & MemoryItemSemanticRow>;

    return rows
      .map(row => {
        const semantic = parseMemoryItemSemanticRow(row);
        return {
          ...parseMemoryItemRow(row),
          semantic_score: cosineSimilarity(embedding, semantic.embedding),
          semantic,
        };
      })
      .filter(item => item.semantic_score > 0)
      .sort((left, right) => {
        if (right.semantic_score !== left.semantic_score) {
          return right.semantic_score - left.semantic_score;
        }
        if (right.importance !== left.importance) {
          return right.importance - left.importance;
        }
        return right.created_at.localeCompare(left.created_at);
      })
      .slice(0, limit);
  }

  listRecentMemoryItems(limit: number): ParsedMemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE state != 'archived'
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  updateMemoryItemStates(items: UpdateMemoryItemStateOpts[]): void {
    if (items.length === 0) {
      return;
    }

    const update = this.db.prepare(
      `UPDATE memory_items
       SET state = ?
       WHERE id = ?`,
    );

    const tx = this.db.transaction((updates: UpdateMemoryItemStateOpts[]) => {
      for (const item of updates) {
        update.run(item.state, item.id);
      }
    });

    tx(items);
  }

  touchMemoryItems(ids: string[], touchedAt: string = new Date().toISOString()): void {
    const touch = this.db.prepare(
      `UPDATE memory_items
       SET access_count = access_count + 1,
           last_accessed_at = ?,
           state = CASE
             WHEN state IN ('pinned', 'archived') THEN state
             WHEN EXISTS (
               SELECT 1 FROM memory_references
               WHERE memory_item_id = memory_items.id AND status = 'missing'
             ) THEN state
             WHEN lower(text) LIKE '%status: resolved%' THEN 'cold'
             -- Superseded items are never reheated by access (FR-4): the state
             -- is preserved here and the derive layer caps reinforcement at
             -- warm. LIKE is substring, not line-exact — same pre-existing
             -- divergence the resolved branch above carries.
             WHEN lower(text) LIKE '%status: superseded%' THEN state
             ELSE 'hot'
           END
       WHERE id = ?`,
    );

    const tx = this.db.transaction((memoryIds: string[]) => {
      for (const id of memoryIds) {
        touch.run(touchedAt, id);
      }
    });

    tx(ids);
  }

  insertRetrievalLog(opts: InsertRetrievalLogOpts): ParsedRetrievalLog {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO retrieval_log (
           id,
           session_id,
           topic,
           query_text,
           result_ids_json,
           total_candidates,
           returned_count,
           token_estimate,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.topic,
        opts.queryText ?? null,
        JSON.stringify(opts.resultIds ?? []),
        opts.totalCandidates ?? 0,
        opts.returnedCount ?? 0,
        opts.tokenEstimate ?? 0,
        createdAt,
      );

    return this.getRetrievalLog(id)!;
  }

  getRetrievalLog(id: string): ParsedRetrievalLog | undefined {
    const row = this.db
      .prepare('SELECT * FROM retrieval_log WHERE id = ?')
      .get(id) as RetrievalLogRow | undefined;
    return row ? parseRetrievalLogRow(row) : undefined;
  }

  getRetrievalLogsBySession(sessionId: string): ParsedRetrievalLog[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM retrieval_log
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as RetrievalLogRow[];
    return rows.map(parseRetrievalLogRow);
  }

  // ── Token Ledger ──────────────────────────────────────────────────

  /**
   * Write one ledger row.
   *
   * **A credit without evidence is refused, not silently written** (AC #3).
   * Before Story 3.5 the only `saved` producer in the codebase was
   * `writeSessionSummary`, computing
   * `estimateTokens(JSON.stringify(events)) - estimateTokens(summary)` — the
   * difference between a summary and pasting every captured event as raw JSON,
   * against a baseline no one would ever have paid. That single line was the
   * whole of the 657.6k "Saved" and the 93% "Efficiency" the product displayed.
   * A ledger whose credit side cannot be checked is worse than no ledger,
   * because it is quoted.
   *
   * Enforced here rather than by a table CHECK: this method is the single write
   * path (seven call sites, all through it), and adding a CHECK to a populated
   * table means a full rebuild in SQLite. Stated because it is a real
   * trade-off — a hand-written INSERT bypasses this guard, and nothing at the
   * storage layer would stop it.
   */
  insertLedgerEntry(opts: InsertLedgerOpts): void {
    // Validated for EVERY direction, not just credit. `injected` was unguarded,
    // so `tokens: Infinity` was accepted and then made `Net` and `Efficiency`
    // both `NaN` in `cortex stats` — a guard asymmetry with no reason behind it.
    if (!LEDGER_DIRECTIONS.has(opts.direction)) {
      // A direction outside the four contributes to none of `getTotalTokens`'
      // four sums while still sitting in the table and being rolled up by GC,
      // so the P&L silently stops reconciling against `SUM(tokens)`.
      throw new Error(`unknown ledger direction '${opts.direction}'`);
    }
    if (!Number.isSafeInteger(opts.tokens) || opts.tokens < 0) {
      throw new Error(`ledger row requires a whole non-negative token count, got ${opts.tokens}`);
    }
    if (opts.direction === 'saved' || opts.direction === 'unrealized') {
      assertCreditIsEvidenced(opts);
    }
    const id = opts.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO token_ledger
           (id, session_id, type, direction, tokens, timestamp,
            evidence_kind, evidence_ref, evidence_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId,
        opts.type,
        opts.direction,
        opts.tokens,
        now,
        opts.evidence?.kind ?? null,
        opts.evidence?.ref ?? null,
        opts.evidence?.size ?? null,
      );
  }

  /**
   * Record that Cortex told a session it already has this file's content.
   *
   * **An offer is pending state, not an accounting fact, and that distinction
   * is the whole of AC #6.** Written into `token_ledger` as an `unrealized`
   * row — as this did briefly — an offer counted as adoption failure the
   * instant it was *made*: an agent that adopted every offer scored identically
   * to one that ignored every offer, and the figure rendered "offered, not
   * taken" actually meant "offered". It also forced a DELETE on consumption,
   * against AD-8's "every ledger row is append-only".
   *
   * Keyed on `(session_id, scope_key, path)` and upserted, so asking the same
   * question five times leaves one offer rather than five — otherwise following
   * the documented best practice ("ask before re-reading") would monotonically
   * inflate the adoption-failure metric.
   */
  upsertReadOffer(opts: {
    sessionId: string;
    scopeKey: string;
    path: string;
    byteSize: number;
    tokens: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO read_offers (session_id, scope_key, path, byte_size, tokens, offered_at)
         VALUES (:sessionId, :scopeKey, :path, :byteSize, :tokens, :offeredAt)
         ON CONFLICT(session_id, scope_key, path) DO UPDATE SET
           byte_size  = excluded.byte_size,
           tokens     = excluded.tokens,
           offered_at = excluded.offered_at`,
      )
      .run({
        sessionId: opts.sessionId,
        scopeKey: opts.scopeKey,
        path: opts.path,
        byteSize: opts.byteSize,
        tokens: opts.tokens,
        offeredAt: new Date().toISOString(),
      });
  }

  /**
   * Consume an open offer for this file and book the decline, atomically.
   *
   * Returns the `unrealized` row's evidence, or null when no offer was open —
   * in which case nothing is recorded, because a read Cortex never offered to
   * save is not a declined offer.
   *
   * **The consume and the booking are one transaction.** As two statements, a
   * failure between them destroyed the offer and recorded nothing — silently
   * losing the exact fact AC #6 exists to capture. This runs on `hook-entry
   * post` and `cli log read`, where nothing else wraps it.
   *
   * **Matched across the session's ancestry, not just the exact session.** The
   * offer is made to whichever session called the tool — always the primary,
   * since `cortex_read_ledger` resolves without an agent id — while a
   * subagent's Read replays under its own child session. Filtering on equality
   * meant a delegated read could never be seen as a decline, and delegated work
   * is the majority of tool calls. The ancestry rule is AD-16's, reused: a read
   * by you or by a descendant answers an offer made to you.
   */
  consumeReadOffer(
    sessionId: string,
    scopeKey: string,
    filePath: string,
    withinMs = 60 * 60 * 1000,
  ): { path: string; byteSize: number; tokens: number } | null {
    const key = toScopeRelativeKey(filePath, this.scopeRootFor(scopeKey));
    const now = Date.now();
    const since = new Date(now - withinMs).toISOString();
    // Bounded at BOTH ends. A future-dated offer — a clock jump, or a store
    // carried between machines — was consumable indefinitely, because only the
    // lower bound was checked. A small skew allowance keeps an offer written
    // milliseconds ago from failing its own upper bound.
    const until = new Date(now + 60 * 1000).toISOString();
    const ancestry = this.getSessionAncestorIds(sessionId);
    const placeholders = ancestry.map(() => '?').join(', ');

    return this.runInImmediateTransaction(() => {
      const row = this.db
        .prepare(
          `SELECT session_id, path, byte_size, tokens
             FROM read_offers
            WHERE session_id IN (${placeholders})
              AND scope_key = ? AND path = ?
              AND offered_at >= ? AND offered_at <= ?
            ORDER BY offered_at DESC
            LIMIT 1`,
        )
        .get(...ancestry, scopeKey, key, since, until) as
        | { session_id: string; path: string; byte_size: number; tokens: number }
        | undefined;
      if (!row) {
        return null;
      }
      this.db
        .prepare('DELETE FROM read_offers WHERE session_id = ? AND scope_key = ? AND path = ?')
        .run(row.session_id, scopeKey, row.path);
      return { path: row.path, byteSize: row.byte_size, tokens: row.tokens };
    });
  }

  /** Offers that expired unconsumed. Never counted — an unread offer is not a decline. */
  pruneExpiredReadOffers(withinMs = 60 * 60 * 1000): number {
    const since = new Date(Date.now() - withinMs).toISOString();
    return this.db.prepare('DELETE FROM read_offers WHERE offered_at < ?').run(since).changes;
  }

  getLedgerBySession(sessionId: string): LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM token_ledger WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as LedgerRow[];
  }

  /**
   * Ledger totals, by direction.
   *
   * `spent` is retained as the field name for `injected` so existing readers
   * keep compiling; `estimated` and `unrealized` are reported separately and
   * are deliberately **not** folded into `saved`. Folding them is the whole
   * failure this story corrects — a credit that cannot be evidenced, added to
   * one that can, produces a headline number nobody can check.
   */
  getTotalTokens(): { spent: number; saved: number; unrealized: number; estimated: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN direction = 'injected'   THEN tokens ELSE 0 END) as spent,
           SUM(CASE WHEN direction = 'saved'      THEN tokens ELSE 0 END) as saved,
           SUM(CASE WHEN direction = 'unrealized' THEN tokens ELSE 0 END) as unrealized,
           SUM(CASE WHEN direction = 'estimated'  THEN tokens ELSE 0 END) as estimated
         FROM token_ledger`,
      )
      .get() as {
      spent: number | null;
      saved: number | null;
      unrealized: number | null;
      estimated: number | null;
    };
    return {
      spent: row.spent ?? 0,
      saved: row.saved ?? 0,
      unrealized: row.unrealized ?? 0,
      estimated: row.estimated ?? 0,
    };
  }

  /**
   * Totals plus a per-type breakdown.
   *
   * `byType` carries all four directions. It carried only `spent`/`saved`, so
   * `unrealized` and `estimated` rows fell out of it entirely — a consumer
   * would have under-reported without any indication that rows were missing.
   */
  getLedgerStats(): {
    spent: number;
    saved: number;
    unrealized: number;
    estimated: number;
    byType: Record<string, LedgerTypeTotals>;
  } {
    const totals = this.getTotalTokens();
    const rows = this.db
      .prepare(
        `SELECT type, direction, SUM(tokens) as total
         FROM token_ledger
         GROUP BY type, direction`,
      )
      .all() as { type: string; direction: string; total: number }[];

    const byType: Record<string, LedgerTypeTotals> = {};
    for (const row of rows) {
      if (!byType[row.type]) {
        byType[row.type] = { spent: 0, saved: 0, unrealized: 0, estimated: 0 };
      }
      if (row.direction === 'injected') {
        byType[row.type]!.spent = row.total;
      } else if (row.direction === 'saved') {
        byType[row.type]!.saved = row.total;
      } else if (row.direction === 'unrealized') {
        byType[row.type]!.unrealized = row.total;
      } else if (row.direction === 'estimated') {
        byType[row.type]!.estimated = row.total;
      }
    }

    return { ...totals, byType };
  }

  // ── FR-9 reporting reads (Story 3.6) ──────────────────────────────
  //
  // All read-only: `cortex stats` must not create sessions, touch items, or
  // book ledger rows by being used (the FR-21 rule, binding hardest on a
  // reporting surface).

  /**
   * Per-session, per-direction ledger sums for an explicit session list —
   * the FR-9 session block, called with a primary's tree
   * (`getSessionTreeIds`). Returning rows rather than folded totals lets the
   * caller both total the tree and see whether any child contributed.
   */
  getSessionLedgerTotals(sessionIds: string[]): SessionLedgerTotalRow[] {
    if (sessionIds.length === 0) {
      // Measured: SQLite 3.51.3 accepts `IN ()` and matches nothing, so this
      // guard is belt-and-braces, not load-bearing — kept because the
      // empty-list contract should not depend on a parser extension older
      // SQLite builds reject. Its mutation is equivalent here by measurement.
      return [];
    }
    const placeholders = sessionIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT session_id, direction, SUM(tokens) as tokens
           FROM token_ledger
          WHERE session_id IN (${placeholders})
          GROUP BY session_id, direction`,
      )
      .all(...sessionIds) as SessionLedgerTotalRow[];
  }

  /**
   * Cumulative ledger sums for a set of scope keys (FR-9's "cumulatively for
   * the scope"). The ledger carries no scope column, so attribution joins
   * through `sessions`; children inherit their primary's scope_key (Epic 0)
   * and GC rollups keep their session_id, so both stay inside the total. A
   * row whose session is gone drops out — an undercount, the direction FR-9's
   * PM note prefers ("over-reporting is fatal"); nothing deletes sessions
   * today.
   */
  getScopeTokenTotals(scopeKeys: string[]): LedgerDirectionTotals {
    if (scopeKeys.length === 0) {
      return foldLedgerDirectionTotals([]);
    }
    const placeholders = scopeKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT tl.direction as direction, SUM(tl.tokens) as tokens
           FROM token_ledger tl
           JOIN sessions s ON s.id = tl.session_id
          WHERE s.scope_key IN (${placeholders})
          GROUP BY tl.direction`,
      )
      .all(...scopeKeys) as Array<{ direction: string; tokens: number }>;
    return foldLedgerDirectionTotals(rows);
  }

  /**
   * Ledger rows no scope view can reach: sessions whose `scope_key` is NULL
   * (the column was added by migration with no backfill, so pre-scope stores
   * hold such sessions) and rows whose session row is gone. The scope join
   * drops both silently — an undercount, safe for the ratio, but the
   * `estimated` history FR-8 promised to keep visible would vanish from every
   * surface without this. Measured 0 on this repo's store; the query exists
   * for the stores where it is not.
   */
  getUnattributedTokenTotals(): LedgerDirectionTotals {
    const rows = this.db
      .prepare(
        `SELECT tl.direction as direction, SUM(tl.tokens) as tokens
           FROM token_ledger tl
           LEFT JOIN sessions s ON s.id = tl.session_id
          WHERE s.id IS NULL OR s.scope_key IS NULL
          GROUP BY tl.direction`,
      )
      .all() as Array<{ direction: string; tokens: number }>;
    return foldLedgerDirectionTotals(rows);
  }

  /** Item counts by state, store-wide (FR-9 retrieval health; D5). */
  getMemoryItemStateCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) as count FROM memory_items GROUP BY state')
      .all() as Array<{ state: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  /**
   * Items retrieval has never reinforced. `access_count` is bumped only by
   * `touchMemoryItems` and preserved by every re-sync path (FR-22), so zero
   * means exactly "never retrieved".
   */
  countNeverRetrievedMemoryItems(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM memory_items WHERE access_count = 0')
      .get() as { count: number };
    return row.count;
  }

  /**
   * The most-retrieved items, store-wide. `access_count > 0` because padding
   * a "most-retrieved" list with never-retrieved rows fabricates retrieval
   * history. The tiebreakers are load-bearing: seeded and same-transaction
   * rows share timestamps to the millisecond, and an unstable order over a
   * partial order silently reshuffles between runs (the FR-21 paging lesson).
   */
  getMostRetrievedMemoryItems(limit: number): ParsedMemoryItem[] {
    // Public API, so the limit is clamped here rather than trusted: SQLite
    // reads a negative LIMIT as *no limit* — the exact whole-store dump the
    // FR-21 paging work guards against — and better-sqlite3 throws raw on
    // NaN. Non-finite and non-positive fall back to ten (the FR-9 constant);
    // 200 mirrors MAX_PAGE_LIMIT.
    const clamped =
      Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 10;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE access_count > 0
          ORDER BY access_count DESC, last_accessed_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(clamped) as MemoryItemRow[];
    return rows.map(parseMemoryItemRow);
  }

  // ── Correction and deletion (FR-22) ───────────────────────────────

  recordMemoryCorrection(opts: RecordMemoryCorrectionOpts): ParsedMemoryCorrection {
    const id = opts.id ?? crypto.randomUUID();
    const createdAt = opts.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_corrections (
           id, memory_item_id, source_table, source_id, scope_key,
           operation, prior_text, new_text, prior_subject, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.memoryItemId,
        opts.sourceTable ?? null,
        opts.sourceId ?? null,
        opts.scopeKey ?? null,
        opts.operation,
        opts.priorText,
        opts.newText ?? null,
        opts.priorSubject ?? null,
        createdAt,
      );

    return this.db
      .prepare('SELECT * FROM memory_corrections WHERE id = ?')
      .get(id) as ParsedMemoryCorrection;
  }

  /** Corrections recorded against an item, newest first. Outlives the item. */
  getMemoryCorrections(memoryItemId: string): ParsedMemoryCorrection[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_corrections
          WHERE memory_item_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(memoryItemId) as ParsedMemoryCorrection[];
  }

  /**
   * Replace an item's text and re-derive everything that hangs off it (FR-22).
   *
   * A note-backed item is corrected **through its note**: `notes.content` is
   * updated and the existing projection rebuilds the item, so the trailer
   * (`Subject:` / `Alternatives:` / `Conflict:` / `Status:`) stays consistent
   * with the columns it mirrors. Patching `memory_items.text` directly instead
   * would desynchronise the two — the exact drift `inspect-memory` reports as
   * `diverged`, introduced by the command meant to repair memory.
   *
   * Access counters and state are deliberately preserved: a correction is not
   * a new memory, and reheating one as a side effect of fixing a typo would
   * change retrieval ranking for a reason the user never asked for.
   */
  /**
   * The text a correction command reads and writes for an item: a note-backed
   * item is edited through `notes.content`, everything else through
   * `memory_items.text`. Keeps `prior_text` round-trippable.
   */
  private editableTextFor(item: ParsedMemoryItem): string {
    if (item.source_table === 'notes' && item.source_id) {
      return this.getNote(item.source_id)?.content ?? item.text;
    }

    return item.text;
  }

  updateMemoryItemText(id: string, text: string): boolean {
    return this.runInImmediateTransaction(() => {
      const item = this.getMemoryItem(id);
      if (!item) {
        return false;
      }

      // Inside the transaction: "recorded in an audit trail" is only true if
      // the record cannot survive a correction that rolled back, or vice versa.
      //
      // `prior_text` records the value `edit-memory` *consumes*, not the
      // projection it produces — for a note-backed item those differ by the
      // kind prefix and the appended trailer, so recording `item.text` would
      // make the audit row unreplayable: feeding it back doubles both.
      this.recordMemoryCorrection({
        memoryItemId: item.id,
        sourceTable: item.source_table,
        sourceId: item.source_id,
        scopeKey: item.scope_key,
        operation: 'edit',
        priorText: this.editableTextFor(item),
        newText: text,
        priorSubject: item.subject,
      });

      if (item.source_table === 'notes' && item.source_id && this.getNote(item.source_id)) {
        this.db
          .prepare('UPDATE notes SET content = ? WHERE id = ?')
          .run(text, item.source_id);
        this.syncMemoryItemForNote(item.source_id);
        return true;
      }

      this.db.prepare('UPDATE memory_items SET text = ? WHERE id = ?').run(text, id);
      this.replaceMemoryReferences(id, extractMemoryReferences(item.subject, text));
      return true;
    });
  }

  /**
   * Delete a memory item, its source row, and everything derived from it —
   * in one transaction (FR-22).
   *
   * Deleting the `memory_items` row alone is not a deletion. `backfillMemoryItems`
   * re-inserts from `notes`, `episodes`, `project_snapshots` and `command_runs`
   * on every `ensureCortexSchema`, which every CLI command triggers, so the item
   * returns with its original id on the next invocation. The source row is what
   * makes the removal durable.
   *
   * `memory_references`, `memory_item_semantics` and the FTS row follow the
   * item automatically — the first two by `ON DELETE CASCADE` (which relies on
   * `openDatabase` setting `foreign_keys = ON`), the third by an AFTER DELETE
   * trigger. They are pinned by test rather than trusted.
   */
  deleteMemoryItemCascade(id: string): boolean {
    return this.runInImmediateTransaction(() => {
      const item = this.getMemoryItem(id);
      if (!item) {
        return false;
      }

      const note =
        item.source_table === 'notes' && item.source_id
          ? this.getNote(item.source_id)
          : undefined;
      // Read the scope before the note row is gone: clearConflictsForSubject
      // resolves scope by joining through the note's session.
      const noteScopeKey = note ? this.getScopeKeyForNote(note.id) : null;

      this.recordMemoryCorrection({
        memoryItemId: item.id,
        sourceTable: item.source_table,
        sourceId: item.source_id,
        scopeKey: item.scope_key,
        operation: 'delete',
        priorText: this.editableTextFor(item),
        priorSubject: item.subject,
      });

      // Deleting one side of a contest must not leave the survivor rendering
      // [contested] against a counterpart that no longer exists.
      if (note?.subject && note.conflict) {
        this.clearConflictsForSubject(note.subject, noteScopeKey);
      }

      if (item.source_table && item.source_id) {
        if (!DELETABLE_SOURCE_TABLES.has(item.source_table)) {
          // Refuse rather than half-delete. Falling through would drop the
          // memory item while its source survives — and the backfill would
          // bring the item straight back, with the caller told it succeeded.
          throw new Error(
            `Cannot delete a memory item sourced from "${item.source_table}": no deletion rule exists for that table.`,
          );
        }

        this.db
          .prepare(`DELETE FROM ${item.source_table} WHERE id = ?`)
          .run(item.source_id);
        this.deleteUpstreamOf(item.source_table, item.source_id);
      }

      this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
      return true;
    });
  }

  /**
   * Delete the rows a source row is itself re-derived from.
   *
   * Three of the six source tables are **second-order**: the backfill rebuilds
   * them from `events` and `state`, reusing the same primary key. Deleting only
   * the source row therefore looks correct and is undone by the next
   * `ensureCortexSchema` — the very failure `deleteMemoryItemCascade` exists to
   * prevent, one level further up than it originally looked.
   *
   *   command_runs      ← events   (type='cmd';  `handleCmdEvent` reuses the event id)
   *   episodes          ← state    (layer='session'; `writeSessionSummary` reuses the state id)
   *   project_snapshots ← state    (layer='project'; `insertState` reuses its own id)
   *
   * A `state` row is itself upstream of the other two, so deleting a
   * `state`-backed item takes its twin projection with it — one piece of
   * content is otherwise projected as two memory items sharing an id.
   */
  private deleteUpstreamOf(sourceTable: string, sourceId: string): void {
    if (sourceTable === 'command_runs') {
      this.db.prepare('DELETE FROM events WHERE id = ?').run(sourceId);
      return;
    }

    if (sourceTable === 'episodes' || sourceTable === 'project_snapshots') {
      this.db.prepare('DELETE FROM state WHERE id = ?').run(sourceId);
      return;
    }

    if (sourceTable === 'state') {
      this.db.prepare('DELETE FROM episodes WHERE id = ?').run(sourceId);
      this.db.prepare('DELETE FROM project_snapshots WHERE id = ?').run(sourceId);
      this.db
        .prepare('DELETE FROM memory_items WHERE source_table IN (?, ?) AND source_id = ?')
        .run('episodes', 'project_snapshots', sourceId);
    }
  }

  // ── Transactions ──────────────────────────────────────────────────

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Like `runInTransaction`, but takes the write lock up front.
   *
   * Required for any read-then-write sequence: a DEFERRED transaction upgrades
   * lazily, and the upgrade fails with `SQLITE_BUSY_SNAPSHOT`, which **bypasses
   * the busy handler** — so `busy_timeout` never applies and the work is
   * discarded instead of waiting. `insertNote` and `updateNoteStatus` use this
   * for the same reason; two sessions share one database file.
   */
  runInImmediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ── Content digests (read ledger, FR-5) ────────────────────────────────────

  /**
   * Record what a file's bytes were when a session read it.
   *
   * Keyed by `(scope_key, path)`, so a re-read overwrites rather than appending
   * — the ledger answers "has this changed since I read it", which needs the
   * latest digest, not a history. `read_count` accumulates across the upsert
   * because Story 3.4 orders its brief line by read frequency and a keyed row
   * cannot recover that number afterwards.
   *
   * `session_id`/`agent_id` record the reader, and the update is **not**
   * unconditional last-writer-wins. AD-16 asks whether the requesting session
   * *or an ancestor* read the file, so a descendant overwriting its ancestor
   * destroys the stronger claim: measured, a parent read followed by its own
   * subagent reading the same file left zero rows attributable to the parent,
   * and the parent would later be told a subagent read a file it read itself.
   * Under-crediting is tolerable (SM-C3); misattributing an ancestor's read to
   * its descendant is not.
   *
   * So when the existing recorder is the incoming reader's parent, the existing
   * reader is kept while the content columns still update. Sessions nest exactly
   * one level — Epic 0 creates child sessions directly under the active primary
   * — so "ancestor" is the parent, and this is a comparison rather than a walk.
   * An unrelated newer session still takes over, which is correct: it is not a
   * descendant, so nothing stronger is being discarded.
   */
  /**
   * The worktree root recorded for a scope, memoized.
   *
   * The store derives the digest key itself — relative to this root — on both
   * write and read, so a caller cannot supply one and forget the other. That
   * asymmetry is silent and total: the write would key `src/a.ts` while the
   * read looked up `c:/repo/src/a.ts`, and the ledger would answer "unread" for
   * every file it had just recorded. Memoized because a flush resolves the same
   * scope for hundreds of entries, the same reason `sessionByAgent` exists.
   */
  private readonly scopeRootCache = new Map<string, string | null>();

  /**
   * Public because a caller that must resolve an on-disk path for a scope has
   * to use the SAME root the key derivation uses.
   *
   * The read ledger resolves a relative input against the scope root in order
   * to hash it, while `getContentDigest` derives the lookup key against this
   * one. Taking the requesting session's own `worktree_path` for the first and
   * leaving the store to resolve the second is two roots for one query — the
   * shape Story 3.2 was bitten by, and the shape `recordReadDigest` carries
   * three lines of comment to avoid. Content-derived comparison happens to
   * absorb the divergence today (hashing the wrong file can only produce a
   * *content* mismatch, never a false `unchanged`), which is exactly why it
   * would sit undetected until a path-identity check is added.
   */
  resolveScopeRoot(scopeKey: string): string | null {
    return this.scopeRootFor(scopeKey);
  }

  private scopeRootFor(scopeKey: string): string | null {
    const cached = this.scopeRootCache.get(scopeKey);
    if (cached !== undefined && cached !== null) {
      return cached;
    }
    const row = this.db
      .prepare(
        `SELECT worktree_path
           FROM sessions
          WHERE scope_key = ? AND worktree_path IS NOT NULL
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get(scopeKey) as { worktree_path: string } | undefined;
    const root = row?.worktree_path ?? null;
    // A resolved root is stable and memoized. A `null` is deliberately NOT
    // memoized: it means no session has recorded a worktree for this scope
    // *yet*, and caching it would freeze that answer for the life of the
    // process. Measured consequence — a key written while the root was unknown
    // is stored absolute, and a fresh store in another process resolves the
    // root, looks up the relative form, and answers "unread" for a file it had
    // just recorded. That is precisely the write/read asymmetry this method
    // exists to make impossible, reintroduced at process granularity.
    if (root !== null) {
      this.scopeRootCache.set(scopeKey, root);
    }
    return root;
  }

  upsertContentDigest(opts: UpsertContentDigestOpts): ParsedContentDigest {
    const recordedAt = opts.recordedAt ?? new Date().toISOString();
    // Derived here rather than at the call sites, so the write and every future
    // read produce the same key by construction. `scopeRoot` is an optimization
    // for callers that already hold it; omitting it resolves the same value.
    const scopeRoot = opts.scopeRoot ?? this.scopeRootFor(opts.scopeKey);
    const key = toScopeRelativeKey(opts.path, scopeRoot);

    // **The ancestor-retention rule is conditional on the CONTENT being the
    // same, and that condition is load-bearing.** Retaining an ancestor's
    // `session_id` exists so a descendant's re-read does not erase the fact
    // that the ancestor read the file (AD-16). Unconditionally, it retained the
    // ancestor's *identity* while overwriting the ancestor's *snapshot* — so
    // `session_id` stopped meaning "the session that produced these bytes".
    // Measured: parent reads X, the file becomes Y, the parent's own subagent
    // reads Y. The row kept `session_id = parent` and `sha256 = Y`, so the
    // parent was told `unchanged-since`, refund-eligible and **unattributed**,
    // about content it had never seen — AD-16's "says you read it when you
    // didn't" and AD-6's "asserts unchanged without the evidence" at once, at
    // the only nesting depth that exists today. When the content matches, the
    // retained identity is still true of these bytes and the rule is correct.
    // `IS` rather than `=` so two oversize rows (both `sha256` NULL) compare
    // equal instead of yielding NULL and silently taking the ELSE branch.
    //
    // RETURNING rather than a follow-up SELECT: the read-back was a second
    // statement compiled and executed per read entry, inside the flush's write
    // transaction, and every caller either ignores it or wants exactly this row.
    const row = this.db
      .prepare(
        `INSERT INTO content_digests (
           scope_key, path, sha256, byte_size, mtime,
           session_id, agent_id, oversize, read_count, recorded_at,
           refund_eligible
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(scope_key, path) DO UPDATE SET
           sha256 = excluded.sha256,
           byte_size = excluded.byte_size,
           mtime = excluded.mtime,
           session_id = CASE WHEN content_digests.session_id = :parent
                                  AND excluded.sha256 IS content_digests.sha256
                             THEN content_digests.session_id
                             ELSE excluded.session_id END,
           agent_id   = CASE WHEN content_digests.session_id = :parent
                                  AND excluded.sha256 IS content_digests.sha256
                             THEN content_digests.agent_id
                             ELSE excluded.agent_id END,
           oversize = excluded.oversize,
           read_count = content_digests.read_count + 1,
           recorded_at = excluded.recorded_at,
           refund_eligible = excluded.refund_eligible
         RETURNING *`,
      )
      .get(
        opts.scopeKey,
        key,
        opts.sha256,
        opts.byteSize,
        opts.mtime ?? null,
        opts.sessionId,
        opts.agentId ?? null,
        opts.oversize ? 1 : 0,
        recordedAt,
        // Always the NEW read's assessment, never retained: eligibility
        // certifies "this digest is what that read returned", and each upsert
        // rewrites the digest, so a stale bit in either direction lies.
        opts.refundEligible === false ? 0 : 1,
        // Named so the CASE can reference it twice from one binding. A session
        // with no parent binds null, which never equals a session_id, so the
        // ancestor branch simply never fires for a primary session.
        { parent: opts.readerParentSessionId ?? null },
      ) as ContentDigestRow;

    return parseContentDigestRow(row);
  }

  getContentDigest(
    scopeKey: string,
    filePath: string,
    scopeRoot?: string | null,
  ): ParsedContentDigest | undefined {
    const root = scopeRoot ?? this.scopeRootFor(scopeKey);
    const row = this.db
      .prepare('SELECT * FROM content_digests WHERE scope_key = ? AND path = ?')
      .get(scopeKey, toScopeRelativeKey(filePath, root)) as ContentDigestRow | undefined;
    return row ? parseContentDigestRow(row) : undefined;
  }

  /**
   * Record a certified zero-result search (FR-12, Story 4.3). Plain
   * last-writer-wins upsert: a re-search that still found nothing refreshes
   * the census, the head, and `recorded_at`. No retention CASE like
   * `upsertContentDigest`'s — there is no per-session attribution to preserve
   * (negatives are scope facts), and each certified capture fully supersedes
   * the prior evidence.
   */
  upsertNegativeResult(opts: UpsertNegativeResultOpts): ParsedNegativeResult {
    const recordedAt = opts.recordedAt ?? new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO negative_results (
           scope_key, query_key, tool, pattern, root, params_json,
           head_oid, census_sha256, census_files, census_bytes, recorded_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, query_key) DO UPDATE SET
           tool = excluded.tool,
           pattern = excluded.pattern,
           root = excluded.root,
           params_json = excluded.params_json,
           head_oid = excluded.head_oid,
           census_sha256 = excluded.census_sha256,
           census_files = excluded.census_files,
           census_bytes = excluded.census_bytes,
           recorded_at = excluded.recorded_at
         RETURNING *`,
      )
      .get(
        opts.scopeKey,
        opts.queryKey,
        opts.tool,
        opts.pattern,
        opts.root,
        opts.paramsJson ?? null,
        opts.headOid ?? null,
        opts.censusSha256,
        opts.censusFiles,
        opts.censusBytes,
        recordedAt,
      ) as NegativeResultRow;
    return parseNegativeResultRow(row);
  }

  /** Exact-key lookup; the `scope_key` equality IS the AC #5 boundary. */
  getNegativeResult(scopeKey: string, queryKey: string): ParsedNegativeResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM negative_results WHERE scope_key = ? AND query_key = ?')
      .get(scopeKey, queryKey) as NegativeResultRow | undefined;
    return row ? parseNegativeResultRow(row) : undefined;
  }

  // ── Subagent dispatches (FR-18, Story 5.2) ────────────────────────

  /** Record a dispatch seen at `PreToolUse` on the `Agent` tool. */
  insertSubagentDispatch(opts: InsertSubagentDispatchOpts): ParsedSubagentDispatch {
    const id = crypto.randomUUID();
    const capturedAt = opts.capturedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO subagent_dispatches (
           id, scope_key, host_session_id, prompt_id, agent_type, tool_use_id,
           description, prompt_digest, prompt_prefix, prompt_chars, captured_at, consumed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        opts.scopeKey,
        opts.hostSessionId,
        opts.promptId,
        opts.agentType,
        opts.toolUseId ?? null,
        opts.description,
        opts.promptDigest ?? null,
        opts.promptPrefix ?? null,
        opts.promptChars ?? 0,
        capturedAt,
      );
    return this.getSubagentDispatch(id)!;
  }

  getSubagentDispatch(id: string): ParsedSubagentDispatch | undefined {
    const row = this.db
      .prepare('SELECT * FROM subagent_dispatches WHERE id = ?')
      .get(id) as SubagentDispatchRow | undefined;
    return row ? parseSubagentDispatchRow(row) : undefined;
  }

  /**
   * How many unconsumed captures match the pairing key inside the horizon.
   *
   * Read separately from the consume so the ambiguous case can be COUNTED. More
   * than one match means only dispatch order separates the candidates — N
   * same-type subagents dispatched in one assistant message — and a design whose
   * safety rests on that ordering has to report how often the assumption is
   * being tested (AD-12).
   */
  countPendingSubagentDispatches(key: SubagentDispatchKey, notOlderThan: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM subagent_dispatches
         WHERE host_session_id = ? AND prompt_id = ? AND agent_type = ?
           AND consumed_at IS NULL AND captured_at > ?`,
      )
      .get(key.hostSessionId, key.promptId, key.agentType, notOlderThan) as { n: number };
    return row.n;
  }

  /**
   * Claim the oldest unconsumed capture matching the key, in ONE statement.
   *
   * A conditional `UPDATE ... RETURNING` rather than select-then-update:
   * `SubagentStart` hooks are independent OS processes, and `busy_timeout`
   * serialises writes without making read-then-write atomic — Story 5.1's review
   * reproduced two hook processes losing an increment through exactly that
   * shape. Here the same race would hand ONE capture to TWO subagents, so the
   * claim has to happen inside the database. A returned row is the row count:
   * exactly one caller sees it.
   *
   * `captured_at > notOlderThan` is CORRECTNESS, not housekeeping, and must not
   * be confused with the GC rule that also prunes this table. GC runs at most
   * once per 24 hours, so a capture orphaned at 09:00 — a dispatch the user
   * denied, or one the host never started — would otherwise stay eligible to
   * mis-brief a later same-type subagent all day.
   */
  consumeSubagentDispatch(
    key: SubagentDispatchKey,
    notOlderThan: string,
    consumedAt: string = new Date().toISOString(),
  ): ParsedSubagentDispatch | undefined {
    const row = this.db
      .prepare(
        `UPDATE subagent_dispatches SET consumed_at = ?
         WHERE id = (
           SELECT id FROM subagent_dispatches
           WHERE host_session_id = ? AND prompt_id = ? AND agent_type = ?
             AND consumed_at IS NULL AND captured_at > ?
           ORDER BY captured_at ASC, rowid ASC
           LIMIT 1
         )
           AND consumed_at IS NULL
         RETURNING *`,
      )
      .get(consumedAt, key.hostSessionId, key.promptId, key.agentType, notOlderThan) as
      | SubagentDispatchRow
      | undefined;
    return row ? parseSubagentDispatchRow(row) : undefined;
  }
}
