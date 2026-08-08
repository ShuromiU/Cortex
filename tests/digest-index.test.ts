import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, ensureCortexSchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  DIGEST_INDEX_FILENAME,
  INDEX_ABSENT,
  collectIndexRecords,
  deriveDigestIndexPath,
  digestIndexExists,
  escapeIndexField,
  indexLookupNeedle,
  formatIndexLine,
  parseIndexLine,
  renderDigestIndex,
  unescapeIndexField,
  writeDigestIndex,
} from '../src/capture/digest-index.js';
import { handleReadEvent } from '../src/capture/hooks.js';
import { appendSpoolEntry, flushSpool } from '../src/capture/spool.js';
import { IGNORE_ENTRIES } from '../src/query/install.js';
import { isAbsoluteFileKey, normalizeFilePathKey, toScopeRelativeKey } from '../src/scope/keys.js';
import { runGc } from '../src/db/gc.js';
import { requirePosixTool } from './posix-tools.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-index-'));
}

// Absolute paths, never bare names: `spawnSync` inherits PATH, and Git for
// Windows keeps its POSIX tools off it. See `tests/posix-tools.ts` — run from
// PowerShell rather than Git Bash, every grep assertion below failed with a
// spawn error instead of an assertion.
const GREP = requirePosixTool('grep');
const CUT = requirePosixTool('cut');

function createStore(root: string): {
  store: CortexStore;
  sessionId: string;
  scopeKey: string;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const scopeKey = `project:${root}`;
  const session = store.createSession({
    worktreePath: root,
    scopeType: 'project',
    scopeKey,
  });
  return { store, sessionId: session.id, scopeKey, db };
}

function seedRead(store: CortexStore, sessionId: string, root: string, name: string, body: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  handleReadEvent(store, sessionId, { file });
  return file;
}

// ── AC #1 — the flush writes a line-oriented index ──────────────────────────

describe('digest index: writing (AC #1)', () => {
  it('writes one line per record carrying path, sha256, size, session and agent', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    seedRead(store, sessionId, root, 'src/a.ts', 'alpha');

    // Precondition: no index yet, so the assertions below cannot pass against a
    // file that was already there.
    expect(digestIndexExists(root)).toBe(false);

    const written = writeDigestIndex(store, root);
    expect(written).toBe(1);

    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    const lines = body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = parseIndexLine(lines[0]!)!;
    expect(record.scopeKey).toBe(scopeKey);
    expect(record.path).toBe('src/a.ts');
    expect(record.sha256).toBe(crypto.createHash('sha256').update('alpha').digest('hex'));
    expect(record.byteSize).toBe(5);
    expect(record.sessionId).toBe(sessionId);
    expect(record.agentId).toBeNull();
  });

  it('is written by a real flush, not only by the helper', () => {
    // The 2.5/2.6/3.1 lesson, three times paid for: a unit-tested writer proves
    // nothing about whether the shipping path ever calls it.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    const file = path.join(root, 'flushed.ts');
    fs.writeFileSync(file, 'via the spool');

    appendSpoolEntry(root, { tool: 'read', file, ts: '2026-08-02T10:00:00Z', seq: 1 });
    expect(digestIndexExists(root)).toBe(false);

    flushSpool(store, root, sessionId);

    expect(digestIndexExists(root)).toBe(true);
    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body).toContain('flushed.ts');
  });

  it('ends every record with a newline', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'x');
    writeDigestIndex(store, root);
    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('writes LF, never CRLF, whatever the platform', () => {
    // There is no .gitattributes and `hooks/` ships in the package. A CRLF file
    // is tolerated by Git Bash and rejected by bash on Linux, macOS and WSL —
    // Story 2.4 paid for this exact bug in the hook scripts.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'x');
    seedRead(store, sessionId, root, 'b.ts', 'y');
    writeDigestIndex(store, root);
    const raw = fs.readFileSync(deriveDigestIndexPath(root));
    expect(raw.includes(Buffer.from('\r\n'))).toBe(false);
  });

  it('writes a fixed column count, using a placeholder for an absent agent', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    seedRead(store, sessionId, root, 'plain.ts', 'x');

    const sub = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey,
      parentSessionId: sessionId,
      agentId: 'sub-9',
      agentType: 'Explore',
    });
    const other = path.join(root, 'by-sub.ts');
    fs.writeFileSync(other, 'y');
    handleReadEvent(store, sub.id, { file: other });

    writeDigestIndex(store, root);
    const lines = fs
      .readFileSync(deriveDigestIndexPath(root), 'utf8')
      .split('\n')
      .filter(Boolean);
    // A missing field would shift every later column and make `cut -f6` lie.
    for (const line of lines) {
      expect(line.split('\t')).toHaveLength(6);
    }
    const withAgent = lines.map(l => parseIndexLine(l)!).find(r => r.path === 'by-sub.ts')!;
    const withoutAgent = lines.map(l => parseIndexLine(l)!).find(r => r.path === 'plain.ts')!;
    expect(withAgent.agentId).toBe('sub-9');
    expect(withoutAgent.agentId).toBeNull();
    expect(fs.readFileSync(deriveDigestIndexPath(root), 'utf8')).toContain(`\t${INDEX_ABSENT}\n`);
  });

  it('records an oversize row with no digest rather than dropping it', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'huge.bin'),
      sha256: null,
      byteSize: 9_000_000,
      sessionId,
      oversize: true,
    });
    writeDigestIndex(store, root);
    const record = parseIndexLine(
      fs.readFileSync(deriveDigestIndexPath(root), 'utf8').split('\n')[0]!,
    )!;
    expect(record.sha256).toBeNull();
    expect(record.byteSize).toBe(9_000_000);
  });
});

