import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  defaultGitCommandRunner,
  readGitPath,
  type GitCommandRunner,
} from './git.js';

/**
 * Store identity (FR-24, AD-10).
 *
 * One store per repository, addressed by a hash of the absolute realpath of
 * `git rev-parse --git-common-dir`. Every worktree of a repository resolves to
 * the same store — worktree partitioning is already handled inside the store by
 * `scope_key`, not by file layout — while two clones resolve to two stores.
 *
 * The realpath is not decoration. Measured on win32: `path.resolve` preserves
 * `c:\repo` as typed while the canonical path is `C:\repo`, and it resolves a
 * junction to the link rather than its target. Either one splits a single
 * repository across two stores, silently, with memory divided between them.
 */

/** Hex characters kept from the sha256. Matches `hookTemplateDigest`. */
export const STORE_ID_LENGTH = 16;

/** Directory under the user's home when `CORTEX_HOME` is unset. */
export const DEFAULT_HOME_DIR_NAME = '.cortex';

/** Store filename inside its per-project directory. */
export const STORE_FILENAME = 'cortex.db';

/** The pre-relocation filename, still read for migration and still ignored by git. */
export const LEGACY_STORE_FILENAME = '.cortex.db';

export interface StoreIdentity {
  /** Hash of the absolute realpath of the git common dir, or of cwd when degraded. */
  storeId: string;
  /** `<home>/projects/<label>-<storeId>`. */
  storeDir: string;
  /** The database this project resolves to. */
  dbPath: string;
  /** Resolved Cortex home. */
  home: string;
  /** Realpath of the working tree (or of `startDir` without git). */
  projectRoot: string;
  /** Realpath of `git rev-parse --git-common-dir`; null without git. */
  gitCommonDir: string | null;
  /**
   * AD-10's repair anchor; null for an empty repo or without git.
   *
   * A memoized thunk rather than a field, because resolving it costs a git
   * subprocess (~100 ms on win32) and almost nothing needs it: the meta write
   * happens once per store and the adoption scan only runs when a repository
   * has no store at all. Every ambient open would otherwise pay for it.
   */
  readRootCommitOid(): string | null;
  /** True when identity fell back to the working directory (AC #5). */
  degraded: boolean;
  /** Human-readable reason, present only when `degraded`. */
  degradedReason: string | null;
  /** Pre-relocation database locations to consider migrating, most likely first. */
  legacyDbPaths: string[];
}

/**
 * Absolute realpath, falling back when the path cannot be resolved.
 *
 * `realpathSync.native` canonicalises drive-letter case and 8.3 short names on
 * win32 and resolves symlinks everywhere; `path.resolve` does neither.
 */
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  }
}

/**
 * Cortex home: `CORTEX_HOME` when set and non-empty, else `~/.cortex`.
 *
 * Follows `CORTEX_SPOOL_DIR`'s existing shape. This override is also the test
 * hermeticity boundary — a test that does not set it writes into the developer's
 * real memory store, which is the incident story 2.4 recorded.
 */
export function cortexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CORTEX_HOME'];
  const trimmed = override?.trim() ?? '';
  if (trimmed.length === 0) {
    return path.join(os.homedir(), DEFAULT_HOME_DIR_NAME);
  }
  // Use the *trimmed* value. Testing `override.trim()` and then resolving
  // `override` meant a trailing newline or a stray space from a shell export
  // became a relative path segment: `CORTEX_HOME="  /home  "` resolved under
  // cwd, produced a path with an embedded drive colon, and `cortex store`
  // printed it and exited 0 as though healthy.
  //
  // A relative value resolves against the user's home, never cwd. Hooks, the
  // MCP server and manual CLI runs all have different working directories, so
  // cwd-relative resolution silently fans one repository's memory across
  // several homes — the exact fragmentation this addressing scheme exists to
  // prevent.
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(os.homedir(), trimmed);
}

