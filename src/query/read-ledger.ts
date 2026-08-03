import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexStore, ParsedContentDigest } from '../db/store.js';
import { computeFileDigest, createDigestCache, type DigestCache } from '../capture/digest.js';
import { formatMemoryTimestamp } from './render.js';

/**
 * The read-ledger query (FR-6, Story 3.3): has this session already read this
 * file, and has it changed since?
 *
 * **Evidence in hand, never a proxy (AD-6).** `unchanged` is asserted only after
 * re-hashing the current bytes and matching them against the recorded digest.
 * `mtime` is recorded by Story 3.1 for reporting and is never read here — it is
 * the exact proxy AD-6 names, and a file restored from backup or checked out by
 * git carries a new mtime with identical content, while a same-second edit
 * carries the old one with different content. Ambiguity resolves to a **miss**:
 * every state that cannot produce its evidence answers `changed-since`, which
 * costs a re-read and can never license a false refund.
 *
 * **Change detection is scope-wide; "you already have this" is session-bound
 * (AD-16).** A digest recorded by a sibling or descendant session is a valid
 * fact about the file and is reported as one — but it is not refund-eligible,
 * and the rendered line attributes it to the agent that actually read it rather
 * than saying "you".
 *
 * **Inherited imprecision, stated rather than hidden.** Story 3.1 records the
 * digest when the spool batch is *flushed*, not when the read happened. A file
 * changed by something outside Cortex in that window recorded the changed bytes
 * and will read as `unchanged-since` here. This module cannot repair that; it
 * inherits it, and the bound is the flush interval.
 */

/** Exactly four, per FR-6. Qualifiers ride on `changed-since`; there is no fifth. */
export type ReadLedgerVerdict =
  | 'unread'
  | 'unchanged-since'
  | 'changed-since'
  | 'edited-by-you-since';

/**
 * Why a `changed-since` could not be narrowed further.
 *
 * `missing` is AC #5's: the file is gone. `unverifiable` covers every state
 * where no comparison was possible — an `oversize` record (Story 3.1 stores
 * path and size but no `sha256` past the 2 MiB ceiling), a file that is now
 * oversize, a permission error, a path that is now a directory. Both are
 * *misses*: they report the safe direction, never `unchanged`.
 */
export type ReadLedgerQualifier = 'missing' | 'unverifiable';

export interface ReadLedgerRecorder {
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
}

export interface ReadLedgerResult {
  /** The path exactly as asked, so a caller can correlate without re-deriving. */
  path: string;
  /** The stored `(scope_key, path)` key half, or null when nothing was recorded. */
  key: string | null;
  verdict: ReadLedgerVerdict;
  qualifier?: ReadLedgerQualifier;
  /** When the digest was recorded, ISO-8601. Null for `unread`. */
  recordedAt: string | null;
  /**
   * AD-16. True only when the recording session is the requesting session or an
   * ancestor of it. A `false` here forbids the second person in any rendering.
   */
  refundEligible: boolean;
  /** Present only when NOT refund-eligible — who actually read it. */
  recordedBy?: ReadLedgerRecorder;
  /**
   * The recorded size of the file, when a digest exists. This is the *evidence*
   * an FR-8 credit is anchored to — the actual size of the actual file, which
   * is what separates a real saving from a counterfactual.
   */
  byteSize?: number;
}

