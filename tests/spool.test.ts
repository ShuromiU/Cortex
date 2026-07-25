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

  it('attributes each entry in a mixed batch to the session matching its agent_id', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    appendSpoolEntry(root, { tool: 'read', file: 'src/primary.ts', ts: '2026-06-10T10:00:00Z', seq: 1 });
    appendSpoolEntry(root, {
      tool: 'read', file: 'src/agent-one.ts', ts: '2026-06-10T10:00:01Z', seq: 2,
      agent_id: 'agent-1', agent_type: 'Explore',
    });
    appendSpoolEntry(root, {
      tool: 'edit', file: 'src/agent-two.ts', ts: '2026-06-10T10:00:02Z', seq: 3,
      agent_id: 'agent-2', agent_type: 'general-purpose',
    });
    appendSpoolEntry(root, {
      tool: 'read', file: 'src/agent-one-again.ts', ts: '2026-06-10T10:00:03Z', seq: 4,
      agent_id: 'agent-1',
    });

    expect(flushSpool(store, root, sessionId)).toEqual({ processed: 4, skipped: 0 });

    const children = store.getChildSessions(sessionId);
    expect(children).toHaveLength(2);

    const primary = store.getSession(sessionId)!;
    const one = store.getSessionByAgentId(primary.scope_key!, 'agent-1')!;
    const two = store.getSessionByAgentId(primary.scope_key!, 'agent-2')!;

    expect(one.agent_type).toBe('Explore');
    expect(two.agent_type).toBe('general-purpose');
    expect(store.getEventsBySession(sessionId).map(event => event.target)).toEqual([
      'src/primary.ts',
    ]);
    expect(store.getEventsBySession(one.id).map(event => event.target)).toEqual([
      'src/agent-one.ts',
      'src/agent-one-again.ts',
    ]);
    expect(store.getEventsBySession(two.id).map(event => event.target)).toEqual([
      'src/agent-two.ts',
    ]);
  });

  it('replaying an agent batch produces identical state', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    const lines = [
      '{"v":1,"ts":"2026-06-10T10:00:00Z","tool":"read","file":"src/a.ts"}',
      '{"v":1,"ts":"2026-06-10T10:00:01Z","tool":"read","file":"src/b.ts","agent_id":"agent-1","agent_type":"Explore"}',
      '',
    ].join('\n');

    fs.writeFileSync(deriveSpoolPath(root), lines);
    expect(flushSpool(store, root, sessionId).processed).toBe(2);

    fs.writeFileSync(deriveSpoolPath(root), lines);
    expect(flushSpool(store, root, sessionId).processed).toBe(0);

    expect(store.getChildSessions(sessionId)).toHaveLength(1);
    expect(store.getEventsBySession(sessionId)).toHaveLength(1);
    const child = store.getChildSessions(sessionId)[0]!;
    expect(store.getEventsBySession(child.id)).toHaveLength(1);
  });

  it('attributes an entry to its child even after the parent session has ended', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    // First batch creates the child, then the whole tree is ended.
    appendSpoolEntry(root, {
      tool: 'read', file: 'src/first.ts', ts: '2026-06-10T10:00:00Z', seq: 1,
      agent_id: 'agent-1', agent_type: 'Explore',
    });
    flushSpool(store, root, sessionId);
    store.endSessionTree(sessionId);

    const primary = store.getSession(sessionId)!;
    const child = store.getSessionByAgentId(primary.scope_key!, 'agent-1')!;
    expect(store.getSession(child.id)?.status).toBe('ended');

    // A late line for the same subagent still lands on it, and does not throw.
    appendSpoolEntry(root, {
      tool: 'read', file: 'src/late.ts', ts: '2026-06-10T10:05:00Z', seq: 2,
      agent_id: 'agent-1',
    });
    expect(() => flushSpool(store, root, sessionId)).not.toThrow();

    expect(store.getChildSessions(sessionId)).toHaveLength(1);
    expect(store.getEventsBySession(child.id).map(event => event.target)).toEqual([
      'src/first.ts',
      'src/late.ts',
    ]);
  });

  it('keeps command-failure episodes with the session that recorded them, in either order', () => {
    const failure = {
      tool: 'cmd' as const,
      cmd: 'npm test',
      exit: '1',
      stderr: 'FAIL src/db/store.test.ts',
    };

    // Subagent fails FIRST — the parent's later identical failure must still
    // produce the parent's own episode rather than folding into the child's.
    const childFirst = tempRoot();
    {
      const { store, sessionId } = createStore(childFirst);
      appendSpoolEntry(childFirst, { ...failure, ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'a1' });
      appendSpoolEntry(childFirst, { ...failure, ts: '2026-06-10T10:00:05Z', seq: 2 });
      flushSpool(store, childFirst, sessionId);

      const child = store.getChildSessions(sessionId)[0]!;
      expect(store.getEpisodesBySession(sessionId)).toHaveLength(1);
      expect(store.getEpisodesBySession(child.id)).toHaveLength(1);
    }

    // Parent fails first — same outcome, mirrored.
    const parentFirst = tempRoot();
    {
      const { store, sessionId } = createStore(parentFirst);
      appendSpoolEntry(parentFirst, { ...failure, ts: '2026-06-10T10:00:00Z', seq: 1 });
      appendSpoolEntry(parentFirst, { ...failure, ts: '2026-06-10T10:00:05Z', seq: 2, agent_id: 'a1' });
      flushSpool(store, parentFirst, sessionId);

      const child = store.getChildSessions(sessionId)[0]!;
      expect(store.getEpisodesBySession(sessionId)).toHaveLength(1);
      expect(store.getEpisodesBySession(child.id)).toHaveLength(1);
    }
  });

  it('still folds a repeated failure within one session', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    const failure = { tool: 'cmd' as const, cmd: 'npm test', exit: '1', stderr: 'FAIL src/a.test.ts' };

    appendSpoolEntry(root, { ...failure, ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'a1' });
    appendSpoolEntry(root, { ...failure, ts: '2026-06-10T10:00:05Z', seq: 2, agent_id: 'a1' });
    flushSpool(store, root, sessionId);

    const child = store.getChildSessions(sessionId)[0]!;
    const episodes = store.getEpisodesBySession(child.id);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.summary).toContain('(seen 2x)');
  });

  it('does not create a child session for an entry it cannot replay', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    // A tool kind this build does not know — e.g. a newer hook against older dist.
    appendSpoolEntry(root, { tool: 'todo', ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'ghost' });

    expect(flushSpool(store, root, sessionId)).toEqual({ processed: 0, skipped: 1 });
    expect(store.getChildSessions(sessionId)).toHaveLength(0);
  });

  it('ends a child created under an already-ended primary', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    store.endSessionTree(sessionId);

    appendSpoolEntry(root, {
      tool: 'read', file: 'src/late.ts', ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'late',
    });
    flushSpool(store, root, sessionId);

    const child = store.getChildSessions(sessionId)[0]!;
    expect(child.status).toBe('ended');
    // Consolidation and event GC both require status = 'ended'.
    expect(store.getUnconsolidatedSessions().some(session => session.id === child.id)).toBe(true);
  });

  it('treats a numeric agent_id as the same subagent as its string form', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    fs.writeFileSync(
      deriveSpoolPath(root),
      [
        '{"v":1,"ts":"2026-06-10T10:00:00Z","tool":"read","file":"src/a.ts","agent_id":42}',
        '{"v":1,"ts":"2026-06-10T10:00:01Z","tool":"read","file":"src/b.ts","agent_id":"42"}',
        '',
      ].join('\n'),
    );
    flushSpool(store, root, sessionId);

    const children = store.getChildSessions(sessionId);
    expect(children).toHaveLength(1);
    expect(children[0]?.agent_id).toBe('42');
    expect(store.getEventsBySession(children[0]!.id)).toHaveLength(2);
  });

  it('ignores a malformed agent_type without losing the agent_id', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    fs.writeFileSync(
      deriveSpoolPath(root),
      [
        // agent_type is structured. It must be dropped, not allowed to void
        // attribution for a perfectly good agent_id.
        '{"v":1,"ts":"2026-06-10T10:00:00Z","tool":"read","file":"src/a.ts","agent_id":"g","agent_type":{"bad":1}}',
        '{"v":1,"ts":"2026-06-10T10:00:01Z","tool":"read","file":"src/b.ts","agent_id":"g"}',
        '',
      ].join('\n'),
    );
    flushSpool(store, root, sessionId);

    const children = store.getChildSessions(sessionId);
    expect(children).toHaveLength(1);
    expect(children[0]?.agent_type).toBe('subagent');
    expect(store.getEventsBySession(children[0]!.id).map(event => event.target)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(store.getEventsBySession(sessionId)).toHaveLength(0);
  });

  it('upgrades a placeholder agent_type when a later entry supplies the real one', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    appendSpoolEntry(root, { tool: 'read', file: 'src/a.ts', ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'a9' });
    appendSpoolEntry(root, {
      tool: 'read', file: 'src/b.ts', ts: '2026-06-10T10:00:01Z', seq: 2,
      agent_id: 'a9', agent_type: 'Explore',
    });
    flushSpool(store, root, sessionId);

    const children = store.getChildSessions(sessionId);
    expect(children).toHaveLength(1);
    expect(children[0]?.agent_type).toBe('Explore');
  });

  it('attributes a subagent command run to the child session', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    appendSpoolEntry(root, {
      tool: 'cmd', cmd: 'npm test', exit: '1', stderr: 'FAIL src/db/store.test.ts',
      ts: '2026-06-10T10:00:00Z', seq: 1, agent_id: 'agent-1', agent_type: 'Explore',
    });
    flushSpool(store, root, sessionId);

    const child = store.getChildSessions(sessionId)[0]!;
    expect(child.agent_id).toBe('agent-1');
    expect(store.getCommandRunsBySession(child.id)).toHaveLength(1);
    expect(store.getCommandRunsBySession(sessionId)).toHaveLength(0);
  });

  it('replays legacy spool lines into the session it was given, idempotently', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);

    // Lines written by a hook installed before agent identity existed. The
    // spool format has no agent field in any version, so this pins the replay
    // contract only; the resolution half of AC 5 — a payload with no agent_id
    // resolving to the primary — is asserted in tests/hook-entry.test.ts.
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
