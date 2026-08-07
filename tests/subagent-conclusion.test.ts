import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore, normalizeNoteSubject } from '../src/db/store.js';
import { HOOK_ACTIONS, handleHookPayload } from '../src/transports/hook-entry.js';
import {
  SUBAGENT_AUDITED_COUNT_KEY,
  SUBAGENT_MISPAIRED_COUNT_KEY,
} from '../src/scope/runtime.js';
import {
  CONCLUSION_SURFACED_KEY,
  SUBAGENT_CONCLUSION_KIND,
  conclusionMaxChars,
  readDispatchSidecar,
  resolveConclusionText,
} from '../src/query/subagent-conclusion.js';
import {
  MEMORY_GUARD_TOOLS,
  SHELL_MEMORY_COMMANDS,
  evaluateMemoryGuard,
  shellCommandTargetsMemory,
} from '../src/query/memory-guard.js';

const SCOPE_KEY = 'branch:/repo/.git:/repo:feature/hooks';

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
    scopeKey: SCOPE_KEY,
  });

  return { store, sessionId: session.id };
}

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-53-'));
}

function stopPayload(
  agentId: string | undefined,
  message: string | undefined,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'host-session-id',
    transcript_path: '/transcripts/host-session-id.jsonl',
    cwd: '/repo',
    prompt_id: 'prompt-1',
    hook_event_name: 'SubagentStop',
    agent_type: 'Explore',
    ...(agentId ? { agent_id: agentId } : {}),
    ...(message !== undefined ? { last_assistant_message: message } : {}),
    ...extra,
  });
}

function startPayload(agentId: string, agentType = 'Explore'): string {
  return JSON.stringify({
    session_id: 'host-session-id',
    transcript_path: '/transcripts/host-session-id.jsonl',
    cwd: '/repo',
    prompt_id: 'prompt-1',
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
  });
}

/** Create the child the way production does, through the start hook. */
function startChild(store: CortexStore, cwd: string, agentId: string): string {
  handleHookPayload(store, 'subagent-start', startPayload(agentId), cwd, {
    requireEngagement: false,
  });
  return store.getSessionByAgentId(SCOPE_KEY, agentId)!.id;
}

function conclusionsOf(store: CortexStore, sessionId: string) {
  return store
    .getEpisodesBySession(sessionId)
    .filter(episode => episode.kind === SUBAGENT_CONCLUSION_KIND);
}

// ── Task 1: no HookAction may fall through to the reflex path ────────

describe('every HookAction has its own branch (FR-19 Task 1)', () => {
  // `handleHookPayload` is a chain of `if`s ending in `return
  // reflectFromPayload(...)`, with no exhaustive switch and no `never` guard,
  // and `main()` casts `process.argv[2]` unchecked. So adding a member to
  // `HookAction` and forgetting its branch COMPILES, and every fire of that
  // action lands in the reflex path — whose else-branch maps `tool_name ===
  // 'Agent'` to the `agent` reflex and injects `additionalContext` into the
  // PARENT. The trap has been hit twice (`dispatch-pre`, `subagent-stop`).
  //
  // Iterating `HOOK_ACTIONS` is what makes the third instance impossible to
  // ship: a new member with no branch fails here without anyone remembering to
  // add a case for it.
  const REFLEX_ACTIONS = new Set([
    'reflect-prompt',
    'reflect-pre',
    'reflect-edit',
    'reflect-cmd',
    'reflect-agent',
  ]);

  /** An `Agent` tool call — the exact payload the fallthrough would speak on. */
  function agentPayload(): string {
    return JSON.stringify({
      session_id: 'host-session-id',
      transcript_path: '/transcripts/host-session-id.jsonl',
      cwd: '/repo',
      prompt_id: 'prompt-1',
      agent_id: 'agent-fallthrough',
      agent_type: 'Explore',
      tool_name: 'Agent',
      tool_input: { description: 'read ledger audit', subagent_type: 'Explore' },
    });
  }

  function seeded(): { store: CortexStore; cwd: string } {
    const { store, sessionId } = createTestStore();
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'read ledger',
      content: 'The read ledger answers unchanged-since by re-hashing, never by mtime.',
    });
    return { store, cwd: tempCwd() };
  }

  it('proves the reflex path really would speak on this payload', () => {
    // Without this the whole suite below is vacuous: if the reflex produced
    // nothing for an `Agent` payload, every action would return '' whether it
    // had a branch or not, and a missing branch would sail through.
    const { store, cwd } = seeded();
    const spoken = handleHookPayload(store, 'reflect-agent', agentPayload(), cwd, {
      requireEngagement: false,
      stateDir: tempCwd(),
    });
    expect(spoken, 'the reflex emitted nothing, so the silence assertions prove nothing').not.toBe(
      '',
    );
    expect(spoken).toContain('additionalContext');
  });

  for (const action of HOOK_ACTIONS) {
    if (REFLEX_ACTIONS.has(action)) continue;
    it(`\`${action}\` returns nothing rather than falling through to the reflex`, () => {
      const { store, cwd } = seeded();
      const output = handleHookPayload(store, action, agentPayload(), cwd, {
        requireEngagement: false,
        stateDir: tempCwd(),
      });
      expect(output, `\`${action}\` spoke: ${output}`).toBe('');
    });
  }
});

