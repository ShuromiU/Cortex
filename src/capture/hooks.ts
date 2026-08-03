import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { CortexStore } from '../db/store.js';
import { isAbsoluteFileKey } from '../scope/keys.js';
import { syncBranchSnapshotForSession } from '../scope/runtime.js';
import { computeRootCensus, type RootCensus } from './census.js';
import { consolidateLevel1, renderCompressed } from './consolidate.js';
import { computeFileDigest, type DigestCache } from './digest.js';
import { isCertifiableSearch, normalizeSearchRoot, searchQueryKey } from './search-query.js';
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
  /**
   * The hot path replaced this read's output (Story 4.5). Set only by the spool
   * replay, from the `subst` field the PostToolUse hook writes onto the read
   * line. Optional and defaulting to false, so the three other callers —
   * `cli log read`, `hook-entry postToolUse`, and direct use — are unchanged.
   */
  substituted?: boolean;
  /**
   * Whether the digest recorded for this read will describe the bytes the read
   * RETURNED — see `ParsedContentDigest.refundEligible`. Defaults to true,
   * which is correct for direct callers (digest computed at event time); the
   * spool flush passes its batch pre-pass verdict.
   */
  refundEligible?: boolean;
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
  /**
   * True when the hot path replaced this read's output (Story 4.5). The offer
   * is still **consumed** — leaving it open would let the next read of the same
   * file book a decline that already did not happen — but nothing is booked.
   *
   * A substituted read is the precise opposite of a decline: Cortex offered the
   * refund and the agent took it. Booking `unrealized` here would charge the
   * adoption gap against the one turn that closed it, and `unrealized` is
   * reported separately for exactly the reason that would ruin — it measures
   * capability-versus-adoption, so inverting its sign on success is worse than
   * not measuring at all. The saving itself arrives on its own `credit` line
   * (AD-15) with its own evidence.
   */
  substituted = false,
): void {
  if (!scopeKey) {
    return;
  }
  // **Consume and book in ONE transaction.** As two operations, a failure
  // between them destroyed the offer and recorded nothing — measured, "offer
  // consumed but nothing booked: true" — silently losing the exact fact AC #6
  // exists to capture, and unrecoverably, because the offer is gone. Moving
  // offers out of `token_ledger` fixed AD-8's append-only violation; it did not
  // make the pair atomic, and those are separate defects.
  store.runInTransaction(() => {
    const offer = store.consumeReadOffer(sessionId, scopeKey, filePath);
    if (!offer || substituted) {
      return;
    }
    store.insertLedgerEntry({
      sessionId,
      type: 'unrealized:read',
      direction: 'unrealized',
      tokens: offer.tokens,
      evidence: { kind: 'read', ref: offer.path, size: offer.byteSize },
    });
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
    bookUnrealizedIfOffered(
      store,
      sessionId,
      session?.scope_key ?? null,
      args.file,
      args.substituted === true,
    );
  } catch {
    // Accounting must never break capture (AD-12).
  }
  recordReadDigest(store, sessionId, args);
  syncBranchSnapshotForSession(store, sessionId);
}

export interface SearchCaptureDeps {
  census: typeof computeRootCensus;
  /** Flush-time HEAD of the recording worktree; null when unresolvable. */
  headOid: (worktreePath: string) => string | null;
  /**
   * Which of `paths` git ignores, relative to `worktreePath`. Returns null when
   * the question cannot be answered (no git, error) — which must be treated as
   * "not ignored", never as "ignored".
   */
  ignored: (worktreePath: string, paths: string[]) => Set<string> | null;
}

export interface SearchArgs {
  pattern: string;
  /** Raw, as the tool reported it: '' (the scope root) or an absolute path. */
  root: string;
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
  /**
   * The flush pre-pass's verdict (`computeSearchEligibility`): nothing after
   * this search in its batch could have rewritten the tree under its root.
   * False means NOTHING is recorded — an uncertifiable negative has no
   * consumer and a stored one would assert about a tree the search never saw.
   */
  certified: boolean;
  deps?: SearchCaptureDeps;
  /** Per-batch memo (see `createSearchCaptureCache`). */
  cache?: SearchCaptureCache;
}

/**
 * Per-flush memo for the two expensive, batch-invariant facts: the worktree's
 * HEAD (one `git` spawn) and a root's census (a full walk). Both were computed
 * once per certified search inside the flush's write transaction, so N searches
 * over one root cost N walks and N spawns while holding the SQLite write lock.
 * Created per batch and discarded with it, exactly like the digest cache — a
 * module-level cache would serve a stale fingerprint for the life of the
 * process.
 */
export interface SearchCaptureCache {
  heads: Map<string, string | null>;
  censuses: Map<string, RootCensus>;
  ignored: Map<string, Set<string> | null>;
}

export function createSearchCaptureCache(): SearchCaptureCache {
  return { heads: new Map(), censuses: new Map(), ignored: new Map() };
}

function resolveHeadCached(
  deps: SearchCaptureDeps,
  cache: SearchCaptureCache | undefined,
  worktree: string,
): string | null {
  const cached = cache?.heads.get(worktree);
  if (cached !== undefined) return cached;
  const head = deps.headOid(worktree);
  cache?.heads.set(worktree, head);
  return head;
}

/**
 * Flush-time HEAD via one git spawn, cold path only, and only for a search
 * that is actually being recorded. Null on any failure — `head_oid` is
 * verdict METADATA (rendered, never compared), so a missing head costs a
 * cosmetic '-' in the verdict, never an assertion.
 */
function resolveFlushHeadOid(worktreePath: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const oid = out.trim();
    return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/**
 * `git check-ignore` over the runtime files the census skipped. One spawn, and
 * only when the walk actually met such a file — a search rooted anywhere below
 * the project root meets none, which is the common case.
 *
 * Exit code 0 means "some path is ignored", 1 means "none are", and anything
 * else is an error; only `--stdin -z` output is trusted, so a non-zero exit
 * with no output yields an empty set rather than a guess.
 */
function resolveIgnoredPaths(worktreePath: string, paths: string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: worktreePath,
      input: `${paths.join('\u0000')}\u0000`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return new Set(out.split('\u0000').filter(p => p.length > 0));
  } catch (error) {
    // Exit 1 = nothing ignored, which is a real answer, not a failure.
    const status = (error as { status?: number }).status;
    if (status === 1) return new Set();
    return null;
  }
}

const DEFAULT_SEARCH_DEPS: SearchCaptureDeps = {
  census: computeRootCensus,
  headOid: resolveFlushHeadOid,
  ignored: resolveIgnoredPaths,
};

/**
 * Record a certified zero-result search as a negative-cache entry (FR-12,
 * Story 4.3). Deliberately writes NO `events` row: the negative record is the
 * durable artifact, and a new event type would leak into branch-snapshot
 * summaries and session tails this story has no license to change.
 *
 * Every exit is silent (AD-12): this runs on the capture path, where a memory
 * failure must never break the turn. The gates, in order — certification
 * (computed by the flush, which can see the whole batch), the certifiability
 * class (`isCertifiableSearch`: patterns that cannot be an invalid regex, so
 * a pre-2.1.208 host's zero-shaped error response can never record a negative
 * for a search that never ran), root resolution (scope-relative or the scope
 * root itself; a root outside the scope or an unresolvable scope root records
 * nothing — never a cwd-anchored walk), then the census at the environment
 * ceilings. The stored pattern is redacted (people grep for secrets; PRD
 * §11.1 routes negative-result capture through the existing redaction) while
 * the KEY hashes the raw pattern, so distinct secret-bearing searches stay
 * distinct without the secret persisting.
 */
export function handleSearchEvent(store: CortexStore, sessionId: string, args: SearchArgs): void {
  if (!args.certified) return;
  try {
    const query = {
      pattern: args.pattern,
      root: args.root,
      ...(args.glob !== undefined ? { glob: args.glob } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.caseInsensitive !== undefined ? { caseInsensitive: args.caseInsensitive } : {}),
      ...(args.multiline !== undefined ? { multiline: args.multiline } : {}),
    };
    if (!isCertifiableSearch(query)) return;

    const session = store.getSession(sessionId);
    const scopeKey = session?.scope_key ?? null;
    if (!scopeKey) return;
    const scopeRoot = store.resolveScopeRoot(scopeKey);
    if (!scopeRoot) return;

    const relRoot = normalizeSearchRoot(args.root, scopeRoot);
    // Still absolute after normalization = outside the scope root. A negative
    // there is scoped to nothing this store owns; skip it.
    if (relRoot !== '' && isAbsoluteFileKey(relRoot)) return;
    const absRoot = relRoot === '' ? scopeRoot : path.join(scopeRoot, relRoot);

    const deps = args.deps ?? DEFAULT_SEARCH_DEPS;
    const cache = args.cache;
    let census = cache?.censuses.get(absRoot);
    if (census === undefined) {
      census = deps.census(absRoot);
      cache?.censuses.set(absRoot, census);
    }
    if (census.status !== 'ok') return;

    const worktree = session?.worktree_path ?? scopeRoot;

    // **Exclusion parity, or no record** (review round, measured). The census
    // skips Cortex's runtime files because they change on every tool call and
    // would invalidate every record instantly — but that is only sound if the
    // SEARCH skipped them too. Measured against the real Grep tool: a token
    // inside `.cortex.spool.jsonl` IS found in a repository whose ignore file
    // has not been swept, and hooks arrive machine-wide while ignore entries
    // are written per-repo, so every fresh project is in that state. Without
    // this gate the fingerprint proves "unchanged" over a smaller file universe
    // than the search read — a false assertion needing no change at all.
    // Nothing to check when the walk met no such file, which is every search
    // rooted below the project root.
    if (census.excludedCortex.length > 0) {
      const relToWorktree = census.excludedCortex.map(rel =>
        relRoot === '' ? rel : `${relRoot}/${rel}`,
      );
      const ignoreKey = `${worktree}\u0000${relToWorktree.join('\u0000')}`;
      let ignored = cache?.ignored.get(ignoreKey);
      if (ignored === undefined) {
        ignored = deps.ignored(worktree, relToWorktree);
        cache?.ignored.set(ignoreKey, ignored);
      }
      // null = unanswerable (no git, error). Ambiguity is a miss (AD-6).
      if (ignored === null) return;
      const answer = ignored;
      if (relToWorktree.some(p => !answer.has(p))) return;
    }
    store.upsertNegativeResult({
      scopeKey,
      queryKey: searchQueryKey({ ...query, root: relRoot }),
      tool: 'grep',
      pattern: redactSensitiveText(args.pattern),
      root: relRoot,
      paramsJson: searchParamsJson(query),
      headOid: resolveHeadCached(deps, cache, worktree),
      censusSha256: census.sha256,
      censusFiles: census.files,
      censusBytes: census.bytes,
    });
  } catch {
    // Capture edges never throw (AD-12): a failed negative-record is a lost
    // refund opportunity, never a broken flush.
  }
}

/** Only the params that were actually set, or null — keeps rows small. */
function searchParamsJson(query: {
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
}): string | null {
  const params: Record<string, string | boolean> = {};
  if (query.glob !== undefined && query.glob !== '') params['glob'] = query.glob;
  if (query.type !== undefined && query.type !== '') params['type'] = query.type;
  if (query.caseInsensitive === true) params['i'] = true;
  if (query.multiline === true) params['multiline'] = true;
  return Object.keys(params).length > 0 ? JSON.stringify(params) : null;
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
      refundEligible: args.refundEligible !== false,
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
