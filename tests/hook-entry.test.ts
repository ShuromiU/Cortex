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
  SUBAGENT_AMBIGUOUS_COUNT_KEY,
  SUBAGENT_BRIEFED_COUNT_KEY,
  SUBAGENT_PAIRED_COUNT_KEY,
  SUBAGENT_START_COUNT_KEY,
  SUBAGENT_START_KEY,
} from '../src/scope/runtime.js';
import {
  buildSubagentBrief,
  PROMPT_PREFIX_MAX_CHARS,
  SUBAGENT_BRIEF_ENV,
} from '../src/query/subagent-brief.js';
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

    // Silence, because nothing was captured for this start to pair with. Story
    // 5.2 made this channel conditional rather than mute: with no dispatch row
    // there is nothing to brief from, and N-1 makes that emit nothing at all.
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

// ── dispatch-pre and the automatic brief (FR-18, Story 5.2) ──────────
//
// `PreToolUse` on the `Agent` tool is the ONLY event carrying the dispatch
// description: `SubagentStart`'s seven fields do not include it, its sidecar is
// written strictly after every start hook returns, and the parent transcript is
// racy at that instant. So the description is captured one event early and
// consumed when the subagent starts.
function dispatchPrePayload(
  description: string,
  agentType = 'Explore',
  extra: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'host-session-id',
    transcript_path: '/transcripts/host-session-id.jsonl',
    cwd: '/repo',
    prompt_id: 'prompt-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'toolu_dispatch_1',
    tool_input: {
      description,
      prompt: 'Go and do the thing.',
      subagent_type: agentType,
      ...input,
    },
    ...extra,
  });
}

function ledgerRows(store: CortexStore): Array<{ session_id: string; type: string; tokens: number }> {
  return store.db
    .prepare('SELECT session_id, type, tokens FROM token_ledger ORDER BY rowid')
    .all() as Array<{ session_id: string; type: string; tokens: number }>;
}

function seedBriefableMemory(store: CortexStore, sessionId: string): void {
  store.insertNote({
    sessionId,
    kind: 'decision',
    subject: 'read ledger',
    content: 'The read ledger answers unchanged-since by re-hashing, never by mtime.',
  });
}

function dispatchCount(store: CortexStore): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM subagent_dispatches').get() as { n: number }).n;
}

