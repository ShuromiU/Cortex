import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { estimateTokens } from '../src/query/retrieval.js';
import { renderMemoryLine } from '../src/query/render.js';
import {
  DEFAULT_DISPATCH_HORIZON_SECONDS,
  DISPATCH_HORIZON_ENV,
  MAX_DISPATCH_HORIZON_SECONDS,
  PROMPT_PREFIX_MAX_CHARS,
  SUBAGENT_BRIEF_BUDGET,
  SUBAGENT_BRIEF_ENV,
  briefAlreadyInPrompt,
  buildSubagentBrief,
  dispatchCutoff,
  dispatchHorizonSeconds,
  normalizeForComparison,
  subagentBriefEnabled,
  summarizeDispatchPrompt,
} from '../src/query/subagent-brief.js';
import { DEFAULT_SESSION_BRIEF_BUDGET } from '../src/query/session-brief.js';
import { runGc } from '../src/db/gc.js';

const SCOPE_KEY = 'branch:/repo/.git:/repo:feature/hooks';

function createTestStore(): { store: CortexStore; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/repo');

  const store = new CortexStore(db);
  const session = store.createSession({
    gitRoot: '/repo/.git',
    worktreePath: '/repo',
    branchRef: 'feature/hooks',
    headOid: 'abc123',
    scopeType: 'branch',
    scopeKey: SCOPE_KEY,
  });
  return { store, sessionId: session.id };
}

function retrievalLogCount(store: CortexStore): number {
  return (
    store.db.prepare('SELECT COUNT(*) AS n FROM retrieval_log').get() as { n: number }
  ).n;
}

function key(overrides: Partial<{ hostSessionId: string; promptId: string; agentType: string }> = {}) {
  return {
    hostSessionId: 'host-1',
    promptId: 'prompt-1',
    agentType: 'Explore',
    ...overrides,
  };
}

function capture(
  store: CortexStore,
  overrides: Partial<{
    hostSessionId: string;
    promptId: string;
    agentType: string;
    description: string;
    capturedAt: string;
    promptPrefix: string | null;
  }> = {},
) {
  return store.insertSubagentDispatch({
    scopeKey: SCOPE_KEY,
    hostSessionId: overrides.hostSessionId ?? 'host-1',
    promptId: overrides.promptId ?? 'prompt-1',
    agentType: overrides.agentType ?? 'Explore',
    description: overrides.description ?? 'trace the read ledger',
    ...(overrides.capturedAt === undefined ? {} : { capturedAt: overrides.capturedAt }),
    ...(overrides.promptPrefix === undefined ? {} : { promptPrefix: overrides.promptPrefix }),
  });
}

/** Far enough in the past that nothing is ever pruned by the horizon. */
const OPEN_HORIZON = '1970-01-01T00:00:00.000Z';

// ── The pairing key and its claim (AC #1) ─────────────────────────────

