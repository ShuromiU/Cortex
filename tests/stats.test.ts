import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { runGc } from '../src/db/gc.js';
import { deriveProjectScopeKey } from '../src/scope/keys.js';
import { buildStatsReport, renderStatsReport, MOST_RETRIEVED_LIMIT } from '../src/query/stats.js';
import { createProgram } from '../src/transports/cli.js';
import { openProjectStore, clearProjectStoreCache } from '../src/scope/store-migration.js';
import { ensureScopedSession } from '../src/scope/runtime.js';

/**
 * FR-9: report the P&L (Story 3.6).
 *
 * `cortex stats` reports tokens injected/saved/net/ratio for the current
 * session and cumulatively for the scope, retrieval health over the whole
 * store, and unrealized savings distinctly — within 200 ms in-process on a
 * 10,000-item store (B-6; the CLI end-to-end cost is recorded, not claimed).
 */

const ROOT = '/stats/root';
const PROJECT_KEY = deriveProjectScopeKey(ROOT);

interface Fixture {
  db: Database.Database;
  store: CortexStore;
}

function createFixture(): Fixture {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, ROOT);
  return { db, store: new CortexStore(db) };
}

function createPrimary(fx: Fixture, startedAt: string, scopeKey = PROJECT_KEY): string {
  const session = fx.store.createSession({ scopeType: 'project', scopeKey });
  fx.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(startedAt, session.id);
  return session.id;
}

function createChild(fx: Fixture, parentId: string, agentId: string, scopeKey = PROJECT_KEY): string {
  const session = fx.store.createSession({
    scopeType: 'project',
    scopeKey,
    parentSessionId: parentId,
    agentId,
    agentType: 'general-purpose',
  });
  return session.id;
}

function seedItem(
  fx: Fixture,
  id: string,
  opts: {
    kind?: string;
    text?: string;
    subject?: string | null;
    state?: 'pinned' | 'hot' | 'warm' | 'cold' | 'archived';
    accessCount?: number;
    lastAccessedAt?: string | null;
    createdAt?: string;
  } = {},
): void {
  fx.store.upsertMemoryItem({
    id,
    scopeType: 'project',
    scopeKey: PROJECT_KEY,
    kind: opts.kind ?? 'note:insight',
    subject: opts.subject ?? null,
    text: opts.text ?? `memory ${id}`,
    state: opts.state ?? 'warm',
    importance: 0.5,
    accessCount: opts.accessCount ?? 0,
    lastAccessedAt: opts.lastAccessedAt ?? null,
    createdAt: opts.createdAt ?? '2026-07-30T11:02:00.000Z',
  });
}

// ── Session block (D2) ────────────────────────────────────────────────