// ── AC #1: the conclusion becomes an episode on the child ────────────

describe('subagent-stop records the conclusion (AC #1)', () => {
  it('writes it as an episode on the CHILD, in the summary field', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-a');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-a', 'The retry backoff never reaches its ceiling.'),
      cwd,
      { requireEngagement: false },
    );

    const episodes = conclusionsOf(store, childId);
    expect(episodes).toHaveLength(1);
    // `summary` specifically, and not merely "somewhere on the episode":
    // `collectEvidence` reads exactly that field, so a conclusion in metadata
    // or target is invisible to every downstream surface (§ finding #3).
    expect(episodes[0]!.summary).toBe('The retry backoff never reaches its ceiling.');
    expect(episodes[0]!.metadata['source']).toBe('message');
    expect(episodes[0]!.metadata['truncated']).toBe(false);
  });

  it('writes nothing when the payload carries no agent_id', () => {
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();

    handleHookPayload(store, 'subagent-stop', stopPayload(undefined, 'Something.'), cwd, {
      requireEngagement: false,
    });

    expect(conclusionsOf(store, sessionId)).toHaveLength(0);
    expect(store.getEpisodesBySession(sessionId)).toHaveLength(0);
  });

  it('writes nothing when the resolved child belongs to a PREVIOUS primary', () => {
    // `getSessionByAgentId` filters by neither parent nor status — deliberately,
    // because Story 0.2 AC #3 needs a child to stay findable after its parent
    // ends. So a recycled `agent_id` resolves to a row from an earlier
    // conversation, reproduced and recorded in `deferred-work.md`. Writing this
    // run's conclusion there would attach it to a timeline it did not happen in.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-recycled');

    // A new primary takes over; the old child keeps pointing at the old parent.
    store.endSession(sessionId);
    store.createSession({ scopeType: 'branch', scopeKey: SCOPE_KEY });

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-recycled', 'A conclusion from the new run.'),
      cwd,
      { requireEngagement: false },
    );

    expect(conclusionsOf(store, childId)).toHaveLength(0);
  });

  it('bounds a very long message and says that it truncated', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-long');

    // ONE oversized item, not many small ones. Story 5.2's 150-token cap was
    // not a cap and its test could not tell, because a budget seeded with many
    // small items never presents the case that fails.
    const huge = 'x'.repeat(conclusionMaxChars() * 3);
    handleHookPayload(store, 'subagent-stop', stopPayload('agent-long', huge), cwd, {
      requireEngagement: false,
    });

    const episode = conclusionsOf(store, childId)[0]!;
    expect(episode.summary.length).toBeLessThanOrEqual(conclusionMaxChars());
    expect(episode.metadata['truncated']).toBe(true);
  });

  it('is idempotent: a second stop for the same agent adds nothing', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-twice');

    handleHookPayload(store, 'subagent-stop', stopPayload('agent-twice', 'First answer.'), cwd, {
      requireEngagement: false,
    });
    handleHookPayload(store, 'subagent-stop', stopPayload('agent-twice', 'Second answer.'), cwd, {
      requireEngagement: false,
    });

    const episodes = conclusionsOf(store, childId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.summary).toBe('First answer.');
  });

  it('honours stop_hook_active and records nothing while it is true', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-active');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-active', 'Loop guard.', { stop_hook_active: true }),
      cwd,
      { requireEngagement: false },
    );

    expect(conclusionsOf(store, childId)).toHaveLength(0);
  });

  it('swallows a throwing store rather than letting it reach the host', () => {
    // MUTATION ANCHOR. This is the one hook in the epic that can damage a run:
    // the host dispatches a blocking error for `SubagentStop`, so an escape
    // here can stop a subagent finishing. Removing the try/catch inside
    // `subagentStop` must turn this red.
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-throw');

    const hostile = Object.create(store) as CortexStore;
    Object.defineProperty(hostile, 'getCurrentSession', {
      value: () => {
        throw new Error('store is on fire');
      },
    });

    expect(() =>
      handleHookPayload(hostile, 'subagent-stop', stopPayload('agent-throw', 'Answer.'), cwd, {
        requireEngagement: false,
      }),
    ).not.toThrow();
  });
});

