import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    expect(resolveWalMaxBytes({ CORTEX_WAL_MAX_BYTES: '1024' })).toBe(1024);
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
    const result = maybeCheckpointWal(db, dbPath, { CORTEX_WAL_MAX_BYTES: '1' });
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
  // 2.5's review found all three transports revertible with the whole suite
  // green, because only the helper was tested. These assert the wiring itself.
  // `readFileSync`, not grep: `hook-entry.ts` carries a raw NUL byte, so
  // ripgrep classifies it as binary and skips it silently.
  const source = (file: string): string =>
    fs.readFileSync(path.join(process.cwd(), file), 'utf8');

  it.each([
    ['src/transports/cli.ts', 'CLI process'],
    ['src/transports/hook-entry.ts', 'hook process'],
    ['src/transports/mcp.ts', 'MCP server'],
  ])('%s installs the close-on-exit handler', file => {
    expect(source(file)).toContain('installStoreCloseOnExit()');
  });

  it('end-of-turn checkpoints, and no reflex path does', () => {
    const hookEntry = source('src/transports/hook-entry.ts');
    expect(hookEntry).toContain('maybeCheckpointWal');

    // The constraint that matters: the checkpoint sits in `endOfTurn`, not in
    // `reflectFromPayload`. `reflect-pre` fires on every Edit and Write, and a
    // checkpoint there would put the cost on the user's tool call — which is
    // what AC #2's "blocks no hook" forbids.
    const endOfTurnAt = hookEntry.indexOf('function endOfTurn');
    const reflectAt = hookEntry.indexOf('function reflectFromPayload');
    const checkpointAt = hookEntry.indexOf('maybeCheckpointWal(');
    expect(endOfTurnAt).toBeGreaterThan(-1);
    expect(reflectAt).toBeGreaterThan(-1);
    expect(checkpointAt).toBeGreaterThan(endOfTurnAt);
    expect(checkpointAt).toBeLessThan(reflectAt > endOfTurnAt ? reflectAt : Number.MAX_SAFE_INTEGER);
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
