import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, ensureCortexSchema, openDatabase } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleReadEvent } from '../src/capture/hooks.js';
import { queryReadLedger } from '../src/query/read-ledger.js';
import { appendSpoolEntry, flushSpool } from '../src/capture/spool.js';
import { handleToolCall } from '../src/transports/mcp.js';
import { createProgram } from '../src/transports/cli.js';
import { openProjectStore, clearProjectStoreCache } from '../src/scope/store-migration.js';
import { ensureScopedSession } from '../src/scope/runtime.js';
import { estimateTokens } from '../src/query/retrieval.js';

/**
 * FR-8: the token P&L (Story 3.5).
 *
 * The story's central act is a WITHDRAWAL — the 657.6k "Saved" the product
 * displayed came from one counterfactual, and AC #3 forbids it. These tests pin
 * the replacement: credit exists only with evidence, an offer the agent
 * declines is recorded separately, and a hot-path credit is booked exactly once
 * or not at all.
 */

interface Fixture {
  store: CortexStore;
  root: string;
  scopeKey: string;
  sessionId: string;
}

function createFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ledger-')));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const scopeKey = `project:${root}`;
  const session = store.createSession({ worktreePath: root, scopeType: 'project', scopeKey });
  return { store, root, scopeKey, sessionId: session.id };
}