// ── The transcript fallback, and its bounds ──────────────────────────

describe('resolveConclusionText', () => {
  it('prefers last_assistant_message and never reads the transcript for it', () => {
    const resolved = resolveConclusionText('The direct answer.', '/does/not/exist.jsonl');
    expect(resolved).toEqual({ text: 'The direct answer.', truncated: false, source: 'message' });
  });

  it('falls back to the transcript tail when the message is absent', () => {
    const dir = tempCwd();
    const file = path.join(dir, 'agent-x.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ message: { role: 'user', content: 'go' } }),
        JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'From the transcript.' }] } }),
        '',
      ].join('\n'),
    );

    const resolved = resolveConclusionText(undefined, file);
    expect(resolved?.text).toBe('From the transcript.');
    expect(resolved?.source).toBe('transcript');
  });

  it('degrades to nothing for an absent, unreadable or non-JSONL transcript', () => {
    expect(resolveConclusionText(undefined, undefined)).toBeUndefined();
    expect(resolveConclusionText(undefined, '/no/such/file.jsonl')).toBeUndefined();

    const dir = tempCwd();
    const junk = path.join(dir, 'junk.jsonl');
    fs.writeFileSync(junk, 'this is not json at all\nnor is this\n');
    expect(resolveConclusionText(undefined, junk)).toBeUndefined();
  });

  it('treats an empty message as nothing to record', () => {
    expect(resolveConclusionText('   ', undefined)).toBeUndefined();
  });
});

// ── AC #1/#2 end to end: the ordering IS the feature ─────────────────

