import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { resolveStoreIdentity } from '../src/scope/identity.js';
import { clearProjectStoreCache } from '../src/scope/store-migration.js';
import {
  applySchema,
  initializeMeta,
  ensureCortexSchema,
  getSchemaVersion,
  setMetaValue,
  NewerSchemaError,
  SCHEMA_VERSION,
} from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  computeFileDigest,
  createDigestCache,
  resolveDigestMaxBytes,
  DEFAULT_DIGEST_MAX_BYTES,
} from '../src/capture/digest.js';
import { handleReadEvent } from '../src/capture/hooks.js';
import { appendSpoolEntry, flushSpool } from '../src/capture/spool.js';
import { normalizeFilePathKey, toScopeRelativeKey, isAbsoluteFileKey } from '../src/scope/keys.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function tempRoot(): string {
  // os.tmpdir(), never a literal /tmp — on Windows those are different
  // filesystems and a hardcoded path passes CI while failing locally.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-digest-'));
}

function createStore(
  root: string,
  opts: { agentId?: string; agentType?: string } = {},
): { store: CortexStore; sessionId: string; scopeKey: string } {
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
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
  });
  return { store, sessionId: session.id, scopeKey };
}

function sha256Of(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── AC #1 — a digest record is stored, and it identifies the reader ──────────

describe('content digests: recording (AC #1)', () => {
  it('records sha256, byte size, mtime, path and scope_key when a read is replayed', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'a.ts');
    const bytes = Buffer.from('export const a = 1;\n');
    fs.writeFileSync(file, bytes);

    // Precondition, asserted inside the test: nothing recorded yet. Without
    // this the assertions below would pass against a fixture that had somehow
    // been pre-populated.
    expect(store.getContentDigest(scopeKey, file)).toBeUndefined();

    handleReadEvent(store, sessionId, { file });

    const digest = store.getContentDigest(scopeKey, file);
    expect(digest).toBeDefined();
    expect(digest!.sha256).toBe(sha256Of(bytes));
    expect(digest!.byteSize).toBe(bytes.length);
    // Stored relative to the scope root, not as the raw absolute argument:
    // the repo prefix is redundant with scope_key and carrying it twice is what
    // breached AC #5 in Story 3.1.
    expect(digest!.path).toBe('a.ts');
    expect(isAbsoluteFileKey(digest!.path)).toBe(false);
    expect(normalizeFilePathKey(file).endsWith(digest!.path)).toBe(true);
    expect(digest!.scopeKey).toBe(scopeKey);
    expect(digest!.oversize).toBe(false);
    // mtime is ISO-8601 UTC text, never an epoch number or a Date.
    expect(digest!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('identifies the reading session and its agent_id (AD-16)', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root, {
      agentId: 'agent-42',
      agentType: 'Explore',
    });
    const file = path.join(root, 'b.ts');
    fs.writeFileSync(file, 'x');

    handleReadEvent(store, sessionId, { file });

    const digest = store.getContentDigest(scopeKey, file)!;
    // Both, not either: AD-16 makes refund eligibility per-session with
    // ancestor rules, and a row knowing only its scope cannot answer whether
    // *this* session read the file.
    expect(digest.sessionId).toBe(sessionId);
    expect(digest.agentId).toBe('agent-42');
  });

  it('keys on (scope_key, path): a re-read updates one row and counts reads', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'c.ts');
    fs.writeFileSync(file, 'first');

    handleReadEvent(store, sessionId, { file });
    const first = store.getContentDigest(scopeKey, file)!;
    expect(first.readCount).toBe(1);

    fs.writeFileSync(file, 'second-content');
    handleReadEvent(store, sessionId, { file });

    const rows = store.db
      .prepare('SELECT COUNT(*) c FROM content_digests WHERE scope_key = ? AND path = ?')
      .get(scopeKey, toScopeRelativeKey(file, root)) as { c: number };
    // One row per file per scope, never one per read — otherwise the table
    // grows without bound and 3.3 has to pick among histories.
    expect(rows.c).toBe(1);

    const second = store.getContentDigest(scopeKey, file)!;
    expect(second.sha256).toBe(sha256Of(Buffer.from('second-content')));
    expect(second.sha256).not.toBe(first.sha256);
    // read_count accumulates because Story 3.4 orders by read frequency and a
    // keyed upsert cannot recover that number afterwards.
    expect(second.readCount).toBe(2);
  });

  it('isolates identical paths in different scopes', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'shared.ts');

    // Two scopes read the same path with DIFFERENT content. Asserting only
    // that each lookup returns *something* is not enough — a lookup ignoring
    // scope_key returns the other scope's row and still satisfies
    // `toBeDefined()`. This is what a mutation dropping `scope_key = ?` from
    // the query survived on, so each side asserts its own bytes.
    fs.writeFileSync(file, 'content-for-main');
    handleReadEvent(store, sessionId, { file });

    const other = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: 'project:other-branch',
    });
    fs.writeFileSync(file, 'content-for-other-branch');
    handleReadEvent(store, other.id, { file });

    const mainDigest = store.getContentDigest(scopeKey, file)!;
    const otherDigest = store.getContentDigest('project:other-branch', file)!;

    expect(mainDigest.scopeKey).toBe(scopeKey);
    expect(otherDigest.scopeKey).toBe('project:other-branch');
    expect(mainDigest.sha256).toBe(sha256Of(Buffer.from('content-for-main')));
    expect(otherDigest.sha256).toBe(sha256Of(Buffer.from('content-for-other-branch')));
    expect(mainDigest.sha256).not.toBe(otherDigest.sha256);
    expect(mainDigest.sessionId).not.toBe(otherDigest.sessionId);

    const total = store.db
      .prepare('SELECT COUNT(*) c FROM content_digests WHERE path = ?')
      .get(toScopeRelativeKey(file, root)) as { c: number };
    expect(total.c).toBe(2);
  });

  it('a descendant read does not erase its ancestor as the recorder (AD-16)', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'both-read.ts');
    fs.writeFileSync(file, 'read by parent then child');

    // Parent reads it first.
    handleReadEvent(store, sessionId, { file });
    expect(store.getContentDigest(scopeKey, file)!.sessionId).toBe(sessionId);

    // Its own subagent reads the same file.
    const child = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey,
      parentSessionId: sessionId,
      agentId: 'sub-1',
      agentType: 'Explore',
    });
    handleReadEvent(store, child.id, { file });

    const digest = store.getContentDigest(scopeKey, file)!;
    // Last-writer-wins destroyed this: the parent's read became unrecoverable
    // and the parent would later be told a *subagent* read a file it read
    // itself. AD-16 counts self-or-ancestor as eligible, so the ancestor is the
    // stronger claim and is kept. Content columns still update.
    expect(digest.sessionId).toBe(sessionId);
    expect(digest.agentId).toBeNull();
    expect(digest.readCount).toBe(2);
  });

  it('an unrelated later session does take over as recorder', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'handed-over.ts');
    fs.writeFileSync(file, 'x');

    handleReadEvent(store, sessionId, { file });

    // No parent relationship — nothing stronger is being discarded, so the
    // newest reader is correctly the recorded one.
    const later = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey,
    });
    handleReadEvent(store, later.id, { file });

    expect(store.getContentDigest(scopeKey, file)!.sessionId).toBe(later.id);
  });

  it('normalizes the path key: one file is one row however it is spelled', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'spelled.ts');
    fs.writeFileSync(file, 'one file');

    // Measured before normalization: these produced three rows for one file.
    const spellings = [file, file.replace(/\\/g, '/'), path.join(root, '.', 'spelled.ts')];
    if (process.platform === 'win32') {
      spellings.push(file.toLowerCase(), file.toUpperCase());
    }
    for (const spelling of spellings) {
      handleReadEvent(store, sessionId, { file: spelling });
    }

    const rows = store.db
      .prepare('SELECT COUNT(*) c FROM content_digests WHERE scope_key = ?')
      .get(scopeKey) as { c: number };
    expect(rows.c).toBe(1);
    // And every spelling finds it back.
    for (const spelling of spellings) {
      expect(store.getContentDigest(scopeKey, spelling)).toBeDefined();
    }
    expect(store.getContentDigest(scopeKey, file)!.readCount).toBe(spellings.length);
  });

  it('records nothing for a file that does not exist, without throwing (AD-12)', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const missing = path.join(root, 'nope.ts');
    expect(fs.existsSync(missing)).toBe(false);

    expect(() => handleReadEvent(store, sessionId, { file: missing })).not.toThrow();
    expect(store.getContentDigest(scopeKey, missing)).toBeUndefined();
    // The read *event* is still recorded — only the ledger row is absent.
    const events = store.db
      .prepare("SELECT COUNT(*) c FROM events WHERE type = 'read'")
      .get() as { c: number };
    expect(events.c).toBe(1);
  });
});

