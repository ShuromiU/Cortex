import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { assembleBudgeted, recall, type BudgetedEvidence } from '../src/query/recall.js';
import { brief } from '../src/query/brief.js';
import { estimateTokens, retrieveMemory } from '../src/query/retrieval.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function makeStore(): CortexStore {
  return new CortexStore(createTestDb());
}

// ── recall ────────────────────────────────────────────────────────────

describe('recall — finds notes matching topic', () => {
  it('renders note timestamps in compact UTC form', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const store = makeStore();
      const session = store.createSession();
      store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT tokens' });

      const result = recall(store, 'auth');

      expect(result).toContain('Decision [2026-06-06 05:18Z]: [auth] use JWT tokens');
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds notes by subject match', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT tokens' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'unrelated info' });

    const result = recall(store, 'auth');
    expect(result).toContain('Decision [');
    expect(result).toContain('[auth] use JWT tokens');
    expect(result).not.toContain('unrelated info');
  });

  it('finds notes by content match', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'JWT is stateless and scalable' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'sessions have server overhead' });

    const result = recall(store, 'JWT');
    expect(result).toContain('JWT is stateless');
    expect(result).not.toContain('server overhead');
  });

  it('returns no-matches message for unrelated topics', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth is good' });

    const result = recall(store, 'kubernetes');
    expect(result).toBe(
      'No matches for "kubernetes". Try a broader topic, or cortex_state for the working set.',
    );
  });

  it('excludes superseded notes (only shows active and resolved)', () => {
    const store = makeStore();
    const session = store.createSession();
    // Insert a decision that gets superseded by a second one
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'caching', content: 'use Redis' });
    // This supersedes the first
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'caching', content: 'use in-memory cache' });

    const result = recall(store, 'caching');
    // Only the active one (in-memory) should be in the result
    expect(result).toContain('in-memory cache');
    // The superseded one should NOT appear
    expect(result).not.toContain('use Redis');
  });

  it('includes resolved notes with lower relevance score', () => {
    const store = makeStore();
    const session = store.createSession();
    const note = store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'deploy', content: 'missing env var for deploy' });
    store.updateNoteStatus(note.id, 'resolved');

    const result = recall(store, 'deploy');
    expect(result).toContain('missing env var');
    expect(result).toContain('(resolved)');
  });

  it('searches consolidated state content', () => {
    const store = makeStore();
    const session = store.createSession();
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Completed auth module refactoring.' });

    const result = recall(store, 'auth');
    expect(result).toContain('[session state]');
    expect(result).toContain('Completed auth module refactoring.');
  });

  it('searches project state content', () => {
    const store = makeStore();
    store.insertState({ layer: 'project', content: 'Focus on performance optimization for the API.' });

    const result = recall(store, 'performance');
    expect(result).toContain('[project state]');
    expect(result).toContain('performance optimization');
  });

  it('returns no matches when topic not in any note or state', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth notes here' });
    store.insertState({ layer: 'project', content: 'auth project' });

    const result = recall(store, 'blockchain');
    expect(result).toBe(
      'No matches for "blockchain". Try a broader topic, or cortex_state for the working set.',
    );
  });

  it('subject match scores higher than content match — subject results appear first', () => {
    const store = makeStore();
    const session = store.createSession();
    // Content-only match
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'jwt mentioned in passing' });
    // Subject match (higher score)
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'jwt', content: 'use HS256 signing' });

    const result = recall(store, 'jwt');
    const decisionIdx = result.indexOf('Decision [');
    const insightIdx = result.indexOf('Insight [');
    expect(decisionIdx).toBeLessThan(insightIdx);
  });

  it('limits results to top 10', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 15; i++) {
      store.insertNote({ sessionId: session.id, kind: 'insight', content: `auth tip ${i}` });
    }

    const result = recall(store, 'auth');
    const lines = result.split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});

// ── brief ─────────────────────────────────────────────────────────────

