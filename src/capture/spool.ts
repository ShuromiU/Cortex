import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexStore } from '../db/store.js';
import { isAbsoluteFileKey, normalizeFilePathKey } from '../scope/keys.js';
import { resolveAgentSessionId } from '../scope/runtime.js';
import { createDigestCache, type DigestCache, type DigestDeps } from './digest.js';
import {
  describeScan,
  failedOutcomes,
  outcomeExitCode,
  outcomesByCommand,
  scanTranscriptTail,
  type CommandOutcomeMap,
  type TranscriptOutcome,
} from './transcript.js';
import { digestIndexExists, writeDigestIndex } from './digest-index.js';
import {
  createSearchCaptureCache,
  handleAgentEvent,
  handleCmdEvent,
  handleEditEvent,
  handleReadEvent,
  handleSearchEvent,
  handleWriteEvent,
  type SearchCaptureCache,
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
  /** Subagent identity, written by the hook; absent for primary-session work. */
  agent_id?: string;
  agent_type?: string;
  /**
   * The hot path replaced this read's output (Story 4.5, AD-7).
   *
   * Typed loosely on purpose: `jq` preserves JSON types, so the hook's
   * `{subst:1}` arrives as a **number**, not a boolean or a string — the same
   * hazard this file already documents for `agent_id` and `credit_size`.
   * Interpreted through `isSubstitutedRead`, never by truthiness.
   */
  subst?: unknown;
  /**
   * A zero-result search observed by the hook (FR-12, Story 4.3).
   *
   * `tool: 'search'`. `stool` names the searching tool ('grep'); `pattern`,
   * `sroot`, `sglob`, `stype` carry the matching-relevant parameters exactly
   * as the tool reported them (`sroot` may be '' — the scope root). `zero`,
   * `sci` and `sml` are jq-emitted flags and arrive as NUMBERS — interpreted
   * through `readJsonFlag`, never truthiness, the `subst` hazard again. The
   * hook emits a search line only when the payload POSITIVELY proved zero
   * results under a recognized response shape; ambiguity emits nothing.
   */
  stool?: string;
  pattern?: string;
  sroot?: string;
  sglob?: string;
  stype?: string;
  sci?: unknown;
  sml?: unknown;
  zero?: unknown;
  /**
   * This `cmd` was launched into the background (Story 4.3 review round).
   *
   * PostToolUse fires at LAUNCH, so a backgrounded build's timestamp orders
   * *before* a later search while the process keeps writing after it — the
   * ordered `>=` disqualifier is blind to exactly the writer most likely to
   * invalidate a search. Any `bg` command in a batch disqualifies every search
   * in that batch, whatever the order. jq emits it as a number, so it is read
   * through `readJsonFlag`.
   */
  bg?: unknown;
  /**
   * A credit that originated on the hot path (AD-15, FR-8 AC #5).
   *
   * The hot path may not open SQLite (AD-2), so a substitution that avoids a
   * read cannot book its own credit. It emits a spool record carrying its own
   * evidence instead, and the cold-path flush books it under the same
   * exactly-once claim as every other spool line. **A lost record is no credit,
   * never a reconstructed one** — there is no replay from inference, because a
   * credit Cortex cannot evidence is the thing AC #3 forbids.
   *
   * Set `tool: 'credit'`. `credit_size` is bytes for a read, output size for a
   * command, result count for a search.
   */
  credit_kind?: 'read' | 'command' | 'search';
  credit_ref?: string;
  credit_size?: string;
  credit_tokens?: string;
}

