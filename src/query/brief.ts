import type { CortexStore } from '../db/store.js';
import {
  groupContestedWithinKind,
  renderMemoryLine,
  renderedAlternatives,
} from './render.js';
import { logRetrieval, retrieveMemory } from './retrieval.js';
import {
  assembleBudgeted,
  buildLeadLine,
  renderScoreDetail,
  type RecallOptions,
} from './recall.js';

export const DEFAULT_BRIEF_BUDGET = 450;

const KIND_PRIORITY: Record<string, number> = {
  'note:decision': 0,
  'note:intent': 1,
  'note:blocker': 2,
  'note:insight': 3,
};

function compareBriefOrder(leftKind: string, rightKind: string): number {
  return (KIND_PRIORITY[leftKind] ?? 99) - (KIND_PRIORITY[rightKind] ?? 99);
}

export function brief(
  store: CortexStore,
  topic: string,
  forAgent?: string,
  options: RecallOptions = {},
): string {
  const retrieval = retrieveMemory(store, topic, options.limit ?? 5);
  const header: string[] = [];

  if (forAgent) {
    header.push(`Briefing for ${forAgent}:`);
  }

  if (retrieval.context.preferredScope && retrieval.context.preferredScope.scopeType !== 'project') {
    header.push(`Scope: ${retrieval.context.preferredScope.scopeLabel}`);
  }

  if (retrieval.context.focus) {
    header.push(`Focus: ${retrieval.context.focus}`);
  }

  if (retrieval.results.length === 0) {
    header.push(`No context found for "${topic}".`);
    const renderedEmpty = header.join('\n');
    logRetrieval(store, retrieval, renderedEmpty);
    return renderedEmpty;
  }

  const ordered = [...retrieval.results].sort((left, right) => {
    const kindDelta = compareBriefOrder(left.kind, right.kind);
    if (kindDelta !== 0) {
      return kindDelta;
    }
    return right.retrieval_score - left.retrieval_score;
  });

  const detail = options.detail ?? 'none';
  // Within each kind bucket only — the kind sort above is the primary ordering.
  const grouped = groupContestedWithinKind(ordered);
  const evidence = grouped.map(item => {
    const alternatives = renderedAlternatives(item);
    return {
      line: `${renderMemoryLine(item, 2)}${detail === 'scores' ? renderScoreDetail(item) : ''}`,
      ...(alternatives !== null ? { continuation: alternatives } : {}),
    };
  });

  const lead = [...header, buildLeadLine(ordered[0]!)].join('\n');
  const rendered = assembleBudgeted(
    lead,
    evidence,
    options.budget ?? DEFAULT_BRIEF_BUDGET,
    dropped => `…${dropped} more trimmed (raise budget or refine topic)`,
  );

  logRetrieval(store, retrieval, rendered);
  return rendered;
}