describe('brief — scoped briefing', () => {
  it('renders note timestamps in compact UTC form', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const store = makeStore();
      const session = store.createSession();
      store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });

      const result = brief(store, 'auth');

      expect(result).toContain('Decision [2026-06-06 05:18Z]: [auth] use JWT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('generates a scoped briefing for a topic', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'auth', content: 'add refresh tokens' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'unrelated CSS info' });

    const result = brief(store, 'auth');
    expect(result).toContain('use JWT');
    expect(result).toContain('add refresh tokens');
    expect(result).not.toContain('CSS info');
  });

  it('includes agent context when forAgent is provided', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'api', content: 'REST over GraphQL' });

    const result = brief(store, 'api', 'deployment-agent');
    expect(result).toContain('Briefing for deployment-agent:');
    expect(result).toContain('REST over GraphQL');
  });

  it('does not include agent context header when forAgent is not provided', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth insight' });

    const result = brief(store, 'auth');
    expect(result).not.toContain('Briefing for');
  });

  it('returns no context message when no relevant notes found', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth notes' });

    const result = brief(store, 'kubernetes');
    expect(result).toContain('No context found for "kubernetes".');
  });

  it('sorts by kind priority: decision > intent > blocker > insight', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'cache insight' });
    store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'cache', content: 'cache blocked' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'cache', content: 'cache intent' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'cache', content: 'use Redis' });

    const result = brief(store, 'cache');
    const decisionIdx = result.indexOf('Decision [');
    const intentIdx = result.indexOf('Intent [');
    const blockerIdx = result.indexOf('Blocker [');
    const insightIdx = result.indexOf('Insight [');

    expect(decisionIdx).toBeLessThan(intentIdx);
    expect(intentIdx).toBeLessThan(blockerIdx);
    expect(blockerIdx).toBeLessThan(insightIdx);
  });

  it('limits to max 5 notes', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 8; i++) {
      store.insertNote({ sessionId: session.id, kind: 'insight', content: `cache tip ${i}` });
    }

    const result = brief(store, 'cache');
    const lines = result.split('\n').filter(l => l.startsWith('Insight ['));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('includes current session focus when available', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'auth-redesign' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use OIDC' });

    const result = brief(store, 'auth');
    expect(result).toContain('Focus: auth-redesign');
  });

  it('is concise — under 400 chars for a small briefing', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'api', content: 'REST' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'api', content: 'add v2 endpoint' });

    const result = brief(store, 'api');
    expect(result.length).toBeLessThan(400);
  });
});

// ── answer shape, budgets, and score detail ───────────────────────────

describe('recall — answer shape and budgets', () => {
  it('leads with a synthesized most-relevant line', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'cache policy',
      content: 'cache invalidation uses tags',
    });

    const result = recall(store, 'cache invalidation');
    const lines = result.split('\n');
    expect(lines[0]).toMatch(/^Most relevant — Decision \[cache policy\] \(today, /);
    expect(lines[1]).toContain('cache invalidation uses tags');
  });

  it('enforces the output token budget by dropping evidence from the bottom', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 8; i++) {
      store.insertNote({
        sessionId: session.id,
        kind: 'insight',
        subject: `cache shard ${i}`,
        content: `cache shard ${i} eviction follows the segmented lru policy with per-tenant quotas and warmup batches`,
      });
    }

    const full = recall(store, 'cache eviction');
    const budgeted = recall(store, 'cache eviction', { budget: 80 });

    expect(budgeted.length).toBeLessThan(full.length);
    expect(Math.ceil(budgeted.length / 4)).toBeLessThanOrEqual(80 + 30);
    expect(budgeted).toContain('trimmed (raise budget or refine topic)');
    // The top evidence line always survives the budget.
    expect(budgeted.split('\n')[1]).toContain('cache shard');
  });

  it('appends score breakdowns when detail is scores', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'queue',
      content: 'queue retries use jitter',
    });

    const plain = recall(store, 'queue retries');
    const detailed = recall(store, 'queue retries', { detail: 'scores' });

    expect(plain).not.toContain('(score ');
    expect(detailed).toContain('(score ');
    expect(detailed).toContain('lex ');
    expect(detailed).toContain('truth ');
  });

  it('brief respects an output budget', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 5; i++) {
      store.insertNote({
        sessionId: session.id,
        kind: 'insight',
        subject: `worker pool ${i}`,
        content: `worker pool ${i} drains gracefully on deploy with a thirty second linger before hard kill`,
      });
    }

    const budgeted = brief(store, 'worker pool drain', undefined, { budget: 60 });
    expect(budgeted).toContain('trimmed');
    expect(budgeted.split('\n').some(line => line.startsWith('Insight ['))).toBe(true);
  });
});

