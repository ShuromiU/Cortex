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
  const resolved = path.resolve(rawPath).replace(/\\/g, '/');
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return caseInsensitive ? resolved.toLowerCase() : resolved;
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
