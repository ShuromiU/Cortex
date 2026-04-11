// Cortex — Working Memory for AI Agents
// Public API re-exports

// Database
export { openDatabase, applySchema, initializeMeta, SCHEMA_VERSION } from './db/schema.js';
export { CortexStore, type SessionRow, type EventRow, type ParsedEvent, type NoteRow, type ParsedNote, type StateRow, type LedgerRow, type CreateSessionOpts, type InsertEventOpts, type InsertNoteOpts, type InsertStateOpts, type InsertLedgerOpts } from './db/store.js';
// Capture
export { handleReadEvent, handleEditEvent, handleWriteEvent, handleCmdEvent, handleAgentEvent } from './capture/hooks.js';
export { redactCommand, classifyCommand, extractTouchedFiles } from './capture/redact.js';
export { consolidateLevel1, renderCompressed, getPendingConsolidation, writeSessionSummary, promoteSubagentNotes, mergeProjectState, type CompressedEvent } from './capture/consolidate.js';
// Query
export { buildHeader, buildFullState } from './query/state.js';
export { recall } from './query/recall.js';
export { brief } from './query/brief.js';
// Transports
export { createMcpServer, startServer, handleToolCall, TOOL_DEFINITIONS, deriveEngagementPath } from './transports/mcp.js';
export { createProgram } from './transports/cli.js';
