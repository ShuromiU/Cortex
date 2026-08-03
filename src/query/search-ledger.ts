import * as path from 'node:path';
import type { CortexStore, ParsedNegativeResult } from '../db/store.js';
import { computeRootCensus, type RootCensus } from '../capture/census.js';
import {
  normalizeSearchRoot,
  searchQueryKey,
  type SearchQuery,
} from '../capture/search-query.js';
import { formatMemoryTimestamp } from './render.js';

/**
 * The search ledger (FR-13, Story 4.3): has this exact search already been
 * proven to return nothing, and is that proof still current?
 *
 * **The census is the evidence; head is metadata.** `no-matches-at` is
 * asserted only when the search root's working tree re-fingerprints to the
 * recorded census (AD-6: evidence in hand, never a proxy — and never mtime).
 * The recorded `head_oid` renders in the verdict per the AC and is never
 * compared: a head that moved over a byte-identical root does not change what
 * the search would return, and comparing it could only manufacture false
 * misses.
 *
 * **Verdict ladder.** No record → `miss`. Root missing, census mismatch, or
 * the walk provably exceeding the recorded census (growth) → `miss` — AC #3's
 * "invalidated" is a verdict, never a row mutation: this query writes nothing
 * (the FR-21 read-only rule), and a `git stash pop` that restores the exact
 * bytes honestly re-validates the record. Anything unprovable in either
 * direction — an unreadable entry, an unresolvable scope root — → `unknown`
 * (AC #4). Scope isolation (AC #5) is the exact-key lookup's `scope_key`
 * equality; there is deliberately NO subsumption reasoning across roots.
 *
 * **The query walks with the RECORD's own census figures as its limits**, not
 * the environment ceilings. Exceeding the recorded file count or byte total
 * mid-walk proves growth (a change → miss) without hashing the rest, keeps
 * the work bounded by what was recorded (the "recorded size gates the work"
 * rule from FR-7/4.5), and makes the answer independent of any later change
 * to `CORTEX_NEGATIVE_MAX_*`.
 *
 * Query identity and the certifiability gates live in
 * `src/capture/search-query.ts` — the capture layer, because the flush shares
 * them and layer direction forbids `capture/` importing `query/`. Re-exported
 * here so consumers of the ledger see one module.
 */

export {
  CERTIFIABLE_GLOB,
  CERTIFIABLE_PATTERN,
  CERTIFIABLE_TYPES,
  canonicalSearchQuery,
  isCertifiableSearch,
  normalizeSearchRoot,
  searchQueryKey,
} from '../capture/search-query.js';
export type { SearchQuery } from '../capture/search-query.js';

/** Mirrors READ_LEDGER_MAX_PATHS: a cap, not a budget — excess is refused. */
export const SEARCH_LEDGER_MAX_QUERIES = 16;

/** AC #2: each rendered line fits 25 tokens, enforced as chars/4 like the read ledger. */
export const SEARCH_LEDGER_TOKENS_PER_QUERY = 25;

export type SearchLedgerVerdict = 'no-matches-at' | 'miss' | 'unknown';

export interface SearchLedgerResult {
  /** The pattern exactly as asked, so a caller can correlate. */
  pattern: string;
  queryKey: string;
  verdict: SearchLedgerVerdict;
  /** Present only on `no-matches-at`. */
  headOid: string | null;
  recordedAt: string | null;
}

export interface SearchLedgerDeps {
  census: typeof computeRootCensus;
}

const DEFAULT_DEPS: SearchLedgerDeps = { census: computeRootCensus };

export function querySearchLedger(
  store: CortexStore,
  scopeKey: string,
  queries: SearchQuery[],
  deps: SearchLedgerDeps = DEFAULT_DEPS,
): SearchLedgerResult[] {
  const bounded = queries.slice(0, SEARCH_LEDGER_MAX_QUERIES);
  const scopeRoot = store.resolveScopeRoot(scopeKey);

  return bounded.map(q => {
    // Same normalization the capture used, or the key never matches: an
    // absolute root relativizes against the scope root; an already-relative
    // one passes through untouched (never re-resolved — the 3.2 rule).
    const relRoot = normalizeSearchRoot(q.root, scopeRoot);
    const key = searchQueryKey({ ...q, root: relRoot });
    const base = { pattern: q.pattern, queryKey: key };

    const record = store.getNegativeResult(scopeKey, key);
    if (!record) {
      return { ...base, verdict: 'miss' as const, headOid: null, recordedAt: null };
    }
    return {
      ...base,
      ...verdictFor(record, scopeRoot, deps),
    };
  });
}