describe('buildStatsReport — session block', () => {
  it('resolves the most recent primary in scope and totals its whole tree', () => {
    const fx = createFixture();
    const older = createPrimary(fx, '2026-08-01T00:00:00.000Z');
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    const child = createChild(fx, current, 'agent-1');

    fx.store.insertLedgerEntry({ sessionId: older, type: 'state', direction: 'injected', tokens: 100 });
    fx.store.insertLedgerEntry({ sessionId: current, type: 'recall', direction: 'injected', tokens: 50 });
    fx.store.insertLedgerEntry({ sessionId: child, type: 'brief', direction: 'injected', tokens: 30 });
    fx.store.insertLedgerEntry({
      sessionId: child,
      type: 'offer:read',
      direction: 'unrealized',
      tokens: 10,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 40 },
    });

    const report = buildStatsReport(fx.store);

    expect(report.session.id).toBe(current);
    expect(report.session.totals).not.toBeNull();
    // The tree: current (50) + child (30). The older primary's 100 stays out.
    expect(report.session.totals!.injected).toBe(80);
    expect(report.session.totals!.unrealized).toBe(10);
    expect(report.session.includesSubagents).toBe(true);
    // The POSITIVE render assertions: deleting the `started` prefix or the
    // subagents suffix from the renderer previously left the whole suite
    // green — only the negative half ("does not claim…") was pinned.
    const rendered = renderStatsReport(report);
    expect(rendered).toContain('Session:       started 2026-08-02 00:00Z (incl. subagents)');
  });

  it('breaks a cross-key started_at tie toward the preferred scope key', () => {
    const fx = createFixture();
    // Same instant under both working keys. The preferred (branch) key is
    // iterated first and strict `>` keeps the incumbent — the documented
    // choice, previously unpinned. rowid tiebreaks only within a key.
    const projectTied = createPrimary(fx, '2026-08-02T00:00:00.000Z', PROJECT_KEY);
    const branchTied = createPrimary(fx, '2026-08-02T00:00:00.000Z', 'branch:/stats/root#main');
    fx.store.insertLedgerEntry({ sessionId: projectTied, type: 'state', direction: 'injected', tokens: 3 });
    fx.store.insertLedgerEntry({ sessionId: branchTied, type: 'state', direction: 'injected', tokens: 5 });

    const report = buildStatsReport(fx.store);
    expect(report.scope.scopeKeys[0]).toBe('branch:/stats/root#main');
    expect(report.session.id).toBe(branchTied);
  });

  it('the most recent primary wins over an older still-active one', () => {
    const fx = createFixture();
    const active = createPrimary(fx, '2026-08-01T00:00:00.000Z');
    const newer = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.endSession(newer);
    // `active` is still status='active', but stats answers "what did the last
    // session cost" — inject-header ends the tree on every SessionStart, so
    // active-only would leave this block empty almost always (the FR-7 wall).
    fx.store.insertLedgerEntry({ sessionId: active, type: 'state', direction: 'injected', tokens: 7 });
    fx.store.insertLedgerEntry({ sessionId: newer, type: 'state', direction: 'injected', tokens: 9 });

    const report = buildStatsReport(fx.store);
    expect(report.session.id).toBe(newer);
    expect(report.session.totals!.injected).toBe(9);
  });

  it('picks the newest primary across both working scope keys', () => {
    const fx = createFixture();
    // The newest primary lives under a BRANCH key, so the working keys are
    // [branch, project] and both hold a candidate. A single-key fixture never
    // exercises the cross-key comparison at all — with one candidate the
    // `best` slot is filled unconditionally, so an inverted comparison
    // survives every single-scope test.
    const projectOld = createPrimary(fx, '2026-08-01T00:00:00.000Z', PROJECT_KEY);
    const branchNew = createPrimary(fx, '2026-08-02T00:00:00.000Z', 'branch:/stats/root#main');
    fx.store.insertLedgerEntry({ sessionId: projectOld, type: 'state', direction: 'injected', tokens: 3 });
    fx.store.insertLedgerEntry({ sessionId: branchNew, type: 'state', direction: 'injected', tokens: 5 });

    const report = buildStatsReport(fx.store);
    expect(report.scope.scopeKeys).toEqual(['branch:/stats/root#main', PROJECT_KEY]);
    expect(report.session.id).toBe(branchNew);
    expect(report.session.totals!.injected).toBe(5);
  });

  it('renders an explicit line when the scope has no session, not zeros posing as measurement', () => {
    const fx = createFixture();
    const report = buildStatsReport(fx.store);

    expect(report.session.id).toBeNull();
    expect(report.session.totals).toBeNull();
    expect(renderStatsReport(report)).toContain('no session in this scope yet');
  });

  it('ignores unknown-direction rows in totals AND in the subagents label', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    const child = createChild(fx, current, 'agent-1');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 5 });
    // Only reachable via a raw INSERT — `insertLedgerEntry` throws on unknown
    // directions; `cortex gc`'s rollup is the documented bypass precedent.
    // The dropped tokens must drop from EVERY number, and a direction the
    // fold ignores must not make the header claim a contribution no printed
    // total contains.
    fx.db
      .prepare(
        `INSERT INTO token_ledger (id, session_id, type, direction, tokens, timestamp)
         VALUES ('raw-1', ?, 'mystery', 'refunded', 999, ?)`,
      )
      .run(child, new Date().toISOString());

    const report = buildStatsReport(fx.store);
    expect(report.session.totals!.injected).toBe(5);
    expect(report.session.totals!.saved).toBe(0);
    expect(report.session.includesSubagents).toBe(false);
    expect(renderStatsReport(report)).not.toContain('incl. subagents');
  });

  it('does not claim subagents when only the primary booked rows', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    createChild(fx, current, 'agent-1');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 5 });

    const report = buildStatsReport(fx.store);
    expect(report.session.includesSubagents).toBe(false);
    expect(renderStatsReport(report)).not.toContain('incl. subagents');
  });
});

