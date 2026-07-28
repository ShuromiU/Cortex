import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { createProgram } from '../src/transports/cli.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import { openDatabase, ensureCortexSchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MEMORY_LIST_ORDER,
} from '../src/query/inspect.js';

// ── createProgram ─────────────────────────────────────────────────────

describe('createProgram', () => {
  it('returns a valid Commander Command instance', () => {
    const program = createProgram();
    expect(program).toBeInstanceOf(Command);
  });

  it('has the name "cortex"', () => {
    const program = createProgram();
    expect(program.name()).toBe('cortex');
  });

  // ── log subcommand ──────────────────────────────────────────────

  describe('log subcommand', () => {
    it('exists as a subcommand', () => {
      const program = createProgram();
      const names = program.commands.map(c => c.name());
      expect(names).toContain('log');
    });

    it('has a read sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      expect(log).toBeDefined();
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('read');
    });

    it('has an edit sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('edit');
    });

    it('has a write sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('write');
    });

    it('has a cmd sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('cmd');
    });

    it('has an agent sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('agent');
    });

    it('log read has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const read = log.commands.find(c => c.name() === 'read')!;
      const optNames = read.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log read has optional --lines option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const read = log.commands.find(c => c.name() === 'read')!;
      const optNames = read.options.map(o => o.long);
      expect(optNames).toContain('--lines');
    });

    it('log edit has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const edit = log.commands.find(c => c.name() === 'edit')!;
      const optNames = edit.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log write has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const write = log.commands.find(c => c.name() === 'write')!;
      const optNames = write.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log cmd has optional --exit, --cmd, --stdout, and --stderr options', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const cmd = log.commands.find(c => c.name() === 'cmd')!;
      const optNames = cmd.options.map(o => o.long);
      expect(optNames).toContain('--exit');
      expect(optNames).toContain('--cmd');
      expect(optNames).toContain('--stdout');
      expect(optNames).toContain('--stderr');
    });

    it('log agent has --desc option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const agent = log.commands.find(c => c.name() === 'agent')!;
      const optNames = agent.options.map(o => o.long);
      expect(optNames).toContain('--desc');
    });
  });

  // ── top-level commands ──────────────────────────────────────────

  it('has inject-header command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('inject-header');
  });

  it('has route command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('route');
  });

  it('has reflect command with event anchor options', () => {
    const program = createProgram();
    const reflect = program.commands.find(c => c.name() === 'reflect')!;
    expect(reflect).toBeDefined();
    const optNames = reflect.options.map(o => o.long);
    expect(optNames).toContain('--event');
    expect(optNames).toContain('--prompt');
    expect(optNames).toContain('--file');
    expect(optNames).toContain('--cmd');
    expect(optNames).toContain('--desc');
  });

  it('inject-header engages cortex without claiming state was already loaded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-'));
    const originalCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      process.chdir(tempDir);
      const program = createProgram();
      await program.parseAsync(['node', 'cortex', 'inject-header']);

      const engagement = fs.readFileSync(deriveEngagementPath(tempDir), 'utf8');
      expect(engagement).toContain('enabled=true');
      expect(engagement).toContain('state_called=false');
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it('inject-header --quiet engages cortex without printing startup output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-quiet-'));
    const originalCwd = process.cwd();
    let stdout = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });

    try {
      process.chdir(tempDir);
      const program = createProgram();
      await program.parseAsync(['node', 'cortex', 'inject-header', '--quiet']);

      const engagement = fs.readFileSync(deriveEngagementPath(tempDir), 'utf8');
      expect(engagement).toContain('enabled=true');
      expect(engagement).toContain('state_called=false');
      expect(stdout).toBe('');
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it('has status command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('status');
  });

  it('has stats command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('stats');
  });

  it('has consolidate command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('consolidate');
  });

  it('has evaluate command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('evaluate');
  });

  it('has suggest-notes command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('suggest-notes');
  });

  it('has validate-memory command with optional topic', () => {
    const program = createProgram();
    const validate = program.commands.find(c => c.name() === 'validate-memory')!;
    expect(validate).toBeDefined();
    const optNames = validate.options.map(o => o.long);
    expect(optNames).toContain('--topic');
  });

  it('evaluate command accepts quality suite and compare options', () => {
    const program = createProgram();
    const evaluate = program.commands.find(c => c.name() === 'evaluate')!;
    const optNames = evaluate.options.map(o => o.long);
    expect(optNames).toContain('--suite');
    expect(optNames).toContain('--compare');
  });

  it('has serve command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('serve');
  });
});

