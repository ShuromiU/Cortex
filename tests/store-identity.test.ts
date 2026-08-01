import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { openDatabase, ensureCortexSchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  computeStoreId,
  cortexHome,
  readRootCommitOid,
  resolveRealPath,
  resolveStoreIdentity,
  sanitizeLabel,
  storeLabelFor,
  STORE_FILENAME,
} from '../src/scope/identity.js';
import {
  adoptStore,
  clearProjectStoreCache,
  findAdoptionCandidates,
  migrateLegacyStore,
  openProjectStore,
  resolveProjectStore,
  verifyStoreCopy,
} from '../src/scope/store-migration.js';
import type { GitCommandRunner } from '../src/scope/git.js';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-identity-'));
  home = path.join(root, 'cortex-home');
  clearProjectStoreCache();
});

afterEach(() => {
  clearProjectStoreCache();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* an open sqlite handle on Windows must not fail a passing test */
  }
});

const env = (): NodeJS.ProcessEnv => ({ CORTEX_HOME: home });

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A real repository with one commit — the ACs are about git's own answers. */
function initRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--initial-branch=main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Cortex Test'], dir);
  // Content must differ per repository, or two fixtures built in the same
  // second produce the *same* root-commit OID — identical tree, message, author
  // and timestamp hash to one commit. That silently made "an unrelated repo is
  // not an adoption candidate" pass or fail on clock luck.
  fs.writeFileSync(path.join(dir, 'README.md'), `# fixture ${name}\n`);
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

/** Seed a project-root store with real, countable content. */
function seedLegacyStore(projectDir: string, noteCount: number): string {
  const dbPath = path.join(projectDir, '.cortex.db');
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, projectDir);
  const store = new CortexStore(db);
  const session = store.createSession({ cwd: projectDir });
  for (let i = 0; i < noteCount; i++) {
    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      content: `decision number ${i} about src/index.ts`,
      subject: `subject-${i}`,
    });
  }
  db.close();
  return dbPath;
}

function countNotes(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

// ── AC #1: identity is a hash of the git-common-dir realpath ──────────

describe('AC #1 — store identity from the git common dir', () => {
  it('hashes the absolute realpath of `git rev-parse --git-common-dir`', () => {
    const repo = initRepo('repo');
    const identity = resolveStoreIdentity(repo, { env: env() });

    // Computed independently here rather than read back from the module, so a
    // change of hash input or algorithm has to be made in two places.
    // `--path-format=absolute` is load-bearing in the test too: plain
    // `--git-common-dir` answers `.git`, which resolves against the *test
    // runner's* cwd — this repo — and the assertion then compares cortex's own
    // store id against the fixture's.
    const commonDir = resolveRealPath(
      git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo),
    );
    const expected = crypto
      .createHash('sha256')
      .update(commonDir, 'utf8')
      .digest('hex')
      .slice(0, 16);

    expect(identity.degraded).toBe(false);
    expect(identity.storeId).toBe(expected);
    expect(identity.gitCommonDir).toBe(commonDir);
    expect(identity.dbPath).toBe(path.join(identity.storeDir, STORE_FILENAME));
  });

  it('resolves every worktree of a repository to the same store', () => {
    const repo = initRepo('repo');
    const worktree = path.join(root, 'wt');
    git(['worktree', 'add', '-b', 'feature', worktree], repo);

    // Pre-assert the precondition, so this cannot pass by the two paths being
    // accidentally equal.
    expect(fs.realpathSync(worktree)).not.toBe(fs.realpathSync(repo));
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree)).toBe('feature');

    const main = resolveStoreIdentity(repo, { env: env() });
    const linked = resolveStoreIdentity(worktree, { env: env() });

    expect(linked.storeId).toBe(main.storeId);
    // The full path, not just the hash: a label derived from the *worktree*
    // basename would give identical ids and different directories, which is a
    // different store with every hash assertion still green.
    expect(linked.storeDir).toBe(main.storeDir);
    expect(linked.dbPath).toBe(main.dbPath);
  });

  it('derives the directory label from the common dir, never the worktree', () => {
    expect(storeLabelFor(path.join('C:', 'code', 'myrepo', '.git'))).toBe('myrepo');
    expect(storeLabelFor(path.join('/srv', 'bare', 'myrepo.git'))).toBe('myrepo');
  });
});

