import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { spawnSync } from 'node:child_process';
import { flushSpool } from '../src/capture/spool.js';
import { runGc } from '../src/db/gc.js';
import { findPosixTool } from './posix-tools.js';

/** Absolute, never bare `git`: PATH resolution differs under vitest on win32. */
const GIT = findPosixTool('git') ?? 'git';
import {
  CENSUS_DEFAULT_MAX_BYTES,
  CENSUS_DEFAULT_MAX_FILES,
  computeRootCensus,
} from '../src/capture/census.js';
import {
  CERTIFIABLE_PATTERN,
  SEARCH_LEDGER_MAX_QUERIES,
  SEARCH_LEDGER_TOKENS_PER_QUERY,
  canonicalSearchQuery,
  isCertifiableSearch,
  normalizeSearchRoot,
  querySearchLedger,
  renderSearchLedger,
  renderSearchLedgerLine,
  searchQueryKey,
  type SearchLedgerResult,
  type SearchQuery,
} from '../src/query/search-ledger.js';
import { normalizeSearchQueries } from '../src/transports/mcp.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const SCOPE_A = 'branch:C:/repo:refs/heads/main';
const SCOPE_B = 'branch:C:/repo:refs/heads/other';

function memoryStore(root = 'C:/repo'): CortexStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  return new CortexStore(db);
}

function baseUpsert(overrides: Record<string, unknown> = {}) {
  return {
    scopeKey: SCOPE_A,
    queryKey: 'aabbccddeeff0011',
    tool: 'grep',
    pattern: 'zzz_nonexistent',
    root: 'src',
    paramsJson: '{"glob":"*.ts"}',
    headOid: '4ae5ac84813fbe5e',
    censusSha256: 'c'.repeat(64),
    censusFiles: 3,
    censusBytes: 1024,
    ...overrides,
  };
}

// ── Store layer: negative_results ────────────────────────────────────