// ── Scope block (D3) ──────────────────────────────────────────────────

describe('buildStatsReport — scope block', () => {
  it('includes child-session rows and excludes another scope entirely', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    const child = createChild(fx, current, 'agent-1');
    // Another branch's session, older so the preferred scope stays ours.
    const other = createPrimary(fx, '2026-08-01T00:00:00.000Z', 'branch:/stats/root#other');

    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 40 });
    fx.store.insertLedgerEntry({ sessionId: child, type: 'brief', direction: 'injected', tokens: 20 });
    fx.store.insertLedgerEntry({ sessionId: other, type: 'state', direction: 'injected', tokens: 999 });

    const report = buildStatsReport(fx.store);
    expect(report.scope.totals.injected).toBe(60);
    // The other scope's 999 must not leak into this scope's cumulative view.
    expect(report.scope.totals.injected).not.toBe(1059);
  });

  it('scope totals survive a GC rollup byte-identically', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'recall', direction: 'injected', tokens: 100 });
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 50 });
    fx.store.insertLedgerEntry({
      sessionId: current,
      type: 'substitution:read',
      direction: 'saved',
      tokens: 300,
      evidence: { kind: 'read', ref: 'src/e.ts', size: 1200 },
    });
    // A second session in a FOREIGN scope, same direction, also old. This is
    // what makes the assertion able to fail: with one session, a rollup whose
    // GROUP BY loses `session_id` produces identical output (SQLite's
    // bare-column pick returns the only session there is), so the exact
    // regression this test exists to block — cross-session folding that
    // leaks tokens across scope views — ships green on a one-session fixture.
    const foreign = createPrimary(fx, '2026-08-01T00:00:00.000Z', 'branch:/stats/root#other');
    fx.store.insertLedgerEntry({ sessionId: foreign, type: 'recall', direction: 'injected', tokens: 7777 });

    const before = buildStatsReport(fx.store).scope.totals;
    fx.db
      .prepare('UPDATE token_ledger SET timestamp = ?')
      .run(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString());
    // `ledgerDays` is passed EXPLICITLY: relying on the default (14) made the
    // test's firing condition invisible — an exported CORTEX_GC_LEDGER_DAYS
    // above 20 in the running shell, or a raised default, would turn this
    // into comparing unrolled rows with themselves, green forever (found
    // independently by all three review layers).
    runGc(fx.db, { dryRun: false, vacuum: 'never', ledgerDays: 14 });
    // Pre-assert the rollup actually happened — the same discipline the B-6
    // fixture in this file applies ("a ceiling gated on the wrong predicate
    // never fires").
    const rollups = (
      fx.db.prepare("SELECT COUNT(*) AS n FROM token_ledger WHERE type = 'rollup'").get() as {
        n: number;
      }
    ).n;
    expect(rollups).toBeGreaterThan(0);
    const after = buildStatsReport(fx.store).scope.totals;

    // The rollup keeps session_id, so the sessions join still attributes every
    // token to this scope. If GC leaked tokens out of the scope view, the
    // cumulative number would decay with time — the exact "number nobody can
    // check" failure FR-8 retired.
    expect(after).toEqual(before);
  });

  it('reports NULL-scope and orphaned ledger rows as unattributed, counted nowhere', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 40 });
    // A pre-scope-column store: the migration added sessions.scope_key with
    // no backfill, so legacy sessions carry NULL — and the scope JOIN drops
    // their rows from every view. The estimated history FR-8 promised to
    // keep must not silently vanish there.
    const legacy = createPrimary(fx, '2026-08-01T00:00:00.000Z');
    fx.db.prepare('UPDATE sessions SET scope_key = NULL WHERE id = ?').run(legacy);
    fx.store.insertLedgerEntry({ sessionId: legacy, type: 'consolidation', direction: 'estimated', tokens: 600000 });

    const report = buildStatsReport(fx.store);
    // Not in the scope totals…
    expect(report.scope.totals.estimated).toBe(0);
    expect(report.scope.totals.injected).toBe(40);
    // …but not invisible either.
    expect(report.scope.unattributed.estimated).toBe(600000);
    const rendered = renderStatsReport(report);
    expect(rendered).toContain('Unattributed:');
    expect(rendered).toContain('600k estimated');
    expect(rendered).toContain('counted nowhere above');
  });

  it('renders no Unattributed line when every row is scoped', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 40 });
    expect(renderStatsReport(buildStatsReport(fx.store))).not.toContain('Unattributed:');
  });
});

