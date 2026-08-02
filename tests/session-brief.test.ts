import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { buildSessionBrief, buildSessionBriefForTest, formatLedgerPath } from '../src/query/session-brief.js';
import { knownUnchangedFiles } from '../src/query/read-ledger.js';
import { handleReadEvent } from '../src/capture/hooks.js';
import { createDigestCache } from '../src/capture/digest.js';

function createStore(): CortexStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/root');
  return new CortexStore(db);
}

function seedNote(
  store: CortexStore,
  sessionId: string,
  scopeKey: string,
  id: string,
  kind: string,
  subject: string,
  text: string,
  ageDays = 1,
): void {
  store.upsertMemoryItem({
    id,
    sessionId,
    scopeType: 'branch',
    scopeKey,
    kind,
    sourceTable: 'notes',
    sourceId: id,
    subject,
    text,
    state: 'hot',
    importance: 2.5,
    createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
  });
}

// ── FR-7: the read-ledger line (Story 3.4) ───────────────────────────────────

/**
 * A brief fixture backed by a REAL directory.
 *
 * The ledger line's whole claim is "still unchanged", which Story 3.3 answers by
 * re-hashing — so a store-only fixture cannot exercise it at all. Files go on
 * disk under `os.tmpdir()`, never a literal `/tmp`: on Windows those are
 * different filesystems.
 */
interface LedgerFixture {
  store: CortexStore;
  root: string;
  scopeKey: string;
  sessionId: string;
}

function createLedgerFixture(): LedgerFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-brief-')));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const scopeKey = `branch:${root}:main`;
  const session = store.createSession({
    worktreePath: root,
    scopeType: 'branch',
    scopeKey,
    branchRef: 'main',
  });
  store.upsertCurrentAppGraph({ scopeKey, scopeType: 'branch', files: [] });
  return { store, root, scopeKey, sessionId: session.id };
}

const LEDGER_PREFIX = '- read in this scope, still unchanged: ';

/** The files named on the ledger line, in rendered order. */
function ledgerFiles(brief: string): string[] {
  const line = brief.split('\n').find(l => l.startsWith(LEDGER_PREFIX));
  expect(line).toBeDefined();
  return line!.slice(LEDGER_PREFIX.length).split(', ');
}