// ── Contested rendering (FR-2, Story 1.2) ─────────────────────────────

/**
 * Seeds a real contest through the write path so these tests exercise Story
 * 1.1's detector rather than a hand-built `Conflict: true` string.
 */
function seedContest(store: CortexStore): { sessionId: string } {
  const session = store.createSession();
  store.insertNote({
    sessionId: session.id,
    kind: 'decision',
    subject: 'spool flush',
    content: 'flush the spool at turn end',
  });
  const second = store.insertNote({
    sessionId: session.id,
    kind: 'decision',
    subject: 'spool flush',
    content: 'do not flush the spool at turn end',
  });
  expect(second.conflicts?.length ?? 0).toBeGreaterThan(0);
  return { sessionId: session.id };
}

describe('recall — contested items', () => {
  it('marks both sides of a contest', () => {
    const store = makeStore();
    seedContest(store);

    const result = recall(store, 'spool flush');
    const marked = result.split('\n').filter(line => line.includes('[contested]'));
    expect(marked).toHaveLength(2);
  });

  it('never renders the pre-1.2 [conflict] marker', () => {
    const store = makeStore();
    seedContest(store);

    expect(recall(store, 'spool flush')).not.toContain('[conflict]');
  });

  it('leaves uncontested notes unmarked', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });

    expect(recall(store, 'spool flush')).not.toContain('[contested]');
  });

  it('renders both sides adjacently when an uncontested note outranks one of them', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession();

    const losing = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const winning = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(winning.conflicts?.length ?? 0).toBeGreaterThan(0);
    store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      subject: 'spool flush',
      content: 'the spool flush is idempotent per batch so a double flush cannot double count',
    });

    // Age the losing side and warm the insight so ranking alone puts the
    // uncontested note *between* the two contested ones. Applied after the
    // contest is recorded, because markConflict re-syncs the memory item.
    const aged = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE memory_items SET created_at = ?, state = 'cold' WHERE source_id = ?").run(
      aged,
      losing.id,
    );
    const insightItem = db
      .prepare("SELECT id FROM memory_items WHERE kind = 'note:insight'")
      .get() as { id: string };
    for (let index = 0; index < 3; index += 1) {
      store.touchMemoryItems([insightItem.id]);
    }

    // Guard: without grouping the pair really would be split by ranking.
    const ranked = retrieveMemory(store, 'spool flush', 8).results;
    expect(ranked.map(item => item.kind)).toEqual([
      'note:decision',
      'note:insight',
      'note:decision',
    ]);

    const lines = recall(store, 'spool flush')
      .split('\n')
      .filter(line => line.startsWith('Decision') || line.startsWith('Insight'));
    const contestedAt = lines
      .map((line, index) => (line.includes('[contested]') ? index : -1))
      .filter(index => index >= 0);

    expect(contestedAt).toHaveLength(2);
    expect(contestedAt[1]! - contestedAt[0]!).toBe(1);
  });

  it('gives the marker no budget priority — a contested line is trimmed like any other', () => {
    const store = makeStore();
    seedContest(store);

    // Tight enough that only one evidence line survives.
    const tight = recall(store, 'spool flush', { budget: 40 });
    expect(tight).toContain('trimmed');
    expect(tight.split('\n').filter(line => line.includes('[contested]'))).toHaveLength(1);

    // Loosen it and the trimmed side comes back — nothing about the marker
    // exempted it from, or privileged it in, the budget.
    const loose = recall(store, 'spool flush', { budget: 600 });
    expect(loose).not.toContain('trimmed');
    expect(loose.split('\n').filter(line => line.includes('[contested]'))).toHaveLength(2);
  });

  it('costs the contested marker inside its own line, not as a free rider', () => {
    const store = makeStore();
    seedContest(store);

    const rendered = recall(store, 'spool flush', { budget: 600 });
    const contestedLine = rendered
      .split('\n')
      .find(line => line.includes('[contested]'))!;
    // The marker is part of the line assembleBudgeted prices, so removing it
    // must reduce that line's cost — proving it was never charged separately.
    const withMarker = estimateTokens(contestedLine);
    const withoutMarker = estimateTokens(contestedLine.replace(' [contested]', ''));
    expect(withMarker).toBeGreaterThanOrEqual(withoutMarker);
    expect(withMarker - withoutMarker).toBeLessThanOrEqual(4);
  });

  // Pre-existing assembleBudgeted behavior, pinned here because story 1.2's
  // first attempt at the AC #3 test measured `slice(1, -1)` — everything except
  // the trimmed hint, which is the only line that can breach the budget — and
  // so could not fail. The overshoot is not contested-specific: assembleBudgeted
  // refuses to drop the last evidence line (so the budget can never silence the
  // top result) and then appends the hint regardless.
  it('can exceed the budget by the trimmed hint when only one evidence line survives', () => {
    const store = makeStore();
    seedContest(store);

    const rendered = recall(store, 'spool flush', { budget: 10 });
    expect(rendered.split('\n')).toHaveLength(3); // lead + 1 evidence + hint
    expect(estimateTokens(rendered)).toBeGreaterThan(10);
  });
});