// ── AC #2 — locatable with grep alone ───────────────────────────────────────

describe('digest index: the hot path can read it with grep (AC #2)', () => {
  it('finds a record with grep alone — no jq, no Node', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'src/query/recall.ts', 'recall');
    seedRead(store, sessionId, root, 'src/db/store.ts', 'store');
    seedRead(store, sessionId, root, 'README.md', 'readme');
    writeDigestIndex(store, root);

    // A REAL grep subprocess. Reimplementing the search in JS would prove the
    // format is parseable by JavaScript, which is not the claim AD-3 makes.
    const grep = spawnSync(GREP, ['-F', '\tsrc/db/store.ts\t', DIGEST_INDEX_FILENAME], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(grep.error).toBeUndefined();
    expect(grep.status).toBe(0);

    const matched = grep.stdout.trim().split('\n');
    expect(matched).toHaveLength(1);
    const record = parseIndexLine(matched[0]!)!;
    expect(record.path).toBe('src/db/store.ts');
    expect(record.sha256).toBe(crypto.createHash('sha256').update('store').digest('hex'));
  });

  it('a field is extractable with cut alone', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'only.ts', 'body');
    writeDigestIndex(store, root);

    const cut = spawnSync(requirePosixTool('sh'), [
      '-c',
      `"${GREP}" -F '\tonly.ts\t' ${DIGEST_INDEX_FILENAME} | "${CUT}" -f3`,
    ], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(cut.status).toBe(0);
    expect(cut.stdout.trim()).toBe(crypto.createHash('sha256').update('body').digest('hex'));
  });

  it('a path containing a tab or newline cannot forge a column or a record', () => {
    // `path` comes from whatever the agent read and `scope_key` embeds a branch
    // ref, which git permits to contain almost anything. A raw tab forges a
    // column; a raw newline forges an entire record, letting one file's line
    // claim another file's digest.
    const evil = 'src/a\tb\nc.ts';
    const line = formatIndexLine({
      scopeKey: 'branch:x\ty',
      path: evil,
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId: 's1',
      agentId: null,
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(line.split('\t')).toHaveLength(6);

    const parsed = parseIndexLine(line)!;
    expect(parsed.path).toBe(evil);
    expect(parsed.scopeKey).toBe('branch:x\ty');
  });

  it('escaping round-trips, including a literal percent', () => {
    for (const value of ['plain', 'a%09b', '%', '%%25', 'tab\there', 'nl\nhere', 'cr\rhere']) {
      expect(unescapeIndexField(escapeIndexField(value))).toBe(value);
    }
  });

  it('rejects a malformed line rather than mis-parsing it', () => {
    expect(parseIndexLine('too\tfew\tfields')).toBeNull();
    expect(parseIndexLine('a\tb\tc\tnot-a-number\te\tf')).toBeNull();
    expect(parseIndexLine('')).toBeNull();
  });
});

// ── AC #3 — derived, never authoritative ────────────────────────────────────