describe('handleHookPayload dispatch-pre', () => {
  it('records the dispatch and emits nothing', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    const output = handleHookPayload(
      store,
      'dispatch-pre',
      dispatchPrePayload('trace the read ledger'),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
    expect(
      store.countPendingSubagentDispatches(
        { hostSessionId: 'host-session-id', promptId: 'prompt-1', agentType: 'Explore' },
        '1970-01-01T00:00:00.000Z',
      ),
    ).toBe(1);
  });

  // The fallthrough guard. `handleHookPayload` is a chain of `if`s ending in
  // `return reflectFromPayload(...)` and `main()` casts argv[2] unchecked, so
  // adding a `HookAction` member and forgetting its branch COMPILES — and every
  // dispatch would then inject reflex `additionalContext` into the PARENT.
  it('never produces reflex output, even with memory that matches the dispatch', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-state-'));
    seedBriefableMemory(store, sessionId);

    const output = handleHookPayload(
      store,
      'dispatch-pre',
      dispatchPrePayload('read ledger freshness'),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );

    expect(output).toBe('');
    expect(output).not.toContain('hookSpecificOutput');
    expect(ledgerRows(store)).toHaveLength(0);
  });

  it('refuses a dispatch with no explicit subagent_type rather than guessing one', () => {
    // A guessed default does not merely fail to pair: it puts a foreign row into
    // the queue for a type that IS dispatched, where FIFO hands it to a
    // legitimate subagent. Refusing costs one brief and can never mislead.
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    // Asserted on the CALL, not only on the row count. A NOT NULL column plus
    // AD-12's swallow would hide a removed guard behind an identical empty
    // table — the guard has to be shown never to reach the write.
    let attempted = 0;
    const watched = Object.create(store) as typeof store;
    watched.insertSubagentDispatch = opts => {
      attempted += 1;
      return store.insertSubagentDispatch(opts);
    };

    handleHookPayload(
      watched,
      'dispatch-pre',
      JSON.stringify({
        session_id: 'host-session-id',
        prompt_id: 'prompt-1',
        cwd: '/repo',
        tool_name: 'Agent',
        tool_input: { description: 'no type given', prompt: 'go' },
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(attempted, 'the capture was attempted without an agent type').toBe(0);
    expect(dispatchCount(store)).toBe(0);
  });

  it('ignores a tool that is not Agent, however broad the matcher becomes', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    handleHookPayload(
      store,
      'dispatch-pre',
      JSON.stringify({
        session_id: 'host-session-id',
        prompt_id: 'prompt-1',
        cwd: '/repo',
        tool_name: 'Edit',
        tool_input: { description: 'not a dispatch', subagent_type: 'Explore' },
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(dispatchCount(store)).toBe(0);
  });

  it('records the tool_use_id Story 5.3 will audit the pairing against', () => {
    // It is the ONLY thing this story ships for the clause deferred to 5.3, and
    // review found it written but never asserted: deleting the `toolUseId` line
    // from `captureDispatch` left the whole suite green, and 5.3's audit would
    // have found nothing to check.
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    handleHookPayload(store, 'dispatch-pre', dispatchPrePayload('audit me'), cwd, {
      requireEngagement: false,
    });

    const row = store.db
      .prepare('SELECT tool_use_id FROM subagent_dispatches')
      .get() as { tool_use_id: string | null };
    expect(row.tool_use_id).toBe('toolu_dispatch_1');
  });

  it('captures nothing at all when the brief is switched off', () => {
    // Reproduced in review: the off switch was checked only where the brief is
    // EMITTED, so rows still accumulated unconsumed and `doctor` then warned
    // forever on a deliberately configured install, naming a fix that repairs
    // nothing — the cries-wolf half of AD-12, through the one switch documented
    // to prevent all of this.
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    const previous = process.env[SUBAGENT_BRIEF_ENV];
    process.env[SUBAGENT_BRIEF_ENV] = 'off';
    try {
      for (let index = 0; index < 3; index += 1) {
        handleHookPayload(store, 'dispatch-pre', dispatchPrePayload(`job ${index}`), cwd, {
          requireEngagement: false,
        });
      }
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_BRIEF_ENV];
      else process.env[SUBAGENT_BRIEF_ENV] = previous;
    }

    // MUTATION ANCHOR: removing the `subagentBriefEnabled()` guard from
    // `captureDispatch` must turn this red.
    expect(dispatchCount(store)).toBe(0);
    expect(store.getMeta('subagent_dispatch_count')).toBeUndefined();
  });

  it('stores a bounded prompt summary rather than the prompt itself', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    const long = 'y'.repeat(PROMPT_PREFIX_MAX_CHARS * 2);

    handleHookPayload(
      store,
      'dispatch-pre',
      dispatchPrePayload('bounded prompt', 'Explore', {}, { prompt: long }),
      cwd,
      { requireEngagement: false },
    );

    const row = store.db
      .prepare('SELECT prompt_prefix, prompt_chars, prompt_digest FROM subagent_dispatches')
      .get() as { prompt_prefix: string; prompt_chars: number; prompt_digest: string };
    expect(row.prompt_prefix).toHaveLength(PROMPT_PREFIX_MAX_CHARS);
    expect(row.prompt_chars).toBe(long.length);
    expect(row.prompt_digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('creates no session and rotates nothing: a dispatch is not a session boundary', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    const before = store.getSessionCount();

    handleHookPayload(store, 'dispatch-pre', dispatchPrePayload('anything'), cwd, {
      requireEngagement: false,
    });

    expect(store.getSessionCount()).toBe(before);
    expect(store.getCurrentSession()?.id).toBe(sessionId);
  });

  it('swallows a store failure instead of letting it reach the turn (AD-12)', () => {
    const { store } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));

    const broken = Object.create(store) as typeof store;
    broken.insertSubagentDispatch = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    let output = 'unset';
    expect(() => {
      output = handleHookPayload(broken, 'dispatch-pre', dispatchPrePayload('boom'), cwd, {
        requireEngagement: false,
      });
    }).not.toThrow();
    expect(output).toBe('');
  });
});

describe('handleHookPayload subagent-start brief', () => {
  const dispatch = (store: CortexStore, cwd: string, description: string, agentType = 'Explore') =>
    handleHookPayload(store, 'dispatch-pre', dispatchPrePayload(description, agentType), cwd, {
      requireEngagement: false,
    });

  const start = (store: CortexStore, cwd: string, agentId: string, agentType = 'Explore') =>
    handleHookPayload(store, 'subagent-start', subagentStartPayload(agentId, agentType), cwd, {
      requireEngagement: false,
    });

  it('injects the brief through the additionalContext envelope', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    dispatch(store, cwd, 'read ledger freshness');
    const output = start(store, cwd, 'agent-alpha');

    const parsed = JSON.parse(output) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Briefing for Explore:');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('re-hashing');
  });

  it('emits nothing when the dispatch topic matches no memory (AC #2)', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    dispatch(store, cwd, 'zzqqxx nothing here matches that phrase');
    const output = start(store, cwd, 'agent-alpha');

    expect(output).toBe('');
    expect(output).not.toContain('No context found');
  });

  it('emits nothing when no dispatch was captured for this start', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    expect(start(store, cwd, 'agent-alpha')).toBe('');
  });

  it('does not pair across host windows or turns', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    handleHookPayload(
      store,
      'dispatch-pre',
      dispatchPrePayload('read ledger freshness', 'Explore', {
        session_id: 'a-different-window',
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(start(store, cwd, 'agent-alpha')).toBe('');
  });

  it('consumes each capture once, so a re-fired start says nothing twice (N-7)', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    dispatch(store, cwd, 'read ledger freshness');
    expect(start(store, cwd, 'agent-alpha')).not.toBe('');
    expect(start(store, cwd, 'agent-alpha')).toBe('');
  });

  /** Two notes with NO shared vocabulary, so each brief can only match its own. */
  const seedTwoDisjointTopics = (store: CortexStore, sessionId: string): void => {
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'zeppelin mooring',
      content: 'Zeppelin mooring decision: the mast tension is fixed at eleven.',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'quokka census',
      content: 'Quokka census decision: the island tally happens each equinox.',
    });
  };

  it('briefs both same-type siblings under the MEASURED host ordering', () => {
    // The ordering the host actually produces is strictly interleaved —
    // `PreToolUse(a) -> Start(a) -> PreToolUse(b) -> Start(b)` — so a genuine
    // same-message fan-out never has two captures pending at a start and keeps
    // both briefs. This is the evidence that refusing on ambiguity costs the
    // fan-out case nothing, which the story's original premise got backwards.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedTwoDisjointTopics(store, sessionId);

    dispatch(store, cwd, 'zeppelin mooring');
    const first = start(store, cwd, 'agent-alpha');
    dispatch(store, cwd, 'quokka census');
    const second = start(store, cwd, 'agent-bravo');

    // Disjoint vocabularies: the earlier version seeded two notes that both
    // matched both topics, so it passed under LIFO, under a swap, and even if
    // both starts got the same capture.
    expect(first).toContain('zeppelin');
    expect(first).not.toContain('quokka');
    expect(second).toContain('quokka');
    expect(second).not.toContain('zeppelin');

    expect(store.getMeta(SUBAGENT_PAIRED_COUNT_KEY)).toBe('2');
    expect(store.getMeta(SUBAGENT_BRIEFED_COUNT_KEY)).toBe('2');
    expect(store.getMeta(SUBAGENT_AMBIGUOUS_COUNT_KEY)).toBeUndefined();
  });

  it('says NOTHING when two captures could be this subagent (ruling, 2026-08-07)', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedTwoDisjointTopics(store, sessionId);

    dispatch(store, cwd, 'zeppelin mooring');
    dispatch(store, cwd, 'quokka census');

    // MUTATION ANCHOR: removing the `pending > 1` refusal must turn this red.
    expect(start(store, cwd, 'agent-alpha')).toBe('');
    expect(store.getMeta(SUBAGENT_AMBIGUOUS_COUNT_KEY)).toBe('1');
    expect(store.getMeta(SUBAGENT_PAIRED_COUNT_KEY)).toBeUndefined();
    // Nothing was consumed: draining to one would be the same guess with an
    // extra step, and which row is the orphan is exactly what is unknowable.
    expect(
      store.countPendingSubagentDispatches(
        { hostSessionId: 'host-session-id', promptId: 'prompt-1', agentType: 'Explore' },
        '1970-01-01T00:00:00.000Z',
      ),
    ).toBe(2);
  });

  it('never briefs a subagent from a dispatch the user denied (SM-C3)', () => {
    // The reproduced case, and the reason the ruling exists. An `Agent` call the
    // user denies fires `PreToolUse` and never starts; the assistant re-dispatches
    // in the SAME turn, so every key part matches and the horizon has not moved.
    // Before the ruling the real subagent opened with the denied job's topic.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedTwoDisjointTopics(store, sessionId);

    dispatch(store, cwd, 'zeppelin mooring'); // denied — never starts
    dispatch(store, cwd, 'quokka census'); // the real one
    const output = start(store, cwd, 'agent-real');

    expect(output).not.toContain('zeppelin');
    expect(output).toBe('');
  });

  it('books the pairing even when the brief generator throws (AC #4)', () => {
    // The counters must not disagree with the rows. Booking `paired` after the
    // brief left a throwing generator with the capture consumed and `paired`
    // unset — which `doctor` then reads as "nothing ever pairs".
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);
    dispatch(store, cwd, 'read ledger freshness');

    const broken = Object.create(store) as typeof store;
    broken.searchMemoryItems = () => {
      throw new Error('FTS index is corrupt');
    };
    broken.listRecentMemoryItems = () => {
      throw new Error('FTS index is corrupt');
    };

    let output = 'unset';
    expect(() => {
      output = handleHookPayload(
        broken,
        'subagent-start',
        subagentStartPayload('agent-alpha', 'Explore'),
        cwd,
        { requireEngagement: false },
      );
    }).not.toThrow();

    expect(output).toBe('');
    expect(store.getMeta(SUBAGENT_PAIRED_COUNT_KEY)).toBe('1');
    expect(store.getMeta(SUBAGENT_BRIEFED_COUNT_KEY)).toBeUndefined();
  });

  it('refuses to brief one agent twice, and leaves the sibling its capture', () => {
    // Reproduced in review: alpha briefed twice — the second time with bravo's
    // topic — bravo silent, and both injections billed to alpha.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedTwoDisjointTopics(store, sessionId);

    dispatch(store, cwd, 'zeppelin mooring');
    const first = start(store, cwd, 'agent-alpha');
    expect(first).toContain('zeppelin');

    dispatch(store, cwd, 'quokka census');
    // MUTATION ANCHOR: removing the `NOT EXISTS` clause from
    // `consumeSubagentDispatch` must turn this red.
    expect(start(store, cwd, 'agent-alpha')).toBe('');
    expect(start(store, cwd, 'agent-bravo')).toContain('quokka');
  });

  it('suppresses a brief the parent already pasted into the dispatch prompt (AC #3)', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);

    // What an explicit `cortex_brief` would have handed the parent.
    const pasted = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
    }).text;
    expect(pasted).not.toBe('');

    handleHookPayload(
      store,
      'dispatch-pre',
      dispatchPrePayload('read ledger freshness', 'Explore', {}, {
        prompt: `Context:\n${pasted}\n\nNow audit it.`,
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(start(store, cwd, 'agent-alpha')).toBe('');
    // Paired and counted, but deliberately not briefed.
    expect(store.getMeta(SUBAGENT_PAIRED_COUNT_KEY)).toBe('1');
    expect(store.getMeta(SUBAGENT_BRIEFED_COUNT_KEY)).toBeUndefined();
  });

  it('books the injection to the CHILD session, never the parent', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    const parent = store.getSession(sessionId)!;
    seedBriefableMemory(store, sessionId);

    dispatch(store, cwd, 'read ledger freshness');
    const output = start(store, cwd, 'agent-alpha');
    expect(output).not.toBe('');

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-alpha')!;
    const booked = ledgerRows(store).filter(row => row.type === 'subagent_brief');
    expect(booked).toHaveLength(1);
    // MUTATION ANCHOR: dropping the `child.id` argument from
    // `bookHookInjection` in `renderSubagentBrief` must turn this red —
    // `getCurrentSession()` is primary-only by SQL, so it would silently bill
    // every dispatch to the parent.
    expect(booked[0]!.session_id).toBe(child.id);
    expect(booked[0]!.session_id).not.toBe(parent.id);
    expect(booked[0]!.tokens).toBeGreaterThan(0);
  });

  it('leaves the parent-facing consult gate booked to the primary', () => {
    // The other half of the same fix: `bookHookInjection`'s new argument must
    // not have moved a surface that legitimately belongs to the parent.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-consult-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-consult-state-'));

    const output = handleHookPayload(
      store,
      'reflect-prompt',
      JSON.stringify({ prompt: 'Resume the previous debugging work' }),
      cwd,
      { sessionId, stateDir, requireEngagement: false },
    );
    expect(output).not.toBe('');

    const booked = ledgerRows(store).filter(row => row.type === 'consult_gate');
    expect(booked).toHaveLength(1);
    expect(booked[0]!.session_id).toBe(sessionId);
  });

  it('still creates the session when the brief half throws (AD-12)', () => {
    // Two independently guarded halves: the session is the deliverable every
    // later story depends on, the brief is an optimisation on top of it.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    const parent = store.getSession(sessionId)!;
    seedBriefableMemory(store, sessionId);
    dispatch(store, cwd, 'read ledger freshness');

    const broken = Object.create(store) as typeof store;
    broken.consumeSubagentDispatch = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    let output = 'unset';
    expect(() => {
      output = handleHookPayload(
        broken,
        'subagent-start',
        subagentStartPayload('agent-alpha', 'Explore'),
        cwd,
        { requireEngagement: false },
      );
    }).not.toThrow();

    expect(output).toBe('');
    expect(store.getSessionByAgentId(parent.scope_key!, 'agent-alpha')).toBeDefined();
    expect(store.getMeta(SUBAGENT_START_KEY)).toBeDefined();
  });

  it('is silent when the brief is switched off', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dispatch-'));
    seedBriefableMemory(store, sessionId);
    dispatch(store, cwd, 'read ledger freshness');

    const previous = process.env[SUBAGENT_BRIEF_ENV];
    process.env[SUBAGENT_BRIEF_ENV] = 'off';
    try {
      expect(start(store, cwd, 'agent-alpha')).toBe('');
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_BRIEF_ENV];
      else process.env[SUBAGENT_BRIEF_ENV] = previous;
    }
  });
});