/** Write a file and record `reads` reads of it, so `read_count` is meaningful. */
function seedRead(fx: LedgerFixture, name: string, body: string, reads = 1): string {
  const file = path.join(fx.root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  for (let i = 0; i < reads; i += 1) {
    handleReadEvent(fx.store, fx.sessionId, { file });
  }
  return file;
}

describe('session brief: read-ledger line (FR-7)', () => {
  it('names unchanged files, most-read first, capped at five (AC #1)', () => {
    const fx = createLedgerFixture();
    // Deliberately seeded out of order, so passing requires the ORDER BY rather
    // than insertion order. Six files, so the cap is exercised too.
    // Read counts are DISTINCT, and the names are chosen so that alphabetical
    // order is the REVERSE of read-count order. `content_digests` is WITHOUT
    // ROWID keyed on (scope_key, path), so with no ORDER BY at all SQLite scans
    // in path-alphabetical order — and an earlier version of this test used
    // a.ts..f.ts with descending counts, making the two orders identical for
    // the top five. Deleting the ORDER BY clause outright passed.
    seedRead(fx, 'src/zulu.ts', 'z\n', 11);
    seedRead(fx, 'src/yankee.ts', 'y\n', 9);
    seedRead(fx, 'src/xray.ts', 'x\n', 7);
    seedRead(fx, 'src/whiskey.ts', 'w\n', 5);
    seedRead(fx, 'src/victor.ts', 'v\n', 3);
    seedRead(fx, 'src/alpha.ts', 'a\n', 1);

    const named = ledgerFiles(buildSessionBrief(fx.store));
    expect(named).toHaveLength(5);
    expect(named).toEqual([
      'src/zulu.ts',
      'src/yankee.ts',
      'src/xray.ts',
      'src/whiskey.ts',
      'src/victor.ts',
    ]);
    // Alphabetically first, least read: present iff the ordering is wrong.
    expect(named).not.toContain('src/alpha.ts');
  });

  it('never says "you" — the reads belong to earlier sessions (AD-16)', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/a.ts', 'a\n', 3);
    const brief = buildSessionBrief(fx.store);
    // `inject-header` makes a fresh primary every SessionStart, so essentially
    // every recorded read is an earlier session's. Story 3.3 hit the same wall
    // and stopped rendering `read by primary`.
    expect(brief).toContain('read in this scope, still unchanged');
    expect(brief).not.toMatch(/\byou\b/i);
  });

  it('omits a file whose content changed since it was read', () => {
    const fx = createLedgerFixture();
    const stable = seedRead(fx, 'src/stable.ts', 'stable\n', 5);
    const churned = seedRead(fx, 'src/churned.ts', 'before\n', 9);
    // Precondition: the churned file outranks the stable one, so its absence is
    // the freshness check and not the ordering.
    expect(fx.store.getContentDigest(fx.scopeKey, churned)).toBeDefined();
    fs.writeFileSync(churned, 'after\n');

    const brief = buildSessionBrief(fx.store);
    expect(brief).toContain('src/stable.ts');
    expect(brief).not.toContain('src/churned.ts');
    void stable;
  });

  it('omits a deleted file', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/kept.ts', 'kept\n', 2);
    const gone = seedRead(fx, 'src/gone.ts', 'gone\n', 8);
    fs.rmSync(gone);

    const brief = buildSessionBrief(fx.store);
    expect(brief).toContain('src/kept.ts');
    expect(brief).not.toContain('src/gone.ts');
  });

  it('emits nothing on a cold start, even with the ledger enabled (AC #3, N-1)', () => {
    const fx = createLedgerFixture();
    // No notes, no summaries, no reads: nothing has happened in this scope.
    expect(buildSessionBrief(fx.store)).toBe('');
  });

  it('carries the brief on its own when nothing else qualifies', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/a.ts', 'a\n', 2);
    // Digests exist, so a prior session existed — this is not a cold start, and
    // the orientation hint is the whole value on offer.
    const brief = buildSessionBrief(fx.store);
    expect(brief).toContain('Cortex memory');
    expect(brief).toContain('- read in this scope, still unchanged: src/a.ts');
  });

  it('drops the ledger line FIRST when the budget binds (AC #2)', () => {
    const fx = createLedgerFixture();
    seedNote(
      fx.store,
      fx.sessionId,
      fx.scopeKey,
      'note-1',
      'note:decision',
      'auth strategy',
      'Decision: keep sessions server-side.\nSubject: auth strategy',
    );
    seedRead(fx, 'src/a.ts', 'a\n', 4);

    const generous = buildSessionBrief(fx.store, { budget: 150 });
    expect(generous).toContain('read in this scope, still unchanged');
    expect(generous).toContain('keep sessions server-side');

    // Tight enough that both cannot fit. The note is load-bearing memory; the
    // ledger line is an orientation hint, so the hint is what must go.
    const tight = buildSessionBrief(fx.store, { budget: 30 });
    expect(tight).not.toContain('read in this scope, still unchanged');
    expect(tight).toContain('keep sessions server-side');
  });

  it('drops the ledger line before the resume line, not merely last-in-wins', () => {
    const fx = createLedgerFixture();
    fx.store.upsertMemoryItem({
      id: 'summary-1',
      sessionId: fx.sessionId,
      scopeType: 'branch',
      scopeKey: fx.scopeKey,
      kind: 'episode:session_summary',
      sourceTable: 'episodes',
      sourceId: 'summary-1',
      subject: 'last session',
      text: 'Wired the flush path end to end and verified it against the installed hook.',
      state: 'hot',
      importance: 2.0,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    seedRead(fx, 'src/a.ts', 'a\n', 4);

    // Both present at a generous budget.
    const generous = buildSessionBrief(fx.store, { budget: 150 });
    expect(generous).toContain('- resume:');
    expect(generous).toContain('read in this scope, still unchanged');

    // Sweep every budget rather than guessing one. Picking a single number
    // pins whatever the current line lengths happen to be, and the invariant is
    // an ORDER, not a threshold: there must exist no budget at which the ledger
    // line survives while the resume line has already been dropped. A ledger
    // line that merely sat last would violate this the moment a resume line
    // rendered longer than it.
    let sawLedgerWithoutResume = 0;
    let sawResumeWithoutLedger = 0;
    for (let budget = 5; budget <= 150; budget += 1) {
      const brief = buildSessionBrief(fx.store, { budget });
      const hasLedger = brief.includes('read in this scope, still unchanged');
      const hasResume = brief.includes('- resume:');
      if (hasLedger && !hasResume) sawLedgerWithoutResume += 1;
      if (hasResume && !hasLedger) sawResumeWithoutLedger += 1;
    }
    expect(sawLedgerWithoutResume).toBe(0);
    // And the ordering is actually exercised somewhere in the range, so this
    // cannot pass by both lines always appearing or always vanishing together.
    expect(sawResumeWithoutLedger).toBeGreaterThan(0);
  });

  it('survives a filesystem failure with the rest of the brief intact (AD-12)', () => {
    const fx = createLedgerFixture();
    seedNote(
      fx.store,
      fx.sessionId,
      fx.scopeKey,
      'note-1',
      'note:decision',
      'auth strategy',
      'Decision: keep sessions server-side.\nSubject: auth strategy',
    );
    seedRead(fx, 'src/a.ts', 'a\n', 3);

    // SessionStart is bound to silence by AD-12, and a brief that dies takes
    // the notes with it — so a throw from the ledger path must cost the line,
    // never the brief.
    //
    // The seam matters. An earlier version of this test built a Proxy that
    // threw on `.db`, asserted the Proxy broke `knownUnchangedFiles`, and then
    // called `buildSessionBrief(fx.store)` — the REAL store. The function under
    // test never saw the broken one, so removing the whole `try`/`catch` was
    // invisible. A broad Proxy cannot be the fix either: it breaks
    // `resolveWorkingScopeKeys` first, so the brief dies before the ledger is
    // reached and the catch is still not exercised. The throw has to originate
    // inside the ledger path and nowhere else.
    const brief = buildSessionBriefForTest(fx.store, {}, {
      knownUnchangedFiles: () => {
        throw new Error('simulated ledger failure');
      },
    });
    expect(brief).toContain('keep sessions server-side');
    expect(brief).not.toContain('still unchanged');
    // And the same store with the ledger working DOES render the line, so the
    // assertion above cannot pass because the line never appears anyway.
    expect(buildSessionBrief(fx.store)).toContain('still unchanged');
  });

  it('never renders a header and footer with no content between them', () => {
    const fx = createLedgerFixture();
    seedNote(
      fx.store, fx.sessionId, fx.scopeKey, 'note-1', 'note:decision',
      'auth strategy', 'Decision: keep sessions server-side.\nSubject: auth strategy',
    );
    seedRead(fx, 'src/a.ts', 'a\n', 3);
    // Sweep the range where the budget squeezes everything out. A brief that
    // renders only `Cortex memory (...):` and `More: cortex_recall(topic).`
    // costs tokens and carries no memory — measured at 48 of 60 budgets with
    // the guard removed, and invisible to every other test.
    for (let budget = 1; budget <= 60; budget += 1) {
      const brief = buildSessionBrief(fx.store, { budget });
      if (brief === '') continue;
      const lines = brief.split('\n');
      expect(lines.length).toBeGreaterThan(2);
    }
  });

  it('does not let an oversize record burn a candidate slot', () => {
    const fx = createLedgerFixture();
    // Six unchanged files, but the top-ranked one is oversize. If the SQL
    // clause excluding `sha256 IS NULL` were dropped, that row would occupy a
    // slot and return `unverifiable` forever, so only four real files could
    // ever be named. Asserting the outcome alone (the oversize file is absent)
    // passes either way — the slot is what has to be observed.
    seedRead(fx, 'src/huge.ts', 'huge\n', 99);
    (fx.store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('UPDATE content_digests SET sha256 = NULL, oversize = 1 WHERE path = ?')
      .run('src/huge.ts');
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      seedRead(fx, `src/${name}.ts`, `${name}\n`, 5);
    }

    // The slot has to be SCARCE for its consumption to be observable. With the
    // default window of 24 and six rows, dropping the SQL clause changes
    // nothing — the oversize row is skipped later by verdict and the five real
    // files still fit. Measured: that version of this test passed against an
    // implementation with the clause deleted. A window of exactly 5 makes the
    // slot the thing under test.
    // Set, not order: these five share a read_count, so their relative order is
    // the `recorded_at` tiebreak and asserting it would pin an arbitrary
    // detail. Ordering is covered by the distinct-count test above.
    expect(
      [...knownUnchangedFiles(fx.store, [fx.scopeKey], { candidateLimit: 5 })].sort(),
    ).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    expect(ledgerFiles(buildSessionBrief(fx.store))).not.toContain('src/huge.ts');
  });

  it('refuses a negative candidateLimit instead of handing SQLite "no limit"', () => {
    const fx = createLedgerFixture();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      seedRead(fx, `src/${name}.ts`, `${name}\n`, 5);
    }
    // SQLite reads a negative LIMIT as *unlimited* — the hazard `resolvePageLimit`
    // already documents for `list-memory`. `NaN < 1` is false too, so an
    // unguarded NaN sails through every comparison.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(knownUnchangedFiles(fx.store, [fx.scopeKey], { candidateLimit: bad }))
        .toHaveLength(5);
    }
    // A real, small window still narrows.
    expect(knownUnchangedFiles(fx.store, [fx.scopeKey], { candidateLimit: 2 }))
      .toHaveLength(2);
  });

  it('hashes a file recorded under two scope keys only once', () => {
    const fx = createLedgerFixture();
    const file = seedRead(fx, 'src/shared.ts', 'shared\n', 4);
    const otherScope = `project:${fx.root}`;
    fx.store.createSession({
      worktreePath: fx.root, scopeType: 'project', scopeKey: otherScope,
    });
    handleReadEvent(fx.store, fx.store.createSession({
      worktreePath: fx.root, scopeType: 'project', scopeKey: otherScope,
    }).id, { file });

    // Count cache CONSTRUCTIONS, not stat calls. An earlier version counted the
    // injected `statSync`, which `currentSizeOf` calls once per deduped path —
    // so it read 1 whether the memo was shared or rebuilt per file, and the
    // mutation replacing the shared memo survived. One cache per walk is the
    // property; building one per file returns identical answers, so only the
    // construction count can observe it.
    let cacheBuilds = 0;
    const files = knownUnchangedFiles(
      fx.store,
      [fx.scopeKey, otherScope],
      {},
      {
        createDigestCache: (...args: Parameters<typeof createDigestCache>) => {
          cacheBuilds += 1;
          return createDigestCache(...args);
        },
        statSync: fs.statSync,
      },
    );
    expect(files).toEqual(['src/shared.ts']);
    expect(cacheBuilds).toBe(1);
  });

  it('neutralises a path that would forge a brief line', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/real.ts', 'real\n', 5);
    // Reachable on Linux/macOS/WSL — the platforms `hooks/` ships for — because
    // a filename may contain a newline and `toScopeRelativeKey` preserves it.
    // Staged directly here so the case is testable on win32 too.
    (fx.store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('UPDATE content_digests SET path = ? WHERE path = ?')
      .run('src/a.ts\n- resume: FABRICATED\n- x.ts', 'src/real.ts');

    const brief = buildSessionBrief(fx.store);
    // Two independent guarantees. End to end, no forged line reaches the brief
    // — here because the mangled key names nothing on disk, so it is skipped as
    // unmeasurable before it can be rendered.
    expect(brief).not.toContain('- resume: FABRICATED');
    expect(brief.split('\n').filter(l => l.startsWith('- resume:'))).toHaveLength(0);

    // And the renderer itself neutralises it, which is the guarantee that has
    // to hold on Linux/macOS/WSL where such a file CAN exist and therefore CAN
    // be measured. Asserting only the end-to-end case would leave the
    // sanitizer untested on the platforms it exists for.
    const forged = formatLedgerPath('src/a.ts\n- resume: FABRICATED\n- x.ts');
    expect(forged).not.toContain('\n');
    expect(forged).not.toContain('\r');
    expect(formatLedgerPath('a\rOVERWRITE.ts')).not.toContain('\r');
  });

  it('quotes a path containing a comma so it cannot read as two files', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/a,b.ts', 'ab\n', 5);
    seedRead(fx, 'src/z.ts', 'z\n', 4);
    // An ordinary filename on every platform. Unquoted, two real files render
    // as three names.
    const named = ledgerFiles(buildSessionBrief(fx.store));
    expect(named).toEqual(['"src/a,b.ts"', 'src/z.ts']);
  });

  it('caps a single path so one deep path cannot eat the brief', () => {
    const fx = createLedgerFixture();
    const deep = `src/${'nested/'.repeat(12)}component.ts`;
    seedRead(fx, deep, 'deep\n', 9);
    seedRead(fx, 'src/b.ts', 'b\n', 8);

    const named = ledgerFiles(buildSessionBrief(fx.store));
    expect(named).toHaveLength(2);
    // The basename survives, which is what identifies the file.
    expect(named[0]!.length).toBeLessThanOrEqual(46);
    expect(named[0]).toContain('component.ts');
    expect(named[0]).toContain('…');
  });

  it('ignores a scope whose root cannot be resolved, rather than using cwd', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/a.ts', 'a\n', 3);
    // An orphan scope key with no session carrying a worktree_path. Stored keys
    // are RELATIVE, so `resolveOnDiskPath` would anchor them to `process.cwd()`
    // — the substitution Story 3.2 measured relocating every key it touched.
    // On the live store the project scope key already resolves to null, and it
    // is one of the two keys the brief always passes.
    const orphan = 'project:orphan-scope-with-no-session';
    expect(fx.store.resolveScopeRoot(orphan)).toBeNull();
    // A row under the orphan scope naming a path that EXISTS relative to cwd.
    // Asserting an empty result is not enough: with the guard removed the
    // resolver falls back to `process.cwd()`, hashes the repo's own file, and
    // still returns [] because the hash will not match — so the test passed
    // against the defect. What has to be observed is that the filesystem under
    // cwd is never touched at all.
    (fx.store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(
        `INSERT INTO content_digests
           (scope_key, path, sha256, byte_size, mtime, session_id, agent_id, oversize, read_count, recorded_at)
         VALUES (?, 'package.json', 'deadbeef', 10, NULL, ?, NULL, 0, 50, ?)`,
      )
      .run(orphan, fx.sessionId, new Date().toISOString());

    const statted: string[] = [];
    const files = knownUnchangedFiles(fx.store, [orphan, fx.scopeKey], {}, {
      createDigestCache,
      statSync: ((p: fs.PathLike) => {
        statted.push(String(p));
        return fs.statSync(p);
      }) as typeof fs.statSync,
    });
    expect(files).toEqual(['src/a.ts']);
    const cwd = process.cwd().replace(/\\/g, '/').toLowerCase();
    expect(
      statted.map(p => p.replace(/\\/g, '/').toLowerCase()).filter(p => p.startsWith(cwd)),
    ).toEqual([]);
  });

  it('bounds hashing by ACTUAL size, not the recorded byte_size', () => {
    const fx = createLedgerFixture();
    // Recorded tiny, grown large. The meter charged `byte_size` from the table
    // while the hash reads what is on disk now — measured, rows totalling 24
    // recorded bytes hashed 48 MiB. A grown file is by definition *changed*, so
    // it never becomes a hit, which is why the old `found.length > 0` gate
    // never armed for it and the two defects compounded into a B-1 breach.
    for (const name of ['g1', 'g2', 'g3']) {
      seedRead(fx, `src/${name}.ts`, 'x\n', 9);
      fs.writeFileSync(path.join(fx.root, 'src', `${name}.ts`), 'y'.repeat(600 * 1024));
    }
    seedRead(fx, 'src/small.ts', 'small\n', 1);

    let bytesMeasured = 0;
    knownUnchangedFiles(fx.store, [fx.scopeKey], { byteBudget: 1024 * 1024 }, {
      createDigestCache,
      statSync: ((p: fs.PathLike) => {
        const stat = fs.statSync(p);
        bytesMeasured += stat.isFile() ? stat.size : 0;
        return stat;
      }) as typeof fs.statSync,
    });
    // Two grown files (1.17 MiB) exceed the 1 MiB budget, so the walk stops.
    // Charging the recorded sizes instead would have walked all four.
    expect(bytesMeasured).toBeLessThan(1.4 * 1024 * 1024);
  });

  it('bounds hashing by recorded byte_size before opening anything', () => {
    const fx = createLedgerFixture();
    // One large file ranked first, then small ones. With a budget smaller than
    // the large file, the walk must still return it and then stop — the point
    // is that the ceiling is consulted using `byte_size` from Story 3.1 rather
    // than discovered after paying for the read.
    seedRead(fx, 'src/big.ts', 'x'.repeat(64 * 1024), 9);
    seedRead(fx, 'src/s1.ts', 'a\n', 5);
    seedRead(fx, 'src/s2.ts', 'b\n', 4);

    const bounded = knownUnchangedFiles(fx.store, [fx.scopeKey], { byteBudget: 1024 });
    expect(bounded).toEqual(['src/big.ts']);

    const unbounded = knownUnchangedFiles(fx.store, [fx.scopeKey]);
    expect(unbounded).toEqual(['src/big.ts', 'src/s1.ts', 'src/s2.ts']);
  });

  it('skips an oversize record, which can never be verified', () => {
    const fx = createLedgerFixture();
    seedRead(fx, 'src/ok.ts', 'ok\n', 2);
    const big = seedRead(fx, 'src/huge.ts', 'huge\n', 9);
    // Story 3.1 stores path and size only past the ceiling, so there is no hash
    // to compare. Such a row would burn a candidate slot forever.
    (fx.store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('UPDATE content_digests SET sha256 = NULL, oversize = 1 WHERE path = ?')
      .run('src/huge.ts');
    void big;

    expect(knownUnchangedFiles(fx.store, [fx.scopeKey])).toEqual(['src/ok.ts']);
  });

  it('builds the brief within B-1 (<=150 ms p95) with the ledger enabled', () => {
    const fx = createLedgerFixture();
    for (let i = 0; i < 40; i += 1) {
      seedRead(fx, `src/f${i}.ts`, 'x'.repeat(8 * 1024), (i % 7) + 1);
    }
    seedNote(
      fx.store,
      fx.sessionId,
      fx.scopeKey,
      'note-1',
      'note:decision',
      'auth strategy',
      'Decision: keep sessions server-side.\nSubject: auth strategy',
    );

    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = process.hrtime.bigint();
      buildSessionBrief(fx.store);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThanOrEqual(150);
  });
});