describe('digest index: regeneration (AC #3)', () => {
  it('is fully regenerated after deletion, byte-identical, with no memory lost', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'alpha');
    seedRead(store, sessionId, root, 'b.ts', 'beta');
    seedRead(store, sessionId, root, 'c.ts', 'gamma');
    writeDigestIndex(store, root);

    const before = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(before.split('\n').filter(Boolean)).toHaveLength(3);

    fs.unlinkSync(deriveDigestIndexPath(root));
    expect(digestIndexExists(root)).toBe(false);

    // "When Cortex next runs" — the next cold-path flush, even an empty one.
    flushSpool(store, root, sessionId);

    const after = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(after).toBe(before);
    // And the table — the authority — never changed.
    const rows = store.db.prepare('SELECT COUNT(*) c FROM content_digests').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('is a projection of the table, not an accumulation of batches', () => {
    // The distinction AC #1 and AC #3 create between them: an index appended
    // per batch satisfies "the flush writes it" while failing "a deleted index
    // is FULLY regenerated". After deleting the file, a batch containing one
    // unrelated read must still produce every record.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'old-1.ts', '1');
    seedRead(store, sessionId, root, 'old-2.ts', '2');
    writeDigestIndex(store, root);
    fs.unlinkSync(deriveDigestIndexPath(root));

    const fresh = path.join(root, 'new.ts');
    fs.writeFileSync(fresh, '3');
    appendSpoolEntry(root, { tool: 'read', file: fresh, ts: '2026-08-02T11:00:00Z', seq: 1 });
    flushSpool(store, root, sessionId);

    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body).toContain('old-1.ts');
    expect(body).toContain('old-2.ts');
    expect(body).toContain('new.ts');
  });

  it('writes a populated index when the project root is BELOW the git toplevel', () => {
    // The whole suite previously built every fixture with
    // `worktreePath === projectRoot`, so this — the one divergence that
    // matters — was structurally unreachable. Measured before the fix: a
    // project root one level under the git toplevel matched zero scopes and
    // wrote a ZERO-BYTE index while the digests recorded correctly, so a hot
    // path would grep an empty file and conclude nothing had ever been read.
    const toplevel = tempRoot();
    const packageDir = path.join(toplevel, 'packages', 'app');
    fs.mkdirSync(packageDir, { recursive: true });

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, toplevel);
    const store = new CortexStore(db);
    const scopeKey = `project:${toplevel}`;
    // The session records the GIT TOPLEVEL, as `git rev-parse --show-toplevel` does.
    const session = store.createSession({
      worktreePath: toplevel,
      scopeType: 'project',
      scopeKey,
    });

    const file = path.join(packageDir, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'alpha');
    handleReadEvent(store, session.id, { file });

    // Precondition: the digest really was recorded, so an empty index would be
    // a projection failure and not an absent-data artifact.
    expect(store.getContentDigest(scopeKey, file)).toBeDefined();

    // The flush is given the PACKAGE dir — every caller passes cwd.
    const count = writeDigestIndex(store, packageDir);
    expect(count).toBe(1);

    const body = fs.readFileSync(deriveDigestIndexPath(packageDir), 'utf8');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('packages/app/src/a.ts');
  });

  it('regenerates a zero-byte index rather than treating it as present', () => {
    // `isFile()` is true for a zero-byte file, so an index written empty
    // satisfied the regeneration guard forever and never self-healed.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'alpha');

    fs.writeFileSync(deriveDigestIndexPath(root), '');
    expect(fs.statSync(deriveDigestIndexPath(root)).size).toBe(0);
    expect(digestIndexExists(root)).toBe(false);

    // An IDLE flush — nothing processed — must still repair it.
    const result = flushSpool(store, root, sessionId);
    expect(result.processed).toBe(0);

    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body).toContain('a.ts');
  });

  it('REFRESHES an index that already exists — not only creates a missing one', () => {
    // The mutation that survived all 1178 tests: narrowing the rebuild guard to
    // `!digestIndexExists(dir)` writes the index once and never again, leaving
    // a permanently stale freshness oracle. Every other test here starts with
    // no index, deletes it first, or calls the writer directly — so none of
    // them could see it. This is the "helper, not the transport" family in its
    // UPDATE-path form.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'first.ts', 'one');
    flushSpool(store, root, sessionId);

    const before = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(before).toContain('first.ts');
    expect(before).not.toContain('second.ts');
    // Precondition: a usable index is already present, so the missing-file
    // branch cannot be what satisfies the assertion below.
    expect(digestIndexExists(root)).toBe(true);

    const second = path.join(root, 'second.ts');
    fs.writeFileSync(second, 'two');
    appendSpoolEntry(root, { tool: 'read', file: second, ts: '2026-08-02T12:00:00Z', seq: 1 });
    const result = flushSpool(store, root, sessionId);
    expect(result.processed).toBe(1);

    const after = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(after).toContain('first.ts');
    expect(after).toContain('second.ts');
    expect(after).not.toBe(before);
  });

  it('rebuilds an index that exists but holds garbage (AC #3: unreadable)', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'real.ts', 'x');
    flushSpool(store, root, sessionId);

    fs.writeFileSync(deriveDigestIndexPath(root), 'STALE GARBAGE\nnot our format\n');
    expect(digestIndexExists(root)).toBe(false);

    // An idle flush must repair it — "deleted OR unreadable".
    flushSpool(store, root, sessionId);
    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body).toContain('real.ts');
    expect(parseIndexLine(body.split('\n')[0]!)).not.toBeNull();
  });

  it('carries only the scopes belonging to this project root', () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'mine.ts', 'mine');

    // A sibling worktree shares the store but has its own index file.
    const sibling = store.createSession({
      worktreePath: elsewhere,
      scopeType: 'project',
      scopeKey: `project:${elsewhere}`,
    });
    const otherFile = path.join(elsewhere, 'theirs.ts');
    fs.writeFileSync(otherFile, 'theirs');
    handleReadEvent(store, sibling.id, { file: otherFile });

    writeDigestIndex(store, root);
    const body = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');
    expect(body).toContain('mine.ts');
    expect(body).not.toContain('theirs.ts');
  });
});

// ── AC #4 — the cold path is the sole writer ────────────────────────────────

