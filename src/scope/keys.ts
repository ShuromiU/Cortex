import * as path from 'node:path';

export type ScopeType = 'project' | 'branch' | 'detached-head';

export interface ScopeDescriptor {
  scopeType: ScopeType;
  branchRef?: string | null;
  headOid?: string | null;
  worktreePath?: string | null;
}

export function normalizeScopePath(rawPath: string): string {
  return path
    .resolve(rawPath)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * The key form of a *file* path, for the read ledger's `(scope_key, path)` key.
 *
 * Deliberately not `normalizeScopePath`, which lowercases unconditionally.
 * That is right for a repository root — the odds of two roots differing only by
 * case are negligible — but wrong for arbitrary source files, where `Makefile`
 * and `makefile` genuinely coexist on a case-sensitive filesystem and folding
 * them would merge two files into one ledger row. Case is folded where the
 * filesystem is case-insensitive: win32, and **darwin**, whose APFS/HFS+
 * volumes are case-insensitive by default — omitting darwin would leave macOS
 * with the duplicate-row bug this function exists to prevent.
 *
 * Known residual: this is `path.resolve`, not `realpath`. A symlink or a
 * junction still produces two keys for one file. Resolving links would mean a
 * syscall per read on the flush path and would fail for a path that no longer
 * exists, so it is deliberately not done here — the same trade `normalizeScopePath`
 * makes, and unlike store identity (Story 2.5) where realpath is mandatory
 * because the answer decides which database is opened.
 *
 * Normalizing at all is not cosmetic: `path` is both the primary key and the
 * argument handed to the filesystem. Measured before this existed,
 * `C:/x/a.ts`, `C:\x\a.ts` and `c:\x\a.ts` produced three rows for one file,
 * and a *relative* key was worse — the key was the literal string while the
 * bytes came from the flushing process's cwd, so one key described different
 * files. Story 3.3 compares by this key, so a path resolved differently at
 * compare time would report "not read" for a file that was read.
 */
export function normalizeFilePathKey(rawPath: string): string {
  // Separators are normalized BEFORE `path.resolve`, never after, and the
  // ordering is the platform contract rather than a style choice.
  // `path.resolve` is the only platform-DEPENDENT step in this function: on
  // win32 it splits on a backslash, on POSIX a backslash is an ordinary
  // filename byte. Resolving first and stripping backslashes afterwards
  // therefore made an absolute backslashed path resolve as a *relative* name
  // off-Windows and come back anchored to `process.cwd()`. Measured:
  // `\p\src\a.ts` under root `/p` keyed `<cwd>//p/src/a.ts` instead of
  // `src/a.ts`, so `sessionEditedPathAfter`'s join silently missed and AC #4's
  // `edited-by-you-since` was unreachable on every non-win32 host while the
  // reference platform stayed green. A cwd-dependent key is also the exact
  // thing docs/invariants.md forbids: the three transports run from three
  // different directories, so one file would be written and looked up under
  // two keys.
  //
  // Backslash-as-separator is deliberately platform-INDEPENDENT here.
  // `toScopeRelativeKey`'s guard, `normalizeRelativeKey`, `normalizeScopePath`,
  // `isAbsoluteFileKey` (which accepts a Windows drive on any platform) and
  // `resolveOnDiskPath` all already treat it that way everywhere — and the
  // guard in particular decides absolute-vs-relative from the
  // backslash-normalized string, so this line deciding otherwise put the branch
  // choice and the branch body on two different platform rules. The trailing
  // replace stays: on win32 `path.resolve` RETURNS backslashes.
  const resolved = path.resolve(rawPath.replace(/\\/g, '/')).replace(/\\/g, '/');
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/**
 * The stored form of a read-ledger path: relative to the scope root when the
 * file lives under it, absolute otherwise.
 *
 * The repository prefix is exactly what is redundant with `scope_key`, and
 * carrying it twice is what breached Story 3.1's AC #5 — 417.8 bytes/file for a
 * 135-character absolute path against a 400-byte ceiling. Stripping it also
 * shrinks the flat index the hot path greps on every read.
 *
 * The two forms stay distinguishable without a flag: a relative key never
 * starts with `/` and never carries a `<drive>:` prefix, which is asserted by
 * test rather than assumed. A file outside the scope root (a system header, a
 * file in a sibling checkout) keeps its absolute key and is still correct —
 * just larger, which is the right trade for the rare case.
 */
export function toScopeRelativeKey(rawPath: string, scopeRoot: string | null | undefined): string {
  // An input that is ALREADY relative is already a stored key, and must not be
  // resolved: `path.resolve` would anchor it to `process.cwd()`, which is
  // whatever directory the flush, CLI or MCP server happens to run in. Measured
  // — re-running the migration turned `src/kept.ts` into
  // `c:/claude code/cortex/src/kept.ts`, silently relocating every key to the
  // process's cwd and orphaning the rows it had just repaired. Normalize its
  // separators and case only.
  if (!isAbsoluteFileKey(rawPath.replace(/\\/g, '/'))) {
    return normalizeRelativeKey(rawPath);
  }

  const key = normalizeFilePathKey(rawPath);
  if (!scopeRoot) {
    return key;
  }
  const root = normalizeFilePathKey(scopeRoot).replace(/\/+$/, '');
  if (root.length === 0) {
    return key;
  }
  // Boundary-aware: `/repo-two/a.ts` must not match a root of `/repo`, which a
  // bare `startsWith` would accept and then slice into a corrupt key.
  if (key === root) {
    return key;
  }
  if (!key.startsWith(`${root}/`)) {
    return key;
  }
  const relative = key.slice(root.length + 1);
  // Defensive: an empty result would key every row identically.
  return relative.length > 0 ? relative : key;
}

/** True when a stored key is already absolute (POSIX root or a Windows drive). */
export function isAbsoluteFileKey(key: string): boolean {
  return key.startsWith('/') || /^[a-z]:\//i.test(key);
}

/**
 * Normalize a key that is already scope-relative, without resolving it against
 * the current working directory — see `toScopeRelativeKey` for why that matters.
 */
function normalizeRelativeKey(rawPath: string): string {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');

  // Collapse `.` and `..` the way the absolute branch does via `path.resolve`.
  // Without this, `src/./a.ts` and `src/../src/a.ts` each became their own key
  // for a file the absolute branch stores once as `src/a.ts` — one file, three
  // ledger rows. Done textually rather than with `path.normalize` so the result
  // stays POSIX-separated on win32 and never touches the filesystem.
  const segments: string[] = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  // An empty result would key every such row identically — the same guard the
  // absolute branch already carries. `''`, `'.'` and `'./'` all mean "the scope
  // root itself" and collapse to one non-empty sentinel rather than to `''`,
  // which would be indistinguishable from a missing key.
  const joined = segments.join('/');
  const result = joined.length > 0 ? joined : '.';
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return caseInsensitive ? result.toLowerCase() : result;
}

export function deriveProjectScopeKey(rootPath: string): string {
  return `project:${normalizeScopePath(rootPath)}`;
}

export function deriveBranchScopeKey(
  gitRoot: string,
  worktreePath: string,
  branchRef: string,
): string {
  return `branch:${normalizeScopePath(gitRoot)}:${normalizeScopePath(worktreePath)}:${branchRef}`;
}

export function deriveDetachedScopeKey(
  gitRoot: string,
  worktreePath: string,
  headOid: string,
): string {
  return `detached:${normalizeScopePath(gitRoot)}:${normalizeScopePath(worktreePath)}:${headOid}`;
}

export function formatScopeLabel(scope: ScopeDescriptor): string {
  if (scope.scopeType === 'branch' && scope.branchRef) {
    return scope.branchRef;
  }

  if (scope.scopeType === 'detached-head' && scope.headOid) {
    return `detached@${scope.headOid.slice(0, 7)}`;
  }

  if (scope.worktreePath) {
    return path.basename(scope.worktreePath);
  }

  return 'project';
}
