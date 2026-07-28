import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { createProgram } from '../src/transports/cli.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import { openDatabase, ensureCortexSchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { handleCmdEvent } from '../src/capture/hooks.js';
import {
  ACCESS_HISTORY_LIMIT,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MEMORY_LIST_ORDER,
  inspectMemory,
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
      // A topic that appears nowhere else in the output. With the topic set to
      // "transport" a `toContain('transport')` passes off the subject line even
      // with the whole access-history section deleted.
      store.insertRetrievalLog({
        sessionId,
        topic: 'zzz-unique-retrieval-topic',
        resultIds: [item.id],
      });
    });

    const run = await runCommand(cwd, ['inspect-memory', noteId]);

    // Each assertion must be reachable ONLY through its own section. The full
    // text is printed verbatim at the end, so any bare substring drawn from the
    // note content passes even with the section that should carry it removed.
    expect(run.stdout).toContain('second line of the decision'); // full text
    expect(run.stdout).toMatch(/^ {2}exists {2,}src\/present\.ts$/m); // references
    expect(run.stdout).toMatch(/^trust: +refs OK$/m); // trust label
    expect(run.stdout).toMatch(/^conflict: +none$/m); // conflict status
    expect(run.stdout).toMatch(/^status: +active$/m);
    expect(run.stdout).toMatch(/^ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z {2}zzz-unique-retrieval-topic$/m); // access history
    expect(run.stdout).toMatch(/^ {2}count 0, last never$/m);
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

// ── edit-memory / delete-memory (FR-22) ───────────────────────────────

describe('cortex edit-memory', () => {
  it('replaces the text, re-extracts references and keeps the prior text', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'item',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:insight',
        text: 'the bug is in src/old.ts',
      });
    });

    const run = await runCommand(cwd, [
      'edit-memory',
      'item',
      '--text',
      'the bug is in src/new.ts',
      '--json',
    ]);
    const parsed = JSON.parse(run.stdout) as {
      prior_text: string;
      item: { text: string };
      references: Array<{ normalized_path: string }>;
    };

    expect(run.exitCode).toBeFalsy();
    expect(parsed.prior_text).toBe('the bug is in src/old.ts');
    expect(parsed.item.text).toBe('the bug is in src/new.ts');
    expect(parsed.references.map(r => r.normalized_path)).toEqual(['src/new.ts']);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    expect(store.getMemoryCorrections('item')[0]).toMatchObject({
      operation: 'edit',
      prior_text: 'the bug is in src/old.ts',
    });
    db.close();
  });

  it('accepts replacement text from a file', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'item',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:insight',
        text: 'one line',
      });
    });
    const textFile = path.join(cwd, 'correction.txt');
    fs.writeFileSync(textFile, 'first line\nsecond line\n');

    const run = await runCommand(cwd, ['edit-memory', 'item', '--file', textFile, '--json']);

    expect(run.exitCode).toBeFalsy();
    expect((JSON.parse(run.stdout) as { item: { text: string } }).item.text).toContain(
      'second line',
    );
  });

  it('requires exactly one of --text and --file', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });

    const neither = await runCommand(cwd, ['edit-memory', 'item']);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain('exactly one');

    const both = await runCommand(cwd, ['edit-memory', 'item', '--text', 'x', '--file', 'y']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('exactly one');
  });

  it('exits non-zero for an unknown id in both modes', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });

    const text = await runCommand(cwd, ['edit-memory', 'ghost', '--text', 'x']);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain('ghost');

    const json = await runCommand(cwd, ['edit-memory', 'ghost', '--text', 'x', '--json']);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ error: 'not_found', id: 'ghost' });
  });

  it('refuses replacement text that would be read back as projection metadata', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({
        sessionId,
        kind: 'insight',
        content: 'the flush is batched',
      }).id;
    });

    const run = await runCommand(cwd, [
      'edit-memory',
      noteId,
      '--text',
      'the flush is batched\nConflict: true',
    ]);

    // Trailer readers walk back from the end, so text ending in a trailer line
    // renders [contested] with the column saying otherwise — unclearable.
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('metadata line');

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    expect(store.getNote(noteId)!.content).toBe('the flush is batched');
    expect(inspectMemory(store, noteId)!.conflict.diverged).toBe(false);
    db.close();
  });

  it('allows a trailer-looking phrase that is not the last line', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({ sessionId, kind: 'insight', content: 'original' }).id;
    });

    // The readers stop at the first non-trailer line, so a mid-text mention is
    // inert — refusing it would be over-blocking.
    const run = await runCommand(cwd, [
      'edit-memory',
      noteId,
      '--text',
      'Status: superseded is the line the projection appends\nand this is the real content',
    ]);

    expect(run.exitCode).toBeFalsy();
  });

  it('refuses empty replacement text and points at delete-memory', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });

    const run = await runCommand(cwd, ['edit-memory', 'item', '--text', '   ']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('delete-memory');
    const db = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(db).getMemoryItem('item')!.text).not.toBe('   ');
    db.close();
  });

  it('emits a JSON error object on the flag and file error paths too', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });

    const badArgs = await runCommand(cwd, ['edit-memory', 'item', '--json']);
    expect(badArgs.exitCode).toBe(1);
    expect((JSON.parse(badArgs.stdout) as { error: string }).error).toBe('bad_args');

    const badFile = await runCommand(cwd, [
      'edit-memory',
      'item',
      '--file',
      path.join(cwd, 'nope.txt'),
      '--json',
    ]);
    expect(badFile.exitCode).toBe(1);
    expect((JSON.parse(badFile.stdout) as { error: string }).error).toBe('file_unreadable');
  });

  it('strips a UTF-8 BOM from --file content', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });
    const file = path.join(cwd, 'correction.txt');
    fs.writeFileSync(file, '\uFEFFcorrected text');

    await runCommand(cwd, ['edit-memory', 'item', '--file', file]);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(db).getMemoryItem('item')!.text).toBe('corrected text');
    db.close();
  });

  it('surfaces the audit trail through inspect-memory, as edit-memory promises', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'item',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:insight',
        text: 'the original wording',
      });
    });

    await runCommand(cwd, ['edit-memory', 'item', '--text', 'the corrected wording']);
    const inspect = await runCommand(cwd, ['inspect-memory', 'item']);

    // edit-memory tells the user "cortex inspect-memory shows the item"; before
    // this, nothing surfaced the trail at all.
    expect(inspect.stdout).toContain('corrections:');
    expect(inspect.stdout).toContain('the original wording');
  });
});

