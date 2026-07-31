#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import {
  handleReadEvent,
  handleEditEvent,
  handleWriteEvent,
  handleCmdEvent,
  handleAgentEvent,
} from '../capture/hooks.js';
import { flushSpool } from '../capture/spool.js';
import { runGc, shouldAutoGc } from '../db/gc.js';
import {
  consolidateLevel1,
  renderCompressed,
  mergeProjectState,
  writeSessionSummary,
} from '../capture/consolidate.js';
import {
  evaluateDatabase,
  type EvaluationOptions,
  type EvaluationResult,
  type QualityFixture,
} from '../eval/harness.js';
import { BASELINE_TRAILER, regenerateBaseline, runEvalGate } from '../eval/gate.js';
import type { EvaluationScenario } from '../eval/seed.js';
import { buildHeader, formatTokens } from '../query/state.js';
import { buildSessionBrief } from '../query/session-brief.js';
import { estimateTokens } from '../query/retrieval.js';
import { reflectMemory, type ReflexEvent } from '../query/reflex.js';
import {
  configureEngagementPath,
  deriveEngagementPath,
  readEngagement,
  renderCortexRoute,
} from './mcp.js';
import { ensureScopedSession, syncBranchSnapshotForSession } from '../scope/runtime.js';
import { refreshCurrentAppGraph } from '../scope/app-graph.js';
import { suggestNotes } from '../query/suggest-notes.js';
import {
  HOOK_SCRIPTS,
  TEMPLATE_ID_PLACEHOLDER,
  hookTemplateDigest,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from '../query/doctor.js';
import { validateMemory } from '../query/validate-memory.js';
import {
  listMemory,
  inspectMemory,
  ACCESS_HISTORY_LIMIT,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type MemoryInspection,
  type MemoryListPage,
} from '../query/inspect.js';
import {
  formatMemoryTimestamp,
  humanizeMemoryKind,
  renderMemorySnippet,
} from '../query/render.js';
import {
  editMemory,
  deleteMemory,
  previewMemoryDeletion,
  type MemoryDeletionPreview,
} from '../query/correct.js';

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): { store: CortexStore; dbPath: string } {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, startDir);
  const store = new CortexStore(db);
  return { store, dbPath };
}

function ensureSession(store: CortexStore, cwd: string): string {
  return ensureScopedSession(store, cwd).id;
}

function refreshCurrentGraphQuietly(store: CortexStore, cwd: string): void {
  try {
    refreshCurrentAppGraph(store, cwd);
  } catch {
    // Current-truth refresh should never block memory access.
  }
}

function parseTopics(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
}

/** The closed set of `memory_items.state` values, for `--state` validation. */
const KNOWN_MEMORY_STATES: ReadonlySet<string> = new Set([
  'pinned',
  'hot',
  'warm',
  'cold',
  'archived',
]);

/** Comma-separated option values, trimmed, empties dropped. */
function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

/**
 * Commander yields option values as raw strings, so a non-numeric `--limit`
 * arrives as `NaN` rather than an error. Passing it through unchanged lets
 * `resolvePageLimit` apply the single documented fallback instead of two
 * different ones in two places.
 *
 * `Number`, not `parseInt`: `parseInt` succeeds on a *prefix*, so `--limit 1e3`
 * silently becomes 1 and `--offset 0x10` silently becomes 0 — a partially
 * parsed value never reaches the `NaN` fallback, and the page size the
 * operator asked for is quietly replaced by a different one.
 */
function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw.trim());
  return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/**
 * Collapse a value onto one line for the listing.
 *
 * `renderMemorySnippet` already does this for item text, but `subject` reaches
 * the line raw, and `insertNote` only trims it — an embedded newline therefore
 * splits one item across two rows, the second of which is entirely
 * author-controlled text that reads as another entry.
 */
function collapseToLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip terminal control characters, keeping tabs and newlines.
 *
 * `inspect-memory` is the first surface that prints stored text untruncated,
 * and `captureOutputTail` strips only CRLF and NUL — so ESC, lone CR and BEL
 * from captured stderr survive into the store. Printed verbatim, a lone CR
 * lets stored content overwrite the line above it and an ESC sequence can
 * recolour or reposition the terminal. `--json` remains byte-faithful;
 * `JSON.stringify` escapes these rather than executing them.
 */
function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

/**
 * The trailer line a replacement text would be misread as, or null.
 *
 * `buildNoteMemoryText` appends `Subject:` / `Alternatives:` / `Conflict:` /
 * `Status:` after the content, and every reader that recovers those flags
 * (`isContested`, `renderedAlternatives`, `isSupersededMemoryItem`) is
 * trailer-scoped — it walks back from the end. Content ending in one of those
 * lines is therefore indistinguishable from real metadata, and the resulting
 * `[contested]` / `(superseded)` cannot be cleared, because `cortex_resolve`
 * clears a column while the marker is read from text. Stories 1.3 and 1.4
 * documented this as a bounded residual reachable only by authoring such a
 * note; `edit-memory --file` would make it a first-class input.
 */
function spoofedTrailerLine(text: string): string | null {
  const trailerPrefixes = ['subject:', 'alternatives:', 'conflict:', 'status:'];
  const lines = text.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }
    const lower = line.toLowerCase();
    const match = trailerPrefixes.find(prefix => lower.startsWith(prefix));
    // Only a *trailing* run of such lines is dangerous — the readers stop at
    // the first line that is not one, so a mid-text mention is inert.
    return match ? line : null;
  }

  return null;
}