// ── The reflex defect re-filed onto this story ───────────────────────
//
// `reflect-pre` fires on every Edit and Write INCLUDING a subagent's, and a
// subagent's `PreToolUse` carries `agent_id`. Two defects rode together, and
// `deferred-work.md` re-filed them as ONE question: the reflex was billed to the
// primary, and — because the dedupe state file is keyed by session id — a
// subagent consumed the PARENT's once-per-anchor marker, so the parent then
// edited the same file and got no reflex at all.
describe('reflex attribution for a subagent (Story 5.2, Task 6)', () => {
  const REFLEX_NOTE =
    'Never hand-edit src/db/store.ts call sites; use find_referencing_symbols first, always.';

  const editPayload = (file: string, agentId?: string): string =>
    JSON.stringify({
      cwd: '/repo',
      tool_name: 'Edit',
      tool_input: { file_path: file },
      ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'Explore' }),
    });

  it('does not let a subagent consume the parent once-per-anchor marker', () => {
    // The dedupe marker lives in a file named after the session id
    // (`statePath` in `src/query/reflex.ts`), so "who owns the marker" IS "which
    // session id resolved". Asserted on the file rather than on the parent's
    // subsequent output, because a temp `cwd` resolves to a different git scope
    // than the seeded session and would rotate the primary — a fixture artifact
    // that would have made this pass for the wrong reason.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-state-'));
    const parent = store.getSession(sessionId)!;
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'src/db/store.ts',
      content: REFLEX_NOTE,
    });

    const subagentOutput = handleHookPayload(
      store,
      'reflect-pre',
      editPayload('src/db/store.ts', 'agent-alpha'),
      cwd,
      { stateDir, requireEngagement: false },
    );
    expect(subagentOutput).not.toBe('');

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-alpha');
    expect(child, 'the subagent identity was not resolved at all').toBeDefined();

    const markerKey = (id: string): string =>
      `cortex-reflex-${id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.json`;
    const written = fs.readdirSync(stateDir);

    // MUTATION ANCHOR: removing `agentIdentity(payload)` from
    // `reflectFromPayload`'s `resolveSessionId` call must turn this red — the
    // subagent then writes the marker under a PRIMARY's id, which is exactly how
    // it consumed the parent's once-per-anchor marker and silenced it.
    expect(written).toContain(markerKey(child!.id));
    expect(written, 'the subagent wrote the parent marker').not.toContain(
      markerKey(parent.id),
    );
  });

  it('drops subagent identity when no primary is active', () => {
    // With an `agentId` and no active primary, `ensureScopedSession` falls
    // through to `ensurePrimarySession` and MINTS one from the SUBAGENT's cwd —
    // the hazard `createSubagentSession` and `dispatchPre` both refuse — and the
    // child it then creates has no `SubagentStart` fire behind it, which
    // `doctor` reads as missed dispatches. Reproduced before the guard: five
    // subagent `Edit` payloads with no start at all gave five children, zero
    // fires, and a warn whose named fix repairs nothing.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, '/repo');
    const store = new CortexStore(db);
    expect(store.getCurrentSession()).toBeUndefined();

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-state-'));

    handleHookPayload(store, 'reflect-pre', editPayload('src/db/store.ts', 'ghost-agent'), cwd, {
      stateDir,
      requireEngagement: false,
    });

    // MUTATION ANCHOR: dropping the `getCurrentSession()?.scope_key` condition
    // in `reflectFromPayload` must turn this red.
    const children = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL')
      .get() as { n: number };
    expect(children.n, 'a child was created with no primary to parent it').toBe(0);
  });

  it('bills a subagent reflex to the subagent', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-state-'));
    const parent = store.getSession(sessionId)!;
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'src/db/store.ts',
      content: REFLEX_NOTE,
    });

    handleHookPayload(store, 'reflect-pre', editPayload('src/db/store.ts', 'agent-alpha'), cwd, {
      stateDir,
      requireEngagement: false,
    });

    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-alpha');
    expect(child, 'the subagent identity was not resolved at all').toBeDefined();
    const booked = ledgerRows(store).filter(row => row.type === 'reflex');
    expect(booked).toHaveLength(1);
    expect(booked[0]!.session_id).toBe(child!.id);
  });

  it('leaves a primary own reflex on the primary', () => {
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-reflex-attr-state-'));
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'src/db/store.ts',
      content: REFLEX_NOTE,
    });

    handleHookPayload(store, 'reflect-pre', editPayload('src/db/store.ts'), cwd, {
      sessionId,
      stateDir,
      requireEngagement: false,
    });

    const booked = ledgerRows(store).filter(row => row.type === 'reflex');
    expect(booked).toHaveLength(1);
    expect(booked[0]!.session_id).toBe(sessionId);
  });
});