// ── AC #1/#2 — the digest happens on the cold path, through a real flush ─────

describe('content digests: the cold path is where this runs (AC #1, #2)', () => {
  it('records digests when a spooled batch is flushed', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'flushed.ts');
    const bytes = Buffer.from('via the spool\n');
    fs.writeFileSync(file, bytes);

    appendSpoolEntry(root, { tool: 'read', file, ts: '2026-08-01T10:00:00Z', seq: 1 });
    // Precondition: appending to the spool alone records nothing. This is the
    // assertion that makes the flush, not the append, the thing under test.
    expect(store.getContentDigest(scopeKey, file)).toBeUndefined();

    const result = flushSpool(store, root, sessionId);
    expect(result.processed).toBe(1);
    expect(store.getContentDigest(scopeKey, file)!.sha256).toBe(sha256Of(bytes));
  });

  it('attributes a subagent read to the subagent session, not the parent (AD-16)', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'sub.ts');
    fs.writeFileSync(file, 'read by a subagent');

    appendSpoolEntry(root, {
      tool: 'read',
      file,
      ts: '2026-08-01T10:00:00Z',
      seq: 1,
      agent_id: 'sub-7',
      agent_type: 'Explore',
    });
    flushSpool(store, root, sessionId);

    const digest = store.getContentDigest(scopeKey, file)!;
    // The whole point of AD-16: this must NOT be the parent, or the parent is
    // later told "unchanged since you read it" about a file it never read.
    expect(digest.sessionId).not.toBe(sessionId);
    expect(digest.agentId).toBe('sub-7');
    const sub = store.getSession(digest.sessionId)!;
    expect(sub.parent_session_id).toBe(sessionId);
  });

  it('counts every read of a path in one batch', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'hot.ts');
    fs.writeFileSync(file, 'read many times');

    for (let i = 0; i < 5; i++) {
      appendSpoolEntry(root, { tool: 'read', file, ts: `2026-08-01T10:00:0${i}Z`, seq: i });
    }
    flushSpool(store, root, sessionId);

    // This is a property of the upsert, NOT of the digest cache. The previous
    // name promised a hash-count check it never made, and a mutation removing
    // the cache from the flush survived behind it.
    expect(store.getContentDigest(scopeKey, file)!.readCount).toBe(5);
  });

  it('the flush actually passes its cache — the file is hashed once per batch', () => {
    // The wiring test the previous one only appeared to be. Unwiring the cache
    // in `processClaimFile` left all tests passing, because the helper was
    // covered directly and nothing proved the flush used it. Same class as the
    // Story 2.5/2.6 "helper, not the transport" finding.
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'swapped.ts');
    fs.writeFileSync(file, 'original bytes');

    // ESM namespaces are not configurable, so `vi.spyOn(fs, ...)` is impossible
    // here. Instead the file's CONTENT changes between reads: with the flush
    // passing one cache, all four entries share the first hash; without it,
    // each entry re-reads and the last write wins.
    let writes = 0;
    const realStat = fs.statSync;
    const countingStat = ((p: fs.PathLike, ...rest: unknown[]) => {
      const s = (realStat as unknown as (...a: unknown[]) => fs.Stats)(p, ...rest);
      if (String(p) === file) {
        writes++;
        // Mutate AFTER the first stat, so a cached digest keeps the original
        // bytes and an uncached one picks up the change.
        fs.writeFileSync(file, Buffer.from(`mutated ${writes}`));
      }
      return s;
    }) as typeof fs.statSync;

    for (let i = 0; i < 4; i++) {
      appendSpoolEntry(root, { tool: 'read', file, ts: `2026-08-01T11:00:0${i}Z`, seq: i });
    }
    flushSpool(store, root, sessionId, { statSync: countingStat });

    const stored = store.getContentDigest(scopeKey, file)!;
    // Exactly one stat means exactly one hash for four reads in one batch.
    // Without the flush passing its cache this is 4 — which is precisely what
    // the previous "hashes once per batch" test failed to notice.
    expect(writes).toBe(1);
    // And the batch settled on the state it saw once, not the last mutation.
    expect(stored.sha256).toBe(sha256Of(Buffer.from('mutated 1')));
    expect(stored.readCount).toBe(4);
  });

  it('the per-batch cache reads the file exactly once for repeated paths', () => {
    const root = tempRoot();
    const file = path.join(root, 'cached.ts');
    fs.writeFileSync(file, 'original');

    const cache = createDigestCache();
    const first = cache(file);

    // Change the bytes underneath. A cache that re-hashes would return the new
    // digest; the contract is that one batch sees one on-disk state.
    fs.writeFileSync(file, 'changed underneath');
    const second = cache(file);

    expect(second!.sha256).toBe(first!.sha256);
    expect(second!.sha256).toBe(sha256Of(Buffer.from('original')));
  });

  it('the PostToolUse hook script computes no digest itself (N-4)', () => {
    // A source check is legitimate here only because the claim IS about the
    // file's text: the shipped hook must contain no hashing invocation. It
    // would NOT be legitimate as a proxy for "the digest gets recorded" — that
    // is asserted behaviorally, through the real flush, above.
    const script = fs.readFileSync('hooks/claude/cortex-capture.sh', 'utf8');
    expect(script).not.toMatch(/sha256sum|shasum|openssl\s+dgst|md5sum/);
    // The read line still carries the field the cold path needs.
    expect(script).toContain('file:(.tool_input.file_path');
  });
});

