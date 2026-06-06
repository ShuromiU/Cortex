import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  TOOL_DEFINITIONS,
  handleToolCall,
  createMcpServer,
  configureEngagementPath,
  readEngagement,
} from '../src/transports/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function createStore(): { store: CortexStore; sessionId: string } {
  const db = createTestDb();
  const store = new CortexStore(db);
  const session = store.createSession();
  return { store, sessionId: session.id };
}

// ── TOOL_DEFINITIONS ──────────────────────────────────────────────────

describe('TOOL_DEFINITIONS', () => {
  it('defines exactly 10 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
  });

  it('has cortex_route tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_route');
    expect(tool).toBeDefined();
  });

  it('cortex_route is a cold-callable capability router', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_route')!;
    expect(tool.description).toContain('ambient memory');
    expect(tool.description).toContain('route');
    expect(tool.inputSchema.required).toEqual([]);
  });

  it('has cortex_state tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_state');
    expect(tool).toBeDefined();
  });

  it('cortex_state description frames Cortex as explicit expansion, not a startup ritual', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_state')!;
    expect(tool.description).toContain('explicitly need');
    expect(tool.description).toContain('ambient');
    expect(tool.description).not.toContain('Start with this');
  });

  it('cortex_state has no required fields', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_state')!;
    expect(tool.inputSchema.required).toHaveLength(0);
  });

  it('has cortex_note tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_note');
    expect(tool).toBeDefined();
  });

  it('cortex_note description emphasizes durable memory only', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_note')!;
    expect(tool.description).toContain('future sessions only');
    expect(tool.description).toContain('routine progress');
  });

  it('cortex_note requires kind and content', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_note')!;
    expect(tool.inputSchema.required).toContain('kind');
    expect(tool.inputSchema.required).toContain('content');
  });

  it('cortex_note kind enum has 5 values', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_note')!;
    const kindProp = (tool.inputSchema.properties as Record<string, { enum?: string[] }>)['kind'];
    expect(kindProp?.enum).toEqual(['insight', 'decision', 'intent', 'blocker', 'focus']);
  });

  it('has cortex_recall tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_recall');
    expect(tool).toBeDefined();
  });

  it('cortex_recall description targets familiar-ground investigations', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_recall')!;
    expect(tool.description).toContain('re-investigating familiar ground');
  });

  it('cortex_recall requires topic', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_recall')!;
    expect(tool.inputSchema.required).toContain('topic');
  });

  it('has cortex_brief tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_brief');
    expect(tool).toBeDefined();
  });

  it('cortex_brief requires topic', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_brief')!;
    expect(tool.inputSchema.required).toContain('topic');
  });

  it('cortex_brief has optional "for" field', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_brief')!;
    const forProp = (tool.inputSchema.properties as Record<string, unknown>)['for'];
    expect(forProp).toBeDefined();
    // "for" is optional — not in required
    const requiredArr = tool.inputSchema.required as string[];
    expect(requiredArr).not.toContain('for');
  });

  it('has cortex_engage tool with no required fields', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_engage');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toHaveLength(0);
  });

  it('has cortex_disengage tool with no required fields', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_disengage');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toHaveLength(0);
  });

  it('has cortex_summarize tool with optional what field', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_summarize');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toHaveLength(0);
    const whatProp = (tool!.inputSchema.properties as Record<string, unknown>)['what'];
    expect(whatProp).toBeDefined();
  });

  it('has cortex_suggest_notes tool with optional session id', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_suggest_notes');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toHaveLength(0);
    const sessionProp = (tool!.inputSchema.properties as Record<string, unknown>)['sessionId'];
    expect(sessionProp).toBeDefined();
  });

  it('has cortex_validate_memory tool with optional topic', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_validate_memory');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toHaveLength(0);
    const topicProp = (tool!.inputSchema.properties as Record<string, unknown>)['topic'];
    expect(topicProp).toBeDefined();
  });
});

// ── handleToolCall ────────────────────────────────────────────────────