// ── The first child must fall inside its own window ──────────────────

describe('the subagent first-fire marker (Story 5.2 correction)', () => {
  it('precedes the child it created, so doctor counts it', () => {
    // `doctor` counts children with `started_at >= <marker>`. Stamping the
    // marker AFTER the create put it one millisecond past the child it had just
    // made, so the very first child of every store fell outside its own window
    // and the row printed a count one too low, permanently. Found by Story 5.2's
    // sandbox proof against the real rendered hook: child ...33.211Z, marker
    // ...33.212Z, "4 fired, 3 recorded" against four real children.
    const { store, sessionId } = createTestStore();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-'));
    const parent = store.getSession(sessionId)!;

    // Asserted as an ORDER OF OPERATIONS, not as a timestamp comparison. In
    // memory the marker write and the session insert land in the same
    // millisecond, so `child.started_at >= marker` holds either way — the
    // mutation campaign caught that version surviving, which is the
    // "asserts less than it claims" shape. The gap is real (1 ms, measured
    // against the rendered hook) and the ordering is what produces it.
    const order: string[] = [];
    const watched = Object.create(store) as typeof store;
    watched.setMeta = (key, value) => {
      if (key === SUBAGENT_START_KEY) order.push('marker');
      store.setMeta(key, value);
    };
    watched.createSession = opts => {
      order.push('session');
      return store.createSession(opts);
    };

    handleHookPayload(
      watched,
      'subagent-start',
      subagentStartPayload('agent-first', 'Explore'),
      cwd,
      { requireEngagement: false },
    );

    // MUTATION ANCHOR: moving `recordSubagentStart` back below
    // `ensureScopedSession` must turn this red.
    expect(order, 'the marker was stamped after the child it describes').toEqual([
      'marker',
      'session',
    ]);

    // And the comparison `doctor` actually makes, on the real rows.
    const marker = store.getMeta(SUBAGENT_START_KEY)!;
    const child = store.getSessionByAgentId(parent.scope_key!, 'agent-first')!;
    expect(child.started_at >= marker).toBe(true);
    const counted = store.db
      .prepare(
        'SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL AND started_at >= ?',
      )
      .get(marker) as { n: number };
    expect(counted.n).toBe(1);
  });
});
