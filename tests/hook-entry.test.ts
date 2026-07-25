import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleHookPayload } from '../src/transports/hook-entry.js';
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