describe('cortex delete-memory', () => {
  it('previews without deleting, and deletes only with --yes', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'doomed',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:insight',
        text: 'a memory about src/a.ts',
      });
    });

    const preview = await runCommand(cwd, ['delete-memory', 'doomed']);
    expect(preview.exitCode).toBeFalsy();
    expect(preview.stdout).toContain('preview only');
    expect(preview.stdout).toContain('--yes');

    // The preview must not have deleted anything — the confirmation is the point.
    const midDb = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(midDb).getMemoryItem('doomed')).toBeTruthy();
    midDb.close();

    const deleted = await runCommand(cwd, ['delete-memory', 'doomed', '--yes']);
    expect(deleted.exitCode).toBeFalsy();
    expect(deleted.stdout).toContain('deleted doomed');

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(db).getMemoryItem('doomed')).toBeUndefined();
    db.close();
  });

  it('keeps a note-backed deletion deleted after the schema re-opens', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'auth',
        content: 'a decision that turned out wrong',
      }).id;
    });

    await runCommand(cwd, ['delete-memory', noteId, '--yes']);

    // Every command re-runs ensureCortexSchema, which re-projects memory items
    // from their source rows. Running a second command is the real test.
    const after = await runCommand(cwd, ['list-memory', '--json']);
    const ids = (JSON.parse(after.stdout) as { items: Array<{ id: string }> }).items.map(
      i => i.id,
    );
    expect(ids).not.toContain(`notes:${noteId}`);
    expect(ids).toHaveLength(0);
  });

  it('warns in the preview that a contest will be cleared', async () => {
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

    const preview = await runCommand(cwd, ['delete-memory', firstId]);
    expect(preview.stdout).toContain('contest:');
    expect(preview.stdout).toContain(secondId);

    await runCommand(cwd, ['delete-memory', firstId, '--yes']);

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    expect(new CortexStore(db).getNote(secondId)!.conflict).toBe(false);
    db.close();
  });

  it('says in the preview when the source table has no deletion rule', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'foreign',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:insight',
        sourceTable: 'file_cards',
        sourceId: 'card-1',
        text: 'an item from a table the cascade does not know',
      });
    });

    const preview = await runCommand(cwd, ['delete-memory', 'foreign']);

    // Promising "deleted too" for a table the cascade skips is a lie the user
    // acts on — and the delete would resurrect the item while reporting success.
    expect(preview.stdout).toContain('NO deletion rule');
    expect(preview.stdout).not.toContain('deleted too');
  });

  it('names the upstream row the backfill would rebuild the source from', async () => {
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      handleCmdEvent(store, sessionId, { exit: '1', cmd: 'npm run build', stderr: 'boom' });
    });

    const listed = await runCommand(cwd, ['list-memory', '--kind', 'command_run', '--json']);
    const itemId = (JSON.parse(listed.stdout) as { items: Array<{ id: string }> }).items[0]!.id;

    const preview = await runCommand(cwd, ['delete-memory', itemId]);

    expect(preview.stdout).toContain('plus its events row');
  });

  it('exits non-zero for an unknown id in preview and in --yes mode', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'item');
    });

    const preview = await runCommand(cwd, ['delete-memory', 'ghost']);
    expect(preview.exitCode).toBe(1);
    expect(preview.stderr).toContain('ghost');

    const confirmed = await runCommand(cwd, ['delete-memory', 'ghost', '--yes', '--json']);
    expect(confirmed.exitCode).toBe(1);
    expect(JSON.parse(confirmed.stdout)).toEqual({ error: 'not_found', id: 'ghost' });
  });

  it('strips control characters from the previewed text', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'esc',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'episode:command_failure',
        text: 'red\u001b[31m\u0007bell\rCARRIAGE',
      });
    });

    const preview = await runCommand(cwd, ['delete-memory', 'esc']);

    expect(preview.stdout).not.toContain('\u001b');
    expect(preview.stdout).not.toContain('\u0007');
    expect(preview.stdout).toContain('CARRIAGE');
  });
});

