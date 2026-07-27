import type { CortexStore } from '../db/store.js';
import {
  describeValidity,
  formatAgeLabel,
  groupContestedAdjacent,
  humanizeMemoryKind,
  renderMemoryLine,
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
 * Assemble lead + evidence lines under a token budget, dropping evidence from
 * the bottom and appending a trimmed marker. Always keeps at least one
 * evidence line so the budget can never silence the top result.
 */
export function assembleBudgeted(
  lead: string | null,
  evidence: string[],
  budget: number,
  trimmedHint: (dropped: number) => string,
): string {
  const lines: string[] = lead ? [lead] : [];
  let used = lead ? estimateTokens(lead) : 0;
  let included = 0;

  for (const line of evidence) {
    const cost = estimateTokens(line);
    if (included > 0 && used + cost > budget) {
      break;
    }
    lines.push(line);
    used += cost;
    included++;
  }

  if (included < evidence.length) {
    // The trimmed marker must fit inside the budget too.
    const hintCost = estimateTokens(trimmedHint(evidence.length - included));
    while (included > 1 && used + hintCost > budget) {
      const removed = lines.pop()!;
      used -= estimateTokens(removed);
      included--;
    }
    lines.push(trimmedHint(evidence.length - included));
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
  const evidence = ordered.map(
    item =>
      `${renderMemoryLine(item, 3)}${detail === 'scores' ? renderScoreDetail(item) : ''}`,
  );

  const rendered = assembleBudgeted(
    buildLeadLine(retrieval.results[0]!),
    evidence,
    budget,
    dropped => `…${dropped} more match${dropped === 1 ? '' : 'es'} trimmed (raise budget or refine topic)`,
  );

  logRetrieval(store, retrieval, rendered);
  return rendered;
}