describe('subagent dispatch pairing', () => {
  it('claims the matching capture and marks it consumed', () => {
    const { store } = createTestStore();
    const row = capture(store);

    const claimed = store.consumeSubagentDispatch(key(), OPEN_HORIZON);
    expect(claimed?.id).toBe(row.id);
    expect(claimed?.description).toBe('trace the read ledger');
    expect(store.getSubagentDispatch(row.id)?.consumedAt).not.toBeNull();
  });

  it('does not claim a capture from another host window on the same branch', () => {
    // Two Claude windows open on one branch share a `scope_key`, so scope alone
    // does not divide them. This is what `host_session_id` buys.
    const { store } = createTestStore();
    capture(store, { hostSessionId: 'host-2' });

    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)).toBeUndefined();
  });

  it('does not claim a capture from an earlier turn', () => {
    // The dangerous mispairing: a stale capture handing a subagent context from
    // genuinely unrelated work. This is what `prompt_id` buys.
    const { store } = createTestStore();
    capture(store, { promptId: 'prompt-0' });

    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)).toBeUndefined();
  });

  it('does not claim a capture for a different agent type', () => {
    const { store } = createTestStore();
    capture(store, { agentType: 'Plan' });

    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)).toBeUndefined();
  });

  it('claims the OLDEST capture when several match, and reports the ambiguity', () => {
    // N same-type agents dispatched in one assistant message share the whole
    // key, so only dispatch order separates them. FIFO over silence, because
    // refusing here would silence exactly the fan-out where briefing is worth
    // most — and the count is what makes the assumption checkable.
    const { store } = createTestStore();
    const first = capture(store, {
      description: 'first dispatch',
      capturedAt: '2026-08-06T10:00:00.000Z',
    });
    const second = capture(store, {
      description: 'second dispatch',
      capturedAt: '2026-08-06T10:00:01.000Z',
    });

    expect(store.countPendingSubagentDispatches(key(), OPEN_HORIZON)).toBe(2);
    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)?.id).toBe(first.id);
    expect(store.countPendingSubagentDispatches(key(), OPEN_HORIZON)).toBe(1);
    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)?.id).toBe(second.id);
    expect(store.countPendingSubagentDispatches(key(), OPEN_HORIZON)).toBe(0);
  });

  it('breaks a same-millisecond tie by insert order rather than at random', () => {
    // FIFO is the whole basis for the fan-out residual, and two captures written
    // in the same millisecond are ordinary — a `captured_at`-only ordering would
    // make which subagent got which brief depend on SQLite's row order.
    const { store } = createTestStore();
    const stamp = '2026-08-06T10:00:00.000Z';
    const first = capture(store, { description: 'alpha', capturedAt: stamp });
    capture(store, { description: 'bravo', capturedAt: stamp });

    expect(store.consumeSubagentDispatch(key(), OPEN_HORIZON)?.id).toBe(first.id);
  });

  it('refuses a capture older than the pairing horizon', () => {
    // CORRECTNESS, not housekeeping: an `Agent` call the user denied fires
    // `PreToolUse` and never starts, and GC runs at most once per 24 hours.
    const { store } = createTestStore();
    capture(store, { capturedAt: '2026-08-06T09:00:00.000Z' });

    const cutoff = '2026-08-06T09:55:00.000Z';
    expect(store.countPendingSubagentDispatches(key(), cutoff)).toBe(0);
    expect(store.consumeSubagentDispatch(key(), cutoff)).toBeUndefined();
  });

  it('hands one capture to exactly one claimant', () => {
    // Two `SubagentStart` hooks are independent OS processes and `busy_timeout`
    // does not make read-then-write atomic. The claim is one conditional
    // statement, and a returned row IS the row count.
    const { store } = createTestStore();
    capture(store);

    const first = store.consumeSubagentDispatch(key(), OPEN_HORIZON);
    const second = store.consumeSubagentDispatch(key(), OPEN_HORIZON);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('never re-claims a consumed capture (N-7)', () => {
    const { store } = createTestStore();
    const row = capture(store);
    const claimedAt = '2026-08-06T10:00:05.000Z';

    store.consumeSubagentDispatch(key(), OPEN_HORIZON, claimedAt);
    store.consumeSubagentDispatch(key(), OPEN_HORIZON, '2026-08-06T10:00:06.000Z');

    // The first claim's stamp survives: replay produces identical state.
    expect(store.getSubagentDispatch(row.id)?.consumedAt).toBe(claimedAt);
  });
});

// ── What is kept of the prompt ────────────────────────────────────────