// ── AC #3 — oversize ────────────────────────────────────────────────────────

describe('content digests: oversize policy (AC #3)', () => {
  it('records path and size but no digest past the ceiling', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'big.bin');
    const bytes = Buffer.alloc(4096, 7);
    fs.writeFileSync(file, bytes);

    // Ceiling below the file size, injected rather than via env so the test is
    // hermetic and order-independent.
    const digest = computeFileDigest(file, 1024);
    expect(digest).not.toBeNull();
    expect(digest!.oversize).toBe(true);
    expect(digest!.sha256).toBeNull();
    expect(digest!.byteSize).toBe(4096);

    store.upsertContentDigest({
      scopeKey,
      path: file,
      sha256: digest!.sha256,
      byteSize: digest!.byteSize,
      mtime: digest!.mtime,
      sessionId,
      oversize: digest!.oversize,
    });
    const stored = store.getContentDigest(scopeKey, file)!;
    expect(stored.oversize).toBe(true);
    expect(stored.sha256).toBeNull();
    expect(stored.byteSize).toBe(4096);
  });

  it('carries the oversize verdict through handleReadEvent, not just the helper', () => {
    // The 2.5/2.6 lesson: a unit-tested helper proves nothing about whether the
    // path that ships ever honors its result. A mutation hard-coding
    // `oversize: false` at the call site survived a helper-only test.
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'huge.bin');
    fs.writeFileSync(file, Buffer.alloc(8192, 3));

    const previous = process.env['CORTEX_DIGEST_MAX_BYTES'];
    process.env['CORTEX_DIGEST_MAX_BYTES'] = '1024';
    try {
      handleReadEvent(store, sessionId, { file });
    } finally {
      if (previous === undefined) {
        delete process.env['CORTEX_DIGEST_MAX_BYTES'];
      } else {
        process.env['CORTEX_DIGEST_MAX_BYTES'] = previous;
      }
    }

    const stored = store.getContentDigest(scopeKey, file)!;
    expect(stored.oversize).toBe(true);
    expect(stored.sha256).toBeNull();
    expect(stored.byteSize).toBe(8192);
  });

  it('digests a file exactly at the ceiling, and refuses one byte over', () => {
    const root = tempRoot();
    const atLimit = path.join(root, 'at.bin');
    const overLimit = path.join(root, 'over.bin');
    fs.writeFileSync(atLimit, Buffer.alloc(1024, 1));
    fs.writeFileSync(overLimit, Buffer.alloc(1025, 1));

    // Boundary is `>`, not `>=`: a file exactly at the ceiling is still hashed.
    expect(computeFileDigest(atLimit, 1024)!.oversize).toBe(false);
    expect(computeFileDigest(atLimit, 1024)!.sha256).not.toBeNull();
    expect(computeFileDigest(overLimit, 1024)!.oversize).toBe(true);
  });

  it('resolves the ceiling with Number, not parseInt', () => {
    expect(resolveDigestMaxBytes(undefined)).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('4096')).toBe(4096);
    // The trap Story 2.6's review found in resolveWalMaxBytes: parseInt('2e6')
    // is 2, which would turn a 2 MB ceiling into a 2-byte one and mark every
    // file oversize. Number('2e6') is 2000000.
    expect(resolveDigestMaxBytes('2e6')).toBe(2_000_000);
    expect(resolveDigestMaxBytes('0x400')).toBe(1024);
    // Nonsense and hostile values fall back rather than disabling the ceiling.
    expect(resolveDigestMaxBytes('abc')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('  ')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('-1')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('0')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('Infinity')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    expect(resolveDigestMaxBytes('NaN')).toBe(DEFAULT_DIGEST_MAX_BYTES);
    // A trailing newline from a shell export must not become a fallback.
    expect(resolveDigestMaxBytes('4096\n')).toBe(4096);
  });

  it('defaults to 2 MiB', () => {
    expect(DEFAULT_DIGEST_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('a fractional ceiling falls back instead of flooring to zero', () => {
    // `parsed <= 0` checked before `Math.floor` let (0,1) through and floored
    // to 0, marking EVERY file oversize and silently disabling hashing —
    // measured end-to-end as `sha256 NULL, oversize 1` on a 20-byte file.
    for (const raw of ['0.5', '.9', '1e-3', '0.0001', '0.999']) {
      expect(resolveDigestMaxBytes(raw), `for ${raw}`).toBe(DEFAULT_DIGEST_MAX_BYTES);
    }
    // A fraction at or above 1 still floors normally rather than falling back.
    expect(resolveDigestMaxBytes('1024.7')).toBe(1024);
    expect(resolveDigestMaxBytes('1.5')).toBe(1);
  });

  it('a fractional ceiling does not disable hashing end to end', () => {
    const root = tempRoot();
    const { store, sessionId, scopeKey } = createStore(root);
    const file = path.join(root, 'small.ts');
    fs.writeFileSync(file, 'twenty bytes here!!!');

    const previous = process.env['CORTEX_DIGEST_MAX_BYTES'];
    process.env['CORTEX_DIGEST_MAX_BYTES'] = '0.5';
    try {
      handleReadEvent(store, sessionId, { file });
    } finally {
      if (previous === undefined) delete process.env['CORTEX_DIGEST_MAX_BYTES'];
      else process.env['CORTEX_DIGEST_MAX_BYTES'] = previous;
    }

    const stored = store.getContentDigest(scopeKey, file)!;
    expect(stored.oversize).toBe(false);
    expect(stored.sha256).not.toBeNull();
  });

  it('an unusable maxBytes argument falls back rather than disabling the ceiling', () => {
    const root = tempRoot();
    const file = path.join(root, 'x.bin');
    fs.writeFileSync(file, Buffer.alloc(64, 1));

    // Both are public parameters on an exported function. NaN compares false
    // against everything (ceiling silently off); a negative marks everything
    // oversize. Neither should depend on the caller being careful.
    expect(computeFileDigest(file, Number.NaN)!.oversize).toBe(false);
    expect(computeFileDigest(file, Number.NaN)!.sha256).not.toBeNull();
    expect(computeFileDigest(file, -1)!.oversize).toBe(false);
    expect(computeFileDigest(file, 0)!.oversize).toBe(false);
  });

  it('re-checks the ceiling against the bytes actually read (TOCTOU)', () => {
    // stat and read are two syscalls. Measured with a concurrent writer, 36 of
    // 17,147 calls hashed a 6 MiB file under a 2 MiB ceiling, and 4.5% of rows
    // had a byte_size and a sha256 describing different states. Simulated here
    // deterministically: the file grows past the ceiling after the stat.
    const root = tempRoot();
    const file = path.join(root, 'grows.bin');
    fs.writeFileSync(file, Buffer.alloc(512, 1));

    const realStat = fs.statSync;
    const stub = ((p: fs.PathLike, ...rest: unknown[]) => {
      const s = (realStat as unknown as (...a: unknown[]) => fs.Stats)(p, ...rest);
      if (String(p) === file) {
        // Report the small size, then grow the file before it is read.
        fs.writeFileSync(file, Buffer.alloc(4096, 2));
      }
      return s;
    }) as typeof fs.statSync;

    const digest = computeFileDigest(file, 1024, { statSync: stub });
    // The old code returned oversize:false with byte_size 512 and a sha256 of
    // 4096 bytes — two columns describing different files.
    expect(digest!.oversize).toBe(true);
    expect(digest!.sha256).toBeNull();
    expect(digest!.byteSize).toBe(4096);
  });
});

// ── AC #4 — binary and non-UTF-8 files are digested ─────────────────────────

describe('content digests: binary content (AC #4)', () => {
  it('digests bytes that would be corrupted by a UTF-8 round trip', () => {
    const root = tempRoot();
    const file = path.join(root, 'bin.dat');
    // Lone continuation bytes and a NUL: decoding to UTF-8 replaces these with
    // U+FFFD, so a digest taken after `toString('utf8')` does not reproduce
    // from the same bytes. This repository has a file like this in src/.
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28, 0x00]);
    fs.writeFileSync(file, bytes);

    const digest = computeFileDigest(file)!;
    expect(digest.sha256).toBe(sha256Of(bytes));
    expect(digest.oversize).toBe(false);
    expect(digest.byteSize).toBe(bytes.length);

    // Prove the claim rather than assert it: the UTF-8 route gives a different
    // digest, so this test fails if the implementation ever decodes first.
    const viaUtf8 = sha256Of(Buffer.from(bytes.toString('utf8'), 'utf8'));
    expect(viaUtf8).not.toBe(digest.sha256);
  });

  it('records nothing for a directory', () => {
    const root = tempRoot();
    const dir = path.join(root, 'subdir');
    fs.mkdirSync(dir);
    expect(computeFileDigest(dir)).toBeNull();
  });
});