// ── Ratio (D4) ────────────────────────────────────────────────────────

describe('buildStatsReport — ratio', () => {
  it('has no value when nothing was injected, and renders as —', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({
      sessionId: current,
      type: 'substitution:read',
      direction: 'saved',
      tokens: 100,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 400 },
    });

    const report = buildStatsReport(fx.store);
    expect(report.scope.totals.ratio).toBeNull();
    expect(renderStatsReport(report)).toMatch(/Ratio:\s+—/);
  });

  it('is floored, never rounded up — conservative by construction', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 1000 });
    fx.store.insertLedgerEntry({
      sessionId: current,
      type: 'substitution:read',
      direction: 'saved',
      tokens: 996,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 4000 },
    });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    // 996/1000 = 0.996. `toFixed(2)` would print 1.00× — reporting parity the
    // ledger does not support. Under-reporting is acceptable; over-reporting
    // is fatal to trust (FR-9 PM note).
    expect(rendered).toContain('0.99×');
    expect(rendered).not.toContain('1.00×');
  });

  it('excludes unrealized and estimated from both ratio terms and from net', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 100 });
    fx.store.insertLedgerEntry({
      sessionId: current,
      type: 'offer:read',
      direction: 'unrealized',
      tokens: 500,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 2000 },
    });
    fx.store.insertLedgerEntry({ sessionId: current, type: 'consolidation', direction: 'estimated', tokens: 900 });

    const report = buildStatsReport(fx.store);
    expect(report.scope.totals.net).toBe(-100);
    expect(report.scope.totals.ratio).toBe(0);
    // Both are still *reported* — distinctly, never counted.
    const rendered = renderStatsReport(report);
    expect(rendered).toContain('(offered, not taken)');
    expect(rendered).toContain('(retired consolidation estimate, not counted)');
  });

  it('renders a negative net through formatTokens, not raw', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 45827 });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    expect(rendered).toContain('-45.8k');
    expect(rendered).not.toContain('-45827');
  });
});

// ── Unrealized distinct (AC #3) ───────────────────────────────────────

describe('buildStatsReport — unrealized', () => {
  it('is reported distinctly in both blocks when non-zero', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 10 });
    fx.store.insertLedgerEntry({
      sessionId: current,
      type: 'offer:read',
      direction: 'unrealized',
      tokens: 240,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 960 },
    });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    const unrealizedLines = rendered.split('\n').filter(line => line.includes('offered, not taken'));
    // Session block and scope block each carry their own line, so the
    // capability-versus-adoption gap is visible at both granularities.
    expect(unrealizedLines).toHaveLength(2);
  });

  it('is absent when zero', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 10 });

    expect(renderStatsReport(buildStatsReport(fx.store))).not.toContain('offered, not taken');
  });
});

// ── Retrieval health (D5) ─────────────────────────────────────────────

