import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexStore } from '../db/store.js';
import {
  handleAgentEvent,
  handleCmdEvent,
  handleEditEvent,
  handleReadEvent,
  handleWriteEvent,
} from './hooks.js';

/**
 * Ambient-capture spool: hook scripts append one JSON line per tool event
 * (no Node spawn), and a single flush replays the batch into the store.
 *
 * Replayed events get flush-time DB timestamps; the original `ts` orders the
 * replay and stays available in the spool line. Flushes are expected within
 * the same turn (Stop hook), at a size threshold, or at the next session
 * start — close enough that capture-time vs flush-time skew does not matter.
 */
export interface SpoolEntry {
  v?: number;
  ts?: string;
  seq?: number;
  tool: 'read' | 'edit' | 'write' | 'cmd' | 'agent' | string;
  file?: string;
  lines?: string;
  cmd?: string;
  exit?: string;
  stdout?: string;
  stderr?: string;
  desc?: string;
}

export interface SpoolFlushResult {
  processed: number;
  skipped: number;
}

const SPOOL_FILENAME = '.cortex.spool.jsonl';
const PROCESSED_MARKER_PREFIX = 'spool_processed:';

export function deriveSpoolPath(dir: string): string {
  const override = process.env['CORTEX_SPOOL_DIR'];
  const base = override && override.length > 0 ? override : dir;
  return path.join(base, SPOOL_FILENAME);
}

/** Node-side append matching what the bash hooks write with `>>`. */
export function appendSpoolEntry(dir: string, entry: SpoolEntry): void {
  const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(deriveSpoolPath(dir), `${line}\n`);
}

export function spoolSizeBytes(dir: string): number {
  try {
    return fs.statSync(deriveSpoolPath(dir)).size;
  } catch {
    return 0;
  }
}

function parseSpoolLines(raw: string): SpoolEntry[] {
  const entries: SpoolEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as SpoolEntry;
      if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string') {
        entries.push(parsed);
      }
    } catch {
      // Torn or corrupt line: skip it, keep the batch.
    }
  }

  return entries.sort((left, right) => {
    const ts = (left.ts ?? '').localeCompare(right.ts ?? '');
    if (ts !== 0) {
      return ts;
    }
    return (left.seq ?? 0) - (right.seq ?? 0);
  });
}

function replayEntry(store: CortexStore, sessionId: string, entry: SpoolEntry): boolean {
  switch (entry.tool) {
    case 'read':
      if (!entry.file) return false;
      handleReadEvent(store, sessionId, {
        file: entry.file,
        ...(entry.lines ? { lines: entry.lines } : {}),
      });
      return true;
    case 'edit':
      if (!entry.file) return false;
      handleEditEvent(store, sessionId, {
        file: entry.file,
        ...(entry.lines ? { lines: entry.lines } : {}),
      });
      return true;
    case 'write':
      if (!entry.file) return false;
      handleWriteEvent(store, sessionId, { file: entry.file });
      return true;
    case 'cmd':
      if (!entry.cmd) return false;
      handleCmdEvent(store, sessionId, {
        cmd: entry.cmd,
        ...(entry.exit !== undefined ? { exit: entry.exit } : {}),
        ...(entry.stdout !== undefined ? { stdout: entry.stdout } : {}),
        ...(entry.stderr !== undefined ? { stderr: entry.stderr } : {}),
      });
      return true;
    case 'agent':
      if (!entry.desc) return false;
      handleAgentEvent(store, sessionId, { desc: entry.desc });
      return true;
    default:
      return false;
  }
}

function processClaimFile(
  store: CortexStore,
  sessionId: string,
  claimPath: string,
): SpoolFlushResult {
  let raw: string;
  try {
    raw = fs.readFileSync(claimPath, 'utf8');
  } catch {
    return { processed: 0, skipped: 0 };
  }

  const contentHash = crypto.createHash('sha1').update(raw).digest('hex');
  const markerKey = `${PROCESSED_MARKER_PREFIX}${contentHash}`;
  const entries = parseSpoolLines(raw);
  let processed = 0;
  let skipped = 0;

  if (entries.length > 0 && store.getMeta(markerKey) === undefined) {
    // One transaction per claim; the marker commits with the replay so a crash
    // between commit and unlink cannot double-apply the batch.
    store.runInTransaction(() => {
      for (const entry of entries) {
        if (replayEntry(store, sessionId, entry)) {
          processed++;
        } else {
          skipped++;
        }
      }
      store.setMeta(markerKey, new Date().toISOString());
    });
  } else {
    skipped = entries.length;
  }

  try {
    fs.unlinkSync(claimPath);
  } catch {
    // The processed marker protects against re-application.
  }

  return { processed, skipped };
}

/**
 * Claim and replay the spool. Crash-safe: an orphaned `.processing` claim from
 * an earlier run is consumed first; the live spool is claimed via atomic
 * rename so concurrent appends land in a fresh spool file.
 */
export function flushSpool(
  store: CortexStore,
  dir: string,
  sessionId: string,
): SpoolFlushResult {
  const spoolPath = deriveSpoolPath(dir);
  const claimPath = `${spoolPath}.processing`;
  let processed = 0;
  let skipped = 0;

  if (fs.existsSync(claimPath)) {
    const orphan = processClaimFile(store, sessionId, claimPath);
    processed += orphan.processed;
    skipped += orphan.skipped;
  }

  if (fs.existsSync(spoolPath)) {
    try {
      fs.renameSync(spoolPath, claimPath);
    } catch {
      // A concurrent flush claimed it; nothing left to do.
      return { processed, skipped };
    }
    const fresh = processClaimFile(store, sessionId, claimPath);
    processed += fresh.processed;
    skipped += fresh.skipped;
  }

  return { processed, skipped };
}
