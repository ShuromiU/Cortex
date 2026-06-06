import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { extractMemoryReferences } from '../src/memory/references.js';
import { refreshCurrentAppGraph } from '../src/scope/app-graph.js';
import { validateMemoryReferences } from '../src/query/reference-validation.js';

function createTestDb(rootPath: string): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, rootPath);
  return db;
}

describe('memory references', () => {
  it('extracts repo-relative and absolute local file references from memory text', () => {
    const refs = extractMemoryReferences(
      'Plan at C:\\Users\\dev\\.claude\\plans\\sunny-mixing-shannon.md touched components/board/ExpandedTaskCard.tsx and src/query/state.ts.',
    );

    expect(refs.map(ref => ref.normalizedPath)).toEqual([
      'C:/Users/dev/.claude/plans/sunny-mixing-shannon.md',
      'components/board/ExpandedTaskCard.tsx',
      'src/query/state.ts',
    ]);
  });

  it('extracts Windows paths with spaces and strips line suffixes', () => {
    const refs = extractMemoryReferences(
      'Changed C:\\Claude Code\\cortex\\src\\query\\state.ts:12 and C:\\repo\\src\\plain.ts:8.',
    );

    expect(refs.map(ref => ref.normalizedPath)).toEqual([
      'C:/Claude Code/cortex/src/query/state.ts',
      'C:/repo/src/plain.ts',
    ]);
  });

  it('refreshes a current app graph from the current checkout without ignored build folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-graph-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alive.ts'), 'export const alive = true;\n');
    fs.writeFileSync(path.join(root, '.cortex.db'), 'not app code\n');
    fs.writeFileSync(path.join(root, '.cortex.db-wal'), 'not app code\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'ignored.ts'), 'ignored\n');
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });

    const graph = refreshCurrentAppGraph(store, root, {
      scopeKey: session.scope_key!,
      scopeType: 'project',
      worktreePath: root,
    });

    expect(graph.files).toContain('src/alive.ts');
    expect(graph.files).not.toContain('.cortex.db');
    expect(graph.files).not.toContain('.cortex.db-wal');
    expect(graph.files).not.toContain('node_modules/pkg/ignored.ts');
    expect(graph.file_count).toBe(1);
  });

  it('does not report tracked files deleted from the working tree as current', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-git-delete-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'deleted.ts'), 'export const gone = true;\n');
    fs.writeFileSync(path.join(root, 'src', 'alive.ts'), 'export const alive = true;\n');
    childProcess.execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    childProcess.execFileSync('git', ['add', '.'], { cwd: root });
    childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    fs.unlinkSync(path.join(root, 'src', 'deleted.ts'));
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });

    const graph = refreshCurrentAppGraph(store, root, {
      scopeKey: session.scope_key!,
      scopeType: 'project',
      worktreePath: root,
    });

    expect(graph.files).toContain('src/alive.ts');
    expect(graph.files).not.toContain('src/deleted.ts');
  });

  it('marks missing memory references against the current app graph', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-refs-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alive.ts'), 'export const alive = true;\n');
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    store.upsertCurrentAppGraph({
      scopeKey: session.scope_key!,
      scopeType: 'project',
      worktreePath: root,
      files: ['src/alive.ts'],
    });
    const item = store.upsertMemoryItem({
      id: 'memory-with-file-refs',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-with-file-refs',
      subject: 'files',
      text: 'decision: Use src/alive.ts and remove src/missing.ts.',
      state: 'warm',
      importance: 1,
    });

    const validation = validateMemoryReferences(store, item);

    expect(validation.references.map(ref => [ref.normalized_path, ref.status])).toEqual([
      ['src/alive.ts', 'exists'],
      ['src/missing.ts', 'missing'],
    ]);
    expect(validation.stale).toBe(true);
    expect(validation.missing).toBe(1);
  });
});