/**
 * Cosmetic directory prefix so `~/.cortex/projects/` is browsable.
 *
 * Never parsed and never used for lookup: the hash is the only authoritative
 * part, and adoption reads each candidate store's `meta` rather than its name.
 */
export function sanitizeLabel(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 32)
    .replace(/[-._]+$/, '');
  return cleaned.length > 0 ? cleaned : 'project';
}

/** sha256 of the identifying path, truncated to `STORE_ID_LENGTH`. */
export function computeStoreId(identifyingPath: string): string {
  return crypto
    .createHash('sha256')
    .update(identifyingPath, 'utf8')
    .digest('hex')
    .slice(0, STORE_ID_LENGTH);
}

/**
 * The label must derive from the same input as the hash.
 *
 * Deriving it from the *worktree* basename would give two worktrees of one
 * repository the same `storeId` but different directory names — and therefore
 * different stores, breaking AC #1 while every hash assertion still passed.
 */
export function storeLabelFor(gitCommonDir: string): string {
  const base = path.basename(gitCommonDir);
  if (base === '.git') {
    return sanitizeLabel(path.basename(path.dirname(gitCommonDir)));
  }
  // A bare repository, or `.git` as a file pointing elsewhere: `foo.git` -> `foo`.
  return sanitizeLabel(base.replace(/\.git$/, ''));
}

/**
 * Root-commit OIDs, sorted and joined.
 *
 * A repository with merged histories or grafts has more than one root commit,
 * and `git rev-list --max-parents=0 HEAD` returns all of them in traversal
 * order — so taking the first is order-dependent and not an identity. An empty
 * repository has no HEAD and no anchor; adoption is simply unavailable there.
 */
export function readRootCommitOid(
  cwd: string,
  runGit: GitCommandRunner,
): string | null {
  const raw = runGit(['rev-list', '--max-parents=0', 'HEAD'], cwd);
  if (!raw) {
    return null;
  }
  const oids = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[0-9a-f]{7,64}$/i.test(line))
    .sort();
  return oids.length > 0 ? oids.join(',') : null;
}

interface LocatedRepository {
  worktreePath: string;
  gitCommonDir: string;
}

/**
 * Both paths from one `git rev-parse`.
 *
 * Measured on this machine: one combined call costs ~64 ms against ~162 ms for
 * three separate ones. Process spawn dominates on win32, so the count of calls
 * is the thing to minimise, not the work each one does.
 */
function readWorktreeAndCommonDir(
  cwd: string,
  runGit: GitCommandRunner,
): LocatedRepository | null {
  const absolute = runGit(
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    cwd,
  );
  if (absolute) {
    const lines = absolute.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      return {
        worktreePath: path.resolve(lines[0] as string),
        gitCommonDir: path.resolve(lines[1] as string),
      };
    }
  }

  // `--path-format` landed in git 2.31. Older git still answers, relatively.
  const relative = runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd);
  if (relative) {
    const lines = relative.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      return {
        worktreePath: path.resolve(cwd, lines[0] as string),
        gitCommonDir: path.resolve(cwd, lines[1] as string),
      };
    }
  }

  // The combined call fails as a unit, and `--show-toplevel` is the half that
  // fails in a **bare** repository and inside a `.git` directory — so both were
  // reported as "not a git repository", with a fix telling the user to run from
  // inside one. Ask for the common dir alone before believing that.
  const commonDirOnly = readGitPath(cwd, ['--git-common-dir'], runGit);
  if (commonDirOnly) {
    // No worktree to speak of; the caller falls back to cwd for `projectRoot`.
    return { worktreePath: cwd, gitCommonDir: commonDirOnly };
  }

  return null;
}

export interface ResolveStoreIdentityOptions {
  env?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
}

/**
 * Resolve where this project's store lives.
 *
 * Never throws and never touches the filesystem beyond realpath resolution:
 * ambient callers run inside hooks, where AD-12 requires that any failure
 * degrade to silence rather than surface.
 */
