import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleHookPayload } from '../src/transports/hook-entry.js';
import {
  resolveAgentSessionId,
  SUBAGENT_START_COUNT_KEY,
  SUBAGENT_START_KEY,
} from '../src/scope/runtime.js';
import { configureEngagementPath, handleToolCall, writeEngagement } from '../src/transports/mcp.js';

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

function parseAdditionalContext(raw: string): string {
  if (!raw) {
    return '';
  }
  const parsed = JSON.parse(raw) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

describe('handleHookPayload', () => {
  it('emits prompt consult gate without leaking matching memory facts', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
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
      JSON.stringify({ prompt: 'Resume the living brain reflex implementation' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );
    const context = parseAdditionalContext(output);

    expect(context).toContain('Cortex may have prior context');
    expect(context).toContain('cortex_recall(topic)');
    expect(context).toContain('cortex_state');
    expect(context).not.toContain('living brain reflex should stay whisper-only');
  });

  it('fires the prompt consult gate at most once per session', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

    const first = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Resume the dashboard work' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );
    const second = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Continue the dashboard work' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(parseAdditionalContext(first)).toContain('Cortex may have prior context');
    expect(second).toBe('');
  });

  it('does not gate PreToolUse tool calls', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

    const output = handleHookPayload(
      store,
      'reflect-pre',
      JSON.stringify({
        tool_name: 'functions.shell_command',
        tool_input: { command: 'npm run test' },
      }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(output === '' || !output.includes('Cortex may have prior context')).toBe(true);
    expect(output).not.toContain('consult');
  });

  it('does not emit prompt consult gate after Cortex was explicitly consulted', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

    handleToolCall(store, 'cortex_route', {}, cwd);

    const output = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Resume the dashboard work' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('keeps prompt consult gate silent when Cortex is disengaged', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));
    configureEngagementPath(cwd);
    writeEngagement('enabled', 'false');

    const output = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Resume the dashboard work' }),
      cwd,
      { sessionId, stateDir },
    );

    expect(output).toBe('');
  });

  it('keeps trivial new-work prompts silent when no scope history exists', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

    const output = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'What is the current time?' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(output).toBe('');
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

  it('attributes a payload carrying agent_id to a child session, not the parent', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-agent-'));

    handleHookPayload(
      store,
      'post',
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: 'src/subagent-read.ts' },
        agent_id: 'agent-xyz',
        agent_type: 'Explore',
      }),
      cwd,
      { requireEngagement: false },
    );

    const primary = store.getCurrentSession()!;
    const child = store.getSessionByAgentId(primary.scope_key!, 'agent-xyz');
    expect(child).toBeDefined();
    expect(child!.parent_session_id).toBe(primary.id);
    expect(child!.agent_type).toBe('Explore');

    expect(
      store.getEventsBySession(child!.id).map(event => event.target),
    ).toEqual(['src/subagent-read.ts']);
    expect(store.getEventsBySession(primary.id)).toHaveLength(0);
  });

  it('attributes a payload without agent_id to the primary session', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-primary-'));

    handleHookPayload(
      store,
      'post',
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: 'src/primary-read.ts' },
      }),
      cwd,
      { requireEngagement: false },
    );

    const primary = store.getCurrentSession()!;
    expect(primary.agent_id).toBeNull();
    expect(
      store.getEventsBySession(primary.id).map(event => event.target),
    ).toEqual(['src/primary-read.ts']);
    expect(store.getChildSessions(primary.id)).toHaveLength(0);
  });
});