// ── AC #5 — footprint ───────────────────────────────────────────────────────

describe('content digests: storage footprint (AC #5)', () => {
  it('costs no more than 400 bytes per tracked file, measured', () => {
    const root = tempRoot();
    const dbPath = path.join(root, 'footprint.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });

    const COUNT = 500;
    // Realistic absolute Windows paths — the dominant per-row cost, and the
    // reason a column-width estimate understates the real footprint.
    const mkPath = (i: number) =>
      `C:\\Users\\Developer\\source\\repos\\some-product\\packages\\core\\src\\features\\module-${i}\\implementation-detail-${i}.ts`;

    db.exec('VACUUM');
    const before = fs.statSync(dbPath).size;

    const insert = db.transaction(() => {
      for (let i = 0; i < COUNT; i++) {
        store.upsertContentDigest({
          scopeKey: `project:${root}`,
          path: mkPath(i),
          sha256: crypto.createHash('sha256').update(`content-${i}`).digest('hex'),
          byteSize: 4096 + i,
          mtime: new Date().toISOString(),
          sessionId: session.id,
          agentId: 'agent-0000-1111-2222',
        });
      }
    });
    insert();

    // VACUUM so the measurement is settled pages, not WAL frames or free space.
    db.exec('VACUUM');
    const after = fs.statSync(dbPath).size;
    db.close();

    const perFile = (after - before) / COUNT;
    // Guard the measurement itself: a fixture that inserted nothing would give
    // perFile === 0 and pass the ceiling vacuously.
    expect(after).toBeGreaterThan(before);
    expect(perFile).toBeGreaterThan(0);
    expect(perFile).toBeLessThanOrEqual(400);
  });

  it('meets the ceiling for every real path length, now that keys are relative', () => {
    // Story 3.1 shipped this FAILING at the repo's longest real path (417.8
    // b/file at 135 chars). Story 3.2 stripped the scope root from the key —
    // the prefix redundant with scope_key — and the same path now costs 376.8.
    // This test asserts the fix and pins where the cliff moved to; if a change
    // moves it back, this fails rather than the ceiling silently regressing.
    const repoRoot = 'C:/Claude Code/cortex';
    const scopeKey = 'branch:c:/claude code/cortex/.git:c:/claude code/cortex:r1-context-economy';
    const home = tempRoot();
    const dbPath = path.join(home, 'boundary.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, home);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: repoRoot,
      scopeType: 'branch',
      scopeKey,
    });

    const COUNT = 300;
    function perFileAtAbsoluteLength(len: number, agentId: string | null = null): number {
      db.exec('DELETE FROM content_digests');
      db.exec('VACUUM');
      const before = fs.statSync(dbPath).size;
      db.transaction(() => {
        for (let i = 0; i < COUNT; i++) {
          const suffix = `-${i}.ts`;
          const fill = Math.max(1, len - repoRoot.length - 1 - suffix.length);
          store.upsertContentDigest({
            scopeKey,
            path: `${repoRoot}/${'x'.repeat(fill)}${suffix}`,
            sha256: crypto.createHash('sha256').update(`c${i}`).digest('hex'),
            byteSize: 4096,
            mtime: '2026-08-01T00:00:00.000Z',
            sessionId: session.id,
            agentId,
          });
        }
      })();
      db.exec('VACUUM');
      return (fs.statSync(dbPath).size - before) / COUNT;
    }

    // Precondition: the key really is being stored relative, or this measures
    // the absolute fallback and proves nothing about the fix.
    store.upsertContentDigest({
      scopeKey,
      path: `${repoRoot}/src/db/store.ts`,
      sha256: 'x'.repeat(64),
      byteSize: 1,
      sessionId: session.id,
    });
    expect(store.getContentDigest(scopeKey, `${repoRoot}/src/db/store.ts`)!.path).toBe(
      'src/db/store.ts',
    );

    const median = perFileAtAbsoluteLength(44);
    const p90 = perFileAtAbsoluteLength(122);
    const repoMax = perFileAtAbsoluteLength(135);
    const siblingRepoMax = perFileAtAbsoluteLength(145);
    const beyond = perFileAtAbsoluteLength(220);

    // AC #5 now holds for every real path length measured across this repo and
    // repo-b — including the 135-char path that failed in Story 3.1.
    expect(median).toBeLessThanOrEqual(400);
    expect(p90).toBeLessThanOrEqual(400);
    expect(repoMax).toBeLessThanOrEqual(400);
    expect(siblingRepoMax).toBeLessThanOrEqual(400);
    // The cliff still exists, further out. Pinned at the MEASURED first breach
    // (152) rather than at a comfortably distant value, because an assertion 68
    // characters past the cliff locates nothing.
    expect(beyond).toBeGreaterThan(400);
    expect(perFileAtAbsoluteLength(152)).toBeGreaterThan(400);
    expect(perFileAtAbsoluteLength(145)).toBeLessThanOrEqual(400);

    // And the dimension the fixture previously could not see: `agent_id` shares
    // the same row budget, so a SUBAGENT read breaches 17 characters earlier —
    // at 135, exactly this repository's longest real path. AC #5 holds for a
    // primary-session read across the full real range and is still breached for
    // a subagent read of the longest paths. Asserted so the limit is a recorded
    // fact rather than a footnote.
    const agentId = 'a9f7b2b4450b02c8f';
    expect(perFileAtAbsoluteLength(122, agentId)).toBeLessThanOrEqual(400);
    expect(perFileAtAbsoluteLength(135, agentId)).toBeGreaterThan(400);
    db.close();
  });

});