export interface SpoolFlushResult {
  processed: number;
  skipped: number;
  /**
   * Failed commands recorded from the transcript because no hook ever saw them
   * (FR-14). Reported rather than silent: the synthesis loop is bounded, and a
   * bound nobody can observe is how a cap becomes a lie about coverage.
   */
  synthesized: number;
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

/**
 * Whether `replayEntry` will accept this entry. Checked before resolving a
 * session so an entry this build cannot replay — an unknown tool from a newer
 * hook, a line missing its target — never materializes an event-less child
 * session as a side effect.
 */
function isReplayable(entry: SpoolEntry): boolean {
  switch (entry.tool) {
    case 'read':
    case 'edit':
    case 'write':
      return Boolean(entry.file);
    case 'cmd':
      return Boolean(entry.cmd);
    case 'agent':
      return Boolean(entry.desc);
    case 'search':
      // Only a POSITIVELY-proven zero result is replayable; a search line
      // without the zero flag has no consumer (D3: non-zero searches are not
      // captured in this story) and is skipped rather than half-recorded.
      return Boolean(entry.pattern) && readJsonFlag(entry.zero);
    case 'credit':
      // Every field is required. A credit line missing any part of its evidence
      // is dropped rather than booked at a default — AC #5's "a lost spool
      // record results in no credit rather than a reconstructed one" is the
      // same rule applied to a partial record as to an absent one.
      return (
        creditKindOf(entry) !== null &&
        Boolean(entry.credit_ref) &&
        parseCreditNumber(entry.credit_size) !== null &&
        parseCreditNumber(entry.credit_tokens) !== null
      );
    default:
      return false;
  }
}

/** The evidence kinds a hot-path credit may claim; anything else is dropped. */
function creditKindOf(entry: SpoolEntry): 'read' | 'command' | 'search' | null {
  return entry.credit_kind === 'read' ||
    entry.credit_kind === 'command' ||
    entry.credit_kind === 'search'
    ? entry.credit_kind
    : null;
}

/**
 * A spool field is text the hook wrote, so a credit's numbers are parsed, never
 * trusted. `Number`, not `parseInt`: `parseInt` succeeds on a prefix, so
 * `'12abc'` would book 12 tokens of credit from a malformed line — the third
 * time this repo has had to say so. Non-finite, negative and fractional all
 * yield null, which drops the line.
 */
function parseCreditNumber(raw: unknown): number | null {
  // `String(raw)` rather than `raw.trim()`. The parameter is TYPED as a string
  // and is not one: `jq` preserves JSON types, so a hook emitting
  // `credit_size: 4096` unquoted delivers a number — and `raw.trim is not a
  // function` threw out of `isReplayable`, off the capture path. `spool.ts`
  // already documents exactly this hazard for `agent_id` and coerces there; the
  // credit fields were added without it.
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Whether a read line was substituted by the hot path.
 *
 * Explicit rather than truthy. `jq` delivers the hook's `{subst:1}` as the
 * number `1`, a hand-written line could carry `"1"` or `true`, and truthiness
 * would additionally accept `"false"`, `"0"` and `{}` — every one of which
 * would suppress a real `unrealized` decline and quietly flatter the adoption
 * figure. Anything unrecognised is `false`: the read is treated as ordinary,
 * which is the pre-4.5 behaviour and the safe direction.
 */
function isSubstitutedRead(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === '1' || raw === 'true';
}

/**
 * The generic form of `isSubstitutedRead`'s explicit test, for the search
 * flags: `jq` emits `{zero:1}` as a NUMBER, and truthiness would additionally
 * accept `"false"`, `"0"` and `{}`.
 */
function readJsonFlag(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === '1' || raw === 'true';
}

/**
 * A stable id for a credit row, derived from the record's own content.
 *
 * Booking the same spool line twice must be a no-op, and the flush's claim is
 * not sufficient on its own: an orphaned `.processing` file can be picked up by
 * two processes. `seq`/`ts` are included when present so two genuinely distinct
 * credits for the same file in one batch stay distinct.
 */
function creditRowId(
  sessionId: string,
  entry: SpoolEntry,
  kind: string,
  size: number,
  tokens: number,
): string {
  const parts = [
    sessionId,
    kind,
    entry.credit_ref ?? '',
    String(size),
    String(tokens),
    entry.seq === undefined ? '' : String(entry.seq),
    entry.ts ?? '',
  ].join('\u0000');
  return `credit:${crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32)}`;
}

/**
 * Whether each read entry's digest will describe the bytes that read RETURNED
 * (Story 4.5 review round — the flush-window defect, reproduced before fixed).
 *
 * The digest is computed at FLUSH time, a whole turn after the read, and the
 * substitution hook then asserts "byte-identical to what you already read"
 * from it. That assertion is a lie whenever the file changed between the read
 * and the flush — and the flush can SEE the in-session causes, because they
 * were captured too. A read is disqualified by:
 *
 * - a later `edit`/`write` event on the same path (compared through
 *   `normalizeFilePathKey`, the same fold the digest key uses), or
 * - **any** later `cmd` event — a command can rewrite any file invisibly, and
 *   classifying which commands write what is Story 4.4's problem, not a guess
 *   this path is allowed to make (AD-6). Deliberately conservative: a read
 *   followed in its turn by a build simply is not refund-eligible, which is
 *   also product-correct — the build may have reformatted what was read.
 *
 * `>=` on the timestamp, not `>`: the hook records at whole-second
 * granularity, so a same-second neighbour is ambiguous, and ambiguity is a
 * miss. An entry with no timestamp at all disqualifies maximally for the same
 * reason. What this cannot see — a writer outside Cortex entirely — is Story
 * 3.1's documented flush-window bound, unchanged; the residue here is
 * milliseconds (a mutation between the last captured event and the hash),
 * down from a full turn.
 */
function computeReadEligibility(
  entries: SpoolEntry[],
  live: LiveSpoolDisqualifiers,
  conservative: boolean,
): boolean[] {
  const MAX_TS = '￿';
  let latestCmdTs: string | null = live.anyCmd ? MAX_TS : null;
  const latestEditTs = new Map<string, string>();
  for (const path of live.editedPaths) {
    latestEditTs.set(path, MAX_TS);
  }

  for (const entry of entries) {
    const ts = entry.ts ?? MAX_TS;
    if (entry.tool === 'cmd') {
      if (latestCmdTs === null || ts > latestCmdTs) latestCmdTs = ts;
    } else if ((entry.tool === 'edit' || entry.tool === 'write') && entry.file) {
      const key = normalizeFilePathKey(entry.file);
      const prior = latestEditTs.get(key);
      if (prior === undefined || ts > prior) latestEditTs.set(key, ts);
    }
  }

  return entries.map(entry => {
    if (entry.tool !== 'read' || !entry.file) return false;
    if (conservative || entry.ts === undefined) return false;
    if (latestCmdTs !== null && latestCmdTs >= entry.ts) return false;
    const editTs = latestEditTs.get(normalizeFilePathKey(entry.file));
    return !(editTs !== undefined && editTs >= entry.ts);
  });
}

/**
 * Which `search` entries may be RECORDED as negatives (FR-12, Story 4.3).
 *
 * The census is computed at flush time, a whole turn after the search ran —
 * if anything after the search in its batch could have changed the tree under
 * its root, the census would describe a tree the search never examined, and a
 * later byte-identical query would assert "no matches" for content the search
 * never saw: SM-C3 in two ordinary tool calls. Unlike `computeReadEligibility`
 * this gates RECORDING, not a flag — an uncertifiable negative has no other
 * consumer, so it is simply never stored.
 *
 * Disqualifiers, each resolving ambiguity to a miss (AD-6):
 * - `conservative` (inject-header's leftover flushes certify nothing) or a
 *   missing timestamp;
 * - any `cmd` at-or-after the search (`>=`: hook stamps are whole-second, and
 *   commands rewrite files invisibly — classifying them is Story 4.4's
 *   problem);
 * - **any BACKGROUNDED `cmd` anywhere in the batch, whatever the order**
 *   (review round): its PostToolUse fires at launch, so a build started before
 *   the search orders before it and then writes after it — the ordered rule is
 *   blind to precisely the writer most likely to invalidate the search;
 * - any `edit`/`write` at-or-after the search whose file sits UNDER the
 *   search's root. An edit outside the root is irrelevant and must not
 *   disqualify, or search-then-edit turns would kill every record. A root of
 *   '' means the scope root, under which every edit presumptively falls;
 * - a RELATIVE non-empty root: it would need resolving against the recording
 *   session's cwd, which the flush does not have — resolving against the
 *   flush's own cwd is the 3.2 relocation defect;
 * - anything in the live-spool peek (events that landed after the claim).
 */
function computeSearchEligibility(
  entries: SpoolEntry[],
  live: LiveSpoolDisqualifiers,
  conservative: boolean,
): boolean[] {
  const MAX_TS = '￿';
  let latestCmdTs: string | null = live.anyCmd ? MAX_TS : null;
  let anyBackgroundCmd = false;
  interface EditStamp {
    key: string;
    ts: string;
  }
  const edits: EditStamp[] = [];
  for (const p of live.editedPaths) {
    edits.push({ key: p, ts: MAX_TS });
  }
  for (const entry of entries) {
    const ts = entry.ts ?? MAX_TS;
    // `mutate` is a file-writing tool the hook cannot model (NotebookEdit, the
    // symbol-refactor tools). It carries no path, so it is treated exactly like
    // a command: anything at-or-after the search disqualifies it. Nothing
    // replays these lines; they exist only to be seen here.
    if (entry.tool === 'cmd' || entry.tool === 'mutate') {
      if (readJsonFlag(entry.bg)) anyBackgroundCmd = true;
      if (latestCmdTs === null || ts > latestCmdTs) latestCmdTs = ts;
    } else if ((entry.tool === 'edit' || entry.tool === 'write') && entry.file) {
      edits.push({ key: normalizeFilePathKey(entry.file), ts });
    }
  }

  const editUnderRootAtOrAfter = (rootRaw: string, searchTs: string): boolean => {
    if (rootRaw === '') {
      return edits.some(e => e.ts >= searchTs);
    }
    const rootKey = normalizeFilePathKey(rootRaw).replace(/\/+$/, '');
    return edits.some(
      e => e.ts >= searchTs && (e.key === rootKey || e.key.startsWith(`${rootKey}/`)),
    );
  };

  return entries.map(entry => {
    if (entry.tool !== 'search' || !entry.pattern) return false;
    if (conservative || entry.ts === undefined) return false;
    // Order-independent: a backgrounded command is still running, so it can
    // write after a search that its own timestamp precedes.
    if (anyBackgroundCmd) return false;
    const root = entry.sroot ?? '';
    if (root !== '' && !isAbsoluteFileKey(root.replace(/\\/g, '/'))) return false;
    if (latestCmdTs !== null && latestCmdTs >= entry.ts) return false;
    return !editUnderRootAtOrAfter(root, entry.ts);
  });
}

interface LiveSpoolDisqualifiers {
  anyCmd: boolean;
  editedPaths: string[];
}

/**
 * Events already sitting in the LIVE spool while this flush runs.
 *
 * The 256 KiB threshold flush is backgrounded and the turn continues around
 * it: a command that runs after the claim but before this flush hashes a file
 * has already changed the disk the hash will read, and its spool line — in the
 * fresh post-claim spool — is the only evidence. PostToolUse appends after the
 * tool finishes, so the change precedes the line; a peek at flush time
 * therefore sees every completed mutator except one still mid-append, a window
 * of milliseconds. Best-effort by design: an unreadable live spool
 * disqualifies nothing extra, which costs at most a wrong-direction refund
 * already bounded by Story 3.1's flush-window caveat.
 */
/** `mutate` counts as a live command: an unmodellable writer landed after the claim. */
function peekLiveSpool(dir: string): LiveSpoolDisqualifiers {
  try {
    const raw = fs.readFileSync(deriveSpoolPath(dir), 'utf8');
    const entries = parseSpoolLines(raw);
    return {
      anyCmd: entries.some(entry => entry.tool === 'cmd' || entry.tool === 'mutate'),
      editedPaths: entries
        .filter(entry => (entry.tool === 'edit' || entry.tool === 'write') && entry.file)
        .map(entry => normalizeFilePathKey(entry.file as string)),
    };
  } catch {
    return { anyCmd: false, editedPaths: [] };
  }
}

function replayEntry(
  store: CortexStore,
  sessionId: string,
  entry: SpoolEntry,
  digestCache: DigestCache,
  readEligible: boolean,
  searchCertified: boolean,
  searchCache?: SearchCaptureCache,
  outcomes?: CommandOutcomeMap,
): boolean {
  switch (entry.tool) {
    case 'read':
      if (!entry.file) return false;
      handleReadEvent(store, sessionId, {
        file: entry.file,
        ...(entry.lines ? { lines: entry.lines } : {}),
        digestCache,
        substituted: isSubstitutedRead(entry.subst),
        refundEligible: readEligible,
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
    case 'cmd': {
      if (!entry.cmd) return false;
      // The outcome the hook could not carry (FR-14). Attached by exact command
      // text, and only when the window is UNAMBIGUOUS about it — the same text
      // twice with different outcomes attaches nothing rather than guessing.
      //
      // **Two spool lines must never take an outcome from this transcript**,
      // and both were measured writing wrong data before this guard existed:
      //
      // - `bg`: PostToolUse fires at LAUNCH for a backgrounded command, and the
      //   host's own result for the launch is a success ("Command running in
      //   background with ID: …"). A backgrounded `npm test` therefore stored
      //   `exit 0` — which is exactly the gate `writeCommandEpisodes` reads to
      //   emit a `test_cycle`, i.e. "tests passed", for a process that had not
      //   finished. That is the worst failure this product can produce, arrived
      //   at from the one direction nothing else in this story could reach.
      // - `agent_id`: a subagent's turns are written to its OWN transcript
      //   (measured: 0 sidechain entries in 2,733 real Bash calls), so a
      //   subagent's run is invisible here and the `ambiguous` guard cannot
      //   fire. The parent's verdict for the same text would be stamped onto
      //   the child's run. The same defeat applies to a second window open on
      //   the same directory: shared spool file, separate transcripts.
      //
      // Both fields are already on the line and already read elsewhere; the
      // outcome attach simply has to respect them.
      const attachable =
        !readJsonFlag(entry.bg) && normalizeAgentId(entry.agent_id) === undefined;
      const observed = attachable ? outcomes?.get(entry.cmd) : undefined;
      const evidenced =
        observed !== undefined && observed !== 'ambiguous' ? outcomeExitCode(observed) : null;
      const exit =
        entry.exit !== undefined
          ? entry.exit
          : evidenced !== null
            ? String(evidenced)
            : undefined;
      handleCmdEvent(store, sessionId, {
        cmd: entry.cmd,
        ...(exit !== undefined ? { exit } : {}),
        ...(entry.stdout !== undefined ? { stdout: entry.stdout } : {}),
        ...(entry.stderr !== undefined ? { stderr: entry.stderr } : {}),
      });
      return true;
    }
    case 'agent':
      if (!entry.desc) return false;
      handleAgentEvent(store, sessionId, { desc: entry.desc });
      return true;
    case 'search':
      if (!entry.pattern) return false;
      // Only the search tool this build knows how to key. A newer hook emitting
      // another tool would otherwise be recorded with grep's key semantics by
      // an older Node build, the way unknown `tool` values are skipped rather
      // than guessed.
      if (entry.stool !== undefined && entry.stool !== 'grep') return false;
      handleSearchEvent(store, sessionId, {
        pattern: entry.pattern,
        root: entry.sroot ?? '',
        ...(entry.sglob ? { glob: entry.sglob } : {}),
        ...(entry.stype ? { type: entry.stype } : {}),
        caseInsensitive: readJsonFlag(entry.sci),
        multiline: readJsonFlag(entry.sml),
        certified: searchCertified,
        ...(searchCache ? { cache: searchCache } : {}),
      });
      return true;
    case 'credit': {
      // AD-15: the credit is booked here, on the cold path. Nothing is
      // reconstructed — the evidence travels on the record or the credit does
      // not happen.
      const kind = creditKindOf(entry);
      const size = parseCreditNumber(entry.credit_size);
      const tokens = parseCreditNumber(entry.credit_tokens);
      if (kind === null || !entry.credit_ref || size === null || tokens === null) {
        return false;
      }
      try {
        store.insertLedgerEntry({
          // **Deterministic id, so a replay collides instead of double-booking.**
          // Every other replay handler is id-stable or an upsert
          // (`handleCmdEvent` reuses the event id); `insertLedgerEntry` mints a
          // fresh UUID, so it was strictly additive. Measured 8/8: two
          // processes flushing the same orphaned `.processing` claim booked
          // every credit twice — 60 rows where 30 were expected. Orphan claims
          // are ordinary here, because the `unlinkSync` that removes a claim is
          // best-effort and `end-of-turn` overlaps `inject-header`.
          id: creditRowId(sessionId, entry, kind, size, tokens),
          sessionId,
          type: `substitution:${kind}`,
          direction: 'saved',
          tokens,
          evidence: { kind, ref: entry.credit_ref, size },
        });
      } catch {
        // **A bad credit line is DROPPED, never thrown off the capture path.**
        //
        // `assertCreditIsEvidenced` rightly refuses a credit claiming more
        // tokens than its evidence can account for — but throwing here aborted
        // the whole flush transaction AND skipped the claim-file unlink, so the
        // `.processing` file survived and every later flush re-read it and
        // threw again. Measured: one over-claiming line destroyed the real
        // `read` and `cmd` lines in its own batch and every subsequent turn's
        // capture, permanently and silently — `hook-entry` swallows the error
        // with "next flush picks it up", which is precisely what could not
        // happen. `handleReadEvent` already guards its accounting with
        // "Accounting must never break capture (AD-12)"; this is the same
        // accounting and had no guard.
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Which session an entry belongs to. Entries with no `agent_id` — every line
 * written before agent identity existed, and every primary-session line since —
 * resolve to the batch's session unchanged (N-7).
 */
/**
 * Spool lines come from `jq`, which preserves whatever JSON type the host sent.
 * A numeric `agent_id` would otherwise bind as a double and split one subagent
 * across `"42"` and `"42.0"`; a structured value would throw on bind. Coerce
 * scalars, reject the rest.
 */
function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeAgentType(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface ResolvedAgent {
  id: string;
  /** Whether the session's agent_type came from a real host value. */
  typed: boolean;
}

function resolveEntrySession(
  store: CortexStore,
  sessionId: string,
  entry: SpoolEntry,
  cache: Map<string, ResolvedAgent>,
): string {
  const agentId = normalizeAgentId(entry.agent_id);
  if (!agentId) {
    return sessionId;
  }

  const agentType = normalizeAgentType(entry.agent_type);
  const cached = cache.get(agentId);
  // Re-resolve when this entry is the first to carry a real agent_type, so the
  // placeholder recorded from an earlier untyped entry still gets upgraded.
  if (cached !== undefined && (cached.typed || !agentType)) {
    return cached.id;
  }

  try {
    const resolved = resolveAgentSessionId(store, sessionId, agentId, agentType);
    cache.set(agentId, { id: resolved, typed: agentType !== undefined });
    return resolved;
  } catch {
    // Attribution is best-effort: a failure here must not abort the batch or
    // surface to the user (AD-12). Fall back to the batch's own session, and
    // deliberately do NOT cache the fallback — one bad entry must not
    // misattribute every later entry from the same agent.
    return sessionId;
  }
}

/** Meta key holding the `tool_use_id`s already synthesized, newest last. */
const SYNTH_SEEN_KEY = 'cmd_outcome_synth_seen';
/**
 * Meta key holding what the last transcript scan actually saw (FR-14).
 *
 * Read by `cortex doctor`. This feature exists because a capability can be
 * wired, running and dead with nothing anywhere saying so — `command_failure`
 * and `test_cycle` had never fired across 4,881 recorded commands and no
 * surface reported it. Shipping the fix with the same blind spot would be the
 * same mistake one layer down: a host that renames `transcript_path`, stops
 * emitting `is_error`, or moves the file would produce silence indistinguishable
 * from "nothing failed".
 */
export const SCAN_STATUS_KEY = 'cmd_outcome_scan';
/**
 * How many ids the ring remembers. Measured over all 45 transcripts on this
 * machine: a 2 MiB tail holds 3-94 paired Bash calls and **at most 6 failures**
 * (20 across 28 transcripts), so 500 is roughly a hundred flushes of headroom
 * and rollover is unreachable in the real distribution. If it ever did roll
 * over the cost is one duplicated row, not a wrong one.
 */
const SYNTH_SEEN_MAX = 500;
/**
 * How many failures one flush may synthesize. The tail is bounded but not
 * small: an adversarial or pathological transcript can present thousands, and
 * every synthesized row is an INSERT inside the flush's write transaction —
 * measured at 6.9 s for 5,000, which holds the write lock long enough to starve
 * every other writer, the same hazard this file documents for the search census.
 */
const SYNTH_PER_FLUSH_MAX = 50;

function readSynthSeen(store: CortexStore): string[] {
  const raw = store.getMeta(SYNTH_SEEN_KEY);
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Record commands the hook never saw at all (FR-14).
 *
 * A command the host deems FAILED fires no `PostToolUse`, so it has no spool
 * line — which is why `command_failure` episodes had never once fired in
 * production across 4,881 recorded commands. The transcript is the only witness,
 * so a failure with no matching spool line is recorded from it directly.
 *
 * **Written exactly once ever, by `tool_use_id`.** An earlier design bounded
 * this to a timestamp window instead, and all three review layers reproduced it
 * writing one failure as two rows or more. Two independent triggers: `flushSpool`
 * processes an orphaned `.processing` claim *and* the fresh spool, so synthesis
 * ran twice over one outcome set; and the window's lower bound is a whole-second
 * comparison, so any later batch stamped in the same second re-admitted a
 * failure already recorded. The window was also *wrong in the other direction* —
 * the transcript stamps when the assistant emitted a call while the hook stamps
 * after the tool finished, so the lower bound systematically excluded the first
 * failure of a turn, which is the feature's headline case.
 *
 * Remembering the host's own id removes all three at once, and it is the same
 * shape `creditRowId` uses two hundred lines above for the same reason: an
 * additive insert on a path that can legitimately run twice needs an identity,
 * not a guard against running twice. This also lets synthesis key off the raw
 * per-call outcomes rather than the text-collapsed map, so three genuine
 * failures of one command are three records instead of one.
 *
 * Successes are NOT synthesized: a successful command already has a spool line,
 * and inventing rows for commands outside this session's capture would describe
 * work Cortex never observed.
 */
function recordUnseenFailures(
  store: CortexStore,
  sessionId: string,
  failures: readonly TranscriptOutcome[],
  spooled: ReadonlySet<string>,
): number {
  if (failures.length === 0) return 0;
  const seen = readSynthSeen(store);
  const seenIds = new Set(seen);
  // `spooled` covers EVERY claim file this flush touched, not just one batch:
  // synthesizing from the orphan claim while the fresh claim holds the matching
  // spool line would write the same command twice by a different route.
  const fresh = failures.filter(o => !seenIds.has(o.toolUseId) && !spooled.has(o.command));
  if (fresh.length === 0) return 0;
  // Newest first when capped — `failedOutcomes` preserves transcript order, and
  // the recent failures are the ones a resumed session needs.
  const batch = fresh.slice(-SYNTH_PER_FLUSH_MAX);

  let written = 0;
  for (const outcome of batch) {
    const exit = outcomeExitCode(outcome);
    if (exit === null) continue;
    handleCmdEvent(store, sessionId, { cmd: outcome.command, exit: String(exit) });
    written++;
  }
  store.setMeta(
    SYNTH_SEEN_KEY,
    JSON.stringify([...seen, ...batch.map(o => o.toolUseId)].slice(-SYNTH_SEEN_MAX)),
  );
  return written;
}

function processClaimFile(
  store: CortexStore,
  sessionId: string,
  claimPath: string,
  dir: string,
  conservativeEligibility: boolean,
  deps: DigestDeps | undefined,
  outcomes: CommandOutcomeMap | undefined,
  /**
   * Every command text this flush has seen a spool line for, across ALL claim
   * files. Populated even when the batch is skipped as already-processed: those
   * commands are in the store from an earlier flush, and synthesis must not
   * record them a second time by the other route.
   */
  spooled: Set<string>,
): SpoolFlushResult {
  let raw: string;
  try {
    raw = fs.readFileSync(claimPath, 'utf8');
  } catch {
    return { processed: 0, skipped: 0, synthesized: 0 };
  }

  const contentHash = crypto.createHash('sha1').update(raw).digest('hex');
  const markerKey = `${PROCESSED_MARKER_PREFIX}${contentHash}`;
  const entries = parseSpoolLines(raw);
  for (const entry of entries) {
    if (entry.tool === 'cmd' && entry.cmd) spooled.add(entry.cmd);
  }
  // Peeked per claim, not once per flush: the fresh claim IS the former live
  // spool, so what is live changes between the orphan batch and the fresh one.
  const live = peekLiveSpool(dir);
  const eligibility = computeReadEligibility(entries, live, conservativeEligibility);
  const searchEligibility = computeSearchEligibility(entries, live, conservativeEligibility);
  let processed = 0;
  let skipped = 0;

  if (entries.length > 0 && store.getMeta(markerKey) === undefined) {
    // One transaction per claim; the marker commits with the replay so a crash
    // between commit and unlink cannot double-apply the batch. Child sessions
    // are created inside it too, so an interrupted batch cannot leave behind a
    // subagent session with no events.
    store.runInTransaction(() => {
      // A 256 KiB batch can hold hundreds of entries from one subagent; resolve
      // each distinct agent once rather than per entry.
      const sessionByAgent = new Map<string, ResolvedAgent>();
      // Likewise for digests: every read in one batch describes the same
      // on-disk state, so a path is hashed once per flush. Created here and
      // discarded with the batch — a module-level cache would let a long-lived
      // MCP process serve a stale hash indefinitely.
      const digestCache = createDigestCache(undefined, deps);
      // Searches get the same treatment, and here it is not just an
      // optimisation: without it, N searches over one root ran N full census
      // walks and N `git rev-parse` SPAWNS inside this write transaction, so a
      // stalled git (network drive, antivirus) held the write lock for N×5 s and
      // starved every other writer. Same lifetime as the digest cache, same
      // reason.
      const searchCache = createSearchCaptureCache();

      for (const [index, entry] of entries.entries()) {
        if (!isReplayable(entry)) {
          skipped++;
          continue;
        }
        const target = resolveEntrySession(store, sessionId, entry, sessionByAgent);
        if (
          replayEntry(
            store,
            target,
            entry,
            digestCache,
            eligibility[index] === true,
            searchEligibility[index] === true,
            searchCache,
            outcomes,
          )
        ) {
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

  return { processed, skipped, synthesized: 0 };
}

/**
 * Claim and replay the spool. Crash-safe: an orphaned `.processing` claim from
 * an earlier run is consumed first; the live spool is claimed via atomic
 * rename so concurrent appends land in a fresh spool file.
 */
export interface SpoolFlushOptions {
  /**
   * Treat every read in the batch as refund-ineligible regardless of what the
   * batch shows. Set by `inject-header`'s leftover flush: those lines are from
   * an earlier session, the digest is being computed a session boundary later,
   * and anything at all may have happened in between — including the very
   * SessionStart activity performing the flush.
   */
  conservativeEligibility?: boolean;
  /** Test seam only; see `computeFileDigest`. Production omits it. */
  deps?: DigestDeps;
  /**
   * Host transcript for this session (FR-14, Story 4.4).
   *
   * The ONLY place a command's pass/fail is observable. Measured 2026-08-03 by
   * dumping raw hook stdin: the Bash `PostToolUse` payload carries no exit code
   * in any form, and a command the host deems FAILED fires no `PostToolUse` at
   * all. Absent means outcomes are simply not attached — never guessed.
   */
  transcriptPath?: string | null;
  /** Test seam for the transcript scan. Production omits it. */
  scanTranscript?: typeof scanTranscriptTail;
}

export function flushSpool(
  store: CortexStore,
  dir: string,
  sessionId: string,
  /**
   * Historical positional seam kept so the four pre-existing callers and tests
   * compile unchanged; new options travel in the fourth parameter.
   */
  deps?: DigestDeps,
  options: SpoolFlushOptions = {},
): SpoolFlushResult {
  const spoolPath = deriveSpoolPath(dir);
  const claimPath = `${spoolPath}.processing`;
  const conservative = options.conservativeEligibility === true;
  const effectiveDeps = options.deps ?? deps;
  // Scanned ONCE per flush, before any claim: the file is the same for both the
  // orphan and the fresh batch, and it is the only place a command's pass/fail
  // is observable at all. Never throws — an unavailable transcript yields an
  // empty map, which attaches nothing.
  let outcomes: CommandOutcomeMap = new Map();
  let failures: readonly TranscriptOutcome[] = [];
  let scanStatus = 'unavailable:not-attempted';
  try {
    const scan = (options.scanTranscript ?? scanTranscriptTail)(options.transcriptPath ?? null);
    outcomes = outcomesByCommand(scan);
    failures = failedOutcomes(scan);
    scanStatus = describeScan(scan);
  } catch {
    // AD-12: the capture path degrades to silence, never to a broken turn.
    scanStatus = 'unavailable:threw';
  }
  let processed = 0;
  let skipped = 0;
  let synthesized = 0;
  // Shared across both claim files on purpose — see `recordUnseenFailures`.
  const spooled = new Set<string>();

  if (fs.existsSync(claimPath)) {
    const orphan = processClaimFile(
      store,
      sessionId,
      claimPath,
      dir,
      conservative,
      effectiveDeps,
      outcomes,
      spooled,
    );
    processed += orphan.processed;
    skipped += orphan.skipped;
  }

  if (fs.existsSync(spoolPath)) {
    let claimed = true;
    try {
      fs.renameSync(spoolPath, claimPath);
    } catch {
      // A concurrent flush claimed it; nothing left to replay.
      claimed = false;
    }
    if (claimed) {
      const fresh = processClaimFile(
        store,
        sessionId,
        claimPath,
        dir,
        conservative,
        effectiveDeps,
        outcomes,
        spooled,
      );
      processed += fresh.processed;
      skipped += fresh.skipped;
    }
  }

  // Synthesis runs ONCE per flush, after every claim, in its own transaction.
  //
  // Both properties are load-bearing and both were review findings. Running it
  // per claim file made one failure two rows whenever an orphan claim was
  // present (an ordinary occurrence here). Running it inside the replay
  // transaction meant a throw rolled back that batch's real capture AND skipped
  // the claim-file unlink, so every later flush re-read the same file and threw
  // again — the exact permanent-silent-outage shape the `credit` handler was
  // given a guard for.
  try {
    store.runInTransaction(() => {
      synthesized = recordUnseenFailures(store, sessionId, failures, spooled);
    });
  } catch {
    // A failed synthesis loses failures, which is the safe direction. It must
    // never cost the batch that already committed.
  }
  try {
    store.setMeta(SCAN_STATUS_KEY, `${new Date().toISOString()} ${scanStatus} synthesized=${synthesized}`);
  } catch {
    // Observability must not be able to break the thing it observes.
  }

  // Rebuild the flat index AFTER the replay transactions have committed, so it
  // can never describe rows a rollback discarded. Also rebuilt when the file is
  // simply missing, which is what makes it regenerable rather than accumulated
  // (AD-3): the index is a projection of the table, not a log of batches.
  if (processed > 0 || !digestIndexExists(dir)) {
    writeDigestIndex(store, dir);
  }

  return { processed, skipped, synthesized };
}