// ── AC #2: separate clones are separate stores ────────────────────────

describe('AC #2 — two clones of one repository', () => {
  it('resolves to two distinct stores even though they share a root commit', () => {
    const origin = initRepo('origin');
    const cloneA = path.join(root, 'clone-a');
    const cloneB = path.join(root, 'clone-b');
    git(['clone', origin, cloneA], root);
    git(['clone', origin, cloneB], root);

    const a = resolveStoreIdentity(cloneA, { env: env() });
    const b = resolveStoreIdentity(cloneB, { env: env() });

    // The precondition that makes this test meaningful: the root commit — the
    // adoption anchor — is shared, so only the path-primary rule separates them.
    expect(a.readRootCommitOid()).toBe(b.readRootCommitOid());
    expect(a.readRootCommitOid()).not.toBeNull();

    expect(a.storeId).not.toBe(b.storeId);
    expect(a.dbPath).not.toBe(b.dbPath);
  });
});

// ── AC #3: migration by copy, verified, original retained ─────────────

describe('AC #3 — migrating a project-root database', () => {
  it('copies the store, verifies it, and leaves the original in place', () => {
    const repo = initRepo('repo');
    const legacy = seedLegacyStore(repo, 7);
    expect(countNotes(legacy)).toBe(7);

    const resolved = resolveProjectStore(repo, { env: env() });

    expect(resolved.migration.action).toBe('migrated');
    expect(resolved.migration.verified).toBe(true);
    expect(resolved.migration.sourcePath).toBe(legacy);

    // Reopened from disk, not read through the connection that wrote it.
    expect(countNotes(resolved.dbPath)).toBe(7);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(countNotes(legacy)).toBe(7);
  });

  it('carries content that lives only in the write-ahead log', () => {
    // The defect this whole mechanism exists to prevent. Measured with
    // `fs.copyFileSync` in its place: the copy opens as a database in which the
    // table does not exist, because every row was still in the -wal sidecar.
    const repo = initRepo('repo');
    const legacy = path.join(repo, '.cortex.db');
    const db = openDatabase(legacy);
    ensureCortexSchema(db, repo);
    const store = new CortexStore(db);
    const session = store.createSession({ cwd: repo });
    for (let i = 0; i < 200; i++) {
      store.insertNote({
        sessionId: session.id,
        kind: 'insight',
        content: `wal-resident insight ${i}`,
        subject: `wal-${i}`,
      });
    }
    // Deliberately NOT closed and NOT checkpointed: leave the WAL hot.
    const walSize = fs.statSync(`${legacy}-wal`).size;
    expect(walSize).toBeGreaterThan(0);

    // Take the naive copy FIRST, while the WAL is still hot. Copying after
    // `db.close()` proves nothing: closing checkpoints the WAL into the main
    // file, so `copyFileSync` would capture all 200 rows and this test would
    // congratulate the very implementation it exists to reject.
    const naive = path.join(root, 'naive.db');
    fs.copyFileSync(legacy, naive);
    let naiveNotes: number | string;
    try {
      naiveNotes = countNotes(naive);
    } catch (error) {
      naiveNotes = error instanceof Error ? error.message : String(error);
    }
    expect(naiveNotes).not.toBe(200);

    const resolved = resolveProjectStore(repo, { env: env() });
    db.close();

    expect(resolved.migration.action).toBe('migrated');
    expect(countNotes(resolved.dbPath)).toBe(200);
  });

  it('is idempotent: a second run neither re-copies nor changes the store', () => {
    const repo = initRepo('repo');
    seedLegacyStore(repo, 3);

    const first = resolveProjectStore(repo, { env: env() });
    expect(first.migration.action).toBe('migrated');
    const stat = fs.statSync(first.dbPath);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(first.dbPath)).digest('hex');

    clearProjectStoreCache();
    const second = resolveProjectStore(repo, { env: env() });

    expect(second.migration.action).toBe('destination-exists');
    expect(second.dbPath).toBe(first.dbPath);
    expect(fs.statSync(second.dbPath).mtimeMs).toBe(stat.mtimeMs);
    expect(
      crypto.createHash('sha256').update(fs.readFileSync(second.dbPath)).digest('hex'),
    ).toBe(digest);
  });

  it('leaves no temp file behind when verification fails', () => {
    const repo = initRepo('repo');
    seedLegacyStore(repo, 2);
    const identity = resolveStoreIdentity(repo, { env: env() });

    // A source that opens but cannot be vacuumed: truncated mid-file.
    const legacy = path.join(repo, '.cortex.db');
    const bytes = fs.readFileSync(legacy);
    fs.writeFileSync(legacy, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const outcome = migrateLegacyStore(identity);

    expect(outcome.action).toBe('failed');
    expect(outcome.originalRetained).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(identity.dbPath)).toBe(false);
    const leftovers = fs.existsSync(identity.storeDir)
      ? fs.readdirSync(identity.storeDir).filter(entry => entry.startsWith('.migrating-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('refuses to install a copy that fails verification', () => {
    // Verification's *verdict must be acted on*, not merely computed. SQLite
    // either copies faithfully or fails, so a rejecting verdict has to be
    // injected; what is under test is the wiring around it.
    const repo = initRepo('repo');
    const legacy = seedLegacyStore(repo, 6);
    const identity = resolveStoreIdentity(repo, { env: env() });

    const outcome = migrateLegacyStore(identity, {
      verify: () => ({ ok: false, reason: 'injected mismatch' }),
    });

    expect(outcome.action).toBe('failed');
    expect(outcome.reason).toBe('injected mismatch');
    // Nothing installed, nothing left half-done, and the original untouched.
    expect(fs.existsSync(identity.dbPath)).toBe(false);
    expect(fs.readdirSync(identity.storeDir)).toEqual([]);
    expect(countNotes(legacy)).toBe(6);
  });

  it('skips the copy entirely once a store exists, rather than re-reading the source', () => {
    const repo = initRepo('repo');
    seedLegacyStore(repo, 3);
    const identity = resolveStoreIdentity(repo, { env: env() });
    expect(migrateLegacyStore(identity).action).toBe('migrated');

    // Corrupt the source. The destination guard must short-circuit before
    // anything looks at it — so this still reports `destination-exists`. Were
    // the guard removed, the corrupt source would be re-examined and the answer
    // would change, which is what makes this an assertion rather than a
    // restatement of the previous test.
    fs.writeFileSync(path.join(repo, '.cortex.db'), 'no longer a database');

    expect(migrateLegacyStore(identity).action).toBe('destination-exists');
  });

  it('reports a row-count mismatch rather than trusting the copy', () => {
    const repo = initRepo('repo');
    const legacy = seedLegacyStore(repo, 4);
    const other = initRepo('other');
    const different = seedLegacyStore(other, 9);

    // Two valid databases whose contents disagree: verification's actual job.
    const verdict = verifyStoreCopy(legacy, different);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('row count differs');
  });

  it('ignores a project-root file that is not a database', () => {
    const repo = initRepo('repo');
    fs.writeFileSync(path.join(repo, '.cortex.db'), 'not a database at all');
    const identity = resolveStoreIdentity(repo, { env: env() });

    const outcome = migrateLegacyStore(identity);

    expect(outcome.action).toBe('none');
    expect(fs.existsSync(identity.dbPath)).toBe(false);
  });
});

// ── AC #4: adoption after a move or rename ────────────────────────────

describe('AC #4 — a repository that moved', () => {
  it('offers an orphaned store whose root commit matches and whose path is gone', () => {
    const original = initRepo('before');
    seedLegacyStore(original, 5);
    const first = openProjectStore(original, { env: env() });
    first.db.close();
    expect(first.migration.action).toBe('migrated');

    // Move the checkout: a new common dir means a new id and no store there.
    const moved = path.join(root, 'after');
    fs.renameSync(original, moved);
    clearProjectStoreCache();

    const identity = resolveStoreIdentity(moved, { env: env() });
    expect(identity.storeId).not.toBe(first.identity.storeId);
    expect(fs.existsSync(identity.dbPath)).toBe(false);

    const candidates = findAdoptionCandidates(identity);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dbPath).toBe(first.dbPath);
    expect(candidates[0]?.recordedPath).toBe(fs.realpathSync(moved).replace(/after$/, 'before'));
  });

  it('adopts on request, and stops offering once adopted', () => {
    const original = initRepo('before');
    seedLegacyStore(original, 5);
    const first = openProjectStore(original, { env: env() });
    first.db.close();
    const moved = path.join(root, 'after');
    fs.renameSync(original, moved);
    clearProjectStoreCache();

    const identity = resolveStoreIdentity(moved, { env: env() });
    const candidate = findAdoptionCandidates(identity)[0];
    expect(candidate).toBeDefined();

    const outcome = adoptStore(identity, candidate!);

    expect(outcome.action).toBe('adopted');
    expect(countNotes(identity.dbPath)).toBe(5);
    expect(fs.existsSync(first.dbPath)).toBe(false);

    // Assert the recorded path directly. Checking only that the candidate list
    // is now empty proves nothing: `findAdoptionCandidates` returns early once
    // a store exists at the computed path, so it would be empty even if the
    // dead path were still recorded — and the store would then re-orphan the
    // next time it moved.
    const adopted = new Database(identity.dbPath, { readonly: true });
    try {
      const recorded = adopted
        .prepare("SELECT value FROM meta WHERE key = 'root_path'")
        .get() as { value: string } | undefined;
      expect(recorded?.value).toBe(identity.projectRoot);
      expect(fs.existsSync(recorded?.value ?? '')).toBe(true);
    } finally {
      adopted.close();
    }

    expect(findAdoptionCandidates(identity)).toEqual([]);
  });

  it('does not offer a store whose recorded path still exists', () => {
    const alive = initRepo('alive');
    seedLegacyStore(alive, 2);
    openProjectStore(alive, { env: env() }).db.close();
    clearProjectStoreCache();

    // A *clone* is the case that matters: it shares the root commit, so the
    // anchor matches and only the "recorded path still exists" rule separates
    // them. Using an unrelated repository instead would pass on the anchor
    // check alone and prove nothing about this rule — which is exactly how the
    // first version of this test survived its mutation.
    const clone = path.join(root, 'clone');
    git(['clone', alive, clone], root);
    const identity = resolveStoreIdentity(clone, { env: env() });

    expect(identity.readRootCommitOid()).not.toBeNull();
    expect(identity.storeId).not.toBe(
      resolveStoreIdentity(alive, { env: env() }).storeId,
    );
    expect(fs.existsSync(alive)).toBe(true);

    // A fork must not inherit upstream's memory.
    expect(findAdoptionCandidates(identity)).toEqual([]);
  });

  it('does not offer a store whose root commit differs', () => {
    const first = initRepo('first');
    seedLegacyStore(first, 2);
    openProjectStore(first, { env: env() }).db.close();
    const gone = path.join(root, 'first-moved');
    fs.renameSync(first, gone);
    fs.rmSync(gone, { recursive: true, force: true });
    clearProjectStoreCache();

    // An unrelated repository: recorded path is gone, but the anchor disagrees.
    const unrelated = initRepo('unrelated');
    const identity = resolveStoreIdentity(unrelated, { env: env() });
    expect(findAdoptionCandidates(identity)).toEqual([]);
  });
});

