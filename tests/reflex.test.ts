import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleCmdEvent } from '../src/capture/hooks.js';
import { reflectMemory } from '../src/query/reflex.js';

function createTestStore(): { store: CortexStore; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');

  const store = new CortexStore(db);
  const session = store.createSession({
    focus: 'cortex',
    gitRoot: '/repo/.git',
    worktreePath: '/repo',
    branchRef: 'feature/living-brain',
    headOid: 'abc123',
    scopeType: 'branch',
    scopeKey: 'branch:/repo/.git:/repo:feature/living-brain',
  });

  return { store, sessionId: session.id };
}

function parseHookJson(raw: string): string {
  const parsed = JSON.parse(raw) as {
    hookSpecificOutput?: {
      additionalContext?: string;
    };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

describe('reflectMemory', () => {
  it('returns hook JSON for a high-confidence remembered file and dedups the focus', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const { store, sessionId } = createTestStore();
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'src/db/store.ts',
        content: 'Keep memory_items as the canonical retrieval layer in src/db/store.ts.',
      });

      const first = reflectMemory(store, {
        event: 'edit',
        file: 'src/db/store.ts',
        sessionId,
        stateDir,
      });
      const second = reflectMemory(store, {
        event: 'edit',
        file: 'src/db/store.ts',
        sessionId,
        stateDir,
      });

      expect(first).not.toBe('');
      expect(parseHookJson(first)).toContain('Decision [2026-06-06 05:18Z]: [src/db/store.ts]');
      expect(parseHookJson(first)).toContain('canonical retrieval layer');
      expect(parseHookJson(first)).toContain('Cortex memory');
      expect(second).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent for anchors without strong prior memory', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'src/query/retrieval.ts',
      content: 'Tune retrieval thresholds carefully.',
    });

    const result = reflectMemory(store, {
      event: 'edit',
      file: 'src/no-history.ts',
      sessionId,
      stateDir,
    });

    expect(result).toBe('');
  });

  it('surfaces prior command failures for matching command anchors', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

    handleCmdEvent(store, sessionId, {
      cmd: 'npm run test',
      exit: '1',
      stderr: 'vitest failed because retrieval logs were missing result ids',
    });

    const result = reflectMemory(store, {
      event: 'cmd',
      cmd: 'npm run test',
      sessionId,
      stateDir,
    });

    expect(result).not.toBe('');
    expect(parseHookJson(result)).toContain('npm run test');
    expect(parseHookJson(result)).toContain('retrieval logs');
  });

  it('stays silent for vague continuation prompts even when generic words match memory', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'pulse all-project hub foundation fix',
      content: 'Implemented Pulse foundation fix with active project records and the reports panel scope.',
    });

    const result = reflectMemory(store, {
      event: 'prompt',
      prompt: 'Continue with the fix',
      sessionId,
      stateDir,
    });

    expect(result).toBe('');
  });

  it('stays silent for prompt text even when distinctive terms match memory', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'pulse all-project hub foundation fix',
      content: 'Implemented Pulse foundation fix with active project records and the reports panel scope.',
    });

    const result = reflectMemory(store, {
      event: 'prompt',
      prompt: 'Continue Pulse all-project hub foundation fix',
      sessionId,
      stateDir,
    });

    expect(result).toBe('');
  });

  it('does not surface resolved blocker notes for matching command anchors', () => {
    const { store, sessionId } = createTestStore();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-'));

    const note = store.insertNote({
      sessionId,
      kind: 'blocker',
      subject: 'npm-run-test-missing',
      content: '`npm run test` does not exist as a script in package.json.',
    });
    store.updateNoteStatus(note.id, 'resolved');

    const result = reflectMemory(store, {
      event: 'cmd',
      cmd: 'npm run test',
      sessionId,
      stateDir,
    });

    expect(result).toBe('');
  });
});
