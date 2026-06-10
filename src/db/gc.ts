import type Database from 'better-sqlite3';

/**
 * Garbage collection for a Cortex database. Conservative by design: only
 * derived/raw data is pruned (events of consolidated sessions, retrieval log,
 * raw ledger rows after rollup, never-accessed archived items, excess
 * command_run items). Sessions, notes, snapshots, and summaries are kept.
 */
export interface GcOptions {
  /** Delete events of consolidated (ended + summarized) sessions older than this. */
  eventDays?: number;
  retrievalLogDays?: number;
  retrievalLogKeep?: number;
  /** Roll up raw ledger rows older than this into one row per session/direction. */
  ledgerDays?: number;
  /** Delete archived memory items with zero accesses older than this. */
  archivedDays?: number;
  commandRunCapPerScope?: number;
  dryRun?: boolean;
  vacuum?: 'auto' | 'always' | 'never';
  now?: Date;
}

export interface GcCategoryReport {
  candidates: number;
  deleted: number;
}

export interface GcReport {
  dry_run: boolean;
  events: GcCategoryReport;
  retrieval_log: GcCategoryReport;
  token_ledger: GcCategoryReport;
  archived_memory_items: GcCategoryReport;
  command_run_items: GcCategoryReport;
  freelist_ratio: number;
  vacuumed: boolean;
}