describe('handleToolCall', () => {
  let store: CortexStore;
  let sessionId: string;
  let cwd: string;

  function callTool(toolName: string, args: Record<string, unknown> = {}): string {
    return handleToolCall(store, toolName, args, cwd);
  }

  beforeEach(() => {
    const result = createStore();
    store = result.store;
    sessionId = result.sessionId;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mcp-cwd-'));
  });

  it('cortex_route explains ambient capture, reflex, and explicit recall tools', () => {
    const result = callTool('cortex_route');
    expect(result).toContain('Cortex route');
    expect(result).toContain('ambient capture');
    expect(result).toContain('reflex');
    expect(result).toContain('cortex_recall');
  });

  it('cortex_route marks Cortex as consulted for hook visibility suppression', () => {
    configureEngagementPath(cwd);

    callTool('cortex_route');

    expect(readEngagement()['cortex_consulted']).toBe('true');
  });

  // cortex_state

  it('cortex_state returns a string (cognitive state)', () => {
    const result = callTool('cortex_state');
    expect(typeof result).toBe('string');
  });

  it('cortex_state returns actionable fallback guidance when state is empty', () => {
    const result = callTool('cortex_state');
    expect(result).toContain('Cortex state: no current working memory for this scope.');
    expect(result).toContain('cortex_route');
    expect(result).toContain('cortex_recall(topic)');
  });

  it('cortex_state returns content when notes exist', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'Testing works' });
    const result = callTool('cortex_state');
    expect(result).toContain('Testing works');
  });

  it('cortex_state records a spent ledger entry', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'Ledger spent check' });
    callTool('cortex_state');
    const stats = store.getLedgerStats();
    expect(stats.byType['state']?.spent ?? 0).toBeGreaterThan(0);
  });

  it('cortex_recall records a spent ledger entry', () => {
    callTool('cortex_recall', { topic: 'testing' });
    const stats = store.getLedgerStats();
    expect(stats.spent).toBeGreaterThan(0);
    expect(stats.byType['recall']?.spent ?? 0).toBeGreaterThan(0);
  });

  // cortex_note

  it('cortex_note creates a note and returns confirmation', () => {
    const result = callTool('cortex_note', {
      kind: 'insight',
      content: 'This is a test insight',
    });
    expect(result).toMatch(/^Noted \(insight\) \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\]:/);
    expect(result).toContain('This is a test insight');
  });

  it('cortex_note confirmation includes compact UTC timestamp', () => {
    const result = callTool('cortex_note', {
      kind: 'decision',
      content: 'Use SQLite for persistence',
      subject: 'database',
    });

    expect(result).toMatch(/^Noted \(decision\[database\]\) \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\]:/);
  });

  it('cortex_note includes subject in confirmation when provided', () => {
    const result = callTool('cortex_note', {
      kind: 'decision',
      content: 'Use SQLite for persistence',
      subject: 'database',
    });
    expect(result).toMatch(/^Noted \(decision\[database\]\) \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\]:/);
  });

  it('cortex_note truncates long content to 60 chars', () => {
    const longContent = 'A'.repeat(80);
    const result = callTool('cortex_note', {
      kind: 'insight',
      content: longContent,
    });
    // Should end with ellipsis and be limited
    expect(result).toContain('…');
  });

  it('cortex_note validates required subject for decisions', () => {
    const result = callTool('cortex_note', {
      kind: 'decision',
      content: 'Some decision without subject',
    });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain('Subject is required');
  });

  it('cortex_note validates required subject for intent', () => {
    const result = callTool('cortex_note', {
      kind: 'intent',
      content: 'Intend to do something',
    });
    expect(result).toMatch(/^Error:/);
  });

  it('cortex_note validates required subject for blocker', () => {
    const result = callTool('cortex_note', {
      kind: 'blocker',
      content: 'Something is blocked',
    });
    expect(result).toMatch(/^Error:/);
  });

  it('cortex_note allows insight without subject', () => {
    const result = callTool('cortex_note', {
      kind: 'insight',
      content: 'An insight without subject',
    });
    expect(result).not.toMatch(/^Error:/);
  });

  // cortex_recall

  it('cortex_recall returns a string result', () => {
    const result = callTool('cortex_recall', { topic: 'testing' });
    expect(typeof result).toBe('string');
  });

  it('cortex_recall returns no matches message when nothing found', () => {
    const result = callTool('cortex_recall', { topic: 'nonexistent-xyz' });
    expect(result).toContain('No matches for');
  });

  it('cortex_recall finds relevant notes', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'SQLite is great for local storage' });
    const result = callTool('cortex_recall', { topic: 'sqlite' });
    expect(result).toContain('SQLite is great');
  });

  it('cortex_suggest_notes returns proposals without writing notes', () => {
    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Decided to use semantic shadow mode before rank mode.',
    });
    const before = store.getNotesBySession(sessionId);

    const result = callTool('cortex_suggest_notes');
    const parsed = JSON.parse(result) as {
      suggestions: Array<{ kind: string; content: string; evidence: string[] }>;
    };

    expect(store.getNotesBySession(sessionId)).toEqual(before);
    expect(parsed.suggestions).toEqual([
      expect.objectContaining({
        kind: 'decision',
        content: expect.stringContaining('semantic shadow mode'),
        evidence: [expect.stringContaining('Decided to use semantic shadow mode')],
      }),
    ]);
  });

  it('cortex_validate_memory reports missing references without deleting notes', () => {
    store.upsertCurrentAppGraph({
      scopeKey: 'project:default',
      scopeType: 'project',
      worktreePath: '/repo',
      files: ['src/current.ts'],
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'files',
      content: 'Old file was src/missing.ts.',
    });
    const before = store.getActiveNotes(sessionId);

    const result = callTool('cortex_validate_memory', { topic: 'old file' });
    const parsed = JSON.parse(result) as {
      memories: Array<{ status: string; missing_references: string[] }>;
    };

    expect(store.getActiveNotes(sessionId)).toEqual(before);
    expect(parsed.memories[0]?.status).toBe('stale');
    expect(parsed.memories[0]?.missing_references).toEqual(['src/missing.ts']);
  });

  // cortex_brief

  it('cortex_brief returns a string', () => {
    const result = callTool('cortex_brief', { topic: 'testing' });
    expect(typeof result).toBe('string');
  });

  it('cortex_brief includes agent context when "for" is provided', () => {
    const result = callTool('cortex_brief', {
      topic: 'architecture',
      for: 'implementer-agent',
    });
    expect(result).toContain('Briefing for implementer-agent');
  });

  it('cortex_brief includes relevant notes', () => {
    store.insertNote({
      sessionId,
      kind: 'decision',
      content: 'Use TypeScript for type safety',
      subject: 'architecture',
    });
    const result = callTool('cortex_brief', { topic: 'architecture' });
    expect(result).toContain('TypeScript');
  });

  it('cortex_brief reports no context when nothing matches', () => {
    const result = callTool('cortex_brief', { topic: 'irrelevant-xyz' });
    expect(result).toContain('No context found for');
  });

  // cortex_engage

  it('cortex_engage returns cognitive state string', () => {
    const result = callTool('cortex_engage');
    expect(typeof result).toBe('string');
  });

  it('cortex_engage includes notes when they exist', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'Existing context' });
    const result = callTool('cortex_engage');
    expect(result).toContain('Existing context');
  });

  // cortex_disengage

  it('cortex_disengage returns confirmation', () => {
    const result = callTool('cortex_disengage');
    expect(result).toContain('disengaged');
  });

  // cortex_summarize

  it('cortex_summarize returns summary string', () => {
    const result = callTool('cortex_summarize');
    expect(typeof result).toBe('string');
  });

  it('cortex_summarize includes user description when provided', () => {
    const result = callTool('cortex_summarize', { what: 'Refactored the auth module' });
    expect(result).toContain('Refactored the auth module');
  });

  it('cortex_summarize includes file activity', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'write', target: 'src/bar.ts' });
    const result = callTool('cortex_summarize');
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts');
  });

  it('cortex_summarize stores session state', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/test.ts' });
    callTool('cortex_summarize');
    const state = store.getSessionState(sessionId);
    expect(state).toBeDefined();
    expect(state!.content).toContain('src/test.ts');
  });

  // unknown tool

  it('returns error for unknown tool', () => {
    const result = callTool('cortex_unknown_tool');
    expect(result).toBe('Unknown tool: cortex_unknown_tool');
  });
});

// ── createMcpServer ───────────────────────────────────────────────────

describe('createMcpServer', () => {
  it('returns a Server instance', () => {
    const { store } = createStore();
    const server = createMcpServer(store);
    expect(server).toBeInstanceOf(Server);
  });
});