// ── AC #5: no git ─────────────────────────────────────────────────────

describe('AC #5 — a directory that is not a repository', () => {
  it('falls back to the working directory realpath and reports the degradation', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);

    const identity = resolveStoreIdentity(plain, { env: env() });

    expect(identity.degraded).toBe(true);
    expect(identity.degradedReason).toContain('not a git repository');
    expect(identity.gitCommonDir).toBeNull();
    expect(identity.storeId).toBe(computeStoreId(resolveRealPath(plain)));
    expect(identity.readRootCommitOid()).toBeNull();
  });

  it('is still deterministic, so a non-git project keeps one store', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const a = resolveStoreIdentity(plain, { env: env() });
    const b = resolveStoreIdentity(plain, { env: env() });
    expect(a.storeId).toBe(b.storeId);
  });
});

// ── The realpath rule, which `path.resolve` does not satisfy ──────────

describe('identity uses a realpath, not path.resolve', () => {
  it('canonicalises a path that differs only by drive-letter case', () => {
    const target = root;
    const swapped = /^[a-zA-Z]:/.test(target)
      ? target[0]!.toLowerCase() === target[0]
        ? target[0]!.toUpperCase() + target.slice(1)
        : target[0]!.toLowerCase() + target.slice(1)
      : target;

    if (swapped === target) {
      // POSIX has no drive letters; the symlink case below covers it there.
      expect(resolveRealPath(target)).toBe(fs.realpathSync.native(target));
      return;
    }

    // The precondition: `path.resolve` really does keep the wrong case, which
    // is what would have split one repository into two stores.
    expect(path.resolve(swapped)).not.toBe(path.resolve(target));
    expect(resolveRealPath(swapped)).toBe(resolveRealPath(target));
    expect(computeStoreId(resolveRealPath(swapped))).toBe(
      computeStoreId(resolveRealPath(target)),
    );
  });

  it('resolves a symlinked checkout to its target', () => {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch {
      return; // unprivileged host; the drive-case test still pins the rule
    }

    expect(path.resolve(link)).not.toBe(path.resolve(real));
    expect(resolveRealPath(link)).toBe(resolveRealPath(real));
  });

  it('falls back to an absolute path when the target does not exist', () => {
    const missing = path.join(root, 'no-such-dir');
    expect(resolveRealPath(missing)).toBe(path.resolve(missing));
  });
});