describe('a subagent that used no tools still leaves something behind', () => {
  it('produces a conclusion episode and a Stop-nudge suggestion from it', () => {
    // THE test for § finding #3. `collectEvidence` reads episode summaries,
    // events and command runs. For a child the last two are near-empty:
    // `handleReadEvent` records only a line range, so `eventText` returns '',
    // and command runs count only on a non-zero exit. So a subagent that only
    // THINKS — the case Story 5.1 exists to make visible — yields ZERO
    // suggestions unless the conclusion is written as an episode summary first.
    // Remove the Task 2 write and this goes silent while everything compiles.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-thinker');

    expect(store.getEventsBySession(childId)).toHaveLength(0);
    expect(store.getCommandRunsBySession(childId)).toHaveLength(0);

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload(
        'agent-thinker',
        'Decided to use exponential backoff with a hard ceiling in the caller.',
      ),
      cwd,
      { requireEngagement: false },
    );

    const nudge = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ cwd: '/repo', agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );

    expect(nudge, 'the Stop nudge found nothing to offer').not.toBe('');
    expect(JSON.parse(nudge).reason).toContain('backoff');
  });

  it('offers it as a SUGGESTION and writes no note and no memory item (AD-4/FR-19)', () => {
    // The AD-4 line. A subagent proposes; it does not author. If this ever
    // starts producing a `notes` row or a `memory_items` row of its own, a
    // subagent's opinion has become durable memory nobody agreed to.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-proposes');

    const notesBefore = store.getActiveNotes().length;
    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-proposes', 'Decided to use a hard ceiling enforced by the caller.'),
      cwd,
      { requireEngagement: false },
    );
    handleHookPayload(store, 'end-of-turn', JSON.stringify({ cwd: '/repo', agent_used: true }), cwd, {
      requireEngagement: false,
    });

    expect(store.getActiveNotes()).toHaveLength(notesBefore);
    expect(conclusionsOf(store, childId)).toHaveLength(1);

    // The episode half DOES project — episodes are captured, notes are
    // authored — so exactly one memory item, sourced from the episode.
    const items = store.db
      .prepare(`SELECT kind, source_table FROM memory_items WHERE kind LIKE 'episode:%'`)
      .all() as Array<{ kind: string; source_table: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe(`episode:${SUBAGENT_CONCLUSION_KIND}`);
    expect(items[0]!.source_table).toBe('episodes');
  });
});

// ── Task 3: the noise bound ──────────────────────────────────────────

describe('a conclusion is offered once, not on every later turn', () => {
  it('is not re-offered on the next turn that uses a subagent', () => {
    // `getSessionTreeIds` → `getChildSessions` is a bare SELECT with no status,
    // recency or limit filter, `suggestNotes` has no recency filter, and the
    // primary rarely rotates — `endSessionTree` fires only on a scope-key
    // change. So without a marker every conclusion re-surfaces on every later
    // turn that uses any subagent, for the life of the primary. An accepted
    // suggestion that keeps being re-offered trains the user to dismiss the
    // nudge, which is the cries-wolf half of AD-12.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-once');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-once', 'Decided to use a bounded retry ceiling.'),
      cwd,
      { requireEngagement: false },
    );

    const first = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ cwd: '/repo', agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );
    expect(first).not.toBe('');
    expect(conclusionsOf(store, childId)[0]!.metadata[CONCLUSION_SURFACED_KEY]).toBeTypeOf('string');

    const second = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ cwd: '/repo', agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );
    expect(second, 'the same conclusion was offered twice').toBe('');
  });

  it('does not consume a conclusion on a pass that surfaces nothing', () => {
    // Marking at collection time would burn a conclusion on a turn the user
    // never saw. Only a nudge that actually fires consumes one.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    const childId = startChild(store, cwd, 'agent-quiet');

    // Routine progress: `suggestNotes` filters it out, so no nudge fires.
    handleHookPayload(store, 'subagent-stop', stopPayload('agent-quiet', 'Read the file.'), cwd, {
      requireEngagement: false,
    });

    const output = handleHookPayload(
      store,
      'end-of-turn',
      JSON.stringify({ cwd: '/repo', agent_used: true }),
      cwd,
      { sessionId, requireEngagement: false },
    );
    expect(output).toBe('');
    expect(conclusionsOf(store, childId)[0]!.metadata[CONCLUSION_SURFACED_KEY]).toBeUndefined();
  });
});

// ── AC #3: the memory guard ──────────────────────────────────────────

/** A note written by an earlier session, outside the current tree. */
function seedForeignNote(
  store: CortexStore,
  kind: 'decision' | 'intent' | 'insight',
  subject: string,
  content: string,
): { noteId: string; sessionId: string } {
  const foreign = store.createSession({ scopeType: 'branch', scopeKey: SCOPE_KEY });
  const note = store.insertNote({ sessionId: foreign.id, kind, subject, content });
  store.endSession(foreign.id);
  return { noteId: note.id, sessionId: foreign.id };
}