// ── Rejected alternatives (FR-3, Story 1.3) ───────────────────────────

/**
 * Seeds two decisions carrying alternatives plus one insight that does not,
 * through the real write path — so these exercise the projection
 * `buildNoteMemoryText` actually produces rather than a hand-built text blob.
 */
function seedAlternatives(store: CortexStore): void {
  const session = store.createSession();
  store.insertNote({
    sessionId: session.id,
    kind: 'decision',
    subject: 'auth strategy',
    content: 'use OIDC for the auth strategy',
    alternatives: ['session cookies (no SSO path)', 'JWT-in-localStorage (XSS surface)'],
  });
  store.insertNote({
    sessionId: session.id,
    kind: 'decision',
    subject: 'auth session store',
    content: 'keep the auth session store in redis',
    alternatives: ['in-process memory (breaks on restart)'],
  });
  store.insertNote({
    sessionId: session.id,
    kind: 'insight',
    subject: 'auth tokens',
    content: 'auth token refresh happens on the server side only',
  });
}

function primaryLines(rendered: string): string[] {
  return rendered
    .split('\n')
    .filter(line => line.startsWith('Decision ') || line.startsWith('Insight '));
}

function continuationLines(rendered: string): string[] {
  return rendered.split('\n').filter(line => line.trim().startsWith('already rejected:'));
}

describe('recall — rejected alternatives', () => {
  it('lists the alternatives on their own line beneath the decision', () => {
    const store = makeStore();
    seedAlternatives(store);

    const lines = recall(store, 'auth', { budget: 600 }).split('\n');
    const decisionAt = lines.findIndex(line => line.includes('use OIDC for the auth strategy'));

    expect(decisionAt).toBeGreaterThan(-1);
    expect(lines[decisionAt + 1]).toBe(
      '  already rejected: session cookies (no SSO path), JWT-in-localStorage (XSS surface)',
    );
  });

  it('renders one continuation per decision that carries alternatives, and none for the insight', () => {
    const store = makeStore();
    seedAlternatives(store);

    const rendered = recall(store, 'auth', { budget: 600 });
    expect(continuationLines(rendered)).toHaveLength(2);
    // The insight has no alternatives, so nothing follows it.
    const lines = rendered.split('\n');
    const insightAt = lines.findIndex(line => line.startsWith('Insight '));
    expect(lines[insightAt + 1]).toBeUndefined();
  });

  it('leaves a decision written without alternatives untouched', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'auth strategy',
      content: 'use OIDC for the auth strategy',
    });

    expect(recall(store, 'auth')).not.toContain('already rejected');
  });

  it('renders the alternatives in brief as well as recall', () => {
    const store = makeStore();
    seedAlternatives(store);

    const rendered = brief(store, 'auth', undefined, { budget: 600 });
    expect(rendered).toContain('  already rejected: in-process memory (breaks on restart)');
    // KIND_PRIORITY still holds with continuations interleaved.
    expect(primaryLines(rendered).map(line => line.split(' ')[0])).toEqual([
      'Decision',
      'Decision',
      'Insight',
    ]);
  });
});

