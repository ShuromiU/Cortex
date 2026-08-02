import type { CortexStore } from '../db/store.js';
import { syncBranchSnapshotForSession } from '../scope/runtime.js';
import { consolidateLevel1, renderCompressed } from './consolidate.js';
import { computeFileDigest, type DigestCache } from './digest.js';
import {
  captureOutputTail,
  classifyCommand,
  redactCommand,
  redactSensitiveText,
  extractTouchedFiles,
} from './redact.js';

// ── Argument interfaces ───────────────────────────────────────────────

export interface ReadArgs {
  file: string;
  lines?: string;
  /**
   * Per-batch digest memo. Supplied by the spool flush so one file is hashed
   * once per batch; absent for one-off calls, which hash directly.
   */
  digestCache?: DigestCache;
}

export interface EditArgs {
  file: string;
  lines?: string;
}

export interface WriteArgs {
  file: string;
}

export interface CmdArgs {
  exit?: string;
  cmd?: string;
  stdout?: string;
  stderr?: string;
}

export interface AgentArgs {
  desc: string;
}

const TAIL_CAPTURE_CATEGORIES = new Set(['test', 'build', 'git']);

function parseExitCode(exit?: string): number | undefined {
  if (exit === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(exit, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldCaptureOutputTail(
  category: string | undefined,
  exitCode: number | undefined,
): boolean {
  return (
    category !== undefined &&
    exitCode !== undefined &&
    exitCode !== 0 &&
    TAIL_CAPTURE_CATEGORIES.has(category)
  );
}

function sanitizeOutputTail(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const tailed = captureOutputTail(raw);
  if (!tailed) {
    return undefined;
  }

  const redacted = redactSensitiveText(tailed);
  return redacted.trim().length > 0 ? redacted : undefined;
}

function writeCommandEpisodes(
  store: CortexStore,
  sessionId: string,
  eventId: string,
  category: string | undefined,
  safeSummary: string | undefined,
  exitCode: number | undefined,
  filesTouched: string[] | undefined,
  stdoutTail: string | undefined,
  stderrTail: string | undefined,
): void {
  if (
    category !== undefined &&
    exitCode !== undefined &&
    exitCode !== 0 &&
    TAIL_CAPTURE_CATEGORIES.has(category)
  ) {
    const summary = safeSummary
      ? `${category} failed: ${safeSummary} (exit ${exitCode})`
      : `${category} failed with exit ${exitCode}`;

    // The same failure repeating within a day folds into one episode with an
    // occurrence counter instead of stacking duplicate rows.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const existing = store.findRecentEpisodeBySummary(
      'command_failure',
      summary,
      dayAgo,
      sessionId,
    );
    if (existing) {
      store.bumpEpisodeOccurrence(existing.id, summary);
    } else {
      store.insertEpisode({
        id: `command_failure:${eventId}`,
        sessionId,
        kind: 'command_failure',
        summary,
        target: filesTouched?.[0] ?? null,
        metadata: {
          category,
          exit_code: exitCode,
          command_summary: safeSummary ?? null,
          files_touched: filesTouched ?? [],
          stdout_tail: stdoutTail ?? null,
          stderr_tail: stderrTail ?? null,
          event_id: eventId,
        },
      });
    }
  }

  if (category === 'test' && exitCode === 0) {
    const compressed = consolidateLevel1(store, sessionId);
    const latest = compressed[compressed.length - 1];
    if (latest?.type === 'test_cycle') {
      store.insertEpisode({
        id: `test_cycle:${eventId}`,
        sessionId,
        kind: 'test_cycle',
        summary: renderCompressed([latest]),
        target: latest.files?.[0] ?? null,
        metadata: {
          iterations: latest.iterations ?? 1,
          files: latest.files ?? [],
          event_id: eventId,
        },
      });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse a "start-end" line range string into discrete fields.
 * Returns an empty object if lines is undefined or unparseable.
 */
export function parseLineRange(lines?: string): { line_start?: number; line_end?: number } {
  if (!lines) return {};
  const match = /^(\d+)-(\d+)$/.exec(lines.trim());
  if (!match) return {};
  const line_start = parseInt(match[1]!, 10);
  const line_end = parseInt(match[2]!, 10);
  return { line_start, line_end };
}

// ── Event handlers ────────────────────────────────────────────────────

/**
 * Record a file-read event.
 */
/**
 * Book an *unrealized* saving: Cortex offered this file as unchanged and the
 * agent read it anyway (AC #6).
 *
 * **This is an observed decline, not an inferred one — and only the decline is
 * counted.** Both halves are recorded: the offer is a `read_offers` row from a
 * read-ledger query that answered `unchanged-since` and refund-eligible, and
 * the read is the event being replayed right now. Nothing is modeled: if no
 * offer was open, no unrealized row is written, exactly as AC #3 requires of
 * savings.
 *
 * The offer deliberately lives OUTSIDE `token_ledger`. Written there, it
 * counted as `unrealized` the moment it was *made*, so an agent that adopted
 * every offer scored identically to one that ignored every offer — the metric
 * measured Cortex's helpfulness rather than the agent's uptake, under a label
 * saying the opposite. It also required deleting a ledger row, against AD-8's
 * append-only rule.
 *
 * It is recorded *separately* from savings, because folding the two together
 * would hide the number this exists to expose — the gap between what Cortex can
 * do and what the agent actually took. A high unrealized figure is a product
 * problem, not an accounting one, and it must be visible as itself.
 */
function bookUnrealizedIfOffered(
  store: CortexStore,
  sessionId: string,
  scopeKey: string | null,
  filePath: string,
): void {
  if (!scopeKey) {
    return;
  }
  const offer = store.consumeReadOffer(sessionId, scopeKey, filePath);
  if (!offer) {
    return;
  }
  store.insertLedgerEntry({
    sessionId,
    type: 'unrealized:read',
    direction: 'unrealized',
    tokens: offer.tokens,
    evidence: { kind: 'read', ref: offer.path, size: offer.byteSize },
  });
}

export function handleReadEvent(
  store: CortexStore,
  sessionId: string,
  args: ReadArgs,
): void {
  const range = parseLineRange(args.lines);
  store.insertEvent({
    sessionId,
    type: 'read',
    target: args.file,
    ...(Object.keys(range).length > 0 ? { metadata: range } : {}),
  });
  // BEFORE the digest is recorded. `recordReadDigest` upserts the row this
  // read is about, and the offer lookup keys on that row's path — so running it
  // afterwards would compare the offer against a record the same read had just
  // refreshed. Order matters for the same reason it did in the read ledger's
  // edit check: the evidence has to describe the state the decision was made in.
  try {
    const session = store.getSession(sessionId);
    bookUnrealizedIfOffered(store, sessionId, session?.scope_key ?? null, args.file);
  } catch {
    // Accounting must never break capture (AD-12).
  }
  recordReadDigest(store, sessionId, args);
  syncBranchSnapshotForSession(store, sessionId);
}

/**
 * Record the read ledger's digest for a file this session just read (FR-5).
 *
 * Runs on the cold path only — every caller of `handleReadEvent` is either the
 * spool flush, a CLI command, or the `hook-entry` bridge, all of which already
 * have Node running. The bash PostToolUse hook never reaches here (N-4).
 *
 * `scope_key` and `agent_id` come from the *resolved* session rather than from
 * cwd or the raw payload, so a subagent's read is attributed to the subagent —
 * which is the fact AD-16 needs to refuse "you read it" for a sibling session.
 */
function recordReadDigest(store: CortexStore, sessionId: string, args: ReadArgs): void {
  try {
    const session = store.getSession(sessionId);
    // A session with no scope cannot be keyed, and a scope-less digest would
    // collide across branches.
    if (!session?.scope_key) {
      return;
    }

    const digest = args.digestCache
      ? args.digestCache(args.file)
      : computeFileDigest(args.file);
    if (!digest) {
      return;
    }

    store.upsertContentDigest({
      scopeKey: session.scope_key,
      // Raw: the store normalizes the key on write and read alike.
      path: args.file,
      sha256: digest.sha256,
      byteSize: digest.byteSize,
      mtime: digest.mtime,
      sessionId,
      agentId: session.agent_id ?? null,
      oversize: digest.oversize,
      // AD-16: lets the upsert keep an ancestor's recorded read rather than
      // letting this session's read erase it.
      readerParentSessionId: session.parent_session_id,
      // Deliberately NOT `session.worktree_path`. The store resolves the scope
      // root itself, and the write and the read must use the *same* rule or
      // they derive different keys. Measured with two worktrees sharing one
      // scope_key: the write keyed relative to the reader's own worktree while
      // the read keyed relative to the newest session's, so a file was written
      // under one key and looked up under another — and two distinct files
      // collapsed onto one row. Passing the per-session root here is what made
      // the two sides disagree.
    });
  } catch {
    // AD-12: capture is ambient. A ledger failure must never break the user's
    // turn or abort the surrounding spool batch, which carries real events.
  }
}

/**
 * Record a file-edit event.
 */
export function handleEditEvent(
  store: CortexStore,
  sessionId: string,
  args: EditArgs,
): void {
  const range = parseLineRange(args.lines);
  store.insertEvent({
    sessionId,
    type: 'edit',
    target: args.file,
    ...(Object.keys(range).length > 0 ? { metadata: range } : {}),
  });
  syncBranchSnapshotForSession(store, sessionId);
}

/**
 * Record a file-write event.
 */
export function handleWriteEvent(
  store: CortexStore,
  sessionId: string,
  args: WriteArgs,
): void {
  store.insertEvent({
    sessionId,
    type: 'write',
    target: args.file,
  });
  syncBranchSnapshotForSession(store, sessionId);
}

/**
 * Record a command-execution event with classification and redaction.
 */
export function handleCmdEvent(
  store: CortexStore,
  sessionId: string,
  args: CmdArgs,
): void {
  const exitCode = parseExitCode(args.exit);
  const category = args.cmd !== undefined ? classifyCommand(args.cmd) : undefined;
  const safeSummary = args.cmd !== undefined ? redactCommand(args.cmd) : undefined;
  const filesTouched =
    args.cmd !== undefined ? extractTouchedFiles(args.cmd) : undefined;
  const captureTail = shouldCaptureOutputTail(category, exitCode);
  const stdoutTail = captureTail ? sanitizeOutputTail(args.stdout) : undefined;
  const stderrTail = captureTail ? sanitizeOutputTail(args.stderr) : undefined;

  const metadata: Record<string, unknown> = {
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(safeSummary !== undefined ? { safe_summary: safeSummary } : {}),
    ...(filesTouched !== undefined ? { files_touched: filesTouched } : {}),
    ...(stdoutTail !== undefined ? { stdout_tail_captured: true } : {}),
    ...(stderrTail !== undefined ? { stderr_tail_captured: true } : {}),
  };

  store.runInTransaction(() => {
    const eventId = store.insertEvent({
      sessionId,
      type: 'cmd',
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    store.insertCommandRun({
      id: eventId,
      sessionId,
      eventId,
      category,
      commandSummary: safeSummary,
      exitCode,
      stdoutTail,
      stderrTail,
      filesTouched,
    });
    writeCommandEpisodes(
      store,
      sessionId,
      eventId,
      category,
      safeSummary,
      exitCode,
      filesTouched,
      stdoutTail,
      stderrTail,
    );
  });
  syncBranchSnapshotForSession(store, sessionId);
}

/**
 * Record a sub-agent delegation event.
 */
export function handleAgentEvent(
  store: CortexStore,
  sessionId: string,
  args: AgentArgs,
): void {
  store.insertEvent({
    sessionId,
    type: 'agent',
    metadata: { description: args.desc },
  });
  syncBranchSnapshotForSession(store, sessionId);
}
