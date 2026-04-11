import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  parseLineRange,
  handleReadEvent,
  handleEditEvent,
  handleWriteEvent,
  handleCmdEvent,
  handleAgentEvent,
} from '../src/capture/hooks.js';

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

// ── parseLineRange ─────────────────────────────────────────────────────

describe('parseLineRange', () => {
  it('returns empty object for undefined', () => {
    expect(parseLineRange(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseLineRange('')).toEqual({});
  });

  it('parses valid range', () => {
    expect(parseLineRange('1-50')).toEqual({ line_start: 1, line_end: 50 });
  });

  it('parses single-line range', () => {
    expect(parseLineRange('10-10')).toEqual({ line_start: 10, line_end: 10 });
  });

  it('returns empty object for invalid format', () => {
    expect(parseLineRange('abc')).toEqual({});
    expect(parseLineRange('1')).toEqual({});
    expect(parseLineRange('-5')).toEqual({});
    expect(parseLineRange('1-')).toEqual({});
  });

  it('trims surrounding whitespace', () => {
    expect(parseLineRange('  5-20  ')).toEqual({ line_start: 5, line_end: 20 });
  });
});

// ── handleReadEvent ────────────────────────────────────────────────────

describe('handleReadEvent', () => {
  it('stores a read event with file target', () => {
    const { store, sessionId } = createStore();
    handleReadEvent(store, sessionId, { file: 'src/index.ts' });

    const events = store.getEventsBySession(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('read');
    expect(events[0]!.target).toBe('src/index.ts');
    expect(events[0]!.metadata).toEqual({});
  });

  it('stores a read event with line range in metadata', () => {
    const { store, sessionId } = createStore();
    handleReadEvent(store, sessionId, { file: 'src/index.ts', lines: '1-50' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({ line_start: 1, line_end: 50 });
  });

  it('omits metadata when lines is undefined', () => {
    const { store, sessionId } = createStore();
    handleReadEvent(store, sessionId, { file: 'README.md' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({});
  });

  it('omits metadata when lines is unparseable', () => {
    const { store, sessionId } = createStore();
    handleReadEvent(store, sessionId, { file: 'README.md', lines: 'bad' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({});
  });
});

// ── handleEditEvent ────────────────────────────────────────────────────

describe('handleEditEvent', () => {
  it('stores an edit event with file target', () => {
    const { store, sessionId } = createStore();
    handleEditEvent(store, sessionId, { file: 'src/app.ts' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('edit');
    expect(events[0]!.target).toBe('src/app.ts');
  });

  it('stores line range in metadata', () => {
    const { store, sessionId } = createStore();
    handleEditEvent(store, sessionId, { file: 'src/app.ts', lines: '10-20' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({ line_start: 10, line_end: 20 });
  });

  it('omits metadata when no lines provided', () => {
    const { store, sessionId } = createStore();
    handleEditEvent(store, sessionId, { file: 'src/app.ts' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({});
  });
});

// ── handleWriteEvent ───────────────────────────────────────────────────

describe('handleWriteEvent', () => {
  it('stores a write event with file target', () => {
    const { store, sessionId } = createStore();
    handleWriteEvent(store, sessionId, { file: 'dist/output.js' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('write');
    expect(events[0]!.target).toBe('dist/output.js');
    expect(events[0]!.metadata).toEqual({});
  });
});

// ── handleCmdEvent ─────────────────────────────────────────────────────

describe('handleCmdEvent', () => {
  it('stores a cmd event with full args', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { exit: '0', cmd: 'npm run build' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('cmd');
    expect(events[0]!.target).toBeNull();
    const meta = events[0]!.metadata;
    expect(meta.exit_code).toBe(0);
    expect(meta.category).toBe('npm');
    expect(meta.safe_summary).toBe('npm run build');
    expect(meta.files_touched).toEqual([]);
  });

  it('parses exit code as integer', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { exit: '1', cmd: 'tsc --build' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata.exit_code).toBe(1);
  });

  it('omits exit_code when exit is undefined', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { cmd: 'git status' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).not.toHaveProperty('exit_code');
  });

  it('omits cmd-derived fields when cmd is undefined', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { exit: '0' });

    const events = store.getEventsBySession(sessionId);
    const meta = events[0]!.metadata;
    expect(meta.exit_code).toBe(0);
    expect(meta).not.toHaveProperty('category');
    expect(meta).not.toHaveProperty('safe_summary');
    expect(meta).not.toHaveProperty('files_touched');
  });

  it('stores empty metadata object when all args are undefined', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {});

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('cmd');
    expect(events[0]!.metadata).toEqual({});
  });

  it('redacts secrets in safe_summary', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {
      exit: '0',
      cmd: 'deploy --token=supersecret123',
    });

    const events = store.getEventsBySession(sessionId);
    const meta = events[0]!.metadata;
    expect(meta.safe_summary).toBe('deploy --token=[REDACTED]');
    expect(meta.category).toBe('other');
  });

  it('classifies test commands', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { cmd: 'vitest run --coverage' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata.category).toBe('test');
  });

  it('extracts touched files into files_touched', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { cmd: 'tsc src/index.ts src/store.ts' });

    const events = store.getEventsBySession(sessionId);
    const meta = events[0]!.metadata;
    expect(meta.files_touched).toEqual(['src/index.ts', 'src/store.ts']);
  });
});

// ── handleAgentEvent ───────────────────────────────────────────────────

describe('handleAgentEvent', () => {
  it('stores an agent event with description', () => {
    const { store, sessionId } = createStore();
    handleAgentEvent(store, sessionId, { desc: 'Refactor auth module' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('agent');
    expect(events[0]!.metadata.description).toBe('Refactor auth module');
  });

  it('stores long description unchanged', () => {
    const { store, sessionId } = createStore();
    const longDesc = 'Implement full OAuth2 flow with refresh tokens and PKCE support';
    handleAgentEvent(store, sessionId, { desc: longDesc });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata.description).toBe(longDesc);
  });

  it('target is null for agent events', () => {
    const { store, sessionId } = createStore();
    handleAgentEvent(store, sessionId, { desc: 'some task' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.target).toBeNull();
  });
});

// ── Integration: multiple events in sequence ────────────────────────────

describe('hook handlers — integration', () => {
  it('records a realistic workflow sequence', () => {
    const { store, sessionId } = createStore();

    handleReadEvent(store, sessionId, { file: 'src/index.ts', lines: '1-100' });
    handleEditEvent(store, sessionId, { file: 'src/index.ts', lines: '42-55' });
    handleWriteEvent(store, sessionId, { file: 'src/index.ts' });
    handleCmdEvent(store, sessionId, { exit: '0', cmd: 'tsc --noEmit' });

    const events = store.getEventsBySession(sessionId);
    expect(events).toHaveLength(4);
    // Check all expected types are present (order may vary within same timestamp)
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(['cmd', 'edit', 'read', 'write']);
  });

  it('all events belong to the same session', () => {
    const { store, sessionId } = createStore();

    handleReadEvent(store, sessionId, { file: 'a.ts' });
    handleWriteEvent(store, sessionId, { file: 'b.ts' });
    handleAgentEvent(store, sessionId, { desc: 'test' });

    const events = store.getEventsBySession(sessionId);
    expect(events.every((e) => e.session_id === sessionId)).toBe(true);
  });
});
