import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import {
  deriveBranchScopeKey,
  deriveDetachedScopeKey,
  deriveProjectScopeKey,
  formatScopeLabel,
  type ScopeType,
} from './keys.js';

export interface GitScopeIdentity {
  gitRoot: string | null;
  worktreePath: string;
  branchRef: string | null;
  headOid: string | null;
  scopeType: ScopeType;
  scopeKey: string;
  scopeLabel: string;
}

export type GitCommandRunner = (args: string[], cwd: string) => string | null;

function defaultGitCommandRunner(args: string[], cwd: string): string | null {
  try {
    const raw = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readGitPath(
  cwd: string,
  args: string[],
  runGit: GitCommandRunner,
): string | null {
  const absolute = runGit(['rev-parse', '--path-format=absolute', ...args], cwd);
  if (absolute) {
    return path.resolve(absolute);
  }

  const fallback = runGit(['rev-parse', ...args], cwd);
  return fallback ? path.resolve(cwd, fallback) : null;
}

export function detectGitScope(
  startDir: string,
  runGit: GitCommandRunner = defaultGitCommandRunner,
): GitScopeIdentity {
  const cwd = path.resolve(startDir);
  const worktreePath = readGitPath(cwd, ['--show-toplevel'], runGit);

  if (!worktreePath) {
    return {
      gitRoot: null,
      worktreePath: cwd,
      branchRef: null,
      headOid: null,
      scopeType: 'project',
      scopeKey: deriveProjectScopeKey(cwd),
      scopeLabel: formatScopeLabel({
        scopeType: 'project',
        worktreePath: cwd,
      }),
    };
  }

  const gitRoot = readGitPath(cwd, ['--git-common-dir'], runGit) ?? worktreePath;
  const branchRef = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const headOid = runGit(['rev-parse', 'HEAD'], cwd);

  let scopeType: ScopeType = 'project';
  let scopeKey = deriveProjectScopeKey(worktreePath);

  if (branchRef) {
    scopeType = 'branch';
    scopeKey = deriveBranchScopeKey(gitRoot, worktreePath, branchRef);
  } else if (headOid) {
    scopeType = 'detached-head';
    scopeKey = deriveDetachedScopeKey(gitRoot, worktreePath, headOid);
  }

  return {
    gitRoot,
    worktreePath,
    branchRef,
    headOid,
    scopeType,
    scopeKey,
    scopeLabel: formatScopeLabel({
      scopeType,
      branchRef,
      headOid,
      worktreePath,
    }),
  };
}
