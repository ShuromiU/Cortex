import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_WAL_MAX_BYTES,
  checkpointWal,
  databaseSizeBytes,
  ensureCortexSchema,
  maybeCheckpointWal,
  openDatabase,
  openDatabaseReadOnly,
  resolveWalMaxBytes,
  walPath,
  walSizeBytes,
} from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  closeAllProjectStores,
  closeProjectStore,
  openProjectStore,
  clearProjectStoreCache,
} from '../src/scope/store-migration.js';

const require = createRequire(import.meta.url);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-wal-'));
  clearProjectStoreCache();
});

afterEach(() => {
  clearProjectStoreCache();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* an open handle on win32 must not fail a passing test */
  }
});

/** A store with enough committed data to leave a WAL worth measuring. */
function seedWal(dbPath: string, rows: number): ReturnType<typeof openDatabase> {
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, path.dirname(dbPath));
  const store = new CortexStore(db);
  const session = store.createSession({ cwd: path.dirname(dbPath) });
  for (let i = 0; i < rows; i++) {
    store.insertNote({
      sessionId: session.id,
      kind: 'insight',
      content: `padding note ${i} ${'x'.repeat(400)}`,
      subject: `s${i}`,
    });
  }
  return db;
}

describe('checkpointWal', () => {
  it('shrinks the WAL file, which a passive checkpoint does not', () => {
    const dbPath = path.join(root, 'cortex.db');
    const db = seedWal(dbPath, 600);

    const before = walSizeBytes(dbPath);
    expect(before).toBeGreaterThan(0);

    // The pre-assert that makes this test adversarial: SQLite's own
    // autocheckpoint runs PASSIVE, and PASSIVE resets the WAL for reuse without
    // returning the space. If TRUNCATE were swapped for PASSIVE the size below
    // would not move.
    db.pragma('wal_checkpoint(PASSIVE)');
    expect(walSizeBytes(dbPath)).toBe(before);

    const result = checkpointWal(db);

    expect(result).not.toBeNull();
    expect(result?.busy).toBe(false);
    expect(walSizeBytes(dbPath)).toBe(0);
    db.close();
  });

  it('reports busy without throwing when a reader holds the file', () => {
    const dbPath = path.join(root, 'cortex.db');
    const db = seedWal(dbPath, 400);

    const reader = openDatabaseReadOnly(dbPath);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM notes').get();

    const result = checkpointWal(db);

    // busy is the ORDINARY outcome here, not a failure: Cortex's own MCP server
    // is a long-lived reader. The frames still move; only the file cannot be
    // reclaimed. Asserting `walSize === 0` after any checkpoint is the flake
    // this test exists to document.
    expect(result).not.toBeNull();
    expect(result?.busy).toBe(true);
    expect(result?.checkpointed).toBeGreaterThan(0);

    reader.exec('COMMIT');
    reader.close();

    const after = checkpointWal(db);
    expect(after?.busy).toBe(false);
    expect(walSizeBytes(dbPath)).toBe(0);
    db.close();
  });

  it('returns null rather than throwing on a closed handle', () => {
    const dbPath = path.join(root, 'cortex.db');
    const db = seedWal(dbPath, 5);
    db.close();
    expect(checkpointWal(db)).toBeNull();
  });
});