// ── The repair anchor ─────────────────────────────────────────────────

describe('root-commit anchor', () => {
  it('sorts and joins every root commit, so merged histories are stable', () => {
    const calls: string[][] = [];
    const runGit: GitCommandRunner = args => {
      calls.push(args);
      return 'ccc1111\nAAA2222\nbbb3333';
    };
    // Sorted, not traversal order: `git rev-list` returns roots in the order it
    // walks them, so taking them as given is not an identity.
    expect(readRootCommitOid('/anywhere', runGit)).toBe('AAA2222,bbb3333,ccc1111');
    expect(calls[0]).toEqual(['rev-list', '--max-parents=0', 'HEAD']);
  });

  it('is null for a repository with no commits', () => {
    const dir = path.join(root, 'empty');
    fs.mkdirSync(dir);
    git(['init', '--initial-branch=main'], dir);
    const identity = resolveStoreIdentity(dir, { env: env() });
    expect(identity.degraded).toBe(false);
    expect(identity.readRootCommitOid()).toBeNull();
    // With no anchor there is nothing to match on, so adoption is unavailable
    // rather than wrong.
    expect(findAdoptionCandidates(identity)).toEqual([]);
  });

  it('ignores lines that are not object ids', () => {
    const runGit: GitCommandRunner = () => 'warning: something\n';
    expect(readRootCommitOid('/anywhere', runGit)).toBeNull();
  });

  it('resolves at most once, so ambient opens do not pay for git repeatedly', () => {
    let calls = 0;
    const repo = initRepo('repo');
    const runGit: GitCommandRunner = (args, cwd) => {
      if (args[0] === 'rev-list') calls++;
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    };
    const identity = resolveStoreIdentity(repo, { env: env(), runGit });
    identity.readRootCommitOid();
    identity.readRootCommitOid();
    identity.readRootCommitOid();
    expect(calls).toBe(1);
  });
});

// ── Home resolution ───────────────────────────────────────────────────

describe('CORTEX_HOME', () => {
  it('overrides the default when set', () => {
    expect(cortexHome({ CORTEX_HOME: home })).toBe(path.resolve(home));
  });

  it('falls back to ~/.cortex when unset or blank', () => {
    expect(cortexHome({})).toBe(path.join(os.homedir(), '.cortex'));
    expect(cortexHome({ CORTEX_HOME: '   ' })).toBe(path.join(os.homedir(), '.cortex'));
  });
});

describe('directory labels', () => {
  it('strips characters that are unsafe or hidden, and never yields empty', () => {
    expect(sanitizeLabel('my repo!')).toBe('my-repo');
    expect(sanitizeLabel('.hidden')).toBe('hidden');
    expect(sanitizeLabel('trailing.')).toBe('trailing');
    expect(sanitizeLabel('///')).toBe('project');
    expect(sanitizeLabel('a'.repeat(80))).toHaveLength(32);
  });
});