// ── note-resolve repairs (retrospective action item 2) ────────────────

describe('cortex note-resolve', () => {
  it('clears the contest so a resolved note stops rendering as contested', async () => {
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

    const run = await runCommand(cwd, ['note-resolve', '--id', firstId]);
    expect(run.exitCode).toBeFalsy();

    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    // Before this repair the CLI called only updateNoteStatus, so the resolved
    // note kept Conflict: true and rendered "[contested] (resolved)" forever
    // while the survivor kept a bare [contested].
    expect(store.getNote(firstId)!.conflict).toBe(false);
    expect(store.getNote(secondId)!.conflict).toBe(false);
    expect(store.getMemoryItemBySource('notes', secondId)!.text).not.toContain('Conflict: true');
    db.close();
  });

  it('refuses to resolve by subject while a contest is open, naming both sides', async () => {
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

    const run = await runCommand(cwd, ['note-resolve', '--subject', 'spool flush']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(firstId);
    expect(run.stderr).toContain(secondId);

    // Nothing was resolved — the point is that it refused to guess.
    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    expect(store.getNote(firstId)!.status).toBe('active');
    expect(store.getNote(secondId)!.status).toBe('active');
    db.close();
  });

  it('does not clear an unrelated open contest when resolving an uncontested note', async () => {
    let decisionA = '';
    let decisionB = '';
    let blockerId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      decisionA = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'flush the spool at turn end',
      }).id;
      decisionB = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'spool flush',
        content: 'do not flush the spool at turn end',
      }).id;
      blockerId = store.insertNote({
        sessionId,
        kind: 'blocker',
        subject: 'spool flush',
        content: 'spool flush blocked on the jq dependency',
      }).id;
    });

    const before = openDatabase(path.join(cwd, '.cortex.db'));
    const beforeStore = new CortexStore(before);
    expect(beforeStore.getNote(decisionA)!.conflict).toBe(true);
    expect(beforeStore.getNote(blockerId)!.conflict).toBe(false);
    before.close();

    const run = await runCommand(cwd, ['note-resolve', '--id', blockerId]);
    expect(run.exitCode).toBeFalsy();

    // Resolving a note that is not part of the contest must leave the contest
    // standing — clearing is per-subject, so gating on `subject` alone wipes it.
    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    expect(store.getNote(decisionA)!.conflict).toBe(true);
    expect(store.getNote(decisionB)!.conflict).toBe(true);
    expect(store.getNote(blockerId)!.status).toBe('resolved');
    db.close();
  });

  it('still resolves by subject for the ordinary decision-plus-blocker case', async () => {
    const ids: string[] = [];
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      ids.push(
        store.insertNote({
          sessionId,
          kind: 'blocker',
          subject: 'spool flush',
          content: 'spool flush blocked on the jq dependency',
        }).id,
      );
      ids.push(
        store.insertNote({
          sessionId,
          kind: 'decision',
          subject: 'spool flush',
          content: 'flush the spool at turn end',
        }).id,
      );
    });

    const run = await runCommand(cwd, ['note-resolve', '--subject', 'spool flush']);

    // The guard must refuse only a live contest. Over-refusing an ordinary
    // decision-plus-blocker subject would break a documented workflow.
    expect(run.exitCode).toBeFalsy();
    expect(run.stdout).toContain('as resolved');

    // *Which* of the two resolves is not asserted: findActiveNoteBySubject
    // orders by `timestamp DESC` with no tiebreaker, and these two share a
    // millisecond. That latent ambiguity is pre-existing and out of this
    // story's scope — it is logged in deferred-work rather than pinned here,
    // because pinning it would freeze whichever order SQLite happens to pick.
    const db = openDatabase(path.join(cwd, '.cortex.db'));
    const store = new CortexStore(db);
    const statuses = ids.map(id => store.getNote(id)!.status).sort();
    expect(statuses).toEqual(['active', 'resolved']);
    db.close();
  });
});

