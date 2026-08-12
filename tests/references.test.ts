import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, ensureCortexSchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { extractMemoryReferences } from '../src/memory/references.js';
import { detectGitRenames, refreshCurrentAppGraph } from '../src/scope/app-graph.js';
import {
  ReferenceValidator,
  referenceValidationScore,
  validateMemoryReferences,
} from '../src/query/reference-validation.js';

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

  it('keeps the tilde on home-relative references instead of stripping it', () => {
    const refs = extractMemoryReferences(
      'Hook wiring lives in ~/.claude/settings.json and the rule is in ~/.claude/CLAUDE.md.',
    );

    // Regression: the tilde used to fall outside the match, storing
    // `/.claude/CLAUDE.md` — an absolute path resolving against nothing.
    expect(refs.map(ref => ref.normalizedPath)).toEqual([
      '~/.claude/settings.json',
      '~/.claude/CLAUDE.md',
    ]);
    expect(refs.every(ref => ref.referenceType === 'absolute_path')).toBe(true);
    // The relative pass must not also emit a bare `.claude/CLAUDE.md` twin.
    expect(refs.map(ref => ref.normalizedPath)).not.toContain('.claude/CLAUDE.md');
  });

  it('still extracts genuine posix absolute paths that follow a word character', () => {
    const refs = extractMemoryReferences(
      'Config at /etc/cortex/config.json and the log in /var/log/cortex.log.',
    );

    expect(refs.map(ref => ref.normalizedPath)).toEqual([
      '/etc/cortex/config.json',
      '/var/log/cortex.log',
    ]);
  });

  it('resolves home-relative references against the home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# rules\n');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-root-'));
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-home-ref',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-home-ref',
      subject: 'guidance',
      text: 'decision: the consult policy lives in ~/.claude/CLAUDE.md.',
      state: 'hot',
      importance: 2,
    });

    const validation = validateMemoryReferences(store, item, { homeDir: home });

    expect(validation.references.map(ref => [ref.normalized_path, ref.status])).toEqual([
      ['~/.claude/CLAUDE.md', 'exists'],
    ]);
    expect(validation.stale).toBe(false);
    // The false `[stale: missing /.claude/CLAUDE.md]` this test exists to kill.
    expect(validation.label).toBeNull();
  });

  it('still reports a home-relative reference that is genuinely gone', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-gone-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-gone-root-'));
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-home-missing',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-home-missing',
      subject: 'hooks',
      text: 'decision: capture runs from ~/.claude/hooks/deleted.sh.',
      state: 'hot',
      importance: 2,
    });

    const validation = validateMemoryReferences(store, item, { homeDir: home });

    // Expanding rather than excluding keeps the signal: a deleted home file
    // is still reported, which is the whole point of the label.
    expect(validation.missing).toBe(1);
    expect(validation.stale).toBe(true);
    expect(validation.label).toBe('stale: missing ~/.claude/hooks/deleted.sh');
  });

  it('reports unknown, not missing, when there is no home directory to expand against', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-none-'));
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-home-unknown',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:insight',
      sourceTable: 'notes',
      sourceId: 'memory-home-unknown',
      subject: 'guidance',
      text: 'insight: ~/.claude/CLAUDE.md carries the consult policy.',
      state: 'warm',
      importance: 1,
    });

    const validation = validateMemoryReferences(store, item, { homeDir: null });

    expect(validation.unknown).toBe(1);
    expect(validation.missing).toBe(0);
    expect(validation.stale).toBe(false);
  });

  it('repairs tilde-stripped references already stored before the fix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-repair-'));
    const db = createTestDb(root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-legacy-home-ref',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-legacy-home-ref',
      subject: 'guidance',
      text: 'decision: the consult policy lives in ~/.claude/CLAUDE.md.',
      state: 'hot',
      importance: 2,
    });

    // Reproduce what the old extractor wrote: the tilde stripped off.
    db.prepare('DELETE FROM memory_references WHERE memory_item_id = ?').run(item.id);
    db.prepare(
      `INSERT INTO memory_references (
         id, memory_item_id, reference_type, raw_reference, normalized_path, status, checked_at
       ) VALUES ('legacy-ref', ?, 'absolute_path', '/.claude/CLAUDE.md', '/.claude/CLAUDE.md', 'missing', NULL)`,
    ).run(item.id);

    ensureCortexSchema(db, root);

    const repaired = store.getMemoryReferences(item.id).map(ref => ref.normalized_path);
    expect(repaired).toEqual(['~/.claude/CLAUDE.md']);
  });

  it('extracts nothing from a placeholder-rooted path, in either pass', () => {
    const refs = extractMemoryReferences(
      'parent .nexus/index.db opened read-only, plus <worktree>/.nexus/overlay.db with diverged files only.',
    );

    // Regression: `>` fell outside the posix lookbehind, so the match started
    // at the `/` and stored `/.nexus/overlay.db` — an absolute-looking path
    // resolving against nothing. Suppressing only that pass is not enough:
    // the relative pass would then store `.nexus/overlay.db`, equally absent
    // from the scope's app graph and equally `[stale: missing …]`.
    expect(refs.map(ref => ref.normalizedPath)).toEqual(['.nexus/index.db']);
  });

  it('extracts nothing from any placeholder root flavour', () => {
    for (const text of [
      'writes <worktree>/.nexus/overlay.db now',
      'writes <project>/.claude/settings.json now',
      'writes ${HOME}/.codex/history.jsonl now',
      'writes {root}/.nexus/telemetry.db now',
      'writes %APPDATA%/npm/config.json now',
    ]) {
      expect(extractMemoryReferences(text)).toEqual([]);
    }
  });

  it('extracts nothing from a URL, which is not a path on any filesystem', () => {
    const refs = extractMemoryReferences(
      'cloned https://github.com/obra/superpowers.git after reading https://www.sqlite.org/wal.html',
    );

    // `//` is not in the lookbehind set either, so the second slash started a
    // match and stored `/github.com/obra/superpowers.git`. 157 rows machine-wide.
    expect(refs).toEqual([]);
  });

  it('extracts nothing from a glob root or a concatenation fragment', () => {
    expect(
      extractMemoryReferences("rg -g '!**/.codex/history.jsonl' 'C:/Claude Code'"),
    ).toEqual([]);
    expect(
      extractMemoryReferences("const s = fs.readFileSync(homedir()+'/.claude/settings.json')"),
    ).toEqual([]);
  });

  it('still extracts a quoted absolute path that is not being concatenated', () => {
    const refs = extractMemoryReferences("open('/tmp/_allow.sql','w').write(allow)");

    // The fragment rule keys on the `+`, never on the quote: this shape is
    // behind the only quote-preceded references measured to actually resolve.
    expect(refs.map(ref => ref.normalizedPath)).toEqual(['/tmp/_allow.sql']);
  });

  it('masks only the unrooted span, leaving real references around it intact', () => {
    const refs = extractMemoryReferences(
      'see https://example.com/docs/readme.md and <worktree>/.nexus/overlay.db, then src/query/state.ts and /etc/cortex/config.json',
    );

    expect(refs.map(ref => ref.normalizedPath)).toEqual([
      '/etc/cortex/config.json',
      'src/query/state.ts',
    ]);
  });

  it('does not mistake a bracketed real path for a placeholder root', () => {
    // `<docs/readme.md>` is a delimited path, not a `<placeholder>/` root —
    // the closing bracket has to precede the separator for the root to count.
    const refs = extractMemoryReferences('the file <docs/readme.md> is the entry point');

    expect(refs.map(ref => ref.normalizedPath)).toEqual(['docs/readme.md']);
  });

  it('leaves a memory carrying only placeholder paths unlabelled and in the working set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-unrooted-'));
    const store = new CortexStore(createTestDb(root));
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-unrooted',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-unrooted',
      subject: 'worktree overlay',
      text: 'decision: open <worktree>/.nexus/overlay.db with diverged files only.',
      state: 'hot',
      importance: 2,
    });

    const validation = validateMemoryReferences(store, item);

    expect(validation.references).toEqual([]);
    expect(validation.missing).toBe(0);
    // The false `[stale: missing /.nexus/overlay.db]` this test exists to kill,
    // and with it the state.ts `.stale` filter that dropped the note entirely.
    expect(validation.stale).toBe(false);
    expect(validation.label).toBeNull();
  });

  it('repairs unrooted references already stored before the fix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-unrooted-repair-'));
    const db = createTestDb(root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-legacy-unrooted',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-legacy-unrooted',
      subject: 'worktree overlay',
      text: 'decision: open <worktree>/.nexus/overlay.db, cloned from https://github.com/obra/superpowers.git, alongside src/query/state.ts.',
      state: 'hot',
      importance: 2,
    });

    // Reproduce what the old extractor wrote: the placeholder and the URL
    // authority both stored as absolute paths rooted at nothing.
    db.prepare('DELETE FROM memory_references WHERE memory_item_id = ?').run(item.id);
    const insert = db.prepare(
      `INSERT INTO memory_references (
         id, memory_item_id, reference_type, raw_reference, normalized_path, status, checked_at
       ) VALUES (?, ?, ?, ?, ?, 'missing', NULL)`,
    );
    insert.run('legacy-a', item.id, 'absolute_path', '/.nexus/overlay.db', '/.nexus/overlay.db');
    insert.run(
      'legacy-b',
      item.id,
      'absolute_path',
      '/github.com/obra/superpowers.git',
      '/github.com/obra/superpowers.git',
    );

    ensureCortexSchema(db, root);

    expect(store.getMemoryReferences(item.id).map(ref => ref.normalized_path)).toEqual([
      'src/query/state.ts',
    ]);
  });

  it('repairs an item whose references were all unrooted, leaving none behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-unrooted-empty-'));
    const db = createTestDb(root);
    const store = new CortexStore(db);
    const session = store.createSession({
      worktreePath: root,
      scopeType: 'project',
      scopeKey: `project:${root}`,
    });
    const item = store.upsertMemoryItem({
      id: 'memory-legacy-all-unrooted',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:insight',
      sourceTable: 'notes',
      sourceId: 'memory-legacy-all-unrooted',
      subject: 'telemetry',
      text: 'insight: telemetry lands in {root}/.nexus/telemetry.db.',
      state: 'warm',
      importance: 1,
    });

    db.prepare('DELETE FROM memory_references WHERE memory_item_id = ?').run(item.id);
    db.prepare(
      `INSERT INTO memory_references (
         id, memory_item_id, reference_type, raw_reference, normalized_path, status, checked_at
       ) VALUES ('legacy-only', ?, 'absolute_path', '/.nexus/telemetry.db', '/.nexus/telemetry.db', 'missing', NULL)`,
    ).run(item.id);

    ensureCortexSchema(db, root);

    // An item that now extracts to nothing must have its rows deleted, not
    // skipped — otherwise the repair leaves exactly the rows it exists to clear.
    expect(store.getMemoryReferences(item.id)).toEqual([]);
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

  it('resolves renamed references to moved status via the rename map', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-moved-'));
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
      files: ['src/db/queries/reads.ts', 'src/db/schema.ts'],
    });
    store.insertFileRenames({
      scopeKey: session.scope_key!,
      renames: [{ oldPath: 'src/db/reads.ts', newPath: 'src/db/queries/reads.ts' }],
    });
    const item = store.upsertMemoryItem({
      id: 'memory-with-moved-ref',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-with-moved-ref',
      subject: 'reads',
      text: 'decision: keep read queries in src/db/reads.ts isolated.',
      state: 'hot',
      importance: 2,
    });

    const validation = validateMemoryReferences(store, item);

    expect(validation.moved).toBe(1);
    expect(validation.missing).toBe(0);
    expect(validation.stale).toBe(false);
    expect(validation.movedReferences).toEqual([
      { from: 'src/db/reads.ts', to: 'src/db/queries/reads.ts' },
    ]);
    expect(validation.label).toContain('moved: src/db/reads.ts → src/db/queries/reads.ts');
    expect(referenceValidationScore(validation, false)).toBe(3);

    const persisted = store.getMemoryReferences(item.id);
    const movedRef = persisted.find(ref => ref.normalized_path === 'src/db/reads.ts');
    expect(movedRef?.status).toBe('moved');
    expect(movedRef?.moved_to).toBe('src/db/queries/reads.ts');
  });

  it('falls back to unique basename matches and refuses ambiguous ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-basename-'));
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
      files: ['src/new-home/unique.ts', 'src/a/dupe.ts', 'src/b/dupe.ts'],
    });
    const item = store.upsertMemoryItem({
      id: 'memory-basename-refs',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:insight',
      sourceTable: 'notes',
      sourceId: 'memory-basename-refs',
      subject: 'moves',
      text: 'insight: src/old-home/unique.ts and src/old/dupe.ts moved during the refactor.',
      state: 'warm',
      importance: 1,
    });

    const validation = validateMemoryReferences(store, item);
    const byPath = new Map(
      validation.references.map(ref => [ref.normalized_path, ref]),
    );

    expect(byPath.get('src/old-home/unique.ts')?.status).toBe('moved');
    expect(byPath.get('src/old-home/unique.ts')?.moved_to).toBe('src/new-home/unique.ts');
    expect(byPath.get('src/old/dupe.ts')?.status).toBe('missing');
  });

  it('follows rename chains across successive moves', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-chain-'));
    const store = new CortexStore(createTestDb(root));
    store.insertFileRenames({
      scopeKey: 'project:chain',
      renames: [{ oldPath: 'src/a.ts', newPath: 'src/b.ts' }],
    });
    store.insertFileRenames({
      scopeKey: 'project:chain',
      renames: [{ oldPath: 'src/b.ts', newPath: 'src/c/final.ts' }],
    });

    expect(store.resolveFileRename('project:chain', 'src/a.ts')).toBe('src/c/final.ts');
    expect(store.resolveFileRename('project:chain', 'src/b.ts')).toBe('src/c/final.ts');
    expect(store.resolveFileRename('project:chain', 'src/none.ts')).toBeNull();
  });

  it('applies graduated, capped penalties instead of burying stale memory', () => {
    const validationWith = (missing: number): Parameters<typeof referenceValidationScore>[0] => ({
      references: Array.from({ length: missing }, (_, i) => ({
        id: `ref-${i}`,
        memory_item_id: 'item',
        reference_type: 'file',
        raw_reference: `src/gone-${i}.ts`,
        normalized_path: `src/gone-${i}.ts`,
        status: 'missing' as const,
        checked_at: null,
        moved_to: null,
      })),
      exists: 0,
      missing,
      moved: 0,
      unknown: 0,
      external: 0,
      stale: missing > 0,
      missingReferences: Array.from({ length: missing }, (_, i) => `src/gone-${i}.ts`),
      movedReferences: [],
      label: null,
    });

    expect(referenceValidationScore(validationWith(1), false)).toBe(-5);
    expect(referenceValidationScore(validationWith(3), false)).toBe(-7);
    expect(referenceValidationScore(validationWith(8), false)).toBe(-8);
    expect(referenceValidationScore(validationWith(1), true)).toBe(-1.5);
    expect(referenceValidationScore(validationWith(8), true)).toBe(-12);
  });

  it('batches reference status writes until flush', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-batch-'));
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
      id: 'memory-batched-refs',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: session.scope_key!,
      kind: 'note:decision',
      sourceTable: 'notes',
      sourceId: 'memory-batched-refs',
      subject: 'batch',
      text: 'decision: src/alive.ts stays, src/gone.ts is removed.',
      state: 'hot',
      importance: 2,
    });

    const validator = new ReferenceValidator(store);
    const validation = validator.validate(item);
    expect(validation.missing).toBe(1);

    // Statuses are computed in-memory but not yet persisted.
    const beforeFlush = store.getMemoryReferences(item.id);
    expect(beforeFlush.every(ref => ref.status === 'unknown')).toBe(true);

    // Repeat validation hits the per-item cache (no duplicate queued writes).
    validator.validate(item);
    validator.flush();

    const afterFlush = new Map(
      store.getMemoryReferences(item.id).map(ref => [ref.normalized_path, ref.status]),
    );
    expect(afterFlush.get('src/alive.ts')).toBe('exists');
    expect(afterFlush.get('src/gone.ts')).toBe('missing');
  });

  it('records git renames when the app graph head changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rename-git-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'before.ts'), 'export const v = 1;\n');
    childProcess.execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    childProcess.execFileSync('git', ['add', '.'], { cwd: root });
    childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    const firstHead = childProcess
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .trim();

    const store = new CortexStore(createTestDb(root));
    const scopeKey = `project:${root}`;
    refreshCurrentAppGraph(store, root, {
      scopeKey,
      scopeType: 'project',
      worktreePath: root,
      headOid: firstHead,
    });

    fs.mkdirSync(path.join(root, 'src', 'moved'), { recursive: true });
    childProcess.execFileSync(
      'git',
      ['mv', 'src/before.ts', 'src/moved/after.ts'],
      { cwd: root, stdio: 'ignore' },
    );
    childProcess.execFileSync('git', ['commit', '-m', 'move'], { cwd: root, stdio: 'ignore' });
    const secondHead = childProcess
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .trim();

    expect(detectGitRenames(root, firstHead, secondHead)).toEqual([
      { oldPath: 'src/before.ts', newPath: 'src/moved/after.ts' },
    ]);

    refreshCurrentAppGraph(store, root, {
      scopeKey,
      scopeType: 'project',
      worktreePath: root,
      headOid: secondHead,
    });

    const renames = store.getFileRenames(scopeKey);
    expect(renames).toHaveLength(1);
    expect(renames[0]!.old_path).toBe('src/before.ts');
    expect(renames[0]!.new_path).toBe('src/moved/after.ts');
    expect(store.resolveFileRename(scopeKey, 'src/before.ts')).toBe('src/moved/after.ts');
  });
});
