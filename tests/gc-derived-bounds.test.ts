import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySchema, ensureCortexSchema, initializeMeta } from '../src/db/schema.js';
import { runGc } from '../src/db/gc.js';
import { isAutoGcDisabled } from '../src/transports/cli.js';

/**
 * FR-16 (Story 4.6): bounding the derived cache.
 *
 * The defect this story exists to fix, measured 2026-08-04 on a copy of the live
 * 25.2 MB store: `runGc` reported `command_run_items.deleted = 4787` and the
 * database shrank to 13.8 MB — then ONE `ensureCortexSchema`, which every CLI
 * command triggers, restored all 5,434 rows and 24.3 MB. The cap deleted a
 * PROJECTION whose SOURCE survived, and `backfillMemoryItems` rebuilt it. GC was
 * reporting deletions it did not durably make: the AD-12 shape.
 */

/** `os.tmpdir()`, never a literal `/tmp` — different filesystems on win32. */
function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-gc-')));
}

interface Fixture {
  db: Database.Database;
  root: string;
}

function fixture(): Fixture {
  const root = tempRoot();
  const db = new Database(path.join(root, 'cortex.db'));
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  return { db, root };
}

function session(fx: Fixture, id: string, scopeKey: string): void {
  fx.db
    .prepare(
      'INSERT INTO sessions (id, started_at, worktree_path, scope_type, scope_key) VALUES (?,?,?,?,?)',
    )
    .run(id, '2026-08-01T00:00:00Z', fx.root, 'project', scopeKey);
}

/**
 * N command runs in one scope, oldest first.
 *
 * **One transaction, not N — this is a platform cost, not a style preference.**
 * `fixture()` opens with a raw `new Database(...)` rather than `openDatabase`,
 * so it inherits SQLite's DEFAULT `journal_mode = delete` and
 * `synchronous = FULL` (both read back from the live connection to confirm).
 * Every autocommit `.run()` is then its own transaction, and on Windows that is
 * a journal file created, written, fsynced, committed, deleted, plus an NTFS
 * directory-metadata update — per row. Measured here, 300 rows: **766 ms**
 * unbatched vs **3 ms** batched. On windows-latest the same loop cost ~10 s of
 * an 11.3 s test and timed the convergence case out at 10 s, while Linux and a
 * local NVMe absorbed it; that is also why the neighbours, which seed 20-50
 * rows, sat at 2-3 s each rather than failing.
 *
 * Production never pays this and the tax is the fixture's alone:
 * `openProjectStore` opens WAL with `synchronous = NORMAL` (19 ms for the same
 * 300 unbatched rows), and the only caller of `insertCommandRun`,
 * `handleCmdEvent`, is already inside `runInTransaction`.
 */
function commandRuns(fx: Fixture, sessionId: string, n: number): void {
  const insert = fx.db.prepare(
    'INSERT INTO command_runs (id, session_id, timestamp, category, command_summary) VALUES (?,?,?,?,?)',
  );
  fx.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      insert.run(`cr-${sessionId}-${i}`, sessionId, ts, 'test', `npm test ${i}`);
    }
  })();
}

const countRuns = (fx: Fixture): number =>
  (fx.db.prepare('SELECT COUNT(*) AS n FROM command_runs').get() as { n: number }).n;
const countItems = (fx: Fixture): number =>
  (
    fx.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE kind = 'command_run'").get() as {
      n: number;
    }
  ).n;

// ── The defect ───────────────────────────────────────────────────────