describe('recall — alternatives survive the projection intact', () => {
  function renderAlternatives(alternatives: string[]): string | undefined {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'queue choice',
      content: 'use sqs for the queue choice',
      alternatives,
    });
    return continuationLines(recall(store, 'queue choice', { budget: 600 }))[0];
  }

  it('keeps every alternative when one of them contains a newline', () => {
    // buildNoteMemoryText joins onto one line, so an embedded newline used to
    // split the projection and silently drop the rationale AND every later
    // alternative. README promises the strings are reproduced; they must be.
    expect(renderAlternatives(['kafka\n(too heavy to operate)', 'rabbitmq'])).toBe(
      '  already rejected: kafka (too heavy to operate), rabbitmq',
    );
  });

  it('does not let note content posing as a second line replace the real list', () => {
    expect(
      renderAlternatives(['mysql', 'sqlite\nAlternatives: nothing was ever rejected']),
    ).toContain('mysql, sqlite');
  });

  it('strips carriage returns rather than leaking them into rendered output', () => {
    // A bare CR returns the terminal cursor to column 0, hiding the prefix.
    const rendered = renderAlternatives(['session cookies\r(no SSO)', 'JWT'])!;
    expect(rendered).not.toContain('\r');
    expect(rendered).toBe('  already rejected: session cookies (no SSO), JWT');
  });

  it('drops empty entries instead of rendering a dangling comma', () => {
    expect(renderAlternatives(['redis', ''])).toBe('  already rejected: redis');
    expect(renderAlternatives(['', 'redis'])).toBe('  already rejected: redis');
  });

  it('renders nothing when every entry is empty', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'queue choice',
      content: 'use sqs for the queue choice',
      alternatives: ['', '   '],
    });
    expect(recall(store, 'queue choice')).not.toContain('already rejected');
  });

  it('does not fabricate a rejection list from a content line', () => {
    // End-to-end companion to the render.ts unit test: notes.alternatives is
    // NULL here, so nothing may render.
    const store = makeStore();
    const session = store.createSession();
    const note = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'api shape',
      content: 'adopt tRPC for the internal api\nAlternatives: REST, GraphQL',
    });

    expect(note.alternatives).toBeNull();
    expect(recall(store, 'api shape')).not.toContain('already rejected');
  });

  it('lets one runaway list coexist with other decisions alternatives', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'queue choice',
      content: 'use sqs for the queue choice',
      alternatives: Array.from({ length: 60 }, (_, i) => `rejected option ${i} with a rationale`),
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'queue serialization',
      content: 'use protobuf for the queue serialization',
      alternatives: ['json'],
    });

    // Uncapped, the first list exceeds the budget, pass 2 stops, and *no*
    // decision gets its alternatives while most of the budget goes unspent.
    expect(continuationLines(recall(store, 'queue', { budget: 600 }))).toHaveLength(2);
  });
});