function verdictFor(
  record: ParsedNegativeResult,
  scopeRoot: string | null,
  deps: SearchLedgerDeps,
): Pick<SearchLedgerResult, 'verdict' | 'headOid' | 'recordedAt'> {
  // A record exists but its scope root cannot be resolved on this machine —
  // nothing can be walked, so nothing can be proven either way. Never anchor
  // a stored relative root to process.cwd() (the 3.2 relocation defect).
  if (scopeRoot === null && !path.isAbsolute(record.root)) {
    return { verdict: 'unknown', headOid: null, recordedAt: null };
  }
  const absRoot = path.isAbsolute(record.root)
    ? record.root
    : record.root === ''
      ? (scopeRoot as string)
      : path.join(scopeRoot as string, record.root);

  // Wrapped even though every syscall inside is guarded: a pathological
  // directory depth throws `RangeError` from the recursion itself, which no
  // per-syscall catch sees, and this runs on a public query surface (the MCP
  // dispatch and the CLI action both propagate). Unprovable is `unknown`.
  let census: RootCensus;
  try {
    census = deps.census(absRoot, {
      maxFiles: record.censusFiles,
      maxBytes: record.censusBytes,
    });
  } catch {
    return { verdict: 'unknown', headOid: null, recordedAt: null };
  }

  switch (census.status) {
    case 'missing':
      // The root is gone: that IS a change. AC #3's miss, provably.
      return { verdict: 'miss', headOid: null, recordedAt: null };
    case 'overflow':
      // The walk exceeded the recorded census before finishing: the tree grew.
      return { verdict: 'miss', headOid: null, recordedAt: null };
    case 'unreadable':
      return { verdict: 'unknown', headOid: null, recordedAt: null };
    case 'ok':
      if (
        census.sha256 === record.censusSha256 &&
        census.files === record.censusFiles &&
        census.bytes === record.censusBytes
      ) {
        return { verdict: 'no-matches-at', headOid: record.headOid, recordedAt: record.recordedAt };
      }
      return { verdict: 'miss', headOid: null, recordedAt: null };
  }
}

// ── Rendering ────────────────────────────────────────────────────────

/**
 * Stored-strings discipline for the one author-supplied field on this line.
 * Control characters strip (escaped classes, never literal bytes — a raw CR
 * here overwrites the previous verdict on a terminal), whitespace collapses,
 * and the result is capped so the VERDICT — the answer — is never what gets
 * cut.
 */
function collapsePattern(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fitPattern(pattern: string, room: number): string {
  const collapsed = collapsePattern(pattern);
  if (collapsed.length <= room) return collapsed;
  if (room <= 1) return '…';
  let cut = collapsed.slice(0, room - 1);
  // Never split a surrogate pair (the FR-9 truncation rule).
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function renderSearchLedgerLine(result: SearchLedgerResult): string {
  const budgetChars = SEARCH_LEDGER_TOKENS_PER_QUERY * 4;
  let verdictText: string;
  if (result.verdict === 'no-matches-at') {
    const head = result.headOid ? result.headOid.slice(0, 7) : '-';
    // `formatMemoryTimestamp` answers null for a truthy-but-unparseable stamp,
    // which the template rendered as the literal "(null)".
    const stamp = result.recordedAt ? formatMemoryTimestamp(result.recordedAt) : null;
    const when = stamp ? ` (${stamp})` : '';
    verdictText = `no-matches-at ${head}${when}`;
  } else {
    verdictText = result.verdict;
  }
  const room = budgetChars - verdictText.length - 2; // ': ' separator
  const shown = fitPattern(result.pattern, Math.max(room, 1));
  return `${shown}: ${verdictText}`;
}

/**
 * `requested` names the drops. Silently returning 16 answers to a question
 * about 20 makes four searches indistinguishable from "not asked about" — the
 * wrong-answer direction AD-6 forbids, and the rule the read ledger already
 * follows on both of its surfaces.
 */
export function renderSearchLedger(results: SearchLedgerResult[], requested?: number): string {
  const lines = results.map(renderSearchLedgerLine);
  const asked = requested ?? results.length;
  if (asked > results.length) {
    lines.push(
      `…${asked - results.length} more not checked (cap is ${SEARCH_LEDGER_MAX_QUERIES})`,
    );
  }
  return lines.join('\n');
}