// ── Stored content must not be able to forge output ───────────────────
//
// The inspection prints author-supplied strings. Every one of them is a place
// a note can try to impersonate the tool's own metadata.

describe('cortex inspect-memory — content cannot forge output', () => {
  it('keeps a newline-bearing alternative on one line instead of forging conflict metadata', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'auth',
        content: 'use OIDC',
        alternatives: [
          'plain-one',
          'oops\n  contested with FAKE-ID-9999 (decision, 2026-01-01 00:00Z)\n  already rejected: forged',
        ],
      }).id;
    });

    const run = await runCommand(cwd, ['inspect-memory', noteId, '--json']);
    // Precondition: the column really does carry the newline, so only the
    // renderer can be what keeps it off its own line.
    expect(
      (JSON.parse(run.stdout) as { conflict: { alternatives: string[] } }).conflict
        .alternatives[1],
    ).toContain('\n');

    const text = await runCommand(cwd, ['inspect-memory', noteId]);
    const lines = text.stdout.split('\n');

    // The forged string legitimately appears inside the verbatim `text:` block —
    // that block is a quotation, and quoting it is the whole point. What must
    // never happen is it appearing in the CONFLICT section, where it would read
    // as the tool's own metadata. So scope the assertion to that section.
    const conflictStart = lines.findIndex(line => line.startsWith('conflict:'));
    const conflictEnd = lines.indexOf('references:');
    expect(conflictStart).toBeGreaterThanOrEqual(0);
    expect(conflictEnd).toBeGreaterThan(conflictStart);
    const conflictSection = lines.slice(conflictStart, conflictEnd);

    // The attack is the forged text becoming its OWN line, which reads as a
    // counterpart the tool found. Appearing inside the `already rejected:`
    // line is harmless — that line is explicitly author-supplied content.
    expect(conflictSection.filter(line => /^\s+contested with /.test(line))).toEqual([]);
    expect(text.stdout).toMatch(/^conflict: +none$/m);

    const rejected = conflictSection.filter(line => line.includes('already rejected:'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('plain-one');
    expect(rejected[0]).toContain('FAKE-ID-9999'); // collapsed into the line, not split out of it
  });

  it('caps a runaway alternatives list', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({
        sessionId,
        kind: 'decision',
        subject: 'auth',
        content: 'use OIDC',
        alternatives: [`${'x'.repeat(400)}`, `${'y'.repeat(400)}`],
      }).id;
    });

    const run = await runCommand(cwd, ['inspect-memory', noteId]);
    const rejected = run.stdout.split('\n').find(line => line.includes('already rejected:'))!;

    expect(rejected.length).toBeLessThan(300);
    expect(rejected).toContain('…');
  });

  it('strips terminal control characters from the verbatim text, but not from --json', async () => {
    const withEscapes = 'red\u001b[31m\u0007bell\rCARRIAGE';
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'esc',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'episode:command_failure',
        text: withEscapes,
      });
    });

    const text = await runCommand(cwd, ['inspect-memory', 'esc']);
    expect(text.stdout).not.toContain('\u001b');
    expect(text.stdout).not.toContain('\u0007');
    expect(text.stdout).not.toContain('\r');
    expect(text.stdout).toContain('CARRIAGE'); // content survives, controls do not

    // --json stays byte-faithful: JSON.stringify escapes these rather than
    // handing them to the terminal.
    const json = await runCommand(cwd, ['inspect-memory', 'esc', '--json']);
    expect((JSON.parse(json.stdout) as { text: string }).text).toBe(withEscapes);
  });

  it('cannot forge a second listing row through a newline in the subject', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'forge',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:decision',
        subject: 'auth\nINJECTED-ROW  warm  Decision',
        text: 'a decision',
      });
    });

    const run = await runCommand(cwd, ['list-memory']);

    expect(run.stdout).toContain('INJECTED-ROW'); // still shown, just not as a row
    const bodyLines = run.stdout.split('\n').filter(line => line.trim().length > 0).slice(1);
    expect(bodyLines).toHaveLength(1);
  });
});