describe('recall — the alternatives line drops before its decision (AC #2)', () => {
  it('keeps every decision and drops both continuations at a budget that binds', () => {
    const store = makeStore();
    seedAlternatives(store);

    // Precondition, asserted so this fails loudly if it ever stops being
    // adversarial: at a generous budget both continuations are present, and the
    // binding budget below is genuinely too tight to hold them.
    const generous = recall(store, 'auth', { budget: 600 });
    expect(continuationLines(generous)).toHaveLength(2);
    const allPrimaries = primaryLines(generous);
    expect(allPrimaries).toHaveLength(3);

    const bound = recall(store, 'auth', { budget: 90 });

    // Every primary line survives...
    expect(primaryLines(bound)).toEqual(allPrimaries);
    expect(bound).not.toContain('trimmed');
    // ...and the continuations are what paid for it.
    expect(continuationLines(bound)).toHaveLength(0);
    expect(estimateTokens(bound)).toBeLessThanOrEqual(90);
  });

  it('shows every decision before it shows any alternatives, on this result set', () => {
    const store = makeStore();
    seedAlternatives(store);

    const sweep = [20, 40, 60, 70, 80, 90, 100, 110, 120, 200, 600].map(budget => {
      const rendered = recall(store, 'auth', { budget });
      return {
        budget,
        primaries: primaryLines(rendered),
        continuations: continuationLines(rendered),
      };
    });

    const total = sweep[sweep.length - 1]!.primaries.length;
    expect(total).toBe(3);

    const firstFullPrimaries = sweep.find(run => run.primaries.length === total)!.budget;
    const firstContinuation = sweep.find(run => run.continuations.length > 0)!.budget;

    // On this result set the last decision is affordable strictly before the
    // first alternatives line is. This is a property of these three items, NOT
    // of the mechanism — with a short top decision and long lower-ranked ones,
    // the top item's alternatives legitimately render while a lower decision is
    // trimmed, because AC #2 is per-decision. The mechanism itself is pinned
    // below, against assembleBudgeted directly.
    expect(firstFullPrimaries).toBeLessThan(firstContinuation);

    // Primaries only ever grow with the budget.
    for (let index = 1; index < sweep.length; index += 1) {
      expect(sweep[index]!.primaries.length).toBeGreaterThanOrEqual(
        sweep[index - 1]!.primaries.length,
      );
    }
  });

  it('never trades a decision for an alternatives line, at any budget', () => {
    // The real invariant, and the reason AC #2 holds rather than happening to:
    // adding continuations to an entry set must not change which primary lines
    // are rendered — at any budget, for any shape of data. Asserted against
    // assembleBudgeted directly so it cannot become a property of one fixture.
    const withAlternatives: BudgetedEvidence[] = [
      { line: 'Decision: short one', continuation: '  already rejected: a very long list indeed, and another entry' },
      { line: `Decision: ${'a padded decision line that costs a lot to render '.repeat(3)}` },
      { line: 'Decision: another short one', continuation: '  already rejected: x' },
      { line: 'Insight: trailing item' },
    ];
    const withoutAlternatives = withAlternatives.map(entry => ({ line: entry.line }));
    const hint = (dropped: number) => `…${dropped} more trimmed`;

    for (let budget = 0; budget <= 400; budget += 1) {
      const on = assembleBudgeted('Lead line', withAlternatives, budget, hint);
      const off = assembleBudgeted('Lead line', withoutAlternatives, budget, hint);

      const onPrimaries = on.split('\n').filter(line => !line.startsWith('  already rejected:'));
      expect(onPrimaries).toEqual(off.split('\n'));
    }

    // Precondition: the fixture must actually exercise continuations somewhere,
    // or the loop above compares two identical inputs and proves nothing.
    expect(assembleBudgeted('Lead line', withAlternatives, 400, hint)).toContain(
      'already rejected',
    );
  });

  it('drops continuations top-down, keeping the highest-ranked one last', () => {
    const store = makeStore();
    seedAlternatives(store);

    // Between "all primaries, no continuations" and "everything", exactly one
    // continuation fits — and it must be the top decision's, not the cheaper one
    // further down.
    const partial = recall(store, 'auth', { budget: 104 });
    const continuations = continuationLines(partial);

    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toContain('session cookies (no SSO path)');
    expect(primaryLines(partial)).toHaveLength(3);
  });

  it('stops at the first continuation that does not fit rather than skipping it', () => {
    const store = makeStore();
    seedAlternatives(store);

    // The discriminating window. After the primaries, 21 tokens remain unspent
    // at budget 102 — enough for the top decision's alternatives. The second
    // decision's are cheaper (13) and would fit from budget 94 upward. A greedy
    // fill would therefore show the *second* decision's alternatives here while
    // the top decision's are missing, which is not how anything else in this
    // codebase drops content.
    for (const budget of [94, 96, 98, 100]) {
      const rendered = recall(store, 'auth', { budget });
      expect(primaryLines(rendered)).toHaveLength(3);
      expect(continuationLines(rendered)).toHaveLength(0);
    }

    // Precondition: 102 really is where the top one starts fitting, so this test
    // fails loudly if the window ever moves rather than passing vacuously.
    expect(continuationLines(recall(store, 'auth', { budget: 102 }))).toHaveLength(1);
  });
});