describe('summarizeDispatchPrompt', () => {
  it('records a digest, a normalized prefix and the full normalized length', () => {
    const summary = summarizeDispatchPrompt('  Trace   the READ ledger\n\nplease  ');
    expect(summary.prefix).toBe('trace the read ledger please');
    expect(summary.chars).toBe('trace the read ledger please'.length);
    expect(summary.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('bounds the prefix while still recording how long the prompt really was', () => {
    // AD-6: the row has to say how much of the prompt a suppression decision
    // actually saw, rather than implying it saw all of it.
    const prompt = 'x'.repeat(PROMPT_PREFIX_MAX_CHARS * 2);
    const summary = summarizeDispatchPrompt(prompt);
    expect(summary.prefix).toHaveLength(PROMPT_PREFIX_MAX_CHARS);
    expect(summary.chars).toBe(PROMPT_PREFIX_MAX_CHARS * 2);
  });

  it('is empty for an absent prompt rather than storing a digest of nothing', () => {
    expect(summarizeDispatchPrompt(undefined)).toEqual({ digest: null, prefix: null, chars: 0 });
    expect(summarizeDispatchPrompt('')).toEqual({ digest: null, prefix: null, chars: 0 });
  });
});

// ── The horizon option ────────────────────────────────────────────────

describe('dispatchHorizonSeconds', () => {
  it('defaults when unset or blank', () => {
    expect(dispatchHorizonSeconds({})).toBe(DEFAULT_DISPATCH_HORIZON_SECONDS);
    expect(dispatchHorizonSeconds({ [DISPATCH_HORIZON_ENV]: '   ' })).toBe(
      DEFAULT_DISPATCH_HORIZON_SECONDS,
    );
  });

  it('parses with Number, never parseInt', () => {
    // `parseInt` succeeds on a PREFIX: `1e9` becomes 1 and `6e1` becomes 6. Five
    // incidents in this repository, the most recent through SQL's `CAST`. Here a
    // silently-tiny horizon disables pairing entirely while every diagnostic
    // still reads healthy.
    expect(dispatchHorizonSeconds({ [DISPATCH_HORIZON_ENV]: '6e1' })).toBe(60);
    expect(dispatchHorizonSeconds({ [DISPATCH_HORIZON_ENV]: '1e9' })).toBe(
      MAX_DISPATCH_HORIZON_SECONDS,
    );
  });

  it('falls back to the default on values that would disable pairing', () => {
    for (const raw of ['0', '-30', 'off', 'NaN']) {
      expect(dispatchHorizonSeconds({ [DISPATCH_HORIZON_ENV]: raw }), raw).toBe(
        DEFAULT_DISPATCH_HORIZON_SECONDS,
      );
    }
  });

  it('computes a cutoff the pairing query can compare against', () => {
    const now = new Date('2026-08-06T10:00:00.000Z');
    expect(dispatchCutoff(now, 300)).toBe('2026-08-06T09:55:00.000Z');
  });
});

describe('subagentBriefEnabled', () => {
  it('is on by default and off only for the documented spelling', () => {
    expect(subagentBriefEnabled({})).toBe(true);
    expect(subagentBriefEnabled({ [SUBAGENT_BRIEF_ENV]: 'off' })).toBe(false);
    expect(subagentBriefEnabled({ [SUBAGENT_BRIEF_ENV]: 'on' })).toBe(true);
  });
});

// ── AC #2: silence when there is nothing to say ───────────────────────

describe('buildSubagentBrief', () => {
  it('emits NOTHING for a topic with no matching memory, and logs no retrieval', () => {
    // The trap: `brief()` never returns an empty string. With no results it
    // returns `No context found for "<topic>"` — two lines with `forAgent` set —
    // AND calls `logRetrieval`. "Call it and discard when empty" would put a
    // sentence at the top of a fresh subagent's context announcing there was
    // nothing to say, and write a retrieval-log row on every no-match dispatch.
    const { store, sessionId } = createTestStore();
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'kafka',
      content: 'Kafka was chosen for the ingestion pipeline.',
    });
    const logsBefore = retrievalLogCount(store);

    const result = buildSubagentBrief(store, {
      description: 'zzqqxx unrelated topic nobody has ever written about',
      agentType: 'Explore',
    });

    expect(result.text).toBe('');
    expect(result.text).not.toContain('No context found');
    expect(result.matched).toBe(0);
    expect(result.suppressed).toBe(false);
    expect(retrievalLogCount(store)).toBe(logsBefore);
  });

  it('emits nothing for a blank description rather than retrieving on empty text', () => {
    const { store } = createTestStore();
    expect(buildSubagentBrief(store, { description: '   ', agentType: 'Explore' }).text).toBe('');
  });

  it('briefs from matching memory, headed for the dispatched agent type', () => {
    const { store, sessionId } = createTestStore();
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'read ledger',
      content: 'The read ledger answers unchanged-since by re-hashing, never by mtime.',
    });

    const result = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
    });

    expect(result.matched).toBeGreaterThan(0);
    expect(result.text).toContain('Briefing for Explore:');
    expect(result.text).toContain('re-hashing');
  });

  it('honours the 150-token session-brief budget, not cortex_brief’s 450', () => {
    // Ruling, ShuromiU, 2026-08-06. Seeded at a BINDING size: a cap above the
    // seeded content can never fire and is decoration.
    const { store, sessionId } = createTestStore();
    for (let index = 0; index < 12; index += 1) {
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: `read ledger ${index}`,
        content: `The read ledger decision ${index}: unchanged-since is verified by re-hashing the file contents rather than trusting mtime, and a read by a sibling session is attributed rather than claimed.`,
      });
    }

    const unbudgeted = buildSubagentBrief(store, {
      description: 'read ledger unchanged-since re-hashing',
      agentType: 'Explore',
      budget: 10_000,
    });
    const result = buildSubagentBrief(store, {
      description: 'read ledger unchanged-since re-hashing',
      agentType: 'Explore',
    });

    expect(SUBAGENT_BRIEF_BUDGET).toBe(DEFAULT_SESSION_BRIEF_BUDGET);
    expect(SUBAGENT_BRIEF_BUDGET).toBe(150);
    // The budget genuinely binds here — the unbudgeted render is larger.
    expect(estimateTokens(unbudgeted.text)).toBeGreaterThan(SUBAGENT_BRIEF_BUDGET);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(SUBAGENT_BRIEF_BUDGET);
  });

  it('reinforces the memory it delivered, and nothing when it delivered none', () => {
    // A stated decision, not an accident of calling `brief()`: reinforcement
    // records that memory was actually delivered into an agent's context. The
    // pre-check is what keeps it from firing on every no-match dispatch.
    const { store, sessionId } = createTestStore();
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'read ledger',
      content: 'The read ledger answers unchanged-since by re-hashing, never by mtime.',
    });

    const before = retrievalLogCount(store);
    buildSubagentBrief(store, { description: 'zzqqxx nothing matches this', agentType: 'Explore' });
    expect(retrievalLogCount(store)).toBe(before);

    buildSubagentBrief(store, { description: 'read ledger freshness', agentType: 'Explore' });
    expect(retrievalLogCount(store)).toBe(before + 1);
  });
});