describe('the command-run cap survives a backfill (the Story 4.6 defect)', () => {
  it('bounds the SOURCE table, not just its projection', () => {
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 50);
    ensureCortexSchema(fx.db, fx.root);
    expect(countRuns(fx)).toBe(50);
    expect(countItems(fx)).toBe(50);

    const report = runGc(fx.db, { dryRun: false, commandRunCapPerScope: 10 });

    expect(report.command_runs.deleted).toBe(40);
    expect(countRuns(fx)).toBe(10);
  });

  it('STAYS pruned after the backfill that every CLI command triggers', () => {
    // The whole point. Before this story the projection came straight back,
    // because its source was untouched — 4,787 rows and 10.5 MB restored by one
    // command on the live store.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 50);
    ensureCortexSchema(fx.db, fx.root);

    runGc(fx.db, { dryRun: false, commandRunCapPerScope: 10 });
    ensureCortexSchema(fx.db, fx.root);

    expect(countRuns(fx)).toBe(10);
    expect(countItems(fx)).toBe(10);
  });

  it('keeps the NEWEST runs per scope, and caps each scope independently', () => {
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    session(fx, 's-2', 'project:beta');
    commandRuns(fx, 's-1', 30);
    commandRuns(fx, 's-2', 30);

    runGc(fx.db, { dryRun: false, commandRunCapPerScope: 5 });

    expect(countRuns(fx)).toBe(10);
    const kept = (
      fx.db.prepare('SELECT command_summary FROM command_runs').all() as Array<{
        command_summary: string;
      }>
    ).map(r => r.command_summary);
    expect(kept).toContain('npm test 29');
    expect(kept).not.toContain('npm test 0');
  });

  it('removes projection rows whose source is gone, whatever the ranking', () => {
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 20);
    ensureCortexSchema(fx.db, fx.root);
    // Delete a source row directly, the way a session cascade would.
    fx.db.prepare('DELETE FROM command_runs WHERE id = ?').run('cr-s-1-19');

    const report = runGc(fx.db, { dryRun: false, commandRunCapPerScope: 1000 });

    expect(report.orphaned_command_run_items.deleted).toBe(1);
    expect(countItems(fx)).toBe(19);
  });

  it('bounds the HEAD of the chain too — cmd events, which rebuild the runs', () => {
    // Bounding `command_runs` alone was STILL partially undone: measured on a
    // copy of the live store, gc brought runs to 647 and one
    // `ensureCortexSchema` restored 112, because `backfillCommandRuns`
    // (schema.ts:1282) re-inserts from `events WHERE type = 'cmd'`. The chain is
    // events -> command_runs -> memory_items and every link has a backfill, so
    // the only durable bound is at the head.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    const insert = fx.db.prepare(
      'INSERT INTO events (id, session_id, type, timestamp, metadata_json) VALUES (?,?,?,?,?)',
    );
    for (let i = 0; i < 40; i++) {
      insert.run(
        `ev-${i}`,
        's-1',
        'cmd',
        new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        JSON.stringify({ safe_summary: `npm test ${i}` }),
      );
    }

    runGc(fx.db, { dryRun: false, commandRunCapPerScope: 10 });
    ensureCortexSchema(fx.db, fx.root);

    const cmdEvents = (
      fx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'cmd'").get() as { n: number }
    ).n;
    expect(cmdEvents).toBe(10);
    // And the rebuild cannot exceed what the head allows.
    expect(countRuns(fx)).toBeLessThanOrEqual(10);
  });

  it('converges: repeated gc + backfill cycles do not grow the store', { timeout: 30_000 }, () => {
    // **Timeout raised HERE and nowhere else — `vitest.config.ts` stays at 10 s
    // deliberately, so a real hang anywhere else still fails fast.**
    //
    // This case does ~10x the database work of its neighbours: 300 seeded rows
    // against their 20-50, and three gc + backfill cycles against their one. A
    // windows-latest runner's fsync is roughly an order of magnitude slower than
    // ext4 or a local NVMe, which is what turned 1.5 s locally into 11.3 s on
    // CI. With the batched seed above the body measures 93 ms locally and
    // projects to ~1-2 s on that runner, so 30 s is more than 10x headroom over
    // the slowest observed platform — generous enough that disk speed can never
    // flake this, tight enough that a hang or a regression reintroducing
    // superlinear work still fails rather than passing slowly.
    //
    // The work is NOT superlinear today, and that is measured, not assumed: the
    // three cycles cost 9/4/4 ms of gc and 29/23/26 ms of backfill and settle at
    // 25/25/25 runs. VACUUM never fires here (the freelist ratio stays under the
    // 0.2 threshold), so it is not part of the cost either.
    //
    // A bound that oscillates upward is not a bound. Measured on the live store
    // copy: 5,434 runs / 25.2 MB settles at 759 / 11.4 MB and holds there across
    // five cycles.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 300);

    const settled: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      runGc(fx.db, { dryRun: false, commandRunCapPerScope: 25 });
      ensureCortexSchema(fx.db, fx.root);
      settled.push(countRuns(fx));
    }

    expect(settled[0]).toBeLessThanOrEqual(25);
    expect(settled[1]).toBe(settled[0]);
    expect(settled[2]).toBe(settled[0]);
  });

  it('refuses a cap of 0 rather than deleting every command in every scope', () => {
    // `0` is the spelling an operator types to turn something off — it is one of
    // the values that disables `CORTEX_GC_AUTO`. On a ROW cap it would mean keep
    // nothing at all, permanently, unattended at session start. Every other bad
    // value was already rejected; this one was accepted.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 30);

    const prior = process.env['CORTEX_GC_COMMAND_RUN_CAP'];
    try {
      process.env['CORTEX_GC_COMMAND_RUN_CAP'] = '0';
      runGc(fx.db, { dryRun: false });
    } finally {
      if (prior === undefined) delete process.env['CORTEX_GC_COMMAND_RUN_CAP'];
      else process.env['CORTEX_GC_COMMAND_RUN_CAP'] = prior;
    }

    // Falls through to the default of 200, so all 30 survive.
    expect(countRuns(fx)).toBe(30);
    expect(runGc(fx.db, { dryRun: false, commandRunCapPerScope: 0 }) && countRuns(fx)).toBe(30);
  });

  it('does not clamp a large cap down to a date range', () => {
    // The first fix routed this through `normalizeDays`, whose clamp is
    // `MAX_RETENTION_DAYS` — a bound that exists because a retention WINDOW
    // becomes an unrepresentable Date. Applied to a row count it silently turned
    // "keep a billion" into "keep 100,000", i.e. deleted MORE than asked: the
    // wrong direction for a bound.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 10);

    const report = runGc(fx.db, { dryRun: false, commandRunCapPerScope: 1_000_000 });

    expect(report.command_runs.deleted).toBe(0);
    expect(countRuns(fx)).toBe(10);
  });

  it('reads the cap with Number, so 1e9 is a billion and not 1', () => {
    // `envNumber` parses with `parseInt`, which succeeds on a PREFIX: `1e9` —
    // the natural way to disable the cap — became **1**. Before this story that
    // only deleted a projection the backfill restored; now the cap deletes cmd
    // events and command_runs permanently and unattended, so the parser had to
    // change with the blast radius. Fourth `parseInt` incident in this file.
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 30);

    const prior = process.env['CORTEX_GC_COMMAND_RUN_CAP'];
    try {
      process.env['CORTEX_GC_COMMAND_RUN_CAP'] = '1e9';
      runGc(fx.db, { dryRun: false });
    } finally {
      if (prior === undefined) delete process.env['CORTEX_GC_COMMAND_RUN_CAP'];
      else process.env['CORTEX_GC_COMMAND_RUN_CAP'] = prior;
    }

    expect(countRuns(fx)).toBe(30);
  });

  it('caps each NULL-scope session separately, not all of them together', () => {
    // SQL `PARTITION BY` groups every NULL into ONE partition, so "200 per
    // scope" silently became 200 in total for stores migrated up from a
    // pre-scope schema version.
    const fx = fixture();
    for (const id of ['s-1', 's-2']) {
      fx.db
        .prepare('INSERT INTO sessions (id, started_at, worktree_path) VALUES (?,?,?)')
        .run(id, '2026-08-01T00:00:00Z', fx.root);
      commandRuns(fx, id, 20);
    }

    runGc(fx.db, { dryRun: false, commandRunCapPerScope: 10 });

    expect(countRuns(fx)).toBe(20);
  });

  it('changes nothing on a dry run, which is still the default', () => {
    const fx = fixture();
    session(fx, 's-1', 'project:alpha');
    commandRuns(fx, 's-1', 50);

    const report = runGc(fx.db, { commandRunCapPerScope: 10 });

    expect(report.dry_run).toBe(true);
    expect(report.command_runs.candidates).toBe(40);
    expect(report.command_runs.deleted).toBe(0);
    expect(countRuns(fx)).toBe(50);
  });
});

