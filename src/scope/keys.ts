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
