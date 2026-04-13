import { describe, it, expect } from 'vitest';
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

function createScopedStore(): { store: CortexStore; sessionId: string; scopeKey: string } {
  const db = createTestDb();
  const store = new CortexStore(db);
  const scopeKey = 'branch:/repo/.git:/repo:feature/auth';
  const session = store.createSession({
    gitRoot: '/repo/.git',
    worktreePath: '/repo',
    branchRef: 'feature/auth',
    headOid: 'abc123',
    scopeType: 'branch',
    scopeKey,
  });
  return { store, sessionId: session.id, scopeKey };
}

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

  it('returns empty object for invalid format', () => {
    expect(parseLineRange('abc')).toEqual({});
  });

  it('trims surrounding whitespace', () => {
    expect(parseLineRange('  5-20  ')).toEqual({ line_start: 5, line_end: 20 });
  });
});

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
});

describe('handleEditEvent', () => {
  it('stores an edit event with line range', () => {
    const { store, sessionId } = createStore();
    handleEditEvent(store, sessionId, { file: 'src/app.ts', lines: '10-20' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata).toEqual({ line_start: 10, line_end: 20 });
  });

  it('refreshes the branch snapshot from activity', () => {
    const { store, sessionId, scopeKey } = createScopedStore();
    handleEditEvent(store, sessionId, { file: 'src/app.ts' });

    const snapshot = store.getBranchSnapshot(scopeKey);
    expect(snapshot).toBeDefined();
    expect(snapshot?.recent_files).toContain('src/app.ts');
  });
});

describe('handleWriteEvent', () => {
  it('stores a write event with file target', () => {
    const { store, sessionId } = createStore();
    handleWriteEvent(store, sessionId, { file: 'dist/output.js' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('write');
    expect(events[0]!.target).toBe('dist/output.js');
  });
});

describe('handleCmdEvent', () => {
  it('stores a cmd event and a command_run record', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { exit: '0', cmd: 'npm run build' });

    const events = store.getEventsBySession(sessionId);
    const runs = store.getCommandRunsBySession(sessionId);
    expect(events).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event_id).toBe(events[0]!.id);
    expect(runs[0]!.command_summary).toBe('npm run build');
    expect(runs[0]!.category).toBe('npm');
    expect(runs[0]!.exit_code).toBe(0);
  });

  it('stores empty metadata and a nullable command_run when args are missing', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {});

    const events = store.getEventsBySession(sessionId);
    const run = store.getCommandRunsBySession(sessionId)[0]!;
    expect(events[0]!.metadata).toEqual({});
    expect(run.category).toBeNull();
    expect(run.command_summary).toBeNull();
    expect(run.exit_code).toBeNull();
  });

  it('redacts secrets in safe_summary', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {
      exit: '0',
      cmd: 'deploy --token=supersecret123',
    });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.metadata.safe_summary).toBe('deploy --token=[REDACTED]');
  });

  it('extracts touched files into files_touched', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { cmd: 'tsc src/index.ts src/store.ts' });

    const run = store.getCommandRunsBySession(sessionId)[0]!;
    expect(run.files_touched).toEqual(['src/index.ts', 'src/store.ts']);
  });

  it('captures redacted stdout/stderr tails for failed test/build/git commands', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {
      exit: '1',
      cmd: 'vitest run auth.test.ts',
      stdout: 'line-1\nline-2\nTOKEN=abc123',
      stderr: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    });

    const event = store.getEventsBySession(sessionId)[0]!;
    const run = store.getCommandRunsBySession(sessionId)[0]!;
    expect(event.metadata.stdout_tail_captured).toBe(true);
    expect(event.metadata.stderr_tail_captured).toBe(true);
    expect(run.stdout_tail).toContain('TOKEN=[REDACTED]');
    expect(run.stderr_tail).toContain('Bearer [REDACTED]');
  });

  it('does not store tails for successful or non-interesting commands', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {
      exit: '0',
      cmd: 'npm run build',
      stdout: 'ok',
      stderr: 'warn',
    });

    const run = store.getCommandRunsBySession(sessionId)[0]!;
    expect(run.stdout_tail).toBeNull();
    expect(run.stderr_tail).toBeNull();
  });

  it('creates a command failure episode for failed test/build/git commands', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, {
      exit: '128',
      cmd: 'git push origin feature/auth',
      stderr: 'remote: denied',
    });

    const episodes = store.getEpisodesBySession(sessionId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('command_failure');
    expect(episodes[0]!.summary).toContain('git failed');
    expect(episodes[0]!.metadata.stderr_tail).toContain('denied');
  });

  it('creates a test_cycle episode when a failing test is followed by a passing retry', () => {
    const { store, sessionId } = createStore();
    handleCmdEvent(store, sessionId, { exit: '1', cmd: 'vitest run' });
    handleEditEvent(store, sessionId, { file: 'src/auth.ts' });
    handleCmdEvent(store, sessionId, { exit: '0', cmd: 'vitest run' });

    const episodes = store.getEpisodesBySession(sessionId);
    const cycle = episodes.find(episode => episode.kind === 'test_cycle');
    expect(cycle).toBeDefined();
    expect(cycle?.summary).toContain('fixed after 1 iteration');
    expect(cycle?.metadata.files).toEqual(['src/auth.ts']);
  });
});

describe('handleAgentEvent', () => {
  it('stores an agent event with description', () => {
    const { store, sessionId } = createStore();
    handleAgentEvent(store, sessionId, { desc: 'Refactor auth module' });

    const events = store.getEventsBySession(sessionId);
    expect(events[0]!.type).toBe('agent');
    expect(events[0]!.metadata.description).toBe('Refactor auth module');
  });
});

describe('hook handlers - integration', () => {
  it('records a realistic workflow sequence', () => {
    const { store, sessionId } = createStore();

    handleReadEvent(store, sessionId, { file: 'src/index.ts', lines: '1-100' });
    handleEditEvent(store, sessionId, { file: 'src/index.ts', lines: '42-55' });
    handleWriteEvent(store, sessionId, { file: 'src/index.ts' });
    handleCmdEvent(store, sessionId, { exit: '0', cmd: 'tsc --noEmit' });

    const events = store.getEventsBySession(sessionId);
    expect(events).toHaveLength(4);
    expect(store.getCommandRunsBySession(sessionId)).toHaveLength(1);
    const types = events.map(event => event.type).sort();
    expect(types).toEqual(['cmd', 'edit', 'read', 'write']);
  });
});