describe('the configured threshold', () => {
  it('defaults, and rejects values that are not a positive number', () => {
    expect(resolveWalMaxBytes({})).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '   ' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: 'nonsense' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '0' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '-1' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '8192' })).toBe(8192);
  });

  it('refuses a fraction or a sub-page ceiling', () => {
    // `Number` accepts these where `parseInt` would not, and a ceiling below one
    // page means every call checkpoints — cheap now that checkpoints never wait,
    // but pointless I/O on every hook fire.
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '0.5' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '1024.5' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '1024' })).toBe(DEFAULT_WAL_MAX_BYTES);
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '4096' })).toBe(4096);
  });

  it('accepts exponent notation, which parseInt would silently truncate', () => {
    // `gc`'s neighbouring `envNumber` uses parseInt, which succeeds on a prefix:
    // `4e6` becomes 4, turning a 4 MB ceiling into a 4-byte one that checkpoints
    // on every single call. Same trap as `resolvePageLimit` in story 2.1.
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '4e6' })).toBe(4_000_000);
    expect(Number.parseInt('4e6', 10)).toBe(4);
  });

  it('checkpoints only once the WAL is over the ceiling', () => {
    const dbPath = path.join(root, 'cortex.db');
    const db = seedWal(dbPath, 600);
    const size = walSizeBytes(dbPath);
    expect(size).toBeGreaterThan(0);

    // Under the ceiling: nothing happens, and the WAL is left alone.
    expect(maybeCheckpointWal(db, dbPath, { CORTEX_WAL_MAX_BYTES: String(size * 10) })).toBeNull();
    expect(walSizeBytes(dbPath)).toBe(size);

    // Over it: the checkpoint runs.
    const result = maybeCheckpointWal(db, dbPath, { CORTEX_WAL_MAX_BYTES: '4096' });
    expect(result).not.toBeNull();
    expect(walSizeBytes(dbPath)).toBe(0);
    db.close();
  });

  it('measures the WAL without creating it', () => {
    // `statSync`, not a query: opening the database to ask would materialise the
    // sidecar it is measuring — story 2.3's finding about read-only opens.
    const dbPath = path.join(root, 'absent.db');
    expect(walSizeBytes(dbPath)).toBe(0);
    expect(databaseSizeBytes(dbPath)).toBe(0);
    expect(fs.existsSync(walPath(dbPath))).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe('the transports actually wire it', () => {
  const source = (file: string): string =>
    fs.readFileSync(path.join(process.cwd(), file), 'utf8');

  /**
   * These tests spawn `dist/`, while the rest of the suite imports `src/`.
   * A stale build therefore tests code that is not the code under review — it
   * cost an hour here, where a child reported zero exit listeners because
   * `dist/` still held a mutation the source no longer had. Fail loudly rather
   * than silently proving nothing.
   */
  function assertDistIsCurrent(sourceFile: string, distFile: string): void {
    const src = fs.statSync(path.join(process.cwd(), sourceFile)).mtimeMs;
    const out = fs.statSync(path.join(process.cwd(), distFile)).mtimeMs;
    expect(
      out,
      `${distFile} is older than ${sourceFile}; run \`npm run build\` — these tests spawn dist/`,
    ).toBeGreaterThanOrEqual(src);
  }

  /**
   * Run a real transport as a child process against a store with a parked WAL,
   * and report whether the sidecar survived the process ending.
   *
   * **This replaces three `expect(source).toContain('installStoreCloseOnExit()')`
   * assertions**, which a reviewer killed by commenting the call out in all
   * three transports with the whole suite still green — a source-string check
   * is satisfied by a call inside a comment. It is the exact failure this
   * story's own Dev Notes quoted from 2.5 ("assert the close happens through
   * the transport") and then committed anyway.
   */
  function walSurvivesProcess(
    entry: string,
    argv: string[],
    buildStdin: ((project: string) => string) | undefined,
    exitMode: 'drain' | 'exit',
  ): { before: number; after: number } {
    const home = fs.mkdtempSync(path.join(root, 'child-home-'));
    const project = fs.mkdtempSync(path.join(root, 'child-proj-'));

    // Create the store, then let this process release it entirely.
    const opened = openProjectStore(project, { env: { CORTEX_HOME: home } });
    const dbPath = opened.dbPath;
    closeProjectStore(opened.db);

    // Park a WAL with NOBODY holding it. A connection kept open in this process
    // would block the child's checkpoint and the test would "fail" for a reason
    // the product never encounters — so the writer is a child that calls
    // `process.exit()`, which skips better-sqlite3's destructor and leaves the
    // sidecar exactly as a crashed hook would.
    const parker = spawnSync(
      process.execPath,
      [
        '-e',
        [
          'const D=require(process.argv[1]);',
          'const db=new D(process.argv[2]);',
          "db.pragma('journal_mode = WAL');",
          // A scratch table, not `notes`: this fixture exists to leave frames in
          // the WAL, and matching the real schema's constraints would make it
          // fail for reasons that have nothing to do with checkpointing.
          "db.exec('CREATE TABLE IF NOT EXISTS _wal_padding(a TEXT)');",
          "const i=db.prepare('INSERT INTO _wal_padding VALUES (?)');",
          "const pad='x'.repeat(400);",
          'for(let n=0;n<2000;n++) i.run(pad);',
          'process.exit(0);',
        ].join(''),
        require.resolve('better-sqlite3'),
        dbPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(parker.status, `parker failed: ${parker.stderr}`).toBe(0);

    const before = walSizeBytes(dbPath);

    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), entry), ...argv],
      {
        cwd: project,
        env: { ...process.env, CORTEX_HOME: home, CORTEX_EXIT_MODE: exitMode },
        input: buildStdin ? buildStdin(project) : '',
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.error, `child failed: ${result.error?.message}`).toBeUndefined();

    return { before, after: walSizeBytes(dbPath) };
  }

  it('the exit handler is what saves a store on a process.exit() path', () => {
    // **The honest scope of the wiring.** A natural drain closes through
    // better-sqlite3's own teardown, so removing `installStoreCloseOnExit()`
    // from all three transports leaves an ordinary command still checkpointing
    // — a reviewer proved that, and it is why the two child tests below cannot
    // detect the wiring at all. What has no other close is `process.exit()`, an
    // uncaught error, and a signal. This exercises the first through the real
    // exported functions rather than a source-string match.
    assertDistIsCurrent('src/scope/store-migration.ts', 'dist/scope/store-migration.js');
    const home = fs.mkdtempSync(path.join(root, 'exit-home-'));
    const project = fs.mkdtempSync(path.join(root, 'exit-proj-'));
    const script = [
      "const m = require(process.argv[1]);",
      "const db = m.openProjectStore(process.argv[2], { env: { CORTEX_HOME: process.argv[3] } });",
      "db.db.exec('CREATE TABLE IF NOT EXISTS _pad(a TEXT)');",
      "const i = db.db.prepare('INSERT INTO _pad VALUES (?)');",
      "const pad = 'x'.repeat(400);",
      'for (let n = 0; n < 2000; n++) i.run(pad);',
      'process.stdout.write(db.dbPath);',
      // INSTALL is toggled by argv[4] so the two branches differ by one call.
      "if (process.argv[4] === 'install') m.installStoreCloseOnExit();",
      'process.exit(0);',
    ].join('');
    const entry = path.join(process.cwd(), 'dist/scope/store-migration.js');

    const run = (mode: string): number => {
      const proj = fs.mkdtempSync(path.join(project, `${mode}-`));
      const result = spawnSync(process.execPath, ['-e', script, entry, proj, home, mode], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, `child failed: ${result.stderr}`).toBe(0);
      return walSizeBytes(result.stdout.trim());
    };

    // Without the handler, `process.exit()` skips the destructor: the WAL stays.
    expect(run('bare')).toBeGreaterThan(0);
    // With it, the same exit path checkpoints.
    expect(run('install')).toBe(0);
  });

  // POSIX only. On win32 `child.kill()` is `TerminateProcess`, which runs no
  // handler at all, so this would fail for a platform reason rather than a code
  // one. It is the only *behavioural* test that can distinguish a transport
  // which installs the handler from one that does not — see the inventory
  // assertions below for why nothing else can.
  const signalIt = process.platform === 'win32' ? it.skip : it;

  signalIt('the MCP server checkpoints when a signal stops it', async () => {
    assertDistIsCurrent('src/transports/cli.ts', 'dist/transports/cli.js');
    const home = fs.mkdtempSync(path.join(root, 'sig-home-'));
    const project = fs.mkdtempSync(path.join(root, 'sig-proj-'));

    const opened = openProjectStore(project, { env: { CORTEX_HOME: home } });
    const dbPath = opened.dbPath;
    closeProjectStore(opened.db);

    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/transports/cli.js'), 'serve'], {
      cwd: project,
      env: { ...process.env, CORTEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Give the server time to open its store and park some WAL.
    await new Promise(resolve => setTimeout(resolve, 1500));
    child.kill('SIGTERM');
    await new Promise(resolve => child.on('exit', resolve));

    expect(walSizeBytes(dbPath)).toBe(0);
    expect(fs.existsSync(walPath(dbPath))).toBe(false);
  });

  it.each([
    ['src/transports/cli.ts'],
    ['src/transports/hook-entry.ts'],
    ['src/transports/mcp.ts'],
  ])('%s installs the close handler (inventory, not proof)', file => {
    // **Labelled honestly.** A reviewer killed the earlier version of this by
    // commenting the call out in all three transports with the suite green, and
    // that survival is real information rather than a fixable test: on an
    // ordinary drain better-sqlite3's destructor closes anyway, and no transport
    // command exits via `process.exit()` while holding a store. The wiring earns
    // its place on signals and uncaught errors, and only the POSIX signal test
    // above can observe it. This is an inventory so a *fourth* transport cannot
    // be added without one — it does not prove the existing three work.
    const body = source(file);
    const calls = body.match(/^\s*installStoreCloseOnExit\(\);/gm) ?? [];
    expect(calls.length, `${file} has no uncommented installStoreCloseOnExit() call`).toBe(1);
  });

  it('closeProjectStore reports the checkpoint it ran', () => {
    // Kills the mutation that drops the explicit checkpoint. Without an
    // assertion on the return value nothing can distinguish it from `close()`'s
    // implicit one, which is exactly why a reviewer's version of this mutation
    // survived.
    const project = fs.mkdtempSync(path.join(root, 'result-proj-'));
    const opened = openProjectStore(project, { env: { CORTEX_HOME: path.join(root, 'result-home') } });
    const result = closeProjectStore(opened.db);
    expect(result).not.toBeNull();
    expect(result?.busy).toBe(false);
  });

  it('the CLI checkpoints when its process ends', () => {
    assertDistIsCurrent('src/transports/cli.ts', 'dist/transports/cli.js');
    const { before, after } = walSurvivesProcess('dist/transports/cli.js', ['status'], undefined, 'drain');
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });

  it('the hook transport checkpoints when its process ends', () => {
    assertDistIsCurrent('src/transports/hook-entry.ts', 'dist/transports/hook-entry.js');
    const { before, after } = walSurvivesProcess(
      'dist/transports/hook-entry.js',
      ['end-of-turn'],
      // The payload's `cwd` is what the hook resolves its store from. Passing
      // this process's cwd pointed the child at the *repository's* store and
      // the temp one was never touched — a green-looking failure.
      project => JSON.stringify({ cwd: project }),
      'drain',
    );
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });

  it('end-of-turn checkpoints, and no reflex path does', () => {
    const hookEntry = source('src/transports/hook-entry.ts');

    // Exactly ONE call site, not "the first one is in the right place". The
    // earlier version compared `indexOf` positions, so *adding* a checkpoint to
    // `reflectFromPayload` — the PreToolUse Edit/Write path AC #2 forbids —
    // left the suite green because the first occurrence was still correct.
    const callSites = hookEntry.match(/maybeCheckpointWal\(/g) ?? [];
    expect(callSites).toHaveLength(1);

    const endOfTurnAt = hookEntry.indexOf('function endOfTurn');
    const reflectAt = hookEntry.indexOf('function reflectFromPayload');
    const checkpointAt = hookEntry.indexOf('maybeCheckpointWal(');
    expect(endOfTurnAt).toBeGreaterThan(-1);
    expect(reflectAt).toBeGreaterThan(-1);
    expect(checkpointAt).toBeGreaterThan(endOfTurnAt);
    expect(checkpointAt).toBeLessThan(reflectAt > endOfTurnAt ? reflectAt : Number.MAX_SAFE_INTEGER);
  });

  it('the flush path checkpoints too', () => {
    // The `flush-spool` call site had zero coverage: deleting it left the suite
    // green. It is the site the detached PostToolUse flush actually reaches.
    const cli = source('src/transports/cli.ts');
    const flushAt = cli.indexOf(".command('flush-spool')");
    expect(flushAt).toBeGreaterThan(-1);
    const nextCommandAt = cli.indexOf(".command(", flushAt + 10);
    const body = cli.slice(flushAt, nextCommandAt > flushAt ? nextCommandAt : undefined);
    expect(body).toContain('maybeCheckpointWal(');
  });

  it('a checkpoint never waits on a busy database', () => {
    // The regression that matters most: inheriting `busy_timeout = 5000` made
    // every checkpoint a five-second stall under contention, measured at 5518 ms
    // and reaching `reflect-pre` — the path this story excluded by design —
    // through the exit handler. A duration assertion is the only thing that
    // catches it; the suite already contained a 6-second test nobody questioned.
    const dbPath = path.join(root, 'nowait.db');
    const db = seedWal(dbPath, 400);
    const reader = openDatabaseReadOnly(dbPath);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM notes').get();

    const started = process.hrtime.bigint();
    const result = checkpointWal(db);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(result?.busy).toBe(true);
    expect(elapsedMs, `checkpoint blocked for ${elapsedMs.toFixed(0)} ms`).toBeLessThan(1000);

    reader.exec('COMMIT');
    reader.close();
    db.close();
  });

  it('restores the busy timeout it borrowed', () => {
    const dbPath = path.join(root, 'restore.db');
    const db = seedWal(dbPath, 20);
    const before = db.pragma('busy_timeout', { simple: true });
    checkpointWal(db);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(before);
    db.close();
  });

  it('the capture hook reaches the checkpoint only through a detached flush', () => {
    // The structural half of "blocks no hook" (AC #2). `PostToolUse` never
    // checkpoints inline; it appends to the spool in pure bash and, only past
    // the 256 KiB threshold, launches `flush-spool` in a BACKGROUNDED subshell
    // so the hook returns immediately. That detached flush is where the
    // checkpoint runs — the critical path is left alone by construction, not
    // by a latency budget someone has to keep re-measuring.
    const capture = fs.readFileSync(
      path.join(process.cwd(), 'hooks/claude/cortex-capture.sh'),
      'utf8',
    );

    // No checkpoint inline in the hook itself.
    expect(capture).not.toContain('checkpoint');

    // Every Node invocation in this script is detached.
    const nodeLines = capture
      .split(/\r?\n/)
      .filter(line => line.includes('__CORTEX_NODE__') && !line.trimStart().startsWith('#'));
    expect(nodeLines.length).toBeGreaterThan(0);
    for (const line of nodeLines) {
      expect(line, `not detached: ${line}`).toMatch(/&\s*\)\s*$/);
    }
  });
});

describe('closing a project store', () => {
  it('checkpoints and removes the sidecar', () => {
    const project = path.join(root, 'proj');
    fs.mkdirSync(project);
    const home = path.join(root, 'home');

    const opened = openProjectStore(project, { env: { CORTEX_HOME: home } });
    const store = new CortexStore(opened.db);
    const session = store.createSession({ cwd: project });
    for (let i = 0; i < 600; i++) {
      store.insertNote({
        sessionId: session.id,
        kind: 'insight',
        content: `padding ${i} ${'x'.repeat(400)}`,
        subject: `s${i}`,
      });
    }
    expect(walSizeBytes(opened.dbPath)).toBeGreaterThan(0);

    closeProjectStore(opened.db);

    expect(walSizeBytes(opened.dbPath)).toBe(0);
    expect(fs.existsSync(walPath(opened.dbPath))).toBe(false);
    // And the data is intact — a checkpoint moves frames into the database, it
    // does not discard them.
    const reopened = openDatabaseReadOnly(opened.dbPath);
    try {
      const row = reopened.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number };
      expect(row.c).toBe(600);
    } finally {
      reopened.close();
    }
  });

  it('is idempotent and never throws on an already-closed store', () => {
    const project = path.join(root, 'proj');
    fs.mkdirSync(project);
    const opened = openProjectStore(project, { env: { CORTEX_HOME: path.join(root, 'home') } });
    expect(() => closeProjectStore(opened.db)).not.toThrow();
    expect(() => closeProjectStore(opened.db)).not.toThrow();
    expect(opened.db.open).toBe(false);
  });

  it('closeAllProjectStores closes every handle this process opened', () => {
    const home = path.join(root, 'home');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    const first = openProjectStore(a, { env: { CORTEX_HOME: home } });
    const second = openProjectStore(b, { env: { CORTEX_HOME: home } });
    expect(first.db.open).toBe(true);
    expect(second.db.open).toBe(true);

    closeAllProjectStores();

    expect(first.db.open).toBe(false);
    expect(second.db.open).toBe(false);
    // Registry emptied, so a second sweep is a no-op rather than a double close.
    expect(() => closeAllProjectStores()).not.toThrow();
  });
});