describe('end-of-turn nudge — subagent evidence', () => {
  it('finds candidates recorded by a subagent session, not just the primary', () => {
    // Deliberately no pre-created session: the first hook call establishes the
    // primary from `cwd`, so both calls resolve the same one. A fixture session
    // scoped elsewhere would make the non-agent end-of-turn call rotate the
    // primary and correctly end its children, which is a different behavior.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, '/repo');
    const store = new CortexStore(db);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-agent-'));

    // No options.sessionId: that short-circuits resolution, and the point here
    // is to exercise the real identity path. A failing command captured against
    // a subagent's own session is the only situation the nudge fires in, and
    // the one it used to be blind to.
    handleHookPayload(
      store,
      'post',
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exit_code: 1, stderr: 'FAIL src/db/store.test.ts' },
        agent_id: 'agent-nudge',
        agent_type: 'Explore',
      }),
      cwd,
      { requireEngagement: false },
    );

    const primary = store.getCurrentSession()!;
    const child = store.getSessionByAgentId(primary.scope_key!, 'agent-nudge')!;
    expect(store.getCommandRunsBySession(child.id)).toHaveLength(1);
    expect(store.getCommandRunsBySession(primary.id)).toHaveLength(0);

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ agent_used: true }),
      cwd,
      { requireEngagement: false },
    );

    const parsed = JSON.parse(output) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('candidate notes from this turn');
  });
});

describe('end-of-turn nudge', () => {
  it('stays silent when no agent ran this turn', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-'));

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({}),
      cwd,
      { sessionId, requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('stays silent when an agent ran but no high-confidence suggestions exist', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-'));

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('blocks once with embedded suggestions when an agent ran and candidates exist', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-'));

    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Decided to route all retrieval through the reference validator.',
    });

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );

    const parsed = JSON.parse(output) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('- decision: ');
    expect(parsed.reason).toContain('reference validator');
    expect(parsed.reason).toContain('cortex_note');
  });

  it('respects the stop_hook_active loop guard', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-'));

    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Decided to route all retrieval through the reference validator.',
    });

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ agent_used: true, stop_hook_active: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('can be disabled with CORTEX_STOP_NUDGE=off', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eot-'));

    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Decided to route all retrieval through the reference validator.',
    });

    process.env['CORTEX_STOP_NUDGE'] = 'off';
    try {
      const output = handleHookPayload(
        store,
        'end-of-turn',
        JSON.stringify({ agent_used: true }),
        cwd,
        { sessionId, requireEngagement: false },
      );
      expect(output).toBe('');
    } finally {
      delete process.env['CORTEX_STOP_NUDGE'];
    }
  });
});

// ── subagent-start (FR-17, Story 5.1) ───────────────────────────────
//
// The measured `SubagentStart` payload is exactly seven fields — no dispatch
// description, no tool input — so every fixture here uses only what the host
// actually sends. Fixtures deliberately do NOT pass `options.sessionId`: this
// action's whole purpose is to resolve a session of its own, and supplying one
// would short-circuit the code under test.
function subagentStartPayload(
  agentId: string,
  agentType?: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'host-session-id',
    transcript_path: '/transcripts/host-session-id.jsonl',
    cwd: '/repo',
    prompt_id: 'prompt-1',
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    ...(agentType ? { agent_type: agentType } : {}),
    ...extra,
  });
}