// ── AC #6 (corrected) / #7 / #8 — migration discipline ──────────────────────

describe('content digests: migration discipline (AC #6-corrected, #7, #8)', () => {
  it('does NOT change SCHEMA_VERSION — 2.2 spent the release bump (AD-11)', () => {
    // The AC text says this story bumps 4 -> 5. It is stale: Story 2.2 took
    // the single bump and created V5_TABLES, and this story appends to it.
    // Pinned as a test because prose in a replan cannot fail a build.
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('creates content_digests as part of V5_TABLES, keyed by (scope_key, path)', () => {
    const db = new Database(':memory:');
    applySchema(db);

    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='content_digests'")
      .get() as { sql: string } | undefined;
    expect(table).toBeDefined();
    // The key AD-3/AD-16 depend on, and a footprint decision (AC #5): the
    // stated key IS the primary key, so there is no surrogate id and no second
    // btree. WITHOUT ROWID keeps the row in that one index.
    expect(table!.sql).toMatch(/PRIMARY KEY\s*\(\s*scope_key\s*,\s*path\s*\)/);
    expect(table!.sql).toMatch(/WITHOUT\s+ROWID/i);
    expect(table!.sql).not.toMatch(/\bid\s+TEXT\s+PRIMARY KEY/);

    // The uniqueness the upsert depends on is enforced by that PK.
    db.prepare(
      `INSERT INTO sessions (id, started_at, status, scope_key)
       VALUES ('s1', '2026-08-01T00:00:00Z', 'active', 'project:x')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO content_digests
       (scope_key, path, sha256, byte_size, session_id, recorded_at)
       VALUES ('project:x', '/a.ts', 'h', 1, 's1', '2026-08-01T00:00:00Z')`,
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY KEY/i);
    db.close();
  });

  it('does not project into memory_items (AD-4: a lookup structure, not knowledge)', () => {
    const root = tempRoot();
    const { store, sessionId } = createStore(root);
    const file = path.join(root, 'lookup.ts');
    fs.writeFileSync(file, 'not knowledge');

    const before = store.db
      .prepare('SELECT COUNT(*) c FROM memory_items')
      .get() as { c: number };
    handleReadEvent(store, sessionId, { file });
    const after = store.db.prepare('SELECT COUNT(*) c FROM memory_items').get() as { c: number };

    // If this ever projects, it floods ranking with lookup rows and incurs an
    // AD-5 kind-coverage obligation the gate would then fail on.
    expect(after.c).toBe(before.c);
  });

  it('is idempotent — applying the schema repeatedly changes nothing (AC #7)', () => {
    const root = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    store.upsertContentDigest({
      scopeKey: `project:${root}`,
      path: '/a/b.ts',
      sha256: 'abc',
      byteSize: 1,
      sessionId: session.id,
    });

    expect(() => {
      applySchema(db);
      applySchema(db);
      ensureCortexSchema(db, root);
    }).not.toThrow();

    // Re-running the DDL must not drop the row — the failure mode AD-11's
    // "no destructive statement" exists to prevent.
    const row = store.getContentDigest(`project:${root}`, '/a/b.ts');
    expect(row).toBeDefined();
    expect(row!.sha256).toBe('abc');
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('survives interruption at a statement boundary and keeps memory (AC #8)', () => {
    const root = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      content: 'user-authored memory that must survive',
      subject: 'migration-safety',
    });

    // Simulate a migration interrupted before content_digests was created:
    // drop the new table and re-open, exactly as the previous binary left it.
    db.exec('DROP TABLE content_digests');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='content_digests'").get(),
    ).toBeUndefined();

    expect(() => ensureCortexSchema(db, root)).not.toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='content_digests'").get(),
    ).toBeDefined();
    const notes = db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
    expect(notes.c).toBe(1);
    db.close();
  });
});

