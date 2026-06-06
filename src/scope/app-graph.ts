import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexStore, ParsedCurrentAppGraph } from '../db/store.js';
import { detectGitScope, type GitScopeIdentity } from './git.js';
import type { ScopeType } from './keys.js';

const IGNORED_DIRS = new Set([
  '.cache',
  '.cortex',
  '.git',
  'coverage',
  'dist',
  'node_modules',
]);

export interface RefreshCurrentAppGraphOptions {
  scopeKey?: string;
  scopeType?: ScopeType;
  gitRoot?: string | null;
  worktreePath?: string | null;
  branchRef?: string | null;
  headOid?: string | null;
  files?: string[];
}

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function listGitFiles(worktreePath: string): string[] | null {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['-C', worktreePath, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output
      .split(/\r?\n/)
      .map(line => normalizeFilePath(line.trim()))
      .filter(Boolean)
      .filter(file => {
        try {
          return fs.statSync(path.join(worktreePath, file)).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return null;
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [''];

  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(path.join(rel, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(normalizeFilePath(path.join(rel, entry.name)));
      }
    }
  }

  return files.sort();
}

function resolveScope(cwd: string, opts: RefreshCurrentAppGraphOptions): GitScopeIdentity {
  if (opts.scopeKey) {
    const worktreePath = path.resolve(opts.worktreePath ?? cwd);
    return {
      gitRoot: opts.gitRoot ?? null,
      worktreePath,
      branchRef: opts.branchRef ?? null,
      headOid: opts.headOid ?? null,
      scopeType: opts.scopeType ?? 'project',
      scopeKey: opts.scopeKey,
      scopeLabel: opts.branchRef ?? worktreePath,
    };
  }

  return detectGitScope(cwd);
}

export function listCurrentAppFiles(worktreePath: string): string[] {
  const gitFiles = listGitFiles(worktreePath);
  const files = gitFiles ?? walkFiles(worktreePath);
  return Array.from(new Set(files.map(normalizeFilePath))).sort();
}

export function refreshCurrentAppGraph(
  store: CortexStore,
  cwd: string,
  opts: RefreshCurrentAppGraphOptions = {},
): ParsedCurrentAppGraph {
  const scope = resolveScope(cwd, opts);
  const worktreePath = path.resolve(scope.worktreePath);
  const files = opts.files?.map(normalizeFilePath) ?? listCurrentAppFiles(worktreePath);

  return store.upsertCurrentAppGraph({
    scopeKey: scope.scopeKey,
    scopeType: scope.scopeType,
    gitRoot: scope.gitRoot,
    worktreePath,
    branchRef: scope.branchRef,
    headOid: scope.headOid,
    files,
  });
}
