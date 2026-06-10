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

function shouldIncludeFile(file: string): boolean {
  const base = path.basename(file);
  return ![
    '.cortex.db',
    '.cortex.db-shm',
    '.cortex.db-wal',
    '.cortex.db-journal',
  ].includes(base);
}

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
      .filter(shouldIncludeFile)
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
        const file = normalizeFilePath(path.join(rel, entry.name));
        if (shouldIncludeFile(file)) {
          files.push(file);
        }
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

/** Parse `git diff --name-status -M` output for R-status (rename) rows. */
export function detectGitRenames(
  worktreePath: string,
  fromOid: string,
  toOid: string,
): Array<{ oldPath: string; newPath: string }> {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['-C', worktreePath, 'diff', '--name-status', '-M70', fromOid, toOid],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const renames: Array<{ oldPath: string; newPath: string }> = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith('R')) {
        continue;
      }
      const parts = line.split('\t');
      if (parts.length < 3) {
        continue;
      }
      const oldPath = normalizeFilePath(parts[1]!.trim());
      const newPath = normalizeFilePath(parts[2]!.trim());
      if (oldPath && newPath && oldPath !== newPath) {
        renames.push({ oldPath, newPath });
      }
    }
    return renames;
  } catch {
    return [];
  }
}

function recordRenamesOnHeadChange(
  store: CortexStore,
  scopeKey: string,
  worktreePath: string,
  previousHeadOid: string | null | undefined,
  nextHeadOid: string | null | undefined,
): void {
  if (!previousHeadOid || !nextHeadOid || previousHeadOid === nextHeadOid) {
    return;
  }

  const renames = detectGitRenames(worktreePath, previousHeadOid, nextHeadOid);
  if (renames.length > 0) {
    store.insertFileRenames({ scopeKey, renames, headOid: nextHeadOid });
  }
}

export function refreshCurrentAppGraph(
  store: CortexStore,
  cwd: string,
  opts: RefreshCurrentAppGraphOptions = {},
): ParsedCurrentAppGraph {
  const scope = resolveScope(cwd, opts);
  const worktreePath = path.resolve(scope.worktreePath);
  const files = opts.files?.map(normalizeFilePath) ?? listCurrentAppFiles(worktreePath);

  const previous = store.getCurrentAppGraph(scope.scopeKey);
  try {
    recordRenamesOnHeadChange(store, scope.scopeKey, worktreePath, previous?.head_oid, scope.headOid);
  } catch {
    // Rename tracking is best-effort; never block the graph refresh.
  }

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