describe('negative_results store methods', () => {
  it('round-trips an upserted record through getNegativeResult', () => {
    const store = memoryStore();
    const written = store.upsertNegativeResult(baseUpsert());

    const read = store.getNegativeResult(SCOPE_A, 'aabbccddeeff0011');
    expect(read).toBeDefined();
    expect(read).toEqual(written);
    expect(read?.scopeKey).toBe(SCOPE_A);
    expect(read?.queryKey).toBe('aabbccddeeff0011');
    expect(read?.tool).toBe('grep');
    expect(read?.pattern).toBe('zzz_nonexistent');
    expect(read?.root).toBe('src');
    expect(read?.paramsJson).toBe('{"glob":"*.ts"}');
    expect(read?.headOid).toBe('4ae5ac84813fbe5e');
    expect(read?.censusSha256).toBe('c'.repeat(64));
    expect(read?.censusFiles).toBe(3);
    expect(read?.censusBytes).toBe(1024);
    expect(typeof read?.recordedAt).toBe('string');
  });

  it('upserting the same (scope, key) replaces the census — last certified wins', () => {
    const store = memoryStore();
    store.upsertNegativeResult(baseUpsert({ recordedAt: '2026-08-01T00:00:00.000Z' }));
    store.upsertNegativeResult(
      baseUpsert({
        censusSha256: 'd'.repeat(64),
        censusFiles: 4,
        censusBytes: 2048,
        headOid: 'ffff000011112222',
        recordedAt: '2026-08-02T00:00:00.000Z',
      }),
    );

    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM negative_results')
      .get() as { n: number };
    expect(rows.n).toBe(1);

    const read = store.getNegativeResult(SCOPE_A, 'aabbccddeeff0011');
    expect(read?.censusSha256).toBe('d'.repeat(64));
    expect(read?.censusFiles).toBe(4);
    expect(read?.censusBytes).toBe(2048);
    expect(read?.headOid).toBe('ffff000011112222');
    expect(read?.recordedAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('optional fields (paramsJson, headOid) round-trip as null when omitted', () => {
    const store = memoryStore();
    store.upsertNegativeResult(baseUpsert({ paramsJson: undefined, headOid: undefined }));
    const read = store.getNegativeResult(SCOPE_A, 'aabbccddeeff0011');
    expect(read?.paramsJson).toBeNull();
    expect(read?.headOid).toBeNull();
  });

  it('never returns a record across a scope boundary (AC #5, store half)', () => {
    const store = memoryStore();
    store.upsertNegativeResult(baseUpsert());

    expect(store.getNegativeResult(SCOPE_B, 'aabbccddeeff0011')).toBeUndefined();

    // Same query key in the other scope is a distinct row, not a collision.
    store.upsertNegativeResult(baseUpsert({ scopeKey: SCOPE_B, censusFiles: 9 }));
    expect(store.getNegativeResult(SCOPE_A, 'aabbccddeeff0011')?.censusFiles).toBe(3);
    expect(store.getNegativeResult(SCOPE_B, 'aabbccddeeff0011')?.censusFiles).toBe(9);
  });

  it('survives a real close-and-reopen through a fresh applySchema (durability)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-negative-'));
    const dbPath = path.join(dir, 'cortex.db');
    try {
      const db1 = new Database(dbPath);
      db1.pragma('foreign_keys = ON');
      applySchema(db1);
      initializeMeta(db1, 'C:/repo');
      const store1 = new CortexStore(db1);
      store1.upsertNegativeResult(baseUpsert());
      db1.close();

      const db2 = new Database(dbPath);
      db2.pragma('foreign_keys = ON');
      applySchema(db2); // must be additive-idempotent over the existing row
      const store2 = new CortexStore(db2);
      const read = store2.getNegativeResult(SCOPE_A, 'aabbccddeeff0011');
      expect(read?.censusSha256).toBe('c'.repeat(64));
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The census ───────────────────────────────────────────────────────

function censusRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-census-')));
}

function seedTree(root: string): void {
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha.ts'), 'export const one = 1;\n');
  fs.writeFileSync(path.join(root, 'sub', 'beta.md'), '# beta\n');
  fs.writeFileSync(path.join(root, 'zeta.txt'), 'plain\n');
}

describe('computeRootCensus', () => {
  it('is deterministic across runs and independent of creation order', () => {
    const a = censusRoot();
    const b = censusRoot();
    try {
      // Same content, opposite creation order.
      fs.mkdirSync(path.join(a, 'sub'));
      fs.writeFileSync(path.join(a, 'alpha.ts'), 'X');
      fs.writeFileSync(path.join(a, 'sub', 'beta.md'), 'Y');
      fs.writeFileSync(path.join(b, 'x-temp'), 'Z');
      fs.mkdirSync(path.join(b, 'sub'));
      fs.writeFileSync(path.join(b, 'sub', 'beta.md'), 'Y');
      fs.writeFileSync(path.join(b, 'alpha.ts'), 'X');
      fs.rmSync(path.join(b, 'x-temp'));

      const one = computeRootCensus(a);
      const two = computeRootCensus(a);
      const three = computeRootCensus(b);
      expect(one).toEqual(two);
      expect(one.status).toBe('ok');
      expect(three).toEqual(one);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('changes when content changes, a file is added, renamed, or deleted', () => {
    const root = censusRoot();
    try {
      seedTree(root);
      const base = computeRootCensus(root);
      expect(base.status).toBe('ok');
      const sha = base.status === 'ok' ? base.sha256 : '';

      fs.writeFileSync(path.join(root, 'alpha.ts'), 'export const one = 2;\n');
      const edited = computeRootCensus(root);
      expect(edited.status === 'ok' && edited.sha256 !== sha).toBe(true);

      fs.writeFileSync(path.join(root, 'alpha.ts'), 'export const one = 1;\n');
      const restored = computeRootCensus(root);
      expect(restored.status === 'ok' && restored.sha256 === sha).toBe(true);

      fs.writeFileSync(path.join(root, 'new.ts'), 'n');
      const added = computeRootCensus(root);
      expect(added.status === 'ok' && added.sha256 !== sha).toBe(true);
      fs.rmSync(path.join(root, 'new.ts'));

      fs.renameSync(path.join(root, 'zeta.txt'), path.join(root, 'yeta.txt'));
      const renamed = computeRootCensus(root);
      expect(renamed.status === 'ok' && renamed.sha256 !== sha).toBe(true);
      fs.renameSync(path.join(root, 'yeta.txt'), path.join(root, 'zeta.txt'));

      fs.rmSync(path.join(root, 'sub', 'beta.md'));
      const deleted = computeRootCensus(root);
      expect(deleted.status === 'ok' && deleted.sha256 !== sha).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores .git and .cortex.* — Cortex must not observe its own exhaust', () => {
    const root = censusRoot();
    try {
      seedTree(root);
      const base = computeRootCensus(root);
      expect(base.status).toBe('ok');

      fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
      fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(root, '.cortex.spool.jsonl'), '{"v":1}\n');
      fs.writeFileSync(path.join(root, '.cortex.state'), 'enabled=true\n');
      fs.mkdirSync(path.join(root, 'sub', '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, 'sub', '.git', 'noise'), 'x');

      const withExhaust = computeRootCensus(root);
      // The FINGERPRINT is unchanged — but the skipped Cortex files are now
      // reported, because the caller must prove the search skipped them too
      // (measured: it does not, in a repo whose ignore file was never swept).
      expect(withExhaust.status === 'ok' && base.status === 'ok' && withExhaust.sha256).toBe(
        base.status === 'ok' ? base.sha256 : '',
      );
      expect(withExhaust.status === 'ok' ? withExhaust.excludedCortex.sort() : []).toEqual([
        '.cortex.spool.jsonl',
        '.cortex.state',
      ]);
      // `.git` is NOT reported: its contents were measured unsearchable.
      expect(
        (withExhaust.status === 'ok' ? withExhaust.excludedCortex : []).some(p =>
          p.includes('.git'),
        ),
      ).toBe(false);

      // A dot-file that is NOT cortex exhaust still counts.
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
      const withDot = computeRootCensus(root);
      expect(withDot.status === 'ok' && base.status === 'ok' && withDot.sha256 !== base.sha256).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles a root that is a single file', () => {
    const root = censusRoot();
    try {
      seedTree(root);
      const file = path.join(root, 'alpha.ts');
      const one = computeRootCensus(file);
      expect(one.status).toBe('ok');
      expect(one.status === 'ok' && one.files).toBe(1);

      fs.appendFileSync(file, '// more\n');
      const two = computeRootCensus(file);
      expect(one.status === 'ok' && two.status === 'ok' && two.sha256 !== one.sha256).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a missing root as missing, never as an empty ok census', () => {
    const root = censusRoot();
    fs.rmSync(root, { recursive: true, force: true });
    expect(computeRootCensus(root)).toEqual({ status: 'missing' });
  });

  it('reports overflow past the file-count and byte ceilings', () => {
    const root = censusRoot();
    try {
      seedTree(root); // 3 files
      expect(computeRootCensus(root, { maxFiles: 2, maxBytes: CENSUS_DEFAULT_MAX_BYTES }).status).toBe(
        'overflow',
      );
      expect(computeRootCensus(root, { maxFiles: CENSUS_DEFAULT_MAX_FILES, maxBytes: 4 }).status).toBe(
        'overflow',
      );
      expect(computeRootCensus(root, { maxFiles: 3, maxBytes: CENSUS_DEFAULT_MAX_BYTES }).status).toBe(
        'ok',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts directories against the ceiling — growth by folders is bounded too', () => {
    // The walk bounded files and bytes but recursed into directories freely, so
    // a tree grown only by (even empty) directories never tripped `overflow`:
    // unbounded work on the flush path, and at pathological depth a stack
    // overflow escaping every per-syscall catch.
    const root = censusRoot();
    try {
      seedTree(root); // 3 files
      for (let i = 0; i < 20; i++) {
        fs.mkdirSync(path.join(root, `d${i}`));
      }
      expect(computeRootCensus(root, { maxFiles: 10, maxBytes: CENSUS_DEFAULT_MAX_BYTES }).status).toBe(
        'overflow',
      );
      expect(computeRootCensus(root, { maxFiles: 100, maxBytes: CENSUS_DEFAULT_MAX_BYTES }).status).toBe(
        'ok',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a root that is itself a Cortex runtime file is unreadable, not censused', () => {
    // The file-root branch bypassed the exclusion entirely, so a search rooted
    // at `.cortex.state` fingerprinted Cortex's own exhaust.
    const root = censusRoot();
    try {
      const exhaust = path.join(root, '.cortex.state');
      fs.writeFileSync(exhaust, 'enabled=true\n');
      expect(computeRootCensus(exhaust).status).toBe('unreadable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an empty directory added under the root does not change the census', () => {
    // rg finds nothing in an empty directory, so zero stays zero — the census
    // deliberately fingerprints file content, not directory shape.
    const root = censusRoot();
    try {
      seedTree(root);
      const base = computeRootCensus(root);
      fs.mkdirSync(path.join(root, 'hollow'));
      expect(computeRootCensus(root)).toEqual(base);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Canonical key + certifiability ───────────────────────────────────

describe('searchQueryKey / canonicalSearchQuery', () => {
  const base: SearchQuery = { pattern: 'findTreasure', root: 'src' };

  it('is stable for identical queries and sensitive to every matching-relevant field', () => {
    expect(searchQueryKey(base)).toBe(searchQueryKey({ ...base }));
    const variants: SearchQuery[] = [
      { ...base, pattern: 'findTreasureX' },
      { ...base, root: 'src/utils' },
      { ...base, glob: '*.ts' },
      { ...base, type: 'ts' },
      { ...base, caseInsensitive: true },
      { ...base, multiline: true },
    ];
    const keys = new Set([searchQueryKey(base), ...variants.map(searchQueryKey)]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it('cannot be forged across field boundaries by hostile field content', () => {
    // Field values are NUL-joined and no field can contain NUL, so two
    // different (pattern, root) splits can never serialize identically.
    const a = canonicalSearchQuery({ pattern: 'ab', root: 'c' });
    const b = canonicalSearchQuery({ pattern: 'a', root: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('isCertifiableSearch', () => {
  it('accepts the literal symbol searches agents actually run', () => {
    for (const pattern of [
      'findTreasure',
      'derive_read_key',
      'no-matches-at',
      'src/query/render',
      'TOKEN_PATTERN, stemLite',
      "cortex_recall('topic')".slice(0, 13), // "cortex_recall" — quote-free prefix
      'v1.2.3',
      'a b c',
      'dot.dot',
    ]) {
      expect(isCertifiableSearch({ pattern }), pattern).toBe(true);
    }
  });

  it('rejects anything that could be an invalid regex on a pre-2.1.208 host', () => {
    for (const pattern of [
      'foo(', 'foo)', 'a[b', 'a]b', 'x{2', 'x}', 'a\u005cb', 'a*b', 'a+b', 'a?b',
      'a|b', '^anchor', 'end$',
      '', 'x'.repeat(513),
    ]) {
      expect(isCertifiableSearch({ pattern }), JSON.stringify(pattern)).toBe(false);
    }
  });

  it('refuses a flag-shaped pattern even though it is regex-valid', () => {
    // If the host ever passes the pattern positionally rather than after
    // `-e`/`--`, a leading dash parses as an unknown option, the invocation
    // errors, and a pre-2.1.208 host answers errors zero-shaped — recording a
    // negative for a search that never ran.
    expect(isCertifiableSearch({ pattern: '-foo' })).toBe(false);
    expect(isCertifiableSearch({ pattern: '--include' })).toBe(false);
    expect(isCertifiableSearch({ pattern: 'foo-bar' })).toBe(true);
  });

  it('gates glob and type conservatively', () => {
    const p = { pattern: 'plainword' };
    expect(isCertifiableSearch({ ...p, glob: '*.ts' })).toBe(true);
    expect(isCertifiableSearch({ ...p, glob: 'src/**/*.md' })).toBe(true);
    expect(isCertifiableSearch({ ...p, glob: '*.{ts,tsx}' })).toBe(false);
    expect(isCertifiableSearch({ ...p, glob: '!vendor' })).toBe(false);
    expect(isCertifiableSearch({ ...p, type: 'ts' })).toBe(true);
    expect(isCertifiableSearch({ ...p, type: 'zzznotatype' })).toBe(false);
  });

  it('CERTIFIABLE_PATTERN class body never grows a structural character', () => {
    // The allowlist's entire argument is glance-verifiability; assert the
    // CLASS CONTENT (between the outer brackets — the regex's own anchors and
    // quantifier sit outside it) never grows one of the characters the gate
    // exists to exclude.
    const source = CERTIFIABLE_PATTERN.source;
    const classBody = source.slice(source.indexOf('[') + 1, source.lastIndexOf(']'));
    for (const banned of ['(', ')', '[', ']', '{', '}', '*', '+', '?', '|', '^', '$']) {
      expect(classBody.includes(banned), banned).toBe(false);
    }
  });
});

// ── The query ladder ─────────────────────────────────────────────────

interface LedgerFixture {
  store: CortexStore;
  root: string;
  scopeKey: string;
}

function ledgerFixture(opts: { sweptIgnores?: boolean } = {}): LedgerFixture {
  const root = censusRoot();
  seedTree(root);
  // A REAL git repository, because the exclusion-parity gate asks git whether
  // the Cortex runtime files it skipped are actually unsearchable. A fixture
  // that only pretends to be a repo would make every scope-root search answer
  // "unanswerable" and quietly stop testing the gate.
  spawnSync(GIT, ['init', '-q'], { cwd: root });
  spawnSync(GIT, ['config', 'user.email', 'fixture@local'], { cwd: root });
  spawnSync(GIT, ['config', 'user.name', 'fixture'], { cwd: root });
  if (opts.sweptIgnores !== false) {
    fs.writeFileSync(path.join(root, '.gitignore'), '.cortex*\n');
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const scopeKey = `project:${root}`;
  store.createSession({ worktreePath: root, scopeType: 'project', scopeKey });
  return { store, root, scopeKey };
}

/** Record a certified negative for `sub` the way the flush would. */
function recordNegativeFor(fx: LedgerFixture, q: SearchQuery, headOid: string | null = 'abc1234def567890'): void {
  const relRoot = normalizeSearchRoot(q.root, fx.root);
  const absRoot = relRoot === '' ? fx.root : path.join(fx.root, relRoot);
  const census = computeRootCensus(absRoot);
  if (census.status !== 'ok') throw new Error(`fixture census ${census.status}`);
  fx.store.upsertNegativeResult({
    scopeKey: fx.scopeKey,
    queryKey: searchQueryKey({ ...q, root: relRoot }),
    tool: 'grep',
    pattern: q.pattern,
    root: relRoot,
    headOid,
    censusSha256: census.sha256,
    censusFiles: census.files,
    censusBytes: census.bytes,
    recordedAt: '2026-08-03T10:00:00.000Z',
  });
}

describe('querySearchLedger', () => {
  it('answers miss when nothing was recorded', () => {
    const fx = ledgerFixture();
    try {
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [{ pattern: 'nope', root: 'sub' }]);
      expect(r.verdict).toBe('miss');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('asserts no-matches-at with the recorded head when the tree is byte-identical', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [q]);
      expect(r.verdict).toBe('no-matches-at');
      expect(r.headOid).toBe('abc1234def567890');
      expect(r.recordedAt).toBe('2026-08-03T10:00:00.000Z');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a new mtime with identical bytes still asserts (git checkout / restore)', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const beta = path.join(fx.root, 'sub', 'beta.md');
      const original = fs.readFileSync(beta);
      fs.writeFileSync(beta, original); // rewrites mtime, not bytes
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [q]);
      expect(r.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a SAME-SIZE content change still answers miss — only the hash can see it', () => {
    // File count and byte totals are redundant belts; the sha256 is the
    // load-bearing comparison. A same-length rewrite is exactly the case the
    // belts cannot catch, so this is the test that keeps the hash comparison
    // honest (and the mutation target that proves it).
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const beta = path.join(fx.root, 'sub', 'beta.md');
      const original = fs.readFileSync(beta, 'utf8');
      const sameLength = original.replace('beta', 'BETA');
      expect(sameLength.length).toBe(original.length);
      fs.writeFileSync(beta, sameLength);
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('miss');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('answers miss after an edit under the root — and re-validates when bytes restore', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const beta = path.join(fx.root, 'sub', 'beta.md');
      const original = fs.readFileSync(beta);

      fs.writeFileSync(beta, '# beta\nchanged\n');
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('miss');

      // The stash-pop honesty property: identical bytes, record re-validates.
      fs.writeFileSync(beta, original);
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('answers miss when a file was added under the root (growth proven by the bounded walk)', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      fs.writeFileSync(path.join(fx.root, 'sub', 'gamma.ts'), 'export {};\n');
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('miss');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('answers miss when the root itself is gone — that IS a change', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      fs.rmSync(path.join(fx.root, 'sub'), { recursive: true, force: true });
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('miss');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('answers unknown when the census cannot complete', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [q], {
        census: () => ({ status: 'unreadable' }),
      });
      expect(r.verdict).toBe('unknown');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('answers unknown, never a cwd-anchored walk, when the scope root cannot be resolved', () => {
    // A store with NO session rows resolves no scope root; a stored relative
    // root must then be unprovable — resolving it against process.cwd() is the
    // 3.2 relocation defect.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, 'C:/nowhere');
    const store = new CortexStore(db);
    const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
    store.upsertNegativeResult({
      scopeKey: 'project:C:/nowhere',
      queryKey: searchQueryKey({ ...q, root: 'sub' }),
      tool: 'grep',
      pattern: q.pattern,
      root: 'sub',
      censusSha256: 'e'.repeat(64),
      censusFiles: 1,
      censusBytes: 10,
    });
    const [r] = querySearchLedger(store, 'project:C:/nowhere', [q]);
    expect(r.verdict).toBe('unknown');
  });

  it('never asserts across a scope boundary, in either direction (AC #5)', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      const otherScope = `branch:${fx.root}:refs/heads/other`;
      fx.store.createSession({ worktreePath: fx.root, scopeType: 'branch', scopeKey: otherScope });

      expect(querySearchLedger(fx.store, otherScope, [q])[0]?.verdict).toBe('miss');
      expect(querySearchLedger(fx.store, fx.scopeKey, [q])[0]?.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('folds a root equal to the scope root and an empty root onto one key', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: '' };
      recordNegativeFor(fx, q);
      // Asking with the ABSOLUTE scope root must hit the record stored via ''.
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [{ pattern: 'zzz_none', root: fx.root }]);
      expect(r.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('caps the number of queries at SEARCH_LEDGER_MAX_QUERIES', () => {
    const fx = ledgerFixture();
    try {
      const queries = Array.from({ length: SEARCH_LEDGER_MAX_QUERIES + 5 }, (_, i) => ({
        pattern: `p${i}`,
        root: 'sub',
      }));
      expect(querySearchLedger(fx.store, fx.scopeKey, queries)).toHaveLength(
        SEARCH_LEDGER_MAX_QUERIES,
      );
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ── Rendering ────────────────────────────────────────────────────────

describe('renderSearchLedgerLine', () => {
  const budgetChars = SEARCH_LEDGER_TOKENS_PER_QUERY * 4;

  function resultOf(pattern: string, verdict: SearchLedgerResult['verdict']): SearchLedgerResult {
    return {
      pattern,
      queryKey: '0'.repeat(16),
      verdict,
      headOid: verdict === 'no-matches-at' ? 'abc1234def567890' : null,
      recordedAt: verdict === 'no-matches-at' ? '2026-08-03T10:00:00.000Z' : null,
    };
  }

  it('fits 25 tokens for every verdict at hostile pattern widths (AC #2)', () => {
    const hostiles = [
      'x'.repeat(200),
      `a${'\u0000'.repeat(5)}b`,
      `cr\u000dclobber${'y'.repeat(150)}`,
      'word '.repeat(60),
      `${'\ud83d\ude00'.repeat(60)}`, // astral pairs at the cut boundary
    ];
    for (const pattern of hostiles) {
      for (const verdict of ['no-matches-at', 'miss', 'unknown'] as const) {
        const line = renderSearchLedgerLine(resultOf(pattern, verdict));
        expect(line.length, `${verdict} ${pattern.length}`).toBeLessThanOrEqual(budgetChars);
        // The verdict — the answer — is never what gets cut.
        expect(line).toContain(verdict === 'no-matches-at' ? 'no-matches-at abc1234' : verdict);
        // No control byte survives to a terminal.
        expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false);
        // No lone surrogate either.
        expect(/(?:^|[^\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/u.test(line)).toBe(false);
      }
    }
  });

  it('renders the assertion with the short head and compact timestamp', () => {
    const line = renderSearchLedgerLine(resultOf('zzz_none', 'no-matches-at'));
    expect(line).toBe('zzz_none: no-matches-at abc1234 (2026-08-03 10:00Z)');
  });

  it('names the queries it dropped instead of silently shortening the answer', () => {
    // Returning 16 answers to a question about 20 makes four searches
    // indistinguishable from "not asked about" — the wrong-answer direction,
    // and the rule the read ledger already follows on both its surfaces.
    const results = Array.from({ length: SEARCH_LEDGER_MAX_QUERIES }, (_, i) =>
      resultOf(`p${i}`, 'miss'),
    );
    const rendered = renderSearchLedger(results, SEARCH_LEDGER_MAX_QUERIES + 4);
    expect(rendered).toContain(`…4 more not checked (cap is ${SEARCH_LEDGER_MAX_QUERIES})`);
    // No note when nothing was dropped.
    expect(renderSearchLedger(results, SEARCH_LEDGER_MAX_QUERIES)).not.toContain('not checked');
  });

  it('renders no parenthetical for an unparseable stored timestamp', () => {
    const line = renderSearchLedgerLine({
      ...resultOf('zzz_none', 'no-matches-at'),
      recordedAt: 'not-a-date',
    });
    expect(line).toBe('zzz_none: no-matches-at abc1234');
    expect(line).not.toContain('null');
  });
});

// ── Input normalization (MCP surface) ────────────────────────────────

describe('normalizeSearchQueries', () => {
  it('drops an entry whose flags are type-mangled, never just the flag', () => {
    // Silently discarding `caseInsensitive: "true"` keys the case-SENSITIVE
    // variant, so an existing record there answers `no-matches-at` for the
    // case-INSENSITIVE search actually asked about — and sensitive-zero does
    // not imply insensitive-zero, so the caller skips a search that would have
    // found matches.
    expect(normalizeSearchQueries([{ pattern: 'x', caseInsensitive: 'true' }])).toEqual([]);
    expect(normalizeSearchQueries([{ pattern: 'x', multiline: 1 }])).toEqual([]);
    expect(normalizeSearchQueries([{ pattern: 'x', path: 42 }])).toEqual([]);
    expect(normalizeSearchQueries([{ pattern: 'x', glob: ['*.ts'] }])).toEqual([]);
    // Well-formed entries still pass, alongside the bare-string form.
    expect(normalizeSearchQueries(['bare', { pattern: 'y', caseInsensitive: true }])).toEqual([
      { pattern: 'bare' },
      { pattern: 'y', caseInsensitive: true },
    ]);
  });

  it('drops entries with no usable pattern', () => {
    expect(normalizeSearchQueries([{ path: 'src' }, '', '   ', null, 7])).toEqual([]);
  });
});

// ── Flush certification (computeSearchEligibility through the real flush) ──

function spoolLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ...fields })}\n`;
}

function writeSpool(root: string, lines: string[]): void {
  fs.writeFileSync(path.join(root, '.cortex.spool.jsonl'), lines.join(''));
}

const T0 = '2026-08-03T10:00:00.000Z';
const T1 = '2026-08-03T10:00:01.000Z';
const T2 = '2026-08-03T10:00:02.000Z';

function searchLine(overrides: Record<string, unknown> = {}): string {
  return spoolLine({ ts: T1, tool: 'search', stool: 'grep', pattern: 'zzz_none', sroot: '', zero: 1, ...overrides });
}

/** The root the hook would now emit for a scope-root search: absolute, never ''. */
function rootedSearchLine(fx: LedgerFixture, overrides: Record<string, unknown> = {}): string {
  return searchLine({ sroot: fx.root, ...overrides });
}

function negativeCount(fx: LedgerFixture): number {
  return (
    fx.store.db.prepare('SELECT COUNT(*) AS n FROM negative_results').get() as { n: number }
  ).n;
}

describe('flush certification of zero-result searches', () => {
  function flush(fx: LedgerFixture, opts?: { conservative?: boolean }): void {
    const session = fx.store.db
      .prepare('SELECT id FROM sessions WHERE scope_key = ? ORDER BY started_at DESC LIMIT 1')
      .get(fx.scopeKey) as { id: string };
    flushSpool(fx.store, fx.root, session.id, undefined, {
      ...(opts?.conservative ? { conservativeEligibility: true } : {}),
    });
  }

  it('records a certified zero-result search, queryable end-to-end', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [searchLine()]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);

      const [r] = querySearchLedger(fx.store, fx.scopeKey, [{ pattern: 'zzz_none', root: '' }]);
      expect(r.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('any command at-or-after the search disqualifies it', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ ts: T1 }),
        spoolLine({ ts: T2, tool: 'cmd', cmd: 'npm run build', exit: '0' }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      // Same second is ambiguity, and ambiguity is a miss (AD-6).
      writeSpool(fx.root, [
        searchLine({ ts: T1 }),
        spoolLine({ ts: T1, tool: 'cmd', cmd: 'echo hi', exit: '0' }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      // A command BEFORE the search does not.
      writeSpool(fx.root, [
        spoolLine({ ts: T0, tool: 'cmd', cmd: 'echo hi', exit: '0' }),
        searchLine({ ts: T1 }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('an edit under the root disqualifies; an edit outside it does not', () => {
    const fx = ledgerFixture();
    try {
      const subRoot = path.join(fx.root, 'sub');
      const editedInside = path.join(fx.root, 'sub', 'beta.md');
      const editedOutside = path.join(fx.root, 'alpha.ts');

      writeSpool(fx.root, [
        searchLine({ sroot: subRoot }),
        spoolLine({ ts: T2, tool: 'edit', file: editedInside }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      writeSpool(fx.root, [
        searchLine({ sroot: subRoot }),
        spoolLine({ ts: T2, tool: 'edit', file: editedOutside }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("a root of '' means the scope root, under which every edit falls", () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ sroot: '' }),
        spoolLine({ ts: T2, tool: 'write', file: path.join(fx.root, 'alpha.ts') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('missing timestamp, conservative flush, and relative roots certify nothing', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [searchLine({ ts: undefined })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      writeSpool(fx.root, [searchLine()]);
      flush(fx, { conservative: true });
      expect(negativeCount(fx)).toBe(0);

      // A relative non-empty root would need the recording session's cwd,
      // which the flush does not have — never resolved against the flush's.
      writeSpool(fx.root, [searchLine({ sroot: 'sub' })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a pattern outside the certifiable class is never recorded', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [searchLine({ pattern: 'broken(regex' })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a search line without a positive zero flag is skipped entirely', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ zero: 0 }),
        searchLine({ zero: 'false' }),
        searchLine({ zero: {} }),
        searchLine({ zero: undefined }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('stores the pattern redacted while the key answers for the raw pattern', () => {
    const fx = ledgerFixture();
    try {
      const secret = 'ghp_abcdefghijklmnop123456';
      writeSpool(fx.root, [searchLine({ pattern: secret })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);

      const row = fx.store.db
        .prepare('SELECT pattern FROM negative_results')
        .get() as { pattern: string };
      expect(row.pattern).toContain('[REDACTED]');
      expect(row.pattern).not.toContain(secret);

      // The raw pattern still finds its record — the key hashed the raw form.
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [{ pattern: secret, root: '' }]);
      expect(r.verdict).toBe('no-matches-at');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('events landing in the live spool after the claim disqualify the claimed search', () => {
    const fx = ledgerFixture();
    try {
      // Stage an orphaned claim (the 4.5 token-ledger pattern): the claim holds
      // the search, the live spool holds a later command.
      fs.writeFileSync(path.join(fx.root, '.cortex.spool.jsonl.processing'), searchLine());
      writeSpool(fx.root, [spoolLine({ ts: T2, tool: 'cmd', cmd: 'make', exit: '0' })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('refuses to record when the skipped Cortex files are actually searchable', () => {
    // The measured defect: the census skips `.cortex.*` because they change on
    // every tool call, but the real Grep tool FINDS tokens inside them in any
    // repository whose ignore file has not been swept — which is every fresh
    // project, since hooks arrive machine-wide while ignore entries are written
    // per-repo. Without the parity gate the fingerprint proves "unchanged" over
    // a smaller file universe than the search read.
    const fx = ledgerFixture({ sweptIgnores: false });
    try {
      fs.writeFileSync(path.join(fx.root, '.cortex.spool.jsonl'), '{"v":1}\n');
      writeSpool(fx.root, [searchLine({ sroot: fx.root })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      // Sweep the ignores and the same search records — proving the refusal is
      // the parity check, not an unrelated failure. The timestamp differs
      // because a batch is deduped by content hash: an identical spool body is
      // treated as an already-processed replay and skipped entirely.
      fs.writeFileSync(path.join(fx.root, '.gitignore'), '.cortex*\n');
      writeSpool(fx.root, [searchLine({ ts: T2, sroot: fx.root })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a search rooted below the project root needs no parity check at all', () => {
    // `sub` contains no Cortex runtime files, so the gate never fires — which
    // is why the common case (an explicitly-rooted search) is unaffected.
    const fx = ledgerFixture({ sweptIgnores: false });
    try {
      fs.writeFileSync(path.join(fx.root, '.cortex.spool.jsonl'), '{"v":1}\n');
      writeSpool(fx.root, [searchLine({ sroot: path.join(fx.root, 'sub') })]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a backgrounded command disqualifies every search in the batch, whatever the order', () => {
    // Its PostToolUse fires at LAUNCH, so a build started BEFORE the search
    // orders before it and then keeps writing after it — invisible to the
    // ordered `>=` rule, and the likeliest real invalidator.
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        spoolLine({ ts: T0, tool: 'cmd', cmd: 'npm run dev', exit: '0', bg: 1 }),
        searchLine({ ts: T1, sroot: path.join(fx.root, 'sub') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      // A foreground command in the same position does not (it finished).
      writeSpool(fx.root, [
        spoolLine({ ts: T0, tool: 'cmd', cmd: 'npm run dev', exit: '0' }),
        searchLine({ ts: T1, sroot: path.join(fx.root, 'sub') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(1);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('an unmodellable file-writing tool disqualifies the search (mutate)', () => {
    // The named hole: this repository's own instructions mandate the
    // symbol-refactor tools for wide edits, and they rewrite files without
    // firing any capture branch — so a search certified in the same turn
    // fingerprinted the post-rename tree and would later assert "no matches"
    // over content full of the new name.
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ ts: T1, sroot: path.join(fx.root, 'sub') }),
        spoolLine({ ts: T2, tool: 'mutate' }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);

      // And it creates no event, episode or memory item of its own.
      const events = fx.store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'mutate'")
        .get() as { n: number };
      expect(events.n).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('an edit in the SAME second as the search disqualifies it (>=, not >)', () => {
    // The cmd side pinned this; the edit side did not, so a `>=`→`>` mutation
    // on the edit compare survived the suite. Hook stamps are whole-second, so
    // same-second is ambiguity, and ambiguity is a miss.
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ ts: T1, sroot: path.join(fx.root, 'sub') }),
        spoolLine({ ts: T1, tool: 'edit', file: path.join(fx.root, 'sub', 'beta.md') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a live-spool EDIT under the root disqualifies, not only a live cmd', () => {
    const fx = ledgerFixture();
    try {
      fs.writeFileSync(
        path.join(fx.root, '.cortex.spool.jsonl.processing'),
        searchLine({ sroot: path.join(fx.root, 'sub') }),
      );
      writeSpool(fx.root, [
        spoolLine({ ts: T2, tool: 'edit', file: path.join(fx.root, 'sub', 'beta.md') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a search line naming an unknown search tool is skipped, never re-keyed as grep', () => {
    const fx = ledgerFixture();
    try {
      writeSpool(fx.root, [
        searchLine({ stool: 'ripgrep-next', sroot: path.join(fx.root, 'sub') }),
      ]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('a census overflow at the environment ceilings records nothing', () => {
    const fx = ledgerFixture();
    const prior = process.env['CORTEX_NEGATIVE_MAX_FILES'];
    try {
      process.env['CORTEX_NEGATIVE_MAX_FILES'] = '2'; // seedTree has 3 files
      writeSpool(fx.root, [searchLine()]);
      flush(fx);
      expect(negativeCount(fx)).toBe(0);
    } finally {
      if (prior === undefined) delete process.env['CORTEX_NEGATIVE_MAX_FILES'];
      else process.env['CORTEX_NEGATIVE_MAX_FILES'] = prior;
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ── B-3: the query answers in ≤ 20 ms p95 on a 10,000-record store ───

describe('search-ledger performance (B-3)', () => {
  it('answers in ≤ 20 ms p95 on 10,000 records, and the census actually ran', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      // 9,999 decoy rows so the lookup runs against a real 10k-row table.
      const insert = fx.store.db.prepare(
        `INSERT INTO negative_results (scope_key, query_key, tool, pattern, root, census_sha256, census_files, census_bytes, recorded_at)
         VALUES (?, ?, 'grep', ?, 'sub', ?, 1, 10, ?)`,
      );
      const fill = fx.store.db.transaction(() => {
        for (let i = 0; i < 9_999; i++) {
          insert.run(fx.scopeKey, i.toString(16).padStart(16, '0'), `decoy${i}`, 'f'.repeat(64), T0);
        }
      });
      fill();

      // The measured path must include the expensive part, or the number is a
      // lie — the FR-7 lesson, where the edit check returned early and the
      // measurement never touched the unbounded path. Count census runs.
      let censusRuns = 0;
      const counting: typeof computeRootCensus = (root, limits) => {
        censusRuns++;
        return computeRootCensus(root, limits);
      };

      const samples: number[] = [];
      for (let i = 0; i < 120; i++) {
        const started = performance.now();
        const [r] = querySearchLedger(fx.store, fx.scopeKey, [q], { census: counting });
        samples.push(performance.now() - started);
        if (i === 0) expect(r.verdict).toBe('no-matches-at');
      }
      expect(censusRuns).toBe(120);

      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1]!;
      // eslint-disable-next-line no-console
      console.log(`    [measured] search-ledger p95 over 10k records: ${p95.toFixed(2)} ms`);
      expect(p95).toBeLessThanOrEqual(20);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('the recorded census bounds the walk — a huge tree answers miss fast, not slow', () => {
    const fx = ledgerFixture();
    try {
      const q: SearchQuery = { pattern: 'zzz_none', root: 'sub' };
      recordNegativeFor(fx, q);
      // Grow the tree far past the recorded census (3 entries → +60 files).
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(path.join(fx.root, 'sub', `grown-${i}.txt`), 'x'.repeat(2048));
      }
      const started = performance.now();
      const [r] = querySearchLedger(fx.store, fx.scopeKey, [q]);
      const elapsed = performance.now() - started;
      expect(r.verdict).toBe('miss');
      // Loose ceiling: the point is the walk stopped at the recorded bound
      // instead of hashing 60 new files; the exact figure is platform noise.
      expect(elapsed).toBeLessThan(250);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ── GC: the FR-16 horizon rule ships with the table ──────────────────

describe('pruneNegativeResults via runGc', () => {
  it('dry-run counts, apply deletes, and a refreshed record survives', () => {
    const fx = ledgerFixture();
    try {
      const old = '2026-06-01T00:00:00.000Z';
      fx.store.upsertNegativeResult({
        scopeKey: fx.scopeKey,
        queryKey: 'a'.repeat(16),
        tool: 'grep',
        pattern: 'stale',
        root: 'sub',
        censusSha256: 'a'.repeat(64),
        censusFiles: 1,
        censusBytes: 10,
        recordedAt: old,
      });
      fx.store.upsertNegativeResult({
        scopeKey: fx.scopeKey,
        queryKey: 'b'.repeat(16),
        tool: 'grep',
        pattern: 'fresh',
        root: 'sub',
        censusSha256: 'b'.repeat(64),
        censusFiles: 1,
        censusBytes: 10,
        recordedAt: new Date().toISOString(),
      });

      const dry = runGc(fx.store.db, { dryRun: true });
      expect(dry.negative_results.candidates).toBe(1);
      expect(dry.negative_results.deleted).toBe(0);
      expect(negativeCount(fx)).toBe(2);

      const applied = runGc(fx.store.db, { dryRun: false, vacuum: 'never' });
      expect(applied.negative_results.deleted).toBe(1);
      expect(negativeCount(fx)).toBe(1);
      expect(fx.store.getNegativeResult(fx.scopeKey, 'b'.repeat(16))).toBeDefined();
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('CORTEX_GC_NEGATIVE_DAYS=1e9 disables pruning rather than becoming 1 day', () => {
    const fx = ledgerFixture();
    const prior = process.env['CORTEX_GC_NEGATIVE_DAYS'];
    try {
      process.env['CORTEX_GC_NEGATIVE_DAYS'] = '1e9';
      fx.store.upsertNegativeResult({
        scopeKey: fx.scopeKey,
        queryKey: 'c'.repeat(16),
        tool: 'grep',
        pattern: 'ancient',
        root: 'sub',
        censusSha256: 'c'.repeat(64),
        censusFiles: 1,
        censusBytes: 10,
        recordedAt: '2020-01-01T00:00:00.000Z',
      });
      // `envDays` parses with `Number`, so '1e9' is a billion-day window —
      // "the natural way to disable pruning" per the digestDays precedent.
      // The measured hazard this pins against is `parseInt('1e9')` → 1: a
      // ONE-day window that wipes nearly everything. Zero candidates proves
      // the window went long, not short.
      const report = runGc(fx.store.db, { dryRun: true });
      expect(report.negative_results.candidates).toBe(0);
      const strict = runGc(fx.store.db, { dryRun: true, negativeDays: 1e9 });
      expect(strict.negative_results.candidates).toBe(0);
      // And without the env override the ancient row IS a candidate — proving
      // the zero above came from the long window, not a dead query.
      delete process.env['CORTEX_GC_NEGATIVE_DAYS'];
      expect(runGc(fx.store.db, { dryRun: true }).negative_results.candidates).toBe(1);
    } finally {
      if (prior === undefined) delete process.env['CORTEX_GC_NEGATIVE_DAYS'];
      else process.env['CORTEX_GC_NEGATIVE_DAYS'] = prior;
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