function writeFile(fx: Fixture, name: string, body: string): string {
  const file = path.join(fx.root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function ledgerRows(fx: Fixture): {
  type: string;
  direction: string;
  tokens: number;
  evidence_kind: string | null;
  evidence_ref: string | null;
  evidence_size: number | null;
}[] {
  return (fx.store as unknown as { db: Database.Database }).db
    .prepare('SELECT type, direction, tokens, evidence_kind, evidence_ref, evidence_size FROM token_ledger ORDER BY rowid')
    .all() as never;
}

function openOffers(fx: Fixture): number {
  return (
    (fx.store as unknown as { db: Database.Database }).db
      .prepare('SELECT COUNT(*) AS n FROM read_offers')
      .get() as { n: number }
  ).n;
}

describe('token ledger: every output surface books what it injected (AC #1)', () => {
  const RENDERING_TOOLS = [
    'cortex_route',
    'cortex_state',
    'cortex_recall',
    'cortex_brief',
    'cortex_summarize',
    'cortex_suggest_notes',
    'cortex_validate_memory',
    'cortex_read_ledger',
  ];

  it('books an injected row for EVERY rendering tool, not just the four that self-book', () => {
    // Measured before the dispatch-boundary change: 7 of 12 tools rendered into
    // the agent's context and recorded nothing — including `cortex_summarize`,
    // which injects a whole session summary. ~70% of injected tokens were
    // invisible to the P&L that judges whether Cortex earns its place.
    for (const tool of RENDERING_TOOLS) {
      const fx = createFixture();
      const file = writeFile(fx, 'src/a.ts', 'x'.repeat(200));
      handleReadEvent(fx.store, fx.sessionId, { file });
      const args = tool === 'cortex_recall' || tool === 'cortex_brief'
        ? { topic: 'anything' }
        : tool === 'cortex_read_ledger'
          ? { paths: ['src/a.ts'] }
          : {};

      const output = handleToolCall(fx.store, tool, args, fx.root);
      const injected = ledgerRows(fx).filter(r => r.direction === 'injected');
      expect(
        injected.length,
        `${tool} rendered ${output.length} chars and booked nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('books the MEASURED count, not a constant', () => {
    // `tokens: 1` at every site passed the whole suite: the two pre-existing
    // assertions only checked `toBeGreaterThan(0)`, so AC #1's word "measured"
    // was entirely unpinned. Asserting exact equality against the returned text
    // is what kills a constant.
    const fx = createFixture();
    const output = handleToolCall(fx.store, 'cortex_route', {}, fx.root);
    const booked = ledgerRows(fx).find(r => r.direction === 'injected')!;
    expect(booked.tokens).toBe(estimateTokens(output));
    expect(booked.tokens).toBeGreaterThan(1);
  });

  it('holds the ledger write inside the operation transaction (AC #4, AD-8)', () => {
    const fx = createFixture();
    const db = (fx.store as unknown as { db: Database.Database }).db;
    // The direct property AD-8 states. Measured before: `db.inTransaction` was
    // FALSE at six of seven ledger write sites — every one committed in
    // autocommit, so a later failure in the same operation could not roll the
    // row back. The one compliant site was inside the spool flush's
    // transaction, which pre-dates this story and exists for AC #5.
    const seen: boolean[] = [];
    const real = fx.store.insertLedgerEntry.bind(fx.store);
    (fx.store as unknown as { insertLedgerEntry: typeof real }).insertLedgerEntry = opts => {
      seen.push(db.inTransaction);
      real(opts);
    };

    handleToolCall(fx.store, 'cortex_route', {}, fx.root);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('rolls the OPERATION back when the ledger write fails (AC #4, AD-8)', () => {
    const fx = createFixture();
    // The strongest form of "the write shares the operation's transaction":
    // break the ledger write and the operation's own side effect must vanish
    // too. If they were separate statements the note would survive — which is
    // the same defect in the other direction, an operation recorded with no
    // accounting.
    const real = fx.store.insertLedgerEntry.bind(fx.store);
    (fx.store as unknown as { insertLedgerEntry: typeof real }).insertLedgerEntry = () => {
      throw new Error('ledger write failed');
    };

    expect(() =>
      handleToolCall(
        fx.store,
        'cortex_note',
        { kind: 'decision', content: 'Decision: use LRU eviction.', subject: 'eviction' },
        fx.root,
      ),
    ).toThrow(/ledger write failed/);

    (fx.store as unknown as { insertLedgerEntry: typeof real }).insertLedgerEntry = real;
    expect(fx.store.getActiveNotes()).toHaveLength(0);
    expect(ledgerRows(fx)).toHaveLength(0);
  });
});

describe('token ledger: a credit amount must fit its evidence (AC #3)', () => {
  it('refuses more tokens than the evidence can account for', () => {
    const fx = createFixture();
    // Measured before this guard: a spool credit line claiming 1,000,000 tokens
    // against `does/not/exist.ts` with size 0 was accepted, and two such lines
    // produced `Saved: 2.0M`. The spool is a plain JSONL file in the project
    // root appended by a bash hook, so that is a reachable input — and an
    // unchecked amount reintroduces unfalsifiable credit through the door the
    // evidence requirement was meant to close.
    expect(() =>
      fx.store.insertLedgerEntry({
        sessionId: fx.sessionId, type: 'substitution:read', direction: 'saved',
        tokens: 1_000_000, evidence: { kind: 'read', ref: 'does/not/exist.ts', size: 0 },
      }),
    ).toThrow(/claims 1000000 tokens against 0 bytes/);

    expect(() =>
      fx.store.insertLedgerEntry({
        sessionId: fx.sessionId, type: 'substitution:read', direction: 'saved',
        tokens: 26, evidence: { kind: 'read', ref: 'a.ts', size: 100 },
      }),
    ).toThrow(/max 25/);

    // Exactly at the ceiling is fine: you may save every token the file holds.
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:read', direction: 'saved',
      tokens: 25, evidence: { kind: 'read', ref: 'a.ts', size: 100 },
    });
    expect(fx.store.getTotalTokens().saved).toBe(25);
  });

  it('refuses an empty reference and a malformed size', () => {
    const fx = createFixture();
    for (const evidence of [
      { kind: 'read' as const, ref: '', size: 100 },
      { kind: 'read' as const, ref: '   ', size: 100 },
      { kind: 'read' as const, ref: 'a.ts', size: -1 },
      { kind: 'read' as const, ref: 'a.ts', size: 1.5 },
      { kind: 'read' as const, ref: 'a.ts', size: Number.NaN },
    ]) {
      expect(() =>
        fx.store.insertLedgerEntry({
          sessionId: fx.sessionId, type: 't', direction: 'saved', tokens: 1, evidence,
        }),
      ).toThrow();
    }
    expect(ledgerRows(fx)).toHaveLength(0);
  });

  it('does not bound a SEARCH credit by bytes, because its evidence is a result count', () => {
    const fx = createFixture();
    // A search's evidence is "result count", not bytes, so `bytes/4` is not a
    // meaningful ceiling. Inventing one would be a fake guarantee; the
    // reference is still required.
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:search', direction: 'saved',
      tokens: 400, evidence: { kind: 'search', ref: 'deriveReadKey', size: 3 },
    });
    expect(fx.store.getTotalTokens().saved).toBe(400);
    expect(() =>
      fx.store.insertLedgerEntry({
        sessionId: fx.sessionId, type: 'substitution:search', direction: 'saved',
        tokens: 400, evidence: { kind: 'search', ref: '', size: 3 },
      }),
    ).toThrow(/non-empty evidence ref/);
  });
});

describe('token ledger: evidence is required for credit (AC #2, #3)', () => {
  it('refuses saved and unrealized rows with no evidence', () => {
    const fx = createFixture();
    for (const direction of ['saved', 'unrealized'] as const) {
      expect(() =>
        fx.store.insertLedgerEntry({ sessionId: fx.sessionId, type: 't', direction, tokens: 10 }),
      ).toThrow(/requires evidence/);
    }
    expect(ledgerRows(fx)).toHaveLength(0);
  });

  it('stores the three evidence shapes the AC names', () => {
    const fx = createFixture();
    // file + byte size for an avoided read, output size for an avoided command,
    // result count for an avoided search.
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:read', direction: 'saved', tokens: 500,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 2048 },
    });
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:command', direction: 'saved', tokens: 80,
      evidence: { kind: 'command', ref: 'npm test', size: 320 },
    });
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:search', direction: 'saved', tokens: 12,
      evidence: { kind: 'search', ref: 'deriveReadKey', size: 0 },
    });

    expect(ledgerRows(fx).map(r => [r.evidence_kind, r.evidence_ref, r.evidence_size])).toEqual([
      ['read', 'src/a.ts', 2048],
      ['command', 'npm test', 320],
      ['search', 'deriveReadKey', 0],
    ]);
  });

  it('validates tokens for EVERY direction, not only credit', () => {
    const fx = createFixture();
    // `injected` was unguarded, so `tokens: Infinity` was accepted and then
    // made `Net` and `Efficiency` both NaN in `cortex stats`. A guard asymmetry
    // with no argument behind it.
    for (const tokens of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5]) {
      expect(() =>
        fx.store.insertLedgerEntry({
          sessionId: fx.sessionId, type: 'recall', direction: 'injected', tokens,
        }),
      ).toThrow(/whole non-negative token count/);
    }
    expect(ledgerRows(fx)).toHaveLength(0);
  });

  it('refuses a direction outside the four', () => {
    const fx = createFixture();
    // Such a row contributes to none of `getTotalTokens`' four sums while
    // sitting in the table and being rolled up by GC, so `SUM(tokens)` stops
    // reconciling against the reported figures — silently.
    expect(() =>
      fx.store.insertLedgerEntry({
        sessionId: fx.sessionId, type: 't',
        direction: 'refunded' as unknown as 'injected', tokens: 10,
      }),
    ).toThrow(/unknown ledger direction/);
  });

  it('injected rows carry no evidence and are not credit', () => {
    const fx = createFixture();
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'recall', direction: 'injected', tokens: 300,
    });
    const totals = fx.store.getTotalTokens();
    expect(totals.spent).toBe(300);
    expect(totals.saved).toBe(0);
    expect(ledgerRows(fx)[0]!.evidence_kind).toBeNull();
  });

  it('keeps estimated separate from saved so it cannot inflate the claim', () => {
    const fx = createFixture();
    // The retired consolidation credit lands here. It stays readable — deleting
    // it would destroy audit history — but it is not a saving.
    (fx.store as unknown as { db: Database.Database }).db
      .prepare(
        `INSERT INTO token_ledger (id, session_id, type, direction, tokens, timestamp)
         VALUES ('legacy', ?, 'consolidation', 'estimated', 657600, ?)`,
      )
      .run(fx.sessionId, new Date().toISOString());

    const totals = fx.store.getTotalTokens();
    expect(totals.estimated).toBe(657600);
    expect(totals.saved).toBe(0);
  });
});

/**
 * A store in the shape an older binary left it: real schema, then downgraded.
 *
 * Hand-writing a two-table database is the tempting shortcut and it is wrong —
 * it omits everything else `ensureCortexSchema` touches (the first attempt died
 * on `sessions.parent_session_id` when the index pass ran), so the test would
 * be exercising a database no user has ever had. Building the real thing and
 * removing exactly what Story 3.5 adds gives a genuine pre-migration store.
 */
function createLegacyStore(
  seed: (ledger: (id: string, type: string, direction: string, tokens: number) => void) => void,
): { root: string; dbPath: string; sessionId: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-legacy-')));
  const dbPath = path.join(root, 'cortex.db');
  const db = new Database(dbPath);
  applySchema(db);
  initializeMeta(db, root);
  const sessionId = new CortexStore(db).createSession({
    worktreePath: root,
    scopeType: 'project',
    scopeKey: `project:${root}`,
  }).id;

  const insert = db.prepare(
    `INSERT INTO token_ledger (id, session_id, type, direction, tokens, timestamp)
     VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  );
  seed((id, type, direction, tokens) => {
    insert.run(id, sessionId, type, direction, tokens);
  });

  // Downgrade: remove exactly what this story adds.
  db.exec(`
    ALTER TABLE token_ledger DROP COLUMN evidence_kind;
    ALTER TABLE token_ledger DROP COLUMN evidence_ref;
    ALTER TABLE token_ledger DROP COLUMN evidence_size;
  `);
  db.close();
  return { root, dbPath, sessionId };
}

describe('token ledger: the spent -> injected migration', () => {
  it('migrates legacy rows, including rollups, and reclassifies evidence-free credit', () => {
    const { root, dbPath, sessionId } = createLegacyStore(ledger => {
      ledger('a', 'recall', 'spent', 100);
      ledger('b', 'rollup', 'spent', 900);
      ledger('c', 'consolidation', 'saved', 657600);
      ledger('d', 'rollup', 'saved', 4200);
    });
    void sessionId;

    const db = openDatabase(dbPath);
    ensureCortexSchema(db, root);
    const rows = db
      .prepare('SELECT id, direction FROM token_ledger ORDER BY id')
      .all() as { id: string; direction: string }[];

    // The ROLLUP rows migrate too. `cortex gc` aggregates GROUP BY direction, so
    // a rollup left on the old value forms a second, parallel total that no
    // query adds up.
    expect(rows).toEqual([
      { id: 'a', direction: 'injected' },
      { id: 'b', direction: 'injected' },
      { id: 'c', direction: 'estimated' },
      { id: 'd', direction: 'estimated' },
    ]);
    db.close();
  });

  it('is idempotent — a second open changes nothing', () => {
    const { root, dbPath, sessionId } = createLegacyStore(ledger => {
      ledger('a', 'recall', 'spent', 100);
    });

    const first = openDatabase(dbPath);
    ensureCortexSchema(first, root);
    // Add a REAL evidence-backed saving between the two runs. The second pass
    // must not sweep it into `estimated`: the reclassification keys on evidence
    // being absent, not on the direction alone.
    new CortexStore(first).insertLedgerEntry({
      sessionId, type: 'substitution:read', direction: 'saved', tokens: 500,
      evidence: { kind: 'read', ref: 'src/a.ts', size: 2000 },
    });
    first.close();

    const second = openDatabase(dbPath);
    ensureCortexSchema(second, root);
    const totals = new CortexStore(second).getTotalTokens();
    expect(totals.spent).toBe(100);
    expect(totals.saved).toBe(500);
    expect(totals.estimated).toBe(0);
    second.close();
  });
});

describe('token ledger: hot-path credit through the spool (AC #5, AD-15)', () => {
  it('books a credit record carrying its own evidence', () => {
    const fx = createFixture();
    appendSpoolEntry(fx.root, {
      tool: 'credit',
      credit_kind: 'read',
      credit_ref: 'src/substituted.ts',
      credit_size: '4096',
      credit_tokens: '1024',
    });

    const result = flushSpool(fx.store, fx.root, fx.sessionId);
    expect(result.processed).toBe(1);

    const rows = ledgerRows(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'substitution:read',
      direction: 'saved',
      tokens: 1024,
      evidence_kind: 'read',
      evidence_ref: 'src/substituted.ts',
      evidence_size: 4096,
    });
  });

  it('books it exactly once across repeated flushes', () => {
    const fx = createFixture();
    appendSpoolEntry(fx.root, {
      tool: 'credit', credit_kind: 'read', credit_ref: 'src/a.ts',
      credit_size: '100', credit_tokens: '25',
    });
    flushSpool(fx.store, fx.root, fx.sessionId);
    flushSpool(fx.store, fx.root, fx.sessionId);
    flushSpool(fx.store, fx.root, fx.sessionId);
    // Exactly-once is the flush's existing atomic claim; a credit that booked
    // per flush would let a single avoided read pay out repeatedly.
    expect(ledgerRows(fx)).toHaveLength(1);
    expect(fx.store.getTotalTokens().saved).toBe(25);
  });

  it('drops an incomplete credit rather than booking a default', () => {
    const fx = createFixture();
    // Each of these is missing exactly one part of its evidence.
    appendSpoolEntry(fx.root, { tool: 'credit', credit_ref: 'a', credit_size: '1', credit_tokens: '1' });
    appendSpoolEntry(fx.root, { tool: 'credit', credit_kind: 'read', credit_size: '1', credit_tokens: '1' });
    appendSpoolEntry(fx.root, { tool: 'credit', credit_kind: 'read', credit_ref: 'a', credit_tokens: '1' });
    appendSpoolEntry(fx.root, { tool: 'credit', credit_kind: 'read', credit_ref: 'a', credit_size: '1' });
    // And a bogus kind, which must not be coerced into one of the three.
    appendSpoolEntry(fx.root, {
      tool: 'credit', credit_kind: 'anything' as never, credit_ref: 'a',
      credit_size: '1', credit_tokens: '1',
    });

    flushSpool(fx.store, fx.root, fx.sessionId);
    // AC #5: "a lost spool record results in no credit rather than a
    // reconstructed one" — the same rule for a partial record as an absent one.
    expect(ledgerRows(fx)).toHaveLength(0);
  });

  it('a bad credit line loses only itself, never the batch or the claim (AD-12)', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/real.ts', 'real\n');
    // A real read and a real command share the batch with a credit line that
    // over-claims. Before this guard the over-claim threw out of `replayEntry`,
    // aborted the flush transaction AND skipped the claim-file unlink — so the
    // `.processing` file survived, every later flush re-read it and threw
    // again, and ambient capture was dead permanently and silently. One
    // malformed line cost all memory from that point on.
    appendSpoolEntry(fx.root, { tool: 'read', file });
    appendSpoolEntry(fx.root, {
      tool: 'credit', credit_kind: 'read', credit_ref: 'src/x.ts',
      credit_size: '4', credit_tokens: '1000000',
    });
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm test', exit: '0' });

    const first = flushSpool(fx.store, fx.root, fx.sessionId);
    expect(first.processed).toBe(2);
    expect(first.skipped).toBe(1);
    expect(ledgerRows(fx).filter(r => r.direction === 'saved')).toHaveLength(0);
    // The real work survived...
    expect(fx.store.getEventsBySession(fx.sessionId).length).toBeGreaterThan(0);

    // ...and the next batch still flushes, which is what the stuck claim broke.
    appendSpoolEntry(fx.root, { tool: 'read', file });
    expect(() => flushSpool(fx.store, fx.root, fx.sessionId)).not.toThrow();
  });

  it('survives a credit field that arrives as a JSON number, not a string', () => {
    const fx = createFixture();
    appendSpoolEntry(fx.root, { tool: 'read', file: writeFile(fx, 'src/a.ts', 'a\n') });
    // `jq` preserves JSON types, so a hook emitting `credit_size: 4096`
    // unquoted delivers a number — and `raw.trim is not a function` threw off
    // the capture path. `normalizeAgentId` documents this same hazard and
    // coerces; the credit fields were added without it.
    appendSpoolEntry(fx.root, {
      tool: 'credit', credit_kind: 'read', credit_ref: 'src/a.ts',
      credit_size: 4096 as unknown as string, credit_tokens: 512 as unknown as string,
    });

    const result = flushSpool(fx.store, fx.root, fx.sessionId);
    expect(result.processed).toBe(2);
    expect(ledgerRows(fx).filter(r => r.direction === 'saved')).toHaveLength(1);
  });

  it('books a replayed credit exactly once even from a duplicated claim', () => {
    const fx = createFixture();
    // TWO byte-identical credit lines in ONE batch. That is what an orphaned
    // `.processing` claim read by two processes delivers, and it is the only
    // form of replay a test can stage honestly: flushing the same content
    // twice is *skipped by the processed marker*, so an earlier version of this
    // test passed while the mutation removing the stable id survived — vacuous,
    // for exactly the reason the marker exists.
    const line = {
      tool: 'credit' as const, credit_kind: 'read' as const, credit_ref: 'src/a.ts',
      credit_size: '400', credit_tokens: '100', seq: 1, ts: '2026-08-02T12:00:00.000Z',
    };
    appendSpoolEntry(fx.root, line);
    appendSpoolEntry(fx.root, line);
    flushSpool(fx.store, fx.root, fx.sessionId);

    expect(ledgerRows(fx).filter(r => r.direction === 'saved')).toHaveLength(1);
    expect(fx.store.getTotalTokens().saved).toBe(100);
  });

  it('parses credit numbers with Number, not parseInt', () => {
    const fx = createFixture();
    // `parseInt('12abc')` is 12, which would book credit from a malformed line.
    for (const bad of ['12abc', '1e3', '-5', '1.5', '', '   ', 'NaN']) {
      appendSpoolEntry(fx.root, {
        tool: 'credit', credit_kind: 'read', credit_ref: 'a',
        credit_size: '100', credit_tokens: bad,
      });
    }
    flushSpool(fx.store, fx.root, fx.sessionId);
    expect(ledgerRows(fx)).toHaveLength(0);
  });
});

describe('token ledger: unrealized savings (AC #6)', () => {
  it('records a decline when the agent reads a file Cortex offered as unchanged', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });

    // The offer: the agent asked, and Cortex said it already has this content.
    const [answer] = queryReadLedger(fx.store, {
      paths: [file], sessionId: fx.sessionId, recordOffers: true,
    });
    expect(answer!.verdict).toBe('unchanged-since');
    expect(answer!.refundEligible).toBe(true);
    // The offer is NOT a ledger row. Written as one, it counted as unrealized
    // the instant it was made.
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);

    // The decline: it reads the file anyway.
    handleReadEvent(fx.store, fx.sessionId, { file });

    const unrealized = ledgerRows(fx).filter(r => r.direction === 'unrealized' && r.type === 'unrealized:read');
    expect(unrealized).toHaveLength(1);
    expect(unrealized[0]!.evidence_kind).toBe('read');
    expect(unrealized[0]!.evidence_size).toBe(4000);
    // Separate from savings, so the capability-versus-adoption gap is visible
    // rather than folded into a number that looks like success either way.
    expect(fx.store.getTotalTokens().saved).toBe(0);
    expect(fx.store.getTotalTokens().unrealized).toBeGreaterThan(0);
  });

  it('an agent that ADOPTS the answer scores differently from one that ignores it', () => {
    // The defect this pins: the offer was written as an `unrealized` ledger row
    // at the moment it was MADE, so both agents produced identical totals and
    // the figure rendered "(offered, not taken)" actually meant "offered". A
    // metric that cannot separate perfect adoption from total non-adoption is
    // measuring Cortex's helpfulness under a label claiming the opposite.
    const adopts = createFixture();
    const fileA = writeFile(adopts, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(adopts.store, adopts.sessionId, { file: fileA });
    queryReadLedger(adopts.store, {
      paths: [fileA], sessionId: adopts.sessionId, recordOffers: true,
    });
    // ...and then does NOT re-read it. That is the success case.

    const ignores = createFixture();
    const fileB = writeFile(ignores, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(ignores.store, ignores.sessionId, { file: fileB });
    queryReadLedger(ignores.store, {
      paths: [fileB], sessionId: ignores.sessionId, recordOffers: true,
    });
    handleReadEvent(ignores.store, ignores.sessionId, { file: fileB });

    expect(adopts.store.getTotalTokens().unrealized).toBe(0);
    expect(ignores.store.getTotalTokens().unrealized).toBeGreaterThan(0);
  });

  it('asking the same question repeatedly leaves ONE offer, not one per call', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    // Following the documented best practice — ask before re-reading — must not
    // inflate the adoption-failure metric. Five calls previously left five
    // offers, of which at most one could ever be consumed.
    for (let i = 0; i < 5; i += 1) {
      queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    }
    // ...and a single call naming the same path three times.
    queryReadLedger(fx.store, {
      paths: [file, file, file], sessionId: fx.sessionId, recordOffers: true,
    });

    handleReadEvent(fx.store, fx.sessionId, { file });
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(1);
    expect(openOffers(fx)).toBe(0);
  });

  it('an expired offer is never counted as a decline', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    expect(openOffers(fx)).toBe(1);

    // Age it past the window. An offer nobody acted on is not adoption failure;
    // as a ledger row it stayed counted forever.
    (fx.store as unknown as { db: Database.Database }).db
      .prepare('UPDATE read_offers SET offered_at = ?')
      .run('2020-01-01T00:00:00.000Z');

    handleReadEvent(fx.store, fx.sessionId, { file });
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
    expect(fx.store.pruneExpiredReadOffers()).toBe(1);
  });

  it("records a SUBAGENT's decline against the offer made to its parent", () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    // `cortex_read_ledger` resolves without an agent id, so the offer is always
    // made to the PRIMARY — while a subagent's Read replays under its own child
    // session. Matching on session equality meant a delegated read could never
    // be seen as a decline, and delegated work is most tool calls here.
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });

    const child = fx.store.createSession({
      parentSessionId: fx.sessionId, agentId: 'sub-1', agentType: 'general-purpose',
      worktreePath: fx.root, scopeType: 'project', scopeKey: fx.scopeKey,
    });
    handleReadEvent(fx.store, child.id, { file });

    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(1);
  });

  it('never offers on a read that was NOT the asking session\'s (AD-16)', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    // A SIBLING read the file. AD-16 forbids presenting that as "you already
    // have this" — so there is no offer to decline, and reading it is not a
    // declined offer. Dropping the `refundEligible` gate books an offer that
    // was never made and then counts the agent as refusing it.
    const parent = fx.store.createSession({
      worktreePath: fx.root, scopeType: 'project', scopeKey: fx.scopeKey,
    });
    const sibling = fx.store.createSession({
      parentSessionId: parent.id, agentId: 'sib-1', agentType: 'code-reviewer',
      worktreePath: fx.root, scopeType: 'project', scopeKey: fx.scopeKey,
    });
    handleReadEvent(fx.store, sibling.id, { file });

    const [answer] = queryReadLedger(fx.store, {
      paths: [file], sessionId: fx.sessionId, recordOffers: true,
    });
    expect(answer!.verdict).toBe('unchanged-since');
    expect(answer!.refundEligible).toBe(false);
    expect(openOffers(fx)).toBe(0);

    handleReadEvent(fx.store, fx.sessionId, { file });
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
  });

  it('bounds the offer token estimate by the recorded byte size', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    handleReadEvent(fx.store, fx.sessionId, { file });

    const decline = ledgerRows(fx).find(r => r.direction === 'unrealized')!;
    // ceil(4000 / 4). The ratio is load-bearing: it is what makes the figure
    // comparable to `estimateTokens`, and it is an upper bound rather than an
    // equality for non-ASCII content.
    expect(decline.tokens).toBe(1000);
    expect(decline.evidence_size).toBe(4000);
    expect(decline.tokens).toBeLessThanOrEqual(Math.ceil(decline.evidence_size! / 4));
  });

  it('makes no offer for a zero-byte file', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/empty.ts', '');
    handleReadEvent(fx.store, fx.sessionId, { file });
    // Nothing is avoided by not reading an empty file, and a 0-token credit is
    // noise in a ledger whose whole point is that every number means something.
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    expect(openOffers(fx)).toBe(0);
  });

  it('consuming an offer and booking the decline is ONE transaction', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    expect(openOffers(fx)).toBe(1);

    // As two operations, a failure between them destroyed the offer and
    // recorded nothing — measured, "offer consumed but nothing booked: true".
    // Unrecoverable, because the offer is gone. Moving offers out of
    // `token_ledger` fixed AD-8's append-only violation and did NOT fix this;
    // they are separate defects and the first was reported as covering both.
    const real = fx.store.insertLedgerEntry.bind(fx.store);
    (fx.store as unknown as { insertLedgerEntry: typeof real }).insertLedgerEntry = () => {
      throw new Error('booking failed');
    };
    handleReadEvent(fx.store, fx.sessionId, { file });
    (fx.store as unknown as { insertLedgerEntry: typeof real }).insertLedgerEntry = real;

    // The offer survives, so the decline can still be recorded later. Losing it
    // silently is the outcome AC #6 cannot tolerate.
    expect(openOffers(fx)).toBe(1);
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
  });

  it('will not consume a FUTURE-dated offer', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });
    // A clock jump, or a store carried between machines. Only the lower bound
    // was checked, so such an offer stayed consumable indefinitely.
    (fx.store as unknown as { db: Database.Database }).db
      .prepare('UPDATE read_offers SET offered_at = ?')
      .run('2099-01-01T00:00:00.000Z');

    handleReadEvent(fx.store, fx.sessionId, { file });
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
  });

  it('reports all four directions in the per-type breakdown', () => {
    const fx = createFixture();
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'recall', direction: 'injected', tokens: 300,
    });
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'substitution:read', direction: 'saved', tokens: 25,
      evidence: { kind: 'read', ref: 'a.ts', size: 100 },
    });
    fx.store.insertLedgerEntry({
      sessionId: fx.sessionId, type: 'unrealized:read', direction: 'unrealized', tokens: 25,
      evidence: { kind: 'read', ref: 'b.ts', size: 100 },
    });
    // `byType` carried only spent/saved, so unrealized and estimated rows fell
    // out of it entirely — a consumer would under-report with no sign that rows
    // were missing.
    const stats = fx.store.getLedgerStats();
    expect(stats.byType['recall']?.spent).toBe(300);
    expect(stats.byType['substitution:read']?.saved).toBe(25);
    expect(stats.byType['unrealized:read']?.unrealized).toBe(25);
    expect(stats.unrealized).toBe(25);
  });

  it('books nothing when no offer was made', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    handleReadEvent(fx.store, fx.sessionId, { file });
    // Reading a file twice is not a declined offer. Without this, every repeat
    // read would be counted as adoption failure — a modeled number, which is
    // what AC #3 forbids on the savings side and is no better here.
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
  });

  it('an offer answers for exactly one decline', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId, recordOffers: true });

    handleReadEvent(fx.store, fx.sessionId, { file });
    handleReadEvent(fx.store, fx.sessionId, { file });
    handleReadEvent(fx.store, fx.sessionId, { file });
    // A loop reading the same file ten times would otherwise book ten declines
    // from one offer, inflating the exact figure this exists to keep honest.
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(1);
  });

  it('the CLI surface records offers and books its own output, like MCP', () => {
    // An agent reaches the ledger by shelling out to the CLI as readily as
    // through MCP. The CLI recorded neither the offer nor what it injected, so
    // the same question answered two ways produced different accounting —
    // which is how a metric stops being trustworthy.
    //
    // Run against the store the CLI itself resolves (hermetic: `CORTEX_HOME`
    // is a temp dir for the whole suite), then reopen it and assert. Driving
    // the command and asserting nothing would be the vacuous test this file
    // has already had to correct twice.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-ledger-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const rel = 'src/a.ts';
    fs.writeFileSync(path.join(root, rel), 'x'.repeat(4000));

    const cwd = process.cwd();
    const stdout: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    try {
      process.chdir(root);
      clearProjectStoreCache();
      // Seed the read through the same store the CLI will open.
      const seed = openProjectStore(root);
      const seedStore = new CortexStore(seed.db);
      const session = ensureScopedSession(seedStore, root);
      handleReadEvent(seedStore, session.id, { file: path.join(root, rel) });
      seed.db.close();
      clearProjectStoreCache();

      (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        stdout.push(s);
        return true;
      };
      const program = createProgram();
      program.exitOverride();
      program.parse(['read-ledger', rel], { from: 'user' });
    } finally {
      (process.stdout as unknown as { write: typeof write }).write = write;
      process.chdir(cwd);
      clearProjectStoreCache();
    }

    expect(stdout.join('')).toContain('unchanged-since');

    const check = openProjectStore(root);
    const store = new CortexStore(check.db);
    const offers = (
      check.db.prepare('SELECT COUNT(*) AS n FROM read_offers').get() as { n: number }
    ).n;
    const injected = (
      check.db
        .prepare("SELECT COUNT(*) AS n FROM token_ledger WHERE type = 'read_ledger' AND direction = 'injected'")
        .get() as { n: number }
    ).n;
    check.db.close();
    clearProjectStoreCache();

    expect(offers).toBe(1);
    expect(injected).toBe(1);
    void store;
  });

  it('does NOT record offers for Cortex probing itself', () => {
    const fx = createFixture();
    const file = writeFile(fx, 'src/a.ts', 'x'.repeat(4000));
    handleReadEvent(fx.store, fx.sessionId, { file });

    // The default. `knownUnchangedFiles` — which the session brief runs on every
    // SessionStart — goes through this path. If it recorded offers, Cortex would
    // manufacture offers to itself and then count the agent as declining them.
    queryReadLedger(fx.store, { paths: [file], sessionId: fx.sessionId });
    expect(ledgerRows(fx).filter(r => r.type === 'offer:read')).toHaveLength(0);

    handleReadEvent(fx.store, fx.sessionId, { file });
    expect(ledgerRows(fx).filter(r => r.direction === 'unrealized')).toHaveLength(0);
  });
});
