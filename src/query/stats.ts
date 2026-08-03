import type { CortexStore, LedgerDirectionTotals, ParsedMemoryItem, SessionRow } from '../db/store.js';
import { LEDGER_DIRECTIONS, foldLedgerDirectionTotals } from '../db/store.js';
import { isSupersededMemoryItem } from '../memory/items.js';
import { formatMemoryTimestamp, humanizeMemoryKind, isContested } from './render.js';
import { formatTokens, resolveWorkingScopeKeys } from './state.js';

/**
 * FR-9: the P&L report behind `cortex stats` (Story 3.6).
 *
 * Built here rather than inline in the CLI so the report is testable and the
 * B-6 budget is measurable in-process — the 3.3 precedent: the CLI end-to-end
 * cost on this platform is dominated by Node boot and store open (~500 ms
 * floor), so "within 200 ms" is a claim about this path, and the CLI cost is
 * recorded separately, never folded into it.
 *
 * Everything here READS. No session is created, no item is touched, no ledger
 * row is booked: a surface for revealing what ranking holds must not change
 * that ranking by being used (FR-21's rule), and a terminal render injects
 * nothing into any context (the documented 3.5 state for CLI commands).
 * `renderMemoryLine` is deliberately not reused for the top-10 list — it
 * wants reference validation, which persists corrected statuses (a write) and
 * costs filesystem time this surface's budget does not owe.
 */

/** AC #2 names ten; a knob would be scope creep. */
export const MOST_RETRIEVED_LIMIT = 10;

/** Fixed width for the text segment of a top-10 line; the count, kind and labels are never what gets cut. */
export const STATS_ITEM_TEXT_MAX = 100;

/** Canonical state order for the counts line; unknown states append after. */
const STATE_ORDER = ['pinned', 'hot', 'warm', 'cold', 'archived'] as const;

const LABEL_WIDTH = 15;

export interface StatsTokenBlock extends LedgerDirectionTotals {
  /** saved − injected. Unrealized and estimated are excluded (AC #3 / AD-8). */
  net: number;
  /**
   * saved / injected, floored to hundredths — never rounded, because
   * `toFixed` would report 996/1000 as parity ("under-reporting is
   * acceptable, over-reporting is fatal", FR-9 PM note). `null` when nothing
   * was injected: no denominator is "no measurement", not zero and not
   * infinity.
   */
  ratio: number | null;
}

export interface StatsMostRetrievedEntry {
  id: string;
  kind: string;
  accessCount: number;
  /** Rendered per the stored-strings-are-content discipline (D6). */
  line: string;
}

export interface StatsReport {
  session: {
    /** Most recent primary across the working scope keys; null when none exists. */
    id: string | null;
    startedAt: string | null;
    /** True only when a child session actually contributed ledger tokens. */
    includesSubagents: boolean;
    /** Totals over the primary's whole tree; null when no session exists. */
    totals: StatsTokenBlock | null;
  };
  scope: {
    scopeKeys: string[];
    totals: StatsTokenBlock;
    /**
     * Ledger rows no scope view can reach — NULL-scope sessions (the column
     * was added by migration with no backfill) and rows whose session is
     * gone. Rendered as one line when non-zero so the `estimated` history
     * FR-8 kept cannot silently vanish on a legacy store; never counted into
     * any total above.
     */
    unattributed: LedgerDirectionTotals;
  };
  items: {
    total: number;
    byState: Record<string, number>;
    neverRetrieved: number;
    mostRetrieved: StatsMostRetrievedEntry[];
  };
}

function withDerived(totals: LedgerDirectionTotals): StatsTokenBlock {
  return {
    ...totals,
    net: totals.saved - totals.injected,
    // Integer math before the floor: `saved * 100` is exact for every
    // magnitude the ledger can hold (`insertLedgerEntry` validates tokens as
    // safe integers, and the product stays exact below 2^53 — a bound the
    // stored sums sit far under), so the floor semantics cannot be disturbed
    // by binary representation of the quotient.
    ratio: totals.injected > 0 ? Math.floor((totals.saved * 100) / totals.injected) / 100 : null,
  };
}

/**
 * The most recent primary across the working scope keys. Most-recent rather
 * than active-only: `inject-header` ends the session tree on every
 * SessionStart, so an active-only lookup would leave the block empty almost
 * always — the same wall FR-7 hit. A tie on `started_at` keeps the first key,
 * which is the preferred scope.
 */