describe('buildStatsReport — retrieval health', () => {
  it('counts every state including archived and pinned, store-wide', () => {
    const fx = createFixture();
    createPrimary(fx, '2026-08-02T00:00:00.000Z');
    seedItem(fx, 'p1', { state: 'pinned' });
    seedItem(fx, 'h1', { state: 'hot' });
    seedItem(fx, 'h2', { state: 'hot' });
    seedItem(fx, 'w1', { state: 'warm' });
    seedItem(fx, 'c1', { state: 'cold' });
    seedItem(fx, 'a1', { state: 'archived' });

    const report = buildStatsReport(fx.store);
    expect(report.items.total).toBe(6);
    expect(report.items.byState).toEqual({ pinned: 1, hot: 2, warm: 1, cold: 1, archived: 1 });
    expect(renderStatsReport(report)).toContain('(pinned 1, hot 2, warm 1, cold 1, archived 1)');
  });

  it('never-retrieved counts access_count = 0 only, across all states', () => {
    const fx = createFixture();
    seedItem(fx, 'z1', { state: 'warm', accessCount: 0 });
    seedItem(fx, 'z2', { state: 'archived', accessCount: 0 });
    seedItem(fx, 'r1', { state: 'warm', accessCount: 3, lastAccessedAt: '2026-08-01T00:00:00.000Z' });

    const report = buildStatsReport(fx.store);
    expect(report.items.neverRetrieved).toBe(2);
  });

  it('top list excludes never-retrieved rows, truncates at ten, and is deterministic', () => {
    const fx = createFixture();
    // 12 retrieved items, several sharing the same count and identical
    // millisecond timestamps — the FR-21 partial-order lesson. 3 never
    // retrieved, which must not pad the list.
    for (let i = 0; i < 12; i += 1) {
      seedItem(fx, `used-${String(i).padStart(2, '0')}`, {
        accessCount: i < 6 ? 5 : 12 - i,
        lastAccessedAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-30T11:02:00.000Z',
      });
    }
    for (let i = 0; i < 3; i += 1) {
      seedItem(fx, `cold-${i}`, { accessCount: 0 });
    }

    const first = buildStatsReport(fx.store);
    const second = buildStatsReport(fx.store);

    expect(first.items.mostRetrieved).toHaveLength(MOST_RETRIEVED_LIMIT);
    expect(MOST_RETRIEVED_LIMIT).toBe(10);
    expect(first.items.mostRetrieved.map(entry => entry.id)).toEqual(
      second.items.mostRetrieved.map(entry => entry.id),
    );
    expect(first.items.mostRetrieved.some(entry => entry.id.startsWith('cold-'))).toBe(false);
    // The exact order, not just "descending": counts are 6, then a seven-way
    // tie at 5 (created in one transaction, millisecond-identical timestamps)
    // broken by rowid DESC, then 4, 3. A double-run comparison alone cannot
    // catch a dropped tiebreaker — a single connection is coincidentally
    // stable — so the order itself is pinned (the FR-21 partial-order lesson).
    expect(first.items.mostRetrieved.map(entry => entry.id)).toEqual([
      'used-06',
      'used-07',
      'used-05',
      'used-04',
      'used-03',
      'used-02',
      'used-01',
      'used-00',
      'used-08',
      'used-09',
    ]);
  });

  it('a retrieval through the real path moves an item up', () => {
    const fx = createFixture();
    seedItem(fx, 'a', { text: 'alpha memory' });
    seedItem(fx, 'b', { text: 'beta memory' });
    seedItem(fx, 'never', { text: 'never retrieved memory' });

    // Through the real writer, not hand-set counters (the FR-22 fixture
    // lesson): if `touchMemoryItems` semantics change, this must break.
    fx.store.touchMemoryItems(['b']);
    fx.store.touchMemoryItems(['b']);
    fx.store.touchMemoryItems(['a']);

    const report = buildStatsReport(fx.store);
    // Exactly the two retrieved items — with slots to spare, a `>= 0` filter
    // would seat `never` in third place. The 12-item fixture above cannot see
    // that mutation: its zero-count rows rank past the LIMIT either way.
    expect(report.items.mostRetrieved.map(entry => entry.id)).toEqual(['b', 'a']);
    expect(report.items.mostRetrieved[0]!.accessCount).toBe(2);
  });

  it('prints the full ordering criterion, tiebreakers included, above a real list', () => {
    const fx = createFixture();
    seedItem(fx, 'r1', { accessCount: 1, lastAccessedAt: '2026-08-01T00:00:00.000Z' });
    const rendered = renderStatsReport(buildStatsReport(fx.store));
    // The FR-21 precedent prints its rowid tiebreaker; so does this surface.
    expect(rendered).toContain('by access count; ties: latest access, then rowid');
    // And the seeded item's line must actually be there — the bare header
    // check was satisfiable by the empty branch ("… none yet"), so this
    // assertion could never fail (review finding).
    expect(rendered).toContain('1× Insight');
    expect(rendered).not.toContain('none yet');
  });

  it('carries the item id as the operator handle into inspect-memory', () => {
    const fx = createFixture();
    seedItem(fx, 'handle-me', { accessCount: 2, lastAccessedAt: '2026-08-01T00:00:00.000Z' });
    const report = buildStatsReport(fx.store);
    // Appended after the labels, so the id survives truncation untouched.
    expect(report.items.mostRetrieved[0]!.line.endsWith('— handle-me')).toBe(true);
  });

  it('renders a placeholder for text that collapses to nothing', () => {
    const fx = createFixture();
    seedItem(fx, 'ctrl-only', {
      accessCount: 3,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      // Entirely control characters (escapes, never literal bytes): BEL, BS,
      // ESC. The collapse strips them all, leaving an empty slot behind the
      // colon.
      text: '\u0007\u0008\u001b',
    });
    const rendered = renderStatsReport(buildStatsReport(fx.store));
    expect(rendered).toContain('(no text)');
  });

  it('never emits a lone surrogate at the truncation cut', () => {
    const fx = createFixture();
    seedItem(fx, 'emoji', {
      accessCount: 4,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      // 60 astral chars = 120 UTF-16 code units; the 99-unit cut lands inside
      // a pair.
      text: '\u{1F600}'.repeat(60),
    });
    const rendered = renderStatsReport(buildStatsReport(fx.store));
    // A high surrogate not followed by a low surrogate is mojibake.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered)).toBe(false);
    expect(rendered).toContain('…');
  });
});