function guardPayload(
  agentId: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  return JSON.stringify({
    session_id: 'host-session-id',
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function denial(raw: string): string | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return parsed.hookSpecificOutput?.permissionDecision === 'deny'
    ? parsed.hookSpecificOutput.permissionDecisionReason
    : undefined;
}

describe('the memory guard allows (AC #3, the half that matters most)', () => {
  it('never denies the PARENT, whose own call carries no agent_id', () => {
    // The regression that would hurt most: the parent is the acceptance path
    // AD-4 routes a subagent's findings through, and blocking it would stop the
    // user's own work with a message about subagents.
    const { store } = createTestStore();
    const cwd = tempCwd();
    seedForeignNote(store, 'decision', 'retry ceiling', 'The ceiling is sixty seconds.');

    const output = handleHookPayload(
      store,
      'guard-memory',
      guardPayload(undefined, 'mcp__cortex__cortex_note', {
        kind: 'decision',
        subject: 'retry ceiling',
        content: 'The ceiling is now thirty seconds.',
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('never denies a subagent acting on memory from its OWN session tree', () => {
    // Ruling (a). No note is ever stamped with a subagent's session id — both
    // MCP write paths resolve without identity and land on the primary — so a
    // child-id comparison would deny every subagent memory operation,
    // including on a note that subagent wrote seconds earlier.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-own');
    const own = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'retry ceiling',
      content: 'The ceiling is sixty seconds.',
    });

    const output = handleHookPayload(
      store,
      'guard-memory',
      guardPayload('agent-own', 'mcp__cortex__cortex_resolve', { note_id: own.id }),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
  });

  it('says nothing for a subagent write that supersedes nothing', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-fresh');

    const output = handleHookPayload(
      store,
      'guard-memory',
      guardPayload('agent-fresh', 'mcp__cortex__cortex_note', {
        kind: 'decision',
        subject: 'something nobody has decided',
        content: 'A brand new decision.',
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
  });
});

describe('the memory guard denies (AC #3)', () => {
  it('a subagent resolving a note from an earlier session', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-resolver');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const reason = denial(
      handleHookPayload(
        store,
        'guard-memory',
        guardPayload('agent-resolver', 'mcp__cortex__cortex_resolve', { note_id: noteId }),
        cwd,
        { requireEngagement: false },
      ),
    );

    expect(reason).toBeDefined();
    expect(reason).toContain('earlier session');
    expect(reason).toContain(noteId);
    // SM-C3: the reason must say what to do instead, not merely refuse.
    expect(reason).toContain('final message');
  });

  it('a subagent writing a decision whose subject would supersede one', () => {
    // The route the AC's own wording misses. `insertNote`'s auto-supersede
    // filters by neither session nor scope, so an ordinary `cortex_note`
    // retires every other active decision on that subject, anywhere.
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-writer');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const reason = denial(
      handleHookPayload(
        store,
        'guard-memory',
        guardPayload('agent-writer', 'mcp__cortex__cortex_note', {
          kind: 'decision',
          subject: 'Retry Ceiling',
          content: 'The ceiling should be thirty seconds instead.',
        }),
        cwd,
        { requireEngagement: false },
      ),
    );

    expect(reason).toBeDefined();
    expect(reason).toContain(noteId);
  });

  it('a subagent calling cortex_resolve with a replacement', () => {
    // The third route: the handler calls `insertNote`, so the replacement
    // carries the same scope-blind auto-supersede and a named-target check
    // alone passes it straight through.
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-replacer');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const reason = denial(
      handleHookPayload(
        store,
        'guard-memory',
        guardPayload('agent-replacer', 'mcp__cortex__cortex_resolve', {
          note_id: noteId,
          replacement: 'The ceiling is now thirty seconds.',
        }),
        cwd,
        { requireEngagement: false },
      ),
    );

    expect(reason).toBeDefined();
  });

  it('a subagent running `cortex delete-memory --yes` through Bash', () => {
    // Ruling (b). The shell reaches the same memory, and this delete is more
    // destructive than anything AC #3 names.
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-deleter');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const reason = denial(
      handleHookPayload(
        store,
        'guard-memory',
        guardPayload('agent-deleter', 'Bash', {
          command: `cortex delete-memory ${noteId} --yes`,
        }),
        cwd,
        { requireEngagement: false },
      ),
    );

    expect(reason).toBeDefined();
    expect(reason).toContain('delete');
  });

  it('a subagent rewriting an earlier session’s memory with `cortex edit-memory`', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-editor');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const reason = denial(
      handleHookPayload(
        store,
        'guard-memory',
        guardPayload('agent-editor', 'Bash', {
          // `--text` takes a value: reading the flag's argument as the id is
          // exactly the parse slip that would silently disarm this route.
          command: `cortex edit-memory --text "rewritten" ${noteId}`,
        }),
        cwd,
        { requireEngagement: false },
      ),
    );

    expect(reason).toBeDefined();
    expect(reason).toContain('rewrite');
  });

  it('allows a delete PREVIEW, which reads and changes nothing', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-previewer');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const output = handleHookPayload(
      store,
      'guard-memory',
      guardPayload('agent-previewer', 'Bash', { command: `cortex delete-memory ${noteId}` }),
      cwd,
      { requireEngagement: false },
    );

    expect(output).toBe('');
  });
});