// ── AC #3: do not say what the parent already said ────────────────────

describe('briefAlreadyInPrompt', () => {
  function seededItems(store: CortexStore, sessionId: string) {
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'read ledger',
      content: 'The read ledger answers unchanged-since by re-hashing, never by mtime.',
    });
    const result = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
    });
    expect(result.text).not.toBe('');
    return result;
  }

  it('suppresses when the parent pasted the same lines into the dispatch prompt', () => {
    const { store, sessionId } = createTestStore();
    const briefed = seededItems(store, sessionId);

    const pasted = summarizeDispatchPrompt(
      `Context from memory:\n${briefed.text}\n\nNow go and audit the ledger.`,
    );
    const result = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
      promptPrefix: pasted.prefix,
    });

    expect(result.text).toBe('');
    expect(result.suppressed).toBe(true);
    expect(result.matched).toBeGreaterThan(0);
  });

  it('still suppresses when the paste differs only in whitespace and line endings', () => {
    const { store, sessionId } = createTestStore();
    const briefed = seededItems(store, sessionId);

    // Indented inside a fenced block, CRLF, and quoted — three shapes a raw
    // equality check would miss.
    const mangled = briefed.text
      .split('\n')
      .map(line => `> \t${line}   `)
      .join('\r\n');
    const pasted = summarizeDispatchPrompt(`Background:\r\n${mangled}\r\n`);

    const result = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
      promptPrefix: pasted.prefix,
    });

    expect(result.suppressed).toBe(true);
    expect(result.text).toBe('');
  });

  it('does not suppress a prompt that never carried the brief', () => {
    const { store, sessionId } = createTestStore();
    seededItems(store, sessionId);

    const pasted = summarizeDispatchPrompt('Audit the ledger. No prior context is supplied.');
    const result = buildSubagentBrief(store, {
      description: 'read ledger freshness',
      agentType: 'Explore',
      promptPrefix: pasted.prefix,
    });

    expect(result.suppressed).toBe(false);
    expect(result.text).not.toBe('');
  });

  it('is false with no prompt at all, rather than vacuously true', () => {
    // `[].every(...)` is `true`, and an empty needle set would suppress every
    // brief on every dispatch that carried no prompt.
    const { store, sessionId } = createTestStore();
    const note = store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'read ledger',
      content: 'The read ledger answers unchanged-since by re-hashing.',
    });
    void note;
    const items = store.listRecentMemoryItems(5);

    expect(briefAlreadyInPrompt(items, null)).toBe(false);
    expect(briefAlreadyInPrompt(items, '')).toBe(false);
    expect(briefAlreadyInPrompt([], 'anything at all')).toBe(false);
  });

  it('needs EVERY matched item present, not one of them', () => {
    const { store, sessionId } = createTestStore();
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'ledger alpha',
      content: 'Ledger alpha decision text about re-hashing.',
    });
    store.insertNote({
      sessionId,
      kind: 'decision',
      subject: 'ledger bravo',
      content: 'Ledger bravo decision text about re-hashing.',
    });
    const items = store.listRecentMemoryItems(5).filter(item => item.kind === 'note:decision');
    expect(items.length).toBeGreaterThanOrEqual(2);

    const onlyFirst = normalizeForComparison(renderMemoryLine(items[0]!, 2));
    expect(briefAlreadyInPrompt(items, onlyFirst)).toBe(false);

    const both = items.map(item => normalizeForComparison(renderMemoryLine(item, 2))).join(' ');
    expect(briefAlreadyInPrompt(items, both)).toBe(true);
  });
});