describe('buildSessionBrief', () => {
  it('emits nothing on a cold start', () => {
    const store = createStore();
    store.createSession({ scopeType: 'branch', scopeKey: 'branch:repo:main' });
    expect(buildSessionBrief(store)).toBe('');
  });

  it('leads with validated branch-scoped load-bearing notes and a recall pointer', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertCurrentAppGraph({
      scopeKey: 'branch:repo:main',
      scopeType: 'branch',
      files: ['src/auth/login.ts'],
    });
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-decision',
      'note:decision',
      'auth login',
      'decision: keep the login flow in src/auth/login.ts behind the session guard.',
    );
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-blocker',
      'note:blocker',
      'vitest teardown',
      'blocker: vitest hangs on db teardown until the handle closes.',
      2,
    );
    // An insight should not appear: brief is decisions/blockers/intents only.
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-insight',
      'note:insight',
      'misc',
      'insight: something minor.',
    );

    const brief = buildSessionBrief(store);
    const lines = brief.split('\n');

    expect(lines[0]).toBe('Cortex memory (main):');
    expect(lines[lines.length - 1]).toBe('More: cortex_recall(topic).');
    expect(brief).toContain('decision: [auth login] keep the login flow');
    expect(brief).toContain('blocker: [vitest teardown] vitest hangs on db teardown');
    expect(brief).not.toContain('something minor');
    expect(brief.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(4);
  });

  it('drops notes whose referenced files are all gone and labels partial staleness', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertCurrentAppGraph({
      scopeKey: 'branch:repo:main',
      scopeType: 'branch',
      files: ['src/kept.ts'],
    });
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-all-gone',
      'note:decision',
      'dead decision',
      'decision: everything lived in src/removed.ts before the rewrite.',
    );
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-partial',
      'note:decision',
      'partial decision',
      'decision: src/kept.ts stays but src/dropped.ts was folded in.',
    );

    const brief = buildSessionBrief(store);

    expect(brief).not.toContain('dead decision');
    expect(brief).toContain('partial decision');
    expect(brief).toContain('(refs: 1 missing)');
  });

  it('includes a resume line from a recent session summary', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    store.upsertMemoryItem({
      id: 'brief-summary',
      sessionId: session.id,
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      kind: 'episode:session_summary',
      sourceTable: 'episodes',
      sourceId: 'brief-summary',
      subject: null,
      text: '## Session Summary | migrated the store reads to the new query layer',
      state: 'warm',
      importance: 1.4,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const brief = buildSessionBrief(store);

    expect(brief).toContain('- resume: Session Summary | migrated the store reads');
  });

  it('stays within the token budget by dropping bullets from the bottom', () => {
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });
    for (let i = 0; i < 3; i++) {
      seedNote(
        store,
        session.id,
        'branch:repo:main',
        `brief-long-${i}`,
        'note:decision',
        `subsystem ${i}`,
        `decision: subsystem ${i} adopts a long-winded multi-clause policy describing migration passes, rollout gates, fallback handling, and verification steps in detail.`,
        i + 1,
      );
    }

    const brief = buildSessionBrief(store, { budget: 60 });

    expect(brief).not.toBe('');
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(60);
    expect(brief.startsWith('Cortex memory (main):')).toBe(true);
    expect(brief).toContain('More: cortex_recall(topic).');
  });
});

