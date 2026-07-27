import type { CortexStore } from '../db/store.js';
import {
  describeValidity,
  formatAgeLabel,
  groupContestedAdjacent,
  humanizeMemoryKind,
  renderMemoryLine,
  renderedAlternatives,
} from './render.js';
import {
  estimateTokens,
  logRetrieval,
  retrieveMemory,
  type RetrievedMemoryItem,
} from './retrieval.js';

export interface RecallOptions {
  /** Estimated-token cap for the rendered output; evidence drops from the bottom. */
  budget?: number;
  /** 'scores' appends a compact per-line rank breakdown for quality debugging. */
  detail?: 'none' | 'scores';
  limit?: number;
}

export const DEFAULT_RECALL_BUDGET = 600;

export function renderScoreDetail(item: RetrievedMemoryItem): string {
  const parts = [
    `score ${item.retrieval_score.toFixed(1)}`,
    `lex ${item.lexical_score.toFixed(1)}`,
    `kind ${item.kind_bonus.toFixed(1)}`,
    `truth ${item.current_truth_bonus.toFixed(1)}`,
    `hot ${item.hotness_bonus.toFixed(1)}`,
  ];
  return ` (${parts.join(', ')})`;
}

export function buildLeadLine(top: RetrievedMemoryItem): string {
  const kind = humanizeMemoryKind(top.kind);
  const subject = top.subject ? ` [${top.subject}]` : '';
  const age = formatAgeLabel(top.created_at);
  const agePart = age ? `${age}, ` : '';
  return `Most relevant — ${kind}${subject} (${agePart}${describeValidity(top)})`;
}

/**
 * One rendered result under the budget: the line that must survive if the entry
 * survives at all, plus an optional lower-priority continuation.
 */
export interface BudgetedEvidence {
  line: string;
  /** Supporting detail, dropped before any `line` is dropped (FR-3). */
  continuation?: string;
}

/**
 * Assemble lead + evidence lines under a token budget, dropping evidence from
 * the bottom and appending a trimmed marker. Always keeps at least one
 * evidence line so the budget can never silence the top result.
 *
 * Two passes, and the split is the mechanism behind FR-3's "the alternatives
 * line drops before the decision itself drops". Dropping from the bottom alone
 * would not deliver it: with `[d1, alt1, d2, alt2]` a cut landing on `d2` drops
 * that decision *and* its continuation together, and `alt1` has already spent
 * budget `d2` needed. Charging continuations only after every affordable `line`
 * is kept makes the guarantee hold at every budget instead of most of them.
 *
 * When no entry carries a continuation, pass two is a no-op and the output is
 * byte-for-byte what pass one alone produced — which is how "decisions without
 * alternatives render exactly as they do today" is satisfied structurally.
 */
export function assembleBudgeted(
  lead: string | null,
  evidence: BudgetedEvidence[],
  budget: number,
  trimmedHint: (dropped: number) => string,
): string {
  // ── Pass 1: primary lines, priced and dropped exactly as before ──
  const kept: string[] = [];
  let used = lead ? estimateTokens(lead) : 0;
  let included = 0;

  for (const entry of evidence) {
    const cost = estimateTokens(entry.line);
    if (included > 0 && used + cost > budget) {
      break;
    }
    kept.push(entry.line);
    used += cost;
    included++;
  }

  let hint: string | null = null;
  if (included < evidence.length) {
    // The trimmed marker must fit inside the budget too.
    const hintCost = estimateTokens(trimmedHint(evidence.length - included));
    while (included > 1 && used + hintCost > budget) {
      const removed = kept.pop()!;
      used -= estimateTokens(removed);
      included--;
    }
    hint = trimmedHint(evidence.length - included);
    // Charged so pass 2 cannot spend budget the hint has already claimed.
    used += estimateTokens(hint);
  }

  // ── Pass 2: continuations, strictly after every affordable line is kept ──
  const continuations = new Map<number, string>();
  for (let index = 0; index < included; index += 1) {
    const continuation = evidence[index]!.continuation;
    if (continuation === undefined) {
      continue;
    }
    const cost = estimateTokens(continuation);
    if (used + cost > budget) {
      // Stop rather than skip: a greedy fill would let a short continuation
      // lower down slip past a long one above it, making which details appear
      // depend on relative lengths. Top-down until the budget runs out reads
      // the same way every other drop in this codebase does.
      break;
    }
    continuations.set(index, continuation);
    used += cost;
  }

  const lines: string[] = lead ? [lead] : [];
  for (let index = 0; index < included; index += 1) {
    lines.push(kept[index]!);
    const continuation = continuations.get(index);
    if (continuation !== undefined) {
      lines.push(continuation);
    }
  }
  if (hint !== null) {
    lines.push(hint);
  }

  return lines.join('\n');
}

export function recall(
  store: CortexStore,
  topic: string,
  options: RecallOptions = {},
): string {
  const retrieval = retrieveMemory(store, topic, options.limit ?? 8);

  if (retrieval.results.length === 0) {
    const empty = `No matches for "${topic}". Try a broader topic, or cortex_state for the working set.`;
    logRetrieval(store, retrieval, empty);
    return empty;
  }

  const detail = options.detail ?? 'none';
  const budget = options.budget ?? DEFAULT_RECALL_BUDGET;
  // Display order only. `retrieval.results` stays in rank order for the log and
  // for the eval harness, which reads ranking metrics straight off retrieval —
  // so reordering here cannot move top1_hit or recall_at_3.
  const ordered = groupContestedAdjacent(retrieval.results);
  const evidence = ordered.map(item => {
    const alternatives = renderedAlternatives(item);
    return {
      line: `${renderMemoryLine(item, 3)}${detail === 'scores' ? renderScoreDetail(item) : ''}`,
      ...(alternatives !== null ? { continuation: alternatives } : {}),
    };
  });

  const rendered = assembleBudgeted(
    buildLeadLine(retrieval.results[0]!),
    evidence,
    budget,
    dropped => `…${dropped} more match${dropped === 1 ? '' : 'es'} trimmed (raise budget or refine topic)`,
  );

  logRetrieval(store, retrieval, rendered);
  return rendered;
}