// ── AC #9 — P-5, refusing a store from a newer build ────────────────────────

describe('newer-schema refusal (AC #9, P-5)', () => {
  function newerStore(root: string): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    setMetaValue(db, 'schema_version', String(SCHEMA_VERSION + 1));
    return db;
  }

  it('refuses rather than opening it', () => {
    const root = tempRoot();
    const db = newerStore(root);
    // Precondition: the store really is marked newer.
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION + 1);

    expect(() => ensureCortexSchema(db, root)).toThrow(NewerSchemaError);
    db.close();
  });

  it('does NOT rewrite the version down — the defect this replaced', () => {
    const root = tempRoot();
    const db = newerStore(root);

    try {
      ensureCortexSchema(db, root);
    } catch {
      // expected
    }

    // Measured before the fix: the guard was `!==`, so it fired in both
    // directions and silently downgraded a newer store to this build's
    // version, destroying the evidence `doctor` reports. Strictly `<` now.
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION + 1);
    db.close();
  });

  it('carries both versions and names upgrading as the fix, never "run a command"', () => {
    const root = tempRoot();
    const db = newerStore(root);

    let caught: NewerSchemaError | undefined;
    try {
      ensureCortexSchema(db, root);
    } catch (err) {
      caught = err as NewerSchemaError;
    }

    expect(caught).toBeInstanceOf(NewerSchemaError);
    expect(caught!.storeVersion).toBe(SCHEMA_VERSION + 1);
    expect(caught!.binaryVersion).toBe(SCHEMA_VERSION);
    expect(caught!.message).toContain('newer version');
    expect(caught!.message).toContain('npm install -g cortex-memory');
    // The fix that must never be offered: running a cortex command is what
    // rewrote the version down in the first place.
    expect(caught!.message).not.toMatch(/run (any )?`?cortex/i);
    db.close();
  });

  it('still migrates an OLDER store upward', () => {
    const root = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    setMetaValue(db, 'schema_version', '4');
    expect(getSchemaVersion(db)).toBe(4);

    // Narrowing `!==` to `<` must not break the direction that has to work.
    expect(() => ensureCortexSchema(db, root)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  // ── AD-12: the refusal must be loud for a user and silent for a hook ──────

  describe('a refused store degrades to silence on hook paths (AD-12)', () => {
    /**
     * These tests spawn `dist/`, while the rest of the suite imports `src/`.
     * A stale build tests code that is not the code under review — the trap
     * Story 2.6 spent an hour on. Fail loudly rather than prove nothing.
     */
    function assertDistIsCurrent(sourceFile: string, distFile: string): void {
      const src = fs.statSync(path.join(process.cwd(), sourceFile)).mtimeMs;
      const out = fs.statSync(path.join(process.cwd(), distFile)).mtimeMs;
      expect(
        out,
        `${distFile} is older than ${sourceFile}; run \`npm run build\` — these tests spawn dist/`,
      ).toBeGreaterThanOrEqual(src);
    }

    /** A real repo whose real store has been stamped one version too new. */
    function repoWithNewerStore(): { repo: string; home: string } {
      const base = tempRoot();
      const repo = path.join(base, 'repo');
      const home = path.join(base, 'home');
      fs.mkdirSync(repo);
      fs.mkdirSync(home);
      execFileSync('git', ['init', '-q', '.'], { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
        { cwd: repo, stdio: 'pipe' },
      );

      const previousHome = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = home;
      let dbPath: string;
      try {
        clearProjectStoreCache();
        dbPath = resolveStoreIdentity(repo).dbPath;
      } finally {
        if (previousHome === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = previousHome;
        clearProjectStoreCache();
      }

      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const seed = new Database(dbPath);
      applySchema(seed);
      initializeMeta(seed, repo);
      setMetaValue(seed, 'schema_version', String(SCHEMA_VERSION + 1));
      seed.close();

      // Precondition: the store really is on disk and really is newer. Without
      // this the "silent" assertions below would pass against no store at all.
      expect(fs.existsSync(dbPath)).toBe(true);
      const check = new Database(dbPath, { readonly: true });
      expect(getSchemaVersion(check)).toBe(SCHEMA_VERSION + 1);
      check.close();

      return { repo, home };
    }

    function run(
      entry: string,
      args: string[],
      repo: string,
      home: string,
      input?: string,
    ): { status: number; out: string } {
      const res = spawnSync(process.execPath, [path.join(process.cwd(), entry), ...args], {
        cwd: repo,
        env: { ...process.env, CORTEX_HOME: home },
        input: input ?? '',
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
    }

    it('inject-header (SessionStart) prints nothing and exits 0', () => {
      assertDistIsCurrent('src/transports/cli.ts', 'dist/transports/cli.js');
      const { repo, home } = repoWithNewerStore();
      const r = run('dist/transports/cli.js', ['inject-header', '--quiet'], repo, home);
      // N-1 and AD-12: SessionStart emits nothing and never fails the turn.
      expect(r.out).toBe('');
      expect(r.status).toBe(0);
    });

    it('reflect-pre (fires on every Edit) prints nothing and exits 0', () => {
      assertDistIsCurrent('src/transports/hook-entry.ts', 'dist/transports/hook-entry.js');
      const { repo, home } = repoWithNewerStore();
      const payload = JSON.stringify({ cwd: repo, tool_input: { file_path: 'a.txt' } });
      const r = run('dist/transports/hook-entry.js', ['reflect-pre'], repo, home, payload);
      // Measured before the guard existed: a raw NewerSchemaError stack trace
      // on every Edit and Write, exit 1.
      expect(r.out).toBe('');
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/NewerSchemaError|at ensureCortexSchema/);
    });

    it('PostToolUse capture prints nothing and exits 0', () => {
      assertDistIsCurrent('src/transports/hook-entry.ts', 'dist/transports/hook-entry.js');
      const { repo, home } = repoWithNewerStore();
      const payload = JSON.stringify({
        cwd: repo,
        tool_name: 'Read',
        tool_input: { file_path: 'a.txt' },
      });
      const r = run('dist/transports/hook-entry.js', ['post'], repo, home, payload);
      expect(r.out).toBe('');
      expect(r.status).toBe(0);
    });

    it('but a user-invoked command still refuses clearly and exits non-zero (P-5)', () => {
      assertDistIsCurrent('src/transports/cli.ts', 'dist/transports/cli.js');
      const { repo, home } = repoWithNewerStore();
      const r = run('dist/transports/cli.js', ['status'], repo, home);
      // The other half of AD-12: silence is for hooks, not for people. If this
      // were also silent the refusal would be undiscoverable.
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('newer version');
      expect(r.out).toContain('npm install -g cortex-memory');
    });
  });

  it('opens a store at the current version unchanged', () => {
    const root = tempRoot();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);

    expect(() => ensureCortexSchema(db, root)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