describe('recall — decisions without alternatives render byte-identically (AC #3)', () => {
  function renderFixedClock(budget: number): string {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-06T05:18:24.000Z'));
      const store = makeStore();
      const session = store.createSession();
      store.insertNote({
        sessionId: session.id,
        kind: 'decision',
        subject: 'cache policy',
        content: 'cache invalidation uses tags',
      });
      store.insertNote({
        sessionId: session.id,
        kind: 'insight',
        subject: 'cache warmup',
        content: 'cache warmup runs before the first request',
      });
      return recall(store, 'cache', { budget });
    } finally {
      vi.useRealTimers();
    }
  }

  it('produces exactly the pre-1.3 output at a generous budget', () => {
    expect(renderFixedClock(600)).toBe(
      [
        'Most relevant — Decision [cache policy] (today, no file refs)',
        'Decision [2026-06-06 05:18Z]: [cache policy] cache invalidation uses tags',
        'Insight [2026-06-06 05:18Z]: [cache warmup] cache warmup runs before the first request',
      ].join('\n'),
    );
  });

  it('produces exactly the pre-1.3 output when the budget binds', () => {
    expect(renderFixedClock(30)).toBe(
      [
        'Most relevant — Decision [cache policy] (today, no file refs)',
        'Decision [2026-06-06 05:18Z]: [cache policy] cache invalidation uses tags',
        '…1 more match trimmed (raise budget or refine topic)',
      ].join('\n'),
    );
  });
});

describe('brief — contested items', () => {
  it('marks a contested note', () => {
    const store = makeStore();
    seedContest(store);

    const result = brief(store, 'spool flush');
    expect(result).toContain('[contested]');
    expect(result).not.toContain('[conflict]');
  });
});

describe('brief — contested grouping within kind', () => {
  it('seats a same-kind contested pair together when an uncontested decision ranks between them', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession();

    const losing = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    const winning = store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(winning.conflicts?.length ?? 0).toBeGreaterThan(0);
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool when the size threshold is crossed',
    });

    const aged = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE memory_items SET created_at = ?, state = 'cold' WHERE source_id = ?").run(
      aged,
      losing.id,
    );

    // Guard: ranking alone really does split the pair, so this fails loudly if
    // the fixture stops being adversarial.
    const ranked = retrieveMemory(store, 'spool flush', 8).results;
    expect(ranked).toHaveLength(3);
    expect(ranked.map(item => item.text.includes('Conflict: true'))).toEqual([true, false, true]);

    const decisionLines = brief(store, 'spool flush', undefined, { budget: 4000 })
      .split('\n')
      .filter(line => line.startsWith('Decision'));
    const contestedAt = decisionLines
      .map((line, index) => (line.includes('[contested]') ? index : -1))
      .filter(index => index >= 0);

    expect(contestedAt).toHaveLength(2);
    expect(contestedAt[1]! - contestedAt[0]!).toBe(1);
  });

  it('never pulls a contested item across a kind boundary', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    // An insight contesting a decision: detection scopes only the prior.
    const insight = store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });
    expect(insight.conflicts?.length ?? 0).toBeGreaterThan(0);

    const lines = brief(store, 'spool flush', undefined, { budget: 4000 })
      .split('\n')
      .filter(line => line.startsWith('Decision') || line.startsWith('Insight'));

    // KIND_PRIORITY survives: the decision still precedes the insight. A
    // cross-kind pair stays split on this surface by design.
    expect(lines[0]!.startsWith('Decision')).toBe(true);
    expect(lines.some(line => line.startsWith('Insight') && line.includes('[contested]'))).toBe(true);
  });
});