describe('digest index: the cold path is the sole writer (AC #4)', () => {
  it('no shipped hook script writes the index — the hot path only reads it', () => {
    // Legitimate as a source check: the claim IS about the scripts' text, it is
    // a negative assertion, and the writing behaviour is covered separately
    // through a real flush.
    for (const name of ['cortex-reflect.sh', 'cortex-end-of-turn.sh']) {
      const script = fs.readFileSync(path.join('hooks/claude', name), 'utf8');
      expect(script, name).not.toMatch(/\.cortex\.index/);
    }

    // `cortex-capture.sh` references the index since Story 4.5, and must:
    // AD-3's whole point is that the hot path finds a record with `grep` alone.
    // What stays impossible is a WRITE — the cold path is the sole writer, or
    // the index stops being a regenerable projection and becomes a second
    // source of truth that a lost file would take with it.
    const capture = fs.readFileSync('hooks/claude/cortex-capture.sh', 'utf8');
    const references = capture
      .split('\n')
      .filter(line => line.includes('.cortex.index') && !line.trim().startsWith('#'));
    expect(references, 'exactly one reference, and it is the lookup').toHaveLength(1);
    expect(references[0]).toMatch(/grep -F -m1 .*"\$CWD\/\.cortex\.index"/);
    expect(capture).not.toMatch(/>\s*"?\$CWD\/\.cortex\.index/);
    expect(capture).not.toMatch(/>>\s*"?\$CWD\/\.cortex\.index/);
  });

  it('is written atomically, leaving no torn file for a concurrent reader', () => {
    // A partial in-place write does not fail a `grep`; it answers it WRONGLY,
    // which is the one outcome AD-6 forbids. Proven by the absence of any
    // moment where the file exists with partial content: the temp file is
    // renamed in, so the index is either the old bytes or the new ones.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    for (let i = 0; i < 50; i++) {
      seedRead(store, sessionId, root, `f${i}.ts`, `body-${i}`);
    }
    writeDigestIndex(store, root);
    const first = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');

    seedRead(store, sessionId, root, 'late.ts', 'late');
    writeDigestIndex(store, root);
    const second = fs.readFileSync(deriveDigestIndexPath(root), 'utf8');

    expect(second).not.toBe(first);
    expect(second.split('\n').filter(Boolean)).toHaveLength(51);
    // No temp file survives a successful write.
    const strays = fs.readdirSync(root).filter(n => n.startsWith(`${DIGEST_INDEX_FILENAME}.tmp`));
    expect(strays).toEqual([]);
  });

  it('writes to a temp path and renames it in — never in place', () => {
    // Atomicity has no observable difference in the success case: a direct
    // overwrite produces identical final bytes. So a mutation replacing
    // temp-write-plus-rename with a direct write survived every behavioural
    // assertion. This one names the mechanism, because the mechanism IS the
    // guarantee — a concurrent `grep` over a half-written file does not fail,
    // it answers wrongly.
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'alpha');

    const indexPath = deriveDigestIndexPath(root);
    const written: string[] = [];
    const renamed: [string, string][] = [];

    const count = writeDigestIndex(store, root, {
      writeFileSync: ((p: fs.PathOrFileDescriptor, data: string, opts: unknown) => {
        written.push(String(p));
        return fs.writeFileSync(p, data as string, opts as never);
      }) as typeof fs.writeFileSync,
      renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        renamed.push([String(from), String(to)]);
        return fs.renameSync(from, to);
      }) as typeof fs.renameSync,
    });

    expect(count).toBe(1);
    // The bytes never land on the destination directly.
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe(indexPath);
    expect(written[0]!.startsWith(indexPath)).toBe(true);
    // And they arrive by rename.
    expect(renamed).toEqual([[written[0]!, indexPath]]);
    expect(fs.readFileSync(indexPath, 'utf8')).toContain('a.ts');
  });

  it('a write failure is silent and costs no data (AD-12)', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    seedRead(store, sessionId, root, 'a.ts', 'x');

    // A directory where the index file belongs makes rename fail.
    fs.mkdirSync(deriveDigestIndexPath(root));
    expect(() => writeDigestIndex(store, root)).not.toThrow();
    expect(writeDigestIndex(store, root)).toBeNull();

    // The authority is untouched — the index is derived, so a failed write
    // costs a rebuild, never memory.
    const rows = store.db.prepare('SELECT COUNT(*) c FROM content_digests').get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

// ── Installation surface ────────────────────────────────────────────────────

describe('digest index: installation surface', () => {
  it('is ignored by cortex install, so a checkout stays clean', () => {
    expect(IGNORE_ENTRIES).toContain(DIGEST_INDEX_FILENAME);
  });

  it('is ignored by this repository too', () => {
    const gitignore = fs.readFileSync('.gitignore', 'utf8');
    expect(gitignore).toContain(DIGEST_INDEX_FILENAME);
  });

  it('lives in the project root, beside the spool', () => {
    // Forced, not chosen: the hot path resolves "$CWD/.cortex.*" in pure bash
    // and cannot hash a store path per tool call (N-4). Story 2.5 recorded this
    // as an architectural floor when it moved the store to $CORTEX_HOME.
    const root = tempRoot();
    expect(deriveDigestIndexPath(root)).toBe(path.join(root, '.cortex.index'));
  });
});

// ── Path migration from Story 3.1's absolute keys ───────────────────────────

describe('digest index: the 3.1 path migration', () => {
  it('rewrites absolute keys to scope-relative rather than orphaning them', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    // Keyed exactly as Story 3.1 keyed it — `normalizeFilePathKey(opts.path)` —
    // which folds case on win32/darwin and PRESERVES it on linux. A blanket
    // `.toLowerCase()` here fabricated a key 3.1 could never have written on a
    // case-sensitive filesystem: `fs.mkdtempSync` draws its suffix from
    // [A-Za-z0-9], so the lowered string named a directory that does not exist,
    // the migration correctly left it absolute (a file outside the scope root
    // keeps its absolute key), and the test failed on Linux in ~96% of runs
    // while passing on Windows forever.
    const absolute = normalizeFilePathKey(path.join(root, 'src/legacy.ts'));

    // Seed the row exactly as Story 3.1 wrote it: keyed absolute, bypassing the
    // store helper so the migration has something real to convert.
    db.prepare(
      `INSERT INTO content_digests
         (scope_key, path, sha256, byte_size, session_id, oversize, read_count, recorded_at)
       VALUES (?, ?, ?, ?, ?, 0, 7, ?)`,
    ).run(scopeKey, absolute, 'f'.repeat(64), 42, sessionId, '2026-08-01T00:00:00.000Z');

    // Precondition: it really is absolute, and unreachable through the new key.
    expect(
      (db.prepare('SELECT path FROM content_digests').get() as { path: string }).path,
    ).toBe(absolute);

    ensureCortexSchema(db, root);

    const migrated = db.prepare('SELECT * FROM content_digests').get() as {
      path: string;
      read_count: number;
      sha256: string;
    };
    expect(migrated.path).toBe('src/legacy.ts');
    // The row is converted, not recreated: its history survives.
    expect(migrated.read_count).toBe(7);
    expect(migrated.sha256).toBe('f'.repeat(64));
    // And it is reachable again through the ordinary lookup.
    expect(store.getContentDigest(scopeKey, path.join(root, 'src/legacy.ts'))).toBeDefined();
  });

  it('is idempotent and leaves already-relative keys alone', () => {
    const root = tempRoot();
    const { store, sessionId, db } = createStore(root);
    seedRead(store, sessionId, root, 'src/kept.ts', 'x');
    const before = db.prepare('SELECT path, read_count FROM content_digests').all();

    ensureCortexSchema(db, root);
    ensureCortexSchema(db, root);

    expect(db.prepare('SELECT path, read_count FROM content_digests').all()).toEqual(before);
  });

  it('never re-resolves an already-relative key against the process cwd', () => {
    // The bug this guards was found by the idempotency test above: a second
    // migration pass turned `src/kept.ts` into
    // `c:/claude code/cortex/src/kept.ts`, because `path.resolve` anchors a
    // relative input to `process.cwd()` — whatever directory the flush, CLI or
    // MCP server happens to be running in. Asserted directly, because the two
    // guards against it (here and in the migration) are redundant and each one
    // alone survives a mutation of the other.
    const cwdKey = path.basename(process.cwd()).toLowerCase();

    for (const root of ['/some/other/root', 'C:/entirely/elsewhere', null]) {
      const key = toScopeRelativeKey('src/kept.ts', root);
      expect(key, `root=${root}`).toBe('src/kept.ts');
      expect(isAbsoluteFileKey(key), `root=${root}`).toBe(false);
      expect(key.includes(cwdKey), `root=${root} must not embed cwd`).toBe(false);
    }

    // `./`-prefixed and backslash forms normalize to the same stored key.
    expect(toScopeRelativeKey('./src/kept.ts', null)).toBe('src/kept.ts');
    expect(toScopeRelativeKey('src\\kept.ts', null)).toBe('src/kept.ts');
    expect(toScopeRelativeKey('src//kept.ts', null)).toBe('src/kept.ts');
  });

  it('strips the scope root from an absolute key, on a boundary', () => {
    // Built through the same normalizer so the assertion holds on win32, where
    // `path.resolve('/x')` anchors to the current drive.
    const root = normalizeFilePathKey('/repo');
    const sibling = normalizeFilePathKey('/repo-two/a.ts');

    expect(toScopeRelativeKey(`${root}/src/a.ts`, root)).toBe('src/a.ts');
    // A sibling directory sharing a prefix must NOT be sliced: a bare
    // `startsWith` would turn `/repo-two/a.ts` into `wo/a.ts` — a corrupt key
    // pointing at nothing, silently.
    expect(toScopeRelativeKey(sibling, root)).toBe(sibling);
    // A trailing separator on the root is tolerated.
    expect(toScopeRelativeKey(`${root}/src/a.ts`, `${root}/`)).toBe('src/a.ts');
    // The root itself is never reduced to an empty key.
    expect(toScopeRelativeKey(root, root)).toBe(root);
  });

  it('folds case in an absolute key only where the filesystem folds it', () => {
    // The platform contract behind the fixtures above, asserted directly rather
    // than left implicit — this is the assertion that would have caught the
    // hand-lowercased legacy keys. `normalizeFilePathKey` folds case on win32
    // and darwin and PRESERVES it on linux, where `Src` and `src` are two
    // directories; a lowercased absolute key is therefore a DIFFERENT file
    // there, outside the scope root, and keeping it absolute is correct rather
    // than a miss. Both platforms are asserted, neither is skipped.
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    const root = normalizeFilePathKey('/Repo/MixedCase');
    const file = `${root}/Src/A.ts`;

    expect(toScopeRelativeKey(file, root)).toBe(caseInsensitive ? 'src/a.ts' : 'Src/A.ts');

    // The same path with its case flattened: sliced on a folding filesystem,
    // left whole on a case-sensitive one.
    const lowered = file.toLowerCase();
    expect(toScopeRelativeKey(lowered, root)).toBe(caseInsensitive ? 'src/a.ts' : lowered);
  });

  it('leaves a file outside the scope root absolute', () => {
    const root = tempRoot();
    const outside = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(outside, 'external.ts');
    fs.writeFileSync(file, 'outside');

    handleReadEvent(store, sessionId, { file });

    const digest = store.getContentDigest(scopeKey, file)!;
    // Correct, just larger — and the two forms stay distinguishable without a
    // flag, which the index format depends on.
    expect(digest.path).toContain('external.ts');
    expect(digest.path.startsWith('..')).toBe(false);
    expect(/^([a-z]:)?\//i.test(digest.path)).toBe(true);
  });
});

// ── GC ──────────────────────────────────────────────────────────────────────

describe('digest index: bounding growth', () => {
  it('gc prunes stale digests, dry-run by default', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'ancient.ts'),
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId,
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    seedRead(store, sessionId, root, 'fresh.ts', 'x');

    const dry = runGc(db, { digestDays: 30 });
    // `cortex gc` is dry-run by default — the repo-wide convention for anything
    // destructive.
    expect(dry.dry_run).toBe(true);
    expect(dry.content_digests.candidates).toBe(1);
    expect(dry.content_digests.deleted).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM content_digests').get() as { c: number }).c).toBe(2);

    const wet = runGc(db, { digestDays: 30, dryRun: true === false });
    expect(wet.content_digests.deleted).toBe(1);
    const left = db.prepare('SELECT path FROM content_digests').all() as { path: string }[];
    expect(left).toHaveLength(1);
    expect(left[0]!.path).toBe('fresh.ts');
  });

  it('never prunes a file that is still being re-read', () => {
    // Keyed on recorded_at, which the upsert refreshes on every read — so an
    // actively-used file survives however old its first read was.
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'hot.ts'),
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId,
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    // Re-read today.
    seedRead(store, sessionId, root, 'hot.ts', 'still in use');

    const report = runGc(db, { digestDays: 30, dryRun: false });
    expect(report.content_digests.deleted).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM content_digests').get() as { c: number }).c).toBe(1);
  });
});