// ── Rendering discipline (D6) ─────────────────────────────────────────

describe('renderStatsReport — stored strings are content', () => {
  it('collapses control characters and newlines so an item cannot forge a row', () => {
    const fx = createFixture();
    seedItem(fx, 'evil', {
      accessCount: 9,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      text: 'before\nInjected:      999999k\u001b[2K\rafter',
    });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\r');
    // The embedded line must not surface as its own row.
    const forged = rendered.split('\n').filter(line => line.trim().startsWith('Injected:      999999k'));
    expect(forged).toHaveLength(0);
    // The ESC and CR are stripped; the printable residue `[2K` stays, the
    // same call the read-ledger and inspect renderers make — control bytes
    // are the danger, not the characters they once decorated.
    expect(rendered).toContain('before Injected: 999999k [2K after');
  });

  it('re-attaches [contested] and (superseded) after truncation', () => {
    const fx = createFixture();
    const longContent = 'decision content '.repeat(20).trim();
    seedItem(fx, 'contested-long', {
      kind: 'note:decision',
      subject: 'store-choice',
      accessCount: 8,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      text: `${longContent}\nSubject: store-choice\nConflict: true`,
    });
    seedItem(fx, 'superseded-long', {
      kind: 'note:decision',
      subject: 'index-choice',
      accessCount: 7,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      text: `${longContent}\nSubject: index-choice\nStatus: superseded`,
    });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    const contestedLine = rendered.split('\n').find(line => line.includes('[contested]'));
    const supersededLine = rendered.split('\n').find(line => line.includes('(superseded)'));
    expect(contestedLine).toBeDefined();
    expect(supersededLine).toBeDefined();
    // Truncated (the content alone is ~340 chars) with the label after the cut.
    expect(contestedLine!).toContain('…');
    expect(contestedLine!.indexOf('…')).toBeLessThan(contestedLine!.indexOf('[contested]'));
  });

  it('does not mark items whose text merely mentions the flags', () => {
    const fx = createFixture();
    seedItem(fx, 'discusses', {
      kind: 'note:insight',
      accessCount: 6,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      text: 'insertNote sets conflict: true on both sides of a contest',
    });
    seedItem(fx, 'episode-log', {
      kind: 'episode:command_failure',
      accessCount: 5,
      lastAccessedAt: '2026-08-01T00:00:00.000Z',
      // An episode's captured stderr can carry the exact line; the kind guard
      // must keep it unmarked.
      text: 'test output\nConflict: true',
    });

    const rendered = renderStatsReport(buildStatsReport(fx.store));
    expect(rendered).not.toContain('[contested]');
  });
});

