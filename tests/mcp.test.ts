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
  it('defines exactly 13 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(13);
  });

  it('cortex_search_ledger asserts only from evidence and stays scope-bounded', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'cortex_search_ledger');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('no-matches-at');
    expect(tool!.description).toContain('never mtime');
    expect(tool!.description).toContain('another branch');
    expect(tool!.inputSchema.required).toEqual(['queries']);
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

  it('cortex_route gives deferred tool discovery recovery guidance', () => {
    const result = callTool('cortex_route');
    expect(result).toContain('callable name');
    expect(result).toContain('cortex_recall');
    expect(result).toContain('cortex_state');
    expect(result).toContain('cortex_route');
    expect(result).toContain('server name');
    expect(result).toContain('Cortex');
    expect(result).toContain('select:mcp__cortex__');
    expect(result).toContain('not proof Cortex is unavailable');
  });

  it('cortex_route marks Cortex as consulted for hook visibility suppression', () => {
    configureEngagementPath(cwd);

    callTool('cortex_route');

    expect(readEngagement()['cortex_consulted']).toBe('true');
  });

  it('consultation tools mark Cortex as consulted for hook gate suppression', () => {
    for (const [toolName, args] of [
      ['cortex_route', {}],
      ['cortex_state', {}],
      ['cortex_recall', { topic: 'testing' }],
      ['cortex_brief', { topic: 'testing' }],
      ['cortex_engage', {}],
      ['cortex_validate_memory', { topic: 'testing' }],
    ] as const) {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mcp-cwd-'));

      callTool(toolName, args);

      expect(readEngagement()['cortex_consulted']).toBe('true');
    }
  });

  it('cortex_resolve marks a note resolved by subject and cools its memory item', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'blocker',
      subject: 'flaky teardown',
      content: 'vitest hangs on db teardown',
    });

    const result = callTool('cortex_resolve', { subject: 'flaky teardown' });

    expect(result).toContain('as resolved');
    expect(store.getNote(note.id)?.status).toBe('resolved');
    const item = store.getMemoryItemBySource('notes', note.id);
    expect(item?.state).toBe('cold');
  });

  it('cortex_resolve supersedes with replacement content in one step', () => {
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'auth transport',
      content: 'use cookies for auth',
    });

    const result = callTool('cortex_resolve', {
      note_id: note.id,
      status: 'superseded',
      replacement: 'use bearer tokens for auth',
    });

    expect(result).toContain('Superseded');
    expect(store.getNote(note.id)?.status).toBe('superseded');
    const replacementNote = store.findActiveNoteBySubject('auth transport');
    expect(replacementNote?.content).toBe('use bearer tokens for auth');
  });

  it('cortex_resolve reports missing targets without throwing', () => {
    const result = callTool('cortex_resolve', { subject: 'nothing here' });
    expect(result).toContain('Error: no active note');
  });

  it('non-consultation tools do not mark Cortex as consulted', () => {
    for (const [toolName, args] of [
      ['cortex_note', { kind: 'insight', content: 'Routine note check' }],
      ['cortex_suggest_notes', {}],
      ['cortex_summarize', {}],
      ['cortex_validate_memory', {}],
    ] as const) {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mcp-cwd-'));

      callTool(toolName, args);

      expect(readEngagement()['cortex_consulted']).toBeUndefined();
    }
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

// ── cortex_note conflict reporting (FR-1, story 1.1) ──────────────────

describe('cortex_note — contradiction reporting', () => {
  let store: CortexStore;
  let cwd: string;

  function callTool(toolName: string, args: Record<string, unknown> = {}): string {
    return handleToolCall(store, toolName, args, cwd);
  }

  beforeEach(() => {
    store = createStore().store;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-note-conflict-'));
    configureEngagementPath(path.join(cwd, '.cortex.state'));
  });

  it('reports the contested prior alongside a successful write', () => {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush validates every spooled entry before replay',
    });

    const output = callTool('cortex_note', {
      kind: 'decision',
      subject: 'spool flush',
      content: 'the flush does not validate spooled entries before replay',
    });

    // The write still succeeds — conflict is advisory, never a rejection.
    expect(output).toContain('Noted (decision[spool flush])');
    expect(output).toContain('Contested');
    expect(output).toContain('opposes 1 active decision');
    expect(output).toContain('the flush validates every spooled entry before rep');
    expect(output).toContain('cortex_resolve');
  });

  it('says nothing about conflicts when there are none', () => {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'primary store',
      content: 'use postgres for the primary store',
    });
    const output = callTool('cortex_note', {
      kind: 'decision',
      subject: 'primary store',
      content: 'use mysql for the primary store',
    });

    expect(output).toContain('Noted (decision[primary store])');
    expect(output).not.toContain('Contested');
    expect(output.split('\n')).toHaveLength(1);
  });

  it('supersedes the outgoing note even when the replacement contradicts it', () => {
    // cortex_resolve is the explicit close-out path. insertNote's auto-supersede
    // is vetoed for contradicting writes (AD-17), so this branch must set the
    // status itself — a replacement that reverses its predecessor is the
    // common case here, not an edge case.
    const first = callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    expect(first).toContain('Noted');

    const noteId = store.getNotesByKindAndSubject('decision', 'brief caching')[0]!.id;

    callTool('cortex_resolve', {
      note_id: noteId,
      status: 'superseded',
      replacement: 'we do not cache the rendered session brief between runs',
    });

    expect(store.getNote(noteId)!.status).toBe('superseded');
  });

  it('resolves the outgoing note when the replacement contradicts it', () => {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const noteId = store.getNotesByKindAndSubject('decision', 'brief caching')[0]!.id;

    callTool('cortex_resolve', {
      note_id: noteId,
      replacement: 'we do not cache the rendered session brief between runs',
    });

    expect(store.getNote(noteId)!.status).toBe('resolved');
  });
});