export interface ReadLedgerQuery {
  paths: string[];
  /** The asking session. Its ancestry is the AD-16 eligibility set. */
  sessionId: string;
  /** Defaults to the asking session's scope. */
  scopeKey?: string | null;
  /**
   * Test seam only, and narrower than it looks: the *current* on-disk state is
   * what must be re-hashed, so this exists to make the hash observable, never to
   * supply a cached answer from a previous flush.
   */
  digestCache?: DigestCache;
  /**
   * Answer "is this file unchanged" without answering "who read it".
   *
   * `knownUnchangedFiles` renders a scope-wide line that names no reader, so
   * the attribution lookup is pure waste — a `getSession` per candidate whose
   * result is discarded, on the B-1 path. It also removes the need for a
   * sentinel session id to be the thing that makes a read non-eligible: with
   * this set, eligibility is not consulted at all rather than happening to
   * evaluate false because no row carries an empty `session_id`.
   */
  skipAttribution?: boolean;
  /**
   * Record an `offer:read` for every refund-eligible `unchanged-since`, so a
   * later read of that file books an *unrealized* saving (AC #6).
   *
   * **Opt-in, and off by default.** The agent-facing surfaces set it, because
   * those are the calls where Cortex actually tells an agent it already has the
   * content. Cortex's own internal probing — `knownUnchangedFiles`, which the
   * session brief runs on every SessionStart — must not, or the product would
   * manufacture offers to itself and then count the agent as having declined
   * them, inflating the exact number this exists to make honest.
   */
  recordOffers?: boolean;
}

/**
 * How many paths one query may answer.
 *
 * Every Cortex surface is budgeted, and this one renders a line per file, so an
 * unbounded list is an unbounded surface. AC #7's ≤30 tokens is enforced
 * per-file; the cap is what keeps the total bounded too. Excess paths are
 * dropped rather than truncated mid-line, and the renderer says so — a silently
 * shortened answer to "have I read these 40 files" reads as "no" for the ones
 * that fell off, which is the wrong-answer direction AD-6 forbids.
 */
export const READ_LEDGER_MAX_PATHS = 20;

/** AC #7. Asserted against the renderer, per file. */
export const READ_LEDGER_TOKENS_PER_FILE = 30;

/**
 * Resolve what to hash.
 *
 * A relative input is resolved against the **scope root**, not `process.cwd()`.
 * The stored key is scope-root-relative, and cwd is whatever directory the CLI,
 * the MCP server or a hook happened to start in — Story 3.2 measured that exact
 * substitution silently relocating every key it touched. Both transports pass
 * an absolute path for this reason; the relative branch serves programmatic
 * callers and stays deterministic for them. With no scope root known there is
 * nothing better than cwd, and that is the degraded case, not the design.
 */
export function resolveOnDiskPath(inputPath: string, scopeRoot: string | null): string {
  const asPosix = inputPath.replace(/\\/g, '/');
  if (asPosix.startsWith('/') || /^[a-z]:\//i.test(asPosix)) {
    return inputPath;
  }
  return scopeRoot ? path.join(scopeRoot, inputPath) : path.resolve(inputPath);
}

type ProbeResult =
  | { state: 'missing' }
  | { state: 'unverifiable' }
  | { state: 'hashed'; sha256: string }
  | { state: 'oversize' };

/**
 * Establish the file's current state, distinguishing *gone* from *unreadable*.
 *
 * `computeFileDigest` collapses both to `null` — correct for the capture path,
 * where a read that cannot be measured is simply not ledgered, but not enough
 * here: AC #5 requires `missing` specifically, and reporting a permission error
 * as `missing` would tell the agent a file it cannot read no longer exists.
 */
function probeCurrentState(absPath: string, digestCache?: DigestCache): ProbeResult {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      // A directory (or a device, or a socket) where a file was. The file as
      // recorded is not there, but calling that `missing` overstates what was
      // observed, and `unverifiable` reaches the same miss.
      return { state: 'unverifiable' };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT and ENOTDIR both mean the path does not resolve to anything.
    // Everything else — EACCES, EPERM, EBUSY, EMFILE — means it may well exist
    // and we simply cannot see it.
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { state: 'missing' }
      : { state: 'unverifiable' };
  }

  const digest = digestCache ? digestCache(absPath) : computeFileDigest(absPath);
  if (!digest) {
    // Stat succeeded and the hash did not: a race with a delete, or a lock.
    return { state: 'unverifiable' };
  }
  // Past the ceiling there is no hash to compare, whatever the record holds.
  return digest.sha256 === null
    ? { state: 'oversize' }
    : { state: 'hashed', sha256: digest.sha256 };
}

