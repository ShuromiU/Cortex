// Cortex — Working Memory for AI Agents
// Public API re-exports

// Database
export { openDatabase, applySchema, initializeMeta, getSchemaVersion, ensureCortexSchema, SCHEMA_VERSION } from './db/schema.js';
export { CortexStore, parseCommandRunRow, parseEpisodeRow, parseMemoryItemRow, parseMemoryItemSemanticRow, parseCurrentAppGraphRow, parseMemoryReferenceRow, parseRetrievalLogRow, type SessionRow, type EventRow, type ParsedEvent, type NoteRow, type ParsedNote, type StateRow, type LedgerRow, type BranchSnapshotRow, type CommandRunRow, type ParsedCommandRun, type EpisodeRow, type ParsedEpisode, type ProjectSnapshotRow, type MemoryItemRow, type ParsedMemoryItem, type MemoryItemSemanticRow, type ParsedMemoryItemSemantic, type CurrentAppGraphRow, type ParsedCurrentAppGraph, type MemoryReferenceStatus, type MemoryReferenceRow, type ParsedMemoryReference, type SemanticMemoryItemResult, type SearchMemoryItemResult, type RetrievalLogRow, type ParsedRetrievalLog, type CreateSessionOpts, type InsertEventOpts, type InsertNoteOpts, type InsertStateOpts, type InsertLedgerOpts, type InsertCommandRunOpts, type InsertEpisodeOpts, type UpsertBranchSnapshotOpts, type UpsertProjectSnapshotOpts, type UpsertMemoryItemOpts, type UpsertMemoryItemSemanticOpts, type UpsertCurrentAppGraphOpts, type UpsertMemoryReferenceOpts, type InsertRetrievalLogOpts, type UpdateMemoryItemStateOpts, type TableCounts } from './db/store.js';
// Capture
export { handleReadEvent, handleEditEvent, handleWriteEvent, handleCmdEvent, handleAgentEvent } from './capture/hooks.js';
export { redactCommand, redactSensitiveText, captureOutputTail, classifyCommand, extractTouchedFiles } from './capture/redact.js';
export { consolidateLevel1, renderCompressed, getPendingConsolidation, writeSessionSummary, promoteSubagentNotes, mergeProjectState, type CompressedEvent } from './capture/consolidate.js';
export { computeMemoryHotness, deriveMemoryItemState, refreshMemoryHotness, selectWorkingMemoryItems, type ScoredMemoryItem } from './memory/hotness.js';
export { extractMemoryReferences, type ExtractedMemoryReference, type MemoryReferenceType } from './memory/references.js';
// Scope
export { normalizeScopePath, deriveProjectScopeKey, deriveBranchScopeKey, deriveDetachedScopeKey, formatScopeLabel, type ScopeType } from './scope/keys.js';
export { detectGitScope, type GitScopeIdentity, type GitCommandRunner } from './scope/git.js';
export { refreshCurrentAppGraph, listCurrentAppFiles, type RefreshCurrentAppGraphOptions } from './scope/app-graph.js';
export { ensureScopedSession, resolveAgentSessionId, syncBranchSnapshotForSession, type ScopeSessionOptions } from './scope/runtime.js';
// Query
export { buildHeader, buildFullState } from './query/state.js';
export { recall } from './query/recall.js';
export { brief } from './query/brief.js';
export { buildRetrievalContext, retrieveMemory, logRetrieval, type RetrievedMemoryItem, type RetrievalContext, type RetrievalResult, type RetrieveMemoryOptions, type SemanticMode, type SemanticProvider } from './query/retrieval.js';
export { validateMemoryReferences, referenceValidationScore, ReferenceValidator, type MemoryReferenceValidation, type MovedReference } from './query/reference-validation.js';
export { validateMemory, type MemoryValidationReport, type MemoryValidationReportItem } from './query/validate-memory.js';
export { suggestNotes, type SuggestedNote, type SuggestedNoteKind } from './query/suggest-notes.js';
export { buildSessionSummary } from './query/summarize.js';
export { buildSessionBrief, type SessionBriefOptions } from './query/session-brief.js';
export { flushSpool, appendSpoolEntry, deriveSpoolPath, spoolSizeBytes, type SpoolEntry, type SpoolFlushResult } from './capture/spool.js';
export { runGc, shouldAutoGc, type GcOptions, type GcReport } from './db/gc.js';
export { estimateTokens, buildTextMetric, evaluateStore, evaluateDatabase, type TextMetric, type TopicEvaluation, type EvaluationResult, type EvaluationOptions, type QualityComparison, type QualityEvaluation, type QualityFixture, type QualityFixtureEvaluation, type QualityScoreBreakdown } from './eval/harness.js';
export { seedStoreFromScenario, createSeededStore, type EvaluationScenario, type ScenarioMemoryItem, type ScenarioAppGraph, type SeededStore } from './eval/seed.js';
export { runEvalGate, regenerateBaseline, checkKindCoverage, checkBaselineJustification, BASELINE_TRAILER, type EvalGateOptions, type GateResult, type GateSuiteResult, type GateKindCoverage, type RegenerationReport, type BaselineJustificationVerdict } from './eval/gate.js';
// Transports
export { createMcpServer, startServer, handleToolCall, TOOL_DEFINITIONS, deriveEngagementPath } from './transports/mcp.js';
export { createProgram } from './transports/cli.js';
