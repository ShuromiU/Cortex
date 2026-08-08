import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { createProgram, formatBytes, installExitCode, onlyUnusedProject, renderDoctorReport, renderInstallResult } from '../src/transports/cli.js';
import type { DoctorCheck, DoctorReport } from '../src/query/doctor.js';
import { HOOK_SCRIPTS, REQUIRED_WIRING, tokenizeCommand } from '../src/query/doctor.js';
import type { InstallAction, InstallResult } from '../src/query/install.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import { openDatabase, ensureCortexSchema } from '../src/db/schema.js';
import { resolveStoreIdentity } from '../src/scope/identity.js';
import { walSizeBytes } from '../src/db/schema.js';
import { clearProjectStoreCache, openProjectStore } from '../src/scope/store-migration.js';
import { HOT_PATH_STATE_KEYS, isSubstitutionEnabled } from '../src/capture/substitution.js';
import { escapeIndexField } from '../src/capture/digest-index.js';
import { normalizeFilePathKey } from '../src/scope/keys.js';
import { execFileSync } from 'node:child_process';
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

  it('inject-header publishes the hot-path facts the substitution hook cannot derive', async () => {
    // Story 4.5's state bridge, end to end. The hook may not open SQLite
    // (AD-2) or spawn Node (N-4), so the session id, the escaped scope key and
    // the scope root have to arrive here or substitution is dead — silently,
    // because a missing key degrades to a miss.
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-hotpath-')));
    const originalCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      process.chdir(tempDir);
      await createProgram().parseAsync(['node', 'cortex', 'inject-header', '--quiet']);

      const engagement = fs.readFileSync(deriveEngagementPath(tempDir), 'utf8');
      const facts = new Map(
        engagement
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const eq = line.indexOf('=');
            return [line.slice(0, eq), line.slice(eq + 1)] as [string, string];
          }),
      );

      // The engagement gate the hook checks first must still be the FIRST line:
      // `grep -q '^enabled=true'` is anchored, and every hook exits on it.
      expect(engagement.startsWith('enabled=true\n')).toBe(true);

      const sessionId = facts.get(HOT_PATH_STATE_KEYS.sessionId);
      expect(sessionId, 'no session id published').toBeTruthy();
      // It must be THIS session, not any session: a stale id is the AD-16
      // false-confidence failure the whole bridge exists to make unreachable.
      const { db } = openProjectStore(tempDir);
      const store = new CortexStore(db);
      expect(store.getCurrentSession()?.id).toBe(sessionId);

      const scopeKey = store.getCurrentSession()!.scope_key!;
      expect(facts.get(HOT_PATH_STATE_KEYS.indexScope)).toBe(escapeIndexField(scopeKey));
      expect(facts.get(HOT_PATH_STATE_KEYS.scopeRoot)).toBe(
        normalizeFilePathKey(store.resolveScopeRoot(scopeKey)!),
      );
      expect(facts.get(HOT_PATH_STATE_KEYS.pathFold)).toBe(
        process.platform === 'win32' || process.platform === 'darwin' ? 'lower' : 'none',
      );
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it('inject-header does not turn substitution on — it is opt-in (AC #6)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-hotpath-off-'));
    const originalCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.chdir(tempDir);
      await createProgram().parseAsync(['node', 'cortex', 'inject-header', '--quiet']);
      expect(isSubstitutionEnabled(tempDir)).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it('inject-header clears a stale turn marker — a crash must not suppress a whole turn', async () => {
    // Review-found: only the Stop hook removed `.cortex.turn-reads`, so a
    // session that died without one carried the marker into the next session
    // and silently declined every refund for the files it listed. SessionStart
    // is a new turn by definition.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-marker-'));
    fs.writeFileSync(path.join(tempDir, '.cortex.turn-reads'), 'src/stale.ts\n');
    const originalCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.chdir(tempDir);
      await createProgram().parseAsync(['node', 'cortex', 'inject-header', '--quiet']);
      expect(fs.existsSync(path.join(tempDir, '.cortex.turn-reads'))).toBe(false);
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

/**
 * Seed at the *legacy* project-root path on purpose.
 *
 * After story 2.5 the CLI reads `$CORTEX_HOME/projects/<id>/cortex.db`, so
 * every command run against a project seeded this way also exercises the
 * migration: if copy-and-verify ever stops preserving data, these tests fail
 * with a missing row rather than passing against a store nobody moved.
 */
function seedTempProject(seed: (store: CortexStore) => void): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cli-memory-'));
  const db = openDatabase(path.join(tempDir, '.cortex.db'));
  ensureCortexSchema(db, tempDir);
  seed(new CortexStore(db));
  db.close();
  return tempDir;
}

/**
 * Reopen the store a CLI command actually wrote.
 *
 * Reading `<cwd>/.cortex.db` back would open the *original*, which migration
 * deliberately leaves in place and never updates again — so assertions against
 * it would silently check a frozen copy and pass for the wrong reason.
 */
function openProjectDb(cwd: string): ReturnType<typeof openDatabase> {
  // **Strict: the computed path only.** An earlier version fell back to
  // `<cwd>/.cortex.db` when the computed path was absent, which made every
  // assertion here pass whether or not the store had moved — reverting all
  // three transports to the pre-relocation path left the entire suite green.
  // A helper that tolerates both answers cannot test which one is right.
  return openDatabase(resolveStoreIdentity(cwd).dbPath);
}

/**
 * The seeded project-root store, for the few tests whose command refuses before
 * opening anything — nothing migrated, so "unchanged" is asserted where the
 * data actually still is. Named separately so each test states which store it
 * means rather than a helper guessing.
 */
function openSeededLegacyDb(cwd: string): ReturnType<typeof openDatabase> {
  return openDatabase(path.join(cwd, '.cortex.db'));
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

    const db = openProjectDb(cwd);
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

    const db = openProjectDb(cwd);
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

    const db = openProjectDb(cwd);
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

    const db = openProjectDb(cwd);
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

    const db = openSeededLegacyDb(cwd);
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
    const db = openSeededLegacyDb(cwd);
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

    const db = openProjectDb(cwd);
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
    const midDb = openProjectDb(cwd);
    expect(new CortexStore(midDb).getMemoryItem('doomed')).toBeTruthy();
    midDb.close();

    const deleted = await runCommand(cwd, ['delete-memory', 'doomed', '--yes']);
    expect(deleted.exitCode).toBeFalsy();
    expect(deleted.stdout).toContain('deleted doomed');

    const db = openProjectDb(cwd);
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

    const db = openProjectDb(cwd);
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

    const db = openProjectDb(cwd);
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
    const db = openProjectDb(cwd);
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

    const before = openSeededLegacyDb(cwd);
    const beforeStore = new CortexStore(before);
    expect(beforeStore.getNote(decisionA)!.conflict).toBe(true);
    expect(beforeStore.getNote(blockerId)!.conflict).toBe(false);
    before.close();

    const run = await runCommand(cwd, ['note-resolve', '--id', blockerId]);
    expect(run.exitCode).toBeFalsy();

    // Resolving a note that is not part of the contest must leave the contest
    // standing — clearing is per-subject, so gating on `subject` alone wipes it.
    const db = openProjectDb(cwd);
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
    const db = openProjectDb(cwd);
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

// ── doctor (FR-23) ────────────────────────────────────────────────────

/**
 * A directory holding fake `jq`, `bash` and `cortex`, prepended to PATH so the
 * diagnostic resolves them without depending on what the runner happens to have
 * installed. Both bare and Windows-shim names, so one fixture serves both
 * platforms.
 *
 * `cortex` belongs here for the same reason `jq` and `bash` do, and it was the
 * omission that made this fixture lie. The SessionStart wiring the README
 * documents is `cortex inject-header --quiet`, so `doctor`'s N-6 interpreter
 * check resolves a BARE `cortex` on PATH — and `withSandbox` only PREPENDS this
 * directory, leaving the machine's own PATH searched behind it. Without a shim
 * the check was answered by whatever global install the developer happened to
 * have: green on a maintainer's machine, red on all four CI jobs, on both
 * operating systems. Not a platform difference — a clean-machine one.
 *
 * The files are empty on purpose. `doctor` LOCATES an interpreter and never
 * executes it, so a zero-byte file is a faithful fixture and needs no exec bit
 * (`resolveExecutable` stats, it does not check X_OK).
 */
function seedFakeBinDir(): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bin-'));
  // `.cmd` is the shim npm writes for a global bin on Windows; the
  // extension-less name is what a POSIX PATH carries and what `PATHEXT`
  // probing finds first on win32.
  for (const name of ['jq', 'bash', 'cortex', 'jq.exe', 'bash.exe', 'cortex.cmd']) {
    fs.writeFileSync(path.join(binDir, name), '');
  }
  return binDir;
}

/**
 * A complete, passing installation, DERIVED from `REQUIRED_WIRING`.
 *
 * Hand-written until Story 5.2, which added a seventh entry and turned every
 * report built from this fixture red. Deriving it means the eighth entry needs
 * no third repair — this and `doctor.test.ts`'s `healthyWiring` were the two
 * places that had to be edited by hand.
 *
 * Each entry carries the matcher its wiring declares. The first version omitted
 * them all — an absent matcher matches every tool, so it passed — which left the
 * sandbox-home path never exercising a real matcher shape at all. Review named
 * that as the one gap the derived fixtures did not close.
 */
function seedSandboxHome(hooksDir: string): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-'));
  const posixHooks = hooksDir.replace(/\\/g, '/');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

  const hooks: Record<string, unknown[]> = {};
  for (const required of REQUIRED_WIRING) {
    const command =
      required.script === undefined
        ? 'cortex inject-header --quiet'
        : `bash "${posixHooks}/${required.script}"${required.action === undefined ? '' : ` ${required.action}`}`;
    const entries = hooks[required.event] ?? [];
    entries.push({
      ...(required.matcher === undefined ? {} : { matcher: required.matcher }),
      hooks: [{ type: 'command', command }],
    });
    hooks[required.event] = entries;
  }

  fs.writeFileSync(
    path.join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      mcpServers: { cortex: { command: 'cortex', args: ['serve'] } },
      hooks,
    }),
  );
  return homeDir;
}