function recorderOf(store: CortexStore, digest: ParsedContentDigest): ReadLedgerRecorder {
  const session = store.getSession(digest.sessionId);
  return {
    sessionId: digest.sessionId,
    // The digest row's own `agent_id` is authoritative — it was written from the
    // resolved session at read time. The session lookup only adds `agent_type`,
    // and a session row that has since been pruned must not erase the id.
    agentId: digest.agentId ?? session?.agent_id ?? null,
    agentType: session?.agent_type ?? null,
  };
}

/**
 * Files this scope has read that are **still unchanged**, most-read first
 * (FR-7, Story 3.4).
 *
 * **Scope-wide, not session-scoped, and that is forced.** `inject-header` ends
 * the session tree and creates a fresh primary on every SessionStart, so a
 * filter for "reads by the asking session" would leave this permanently empty
 * on the one surface that runs at session start. The caller must therefore
 * describe the files rather than the reader — Story 3.3 measured 163 primary
 * sessions against 9 subagents on this repo's live store and had to stop saying
 * `read by primary` for the same reason. This function returns paths; it never
 * asserts who read them.
 *
 * **The cost is bounded before it is paid, not discovered while paying it.**
 * "Unchanged" requires re-hashing (AC #2 of Story 3.3), this runs under B-1
 * (session brief ≤150 ms p95), and a repository holds files of wildly different
 * sizes. So candidates are taken in `read_count` order, and `byte_size` — which
 * Story 3.1 already records — is accumulated against a ceiling *before* any
 * file is opened. A single 2 MiB candidate cannot consume the whole budget and
 * leave four cheap files unverified behind it.
 */
export interface KnownUnchangedOptions {
  /** Stop once this many unchanged files are found (AC #1 says up to five). */
  limit?: number;
  /** How many rows to consider at all. Bounds the SQL, not the hashing. */
  candidateLimit?: number;
  /** Total recorded bytes this call may hash before it stops looking. */
  byteBudget?: number;
}

export const KNOWN_UNCHANGED_LIMIT = 5;
export const KNOWN_UNCHANGED_CANDIDATES = 24;
/** 1 MiB of hashing, well inside B-1 on the platforms measured. */
export const KNOWN_UNCHANGED_BYTE_BUDGET = 1024 * 1024;