/** Quote a value for the copy-pasteable next-page command. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9,._:@/+-]+$/.test(value) ? value : JSON.stringify(value);
}

const CHECK_BADGE: Record<DoctorCheck['status'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

/**
 * Render the diagnostic report.
 *
 * Details and fixes are collapsed onto one line: they interpolate settings-file
 * paths, script names and JSON parser messages, all of which come from
 * user-controlled files on disk. An embedded newline would otherwise forge a
 * check row, and a lone CR would let one check's detail overwrite the row above
 * it — the same discipline `list-memory` applies to stored strings. `--json`
 * stays byte-faithful.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `Cortex doctor — ${collapseToLine(report.project)}`,
    `Hooks directory: ${collapseToLine(report.hooks_dir ?? '(none configured)')}`,
    '',
  ];

  const width = Math.max(...report.checks.map(check => check.label.length));
  for (const check of report.checks) {
    lines.push(
      `  ${CHECK_BADGE[check.status]}  ${check.label.padEnd(width)}  ${collapseToLine(check.detail)}`,
    );
    if (check.status !== 'pass' && check.fix) {
      // Aligns under the detail column: 2 indent + 4 badge + 2 + label + 2.
      lines.push(`${' '.repeat(width + 10)}fix: ${collapseToLine(check.fix)}`);
    }
  }

  lines.push('');
  lines.push(
    report.ok
      ? `All ${report.checks.length} checks pass${report.warnings > 0 ? ` (${report.warnings} warning${report.warnings === 1 ? '' : 's'})` : ''}.`
      : `${report.failures} failing check${report.failures === 1 ? '' : 's'}, ${report.warnings} warning${report.warnings === 1 ? '' : 's'}.`,
  );
  return `${lines.join('\n')}\n`;
}

function describeListFilters(filter: MemoryListPage['filter']): string {
  const parts: string[] = [];
  if (filter.scopeKeys) {
    parts.push(`scope=${filter.scopeKeys.join(',')}`);
  }
  if (filter.kinds) {
    parts.push(`kind=${filter.kinds.join(',')}`);
  }
  if (filter.states) {
    parts.push(`state=${filter.states.join(',')}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}

function renderMemoryListPage(page: MemoryListPage): string {
  // An empty page has no range. Deriving `start` from the offset alone printed
  // inverted nonsense (`memory items 101-100 of 3`) for a caller paging past
  // the end, which is routine once rows are GC'd between pages.
  const empty = page.items.length === 0;
  const start = empty ? 0 : page.offset + 1;
  const end = empty ? 0 : page.offset + page.items.length;
  const lines = [
    `memory items ${start}-${end} of ${page.total} · ${page.order} · filters: ${describeListFilters(page.filter)}`,
  ];

  if (empty) {
    lines.push(
      page.total === 0
        ? 'no items match these filters.'
        : `offset ${page.offset} is past the end; ${page.total} item(s) match.`,
    );
    return lines.join('\n');
  }

  // Widths come from the page, not from guesses. Fixed `padEnd(8)`/`padEnd(12)`
  // are no-ops at exactly their width — and `archived` is exactly 8, so the
  // columns ran together precisely for the state this listing exists to reveal.
  const idWidth = Math.max(...page.items.map(item => item.id.length));
  const stateWidth = Math.max(...page.items.map(item => item.state.length));
  const kindWidth = Math.max(
    ...page.items.map(item => humanizeMemoryKind(item.kind).length),
  );

  for (const item of page.items) {
    const timestamp = formatMemoryTimestamp(item.created_at) ?? item.created_at;
    // `subject` reaches this line raw — `insertNote` only trims it — so an
    // embedded newline would split one item into two rows, the second wholly
    // author-controlled. `renderMemorySnippet` already collapses the text.
    const subject = item.subject ? `[${collapseToLine(item.subject)}] ` : '';
    lines.push(
      [
        item.id.padEnd(idWidth),
        item.state.padEnd(stateWidth),
        humanizeMemoryKind(item.kind).padEnd(kindWidth),
        timestamp,
        `${subject}${renderMemorySnippet(item.text, 1, 80)}`,
      ].join('  '),
    );
  }

  if (end < page.total) {
    // Values are quoted: scope keys embed the absolute worktree path, and a
    // path with a space makes the printed command unrunnable — which is the
    // one thing a "next page" line must not be.
    const filters = [
      ...(page.filter.scopeKeys ?? []).map(key => `--scope ${shellQuote(key)}`),
      ...(page.filter.kinds ? [`--kind ${shellQuote(page.filter.kinds.join(','))}`] : []),
      ...(page.filter.states ? [`--state ${shellQuote(page.filter.states.join(','))}`] : []),
    ].join(' ');
    lines.push(
      '',
      `next page: cortex list-memory ${filters}${filters ? ' ' : ''}--limit ${page.limit} --offset ${end}`.trim(),
    );
  }

  return lines.join('\n');
}

/** Payload cap for the rejected-alternatives line, matching `render.ts`'s. */
const MAX_INSPECT_ALTERNATIVES_CHARS = 240;

/**
 * The alternatives line, rendered under the same discipline `renderedAlternatives`
 * applies on every other surface.
 *
 * `notes.alternatives` is the authoritative column, but it is *author-supplied
 * free text*: joining it raw lets an entry containing a newline emit extra
 * lines inside the conflict block, which read as further conflict metadata —
 * a note whose `conflict` column is `false` could otherwise print
 * `contested with <fabricated id>`. `buildNoteMemoryText` collapses whitespace
 * for exactly this reason before projecting; reading from the column instead
 * of the projection must not discard the guard along with the indirection.
 */
function renderAlternativesLine(alternatives: string[]): string | null {
  const collapsed = alternatives.map(collapseToLine).filter(entry => entry.length > 0);
  if (collapsed.length === 0) {
    return null;
  }

  const joined = collapsed.join(', ');
  const capped =
    joined.length <= MAX_INSPECT_ALTERNATIVES_CHARS
      ? joined
      : `${joined.slice(0, MAX_INSPECT_ALTERNATIVES_CHARS - 1).trimEnd()}…`;
  return `  already rejected: ${capped}`;
}