// ── The growth bound, which ships WITH the table (Task 7) ────────────
//
// `content_digests` shipped in Story 3.1 with no GC rule at all, grew
// monotonically for the life of a project, and became an action item a later
// story had to absorb. This rule ships in the same change as its table.

describe('pruneSubagentDispatches via runGc', () => {
  const at = (iso: string) => ({ capturedAt: iso });

  it('previews by default and deletes only with --apply', () => {
    const { store } = createTestStore();
    capture(store, at('2026-07-01T00:00:00.000Z'));
    const now = new Date('2026-08-06T10:00:00.000Z');

    const dry = runGc(store.db, { now });
    expect(dry.subagent_dispatches.candidates).toBe(1);
    expect(dry.subagent_dispatches.deleted).toBe(0);

    const applied = runGc(store.db, { now, dryRun: false, vacuum: 'never' });
    expect(applied.subagent_dispatches.deleted).toBe(1);
    expect(
      (store.db.prepare('SELECT COUNT(*) AS n FROM subagent_dispatches').get() as { n: number }).n,
    ).toBe(0);
  });

  it('keeps a capture inside the horizon, consumed or not', () => {
    const { store } = createTestStore();
    const recent = capture(store, at('2026-08-06T09:00:00.000Z'));
    store.consumeSubagentDispatch(key(), OPEN_HORIZON);
    expect(store.getSubagentDispatch(recent.id)?.consumedAt).not.toBeNull();

    const report = runGc(store.db, {
      now: new Date('2026-08-06T10:00:00.000Z'),
      dryRun: false,
      vacuum: 'never',
    });
    expect(report.subagent_dispatches.deleted).toBe(0);
    expect(store.getSubagentDispatch(recent.id)).toBeDefined();
  });

  it('parses its horizon with Number, never parseInt', () => {
    // `CORTEX_GC_DISPATCH_DAYS=1e9` — the natural way to disable pruning —
    // becomes 1 under `parseInt`, which would wipe the table daily. Fifth
    // incident of this shape in this repository.
    const { store } = createTestStore();
    capture(store, at('2026-08-05T00:00:00.000Z'));
    const previous = process.env['CORTEX_GC_DISPATCH_DAYS'];
    process.env['CORTEX_GC_DISPATCH_DAYS'] = '1e9';
    try {
      const report = runGc(store.db, {
        now: new Date('2026-08-06T10:00:00.000Z'),
        dryRun: false,
        vacuum: 'never',
      });
      expect(report.subagent_dispatches.deleted).toBe(0);
    } finally {
      if (previous === undefined) delete process.env['CORTEX_GC_DISPATCH_DAYS'];
      else process.env['CORTEX_GC_DISPATCH_DAYS'] = previous;
    }
  });

  it('is the GROWTH bound only — the correctness bound is the pairing query', () => {
    // Two horizons, two mechanisms. GC runs at most once per 24 hours, so a
    // capture orphaned at 09:00 is still in the table at 09:06 — and must
    // already be unpairable by then, or it mis-briefs a later same-type subagent
    // all day.
    const { store } = createTestStore();
    capture(store, at('2026-08-06T09:00:00.000Z'));

    const report = runGc(store.db, {
      now: new Date('2026-08-06T09:06:00.000Z'),
      dryRun: false,
      vacuum: 'never',
    });
    expect(report.subagent_dispatches.deleted, 'GC is not the correctness bound').toBe(0);

    const cutoff = dispatchCutoff(new Date('2026-08-06T09:06:00.000Z'), 300);
    expect(store.consumeSubagentDispatch(key(), cutoff)).toBeUndefined();
  });
});