export function knownUnchangedFiles(
  store: CortexStore,
  scopeKeys: string[],
  options: KnownUnchangedOptions = {},
  /**
   * Seams, never used in production. The shared digest memo and the pre-hash
   * `statSync` have no observable difference from their absent counterparts —
   * building one cache per file and building one per walk return identical
   * answers — so without a seam a mutation removing either survives every
   * behavioural assertion. Story 3.3 added exactly this seam to
   * `queryReadLedger` after that mutation survived once; it was not extended
   * here, and the same mutation survived again.
   */
  deps: ReadLedgerDeps & { statSync: typeof fs.statSync } = {
    createDigestCache,
    statSync: fs.statSync,
  },
): string[] {
  const limit = clampCount(options.limit, KNOWN_UNCHANGED_LIMIT);
  const candidateLimit = clampCount(options.candidateLimit, KNOWN_UNCHANGED_CANDIDATES);
  const byteBudget = clampCount(options.byteBudget, KNOWN_UNCHANGED_BYTE_BUDGET);
  if (scopeKeys.length === 0 || limit < 1) {
    return [];
  }

  // Resolve every scope's root FIRST, and drop the ones that have none.
  //
  // `resolveOnDiskPath` falls back to `path.resolve(input)` when the root is
  // null, which anchors a stored RELATIVE key to `process.cwd()` — the exact
  // substitution Story 3.2 measured silently relocating every key it touched.
  // This is the first caller to feed stored relative keys back in, so the
  // fallback becomes reachable here for the first time: an orphan-scope row
  // plus a cwd that happens to contain a matching relative path yields
  // `unchanged-since` derived from a completely different file. Measured on
  // this repo's live store, `resolveScopeRoot` for the project scope key is
  // already null, and it is one of the two keys the brief always passes.
  const roots = new Map<string, string>();
  for (const scopeKey of scopeKeys) {
    const root = store.resolveScopeRoot(scopeKey);
    if (root !== null) {
      roots.set(scopeKey, root);
    }
  }
  if (roots.size === 0) {
    return [];
  }
  const usableScopes = [...roots.keys()];

  const placeholders = usableScopes.map(() => '?').join(', ');
  // `sha256 IS NOT NULL` excludes oversize records at the SQL layer: Story 3.1
  // stores path and size only past 2 MiB, so those can never be verified and
  // would burn a candidate slot to return `unverifiable` every time.
  // `read_count DESC` is AC #1's ordering; `recorded_at DESC` breaks ties so
  // paging is deterministic rather than dependent on physical row order.
  const rows = store.db
    .prepare(
      `SELECT scope_key, path, byte_size
         FROM content_digests
        WHERE scope_key IN (${placeholders})
          AND sha256 IS NOT NULL
        ORDER BY read_count DESC, recorded_at DESC
        LIMIT ?`,
    )
    .all(...usableScopes, candidateLimit) as {
    scope_key: string;
    path: string;
    byte_size: number;
  }[];

  const found: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  // One memo for the whole walk: a file recorded under two scope keys (the same
  // worktree on two branches) is one file on disk and must not be hashed twice.
  const digests = deps.createDigestCache();

  for (const row of rows) {
    if (found.length >= limit) {
      break;
    }
    // Dedupe by path. `resolveWorkingScopeKeys` always returns the preferred
    // scope AND the project scope, and Story 3.2 made digest paths
    // scope-root-relative — so one file read under both keys is two rows
    // carrying the same string, and the line rendered `src/a.ts, src/a.ts`,
    // burning slots out of AC #1's five. The two-scope case was already
    // anticipated for the hash memo one line below and stopped there.
    if (seen.has(row.path)) {
      continue;
    }
    seen.add(row.path);

    const absPath = resolveOnDiskPath(row.path, roots.get(row.scope_key) ?? null);
    // **Charge what the read will ACTUALLY cost, not what was recorded.**
    // `byte_size` is Story 3.1's size at record time; the hash reads whatever
    // is on disk now. Measured: rows totalling 24 recorded bytes hashed 48 MiB.
    // A file that grew is by definition *changed*, so it can never become a
    // hit — which is why the old `found.length > 0` gate never armed for it and
    // the two defects compounded into a B-1 breach (102 ms p95 measured, 216 ms
    // at a raised `CORTEX_DIGEST_MAX_BYTES`).
    const size = currentSizeOf(absPath, deps);
    if (size === null) {
      // Unmeasurable means unhashable, so it cannot be a hit. Skipping costs
      // nothing and keeps an unreadable path from consuming a candidate slot.
      continue;
    }
    // Gate on `spent > 0`, never on `found.length > 0`. Keying the ceiling on a
    // file having been *found* meant it could not fire until something had
    // already succeeded — so when every candidate is changed, which is the
    // ordinary state after a pull, a rebase or a branch switch, all of them
    // were hashed regardless of size. `spent > 0` still always attempts the
    // first candidate, so a single oversized file is not silently skipped.
    if (spent > 0 && spent + size > byteBudget) {
      break;
    }
    spent += size;

    const [result] = queryReadLedger(store, {
      paths: [row.path],
      // No session: this caller asks "is the file unchanged", never "did you
      // read it". `skipAttribution` makes that explicit rather than leaning on
      // an id that happens to match nothing — and saves a `getSession` per
      // candidate whose result was being discarded on the B-1 path.
      sessionId: '',
      skipAttribution: true,
      scopeKey: row.scope_key,
      digestCache: digests,
    });
    if (result?.verdict === 'unchanged-since') {
      found.push(row.path);
    }
  }
  return found;
}