// ── The lookup contract a hot-path consumer must honour ─────────────────────

describe('digest index: the lookup contract (AC #2)', () => {
  function seedAndWrite(root: string, names: string[]): CortexStore {
    const { store, sessionId } = createStore(root);
    for (const name of names) {
      seedRead(store, sessionId, root, name, `body-${name}`);
    }
    writeDigestIndex(store, root);
    return store;
  }

  function grepCount(root: string, needle: string, fixedString = true): number {
    const args = fixedString ? ['-cF', needle] : ['-c', needle];
    const res = spawnSync(GREP, [...args, DIGEST_INDEX_FILENAME], {
      cwd: root,
      encoding: 'utf8',
    });
    return res.status === 0 ? Number(res.stdout.trim()) : 0;
  }

  it('the needle helper finds paths that a raw path would silently miss', () => {
    // Three transformations stand between a caller's path and the stored key —
    // case folding, scope-relativization, and percent-escaping — and each one
    // fails as a false "unread" rather than as an error. `indexLookupNeedle`
    // exists so a consumer cannot hand-roll any of them wrong.
    const root = tempRoot();
    seedAndWrite(root, ['src/Mixed Case.ts', 'src/pct%enc.ts', 'src/plain.ts']);

    for (const name of ['src/Mixed Case.ts', 'src/pct%enc.ts', 'src/plain.ts']) {
      const absolute = path.join(root, name);
      expect(grepCount(root, indexLookupNeedle(absolute, root)), name).toBe(1);
    }
  });

  it('a percent in the path is stored escaped, so the raw path finds nothing', () => {
    const root = tempRoot();
    seedAndWrite(root, ['src/pct%enc.ts']);
    // The measured trap: grepping the literal path returns zero — a silent
    // false "unread". The needle helper is not a convenience.
    expect(grepCount(root, '\tsrc/pct%enc.ts\t')).toBe(0);
    expect(grepCount(root, indexLookupNeedle(path.join(root, 'src/pct%enc.ts'), root))).toBe(1);
  });

  it('the surrounding tabs stop a prefix match', () => {
    const root = tempRoot();
    seedAndWrite(root, ['src/store.ts', 'src/store.tsx']);
    // Without the delimiters, `store.ts` also matches `store.tsx` and the
    // consumer reads the wrong file's digest.
    expect(grepCount(root, indexLookupNeedle(path.join(root, 'src/store.ts'), root))).toBe(1);
    expect(grepCount(root, 'src/store.ts')).toBe(2);
  });

  it('-F is load-bearing: without it a regex metacharacter matches wrongly', () => {
    const root = tempRoot();
    seedAndWrite(root, ['src/a.b.ts', 'src/axbxts.ts']);
    // Compared on the bare path: `	` is not a regex escape in grep's BRE, so
    // the delimiters would mask the effect being demonstrated.
    expect(grepCount(root, 'src/a.b.ts', true)).toBe(1);
    // As a regex, `.` matches any character — so it also matches `axbxts.ts`,
    // and a consumer that omitted -F reads the wrong file's digest.
    expect(grepCount(root, 'src/a.b.ts', false)).toBe(2);
  });
});