// ── list-memory / inspect-memory (FR-21) ──────────────────────────────
//
// These run the commands. A test that only asserts a command is *registered*
// passes for a command whose action throws on every input.

interface CommandRun {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

function seedTempProject(seed: (store: CortexStore) => void): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-memory-'));
  const db = openDatabase(path.join(tempDir, '.cortex.db'));
  ensureCortexSchema(db, tempDir);
  seed(new CortexStore(db));
  db.close();
  return tempDir;
}

async function runCommand(cwd: string, argv: string[]): Promise<CommandRun> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });

  try {
    process.chdir(cwd);
    process.exitCode = undefined;
    await createProgram().parseAsync(['node', 'cortex', ...argv]);
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    // A leaked non-zero exitCode fails the whole vitest run, not this test.
    process.exitCode = originalExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.chdir(originalCwd);
  }
}

function seedItem(
  store: CortexStore,
  id: string,
  overrides: Partial<{
    scopeKey: string;
    kind: string;
    state: 'pinned' | 'hot' | 'warm' | 'cold' | 'archived';
    text: string;
  }> = {},
): void {
  store.upsertMemoryItem({
    id,
    scopeType: 'project',
    scopeKey: overrides.scopeKey ?? 'scope-a',
    kind: overrides.kind ?? 'note:decision',
    text: overrides.text ?? `stored text for ${id}`,
    state: overrides.state ?? 'warm',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
}

describe('cortex list-memory', () => {
  it('paginates instead of dumping the store, and states its order', async () => {
    const cwd = seedTempProject(store => {
      for (let i = 0; i < 25; i += 1) {
        seedItem(store, `item-${String(i).padStart(2, '0')}`);
      }
    });

    const first = await runCommand(cwd, ['list-memory']);

    const itemLines = first.stdout
      .split('\n')
      .filter(line => line.trimStart().startsWith('item-'));
    expect(itemLines).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(first.stdout).toContain('of 25');
    expect(first.stdout).toContain(MEMORY_LIST_ORDER);
    expect(first.stdout).toContain('--offset 20');
    expect(first.exitCode).toBeFalsy();

    const second = await runCommand(cwd, ['list-memory', '--offset', '20']);
    const secondLines = second.stdout
      .split('\n')
      .filter(line => line.trimStart().startsWith('item-'));
    expect(secondLines).toHaveLength(5);
    // Last page: nothing further to offer.
    expect(second.stdout).not.toContain('next page');
  });

  it('caps the page size however large a limit the caller passes', async () => {
    const cwd = seedTempProject(store => {
      for (let i = 0; i < 25; i += 1) {
        seedItem(store, `item-${String(i).padStart(2, '0')}`);
      }
    });

    const run = await runCommand(cwd, ['list-memory', '--limit', '99999', '--json']);
    const parsed = JSON.parse(run.stdout) as { limit: number; total: number; items: unknown[] };

    expect(parsed.limit).toBe(MAX_PAGE_LIMIT);
    expect(parsed.total).toBe(25);
    expect(parsed.items.length).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
  });

  it('falls back to the default page size for a non-numeric limit', async () => {
    const cwd = seedTempProject(store => {
      for (let i = 0; i < 25; i += 1) {
        seedItem(store, `item-${String(i).padStart(2, '0')}`);
      }
    });

    const run = await runCommand(cwd, ['list-memory', '--limit', 'lots', '--json']);
    const parsed = JSON.parse(run.stdout) as { limit: number; items: unknown[] };

    expect(parsed.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsed.items).toHaveLength(DEFAULT_PAGE_LIMIT);
  });

  it('filters by scope, kind and state, and shows every item id', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'a-hot-decision', { kind: 'note:decision', state: 'hot' });
      seedItem(store, 'a-warm-insight', { kind: 'note:insight', state: 'warm' });
      seedItem(store, 'b-hot-decision', {
        scopeKey: 'scope-b',
        kind: 'note:decision',
        state: 'hot',
      });
      seedItem(store, 'a-archived', { state: 'archived' });
    });

    // Adversarial precondition: unfiltered, every id the filters must exclude
    // is genuinely listed — including the archived one.
    const all = await runCommand(cwd, ['list-memory', '--json']);
    const allIds = (JSON.parse(all.stdout) as { items: Array<{ id: string }> }).items.map(
      item => item.id,
    );
    expect(allIds.sort()).toEqual([
      'a-archived',
      'a-hot-decision',
      'a-warm-insight',
      'b-hot-decision',
    ]);

    const byScope = await runCommand(cwd, ['list-memory', '--scope', 'scope-b', '--json']);
    expect(
      (JSON.parse(byScope.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id),
    ).toEqual(['b-hot-decision']);

    const byKind = await runCommand(cwd, ['list-memory', '--kind', 'note:insight', '--json']);
    expect(
      (JSON.parse(byKind.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id),
    ).toEqual(['a-warm-insight']);

    const byState = await runCommand(cwd, ['list-memory', '--state', 'hot', '--json']);
    expect(
      (JSON.parse(byState.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id).sort(),
    ).toEqual(['a-hot-decision', 'b-hot-decision']);

    const combined = await runCommand(cwd, [
      'list-memory',
      '--scope',
      'scope-a',
      '--kind',
      'note:decision',
      '--state',
      'hot',
      '--json',
    ]);
    expect(
      (JSON.parse(combined.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id),
    ).toEqual(['a-hot-decision']);

    // Text mode carries the ids too — AC #1 asks for items *with ids*.
    const text = await runCommand(cwd, ['list-memory', '--state', 'hot']);
    expect(text.stdout).toContain('a-hot-decision');
    expect(text.stdout).toContain('b-hot-decision');
  });

  it('accepts comma-separated filter values', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'd1', { kind: 'note:decision' });
      seedItem(store, 'i1', { kind: 'note:insight' });
      seedItem(store, 'c1', { kind: 'command_run' });
    });

    const run = await runCommand(cwd, [
      'list-memory',
      '--kind',
      'note:decision,command_run',
      '--json',
    ]);

    expect(
      (JSON.parse(run.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id).sort(),
    ).toEqual(['c1', 'd1']);
  });

  it('prints a next-page command that carries the filters forward', async () => {
    const cwd = seedTempProject(store => {
      for (let i = 0; i < 25; i += 1) {
        seedItem(store, `item-${String(i).padStart(2, '0')}`, { kind: 'note:decision' });
      }
      seedItem(store, 'other-kind', { kind: 'note:insight' });
    });

    const run = await runCommand(cwd, [
      'list-memory',
      '--kind',
      'note:decision',
      '--limit',
      '10',
    ]);

    // The footer has to be runnable as-is, filters included — otherwise page 2
    // silently widens to the whole store.
    const nextPage = run.stdout
      .split('\n')
      .find(line => line.startsWith('next page:'))!;
    expect(nextPage).toBeDefined();
    expect(nextPage).toContain('--kind note:decision');
    expect(nextPage).toContain('--limit 10');
    expect(nextPage).toContain('--offset 10');

    const followUp = await runCommand(cwd, [
      ...nextPage.replace('next page: cortex ', '').split(' '),
      '--json',
    ]);
    const parsed = JSON.parse(followUp.stdout) as {
      total: number;
      items: Array<{ id: string }>;
    };
    expect(parsed.total).toBe(25);
    expect(parsed.items.map(i => i.id)).not.toContain('other-kind');
  });

  it('says so plainly when nothing matches', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'only-one');
    });

    const run = await runCommand(cwd, ['list-memory', '--kind', 'note:blocker']);

    expect(run.stdout).toContain('of 0');
    expect(run.stdout).not.toContain('only-one');
    expect(run.exitCode).toBeFalsy();
  });

  it('does not create a session just to read', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'quiet');
    });

    await runCommand(cwd, ['list-memory']);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    expect(store.getSessionCount()).toBe(0);
    db.close();
  });
});