describe('handleHookPayload subagent-start', () => {
  it('creates a child session recording parent, agent id, agent type and the parent scope key', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    const output = handleHookPayload(
      store,
      'subagent-start',
      subagentStartPayload('agent-alpha', 'general-purpose'),
      cwd,
      { requireEngagement: false },
    );

    // N-1: this channel says nothing. Story 5.2 owns the brief.
    expect(output).toBe('');

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-alpha');
    expect(child).toBeDefined();
    expect(child!.parent_session_id).toBe(parent.id);
    expect(child!.agent_id).toBe('agent-alpha');
    expect(child!.agent_type).toBe('general-purpose');
    expect(child!.scope_key).toBe(parent.scope_key);
  });

  it('reuses the same child when the host fires twice for one agent id (N-7)', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;
    const before = store.getSessionCount();

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha', 'Explore'), cwd, {
      requireEngagement: false,
    });
    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha', 'Explore'), cwd, {
      requireEngagement: false,
    });

    expect(store.getSessionCount()).toBe(before + 1);
    expect(store.getChildSessions(parent.id)).toHaveLength(1);
  });

  it('creates one child per agent id when two subagents start together', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha', 'Explore'), cwd, {
      requireEngagement: false,
    });
    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-bravo', 'Explore'), cwd, {
      requireEngagement: false,
    });

    const children = store.getChildSessions(parent.id);
    expect(children).toHaveLength(2);
    expect(children.map(c => c.agent_id).sort()).toEqual(['agent-alpha', 'agent-bravo']);
  });

  it('accepts the camelCase spellings the host may drift to', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    handleHookPayload(
      store,
      'subagent-start',
      JSON.stringify({ cwd: '/repo', agentId: 'agent-camel', agentType: 'Explore' }),
      cwd,
      { requireEngagement: false },
    );

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-camel');
    expect(child?.agent_type).toBe('Explore');
  });

  it('defaults agent_type when the host sends an id but no type', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-typeless'), cwd, {
      requireEngagement: false,
    });

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-typeless');
    expect(child?.agent_type).toBe('subagent');
  });

  // The one case where the obvious implementation is actively wrong: a bare
  // `resolveSessionId` would resolve OR CREATE a primary as a side effect of a
  // subagent event, and rotate the real one if `cwd` resolved elsewhere.
  it('creates nothing at all when the payload carries no agent id', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const before = store.getSessionCount();

    const output = handleHookPayload(
      store,
      'subagent-start',
      JSON.stringify({ cwd: '/repo', hook_event_name: 'SubagentStart' }),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
    expect(store.getSessionCount()).toBe(before);
  });

  it('creates nothing when the agent id is present but not a string', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const before = store.getSessionCount();

    handleHookPayload(
      store,
      'subagent-start',
      JSON.stringify({ cwd: '/repo', agent_id: 12345 }),
      cwd,
      { requireEngagement: false },
    );

    expect(store.getSessionCount()).toBe(before);
  });

  // AC #3, Node half. The bash half is covered in tests/capture-hook.test.ts.
  it('creates nothing when Cortex is disengaged for the project', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-off-'));
    const before = store.getSessionCount();

    configureEngagementPath(cwd);
    writeEngagement('enabled', 'false');

    const output = handleHookPayload(
      store,
      'subagent-start',
      subagentStartPayload('agent-disengaged', 'Explore'),
      cwd,
      {},
    );

    expect(output).toBe('');
    expect(store.getSessionCount()).toBe(before);
  });

  it('records an observability marker so a dead path cannot look like an idle one', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));

    expect(store.getMeta(SUBAGENT_START_KEY)).toBeUndefined();

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha', 'Explore'), cwd, {
      requireEngagement: false,
    });

    const marker = store.getMeta(SUBAGENT_START_KEY);
    expect(marker).toBeDefined();
    expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Seeded with a distant value rather than compared across two live fires.
  // The obvious form — fire twice, assert the marker did not move — is flaky
  // by construction: `toISOString()` has millisecond resolution, so two
  // back-to-back fires can produce an identical stamp and the write-once guard
  // survives being deleted. Measured: that shape SURVIVED the mutation campaign.
  it('never moves the marker once it is set', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));

    store.setMeta(SUBAGENT_START_KEY, '2020-01-01T00:00:00.000Z');

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha'), cwd, {
      requireEngagement: false,
    });

    expect(store.getMeta(SUBAGENT_START_KEY)).toBe('2020-01-01T00:00:00.000Z');
    // The fire still happened — otherwise this would pass with the whole path
    // deleted.
    expect(store.getMeta(SUBAGENT_START_COUNT_KEY)).toBe('1');
  });

  it('counts every fire, so doctor can see dispatches the hook missed', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha'), cwd, {
      requireEngagement: false,
    });
    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-bravo'), cwd, {
      requireEngagement: false,
    });

    expect(store.getMeta(SUBAGENT_START_COUNT_KEY)).toBe('2');
  });

  // Also pins that the fire path goes through the ATOMIC counter and not a
  // read-modify-write. The two differ observably on a non-integer value: a JS
  // `Number('3.7')` floors to 3 and continues from 4, while the SQL digit guard
  // refuses it and restarts at 1. Without this, reverting `recordSubagentStart`
  // to read-modify-write passes every other test — measured: that mutation
  // SURVIVED the campaign until this case was added.
  it('restarts the count from a corrupt value, through the atomic counter', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));

    for (const corrupt of ['12 fires', '3.7', ' 5']) {
      store.setMeta(SUBAGENT_START_COUNT_KEY, corrupt);
      handleHookPayload(store, 'subagent-start', subagentStartPayload(`agent-${corrupt}`), cwd, {
        requireEngagement: false,
      });
      expect(store.getMeta(SUBAGENT_START_COUNT_KEY), `corrupt value ${JSON.stringify(corrupt)}`).toBe(
        '1',
      );
    }
  });

  // A fire can FIND a child rather than create one: `getSessionByAgentId` is
  // unfiltered by parent and status, so a recycled agent id resolves to a row
  // from an earlier primary. Stamping that row's birthday back-dates the marker
  // and sweeps the entire pre-feature history into doctor's window — the false
  // warn the marker exists to prevent, entering by a different door.
  it('stamps the marker with now, not with a reused child’s birthday', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    // A child from long ago that a recycled agent id will resolve to.
    store.createSession({
      parentSessionId: parent.id,
      agentId: 'recycled-agent',
      agentType: 'general-purpose',
      scopeType: 'branch',
      scopeKey: parent.scope_key!,
    });
    store.db
      .prepare(`UPDATE sessions SET started_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = ?`)
      .run('recycled-agent');

    handleHookPayload(store, 'subagent-start', subagentStartPayload('recycled-agent'), cwd, {
      requireEngagement: false,
    });

    const marker = store.getMeta(SUBAGENT_START_KEY)!;
    expect(marker.startsWith('2026-01-01')).toBe(false);
    // And it really is a fresh stamp, not merely a different old one.
    expect(new Date(marker).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  // Two subagents start ~800 ms apart as separate OS processes on separate
  // connections. `busy_timeout` serialises writes; it does not make
  // read-then-write atomic, so a read-modify-write loses increments — and each
  // loss is permanent, latching doctor to a warn for the life of the store.
  it('increments the fire count atomically across two connections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-race-'));
    const dbPath = path.join(dir, 'cortex.db');

    const dbA = new Database(dbPath);
    dbA.pragma('foreign_keys = ON');
    applySchema(dbA);
    initializeMeta(dbA, '/repo');
    const a = new CortexStore(dbA);
    const b = new CortexStore(new Database(dbPath));

    a.setMeta(SUBAGENT_START_COUNT_KEY, '5');

    // Interleaved exactly as two hook processes can run: both would read 5.
    a.incrementMetaCounter(SUBAGENT_START_COUNT_KEY);
    b.incrementMetaCounter(SUBAGENT_START_COUNT_KEY);

    expect(a.getMeta(SUBAGENT_START_COUNT_KEY)).toBe('7');
  });

  it('starts a counter that does not exist yet, and restarts a corrupt one', () => {
    const { store } = createTestStore();
    store.incrementMetaCounter(SUBAGENT_START_COUNT_KEY);
    expect(store.getMeta(SUBAGENT_START_COUNT_KEY)).toBe('1');

    // A bare SQL CAST parses a numeric PREFIX, which is the `parseInt` trap
    // arriving through SQL. Every one of these must restart at 1, not continue
    // from a prefix.
    for (const corrupt of ['many', '12 fires', '1e9', '-4', '3.7', ' 5', '']) {
      store.setMeta(SUBAGENT_START_COUNT_KEY, corrupt);
      store.incrementMetaCounter(SUBAGENT_START_COUNT_KEY);
      expect(store.getMeta(SUBAGENT_START_COUNT_KEY), `corrupt value ${JSON.stringify(corrupt)}`).toBe(
        '1',
      );
    }
  });

  // Task 2 ticks a box saying nothing may escape onto the turn, and the wrapper
  // script promises it prints nothing and exits 0. `main()` guards only the
  // store open, so the action's own body has to hold that promise itself.
  it('swallows a store failure instead of letting it reach the turn', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    void sessionId;

    const broken = Object.create(store) as typeof store;
    broken.getCurrentSession = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    expect(() =>
      handleHookPayload(broken, 'subagent-start', subagentStartPayload('agent-alpha'), cwd, {
        requireEngagement: false,
      }),
    ).not.toThrow();
  });

  // AC #2, pinned rather than rebuilt — Epic 0 delivered this, and Story 5.1
  // must not regress it now that children are created earlier and more often.
  //
  // MUTATION ANCHOR: deleting `AND parent_session_id IS NULL` from
  // `getRecentSessionsByScope` or `getSessionCountByScope` (src/db/store.ts)
  // must turn this red. Story 0.1's review found three tests that "assert less
  // than they claim", one of which passed byte-identically with its guard
  // deleted, so this targets the filter itself rather than a value already
  // filtered upstream.
  it('keeps a child out of the scoped session listings and counts the parent renders from', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;
    const scopeKey = parent.scope_key!;

    const countBefore = store.getSessionCountByScope(scopeKey);
    const listedBefore = store.getRecentSessionsByScope(scopeKey, 10).map(s => s.id);
    expect(listedBefore).toContain(parent.id);

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-busy', 'Explore'), cwd, {
      requireEngagement: false,
    });
    const child = store.getSessionByAgentId(scopeKey, 'agent-busy')!;
    // The child captures real activity — AC #2's "Given".
    store.insertEvent({ sessionId: child.id, type: 'read', target: 'src/a.ts' });
    store.insertEvent({ sessionId: child.id, type: 'edit', target: 'src/a.ts' });
    expect(store.getEventsBySession(child.id)).toHaveLength(2);

    // The parent's timeline is unchanged: the child is neither listed nor counted.
    expect(store.getSessionCountByScope(scopeKey)).toBe(countBefore);
    const listedAfter = store.getRecentSessionsByScope(scopeKey, 10).map(s => s.id);
    expect(listedAfter).not.toContain(child.id);
    expect(listedAfter).toEqual(listedBefore);

    // And the child owns its own events rather than the parent absorbing them.
    expect(store.getEventsBySession(parent.id)).toHaveLength(0);
  });

  // Disposal (Story 0.1's precedent: "this story creates the rows, so it owns
  // their disposal"). A subagent that captures nothing is the row this path
  // newly creates, and it must not be left active forever — an active child
  // is invisible to consolidation and to event GC, both of which require
  // `status = 'ended'`.
  it('ends a child that captured nothing when its parent ends', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-quiet', 'Explore'), cwd, {
      requireEngagement: false,
    });
    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-quiet')!;
    expect(child.status).toBe('active');
    expect(store.getEventsBySession(child.id)).toHaveLength(0);

    store.endSessionTree(parent.id);

    expect(store.getSession(child.id)!.status).toBe('ended');
    expect(store.getSession(child.id)!.ended_at).not.toBeNull();
  });

  // With no active primary there is no parent, and AC #1 requires the child to
  // record "the parent's scope_key". The permissive alternative is worse than
  // doing nothing: it mints a primary from the SUBAGENT's cwd and attaches the
  // child to a scope the parent never had.
  it('creates nothing when there is no active primary to parent to', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;
    store.endSessionTree(parent.id);
    const before = store.getSessionCount();

    const output = handleHookPayload(
      store,
      'subagent-start',
      subagentStartPayload('agent-late', 'Explore'),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
    expect(store.getSessionCount()).toBe(before);
    expect(store.getSessionByAgentId(parent.scope_key!, 'agent-late')).toBeUndefined();
  });

  // The two writers must converge: this action and the spool flush both
  // find-or-create by (scope_key, agent_id).
  it('converges with the capture path on one session per agent id', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    handleHookPayload(store, 'subagent-start', subagentStartPayload('agent-alpha', 'Explore'), cwd, {
      requireEngagement: false,
    });
    const created = store.getSessionByAgentId(parent.scope_key!, 'agent-alpha')!;

    const resolved = resolveAgentSessionId(store, parent.id, 'agent-alpha', 'Explore');

    expect(resolved).toBe(created.id);
    expect(store.getChildSessions(parent.id)).toHaveLength(1);
  });
});
