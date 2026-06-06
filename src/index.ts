// Cortex — Working Memory for AI Agents
// Public API re-exports

// Database
export { openDatabase, applySchema, initializeMeta, getSchemaVersion, ensureCortexSchema, SCHEMA_VERSION } from './db/schema.js';
export { CortexStore, parseCommandRunRow, parseEpisodeRow, parseMemoryItemRow, parseMemoryItemSemanticRow, parseRetrievalLogRow, type SessionRow, type EventRow, type ParsedEvent, type NoteRow, type ParsedNote, type StateRow, type LedgerRow, type BranchSnapshotRow, type CommandRunRow, type ParsedCommandRun, type EpisodeRow, type ParsedEpisode, type ProjectSnapshotRow, type MemoryItemRow, type ParsedMemoryItem, type MemoryItemSemanticRow, type ParsedMemoryItemSemantic, type SemanticMemoryItemResult, type SearchMemoryItemResult, type RetrievalLogRow, type ParsedRetrievalLog, type CreateSessionOpts, type InsertEventOpts, type InsertNoteOpts, type InsertStateOpts, type InsertLedgerOpts, type InsertCommandRunOpts, type InsertEpisodeOpts, type UpsertBranchSnapshotOpts, type UpsertProjectSnapshotOpts, type UpsertMemoryItemOpts, type UpsertMemoryItemSemanticOpts, type InsertRetrievalLogOpts, type UpdateMemoryItemStateOpts, type TableCounts } from './db/store.js';
// Capture
export { handleReadEvent, handleEditEvent, handleWriteEvent, handleCmdEvent, handleAgentEvent } from './capture/hooks.js';
export { redactCommand, redactSensitiveText, captureOutputTail, classifyCommand, extractTouchedFiles } from './capture/redact.js';
export { consolidateLevel1, renderCompressed, getPendingConsolidation, writeSessionSummary, promoteSubagentNotes, mergeProjectState, type CompressedEvent } from './capture/consolidate.js';
export { computeMemoryHotness, deriveMemoryItemState, refreshMemoryHotness, selectWorkingMemoryItems, type ScoredMemoryItem } from './memory/hotness.js';
// Scope
export { normalizeScopePath, deriveProjectScopeKey, deriveBranchScopeKey, deriveDetachedScopeKey, formatScopeLabel, type ScopeType } from './scope/keys.js';
export { detectGitScope, type GitScopeIdentity, type GitCommandRunner } from './scope/git.js';
export { ensureScopedSession, syncBranchSnapshotForSession, type ScopeSessionOptions } from './scope/runtime.js';
// Query
export { buildHeader, buildFullState } from './query/state.js';
export { recall } from './query/recall.js';
export { brief } from './query/brief.js';
export { buildRetrievalContext, retrieveMemory, logRetrieval, type RetrievedMemoryItem, type RetrievalContext, type RetrievalResult, type RetrieveMemoryOptions, type SemanticMode, type SemanticProvider } from './query/retrieval.js';
export { suggestNotes, type SuggestedNote, type SuggestedNoteKind } from './query/suggest-notes.js';
export { buildSessionSummary } from './query/summarize.js';
export { estimateTokens, buildTextMetric, evaluateStore, evaluateDatabase, type TextMetric, type TopicEvaluation, type EvaluationResult, type EvaluationOptions, type QualityComparison, type QualityEvaluation, type QualityFixture, type QualityFixtureEvaluation, type QualityScoreBreakdown } from './eval/harness.js';
// Transports
export { createMcpServer, startServer, handleToolCall, TOOL_DEFINITIONS, deriveEngagementPath } from './transports/mcp.js';
export { createProgram } from './transports/cli.js';