function resolveCurrentPrimary(store: CortexStore, scopeKeys: string[]): SessionRow | null {
  let best: SessionRow | null = null;
  for (const key of scopeKeys) {
    const candidate = store.getRecentSessionsByScope(key, 1)[0];
    if (candidate && (!best || candidate.started_at > best.started_at)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Stored strings are content, not output: control characters are stripped
 * (escaped classes — never literal bytes; a raw NUL authored in a source
 * regex is how two files in this repo became invisible to grep) and all
 * whitespace including newlines collapses to single spaces, so one item
 * cannot forge another report row.
 */
function collapse(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let kept = value.slice(0, maxChars - 1);
  // `slice` counts UTF-16 code units, so the cut can land inside a surrogate
  // pair — a lone high surrogate renders as mojibake, and `collapse()` does
  // not strip surrogates (they are not control characters). Drop the orphan.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    kept = kept.slice(0, -1);
  }
  return `${kept.trimEnd()}…`;
}

/**
 * One top-10 line: `3× Decision [2026-07-30 11:02Z]: text… [contested]`.
 * Labels come from the canonical sniffs — `isContested` (line-exact,
 * note-only) and `isSupersededMemoryItem` (trailer-scoped) — never a new
 * substring match, and they re-attach AFTER truncation: appended before, any
 * item past the width silently sheds its marker (the `renderHeaderHighlights`
 * lesson), which on a contest means presenting one side as settled.
 */
function renderItemLine(item: ParsedMemoryItem): string {
  const timestamp = formatMemoryTimestamp(item.created_at);
  // Text that is entirely control characters collapses to nothing; a dangling
  // `: ` with an empty slot reads as a rendering bug and gives labels nothing
  // to attach to.
  const text = truncate(collapse(item.text), STATS_ITEM_TEXT_MAX) || '(no text)';
  const labels = `${isSupersededMemoryItem(item) ? ' (superseded)' : ''}${
    isContested(item) ? ' [contested]' : ''
  }`;
  const stamp = timestamp ? ` [${timestamp}]` : '';
  // The id is the operator handle — this list is deliberately store-wide, so
  // without it a suspicious entry cannot be fed to `cortex inspect-memory`
  // (the FR-21 surfaces expose ids for exactly this reason). Appended after
  // the labels so neither the answer nor the markers are ever what gets cut.
  return `${item.access_count}× ${humanizeMemoryKind(item.kind)}${stamp}: ${text}${labels} — ${item.id}`;
}

export function buildStatsReport(store: CortexStore): StatsReport {
  const scopeKeys = resolveWorkingScopeKeys(store);
  const primary = resolveCurrentPrimary(store, scopeKeys);

  let session: StatsReport['session'];
  if (!primary) {
    session = { id: null, startedAt: null, includesSubagents: false, totals: null };
  } else {
    const treeIds = store.getSessionTreeIds(primary.id);
    const rows = store.getSessionLedgerTotals(treeIds);
    session = {
      id: primary.id,
      startedAt: primary.started_at,
      // Only directions the fold counts may claim the label: a row in a
      // direction the totals drop (reachable only via a raw INSERT) must not
      // make the header assert a contribution no printed number contains.
      includesSubagents: rows.some(
        row =>
          row.session_id !== primary.id && row.tokens > 0 && LEDGER_DIRECTIONS.has(row.direction),
      ),
      totals: withDerived(foldLedgerDirectionTotals(rows)),
    };
  }

  const byState = store.getMemoryItemStateCounts();
  const total = Object.values(byState).reduce((sum, count) => sum + count, 0);

  return {
    session,
    scope: {
      scopeKeys,
      totals: withDerived(store.getScopeTokenTotals(scopeKeys)),
      unattributed: store.getUnattributedTokenTotals(),
    },
    items: {
      total,
      byState,
      neverRetrieved: store.countNeverRetrievedMemoryItems(),
      mostRetrieved: store.getMostRetrievedMemoryItems(MOST_RETRIEVED_LIMIT).map(item => ({
        id: item.id,
        kind: item.kind,
        accessCount: item.access_count,
        line: renderItemLine(item),
      })),
    },
  };
}

function pad(label: string): string {
  return label.padEnd(LABEL_WIDTH);
}

function renderTokenBlock(totals: StatsTokenBlock): string[] {
  const lines = [
    `${pad('  Injected:')}${formatTokens(totals.injected)}`,
    `${pad('  Saved:')}${formatTokens(totals.saved)}`,
    `${pad('  Net:')}${formatTokens(totals.net)}`,
    `${pad('  Ratio:')}${totals.ratio === null ? '—' : `${totals.ratio.toFixed(2)}×`}`,
  ];
  if (totals.unrealized > 0) {
    // AC #3: separate from savings, so the capability-versus-adoption gap is
    // visible rather than folded into a number that looks like success either
    // way.
    lines.push(`${pad('  Unrealized:')}${formatTokens(totals.unrealized)} (offered, not taken)`);
  }
  if (totals.estimated > 0) {
    lines.push(
      `${pad('  Estimated:')}${formatTokens(totals.estimated)} (retired consolidation estimate, not counted)`,
    );
  }
  return lines;
}

export function renderStatsReport(report: StatsReport): string {
  const lines: string[] = [];

  if (!report.session.totals) {
    lines.push(`${pad('Session:')}no session in this scope yet`);
  } else {
    const started = report.session.startedAt
      ? formatMemoryTimestamp(report.session.startedAt)
      : null;
    const suffix = report.session.includesSubagents ? ' (incl. subagents)' : '';
    lines.push(`${pad('Session:')}${started ? `started ${started}` : 'most recent'}${suffix}`);
    lines.push(...renderTokenBlock(report.session.totals));
  }

  const keyCount = report.scope.scopeKeys.length;
  lines.push(`${pad('Scope:')}cumulative over ${keyCount} scope key${keyCount === 1 ? '' : 's'}`);
  lines.push(...renderTokenBlock(report.scope.totals));

  // Legacy rows outside every scope view (NULL-scope or missing sessions).
  // One line, only when real: the FR-8 "kept for history" promise must not
  // silently vanish on a store that predates scope records — and these tokens
  // are counted into no total above, so saying so is part of the line.
  const stray = report.scope.unattributed;
  const strayParts = (
    [
      ['injected', stray.injected],
      ['saved', stray.saved],
      ['unrealized', stray.unrealized],
      ['estimated', stray.estimated],
    ] as const
  )
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens]) => `${formatTokens(tokens)} ${name}`);
  if (strayParts.length > 0) {
    lines.push(
      `${pad('  Unattributed:')}${strayParts.join(', ')} (sessions predating scope records; counted nowhere above)`,
    );
  }

  // **`Saved: 0` is the honest state, and saying so is part of the fix**
  // (Story 3.5). Until then this surface read `Saved: 657.6k / Efficiency:
  // 93%` off a single counterfactual. The credit is withdrawn, and the
  // mechanism that produces evidence-backed credit (verified read
  // substitution, Story 4.5) has not shipped — so the reason names the
  // missing MECHANISM, not just missing evidence. Keyed on the scope block:
  // that is the cumulative judgment surface, and a store with no spend would
  // otherwise show a bare zero that reads as a measured verdict rather than
  // an absence of measurement.
  //
  // BINDS STORY 4.5: this wording asserts a global fact ("is not shipped")
  // from scope-local data. The day substitution books savings in ANY scope,
  // a scope with none would print a false statement about the mechanism —
  // the 4.5 story must revise this branch (a sprint action item records the
  // obligation). Until a producer exists anywhere, wording and keying agree.
  if (report.scope.totals.saved === 0) {
    lines.push(`${' '.repeat(LABEL_WIDTH)}no verified savings yet: credit needs recorded evidence, and the`);
    lines.push(
      `${' '.repeat(LABEL_WIDTH)}mechanism that produces it (verified read substitution) is not shipped`,
    );
  }

  const byState = report.items.byState;
  const known = new Set<string>(STATE_ORDER);
  const extras = Object.keys(byState)
    .filter(state => !known.has(state))
    .sort();
  const stateSummary = [...STATE_ORDER, ...extras]
    .map(state => `${state} ${byState[state] ?? 0}`)
    .join(', ');
  lines.push(`${pad('Memory items:')}${report.items.total} (${stateSummary})`);
  lines.push(`  Never retrieved: ${report.items.neverRetrieved}`);
  // The criterion is printed in full, tiebreakers included — the FR-21
  // precedent (`MEMORY_LIST_ORDER`) prints its `rowid` tiebreaker because
  // the tiebreakers are load-bearing for determinism, not decoration.
  const criterion = 'by access count; ties: latest access, then rowid';
  if (report.items.mostRetrieved.length === 0) {
    lines.push(`  Most retrieved (${criterion}): none yet`);
  } else {
    lines.push(`  Most retrieved (${criterion}):`);
    for (const entry of report.items.mostRetrieved) {
      lines.push(`    ${entry.line}`);
    }
  }

  return lines.join('\n');
}
