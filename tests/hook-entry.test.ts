import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleHookPayload } from '../src/transports/hook-entry.js';

function createTestStore(): { store: CortexStore; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');

  const store = new CortexStore(db);
  const session = store.createSession({
    focus: 'hooks',
    gitRoot: '/repo/.git',
    worktreePath: '/repo',
    branchRef: 'feature/hooks',
    headOid: 'abc123',
    scopeType: 'branch',
    scopeKey: 'branch:/repo/.git:/repo:feature/hooks',
  });

  return { store, sessionId: session.id };
}

describe('handleHookPayload', () => {
  it('emits prompt reflex additionalContext from UserPromptSubmit JSON', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

    store.insertNote({
      sessionId,
      kind: 'insight',
      subject: 'living brain',
      content: 'The living brain reflex should stay whisper-only and deduped.',
    });

    const output = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Can we implement the living brain reflex?' }),
      '/repo',
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(output).toContain('"additionalContext"');
    expect(output).toContain('whisper-only');
  });

  it('logs shell command payloads through PostToolUse capture', () => {
    const { store, sessionId } = createTestStore();

    handleHookPayload(
      store,
      'post',
      JSON.stringify({
        tool_name: 'functions.shell_command',
        tool_input: { command: 'npm run test' },
        tool_response: { exit_code: 1, stderr: 'vitest failed in hook entry test' },
      }),
      '/repo',
      { sessionId, requireEngagement: false },
    );

    const runs = store.getCommandRunsBySession(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command_summary).toBe('npm run test');
    expect(runs[0]?.exit_code).toBe(1);
    expect(runs[0]?.stderr_tail).toContain('hook entry test');
  });
});