// ── The ruling: auto-GC on by default ────────────────────────────────

describe('automatic GC is on by default (AC #5, ruling 2026-08-04)', () => {
  it('is enabled when the variable is unset', () => {
    expect(isAutoGcDisabled(undefined)).toBe(false);
  });

  it('is disabled only by an explicit off switch', () => {
    for (const value of ['off', 'never', 'false', '0', 'OFF', ' Never ']) {
      expect(isAutoGcDisabled(value)).toBe(true);
    }
  });

  it('is WIRED to the session-start path, applying rather than previewing', () => {
    // Four mutations of this wiring survived the whole 1,588-test suite: the
    // call site inverted so the bound never runs; the ambient path switched to
    // `dryRun: true` so it previews forever; the `Last cleanup:` line deleted;
    // and `cortex gc` flipped to apply-by-default. The last is the dangerous
    // one — `cortex gc` silently becoming destructive was invisible. The
    // predicate above was pinned in isolation while nothing pinned its use.
    const cli = fs.readFileSync(
      path.join(process.cwd(), 'src', 'transports', 'cli.ts'),
      'utf8',
    );

    // The ambient (SessionStart) path: gated on the opt-out, and it APPLIES.
    expect(cli).toContain("!isAutoGcDisabled(process.env['CORTEX_GC_AUTO'])");
    expect(cli).toContain('runGc(gcDb, { dryRun: false })');

    // The manual command still PREVIEWS unless --apply is given (AC #3).
    expect(cli).toContain('runGc(db, { dryRun: !opts.apply, vacuum })');

    // And the inert-bound surface stays: GC having never run is what let the
    // reference store reach half its budget with nobody noticing.
    //
    // Asserted on the STATEMENT THAT WRITES IT, not the bare label — the label
    // also appears in the comment above it, so `toContain('Last cleanup:')`
    // passed with the output line renamed away. Caught by mutation.
    expect(cli).toContain('`Last cleanup:  ${lastGc ??');
  });

  it('stays ON for an unrecognised value, including the historical "apply"', () => {
    // A typo must not silently disable the bound and quietly restore the state
    // this ruling ended — GC never running on any store (AD-12).
    for (const value of ['apply', 'on', 'yes', 'true', '', 'aply', 'nope']) {
      expect(isAutoGcDisabled(value)).toBe(false);
    }
  });
});