describe('the memory guard fails OPEN (AC #3)', () => {
  // MUTATION ANCHORS, all four. A fail-closed regression blocks the user's own
  // work and is the worst outcome this story can produce.
  const cases: Array<[string, (store: CortexStore) => { store: CortexStore; payload: string }]> = [
    [
      'a throwing store',
      store => {
        const hostile = Object.create(store) as CortexStore;
        Object.defineProperty(hostile, 'getSessionTreeIds', {
          value: () => {
            throw new Error('store is on fire');
          },
        });
        return {
          store: hostile,
          payload: guardPayload('agent-open', 'mcp__cortex__cortex_resolve', {
            subject: 'retry ceiling',
          }),
        };
      },
    ],
    [
      'a target note that does not exist',
      store => ({
        store,
        payload: guardPayload('agent-open', 'mcp__cortex__cortex_resolve', {
          note_id: 'no-such-note',
        }),
      }),
    ],
    [
      'a malformed payload',
      store => ({ store, payload: '{ this is not json' }),
    ],
    [
      'a shell target built at runtime',
      store => ({
        store,
        payload: guardPayload('agent-open', 'Bash', { command: 'cortex delete-memory "$ID" --yes' }),
      }),
    ],
    [
      'an agent id the store has never seen',
      store => ({
        store,
        payload: guardPayload('agent-unknown', 'mcp__cortex__cortex_resolve', {
          subject: 'retry ceiling',
        }),
      }),
    ],
  ];

  for (const [name, build] of cases) {
    it(`allows on ${name}`, () => {
      const { store } = createTestStore();
      const cwd = tempCwd();
      startChild(store, cwd, 'agent-open');
      seedForeignNote(store, 'decision', 'retry ceiling', 'The ceiling is sixty seconds.');

      const built = build(store);
      let output = 'not-run';
      expect(() => {
        output = handleHookPayload(built.store, 'guard-memory', built.payload, cwd, {
          requireEngagement: false,
        });
      }).not.toThrow();
      expect(output, `${name} produced ${output}`).toBe('');
    });
  }
});

