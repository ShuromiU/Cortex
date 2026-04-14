import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { TOOL_DEFINITIONS, handleToolCall, createMcpServer } from '../src/transports/mcp.js';
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
  it('defines exactly 7 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(7);
  });

  it('has cortex_state tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_state');
    expect(tool).toBeDefined();
  });

  it('cortex_state description frames Cortex as selective, not mandatory', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_state')!;
    expect(tool.description).toContain('skip trivial one-shot tasks');
    expect(tool.description).toContain('resumed, branch-sensitive');
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
});

// ── handleToolCall ────────────────────────────────────────────────────

describe('handleToolCall', () => {
  let store: CortexStore;
  let sessionId: string;

  beforeEach(() => {
    const result = createStore();
    store = result.store;
    sessionId = result.sessionId;
  });

  // cortex_state

  it('cortex_state returns a string (cognitive state)', () => {
    const result = handleToolCall(store, 'cortex_state', {});
    expect(typeof result).toBe('string');
  });

  it('cortex_state returns content when notes exist', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'Testing works' });
    const result = handleToolCall(store, 'cortex_state', {});
    expect(result).toContain('Testing works');
  });

  // cortex_note

  it('cortex_note creates a note and returns confirmation', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'insight',
      content: 'This is a test insight',
    });
    expect(result).toMatch(/^Noted \(insight\):/);
    expect(result).toContain('This is a test insight');
  });

  it('cortex_note includes subject in confirmation when provided', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'decision',
      content: 'Use SQLite for persistence',
      subject: 'database',
    });
    expect(result).toMatch(/^Noted \(decision\[database\]\):/);
  });

  it('cortex_note truncates long content to 60 chars', () => {
    const longContent = 'A'.repeat(80);
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'insight',
      content: longContent,
    });
    // Should end with ellipsis and be limited
    expect(result).toContain('…');
  });

  it('cortex_note validates required subject for decisions', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'decision',
      content: 'Some decision without subject',
    });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain('Subject is required');
  });

  it('cortex_note validates required subject for intent', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'intent',
      content: 'Intend to do something',
    });
    expect(result).toMatch(/^Error:/);
  });

  it('cortex_note validates required subject for blocker', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'blocker',
      content: 'Something is blocked',
    });
    expect(result).toMatch(/^Error:/);
  });

  it('cortex_note allows insight without subject', () => {
    const result = handleToolCall(store, 'cortex_note', {
      kind: 'insight',
      content: 'An insight without subject',
    });
    expect(result).not.toMatch(/^Error:/);
  });

  // cortex_recall

  it('cortex_recall returns a string result', () => {
    const result = handleToolCall(store, 'cortex_recall', { topic: 'testing' });
    expect(typeof result).toBe('string');
  });

  it('cortex_recall returns no matches message when nothing found', () => {
    const result = handleToolCall(store, 'cortex_recall', { topic: 'nonexistent-xyz' });
    expect(result).toContain('No matches for');
  });

  it('cortex_recall finds relevant notes', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'SQLite is great for local storage' });
    const result = handleToolCall(store, 'cortex_recall', { topic: 'sqlite' });
    expect(result).toContain('SQLite is great');
  });

  // cortex_brief

  it('cortex_brief returns a string', () => {
    const result = handleToolCall(store, 'cortex_brief', { topic: 'testing' });
    expect(typeof result).toBe('string');
  });

  it('cortex_brief includes agent context when "for" is provided', () => {
    const result = handleToolCall(store, 'cortex_brief', {
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
    const result = handleToolCall(store, 'cortex_brief', { topic: 'architecture' });
    expect(result).toContain('TypeScript');
  });

  it('cortex_brief reports no context when nothing matches', () => {
    const result = handleToolCall(store, 'cortex_brief', { topic: 'irrelevant-xyz' });
    expect(result).toContain('No context found for');
  });

  // cortex_engage

  it('cortex_engage returns cognitive state string', () => {
    const result = handleToolCall(store, 'cortex_engage', {});
    expect(typeof result).toBe('string');
  });

  it('cortex_engage includes notes when they exist', () => {
    store.insertNote({ sessionId, kind: 'insight', content: 'Existing context' });
    const result = handleToolCall(store, 'cortex_engage', {});
    expect(result).toContain('Existing context');
  });

  // cortex_disengage

  it('cortex_disengage returns confirmation', () => {
    const result = handleToolCall(store, 'cortex_disengage', {});
    expect(result).toContain('disengaged');
  });

  // cortex_summarize

  it('cortex_summarize returns summary string', () => {
    const result = handleToolCall(store, 'cortex_summarize', {});
    expect(typeof result).toBe('string');
  });

  it('cortex_summarize includes user description when provided', () => {
    const result = handleToolCall(store, 'cortex_summarize', { what: 'Refactored the auth module' });
    expect(result).toContain('Refactored the auth module');
  });

  it('cortex_summarize includes file activity', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'edit', target: 'src/foo.ts' });
    store.insertEvent({ sessionId, type: 'write', target: 'src/bar.ts' });
    const result = handleToolCall(store, 'cortex_summarize', {});
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts');
  });

  it('cortex_summarize stores session state', () => {
    store.insertEvent({ sessionId, type: 'edit', target: 'src/test.ts' });
    handleToolCall(store, 'cortex_summarize', {});
    const state = store.getSessionState(sessionId);
    expect(state).toBeDefined();
    expect(state!.content).toContain('src/test.ts');
  });

  // unknown tool

  it('returns error for unknown tool', () => {
    const result = handleToolCall(store, 'cortex_unknown_tool', {});
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