// ── Repairs from the review round ─────────────────────────────────────

describe('cortex list-memory — paging and filter robustness', () => {
  function seedN(count: number) {
    return seedTempProject(store => {
      for (let i = 0; i < count; i += 1) {
        seedItem(store, `item-${String(i).padStart(2, '0')}`);
      }
    });
  }

  it('reports an offset past the end instead of an inverted range', async () => {
    const cwd = seedN(3);

    const run = await runCommand(cwd, ['list-memory', '--offset', '100']);

    expect(run.stdout).not.toMatch(/101-100/);
    expect(run.stdout).toContain('offset 100 is past the end');
    expect(run.stdout).toContain('3 item(s) match');
  });

  it('survives an offset larger than a safe integer', async () => {
    const cwd = seedN(3);

    const run = await runCommand(cwd, ['list-memory', '--offset', '9223372036854775807']);

    // Previously reached better-sqlite3 and surfaced as a datatype-mismatch stack trace.
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBeFalsy();
    expect(run.stdout).toContain('of 3');
  });

  it('honours an exponent-notation limit instead of silently truncating it', async () => {
    const cwd = seedN(25);

    const run = await runCommand(cwd, ['list-memory', '--limit', '1e3', '--json']);
    const parsed = JSON.parse(run.stdout) as { limit: number; items: unknown[] };

    // Number.parseInt('1e3', 10) is 1 — the old behaviour silently paged one item.
    expect(parsed.limit).toBe(MAX_PAGE_LIMIT);
    expect(parsed.items).toHaveLength(25);
  });

  it('treats an empty filter value as matching nothing, never as no filter', async () => {
    const cwd = seedN(5);

    const empty = await runCommand(cwd, ['list-memory', '--kind', '', '--json']);
    const commas = await runCommand(cwd, ['list-memory', '--kind', ',,,', '--json']);

    // Both spellings of "no usable values" must agree, and neither may widen
    // the listing to the whole store.
    expect((JSON.parse(empty.stdout) as { items: unknown[]; total: number }).total).toBe(0);
    expect((JSON.parse(commas.stdout) as { items: unknown[]; total: number }).total).toBe(0);
  });

  it('rejects an unknown --state instead of reporting an empty store', async () => {
    const cwd = seedN(5);

    const run = await runCommand(cwd, ['list-memory', '--state', 'HOT']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Unknown --state');
    expect(run.stderr).toContain('archived');
    expect(run.stdout).toBe('');
  });

  it('accepts a repeated --scope, including a key containing a comma', async () => {
    const commaScope = 'branch:c:/repo/.git:c:/repo:feat/a,b';
    const cwd = seedTempProject(store => {
      seedItem(store, 'in-comma-scope', { scopeKey: commaScope });
      seedItem(store, 'in-plain-scope', { scopeKey: 'scope-a' });
      seedItem(store, 'in-third-scope', { scopeKey: 'scope-c' });
    });

    const single = await runCommand(cwd, ['list-memory', '--scope', commaScope, '--json']);
    expect(
      (JSON.parse(single.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id),
    ).toEqual(['in-comma-scope']);

    const repeated = await runCommand(cwd, [
      'list-memory',
      '--scope',
      commaScope,
      '--scope',
      'scope-a',
      '--json',
    ]);
    expect(
      (JSON.parse(repeated.stdout) as { items: Array<{ id: string }> }).items
        .map(i => i.id)
        .sort(),
    ).toEqual(['in-comma-scope', 'in-plain-scope']);
  });

  it('quotes filter values in the next-page command so it runs as printed', async () => {
    const spacedScope = 'branch:c:/claude code/cortex/.git:c:/claude code/cortex:main';
    const cwd = seedTempProject(store => {
      for (let i = 0; i < 5; i += 1) {
        seedItem(store, `item-${i}`, { scopeKey: spacedScope });
      }
    });

    const run = await runCommand(cwd, [
      'list-memory',
      '--scope',
      spacedScope,
      '--limit',
      '2',
    ]);
    const nextPage = run.stdout.split('\n').find(line => line.startsWith('next page:'))!;

    expect(nextPage).toContain(`"${spacedScope}"`);

    // Run it the way a shell would parse it, and check it actually pages.
    const argv = nextPage
      .replace('next page: cortex ', '')
      .match(/"[^"]*"|\S+/g)!
      .map(token => (token.startsWith('"') ? JSON.parse(token) : token));
    const followUp = await runCommand(cwd, [...argv, '--json']);
    const parsed = JSON.parse(followUp.stdout) as {
      total: number;
      offset: number;
      items: unknown[];
    };
    expect(parsed.total).toBe(5);
    expect(parsed.offset).toBe(2);
    expect(parsed.items).toHaveLength(2);
  });

  it('keeps columns separated for the widest real values', async () => {
    const cwd = seedTempProject(store => {
      // 'archived' is exactly 8 chars and 'Command failure' is 15 — both were
      // no-ops against the old fixed padding, so the columns ran together.
      seedItem(store, 'x0', { state: 'archived', kind: 'episode:command_failure' });
      seedItem(store, 'x1', { state: 'warm', kind: 'note:decision' });
    });

    const run = await runCommand(cwd, ['list-memory']);
    const row = run.stdout.split('\n').find(line => line.startsWith('x0'))!;

    expect(row).toContain('archived  Command failure  ');
    expect(row).not.toContain('archivedCommand');
  });

  it('states the tiebreaker as part of the ordering criterion', async () => {
    const cwd = seedN(2);

    const run = await runCommand(cwd, ['list-memory']);

    expect(run.stdout).toContain('created_at DESC, rowid DESC');
  });
});

describe('cortex inspect-memory — repairs', () => {
  it('prints a scope value that can be pasted back into --scope', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'scoped', { scopeKey: 'branch:other-branch' });
    });

    const run = await runCommand(cwd, ['inspect-memory', 'scoped']);
    const scopeLine = run.stdout.split('\n').find(line => line.startsWith('scope:'))!;

    expect(scopeLine).not.toContain('branch:branch:');
    const value = scopeLine.replace(/^scope: +/, '').trim();
    expect(value).toBe('branch:other-branch');

    const roundTrip = await runCommand(cwd, ['list-memory', '--scope', value, '--json']);
    expect(
      (JSON.parse(roundTrip.stdout) as { items: Array<{ id: string }> }).items.map(i => i.id),
    ).toEqual(['scoped']);
  });

  it('emits a parseable error object on stdout for a missing id in --json mode', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'exists');
    });

    const run = await runCommand(cwd, ['inspect-memory', 'ghost', '--json']);

    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ error: 'not_found', id: 'ghost' });
  });

  it('discloses the access-history cap alongside the gc caveat', async () => {
    const cwd = seedTempProject(store => {
      seedItem(store, 'seen');
    });

    const run = await runCommand(cwd, ['inspect-memory', 'seen']);

    expect(run.stdout).toContain(`showing at most ${ACCESS_HISTORY_LIMIT}`);
    expect(run.stdout).toContain('cortex gc');
  });

  it('flags an item whose note row is gone rather than calling it non-note-backed', async () => {
    const cwd = seedTempProject(store => {
      store.upsertMemoryItem({
        id: 'orphan',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:decision',
        sourceTable: 'notes',
        sourceId: 'deleted-note-id',
        text: 'a decision\nSubject: auth\nConflict: true',
      });
    });

    const json = await runCommand(cwd, ['inspect-memory', 'orphan', '--json']);
    const parsed = JSON.parse(json.stdout) as {
      conflict: { conflict: null; projected_contested: boolean; diverged: boolean };
    };

    // The column is gone while the projection still claims a contest — the one
    // drift this surface cannot repair, and so the one it must not hide.
    expect(parsed.conflict.conflict).toBeNull();
    expect(parsed.conflict.projected_contested).toBe(true);
    expect(parsed.conflict.diverged).toBe(true);

    const text = await runCommand(cwd, ['inspect-memory', 'orphan']);
    expect(text.stdout).toContain('no longer exists');
    expect(text.stdout).not.toContain('n/a (no note behind this item)');
  });

  it('renders reference status and move destinations as their own lines', async () => {
    const cwd = seedTempProject(store => {
      store.upsertCurrentAppGraph({
        scopeKey: 'scope-a',
        scopeType: 'project',
        files: ['src/new/moved.ts'],
      });
      store.insertFileRenames({
        scopeKey: 'scope-a',
        renames: [{ oldPath: 'src/old/moved.ts', newPath: 'src/new/moved.ts' }],
      });
      store.upsertMemoryItem({
        id: 'moved-ref',
        scopeType: 'project',
        scopeKey: 'scope-a',
        kind: 'note:decision',
        text: 'the fix lives in src/old/moved.ts',
      });
    });

    const run = await runCommand(cwd, ['inspect-memory', 'moved-ref']);

    expect(run.stdout).toMatch(/^ {2}moved +src\/old\/moved\.ts → src\/new\/moved\.ts$/m);
    expect(run.stdout).toMatch(/^trust: +refs moved$/m);
  });

  it('renders the counterpart and divergence lines discriminatingly', async () => {
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

    const run = await runCommand(cwd, ['inspect-memory', firstId]);

    expect(run.stdout).toMatch(/^conflict: +contested/m);
    expect(run.stdout).toMatch(new RegExp(`^ {2}contested with ${secondId} \\(decision, `, 'm'));
    expect(run.stdout).not.toContain('projection disagrees');
  });

  it('renders the divergence warning in text mode when column and projection disagree', async () => {
    let noteId = '';
    const cwd = seedTempProject(store => {
      const sessionId = store.createSession({ scopeType: 'project', scopeKey: 'scope-a' }).id;
      noteId = store.insertNote({
        sessionId,
        kind: 'insight',
        content: 'the projection writes\nConflict: true\nas its own line',
      }).id;
    });

    // Precondition: the column says no contest while the projected text claims one.
    const json = await runCommand(cwd, ['inspect-memory', noteId, '--json']);
    const parsed = JSON.parse(json.stdout) as {
      conflict: { conflict: boolean; projected_contested: boolean; diverged: boolean };
    };
    expect(parsed.conflict.conflict).toBe(false);
    expect(parsed.conflict.projected_contested).toBe(true);
    expect(parsed.conflict.diverged).toBe(true);

    // The JSON field alone does not prove the operator ever sees it. Text mode
    // is the default surface, and the drift is invisible everywhere else.
    const text = await runCommand(cwd, ['inspect-memory', noteId]);
    expect(text.stdout).toContain('projection disagrees with the stored note');
    expect(text.stdout).toContain('contested=true');
  });
});