describe('the guard mirrors insertNote’s supersede predicate exactly', () => {
  // The story ordered this "mirrored exactly" and named three ways an earlier
  // draft got it wrong. The mirror is structural — the guard calls
  // `previewNoteWrite`, which runs `insertNote`'s own decision phase — and
  // these pin the three properties so a future re-derivation cannot drift.
  function guardTargets(
    store: CortexStore,
    agentId: string,
    input: Record<string, unknown>,
  ): string[] {
    const decision = evaluateMemoryGuard(store, {
      toolName: 'mcp__cortex__cortex_note',
      toolInput: input,
      agentId,
    });
    return decision?.targets.map(target => target.id) ?? [];
  }

  it('is same-kind only: an intent does not retire a decision', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-kind');
    seedForeignNote(store, 'decision', 'retry ceiling', 'The ceiling is sixty seconds.');

    expect(
      guardTargets(store, 'agent-kind', {
        kind: 'intent',
        subject: 'retry ceiling',
        content: 'Plan to revisit the ceiling.',
      }),
    ).toEqual([]);
  });

  it('respects the AD-17 veto: a contested prior is never a target', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-veto');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );
    store.markConflict(noteId);

    expect(
      guardTargets(store, 'agent-veto', {
        kind: 'decision',
        subject: 'retry ceiling',
        content: 'The ceiling is thirty seconds.',
      }),
    ).toEqual([]);
  });

  it('normalises the subject the way the notes table stores it', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-subject');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    expect(normalizeNoteSubject('  Retry Ceiling  ')).toBe('retry ceiling');
    expect(
      guardTargets(store, 'agent-subject', {
        kind: 'decision',
        subject: '  Retry Ceiling  ',
        content: 'The ceiling is thirty seconds.',
      }),
    ).toEqual([noteId]);
  });

  it('agrees with what the write actually does', () => {
    // The strongest form: predict, then perform, then compare. If the two ever
    // disagree the guard is denying writes that supersede nothing, or missing
    // ones that do.
    const { store, sessionId } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-agree');
    const { noteId } = seedForeignNote(
      store,
      'decision',
      'retry ceiling',
      'The ceiling is sixty seconds.',
    );

    const predicted = guardTargets(store, 'agent-agree', {
      kind: 'decision',
      subject: 'retry ceiling',
      content: 'The ceiling is thirty seconds.',
    });

    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'retry ceiling',
      content: 'The ceiling is thirty seconds.',
    });

    expect(store.getNote(noteId)!.status).toBe('superseded');
    expect(predicted).toEqual([noteId]);
  });
});

describe('the shell pre-filter', () => {
  it('screens exactly the commands the hook script screens', () => {
    for (const name of SHELL_MEMORY_COMMANDS) {
      expect(shellCommandTargetsMemory(`cortex ${name} abc`)).toBe(true);
    }
    for (const ordinary of ['npm run build', 'git status', 'ls -la', 'cortex recall retries']) {
      expect(shellCommandTargetsMemory(ordinary)).toBe(false);
    }
  });

  it('covers the three routes and nothing else', () => {
    expect([...MEMORY_GUARD_TOOLS]).toEqual([
      'mcp__cortex__cortex_note',
      'mcp__cortex__cortex_resolve',
      'Bash',
    ]);
  });

  it('is never consulted for a read-only Cortex tool', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-reader');
    seedForeignNote(store, 'decision', 'retry ceiling', 'The ceiling is sixty seconds.');

    const output = handleHookPayload(
      store,
      'guard-memory',
      guardPayload('agent-reader', 'mcp__cortex__cortex_recall', { topic: 'retry ceiling' }),
      cwd,
      { requireEngagement: false },
    );
    expect(output).toBe('');
  });
});

// ── Task 5: the pairing audit ────────────────────────────────────────