const DEFAULTS = {
  eventDays: 30,
  retrievalLogDays: 30,
  retrievalLogKeep: 2000,
  ledgerDays: 14,
  archivedDays: 90,
  commandRunCapPerScope: 200,
} as const;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveGcOptions(options: GcOptions = {}): Required<Omit<GcOptions, 'now'>> & { now: Date } {
  return {
    eventDays: options.eventDays ?? envNumber('CORTEX_GC_EVENT_DAYS') ?? DEFAULTS.eventDays,
    retrievalLogDays:
      options.retrievalLogDays ?? envNumber('CORTEX_GC_RETRIEVAL_LOG_DAYS') ?? DEFAULTS.retrievalLogDays,
    retrievalLogKeep:
      options.retrievalLogKeep ?? envNumber('CORTEX_GC_RETRIEVAL_LOG_KEEP') ?? DEFAULTS.retrievalLogKeep,
    ledgerDays: options.ledgerDays ?? envNumber('CORTEX_GC_LEDGER_DAYS') ?? DEFAULTS.ledgerDays,
    archivedDays: options.archivedDays ?? envNumber('CORTEX_GC_ARCHIVED_DAYS') ?? DEFAULTS.archivedDays,
    commandRunCapPerScope:
      options.commandRunCapPerScope ??
      envNumber('CORTEX_GC_COMMAND_RUN_CAP') ??
      DEFAULTS.commandRunCapPerScope,
    dryRun: options.dryRun ?? true,
    vacuum: options.vacuum ?? 'auto',
    now: options.now ?? new Date(),
  };
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countThenDelete(
  db: Database.Database,
  countSql: string,
  deleteSql: string,
  params: unknown[],
  dryRun: boolean,
): GcCategoryReport {
  const row = db.prepare(countSql).get(...params) as { count: number };
  const candidates = row.count;
  if (dryRun || candidates === 0) {
    return { candidates, deleted: 0 };
  }

  const result = db.prepare(deleteSql).run(...params);
  return { candidates, deleted: result.changes };
}

const CONSOLIDATED_EVENTS_WHERE = `
  timestamp < ?
  AND session_id IN (
    SELECT s.id FROM sessions s
    WHERE s.status = 'ended'
      AND EXISTS (
        SELECT 1 FROM state st WHERE st.session_id = s.id AND st.layer = 'session'
      )
  )`;

const RETRIEVAL_LOG_WHERE = `
  created_at < ?
  AND rowid NOT IN (SELECT rowid FROM retrieval_log ORDER BY rowid DESC LIMIT ?)`;

const ARCHIVED_ITEMS_WHERE = `
  state = 'archived' AND access_count = 0 AND created_at < ?`;

const COMMAND_RUN_OVERFLOW_SQL = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY scope_key ORDER BY created_at DESC
    ) AS rn
    FROM memory_items
    WHERE kind = 'command_run'
  ) WHERE rn > ?`;

function rollupLedger(
  db: Database.Database,
  cutoff: string,
  dryRun: boolean,
): GcCategoryReport {
  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM token_ledger WHERE timestamp < ? AND type != 'rollup'`)
    .get(cutoff) as { count: number };
  const candidates = countRow.count;
  if (dryRun || candidates === 0) {
    return { candidates, deleted: 0 };
  }

  let deleted = 0;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO token_ledger (id, session_id, type, direction, tokens, timestamp)
       SELECT lower(hex(randomblob(16))), session_id, 'rollup', direction, SUM(tokens), MAX(timestamp)
       FROM token_ledger
       WHERE timestamp < ? AND type != 'rollup'
       GROUP BY session_id, direction`,
    ).run(cutoff);
    const result = db
      .prepare(`DELETE FROM token_ledger WHERE timestamp < ? AND type != 'rollup'`)
      .run(cutoff);
    deleted = result.changes;
  });
  tx();

  return { candidates, deleted };
}

function freelistRatio(db: Database.Database): number {
  const freelist = db.pragma('freelist_count', { simple: true }) as number;
  const pages = db.pragma('page_count', { simple: true }) as number;
  return pages > 0 ? freelist / pages : 0;
}

export function runGc(db: Database.Database, options: GcOptions = {}): GcReport {
  const resolved = resolveGcOptions(options);
  const { now, dryRun } = resolved;

  const events = countThenDelete(
    db,
    `SELECT COUNT(*) as count FROM events WHERE ${CONSOLIDATED_EVENTS_WHERE}`,
    `DELETE FROM events WHERE ${CONSOLIDATED_EVENTS_WHERE}`,
    [isoDaysAgo(now, resolved.eventDays)],
    dryRun,
  );

  const retrievalLog = countThenDelete(
    db,
    `SELECT COUNT(*) as count FROM retrieval_log WHERE ${RETRIEVAL_LOG_WHERE}`,
    `DELETE FROM retrieval_log WHERE ${RETRIEVAL_LOG_WHERE}`,
    [isoDaysAgo(now, resolved.retrievalLogDays), resolved.retrievalLogKeep],
    dryRun,
  );

  const ledger = rollupLedger(db, isoDaysAgo(now, resolved.ledgerDays), dryRun);

  const archived = countThenDelete(
    db,
    `SELECT COUNT(*) as count FROM memory_items WHERE ${ARCHIVED_ITEMS_WHERE}`,
    `DELETE FROM memory_items WHERE ${ARCHIVED_ITEMS_WHERE}`,
    [isoDaysAgo(now, resolved.archivedDays)],
    dryRun,
  );

  const commandRuns = countThenDelete(
    db,
    `SELECT COUNT(*) as count FROM memory_items WHERE id IN (${COMMAND_RUN_OVERFLOW_SQL})`,
    `DELETE FROM memory_items WHERE id IN (${COMMAND_RUN_OVERFLOW_SQL})`,
    [resolved.commandRunCapPerScope],
    dryRun,
  );

  const ratio = freelistRatio(db);
  let vacuumed = false;
  if (!dryRun && resolved.vacuum !== 'never') {
    if (resolved.vacuum === 'always' || ratio > 0.2) {
      try {
        db.exec('VACUUM');
        vacuumed = true;
      } catch {
        // VACUUM can fail under concurrent access; the next run retries.
      }
    }
  }

  if (!dryRun) {
    try {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'last_gc_at',
        now.toISOString(),
      );
    } catch {
      // Bookkeeping only.
    }
  }

  return {
    dry_run: dryRun,
    events,
    retrieval_log: retrievalLog,
    token_ledger: ledger,
    archived_memory_items: archived,
    command_run_items: commandRuns,
    freelist_ratio: Number(ratio.toFixed(4)),
    vacuumed,
  };
}

/** True when the last applied GC is older than the interval (default 24h). */
export function shouldAutoGc(db: Database.Database, now: Date = new Date(), intervalHours = 24): boolean {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_gc_at') as
      | { value: string }
      | undefined;
    if (!row) {
      return true;
    }
    const last = Date.parse(row.value);
    if (!Number.isFinite(last)) {
      return true;
    }
    return now.getTime() - last > intervalHours * 60 * 60 * 1000;
  } catch {
    return false;
  }
}
