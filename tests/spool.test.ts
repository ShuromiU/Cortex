import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  appendSpoolEntry,
  deriveSpoolPath,
  flushSpool,
  spoolSizeBytes,
} from '../src/capture/spool.js';

function createStore(root: string): { store: CortexStore; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const session = store.createSession({
    worktreePath: root,
    scopeType: 'project',
    scopeKey: `project:${root}`,
  });
  return { store, sessionId: session.id };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-spool-'));
}

describe('spool', () => {
  it('appends and flushes events into the store in order', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    appendSpoolEntry(root, { tool: 'read', file: 'src/a.ts', ts: '2026-06-10T10:00:00Z', seq: 1 });
    appendSpoolEntry(root, { tool: 'edit', file: 'src/a.ts', ts: '2026-06-10T10:00:01Z', seq: 2 });
    appendSpoolEntry(root, {
      tool: 'cmd',
      cmd: 'npm test',
      exit: '1',
      stderr: 'FAIL src/a.test.ts',
      ts: '2026-06-10T10:00:02Z',
      seq: 3,
    });
    appendSpoolEntry(root, { tool: 'agent', desc: 'explore auth', ts: '2026-06-10T10:00:03Z', seq: 4 });
    expect(spoolSizeBytes(root)).toBeGreaterThan(0);

    const result = flushSpool(store, root, sessionId);

    expect(result.processed).toBe(4);
    expect(result.skipped).toBe(0);
    expect(fs.existsSync(deriveSpoolPath(root))).toBe(false);
    expect(fs.existsSync(`${deriveSpoolPath(root)}.processing`)).toBe(false);

    const events = store.getEventsBySession(sessionId);
    expect(events.map(event => event.type)).toEqual(['read', 'edit', 'cmd', 'agent']);
    const runs = store.getCommandRunsBySession(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.exit_code).toBe(1);
  });

  it('skips corrupt lines without losing the batch', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    fs.appendFileSync(
      deriveSpoolPath(root),
      `{"v":1,"ts":"2026-06-10T10:00:00Z","tool":"read","file":"src/ok.ts"}\n` +
        `{"broken json\n` +
        `{"v":1,"ts":"2026-06-10T10:00:01Z","tool":"unknown-tool"}\n`,
    );

    const result = flushSpool(store, root, sessionId);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(store.getEventsBySession(sessionId)).toHaveLength(1);
  });

  it('recovers an orphaned .processing claim exactly once', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    const claimPath = `${deriveSpoolPath(root)}.processing`;
    fs.writeFileSync(
      claimPath,
      `{"v":1,"ts":"2026-06-10T09:00:00Z","tool":"write","file":"src/orphan.ts"}\n`,
    );

    const first = flushSpool(store, root, sessionId);
    expect(first.processed).toBe(1);
    expect(fs.existsSync(claimPath)).toBe(false);

    // Re-creating the identical claim is skipped via the processed marker.
    fs.writeFileSync(
      claimPath,
      `{"v":1,"ts":"2026-06-10T09:00:00Z","tool":"write","file":"src/orphan.ts"}\n`,
    );
    const second = flushSpool(store, root, sessionId);
    expect(second.processed).toBe(0);
    expect(store.getEventsBySession(sessionId)).toHaveLength(1);
  });

  it('flushing an empty or missing spool is a no-op', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    expect(flushSpool(store, root, sessionId)).toEqual({ processed: 0, skipped: 0 });
  });

  it('replays pre-agent-identity spool lines into the primary session', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    // Lines written by a hook installed before agent identity existed: no
    // agent_id field at all (Story 0.1 AC 5).
    fs.writeFileSync(
      deriveSpoolPath(root),
      [
        '{"v":1,"ts":"2026-06-10T09:00:00Z","tool":"read","file":"src/legacy-a.ts"}',
        '{"v":1,"ts":"2026-06-10T09:00:01Z","tool":"edit","file":"src/legacy-b.ts"}',
        '',
      ].join('\n'),
    );

    const first = flushSpool(store, root, sessionId);
    expect(first).toEqual({ processed: 2, skipped: 0 });
    expect(store.getEventsBySession(sessionId).map(event => event.target)).toEqual([
      'src/legacy-a.ts',
      'src/legacy-b.ts',
    ]);
    expect(store.getChildSessions(sessionId)).toHaveLength(0);

    // Replaying the identical batch produces identical state (N-7).
    fs.writeFileSync(
      deriveSpoolPath(root),
      [
        '{"v":1,"ts":"2026-06-10T09:00:00Z","tool":"read","file":"src/legacy-a.ts"}',
        '{"v":1,"ts":"2026-06-10T09:00:01Z","tool":"edit","file":"src/legacy-b.ts"}',
        '',
      ].join('\n'),
    );
    expect(flushSpool(store, root, sessionId).processed).toBe(0);
    expect(store.getEventsBySession(sessionId)).toHaveLength(2);
  });
});