// ── Non-mutation (D8) ─────────────────────────────────────────────────

describe('buildStatsReport — reads only', () => {
  it('changes no counter, session, or ledger row by being used', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    fx.store.insertLedgerEntry({ sessionId: current, type: 'state', direction: 'injected', tokens: 10 });
    seedItem(fx, 'r1', { accessCount: 2, lastAccessedAt: '2026-08-01T00:00:00.000Z' });

    const snapshot = () => ({
      sessions: (fx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
      ledger: (fx.db.prepare('SELECT COUNT(*) AS n FROM token_ledger').get() as { n: number }).n,
      access: fx.db.prepare('SELECT id, access_count, last_accessed_at, state FROM memory_items ORDER BY id').all(),
      // The write class the stats.ts header names as the reason not to reuse
      // renderMemoryLine: reference validation persists corrected statuses
      // and refreshes the app graph. A future swap to that renderer must turn
      // this test red, so the tables it would dirty are in the snapshot.
      references: (
        fx.db.prepare('SELECT COUNT(*) AS n FROM memory_references').get() as { n: number }
      ).n,
      appGraph: (
        fx.db.prepare('SELECT COUNT(*) AS n FROM current_app_graphs').get() as { n: number }
      ).n,
    });

    const before = snapshot();
    renderStatsReport(buildStatsReport(fx.store));
    renderStatsReport(buildStatsReport(fx.store));
    const after = snapshot();

    // A surface for revealing what ranking holds must not change that ranking
    // by being used (FR-21's rule; the top-10 list is precisely that).
    expect(after).toEqual(before);
  });
});

// ── Store queries ─────────────────────────────────────────────────────

describe('store ledger/scope queries', () => {
  it('returns zeros for an empty scope-key list (guarded before SQL)', () => {
    const fx = createFixture();
    expect(fx.store.getScopeTokenTotals([])).toEqual({
      injected: 0,
      saved: 0,
      unrealized: 0,
      estimated: 0,
    });
    expect(fx.store.getSessionLedgerTotals([])).toEqual([]);
  });

  it('pins the measured SQLite behavior that makes the empty-IN guard equivalent', () => {
    // Executes the actual `IN ()` SQL — the guard above short-circuits before
    // prepare, so the previous version of this test never exercised the
    // clause its title described (review finding). This is the durable
    // artifact behind the store comment and CLAUDE.md bullet calling the
    // guard belt-and-braces: if a future SQLite/binding rejects `IN ()`,
    // this goes red and both claims get re-examined instead of going stale.
    const fx = createFixture();
    const row = fx.db
      .prepare('SELECT COUNT(*) AS n FROM token_ledger WHERE session_id IN ()')
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('clamps a hostile limit instead of dumping the store or throwing raw', () => {
    const fx = createFixture();
    for (let i = 0; i < 15; i += 1) {
      seedItem(fx, `clamp-${String(i).padStart(2, '0')}`, {
        accessCount: i + 1,
        lastAccessedAt: '2026-08-01T00:00:00.000Z',
      });
    }
    // Negative reads as *no limit* in SQLite — the FR-21 dump clause — and
    // NaN throws raw out of better-sqlite3. Public API, so guarded here.
    expect(fx.store.getMostRetrievedMemoryItems(-1)).toHaveLength(10);
    expect(fx.store.getMostRetrievedMemoryItems(Number.NaN)).toHaveLength(10);
    expect(fx.store.getMostRetrievedMemoryItems(3)).toHaveLength(3);
    expect(fx.store.getMostRetrievedMemoryItems(10_000)).toHaveLength(15);
  });
});

// ── B-6 (D7) ──────────────────────────────────────────────────────────

describe('B-6: in-process cost on a 10,000-item store', () => {
  it('build + render p95 stays within 200 ms', () => {
    const fx = createFixture();
    const current = createPrimary(fx, '2026-08-02T00:00:00.000Z');
    const insert = fx.db.prepare(
      `INSERT INTO memory_items
        (id, session_id, scope_type, scope_key, kind, source_table, source_id, subject, text, state, importance, access_count, last_accessed_at, created_at)
       VALUES (?, ?, 'project', ?, 'note:insight', NULL, NULL, NULL, ?, ?, 0.5, ?, ?, ?)`,
    );
    const states = ['hot', 'warm', 'cold', 'archived', 'pinned'];
    fx.db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        insert.run(
          `perf-${i}`,
          current,
          PROJECT_KEY,
          `memory item number ${i} with some text payload for realism`,
          states[i % states.length],
          i % 7 === 0 ? (i % 50) + 1 : 0,
          i % 7 === 0 ? '2026-08-01T00:00:00.000Z' : null,
          '2026-07-30T11:02:00.000Z',
        );
      }
      for (let i = 0; i < 500; i += 1) {
        fx.store.insertLedgerEntry({
          sessionId: current,
          type: 'state',
          direction: 'injected',
          tokens: 40,
        });
      }
    })();

    // Pre-assert the seeded shape (the 3.4 lesson: a ceiling gated on the
    // wrong predicate never fires). A measurement over an empty store would
    // pass vacuously.
    const count = (fx.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get() as { n: number }).n;
    expect(count).toBe(10_000);
    const warmup = buildStatsReport(fx.store);
    expect(warmup.items.mostRetrieved).toHaveLength(10);
    expect(warmup.scope.totals.injected).toBe(20_000);

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now();
      renderStatsReport(buildStatsReport(fx.store));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    // Nearest-rank p95: ceil(0.95 × 20) = 19th value = index 18. The previous
    // formula selected index 19 — the max, i.e. p100 — which is stricter but
    // fails the stated budget on a single GC pause in twenty runs (review
    // finding: mislabeled quantity).
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    expect(p95).toBeLessThanOrEqual(200);
  });
});