// ── Contested marker (FR-2, review round 1) ───────────────────────────

describe('buildSessionBrief — contested notes', () => {
  it('marks a contested decision', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });

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

    // This channel prints unprompted on every SessionStart and selects
    // note:decision in state 'warm' — exactly an active contested decision.
    // Unmarked, it presents one side of an open contest as settled memory.
    const brief = buildSessionBrief(store);
    expect(brief).toContain('decision:');
    expect(brief).toContain('[contested]');
  });

  it('leaves an uncontested decision unmarked', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });

    expect(buildSessionBrief(store)).not.toContain('[contested]');
  });

  it('stays inside its token budget with the marker present', () => {
    const store = createStore();
    const session = store.createSession({ focus: 'spool flush' });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'flush the spool at turn end',
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'spool flush',
      content: 'do not flush the spool at turn end',
    });

    const brief = buildSessionBrief(store);
    expect(brief).toContain('[contested]');
    // The SessionStart brief is capped at 150 tokens and must stay small.
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(150);
  });
});

// ── Superseded exclusion (FR-4, Story 1.4) ─────────────────────────────

describe('buildSessionBrief — superseded items', () => {
  it('never briefs a superseded decision, even one hot enough to qualify', () => {
    // The demoted tier is warm at best, and warm is inside BRIEF_STATES — so
    // without an explicit filter this channel would present a just-retracted
    // decision as settled context on every SessionStart. Resolved never needed
    // the filter because it lands cold, outside the set; superseded does.
    const store = createStore();
    const session = store.createSession({
      scopeType: 'branch',
      scopeKey: 'branch:repo:main',
      branchRef: 'main',
    });

    // An active twin proves the fixture qualifies on every other axis: same
    // kind, same state, same importance, same age — only the status line
    // differs. If the twin stops rendering, the fixture stopped being
    // adversarial and this test fails loudly.
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-active-twin',
      'note:decision',
      'queue engine',
      'decision: use kafka for the queue engine.',
    );
    seedNote(
      store,
      session.id,
      'branch:repo:main',
      'brief-superseded',
      'note:decision',
      'auth strategy',
      'decision: use oauth1 for the auth strategy.\nSubject: auth strategy\nStatus: superseded',
    );

    const brief = buildSessionBrief(store);
    expect(brief).toContain('use kafka for the queue engine');
    expect(brief).not.toContain('oauth1');
  });
});