/**
 * Sandbox `HOME`/`USERPROFILE`/`PATH` for the duration of a call.
 *
 * Without it these tests read the developer's real `~/.claude/settings.json`
 * and real hooks directory — and for `install`, *write* them. Module-scoped so
 * every test that reaches an environment-sensitive command can use it.
 */
async function withSandbox<T>(homeDir: string, binDir: string, run: () => Promise<T>): Promise<T> {
  const original = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  try {
    process.env['PATH'] = `${binDir}${path.delimiter}${original.PATH ?? ''}`;
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    process.env['HOME'] = homeDir;
    process.env['USERPROFILE'] = homeDir;
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('the relocation, through the transports rather than the resolver', () => {
  /** A real repository, so identity is the git-common-dir hash and not a fallback. */
  function initRepo(name: string): { repo: string; home: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-transport-'));
    const repo = path.join(root, name);
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
    };
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Cortex Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    return { repo, home: path.join(root, 'home') };
  }

  async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
    const saved = process.env['CORTEX_HOME'];
    try {
      process.env['CORTEX_HOME'] = home;
      clearProjectStoreCache();
      return await run();
    } finally {
      if (saved === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = saved;
      clearProjectStoreCache();
    }
  }

  it('puts the store under CORTEX_HOME and leaves none in the project root', async () => {
    // The property the whole story exists for, asserted against a command the
    // user actually runs. Every other test in this file reaches the store
    // through a helper, so all of them would pass against a transport that
    // never moved — which is exactly what a reviewer measured.
    const { repo, home } = initRepo('proj');
    await withHome(home, async () => {
      const run = await runCommand(repo, ['status']);
      expect(run.exitCode).toBeUndefined();

      const identity = resolveStoreIdentity(repo);
      expect(identity.degraded).toBe(false);
      expect(fs.existsSync(identity.dbPath)).toBe(true);
      expect(identity.dbPath.startsWith(path.resolve(home))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.cortex.db'))).toBe(false);
    });
  });

  it('reports, and then performs, an adoption after the repository moves', async () => {
    const { repo, home } = initRepo('before');
    await withHome(home, async () => {
      await runCommand(repo, ['status']);
      const first = resolveStoreIdentity(repo);
      const db = openDatabase(first.dbPath);
      const store = new CortexStore(db);
      const session = store.createSession({ cwd: repo });
      store.insertNote({
        sessionId: session.id,
        kind: 'decision',
        content: 'the decision that must survive a rename',
        subject: 'survives',
      });
      db.close();

      const moved = path.join(path.dirname(repo), 'after');
      fs.renameSync(repo, moved);
      clearProjectStoreCache();

      // An ambient start happens first, as it always would.
      await runCommand(moved, ['status']);
      clearProjectStoreCache();

      const doctor = await runCommand(moved, ['doctor', '--json']);
      const report = JSON.parse(doctor.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      const adoption = report.checks.find(check => check.id === 'store-adoption');
      expect(adoption?.status).toBe('warn');
      expect(adoption?.detail).toContain(first.dbPath);

      const store1 = await runCommand(moved, ['store']);
      expect(store1.stdout).toContain('Adoptable:');

      const preview = await runCommand(moved, ['adopt']);
      expect(preview.stdout).toContain('Would adopt:');
      // Preview-by-default: the orphan is untouched until --yes.
      expect(fs.existsSync(first.dbPath)).toBe(true);
    });
  });

  it('`adopt --yes` moves the store and recovers its memory', async () => {
    // Deliberately no ambient run at the new path first. These tests share one
    // process, and the CLI's store handle stays open after `runCommand`
    // returns — on win32 that locks the placeholder, so removing it fails for a
    // reason no real invocation encounters. The preceding test covers the
    // ambient-start-first path; this one covers the move.
    const { repo, home } = initRepo('before');
    await withHome(home, async () => {
      await runCommand(repo, ['status']);
      const first = resolveStoreIdentity(repo);
      const db = openDatabase(first.dbPath);
      const store = new CortexStore(db);
      const session = store.createSession({ cwd: repo });
      store.insertNote({
        sessionId: session.id,
        kind: 'decision',
        content: 'the decision that must survive a rename',
        subject: 'survives',
      });
      db.close();

      const moved = path.join(path.dirname(repo), 'after');
      fs.renameSync(repo, moved);
      clearProjectStoreCache();

      const performed = await runCommand(moved, ['adopt', '--yes']);
      expect(performed.exitCode).toBeUndefined();
      expect(performed.stdout).toContain('Adopted');

      clearProjectStoreCache();
      const identity = resolveStoreIdentity(moved);
      const adopted = openDatabase(identity.dbPath);
      try {
        const row = adopted
          .prepare("SELECT COUNT(*) AS c FROM notes WHERE content LIKE '%must survive a rename%'")
          .get() as { c: number };
        expect(row.c).toBe(1);
      } finally {
        adopted.close();
      }
      // The store now in use is the computed one, not the orphan.
      expect(identity.dbPath).not.toBe(first.dbPath);
      // Removing the source is deliberately best-effort — it must never turn a
      // completed adoption into a reported failure — and these tests share one
      // process where the earlier `runCommand` still holds the file open, so
      // the removal is expected to be skipped here. That it *is* removed under
      // a clean handle is asserted in `tests/store-identity.test.ts`.
    });
  });
});

describe('cortex stats reports the footprint (FR-25 AC #3)', () => {
  it('names database and WAL size separately', async () => {
    const cwd = seedTempProject(store => {
      const session = store.createSession({ cwd: '/tmp/stats' });
      store.insertNote({
        sessionId: session.id,
        kind: 'decision',
        content: 'a decision worth storing',
        subject: 'stats',
      });
    });

    const run = await runCommand(cwd, ['stats']);

    expect(run.exitCode).toBeUndefined();
    // Separately, not as one "footprint" number: a WAL parked at its
    // high-water mark beside a database that is not growing is precisely what
    // folding them together would hide.
    expect(run.stdout).toMatch(/^Database: +\d/m);
    expect(run.stdout).toMatch(/^WAL: +\d/m);

    // The VALUES, not just the labels. Asserting only the shape let a reviewer
    // swap the two numbers, and hard-code both to `0 B`, with the suite green.
    const identity = resolveStoreIdentity(cwd);
    const expectedDb = fs.statSync(identity.dbPath).size;
    expect(run.stdout).toContain(`Database:      ${formatBytes(expectedDb)}`);
    expect(run.stdout).toContain(`WAL:           ${formatBytes(walSizeBytes(identity.dbPath))}`);
    // And the database is genuinely the larger of the two here, so a swap moves
    // both lines rather than being invisible in a store where they happen to match.
    expect(expectedDb).toBeGreaterThan(walSizeBytes(identity.dbPath));
  });

  it('does not report a WAL that its own open created', async () => {
    // `openCortexDb` runs ensureCortexSchema and its backfills — all writes — so
    // reading the sidecar straight afterwards reported a WAL the command itself
    // had just made: on a fresh store, `Database: 4.0 KB / WAL: 704.1 KB`. A
    // 176:1 ratio of its own making, on the one command whose job is to show the
    // real ratio.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-stats-fresh-'));

    const run = await runCommand(cwd, ['stats']);

    expect(run.exitCode).toBeUndefined();
    const wal = /^WAL: +(.+)$/m.exec(run.stdout)?.[1] ?? '';
    const database = /^Database: +(.+)$/m.exec(run.stdout)?.[1] ?? '';
    // Nothing is holding this store, so the checkpoint reclaims everything and
    // the whole footprint is in the database file where it belongs.
    expect(wal).toBe('0 B');
    expect(database).not.toBe('0 B');
  });

  it('formats byte sizes in whole units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB');
    // Never a negative or NaN size in a report.
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('no transport derives a project-root store path', () => {
  // An architectural guard, and labelled as one. `handleHookPayload` and
  // `handleToolCall` are handed an already-open store, so the MCP and hook
  // transports' own `openCortexDb` is only reachable through a stdio server or
  // a stdin-driven `main` — neither testable in process. Without this, those
  // two files can be reverted to `path.join(startDir, '.cortex.db')` with the
  // whole suite still green.
  //
  // `readFileSync` rather than a grep. The original reason — `hook-entry.ts`
  // held a raw NUL byte, so ripgrep and grep classified it as binary and
  // skipped it silently — no longer applies: Story 4.5 replaced all four NULs
  // with escapes and `tests/substitution.test.ts` now walks `src/`, `hooks/`
  // and `tests/` failing on any control byte but tab, LF and CR. Reading the
  // file directly is kept anyway, because it does not depend on that guard
  // continuing to hold.
  const TRANSPORTS = [
    'src/transports/cli.ts',
    'src/transports/mcp.ts',
    'src/transports/hook-entry.ts',
  ];

  it.each(TRANSPORTS)('%s opens through openProjectStore', file => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source).toContain('openProjectStore');
    // The literal may still appear in a comment or an ignore list; what must
    // not appear is a path join that reconstructs the old location.
    expect(source).not.toMatch(/path\.join\(\s*startDir\s*,\s*'\.cortex\.db'\s*\)/);
    expect(source).not.toMatch(/path\.join\(\s*process\.cwd\(\)\s*,\s*'\.cortex\.db'\s*\)/);
  });
});

describe('cortex doctor', () => {
  it('exits non-zero on a broken installation and names a fix for each failure', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-doctor-cli-'));
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-'));
    const run = await withSandbox(emptyHome, seedFakeBinDir(), () =>
      runCommand(cwd, ['doctor']),
    );

    // A bare directory has neither engagement state nor a store.
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('Cortex doctor');
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('fix:');
    // And it created neither of them while looking.
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('--json carries the same verdict as the table', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-doctor-cli-'));
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-'));
    const run = await withSandbox(emptyHome, seedFakeBinDir(), () =>
      runCommand(cwd, ['doctor', '--json']),
    );
    const parsed = JSON.parse(run.stdout) as {
      ok: boolean;
      failures: number;
      checks: Array<{ id: string; status: string; fix?: string }>;
    };

    expect(run.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toBeGreaterThan(0);
    expect(parsed.checks.filter(check => check.status === 'fail').length).toBe(parsed.failures);
    for (const check of parsed.checks.filter(entry => entry.status !== 'pass')) {
      expect(check.fix, `check ${check.id} has no fix`).toBeTruthy();
    }
  });

  it('agrees with install-hooks: a freshly installed hook reports current, and exits zero', async () => {
    // The round trip is the guarantee. `install-hooks` stamps the template it
    // rendered; `doctor` recomputes the digest from the same template. If the
    // two ever disagree, a correct install reports itself out of date forever
    // and the fix it names does not work.
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hooks-'));
    // Fully sandboxed, and the cwd is a temp project. `install-hooks` is now
    // an alias for the whole install, so running it from the repository root
    // against the real HOME would write the developer's settings.json and the
    // repository's own .gitignore. That happened once; it does not again.
    const installHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-'));
    const installProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-proj-'));
    await withSandbox(installHome, seedFakeBinDir(), () =>
      runCommand(installProject, ['install-hooks', '--dir', hooksDir]),
    );

    // Driven by HOOK_SCRIPTS, not a hand-written list: a hardcoded list means
    // the next script Cortex ships is silently exempt from this round trip.
    for (const script of HOOK_SCRIPTS) {
      const installed = fs.readFileSync(path.join(hooksDir, script), 'utf8');
      expect(installed).not.toMatch(/__CORTEX_[A-Z_]+__/);
      expect(installed).toMatch(/# cortex-hook-template: [0-9a-f]{16}/);
    }

    const binDir = seedFakeBinDir();
    // `install-hooks` bakes `<module dir>/cli.js` and `<module dir>/hook-entry.js`.
    // Vitest imports from `src/`, where those are `.ts`, so the baked paths do
    // not exist under test and the Node-resolution check correctly fails.
    // Repoint them at real files so the rest of the report can be asserted
    // green; the template stamp is a separate line and is left untouched, so
    // this does not weaken the round trip being tested.
    // Driven by HOOK_SCRIPTS, not a hand-written list: a hardcoded list means
    // the next script Cortex ships is silently exempt from this round trip.
    for (const script of HOOK_SCRIPTS) {
      const installedPath = path.join(hooksDir, script);
      fs.writeFileSync(
        installedPath,
        fs
          .readFileSync(installedPath, 'utf8')
          .replaceAll(path.join(process.cwd(), 'src', 'transports', 'cli.js'), path.join(binDir, 'jq'))
          .replaceAll(
            path.join(process.cwd(), 'src', 'transports', 'hook-entry.js'),
            path.join(binDir, 'jq'),
          ),
      );
    }

    const homeDir = seedSandboxHome(hooksDir);
    const cwd = seedTempProject(() => {});
    fs.writeFileSync(deriveEngagementPath(cwd), 'enabled=true\n');

    const run = await withSandbox(homeDir, binDir, () => runCommand(cwd, ['doctor', '--json']));
    const parsed = JSON.parse(run.stdout) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const currency = parsed.checks.find(check => check.id === 'hook-currency');
    expect(`${currency?.status}: ${currency?.detail}`).toBe(
      'pass: installed scripts match the templates shipped by this build',
    );

    // Both interpreters must resolve FROM THE SANDBOX, and this asserts the
    // resolved paths rather than settling for `pass`. `withSandbox` only
    // prepends the fake bin directory, so the runner's real PATH is still
    // searched behind it — and the SessionStart wiring names a bare `cortex`,
    // which exists only where the package is globally installed. That leak is
    // exactly how this test read green on a maintainer's machine while failing
    // on every CI job. Asserting where each interpreter came from means the
    // leak fails here instead of passing by accident, on both platforms.
    const interpreter = parsed.checks.find(check => check.id === 'hook-interpreter');
    expect(interpreter?.status).toBe('pass');
    expect(interpreter?.detail).toContain(path.join(binDir, 'cortex'));
    expect(interpreter?.detail).toContain(path.join(binDir, 'bash'));

    // Nothing may FAIL. Kept as an exact list rather than a count so a new
    // failure names itself instead of shifting a number.
    const failing = parsed.checks.filter(check => check.status === 'fail');
    expect(failing.map(check => `${check.id}: ${check.detail}`)).toEqual([]);

    // The only warnings permitted are the two story 2.5 introduces for a
    // project that is not a git repository and has not migrated yet. Asserting
    // the ids exactly means a *third* warning cannot slip in unnoticed — which
    // is the property the original `!== 'pass'` check was really protecting.
    const warned = parsed.checks.filter(check => check.status === 'warn');
    expect(warned.map(check => check.id).sort()).toEqual(['store', 'store-legacy']);

    // And the pre-relocation store is diagnosed rather than declared missing.
    const database = parsed.checks.find(check => check.id === 'database');
    expect(database?.status).toBe('pass');
    expect(database?.detail).toContain('pre-relocation path');

    expect(parsed.ok).toBe(true);
    expect(run.exitCode).toBeUndefined();
  });
});

describe('cortex install (CLI layer)', () => {
  /** A sandboxed home + project + fake PATH, ready for an install run. */
  function seedInstallSandbox(): { home: string; project: string; bin: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ihome-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-iproj-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    return { home, project, bin: seedFakeBinDir() };
  }

  it('exits non-zero when the diagnostic fails, even though every action succeeded', async () => {
    // The story's §6 contract: "the install's exit code is the diagnostic's".
    // A fresh project has no store and no engagement, so install succeeds and
    // doctor fails — and the exit code must follow doctor.
    const { home, project, bin } = seedInstallSandbox();
    const run = await withSandbox(home, bin, () => runCommand(project, ['install']));

    expect(run.stdout).toContain('Install complete.');
    expect(run.stdout).toContain('Cortex doctor');
    expect(run.exitCode).toBe(1);
  });

  it('takes its exit code from the diagnostic, not from its own outcome', async () => {
    // The story's §6 contract. A second run changes nothing — every action is
    // `unchanged` and `refusals` is 0 — and it must still exit non-zero while
    // the diagnostic is failing.
    const { home, project, bin } = seedInstallSandbox();
    await withSandbox(home, bin, () => runCommand(project, ['install']));

    const second = await withSandbox(home, bin, () => runCommand(project, ['install']));
    expect(second.stdout).toContain('Nothing changed');
    expect(second.exitCode).toBe(1);
  });

  it('--json carries the diagnostic, so a scripted caller can see why it failed', async () => {
    const { home, project, bin } = seedInstallSandbox();
    const run = await withSandbox(home, bin, () => runCommand(project, ['install', '--json']));

    const parsed = JSON.parse(run.stdout) as {
      refusals: number;
      diagnostic: { ok: boolean; checks: Array<{ id: string; status: string; fix?: string }> } | null;
    };
    expect(run.exitCode).toBe(1);
    expect(parsed.refusals).toBe(0);
    // Exiting 1 with `refusals: 0` and nothing else is an unreadable answer
    // for the one consumer that cannot read the text report.
    expect(parsed.diagnostic).not.toBeNull();
    expect(parsed.diagnostic?.ok).toBe(false);
    for (const check of parsed.diagnostic!.checks.filter(c => c.status === 'fail')) {
      expect(check.fix, `${check.id} has no fix`).toBeTruthy();
    }
  });

  it('--dry-run writes nothing and does not run the diagnostic', async () => {
    const { home, project, bin } = seedInstallSandbox();
    const run = await withSandbox(home, bin, () => runCommand(project, ['install', '--dry-run']));

    expect(run.stdout).toContain('dry run — nothing written');
    expect(run.stdout).not.toContain('Cortex doctor');
    expect(run.exitCode).toBeUndefined();
    expect(fs.readdirSync(project)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude', 'hooks'))).toBe(false);
  });

  it('rejects an unknown --scope instead of silently writing user scope', async () => {
    const { home, project, bin } = seedInstallSandbox();
    const run = await withSandbox(home, bin, () => runCommand(project, ['install', '--scope', 'porject']));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('unknown --scope');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('refuses --codex rather than pointing Claude Code at the Codex hooks directory', async () => {
    const { home, project, bin } = seedInstallSandbox();
    const run = await withSandbox(home, bin, () => runCommand(project, ['install-hooks', '--codex']));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('--codex is no longer supported');
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('writes wiring that survives a home directory containing a space', async () => {
    // `C:\Users\John Smith`. Unquoted, the shell splits the path and all three
    // .sh wirings silently never fire.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sp-'));
    const home = path.join(parent, 'John Smith');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-iproj-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    await withSandbox(home, seedFakeBinDir(), () => runCommand(project, ['install']));

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };

    for (const event of ['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']) {
      const command = settings.hooks[event]![0]!.hooks[0]!.command;
      const scriptToken = tokenizeCommand(command).find(token => token.endsWith('.sh'));
      expect(scriptToken, `${event} lost its script path to tokenization`).toContain('John Smith');
      expect(fs.existsSync(scriptToken!.replace(/\//g, path.sep))).toBe(true);
    }
  });
});

describe('onlyUnusedProject', () => {
  const report = (checks: DoctorCheck[]): DoctorReport => ({
    project: '/p',
    hooks_dir: '/h',
    checks,
    failures: checks.filter(c => c.status === 'fail').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    ok: checks.every(c => c.status !== 'fail'),
  });
  const fail = (id: string): DoctorCheck => ({ id, label: id, status: 'fail', detail: '', fix: 'x' });
  const pass = (id: string): DoctorCheck => ({ id, label: id, status: 'pass', detail: '' });

  it('is true when only engagement and database fail', () => {
    expect(onlyUnusedProject(report([fail('engagement'), fail('database'), pass('jq')]))).toBe(true);
    expect(onlyUnusedProject(report([fail('database')]))).toBe(true);
  });

  it('is false when anything else fails alongside them', () => {
    // The reassurance must not appear over a genuinely broken installation.
    expect(onlyUnusedProject(report([fail('engagement'), fail('jq')]))).toBe(false);
    expect(onlyUnusedProject(report([fail('hook-currency')]))).toBe(false);
  });

  it('is false when nothing fails, so it never appears on a clean run', () => {
    expect(onlyUnusedProject(report([pass('jq'), pass('database')]))).toBe(false);
  });

  it('gates the EXIT CODE, not just the reassuring sentence', () => {
    // The reassurance was already gated on `onlyUnusedProject`; the exit code
    // was not, so a successful install into a never-run project reported
    // failure. Measured on a clean Linux container: the two commands the
    // README opens with ended in a red report and a non-zero status with
    // nothing wrong — which aborts any scripted or Dockerfile install at its
    // first step. These pin the two together.
    expect(installExitCode(report([fail('engagement'), fail('database'), pass('jq')]))).toBe(0);
    expect(installExitCode(report([fail('database')]))).toBe(0);
  });

  it('still fails the install when anything real is broken', () => {
    // The whole point of running the diagnostic from `install`: actions can
    // all succeed and leave an installation that cannot work.
    expect(installExitCode(report([fail('engagement'), fail('jq')]))).toBe(1);
    expect(installExitCode(report([fail('hook-currency')]))).toBe(1);
    expect(installExitCode(report([fail('database'), fail('node')]))).toBe(1);
  });

  it('is zero on a clean report', () => {
    expect(installExitCode(report([pass('jq'), pass('database')]))).toBe(0);
  });
});

describe('renderInstallResult', () => {
  const result = (actions: InstallAction[]): InstallResult => ({
    actions,
    unchanged: actions.every(a => a.outcome === 'unchanged'),
    refusals: actions.filter(a => a.outcome === 'refused').length,
    dry_run: false,
    hooks_dir: '/hooks',
    settings_path: '/settings.json',
  });

  it('distinguishes the outcomes rather than printing one badge', () => {
    const output = renderInstallResult(
      result([
        { id: 'a', target: '/a', outcome: 'created', detail: 'installed' },
        { id: 'b', target: '/b', outcome: 'unchanged', detail: 'already current' },
        { id: 'c', target: '/c', outcome: 'refused', detail: 'nope', fix: 'do the thing' },
      ]),
    );
    expect(output).toContain('NEW ');
    expect(output).toContain('SAME');
    expect(output).toContain('STOP');
    expect(output).toContain('fix: do the thing');
  });

  it('does not claim nothing was left half-done when actions were applied', () => {
    const output = renderInstallResult(
      result([
        { id: 'a', target: '/a', outcome: 'created', detail: 'installed' },
        { id: 'b', target: '/b', outcome: 'refused', detail: 'nope', fix: 'x' },
      ]),
    );
    expect(output).not.toContain('nothing else was left half-done');
    expect(output).toContain('1 other action already applied');
  });

  it('says nothing was written when the first action refused', () => {
    const output = renderInstallResult(
      result([{ id: 'a', target: '/a', outcome: 'refused', detail: 'nope', fix: 'x' }]),
    );
    expect(output).toContain('nothing was written');
  });

  it('collapses a detail that would otherwise forge a row', () => {
    const output = renderInstallResult(
      result([
        { id: 'a', target: '/a\n  NEW   forged', outcome: 'refused', detail: 'x\ny', fix: 'p\nq' },
      ]),
    );
    expect(output.split('\n').filter(line => /^ {2}(NEW|WROTE|SAME|STOP)/.test(line))).toHaveLength(1);
    expect(output).toContain('fix: p q');
  });
});

describe('renderDoctorReport', () => {
  const report = (checks: DoctorCheck[]): DoctorReport => ({
    project: '/repo',
    hooks_dir: '/hooks',
    checks,
    failures: checks.filter(check => check.status === 'fail').length,
    warnings: checks.filter(check => check.status === 'warn').length,
    ok: checks.every(check => check.status !== 'fail'),
  });

  it('prints a badge and the detail, and the fix only for non-passing checks', () => {
    const output = renderDoctorReport(
      report([
        { id: 'a', label: 'Alpha', status: 'pass', detail: 'fine', fix: 'unused' },
        { id: 'b', label: 'Beta', status: 'fail', detail: 'broken', fix: 'do the thing' },
      ]),
    );
    expect(output).toContain('PASS  Alpha');
    expect(output).toContain('FAIL  Beta');
    expect(output).toContain('fix: do the thing');
    expect(output).not.toContain('fix: unused');
    expect(output).toContain('1 failing check, 0 warnings.');
  });

  it('collapses a detail that would otherwise forge a check row', () => {
    // Details interpolate settings paths and JSON parser messages — content
    // from user-controlled files on disk. A newline would forge a row; a lone
    // CR would let one detail overwrite the row above it.
    const output = renderDoctorReport(
      report([
        {
          id: 'a',
          label: 'Alpha',
          status: 'fail',
          detail: 'real\n  PASS  Forged   all good\rrewritten',
          fix: 'x\ny',
        },
      ]),
    );
    // One badge row, the real one. The forged text survives as *content* on
    // that row — which is the point: it is no longer a row of its own.
    const badgeRows = output.split('\n').filter(line => /^ {2}(PASS|WARN|FAIL) {2}/.test(line));
    expect(badgeRows).toHaveLength(1);
    expect(badgeRows[0]).toContain('FAIL  Alpha');
    expect(output).toContain('real PASS Forged all good rewritten');
    expect(output).toContain('fix: x y');
  });

  it('reports warnings without calling the run failed', () => {
    const output = renderDoctorReport(
      report([
        { id: 'a', label: 'Alpha', status: 'pass', detail: 'fine' },
        { id: 'b', label: 'Beta', status: 'warn', detail: 'iffy', fix: 'maybe' },
      ]),
    );
    expect(output).toContain('All 2 checks pass (1 warning).');
    expect(output).toContain('fix: maybe');
  });
});