// ── Repairs from the review round ───────────────────────────────────────────

describe('digest index: review repairs', () => {
  it('the write and the read resolve the scope root by the SAME rule', () => {
    // Measured before: the write used the reading session's own
    // `worktree_path` while the read used the newest session's, so one scope
    // spanning two worktrees wrote a key nothing would look up — and two
    // distinct files collapsed onto one row.
    const rootA = tempRoot();
    const rootB = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, rootA);
    const store = new CortexStore(db);
    const scopeKey = 'project:shared';

    const older = store.createSession({ worktreePath: rootA, scopeType: 'project', scopeKey });
    const newer = store.createSession({ worktreePath: rootB, scopeType: 'project', scopeKey });
    const setStarted = db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?');
    setStarted.run('2026-08-01T00:00:00.000Z', older.id);
    setStarted.run('2026-08-02T00:00:00.000Z', newer.id);

    const fileA = path.join(rootA, 'a.ts');
    const fileB = path.join(rootB, 'a.ts');
    fs.writeFileSync(fileA, 'from-A');
    fs.writeFileSync(fileB, 'from-B');
    handleReadEvent(store, older.id, { file: fileA });
    handleReadEvent(store, newer.id, { file: fileB });

    // Two distinct files stay two rows, and each is findable by its own path.
    const rows = db.prepare('SELECT COUNT(*) c FROM content_digests').get() as { c: number };
    expect(rows.c).toBe(2);
    expect(store.getContentDigest(scopeKey, fileA)!.sha256).toBe(
      crypto.createHash('sha256').update('from-A').digest('hex'),
    );
    expect(store.getContentDigest(scopeKey, fileB)!.sha256).toBe(
      crypto.createHash('sha256').update('from-B').digest('hex'),
    );
    db.close();
  });

  it('the migration picks the same root the runtime does (newest session)', () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, rootB);
    const store = new CortexStore(db);
    const scopeKey = 'project:shared-two';

    const older = store.createSession({ worktreePath: rootA, scopeType: 'project', scopeKey });
    const newer = store.createSession({ worktreePath: rootB, scopeType: 'project', scopeKey });
    // `CreateSessionOpts` has no `startedAt`, so both rows carry the same
    // timestamp and MAX() would be ambiguous — the ordering IS the thing under
    // test, so it is set explicitly.
    const setStarted = db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?');
    setStarted.run('2026-08-01T00:00:00.000Z', older.id);
    setStarted.run('2026-08-02T00:00:00.000Z', newer.id);

    // A legacy absolute row under the NEWER root, keyed as Story 3.1 keyed it.
    // NOT hand-lowercased: `normalizeFilePathKey` preserves case on linux, and
    // `fs.mkdtempSync` suffixes are drawn from [A-Za-z0-9], so a lowered key is
    // a path outside the scope root there and is correctly left absolute.
    const legacy = normalizeFilePathKey(path.join(rootB, 'legacy.ts'));
    db.prepare(
      `INSERT INTO content_digests
         (scope_key, path, sha256, byte_size, session_id, oversize, read_count, recorded_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
    ).run(scopeKey, legacy, 'a'.repeat(64), 1, newer.id, '2026-08-01T00:00:00.000Z');

    ensureCortexSchema(db, rootB);

    // A `GROUP BY scope_key` picked an arbitrary (older) row, rewriting the key
    // relative to a root nothing uses.
    expect((db.prepare('SELECT path FROM content_digests').get() as { path: string }).path).toBe(
      'legacy.ts',
    );
    db.close();
  });

  it('a migration collision keeps the CURRENT row, not the legacy one', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    // Keyed as Story 3.1 keyed it, not hand-lowercased — see the fixture note in
    // 'rewrites absolute keys to scope-relative'. This test has its own fixture,
    // so its Linux failure was the same defect independently, not a knock-on:
    // an unmigrated legacy row never collides with the 'x.ts' row, `exists`
    // misses, `dropLegacy` never runs, and two rows survive.
    const absolute = normalizeFilePathKey(path.join(root, 'x.ts'));

    // Both forms present for one file, as `scopeRootFor` caching null could produce.
    db.prepare(
      `INSERT INTO content_digests
         (scope_key, path, sha256, byte_size, session_id, oversize, read_count, recorded_at)
       VALUES (?, ?, 'OLD', 111, ?, 0, 7, '2020-01-01T00:00:00.000Z')`,
    ).run(scopeKey, absolute, sessionId);
    db.prepare(
      `INSERT INTO content_digests
         (scope_key, path, sha256, byte_size, session_id, oversize, read_count, recorded_at)
       VALUES (?, 'x.ts', 'NEW', 222, ?, 0, 3, '2026-08-02T00:00:00.000Z')`,
    ).run(scopeKey, sessionId);

    ensureCortexSchema(db, root);

    const rows = db.prepare('SELECT * FROM content_digests').all() as {
      path: string;
      sha256: string;
      byte_size: number;
      read_count: number;
    }[];
    expect(rows).toHaveLength(1);
    // `UPDATE OR REPLACE` kept the 2020 row and destroyed the 2026 one, taking
    // its digest, size and accumulated reads with it — and regressing
    // `recorded_at` six years, straight into the GC window.
    expect(rows[0]!.path).toBe('x.ts');
    expect(rows[0]!.sha256).toBe('NEW');
    expect(rows[0]!.byte_size).toBe(222);
    expect(rows[0]!.read_count).toBe(3);
    expect(store.getContentDigest(scopeKey, path.join(root, 'x.ts'))!.sha256).toBe('NEW');
  });

  it('re-resolves a scope root that was unknown, instead of caching the miss', () => {
    // Measured: with `null` memoized, every later write in the SAME process
    // stayed keyed absolute even after a session recorded the root — so one
    // database answered two different things depending on which process asked,
    // which is the write/read asymmetry `scopeRootFor` exists to prevent.
    const root = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    const store = new CortexStore(db);
    const scopeKey = 'project:late-root';

    // A session with NO worktree_path: the root is genuinely unknown right now.
    const early = store.createSession({ scopeType: 'project', scopeKey });
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'early.ts'),
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId: early.id,
    });
    // Precondition: unknown root really did produce an absolute key.
    const earlyKey = (
      db.prepare('SELECT path FROM content_digests').get() as { path: string }
    ).path;
    expect(isAbsoluteFileKey(earlyKey)).toBe(true);

    // Now the root becomes known — same store instance, same process.
    const later = store.createSession({ worktreePath: root, scopeType: 'project', scopeKey });
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'later.ts'),
      sha256: 'b'.repeat(64),
      byteSize: 1,
      sessionId: later.id,
    });

    const laterRow = db
      .prepare("SELECT path FROM content_digests WHERE sha256 = ?")
      .get('b'.repeat(64)) as { path: string };
    expect(laterRow.path).toBe('later.ts');
    expect(isAbsoluteFileKey(laterRow.path)).toBe(false);
    db.close();
  });

  it('rejects a malformed byte_size instead of reading it as zero', () => {
    const base = 'scope\tpath\t' + 'a'.repeat(64);
    expect(parseIndexLine(`${base}\t\ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t-1\ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t1.5\ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t0x10\ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t1e3\ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t 7 \ts\t-`)).toBeNull();
    expect(parseIndexLine(`${base}\t7\ts\t-`)!.byteSize).toBe(7);
    expect(parseIndexLine(`${base}\t0\ts\t-`)!.byteSize).toBe(0);
  });

  it('tolerates a trailing CR rather than absorbing it into agent_id', () => {
    const line = `${formatIndexLine({
      scopeKey: 's',
      path: 'a.ts',
      sha256: 'b'.repeat(64),
      byteSize: 1,
      sessionId: 'sess',
      agentId: null,
    })}\r`;
    expect(parseIndexLine(line)!.agentId).toBeNull();
  });

  it('collapses . and .. in an already-relative key, as the absolute branch does', () => {
    // One file must not become three ledger rows depending on how it was spelled.
    expect(toScopeRelativeKey('src/./a.ts', null)).toBe('src/a.ts');
    expect(toScopeRelativeKey('src/../src/a.ts', null)).toBe('src/a.ts');
    expect(toScopeRelativeKey('src//a.ts', null)).toBe('src/a.ts');
    // And never collapses to an empty key, which would collide every row.
    // '', '.' and './' all mean "the scope root" and collapse to one non-empty
    // sentinel rather than to '', which would be indistinguishable from absent.
    expect(toScopeRelativeKey('', null)).toBe('.');
    expect(toScopeRelativeKey('.', null)).toBe('.');
    expect(toScopeRelativeKey('./', null)).toBe('.');
  });

  it('parses CORTEX_GC_DIGEST_DAYS with Number, not parseInt', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'old.ts'),
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId,
      recordedAt: '2026-07-01T00:00:00.000Z',
    });

    const previous = process.env['CORTEX_GC_DIGEST_DAYS'];
    try {
      // `parseInt('1e9')` is 1 — the natural way to disable pruning became a
      // ONE-DAY window that wiped nearly the whole ledger. Measured.
      process.env['CORTEX_GC_DIGEST_DAYS'] = '1e9';
      expect(runGc(db, { dryRun: true, now: new Date('2026-08-02T00:00:00.000Z') })
        .content_digests.candidates).toBe(0);

      process.env['CORTEX_GC_DIGEST_DAYS'] = '6e1';
      expect(runGc(db, { dryRun: true, now: new Date('2026-08-02T00:00:00.000Z') })
        .content_digests.candidates).toBe(0);
    } finally {
      if (previous === undefined) delete process.env['CORTEX_GC_DIGEST_DAYS'];
      else process.env['CORTEX_GC_DIGEST_DAYS'] = previous;
    }
  });

  it('a negative or NaN retention window falls back instead of pruning everything', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey, db } = createStore(root);
    store.upsertContentDigest({
      scopeKey,
      path: path.join(root, 'keep.ts'),
      sha256: 'a'.repeat(64),
      byteSize: 1,
      sessionId,
    });
    // A negative window puts the cutoff in the FUTURE and prunes everything;
    // NaN threw RangeError out of the date math.
    expect(runGc(db, { digestDays: -1, dryRun: true }).content_digests.candidates).toBe(0);
    expect(() => runGc(db, { digestDays: Number.NaN, dryRun: true })).not.toThrow();
  });
});

// ── AC #5 — measured, not assumed ───────────────────────────────────────────

describe('digest index: lookup cost (AC #5)', () => {
  it('grep stays small against a large index, measured on this platform', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    seedRead(store, sessionId, root, 'needle.ts', 'needle');

    // 20k synthetic records — a long-lived project's order of magnitude.
    const rows: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      rows.push(
        formatIndexLine({
          scopeKey,
          path: `src/generated/module-${i}/file-${i}.ts`,
          sha256: crypto.createHash('sha256').update(`c${i}`).digest('hex'),
          byteSize: 4096,
          sessionId,
          agentId: null,
        }),
      );
    }
    const indexPath = deriveDigestIndexPath(root);
    fs.writeFileSync(indexPath, `${rows.join('\n')}\n${collectIndexRecords(store, root).map(formatIndexLine).join('\n')}\n`);

    const started = Date.now();
    const grep = spawnSync(GREP, ['-F', '\tneedle.ts\t', DIGEST_INDEX_FILENAME], {
      cwd: root,
      encoding: 'utf8',
    });
    const elapsed = Date.now() - started;

    expect(grep.status).toBe(0);
    expect(grep.stdout).toContain('needle.ts');
    // Reported rather than tuned: this bounds the LOOKUP, which is the part
    // this story owns. It is deliberately loose because the process-spawn floor
    // on this Windows/Git Bash platform dominates it. (B-4a was re-based
    // 2026-08-02 and again 2026-08-03 — structural clause primary, end-to-end
    // miss ≤600 ms / hit ≤800 ms p95, PRD §10; the per-path measurement
    // belongs to Story 4.5's suite, not this one.)
    expect(elapsed).toBeLessThan(2000);
    // eslint-disable-next-line no-console
    console.log(`    [measured] grep over ${rows.length + 1} records: ${elapsed} ms`);
  });

  it('renders an empty index as an empty file, not a stray newline', () => {
    expect(renderDigestIndex([])).toBe('');
  });
});