function renderDeletionPreview(preview: MemoryDeletionPreview, requestedId: string): string {
  const lines = [
    'preview only — nothing has been deleted.',
    '',
    `id:         ${preview.item.id}`,
    `kind:       ${humanizeMemoryKind(preview.item.kind)} (${preview.item.kind})`,
    ...(preview.item.subject ? [`subject:    ${collapseToLine(preview.item.subject)}`] : []),
    `scope:      ${preview.item.scope_key}`,
    `references: ${preview.reference_count} will be removed with it`,
  ];

  if (preview.source_table) {
    // Promise only what the cascade actually performs. A source table with no
    // deletion rule would otherwise be advertised as "deleted too" and skipped.
    if (preview.deletable) {
      lines.push(`source row: ${preview.source_table}/${preview.source_id} — deleted too`);
      lines.push('            (leaving it would resurrect this item on the next command)');
      if (preview.upstream_table) {
        lines.push(
          `            plus its ${preview.upstream_table} row, which the backfill would rebuild it from`,
        );
      }
    } else {
      lines.push(
        `source row: ${preview.source_table}/${preview.source_id} — NO deletion rule; this delete will be refused`,
      );
    }
  }

  if (preview.aggregate_warning) {
    lines.push(`warning:    ${preview.aggregate_warning}`);
  }

  if (preview.contested) {
    lines.push(
      `contest:    open — deleting this side clears it for ${preview.counterparts.length} counterpart(s)`,
    );
    for (const counterpart of preview.counterparts) {
      lines.push(`            ${counterpart.id}`);
    }
  }

  lines.push(
    '',
    'text:',
    stripControlCharacters(preview.item.text),
    '',
    `to delete: cortex delete-memory ${shellQuote(requestedId)} --yes`,
  );

  return lines.join('\n');
}

function renderConflictSection(conflict: MemoryInspection['conflict']): string[] {
  if (conflict.conflict === null) {
    // `diverged` here means the item claims a note that no longer exists — its
    // projection still drives decay and channel exclusion with no column left
    // to correct it. That is not the same as never having been note-backed.
    return conflict.diverged
      ? [
          'conflict:   unknown — this item claims a note that no longer exists',
          `  ⚠ orphaned projection: text reads contested=${conflict.projected_contested}, superseded=${conflict.projected_superseded}`,
        ]
      : ['conflict:   n/a (no note behind this item)'];
  }

  const lines = [
    `conflict:   ${conflict.conflict ? 'contested — an unresolved contradiction on this subject' : 'none'}`,
    `status:     ${conflict.note_status}`,
  ];

  for (const counterpart of conflict.counterparts) {
    const when = formatMemoryTimestamp(counterpart.timestamp) ?? counterpart.timestamp;
    lines.push(`  contested with ${counterpart.id} (${counterpart.kind}, ${when})`);
  }

  if (conflict.conflict && conflict.counterparts.length === 0) {
    lines.push('  no counterpart found in this scope — the contest may be stale');
  }

  if (conflict.alternatives && conflict.alternatives.length > 0) {
    const rejected = renderAlternativesLine(conflict.alternatives);
    if (rejected) {
      lines.push(rejected);
    }
  }

  // Every other surface reads the projected text; only this one can see the
  // column too. A disagreement is invisible everywhere else, so it is named.
  if (conflict.diverged) {
    lines.push(
      `  ⚠ projection disagrees with the stored note: text reads contested=${conflict.projected_contested}, superseded=${conflict.projected_superseded}`,
    );
  }

  return lines;
}

function renderMemoryInspection(inspection: MemoryInspection): string {
  const { item, conflict, access } = inspection;
  const lines = [
    `id:         ${item.id}`,
    `kind:       ${humanizeMemoryKind(item.kind)} (${item.kind})`,
    ...(item.subject ? [`subject:    ${collapseToLine(item.subject)}`] : []),
    // Scope keys already lead with their type (`branch:…`, `project:…`), so
    // prefixing `scope_type` produced `branch:branch:…` — a value that cannot
    // be pasted back into `--scope`.
    `scope:      ${item.scope_key}`,
    ...(item.session_id ? [`session:    ${item.session_id}`] : []),
    `created:    ${formatMemoryTimestamp(item.created_at) ?? item.created_at}`,
    `state:      ${item.state} (importance ${item.importance.toFixed(2)})`,
    `trust:      ${inspection.trust}`,
    '',
    ...renderConflictSection(conflict),
    '',
    'references:',
  ];

  if (inspection.references.length === 0) {
    lines.push('  none');
  } else {
    for (const reference of inspection.references) {
      const moved = reference.moved_to ? ` → ${reference.moved_to}` : '';
      lines.push(`  ${reference.status.padEnd(9)}${reference.normalized_path}${moved}`);
    }
  }

  lines.push(
    '',
    'access history:',
    `  count ${access.access_count}, last ${
      access.last_accessed_at
        ? (formatMemoryTimestamp(access.last_accessed_at) ?? access.last_accessed_at)
        : 'never'
    }`,
  );

  if (access.retrievals.length === 0) {
    lines.push('  no recorded retrievals');
  } else {
    for (const retrieval of access.retrievals) {
      lines.push(
        `  ${formatMemoryTimestamp(retrieval.created_at) ?? retrieval.created_at}  ${collapseToLine(retrieval.topic)}`,
      );
    }
  }

  // Two separate reasons this list can be shorter than the access count, and
  // the caveat named only one of them — an item retrieved 30 times showed 10
  // rows under a note blaming gc, when the immediate cause is the cap.
  lines.push(
    `  (showing at most ${ACCESS_HISTORY_LIMIT}; cortex gc also prunes the retrieval log — the access count is the durable figure)`,
  );

  if (inspection.corrections.length > 0) {
    lines.push('', 'corrections:');
    for (const correction of inspection.corrections) {
      const when = formatMemoryTimestamp(correction.created_at) ?? correction.created_at;
      lines.push(`  ${when}  ${correction.operation}`);
      lines.push(`    was: ${collapseToLine(correction.prior_text).slice(0, 160)}`);
    }
  }

  lines.push(
    '',
    'text:',
    stripControlCharacters(inspection.text),
  );

  return lines.join('\n');
}