// ── CLI surface ───────────────────────────────────────────────────────

describe('cortex stats (CLI)', () => {
  it('prints session, scope, ratio and retrieval health — and Efficiency is gone', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-stats-cli-')));
    const cwd = process.cwd();
    const stdout: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    try {
      process.chdir(root);
      clearProjectStoreCache();
      const seed = openProjectStore(root);
      const seedStore = new CortexStore(seed.db);
      const session = ensureScopedSession(seedStore, root);
      seedStore.insertLedgerEntry({ sessionId: session.id, type: 'state', direction: 'injected', tokens: 1234 });
      seedStore.upsertMemoryItem({
        id: 'cli-item',
        scopeType: 'project',
        scopeKey: session.scope_key,
        kind: 'note:insight',
        text: 'a retrieved memory',
        state: 'warm',
        importance: 0.5,
        accessCount: 4,
        lastAccessedAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-30T11:02:00.000Z',
      });
      seed.db.close();
      clearProjectStoreCache();

      (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        stdout.push(s);
        return true;
      };
      const program = createProgram();
      program.exitOverride();
      program.parse(['stats'], { from: 'user' });
    } finally {
      (process.stdout as unknown as { write: typeof write }).write = write;
      process.chdir(cwd);
      clearProjectStoreCache();
    }

    const out = stdout.join('');
    // Driving the command and asserting nothing is the vacuous test the 3.5
    // reconciliation had to rewrite. Assert the real lines.
    expect(out).toContain('Session:');
    expect(out).toContain('Scope:');
    expect(out).toContain('Injected:');
    // injected=1234, saved=0 → a measured 0.00×, not the no-denominator dash.
    expect(out).toMatch(/Ratio:\s+0\.00×/);
    expect(out).toContain('Memory items:');
    expect(out).toContain('Most retrieved (by access count; ties: latest access, then rowid)');
    expect(out).toContain('a retrieved memory');
    expect(out).toContain('no verified savings yet');
    // D4: Efficiency is replaced by Ratio, not printed alongside it.
    expect(out).not.toContain('Efficiency');
    // FR-25's lines survive.
    expect(out).toContain('Database:');
    expect(out).toContain('WAL:');
  });
});
