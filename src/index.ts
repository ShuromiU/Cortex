// Cortex — Working Memory for AI Agents
// Public API re-exports

// Database
export { openDatabase, openDatabaseReadOnly, applySchema, initializeMeta, getSchemaVersion, ensureCortexSchema, UnopenableStoreError, NewerSchemaError, CorruptSchemaVersionError, SCHEMA_VERSION } from './db/schema.js';
export { DELETABLE_SOURCE_TABLES, CortexStore, parseCommandRunRow, parseEpisodeRow, parseMemoryItemRow, parseMemoryItemSemanticRow, parseCurrentAppGraphRow, parseMemoryReferenceRow, parseRetrievalLogRow, type SessionRow, type EventRow, type ParsedEvent, type NoteRow, type ParsedNote, type NoteConflict, type InsertedNote, type StateRow, type LedgerRow, type BranchSnapshotRow, type CommandRunRow, type ParsedCommandRun, type EpisodeRow, type ParsedEpisode, type ProjectSnapshotRow, type MemoryItemRow, type ParsedMemoryItem, type MemoryItemSemanticRow, type ParsedMemoryItemSemantic, type CurrentAppGraphRow, type ParsedCurrentAppGraph, type MemoryReferenceStatus, type MemoryReferenceRow, type ParsedMemoryReference, type SemanticMemoryItemResult, type SearchMemoryItemResult, type RetrievalLogRow, type ParsedRetrievalLog, type CreateSessionOpts, type InsertEventOpts, type InsertNoteOpts, type InsertStateOpts, type InsertLedgerOpts, type InsertCommandRunOpts, type InsertEpisodeOpts, type UpsertBranchSnapshotOpts, type UpsertProjectSnapshotOpts, type UpsertMemoryItemOpts, type UpsertMemoryItemSemanticOpts, type UpsertCurrentAppGraphOpts, type UpsertMemoryReferenceOpts, type InsertRetrievalLogOpts, type UpdateMemoryItemStateOpts, type MemoryItemFilter, type ListMemoryItemsOpts, type ParsedMemoryCorrection, type RecordMemoryCorrectionOpts, type TableCounts, parseContentDigestRow, type ContentDigestRow, type ParsedContentDigest, type UpsertContentDigestOpts, type LedgerDirection, type LedgerEvidence, type LedgerTypeTotals, type LedgerDirectionTotals, type SessionLedgerTotalRow, LEDGER_DIRECTIONS, foldLedgerDirectionTotals } from './db/store.js';
// Capture
export { handleReadEvent, handleEditEvent, handleWriteEvent, handleCmdEvent, handleAgentEvent } from './capture/hooks.js';
export { computeFileDigest, createDigestCache, resolveDigestMaxBytes, DEFAULT_DIGEST_MAX_BYTES, type FileDigest, type DigestCache, type DigestDeps } from './capture/digest.js';
export { writeDigestIndex, collectIndexRecords, renderDigestIndex, formatIndexLine, parseIndexLine, escapeIndexField, unescapeIndexField, deriveDigestIndexPath, digestIndexExists, indexLookupNeedle, DIGEST_INDEX_FILENAME, INDEX_ABSENT, INDEX_TEMP_SUFFIX, type DigestIndexRecord, type IndexWriteDeps } from './capture/digest-index.js';
export { redactCommand, redactSensitiveText, captureOutputTail, classifyCommand, extractTouchedFiles } from './capture/redact.js';
export { consolidateLevel1, renderCompressed, getPendingConsolidation, writeSessionSummary, promoteSubagentNotes, mergeProjectState, type CompressedEvent } from './capture/consolidate.js';
export { computeMemoryHotness, deriveMemoryItemState, refreshMemoryHotness, selectWorkingMemoryItems, type ScoredMemoryItem } from './memory/hotness.js';
export { demoteMemoryState, isSupersededMemoryItem, isSupersededMemoryText, noteTrailerLines } from './memory/items.js';
export { extractMemoryReferences, type ExtractedMemoryReference, type MemoryReferenceType } from './memory/references.js';
export { detectContradiction, type ContradictionEvidence } from './memory/conflict.js';
// Scope
export { normalizeFilePathKey, toScopeRelativeKey, isAbsoluteFileKey, normalizeScopePath, deriveProjectScopeKey, deriveBranchScopeKey, deriveDetachedScopeKey, formatScopeLabel, type ScopeType } from './scope/keys.js';
export { detectGitScope, type GitScopeIdentity, type GitCommandRunner } from './scope/git.js';
export { refreshCurrentAppGraph, listCurrentAppFiles, type RefreshCurrentAppGraphOptions } from './scope/app-graph.js';
export { ensureScopedSession, resolveAgentSessionId, syncBranchSnapshotForSession, type ScopeSessionOptions } from './scope/runtime.js';
export {
  resolveStoreIdentity,
  resolveRealPath,
  cortexHome,
  sanitizeLabel,
  computeStoreId,
  storeLabelFor,
  readRootCommitOid,
  STORE_ID_LENGTH,
  STORE_FILENAME,
  LEGACY_STORE_FILENAME,
  DEFAULT_HOME_DIR_NAME,
  type StoreIdentity,
  type ResolveStoreIdentityOptions,
} from './scope/identity.js';
export {
  resolveProjectStore,
  openProjectStore,
  clearProjectStoreCache,
  migrateLegacyStore,
  verifyStoreCopy,
  findAdoptionCandidates,
  adoptStore,
  recordStoreIdentityMeta,
  VERIFIED_TABLES,
  type ResolvedProjectStore,
  type OpenedProjectStore,
  type MigrationOutcome,
  type MigrationAction,
  type CopyVerification,
  type AdoptionCandidate,
  type AdoptionOutcome,
  type MigrateOptions,
} from './scope/store-migration.js';
// Query
export { buildHeader, buildFullState } from './query/state.js';
export { recall } from './query/recall.js';
export { brief } from './query/brief.js';
export { CONTESTED_MARKER, isContested, groupContestedAdjacent } from './query/render.js';
export { ALREADY_REJECTED_PREFIX, renderedAlternatives } from './query/render.js';
export { buildRetrievalContext, retrieveMemory, logRetrieval, type RetrievedMemoryItem, type RetrievalContext, type RetrievalResult, type RetrieveMemoryOptions, type SemanticMode, type SemanticProvider } from './query/retrieval.js';
export { validateMemoryReferences, referenceValidationScore, ReferenceValidator, type MemoryReferenceValidation, type MovedReference } from './query/reference-validation.js';
export { validateMemory, type MemoryValidationReport, type MemoryValidationReportItem } from './query/validate-memory.js';
export { listMemory, inspectMemory, resolvePageLimit, resolvePageOffset, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MEMORY_LIST_ORDER, ACCESS_HISTORY_LIMIT, type MemoryListOptions, type MemoryListPage, type MemoryInspection, type MemoryConflictStatus, type MemoryConflictCounterpart, type MemoryReferenceDetail, type MemoryAccessHistory, type MemoryAccessRetrieval, type MemoryCorrectionEntry } from './query/inspect.js';
export { editMemory, deleteMemory, previewMemoryDeletion, type EditMemoryResult, type MemoryDeletionPreview, type MemoryDeletionResult, type DeletionCounterpart } from './query/correct.js';
export { runDoctor, hookTemplateDigest, readTemplateStamp, expandHookPath, tokenizeCommand, resolveExecutable, extractBakedPaths, collectHookCommands, commandSatisfiesWiring, HOOK_SCRIPTS, TEMPLATE_ID_PLACEHOLDER, SPOOL_THRESHOLD_BYTES, SPOOL_STALE_MS, REQUIRED_WIRING, type CheckStatus, type DoctorCheck, type DoctorReport, type DoctorOptions, type RequiredWiring } from './query/doctor.js';
export { runInstall, renderHookScript, installedMatchesTemplate, classifyInstalledScript, mergeHookWiring, mergeMcpServer, mergeIgnoreEntries, writeFileAtomic, IGNORE_ENTRIES, type InstallOptions, type InstallResult, type InstallAction, type ActionOutcome, type ScriptState, type BakedPaths, type MergeResult } from './query/install.js';
export { suggestNotes, type SuggestedNote, type SuggestedNoteKind } from './query/suggest-notes.js';
export { buildSessionSummary } from './query/summarize.js';
export { buildSessionBrief, type SessionBriefOptions } from './query/session-brief.js';
export { buildStatsReport, renderStatsReport, MOST_RETRIEVED_LIMIT, STATS_ITEM_TEXT_MAX, type StatsReport, type StatsTokenBlock, type StatsMostRetrievedEntry } from './query/stats.js';
export { flushSpool, appendSpoolEntry, deriveSpoolPath, spoolSizeBytes, type SpoolEntry, type SpoolFlushResult } from './capture/spool.js';
export { runGc, shouldAutoGc, type GcOptions, type GcReport } from './db/gc.js';
export { estimateTokens, buildTextMetric, evaluateStore, evaluateDatabase, type TextMetric, type TopicEvaluation, type EvaluationResult, type EvaluationOptions, type QualityComparison, type QualityEvaluation, type QualityFixture, type QualityFixtureEvaluation, type QualityScoreBreakdown } from './eval/harness.js';
export { seedStoreFromScenario, createSeededStore, type EvaluationScenario, type ScenarioMemoryItem, type ScenarioAppGraph, type SeededStore } from './eval/seed.js';
export { runEvalGate, regenerateBaseline, checkKindCoverage, checkBaselineJustification, BASELINE_TRAILER, type EvalGateOptions, type GateResult, type GateSuiteResult, type GateKindCoverage, type RegenerationReport, type BaselineJustificationVerdict, type CommitRecord } from './eval/gate.js';
// Transports
export { createMcpServer, startServer, handleToolCall, TOOL_DEFINITIONS, deriveEngagementPath } from './transports/mcp.js';
export { createProgram } from './transports/cli.js';