/**
 * A caller-supplied count, or the default.
 *
 * `NaN < 1` is false, so an unguarded `limit` of `NaN` sailed past the guard,
 * and a negative `candidateLimit` reached SQLite — which reads a negative
 * `LIMIT` as *no limit* and would walk the whole table. That is verbatim the
 * hazard `resolvePageLimit` documents for `list-memory`.
 */
function clampCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 0 ? floored : fallback;
}

/** Current size on disk, or null when it cannot be measured at all. */
function currentSizeOf(
  absPath: string,
  deps: { statSync: typeof fs.statSync },
): number | null {
  try {
    const stat = deps.statSync(absPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export interface ReadLedgerDeps {
  /**
   * Injected only so the per-query memo can be *observed*. Building one cache
   * per query and building one per path produce identical answers, so no
   * behavioural assertion can tell them apart — which is exactly how a mutation
   * removing the memo survived a suite that already tested memoisation, by
   * passing a cache in explicitly and never exercising the default. Production
   * always takes the default. Same reasoning as `writeDigestIndex`'s injected
   * `renameSync`: a mechanism with no observable difference needs a seam or it
   * regresses silently.
   */
  createDigestCache: typeof createDigestCache;
}

/**
 * Record that Cortex offered a file as unchanged, so a later read of it can be
 * booked as an *unrealized* saving (FR-8 AC #6).
 *
 * Only refund-eligible `unchanged-since` answers are offers: those are the ones
 * where Cortex told the asking session it already has the content. A
 * `changed-since` or a sibling's read is information, not an offer, and
 * declining it costs nothing.
 *
 * `tokens` is the read this would have avoided, estimated from the recorded
 * byte size — the one place a token count here is derived rather than measured,
 * because the read did not happen so there is nothing to measure. It is
 * anchored to *recorded evidence* (the actual size of the actual file), which
 * is what separates it from the counterfactual AC #3 forbids.
 */
function recordReadOffers(
  store: CortexStore,
  sessionId: string,
  scopeKey: string | null,
  results: ReadLedgerResult[],
): void {
  for (const result of results) {
    if (result.verdict !== 'unchanged-since' || !result.refundEligible || !result.key) {
      continue;
    }
    try {
      const size = result.byteSize ?? 0;
      if (size <= 0 || !scopeKey) {
        continue;
      }
      store.upsertReadOffer({
        sessionId,
        scopeKey,
        path: result.key,
        byteSize: size,
        // `ceil(bytes / 4)`, which is an UPPER BOUND on the tokens, not an
        // equality. `estimateTokens` counts characters; this counts bytes on
        // disk, and UTF-8 makes those differ — measured 2× on a 2000-character
        // file of two-byte characters. Reading the file to count characters
        // would cost the read this is accounting for the avoidance of, so the
        // bound is taken deliberately and named rather than claimed to agree.
        tokens: Math.ceil(size / 4),
      });
    } catch {
      // Accounting never breaks the answer.
    }
  }
}

export function queryReadLedger(
  store: CortexStore,
  query: ReadLedgerQuery,
  deps: ReadLedgerDeps = { createDigestCache },
): ReadLedgerResult[] {
  const session = store.getSession(query.sessionId);
  const scopeKey = query.scopeKey ?? session?.scope_key ?? null;
  const paths = query.paths.slice(0, READ_LEDGER_MAX_PATHS);

  // Without a scope there is no key, so nothing can have been recorded. Answer
  // `unread` rather than throwing: AD-12 binds every ambient edge to silence,
  // and `unread` is the honest, safe answer — it prompts a real read.
  if (!scopeKey) {
    return paths.map(p => ({
      path: p,
      key: null,
      verdict: 'unread' as const,
      recordedAt: null,
      refundEligible: false,
    }));
  }

  // The STORE's root, never `session.worktree_path`. `getContentDigest` derives
  // the lookup key against `resolveScopeRoot`, and resolving the on-disk path
  // against the requesting session's own worktree instead would be two roots
  // for one query — the asymmetry Story 3.2 was bitten by and that
  // `recordReadDigest` carries three lines of comment to avoid. Content-derived
  // comparison masks it today: hashing the wrong checkout's copy can only yield
  // a content mismatch, never a false `unchanged`. That is a reason it went
  // unnoticed, not a reason to keep it — Story 3.4 feeds relative paths in here.
  const scopeRoot = store.resolveScopeRoot(scopeKey);
  // One walk per query, not per path: the eligibility set is a property of the
  // asking session.
  const ancestry = new Set(store.getSessionAncestorIds(query.sessionId));
  // One memo per query. Hashing dominates the cost — measured, 20 files just
  // under the 2 MiB ceiling cost p95 44 ms against AC #7's 20 ms, while the 20
  // largest real files in this repository cost 5 ms — so a query naming the
  // same path twice must not pay twice. Created per call and discarded with it:
  // a module-level cache would serve a stale hash forever in the long-lived MCP
  // process, which is the one thing re-hashing exists to prevent.
  const digests = query.digestCache ?? deps.createDigestCache();

  const results = paths.map(inputPath => {
    const digest = store.getContentDigest(scopeKey, inputPath);
    if (!digest) {
      return {
        path: inputPath,
        key: null,
        verdict: 'unread' as const,
        recordedAt: null,
        refundEligible: false,
      };
    }

    // Two conditions, two different questions. Ancestry (AD-16) answers "did
    // YOU read it"; the record's own eligibility answers "does the digest
    // describe what that read RETURNED" — false when the read was followed in
    // its flush batch by an edit of the path or by any command (Story 4.5
    // review round). An ineligible record still detects change; it must never
    // ground a refund offer, because consuming one books `unrealized` against
    // the agent for declining content the record cannot prove it ever had.
    const refundEligible = ancestry.has(digest.sessionId) && digest.refundEligible;
    const base = {
      path: inputPath,
      key: digest.path,
      recordedAt: digest.recordedAt,
      refundEligible,
      byteSize: digest.byteSize,
      ...(refundEligible || query.skipAttribution
        ? {}
        : { recordedBy: recorderOf(store, digest) }),
    };

    const absPath = resolveOnDiskPath(inputPath, scopeRoot);
    const current = probeCurrentState(absPath, digests);

    if (current.state === 'missing') {
      return { ...base, verdict: 'changed-since' as const, qualifier: 'missing' as const };
    }
    if (current.state === 'unverifiable' || current.state === 'oversize') {
      return { ...base, verdict: 'changed-since' as const, qualifier: 'unverifiable' as const };
    }
    // An oversize *record* has no `sha256` to compare against, so `unchanged` is
    // unassertable however readable the file is now.
    if (digest.sha256 === null) {
      return { ...base, verdict: 'changed-since' as const, qualifier: 'unverifiable' as const };
    }

    // **Your own edit is checked BEFORE the content comparison, and the order is
    // the correctness argument, not a preference.**
    //
    // Story 3.1 records the digest when the spool is *flushed*, not when the
    // read happened. So the ordinary sequence — read a file, edit it, ask later
    // — replays the read line against POST-edit bytes: the record equals the
    // file on disk while the agent's context holds the pre-edit content.
    // Comparing content first therefore answered `unchanged-since`,
    // refund-eligible, for a file the agent demonstrably did not have. Measured:
    // context `ORIGINAL`, record and disk both `EDITED`, verdict
    // `unchanged-since`, and `sessionEditedPathAfter` returning **true** the
    // whole time — the evidence to answer correctly was in hand and the
    // ordering skipped it.
    //
    // An earlier version of this code justified the reverse order as "Cortex is
    // holding proof the content is identical". That proof is about the wrong
    // snapshot: identical to the RECORD, which is not what was read.
    // `src/capture/digest.ts` had already promised the opposite in writing —
    // "an edit replayed from the same spool wins the verdict (Story 3.3's
    // `edited-by-you-since`)" — so the ordering also broke a documented
    // cross-story contract.
    //
    // It says *you* twice over: you read it (the record must be refund-eligible
    // under AD-16) and you changed it (the edit must be this session's own). An
    // ancestor's edit is deliberately NOT yours — AC #4 says "the requesting
    // session edited" — and falls through to the content comparison below.
    if (
      refundEligible &&
      store.sessionEditedPathAfter({
        sessionId: query.sessionId,
        scopeKey,
        path: inputPath,
        after: digest.recordedAt,
        scopeRoot,
      })
    ) {
      return { ...base, verdict: 'edited-by-you-since' as const };
    }

    if (current.sha256 === digest.sha256) {
      return { ...base, verdict: 'unchanged-since' as const };
    }

    return { ...base, verdict: 'changed-since' as const };
  });

  if (query.recordOffers) {
    recordReadOffers(store, query.sessionId, scopeKey, results);
  }
  return results;
}

/** Written when a recorder's display name sanitizes away to nothing. */
const UNNAMED_AGENT = 'an unnamed agent';

/**
 * The maximum display width of a recorder's name.
 *
 * `agent_type` is author-supplied and shares a 30-token line with the verdict.
 * Uncapped, one long name pushes the path out of the budget entirely.
 */
const MAX_AGENT_LABEL = 32;

/**
 * How the recorder is named when the read was not yours (AD-16).
 *
 * **A primary session is never named by its `agent_type`.** That column
 * defaults to `'primary'` for every non-subagent session, and `inject-header`
 * ends the session tree and creates a fresh primary on each SessionStart — so
 * *any* read from an earlier session of the same project renders here. Measured
 * on this repo's live store: 163 primary sessions against 9 subagents, so
 * `read by primary` was the ~18:1 majority answer, naming a role that every
 * session shares including the asker's own. That is the opposite of AC #6's
 * "attributed to the agent that actually read it", and it sits one synonym away
 * from the second person the rule forbids. An earlier primary is described as
 * what it is; only a genuine subagent gets a name.
 */
function attributionOf(recorder: ReadLedgerRecorder): string {
  const isSubagent = recorder.agentId !== null && recorder.agentId !== '';
  if (!isSubagent) {
    return 'read in an earlier session';
  }
  // `agent_type` is the human-meaningful half ("code-reviewer"); the id is the
  // fallback so the line still identifies *someone*.
  const raw = recorder.agentType ?? recorder.agentId ?? recorder.sessionId;
  const label = sanitizeAgentLabel(raw);
  return `read by subagent ${label}`;
}

/**
 * Make an author-supplied agent name safe to place inside a rendered verdict.
 *
 * This is a stored string reaching a renderer, so it takes the discipline
 * `buildNoteMemoryText`, `renderedAlternatives` and `inspect-memory` already
 * apply — but the grammar of *this* line makes two extra characters dangerous,
 * both measured:
 *
 * - **`;` forges a qualifier.** Qualifiers render as `(missing; read by …)`, so
 *   an `agent_type` of `general-purpose; missing` produced
 *   `(read by general-purpose; missing)` — a `missing` qualifier no probe ever
 *   returned. Parentheses close and reopen the group for the same reason.
 * - **The second person defeats AC #6 outright.** An `agent_type` of `you`
 *   rendered `(read by you)` on a read that was explicitly NOT the asker's —
 *   the one sentence AD-16 forbids, with the suite green, because the test
 *   supplies the name it then asserts against. Neutralised as whole tokens, so
 *   an honest name like `youtube-indexer` is untouched.
 *
 * Control characters are stripped rather than collapsed: `\x1b[1A\x1b[2K` in a
 * name erases the *previous* file's verdict from a terminal, so one line's
 * attribution could hide another line's answer.
 */
export function sanitizeAgentLabel(value: string): string {
  const cleaned = collapse(value)
    .replace(/[;()]/g, ' ')
    .replace(/\byou(?:rs?)?\b/gi, 'that agent')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) {
    return UNNAMED_AGENT;
  }
  return cleaned.length > MAX_AGENT_LABEL
    ? `${cleaned.slice(0, MAX_AGENT_LABEL - 1)}…`
    : cleaned;
}

/**
 * Strip anything that can move a cursor, forge a line, or split a record.
 *
 * `[\r\n\t]` alone was not enough. C0 and C1 control characters, `U+2028` and
 * `U+2029` all reached the output; ESC is the one that matters, because a
 * terminal acts on it. Replaced with a space rather than deleted, so two words
 * separated only by a control character do not silently fuse.
 */
function collapse(value: string): string {
  // The class is written with ESCAPES, never literal control bytes.
  // Authoring it literally put a raw NUL into this file - which is exactly
  // how `src/transports/hook-entry.ts` became invisible to ripgrep, grep and
  // `certify_refs`'s text pass, hiding one of four copies of `findDbPath`.
  // A literal control character is also unreviewable in a diff and does not
  // survive a copy-paste. Replaced with a space rather than deleted, so two
  // words separated only by a control character do not silently fuse.
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One line per file, each within AC #7's 30-token budget.
 *
 * The path is truncated from the LEFT when a line would exceed the budget:
 * `…/query/read-ledger.ts` still identifies the file, while a right-truncated
 * `src/query/read-le…` is ambiguous between siblings — and the verdict, which
 * is the answer, must never be what gets cut.
 */
export function renderReadLedgerLine(result: ReadLedgerResult): string {
  const parts: string[] = [result.verdict];
  if (result.recordedAt) {
    // A `recorded_at` that will not parse must not silently cost the `<ts>` the
    // AC's shape names. `formatMemoryTimestamp` returns null for one, and the
    // old code dropped the part entirely — rendering a bare `unchanged-since`
    // that reads as a complete verdict rather than a damaged one. The column is
    // NOT NULL so this needs a hand-edited or migrated row to reach, but "the
    // schema prevents it" is not the same as "the renderer handles it".
    parts.push(formatMemoryTimestamp(result.recordedAt) ?? 'unknown-time');
  }
  const qualifiers: string[] = [];
  if (result.qualifier) {
    qualifiers.push(result.qualifier);
  }
  if (result.recordedBy) {
    qualifiers.push(attributionOf(result.recordedBy));
  }
  if (qualifiers.length > 0) {
    parts.push(`(${qualifiers.join('; ')})`);
  }

  const verdict = parts.join(' ');
  const budgetChars = READ_LEDGER_TOKENS_PER_FILE * 4;
  const room = budgetChars - verdict.length - 2; // ": "
  const shown = fitPathLeft(collapse(result.path), room);
  return `${shown}: ${verdict}`;
}

function fitPathLeft(value: string, room: number): string {
  if (room <= 1) {
    // The verdict alone has consumed the budget. Keeping a one-character stub
    // would be worse than useless; the caller still has `result.path`.
    return '…';
  }
  return value.length <= room ? value : `…${value.slice(value.length - (room - 1))}`;
}

export function renderReadLedger(results: ReadLedgerResult[], requested = results.length): string {
  if (results.length === 0) {
    return 'Read ledger: no paths given.';
  }
  const lines = results.map(renderReadLedgerLine);
  if (requested > results.length) {
    // Named, not silent. See READ_LEDGER_MAX_PATHS.
    lines.push(`(${requested - results.length} more path(s) not answered; cap is ${READ_LEDGER_MAX_PATHS})`);
  }
  return lines.join('\n');
}