export function resolveStoreIdentity(
  startDir: string,
  options: ResolveStoreIdentityOptions = {},
): StoreIdentity {
  const env = options.env ?? process.env;
  const runGit = options.runGit ?? defaultGitCommandRunner;
  const home = cortexHome(env);
  const cwd = resolveRealPath(startDir);

  let gitCommonDir: string | null = null;
  let worktreePath: string | null = null;

  try {
    // Retried once, because the failure is not free. `defaultGitCommandRunner`
    // cannot distinguish "not a repository" from "git could not be spawned
    // this instant" — both surface as null — and on win32 a transient spawn
    // failure under load is real. Degrading is correct for a directory that
    // genuinely has no git (AC #5), but degrading *inside a repository* means
    // computing a cwd-derived id and opening a different store, so memory
    // written during that window is stranded in one nothing will look at
    // again. One retry costs a single extra spawn, only on the path that has
    // already failed, and only once per process thanks to the memo.
    const located =
      readWorktreeAndCommonDir(cwd, runGit) ?? readWorktreeAndCommonDir(cwd, runGit);
    if (located) {
      worktreePath = resolveRealPath(located.worktreePath);
      gitCommonDir = resolveRealPath(located.gitCommonDir);
    }
  } catch {
    // Absent or broken git degrades to the working-directory fallback below.
  }

  const degraded = gitCommonDir === null;
  const identifyingPath = gitCommonDir ?? cwd;
  const storeId = computeStoreId(identifyingPath);
  const label = gitCommonDir
    ? storeLabelFor(gitCommonDir)
    : sanitizeLabel(path.basename(cwd));

  const storeDir = path.join(home, 'projects', `${label}-${storeId}`);
  const projectRoot = worktreePath ?? cwd;

  // Ordered most-authoritative first, and the order is load-bearing.
  //
  // The **main** worktree comes first because every worktree of a repository
  // now resolves to one store, while the pre-relocation build gave each its own
  // `.cortex.db` — so a first post-upgrade command run inside a *linked*
  // worktree would migrate that worktree's small store and permanently shadow
  // the main checkout's real one (measured: 60 notes replaced by 0, not
  // recovered by later running from main).
  //
  // The worktree root then precedes `cwd` for the same reason: the old build
  // created `<repo>/src/.cortex.db` whenever it ran from a subdirectory, and
  // cwd-first let that stray file win over the real store at the root.
  const mainWorktreePath =
    gitCommonDir !== null && path.basename(gitCommonDir) === '.git'
      ? path.dirname(gitCommonDir)
      : null;

  const legacyDbPaths: string[] = [];
  for (const dir of [mainWorktreePath, projectRoot, cwd]) {
    if (dir === null) {
      continue;
    }
    const candidate = path.join(dir, LEGACY_STORE_FILENAME);
    if (!legacyDbPaths.includes(candidate)) {
      legacyDbPaths.push(candidate);
    }
  }

  let rootCommitResolved = false;
  let rootCommitOid: string | null = null;

  return {
    storeId,
    storeDir,
    dbPath: path.join(storeDir, STORE_FILENAME),
    home,
    projectRoot,
    gitCommonDir,
    readRootCommitOid(): string | null {
      if (rootCommitResolved) {
        return rootCommitOid;
      }
      rootCommitResolved = true;
      try {
        rootCommitOid = gitCommonDir === null ? null : readRootCommitOid(cwd, runGit);
      } catch {
        // The `rev-parse` call above is guarded and this one was not, so an
        // injected or misbehaving runner threw straight out of `runDoctor` and
        // took the whole report with it — the failure mode every other
        // user-controlled read in that command is guarded against.
        rootCommitOid = null;
      }
      return rootCommitOid;
    },
    degraded,
    degradedReason: degraded
      ? `not a git repository; identity falls back to the working directory realpath (${cwd})`
      : null,
    legacyDbPaths,
  };
}