function writeSidecar(dir: string, agentId: string, toolUseId: string): string {
  const sessionDir = path.join(dir, 'host-session-id');
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
  const file = path.join(sessionDir, 'subagents', `agent-${agentId}.meta.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ agentType: 'Explore', description: 'Probe', toolUseId, spawnDepth: 1 }),
  );
  return path.join(dir, 'host-session-id.jsonl');
}

function seedConsumedDispatch(store: CortexStore, agentId: string, toolUseId: string): void {
  const dispatch = store.insertSubagentDispatch({
    scopeKey: SCOPE_KEY,
    hostSessionId: 'host-session-id',
    promptId: 'prompt-1',
    agentType: 'Explore',
    toolUseId,
    description: 'Probe',
    promptDigest: 'digest',
    promptPrefix: 'prefix',
    promptChars: 6,
  });
  store.db
    .prepare('UPDATE subagent_dispatches SET consumed_at = ?, consumed_by_agent_id = ? WHERE id = ?')
    .run(new Date().toISOString(), agentId, dispatch.id);
}

describe('the pairing audit closes Story 5.2’s deferred check (Task 5)', () => {
  it('records agreement when the sidecar names the same tool_use_id', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-audit-ok');
    seedConsumedDispatch(store, 'agent-audit-ok', 'toolu_match');
    const transcript = writeSidecar(tempCwd(), 'agent-audit-ok', 'toolu_match');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-audit-ok', 'Answer.', { transcript_path: transcript }),
      cwd,
      { requireEngagement: false },
    );

    expect(store.getMeta(SUBAGENT_AUDITED_COUNT_KEY)).toBe('1');
    expect(store.getMeta(SUBAGENT_MISPAIRED_COUNT_KEY)).toBeUndefined();
  });

  it('records a mispairing when they disagree', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-audit-bad');
    seedConsumedDispatch(store, 'agent-audit-bad', 'toolu_expected');
    const transcript = writeSidecar(tempCwd(), 'agent-audit-bad', 'toolu_actual');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-audit-bad', 'Answer.', { transcript_path: transcript }),
      cwd,
      { requireEngagement: false },
    );

    expect(store.getMeta(SUBAGENT_AUDITED_COUNT_KEY)).toBe('1');
    expect(store.getMeta(SUBAGENT_MISPAIRED_COUNT_KEY)).toBe('1');
  });

  it('records NOTHING when the sidecar cannot be read', () => {
    // An absent audit is not a failed audit. Counting it either way is the
    // false-alarm class Story 5.1's review found twice — and booking it as
    // audited would put a denominator under a fault rate never measured.
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-audit-none');
    seedConsumedDispatch(store, 'agent-audit-none', 'toolu_expected');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-audit-none', 'Answer.', {
        transcript_path: '/no/such/dir/host-session-id.jsonl',
      }),
      cwd,
      { requireEngagement: false },
    );

    expect(store.getMeta(SUBAGENT_AUDITED_COUNT_KEY)).toBeUndefined();
    expect(store.getMeta(SUBAGENT_MISPAIRED_COUNT_KEY)).toBeUndefined();
  });

  it('records nothing when the subagent consumed no dispatch at all', () => {
    const { store } = createTestStore();
    const cwd = tempCwd();
    startChild(store, cwd, 'agent-audit-solo');
    const transcript = writeSidecar(tempCwd(), 'agent-audit-solo', 'toolu_orphan');

    handleHookPayload(
      store,
      'subagent-stop',
      stopPayload('agent-audit-solo', 'Answer.', { transcript_path: transcript }),
      cwd,
      { requireEngagement: false },
    );

    expect(store.getMeta(SUBAGENT_AUDITED_COUNT_KEY)).toBeUndefined();
  });
});

describe('readDispatchSidecar', () => {
  it('reads it beside the agent transcript, the path the host actually uses', () => {
    const dir = tempCwd();
    const transcript = writeSidecar(dir, 'agent-side', 'toolu_side');
    const agentTranscript = path.join(
      dir,
      'host-session-id',
      'subagents',
      'agent-agent-side.jsonl',
    );

    expect(readDispatchSidecar(agentTranscript, undefined, 'agent-side')?.toolUseId).toBe(
      'toolu_side',
    );
    // And through the documented field, when the undocumented one is absent.
    expect(readDispatchSidecar(undefined, transcript, 'agent-side')?.toolUseId).toBe('toolu_side');
  });

  it('degrades to undefined for every failure it can meet', () => {
    const dir = tempCwd();
    expect(readDispatchSidecar(undefined, undefined, 'agent-x')).toBeUndefined();
    expect(
      readDispatchSidecar(undefined, path.join(dir, 'missing.jsonl'), 'agent-x'),
    ).toBeUndefined();

    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'subagents', 'agent-junk.meta.json'), 'not json');
    expect(
      readDispatchSidecar(undefined, path.join(dir, 'session.jsonl'), 'junk'),
    ).toBeUndefined();
  });
});