// ── Review regressions: transport (story 1.1, round 2) ───────────────

describe('cortex_resolve — contested subjects', () => {
  let store: CortexStore;
  let cwd: string;

  function callTool(toolName: string, args: Record<string, unknown> = {}): string {
    return handleToolCall(store, toolName, args, cwd);
  }

  function openContest(): { loser: string; winner: string } {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we do not cache the rendered session brief between runs',
    });
    const notes = store.getNotesByKindAndSubject('decision', 'brief caching');
    const loser = notes.find(note => !note.content.includes('do not'))!;
    const winner = notes.find(note => note.content.includes('do not'))!;
    expect(loser.conflict).toBe(true);
    expect(winner.conflict).toBe(true);
    return { loser: loser.id, winner: winner.id };
  }

  beforeEach(() => {
    store = createStore().store;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-resolve-contest-'));
    configureEngagementPath(path.join(cwd, '.cortex.state'));
  });

  it('refuses to resolve by subject while a contest is open', () => {
    // Before contested priors were exempted from auto-supersede, a
    // (kind, subject) pair had at most one active note, so
    // findActiveNoteBySubject's LIMIT 1 was unambiguous. With a live contest
    // it silently resolved the NEWEST — the agent's current position — leaving
    // the retracted decision as the only active one.
    const { loser, winner } = openContest();

    const output = callTool('cortex_resolve', { subject: 'brief caching' });

    expect(output).toContain('Error:');
    expect(output).toContain('2 contested notes');
    expect(output).toContain(loser);
    expect(output).toContain(winner);
    // Nothing was resolved.
    expect(store.getNote(loser)!.status).toBe('active');
    expect(store.getNote(winner)!.status).toBe('active');
  });

  it('still resolves by subject when there is no contest', () => {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'primary store',
      content: 'use postgres for the primary store',
    });
    const output = callTool('cortex_resolve', { subject: 'primary store' });
    expect(output).toContain('Marked decision[primary store] as resolved');
  });

  it('still resolves by subject with several uncontested notes on it', () => {
    // A decision plus a blocker on one subject is ordinary usage, and
    // findActiveNoteBySubject has always picked the newest. Refusing on any
    // two active notes — rather than on two CONTESTED ones — broke that
    // documented workflow. The earlier version of this test wrote a single
    // note, so it never covered the case that broke.
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'auth',
      content: 'use short lived tokens for auth',
    });
    callTool('cortex_note', {
      kind: 'blocker',
      subject: 'auth',
      content: 'the auth secret is not provisioned in ci',
    });
    const active = store.getActiveNotesBySubject('auth');
    expect(active).toHaveLength(2);
    expect(active.every(note => !note.conflict)).toBe(true);

    const output = callTool('cortex_resolve', { subject: 'auth' });
    expect(output).toContain('as resolved');
    expect(output).not.toContain('Error:');
  });

  it('does not close an unrelated contest when an uncontested note is resolved', () => {
    // Contested priors are exempt from auto-supersede, so an uncontested third
    // decision can be active alongside a live contest. Resolving it must not
    // wipe markers it has nothing to do with.
    const { loser, winner } = openContest();
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'use redis for storing rendered artifacts instead',
    });
    const third = store
      .getActiveNotesBySubject('brief caching')
      .find(note => note.content.includes('redis'))!;
    expect(third.conflict).toBe(false);

    const output = callTool('cortex_resolve', { note_id: third.id });

    expect(output).not.toContain('Contest closed');
    expect(store.getNote(loser)!.conflict).toBe(true);
    expect(store.getNote(winner)!.conflict).toBe(true);
  });

  it('clears the contest on both sides when one side is resolved', () => {
    // markConflict was the column's only writer, so the survivor rendered
    // [contested] forever against a note nobody was arguing with — and
    // cortex_note's own advice to "close it with cortex_resolve" was false.
    const { loser, winner } = openContest();

    const output = callTool('cortex_resolve', { note_id: loser });

    expect(output).toContain('Contest closed');
    expect(store.getNote(loser)!.conflict).toBe(false);
    expect(store.getNote(winner)!.conflict).toBe(false);
  });

  it('drops Conflict: true from the survivor memory item', () => {
    const { loser, winner } = openContest();
    callTool('cortex_resolve', { note_id: loser });

    const item = store.getMemoryItemBySource('notes', winner);
    expect(item?.text).not.toContain('Conflict: true');
  });

  it('says nothing about a contest when there was none', () => {
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'primary store',
      content: 'use postgres for the primary store',
    });
    const id = store.getNotesByKindAndSubject('decision', 'primary store')[0]!.id;
    const output = callTool('cortex_resolve', { note_id: id });
    expect(output).not.toContain('Contest closed');
  });

  it('never marks a conflict at all during a replacement resolve', () => {
    // The end state is also corrected by clearConflictsForSubject, so asserting
    // only on the final flag cannot tell whether detection ran. Spying on
    // markConflict pins the call site: an explicit resolution must not
    // manufacture the contest in the first place.
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const outgoing = store.getNotesByKindAndSubject('decision', 'brief caching')[0]!.id;

    const marked: string[] = [];
    const originalMark = store.markConflict.bind(store);
    store.markConflict = (id: string) => {
      marked.push(id);
      originalMark(id);
    };
    try {
      callTool('cortex_resolve', {
        note_id: outgoing,
        status: 'superseded',
        replacement: 'we do not cache the rendered session brief between runs',
      });
    } finally {
      store.markConflict = originalMark;
    }

    expect(marked).toEqual([]);
  });

  it('does not contest a replacement against the note it replaces', () => {
    // The outgoing note is still active when insertNote runs, and a
    // replacement that reverses its predecessor is the common shape here — so
    // detection fired and permanently flagged a brand-new note as contested
    // with one the same call had just retired.
    callTool('cortex_note', {
      kind: 'decision',
      subject: 'brief caching',
      content: 'we cache the rendered session brief between runs',
    });
    const outgoing = store.getNotesByKindAndSubject('decision', 'brief caching')[0]!.id;

    callTool('cortex_resolve', {
      note_id: outgoing,
      status: 'superseded',
      replacement: 'we do not cache the rendered session brief between runs',
    });

    const replacement = store
      .getNotesByKindAndSubject('decision', 'brief caching')
      .find(note => note.content.includes('do not'))!;
    expect(replacement.conflict).toBe(false);
    expect(store.getNote(outgoing)!.status).toBe('superseded');
  });
});

describe('cortex_note — the conflict block is bounded', () => {
  let store: CortexStore;
  let cwd: string;

  beforeEach(() => {
    store = createStore().store;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-note-budget-'));
    configureEngagementPath(path.join(cwd, '.cortex.state'));
  });

  it('caps how many contested priors a single write reports', () => {
    // Contested priors are exempt from auto-supersede, so several can be
    // active on one subject at once and the block would grow without limit.
    const sessionId = store.createSession({ scopeKey: null }).id;
    for (let i = 0; i < 5; i++) {
      const note = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'brief caching',
        content: `we cache the rendered session brief between runs variant ${i}`,
      });
      store.markConflict(note.id);
    }

    const output = handleToolCall(
      store,
      'cortex_note',
      {
        kind: 'decision',
        subject: 'brief caching',
        content: 'we do not cache the rendered session brief between runs',
      },
      cwd,
    );

    const bulletLines = output.split('\n').filter(line => line.startsWith('  - '));
    expect(bulletLines.length).toBeLessThanOrEqual(3);
    expect(output).toContain('more (cortex_recall for the rest)');
  });
});