function readJsonFile(filePath: string): unknown {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

interface QualitySuite {
  fixtures: QualityFixture[];
  seed?: EvaluationScenario;
}

function parseQualitySuite(filePath: string): QualitySuite {
  const parsed = readJsonFile(filePath);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { fixtures?: unknown }).fixtures)
  ) {
    throw new Error('Quality suite must be a JSON object with a fixtures array');
  }

  const suite = parsed as { fixtures: QualityFixture[]; seed?: unknown };
  if (suite.seed !== undefined) {
    if (
      !suite.seed ||
      typeof suite.seed !== 'object' ||
      !Array.isArray((suite.seed as { items?: unknown }).items)
    ) {
      throw new Error('Quality suite seed must be an object with an items array');
    }
    return { fixtures: suite.fixtures, seed: suite.seed as EvaluationScenario };
  }

  return { fixtures: suite.fixtures };
}

function parseEvaluationResult(filePath: string): EvaluationResult {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Compare file must be a Cortex evaluation JSON object');
  }

  return parsed as EvaluationResult;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cortex')
    .description('Cortex working memory for AI agents')
    .version('0.1.0');

  const log = program.command('log').description('Log events to the working memory');

  log
    .command('read')
    .description('Log a file read event')
    .requiredOption('--file <path>', 'File path that was read')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleReadEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('edit')
    .description('Log a file edit event')
    .requiredOption('--file <path>', 'File path that was edited')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleEditEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('write')
    .description('Log a file write event')
    .requiredOption('--file <path>', 'File path that was written')
    .action((opts: { file: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleWriteEvent(store, sessionId, { file: opts.file });
    });

  log
    .command('cmd')
    .description('Log a command execution event')
    .option('--exit <code>', 'Exit code of the command')
    .option('--cmd <text>', 'Command text')
    .option('--stdout <text>', 'Captured stdout for the command (optional)')
    .option('--stderr <text>', 'Captured stderr for the command (optional)')
    .action((opts: { exit?: string; cmd?: string; stdout?: string; stderr?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleCmdEvent(store, sessionId, {
        exit: opts.exit,
        cmd: opts.cmd,
        stdout: opts.stdout,
        stderr: opts.stderr,
      });
    });

  log
    .command('agent')
    .description('Log a sub-agent delegation event')
    .requiredOption('--desc <text>', 'Description of the agent task')
    .action((opts: { desc: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleAgentEvent(store, sessionId, { desc: opts.desc });
    });

  program
    .command('inject-header')
    .description('Consolidate sessions, start a new session, print context header')
    .option('--quiet', 'Engage capture without printing the working-memory header')
    .action((opts: { quiet?: boolean }) => {
      configureEngagementPath(process.cwd());
      const { store } = openCortexDb(process.cwd());

      // Replay leftover spooled capture into the session it belongs to,
      // before that session is consolidated and ended.
      const previous = store.getCurrentSession();
      if (previous) {
        try {
          flushSpool(store, process.cwd(), previous.id);
        } catch {
          // Leftovers stay in the spool for the next flush.
        }
      }

      const unconsolidated = store.getUnconsolidatedSessions();

      for (const session of unconsolidated) {
        const compressed = consolidateLevel1(store, session.id);
        if (compressed.length > 0) {
          writeSessionSummary(store, session.id, renderCompressed(compressed));
        }
      }

      mergeProjectState(store);

      const current = store.getCurrentSession();
      if (current) {
        syncBranchSnapshotForSession(store, current.id);
        store.endSessionTree(current.id);
      }

      const scopedSession = ensureScopedSession(store, process.cwd());
      if (!previous) {
        try {
          flushSpool(store, process.cwd(), scopedSession.id);
        } catch {
          // Leftovers stay in the spool for the next flush.
        }
      }
      refreshCurrentGraphQuietly(store, process.cwd());

      const engPath = deriveEngagementPath(process.cwd());
      try {
        fs.writeFileSync(engPath, 'enabled=true\nstate_called=false\n');
      } catch {
        // Non-fatal.
      }

      // Opt-in automatic GC, at most once per 24h.
      if (process.env['CORTEX_GC_AUTO'] === 'apply') {
        try {
          const gcDb = openDatabase(findDbPath(process.cwd()));
          if (shouldAutoGc(gcDb)) {
            runGc(gcDb, { dryRun: false });
          }
          gcDb.close();
        } catch {
          // GC must never block session start.
        }
      }

      if (opts.quiet) {
        // Quiet mode still leads with value: a tiny validated brief, or silence.
        const sessionBrief = buildSessionBrief(store);
        if (sessionBrief) {
          const scoped = store.getCurrentSession();
          if (scoped) {
            try {
              store.insertLedgerEntry({
                sessionId: scoped.id,
                type: 'session_brief',
                direction: 'spent',
                tokens: estimateTokens(sessionBrief),
              });
            } catch {
              // Ledger accounting must never block startup.
            }
          }
          process.stdout.write(`${sessionBrief}\n`);
        }
        return;
      }

      process.stdout.write(`${buildHeader(store)}\n`);
    });

  program
    .command('route')
    .description('Show Cortex ambient-memory capabilities and routing guidance')
    .action(() => {
      process.stdout.write(`${renderCortexRoute()}\n`);
    });

  program
    .command('reflect')
    .description('Emit hook additionalContext when remembered context matches the current focus')
    .requiredOption('--event <event>', 'Hook event anchor type: prompt, edit, cmd, or agent')
    .option('--prompt <text>', 'User prompt text for prompt events')
    .option('--file <path>', 'File path for edit events')
    .option('--cmd <text>', 'Command text for command events')
    .option('--desc <text>', 'Agent task description for agent events')
    .action((opts: { event: ReflexEvent; prompt?: string; file?: string; cmd?: string; desc?: string }) => {
      configureEngagementPath(process.cwd());
      if (readEngagement()['enabled'] !== 'true') {
        return;
      }

      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      refreshCurrentGraphQuietly(store, process.cwd());
      const output = reflectMemory(store, {
        event: opts.event,
        prompt: opts.prompt,
        file: opts.file,
        cmd: opts.cmd,
        desc: opts.desc,
        sessionId: session.id,
      });

      if (output) {
        process.stdout.write(`${output}\n`);
      }
    });

  program
    .command('status')
    .description('Print DB status')
    .action(() => {
      try {
        const { store, dbPath } = openCortexDb(process.cwd());
        const rootPath = store.getMeta('root_path') ?? process.cwd();
        const sessionCount = store.getSessionCount();
        process.stdout.write('OK\n');
        process.stdout.write(`DB: ${dbPath}\n`);
        process.stdout.write(`Root: ${rootPath}\n`);
        process.stdout.write(`Sessions: ${sessionCount}\n`);
      } catch (err) {
        process.stdout.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  program
    .command('stats')
    .description('Token savings dashboard')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const recentSessions = store.getRecentSessions(10);
      let focus = 'unfocused';
      for (const session of recentSessions) {
        if (session.focus !== null) {
          focus = session.focus;
          break;
        }
      }

      const sessionCount = store.getSessionCount();
      const activeNotes = store.getActiveNotes();
      const { spent, saved } = store.getTotalTokens();
      const net = saved - spent;
      const efficiency = spent > 0 ? Math.round((saved / (spent + saved)) * 100) : 0;

      process.stdout.write(`Focus:         ${focus}\n`);
      process.stdout.write(`Sessions:      ${sessionCount}\n`);
      process.stdout.write(`Active notes:  ${activeNotes.length}\n`);
      process.stdout.write(`Spent:         ${formatTokens(spent)}\n`);
      process.stdout.write(`Saved:         ${formatTokens(saved)}\n`);
      process.stdout.write(`Net:           ${formatTokens(net)}\n`);
      process.stdout.write(`Efficiency:    ${efficiency}%\n`);
    });

  program
    .command('consolidate')
    .description('Manually trigger Level 1 consolidation for unconsolidated sessions')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const unconsolidated = store.getUnconsolidatedSessions();

      if (unconsolidated.length === 0) {
        process.stdout.write('No unconsolidated sessions.\n');
        return;
      }

      let count = 0;
      for (const session of unconsolidated) {
        const compressed = consolidateLevel1(store, session.id);
        if (compressed.length > 0) {
          writeSessionSummary(store, session.id, renderCompressed(compressed));
          count++;
        }
      }

      process.stdout.write(`Consolidated ${count} session(s).\n`);
    });

  program
    .command('evaluate')
    .description('Evaluate current memory state and recall output sizes for a Cortex DB')
    .option('--db <path>', 'Path to the Cortex SQLite database', '.cortex.db')
    .option('--root <path>', 'Project root path for schema initialization', process.cwd())
    .option('--topics <items>', 'Comma-separated topics to replay')
    .option('--suite <path>', 'Path to a JSON quality suite with retrieval fixtures')
    .option('--compare <path>', 'Path to a previous cortex evaluate JSON result')
    .action((opts: { db: string; root: string; topics?: string; suite?: string; compare?: string }) => {
      const dbPath = path.isAbsolute(opts.db)
        ? opts.db
        : path.resolve(process.cwd(), opts.db);
      const rootPath = path.isAbsolute(opts.root)
        ? opts.root
        : path.resolve(process.cwd(), opts.root);
      const suite = opts.suite ? parseQualitySuite(opts.suite) : undefined;
      const options: EvaluationOptions = {
        ...(suite ? { fixtures: suite.fixtures } : {}),
        ...(suite?.seed ? { scenario: suite.seed } : {}),
        ...(opts.compare ? { compareTo: parseEvaluationResult(opts.compare) } : {}),
      };
      const result = evaluateDatabase(dbPath, rootPath, parseTopics(opts.topics), options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  program
    .command('eval-gate')
    .description('Run every locked retrieval-quality suite against its baseline (FR-44, AD-5)')
    .option('--suites <dir>', 'Directory of locked suites', 'eval/suites')
    .option('--baselines <dir>', 'Directory of locked baselines', 'eval/baselines')
    .option('--coverage <path>', 'Kind-coverage manifest', 'eval/kind-coverage.json')
    .option(
      '--regenerate-baseline <suite>',
      'Rewrite one locked baseline. Deliberate act — justify it in the commit body.',
    )
    .action((opts: {
      suites: string;
      baselines: string;
      coverage: string;
      regenerateBaseline?: string;
    }) => {
      const options = {
        suitesDir: opts.suites,
        baselinesDir: opts.baselines,
        coveragePath: opts.coverage,
        rootPath: process.cwd(),
      };

      if (opts.regenerateBaseline !== undefined) {
        if (opts.regenerateBaseline.trim().length === 0) {
          process.stderr.write('name the suite to regenerate, e.g. --regenerate-baseline budget\n');
          process.exitCode = 1;
          return;
        }
        const report = regenerateBaseline(opts.regenerateBaseline, options);
        process.stdout.write(`rewrote ${report.baselinePath}\n`);
        if (report.accepted.length > 0) {
          process.stdout.write(
            `accepting these regressions into the baseline:\n${report.accepted
              .map(line => `  ${line}`)
              .join('\n')}\n`,
          );
        }
        process.stdout.write(
          `\nState the reason in the commit body:\n  ${BASELINE_TRAILER} <why this quality change is intended>\n`,
        );
        return;
      }

      const result = runEvalGate(options);
      process.stdout.write(`${result.lines.join('\n')}\n`);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command('flush-spool')
    .description('Replay spooled hook capture (.cortex.spool.jsonl) into the store')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      const result = flushSpool(store, process.cwd(), session.id);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

  program
    .command('note-resolve')
    .description('Mark a saved note as resolved or superseded')
    .option('--id <id>', 'Note id')
    .option('--subject <text>', 'Subject of the active note (when id is unknown)')
    .option('--status <status>', 'resolved | superseded', 'resolved')
    .action((opts: { id?: string; subject?: string; status?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const status = opts.status === 'superseded' ? 'superseded' : 'resolved';

      // Resolving by subject leaned on an invariant that no longer holds: once
      // contested priors were exempted from auto-supersede, a (kind, subject)
      // pair can have two active notes, and `findActiveNoteBySubject`'s LIMIT 1
      // would close the newest while leaving the retracted one as the sole
      // active decision. Only a live contest is ambiguous — a decision plus a
      // blocker on one subject is ordinary usage and must still resolve. The
      // lookup is scope-blind, so this guard is too. Mirrors `mcp.ts`.
      if (!opts.id && opts.subject) {
        const contested = store
          .getActiveNotesBySubject(opts.subject)
          .filter(candidate => candidate.conflict);
        if (contested.length > 1) {
          const lines = contested.map(candidate => {
            const stamp = formatMemoryTimestamp(candidate.timestamp);
            return `  - ${candidate.id}${stamp ? ` [${stamp}]` : ''}`;
          });
          process.stderr.write(
            [
              `Subject "${opts.subject}" has ${contested.length} contested notes — resolving by subject would pick one arbitrarily.`,
              'Re-run with --id for the side you want to close:',
              ...lines,
              '',
            ].join('\n'),
          );
          process.exitCode = 1;
          return;
        }
      }

      const note = opts.id
        ? store.getNote(opts.id)
        : opts.subject
          ? store.findActiveNoteBySubject(opts.subject)
          : undefined;
      if (!note) {
        process.stderr.write('No matching note found (pass --id or --subject).\n');
        process.exitCode = 1;
        return;
      }
      store.updateNoteStatus(note.id, status);
      // Closing one side of a contest clears it for the subject, or the
      // survivor renders [contested] against a note nobody can act on and the
      // resolved note renders "[contested] (resolved)" forever.
      //
      // Gated on `note.conflict`, not just on having a subject: an uncontested
      // third note (a blocker, say) can be active on the same subject, and
      // resolving it must not wipe the markers of a contest it has nothing to
      // do with. This is the half of `mcp.ts`'s guard that matters here.
      if (note.conflict && note.subject) {
        store.clearConflictsForSubject(note.subject, store.getScopeKeyForNote(note.id));
      }
      process.stdout.write(`Marked ${note.kind}${note.subject ? `[${note.subject}]` : ''} as ${status}.\n`);
    });

  program
    .command('gc')
    .description('Prune derived data (events, retrieval log, ledger, archived items). Dry-run by default.')
    .option('--apply', 'Actually delete (default is a dry-run report)')
    .option('--vacuum <mode>', 'auto | always | never', 'auto')
    .action((opts: { apply?: boolean; vacuum?: string }) => {
      const dbPath = findDbPath(process.cwd());
      const db = openDatabase(dbPath);
      ensureCortexSchema(db, process.cwd());
      const vacuum =
        opts.vacuum === 'always' || opts.vacuum === 'never' ? opts.vacuum : 'auto';
      const report = runGc(db, { dryRun: !opts.apply, vacuum });
      db.close();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    });

  program
    .command('install-hooks')
    .description('Install canonical Cortex hook scripts for a harness')
    .option('--claude', 'Install for Claude Code (~/.claude/hooks)')
    .option('--codex', 'Install for Codex (~/.codex/hooks)')
    .option('--dir <path>', 'Override the hooks directory')
    .action((opts: { claude?: boolean; codex?: boolean; dir?: string }) => {
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const templateDir = path.resolve(moduleDir, '..', '..', 'hooks', 'claude');
      const nodePath = process.execPath;
      const cliEntry = path.resolve(moduleDir, 'cli.js');
      const hookEntry = path.resolve(moduleDir, 'hook-entry.js');

      const targetDir =
        opts.dir ??
        (opts.codex
          ? path.join(os.homedir(), '.codex', 'hooks')
          : path.join(os.homedir(), '.claude', 'hooks'));
      fs.mkdirSync(targetDir, { recursive: true });

      for (const script of HOOK_SCRIPTS) {
        const template = fs.readFileSync(path.join(templateDir, script), 'utf8');
        // Stamp the template's identity into the installed copy so `cortex
        // doctor` can tell a current hook from one that merely looks fine. The
        // digest is of the template as shipped — placeholders intact — which is
        // exactly what the doctor recomputes.
        const rendered = template
          .replaceAll(TEMPLATE_ID_PLACEHOLDER, hookTemplateDigest(template))
          .replaceAll('__CORTEX_NODE__', nodePath)
          .replaceAll('__CORTEX_CLI__', cliEntry)
          .replaceAll('__CORTEX_HOOK_ENTRY__', hookEntry);
        const target = path.join(targetDir, script);
        fs.writeFileSync(target, rendered);
        try {
          fs.chmodSync(target, 0o755);
        } catch {
          // chmod is a no-op on Windows.
        }
        process.stdout.write(`installed ${target}\n`);
      }

      const hooksDirForSnippet = targetDir.replace(/\\/g, '/');
      const snippet = {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `"${nodePath}" "${cliEntry}" inject-header --quiet` }] },
          ],
          PostToolUse: [
            {
              matcher: 'Read|Edit|Write|Bash|Agent',
              hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-capture.sh"` }],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-reflect.sh" reflect-pre` }],
            },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-reflect.sh" reflect-prompt` }] },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-end-of-turn.sh"` }] },
          ],
        },
      };
      process.stdout.write(
        `\nMerge into ${opts.codex ? 'Codex' : 'Claude'} settings (hooks section):\n${JSON.stringify(snippet, null, 2)}\n`,
      );
      process.stdout.write(
        '\nNotes: capture is spooled (no Node per tool call); reflex runs only on Edit|Write and prompts; the Stop nudge fires only with high-confidence suggestions. Remove any old cortex-hook.sh / cortex-mark-agent-used.sh wiring.\n',
      );
    });

  program
    .command('doctor')
    .description('Diagnose the Cortex installation: hooks, wiring, store, spool, MCP registration')
    // Nothing here opens a session, engages Cortex, migrates the store or
    // flushes the spool: a diagnostic that repairs what it is checking cannot
    // report on it.
    .option('--json', 'Emit the raw report instead of the table')
    .option('--hooks-dir <path>', 'Diagnose hooks in this directory instead of the configured one')
    .action((opts: { json?: boolean; hooksDir?: string }) => {
      const report = runDoctor({
        projectDir: process.cwd(),
        ...(opts.hooksDir ? { hooksDir: opts.hooksDir } : {}),
      });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report),
      );
      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command('suggest-notes')
    .description('Suggest load-bearing notes from the current session without writing them')
    .option('--session <id>', 'Session id to inspect. Defaults to the current scoped session')
    .action((opts: { session?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      const sessionId = opts.session ?? session.id;
      const suggestions = suggestNotes(store, sessionId);
      process.stdout.write(`${JSON.stringify({ session_id: sessionId, suggestions }, null, 2)}\n`);
    });

  program
    .command('validate-memory')
    .description('Audit retrieved memory against the current checkout without deleting notes')
    .option('--topic <text>', 'Topic to validate. Defaults to recent memory')
    .action((opts: { topic?: string }) => {
      const { store } = openCortexDb(process.cwd());
      ensureScopedSession(store, process.cwd());
      refreshCurrentGraphQuietly(store, process.cwd());
      const report = validateMemory(store, opts.topic);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    });

  program
    .command('list-memory')
    .description('List stored memory items by scope, kind and state (paginated)')
    // Repeatable rather than comma-separated: scope keys embed the worktree
    // path and the branch ref, and git allows commas in branch names, so
    // splitting would shatter a legitimate key into filters that match nothing.
    .option(
      '--scope <key>',
      'Scope key (repeat the flag for more than one)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--kind <kinds>', 'Comma-separated memory item kinds (e.g. note:decision)')
    .option('--state <states>', `Comma-separated states: ${[...KNOWN_MEMORY_STATES].join(', ')}`)
    .option('--limit <n>', `Items per page (default ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT})`)
    .option('--offset <n>', 'Items to skip', '0')
    .option('--json', 'Emit the page as JSON')
    .action((opts: {
      scope: string[];
      kind?: string;
      state?: string;
      limit?: string;
      offset?: string;
      json?: boolean;
    }) => {
      const states = opts.state === undefined ? undefined : parseList(opts.state);
      const unknownStates = (states ?? []).filter(state => !KNOWN_MEMORY_STATES.has(state));
      if (unknownStates.length > 0) {
        // Without this, a typo is byte-identical to an empty store — which is
        // the one question this command exists to answer.
        process.stderr.write(
          `Unknown --state value(s): ${unknownStates.join(', ')}. Valid states: ${[...KNOWN_MEMORY_STATES].join(', ')}.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const { store } = openCortexDb(process.cwd());
      const page = listMemory(store, {
        // `!== undefined`, not truthiness: `--kind ""` is a filter the user
        // typed, and treating it as "no filter" widens the listing to the whole
        // store — precisely what the store layer refuses to do for an empty array.
        ...(opts.scope.length > 0 ? { scopeKeys: opts.scope } : {}),
        ...(opts.kind !== undefined ? { kinds: parseList(opts.kind) } : {}),
        ...(states !== undefined ? { states } : {}),
        ...(parseCount(opts.limit) !== undefined ? { limit: parseCount(opts.limit)! } : {}),
        ...(parseCount(opts.offset) !== undefined ? { offset: parseCount(opts.offset)! } : {}),
      });

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${renderMemoryListPage(page)}\n`);
    });

  program
    .command('inspect-memory')
    .description('Show one memory item in full: text, references, trust, conflict, access history')
    .argument('<id>', 'Memory item id, or the id of the note behind it')
    .option('--json', 'Emit the inspection as JSON')
    .action((id: string, opts: { json?: boolean }) => {
      const { store } = openCortexDb(process.cwd());
      // Refresh current truth first so reference statuses describe the
      // checkout as it is now, not as it was at the last retrieval. This
      // creates no session — reading memory must not manufacture history.
      refreshCurrentGraphQuietly(store, process.cwd());

      const inspection = inspectMemory(store, id);
      if (!inspection) {
        process.stderr.write(
          `No memory item found for id "${id}". List ids with: cortex list-memory\n`,
        );
        // A caller piping --json gets a parseable error rather than zero bytes;
        // the exit code is non-zero either way, which is what the AC binds.
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ error: 'not_found', id }, null, 2)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${renderMemoryInspection(inspection)}\n`);
    });

  program
    .command('edit-memory')
    .description('Replace a memory item\'s text; references are re-extracted and it is re-projected')
    .argument('<id>', 'Memory item id, or the id of the note behind it')
    .option('--text <text>', 'Replacement text')
    .option('--file <path>', 'Read replacement text from a file (for multi-line corrections)')
    .option('--json', 'Emit the result as JSON')
    .action((id: string, opts: { text?: string; file?: string; json?: boolean }) => {
      const fail = (error: string, message: string): void => {
        process.stderr.write(`${message}\n`);
        // --json callers get a parseable object on every error path, not just
        // the not-found one.
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ error, id }, null, 2)}\n`);
        }
        process.exitCode = 1;
      };

      if ((opts.text === undefined) === (opts.file === undefined)) {
        fail('bad_args', 'Pass exactly one of --text or --file.');
        return;
      }

      let text: string;
      try {
        text =
          opts.file !== undefined
            ? fs.readFileSync(path.resolve(process.cwd(), opts.file), 'utf8')
            : opts.text!;
      } catch (err) {
        fail(
          'file_unreadable',
          `Could not read --file: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // Windows editors write a BOM by default, and --file is advertised for
      // multi-line corrections, so it is the likely source of one.
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      if (text.trim().length === 0) {
        fail(
          'empty_text',
          'Replacement text is empty. Use `cortex delete-memory` to remove a memory.',
        );
        return;
      }

      const spoofed = spoofedTrailerLine(text);
      if (spoofed) {
        // The projection appends `Subject:`/`Alternatives:`/`Conflict:`/`Status:`
        // as its trailer, and the readers that recover those flags are
        // trailer-scoped. Text ending in one of those lines would be read back
        // as metadata — rendering [contested] or (superseded) with the column
        // saying otherwise, and nothing able to clear it.
        fail(
          'spoofed_trailer',
          `Replacement text ends with "${spoofed}", which the projection uses as a metadata line. Reword it, or move it away from the end of the text.`,
        );
        return;
      }

      const { store } = openCortexDb(process.cwd());
      const result = editMemory(store, id, text);
      if (!result) {
        process.stderr.write(
          `No memory item found for id "${id}". List ids with: cortex list-memory\n`,
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ error: 'not_found', id }, null, 2)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      process.stdout.write(
        [
          `edited ${result.item.id}`,
          `references: ${result.references.length} re-extracted`,
          'the prior text is recorded in the audit trail (cortex inspect-memory shows the item)',
          '',
          'text:',
          stripControlCharacters(result.item.text),
          '',
        ].join('\n'),
      );
    });

  program
    .command('delete-memory')
    .description('Delete a memory item, its source row and its derived rows. Previews by default.')
    .argument('<id>', 'Memory item id, or the id of the note behind it')
    .option('--yes', 'Actually delete (default is a preview)')
    .option('--json', 'Emit the preview or result as JSON')
    .action((id: string, opts: { yes?: boolean; json?: boolean }) => {
      const { store } = openCortexDb(process.cwd());

      // Preview-by-default is the confirmation AC #2 requires, and it matches
      // `cortex gc`, the only other destructive command. An interactive prompt
      // is not an option: the CLI runs under hooks with no TTY.
      if (!opts.yes) {
        const preview = previewMemoryDeletion(store, id);
        if (!preview) {
          process.stderr.write(
            `No memory item found for id "${id}". List ids with: cortex list-memory\n`,
          );
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({ error: 'not_found', id }, null, 2)}\n`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ...preview, deleted: false }, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${renderDeletionPreview(preview, id)}\n`);
        return;
      }

      const result = deleteMemory(store, id);
      if (!result) {
        process.stderr.write(
          `No memory item found for id "${id}". List ids with: cortex list-memory\n`,
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ error: 'not_found', id }, null, 2)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.deleted) {
          process.exitCode = 1;
        }
        return;
      }

      if (!result.deleted) {
        // The preview read and the cascade are separate transactions, so the
        // row can vanish between them. Reporting success for a deletion that
        // never ran is worse than reporting the race.
        process.stderr.write(
          `Item ${result.item.id} vanished before the delete could run; nothing was removed.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const lines = [`deleted ${result.item.id}`];
      if (result.source_table) {
        lines.push(`  source row: ${result.source_table}/${result.source_id}`);
      }
      if (result.cleared_contest_for) {
        lines.push(`  cleared the contest on "${collapseToLine(result.cleared_contest_for)}"`);
      }
      lines.push(
        '  the removed text is kept in the audit trail (cortex inspect-memory) until cortex gc prunes it',
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });

  program
    .command('serve')
    .description('Start the MCP server')
    .action(async () => {
      const { startServer } = await import('./mcp.js');
      await startServer(process.cwd());
    });

  return program;
}

const self = process.argv[1] ?? '';
if (self.endsWith('cli.js') || self.endsWith('cli.ts')) {
  const program = createProgram();
  try {
    program.parse(process.argv);
  } catch (err) {
    // A store-level failure (unreadable database, a driver rejection) would
    // otherwise surface as a Node stack trace naming dist/ internals. One
    // diagnostic line and a non-zero exit, matching the deliberate handling
    // the commands already apply to a missing id.
    process.stderr.write(`cortex: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