describe('cortex inspect-memory', () => {
  it('shows full text, references, trust label, conflict status and access history', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      store.upsertCurrentAppGraph({
        scopeKey: 'scope-a',
        scopeType: 'project',
        files: ['src/present.ts'],
      });
      const note = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'transport choice',
        content: 'use stdio, wired in src/present.ts\nsecond line of the decision',
        alternatives: ['http streaming', 'websocket'],
      });
      noteId = note.id;
      const item = store.getMemoryItemBySource('notes', note.id)!;
      store.insertRetrievalLog({
        sessionId,
        topic: 'transport',
        resultIds: [item.id],
        createdAt: '2026-07-20T00:00:00.000Z',
      });
    });

    const run = await runCommand(cwd, ['inspect-memory', noteId, '--json']);
    const parsed = JSON.parse(run.stdout) as {
      text: string;
      trust: string;
      references: Array<{ normalized_path: string; status: string }>;
      conflict: { conflict: boolean | null; note_status: string | null; alternatives: string[] | null };
      access: { access_count: number; retrievals: Array<{ topic: string }> };
    };

    expect(run.exitCode).toBeFalsy();
    expect(parsed.text).toContain('second line of the decision');
    expect(parsed.trust).toBe('refs OK');
    expect(parsed.references.map(r => r.normalized_path)).toContain('src/present.ts');
    expect(parsed.conflict.conflict).toBe(false);
    expect(parsed.conflict.note_status).toBe('active');
    expect(parsed.conflict.alternatives).toEqual(['http streaming', 'websocket']);
    expect(parsed.access.retrievals.map(r => r.topic)).toEqual(['transport']);
  });

  it('renders each of those five in text mode too', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      store.upsertCurrentAppGraph({
        scopeKey: 'scope-a',
        scopeType: 'project',
        files: ['src/present.ts'],
      });
      const note = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'transport choice',
        content: 'use stdio, wired in src/present.ts\nsecond line of the decision',
      });
      noteId = note.id;
      const item = store.getMemoryItemBySource('notes', note.id)!;
      store.insertRetrievalLog({ sessionId, topic: 'transport', resultIds: [item.id] });
    });

    const run = await runCommand(cwd, ['inspect-memory', noteId]);

    expect(run.stdout).toContain('second line of the decision'); // full text
    expect(run.stdout).toContain('src/present.ts'); // references
    expect(run.stdout).toContain('refs OK'); // trust label
    expect(run.stdout).toMatch(/conflict/i); // conflict status
    expect(run.stdout).toContain('transport'); // access history
  });

  it('reports an unknown id clearly on stderr and exits non-zero', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'exists');
    });

    const run = await runCommand(cwd, ['inspect-memory', 'no-such-id']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('no-such-id');
    expect(run.stdout).toBe('');
  });

  it('exits non-zero for an unknown id in --json mode as well', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'exists');
    });

    const run = await runCommand(cwd, ['inspect-memory', 'no-such-id', '--json']);

    // A caller piping --json must not read "not found" as success.
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('no-such-id');
  });

  it('shows both sides of a contest, each naming the other', async () => {
    let firstId = '';
    let secondId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      firstId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'flush the spool at turn end',
      }).id;
      secondId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'do not flush the spool at turn end',
      }).id;
    });

    const run = await runCommand(cwd, ['inspect-memory', firstId, '--json']);
    const parsed = JSON.parse(run.stdout) as {
      conflict: { conflict: boolean; counterparts: Array<{ id: string }> };
    };

    expect(parsed.conflict.conflict).toBe(true);
    expect(parsed.conflict.counterparts.map(c => c.id)).toEqual([secondId]);

    // Text mode renders the counterpart with the repo's compact timestamp
    // form, not the raw ISO string stored on the note.
    const text = await runCommand(cwd, ['inspect-memory', firstId]);
    expect(text.stdout).toMatch(
      new RegExp(`contested with ${secondId} \\(decision, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}Z\\)`),
    );
    expect(text.stdout).not.toMatch(/contested with .* \d{2}:\d{2}:\d{2}\.\d{3}Z\)/);
  });

  it('accepts a counterpart id straight from the conflict section', async () => {
    let firstId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      firstId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'flush the spool at turn end',
      }).id;
      store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'do not flush the spool at turn end',
      });
    });

    const first = await runCommand(cwd, ['inspect-memory', firstId, '--json']);
    const counterpartId = (
      JSON.parse(first.stdout) as { conflict: { counterparts: Array<{ id: string }> } }
    ).conflict.counterparts[0]!.id;

    // The section prints note ids, not memory-item ids, so the printed id is
    // only useful if inspect resolves it — the README says it does.
    const second = await runCommand(cwd, ['inspect-memory', counterpartId, '--json']);
    expect(second.exitCode).toBeFalsy();
    expect(
      (JSON.parse(second.stdout) as { conflict: { counterparts: Array<{ id: string }> } }).conflict
        .counterparts.map(c => c.id),
    ).toEqual([firstId]);
  });

  it('does not create a session just to read', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'quiet');
    });

    await runCommand(cwd, ['inspect-memory', 'quiet']);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(db).getSessionCount()).toBe(0);
    db.close();
  });

  it('does not reheat the item it inspects', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'cool',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:decision',
        text: 'a cold decision',
        state: 'cold',
        accessCount: 2,
      });
    });

    await runCommand(cwd, ['inspect-memory', 'cool']);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const item = new CortexStore(db).getMemoryItem('cool')!;
    expect(item.state).toBe('cold');
    expect(item.access_count).toBe(2);
    db.close();
  });
});
