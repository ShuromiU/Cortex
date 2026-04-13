import type { CortexStore } from '../db/store.js';
import { renderMemoryLine } from './render.js';
import { logRetrieval, retrieveMemory } from './retrieval.js';

const KIND_PRIORITY: Record<string, number> = {
  'note:decision': 0,
  'note:intent': 1,
  'note:blocker': 2,
  'note:insight': 3,
};

function compareBriefOrder(leftKind: string, rightKind: string): number {
  return (KIND_PRIORITY[leftKind] ?? 99) - (KIND_PRIORITY[rightKind] ?? 99);
}

export function brief(store: CortexStore, topic: string, forAgent?: string): string {
  const retrieval = retrieveMemory(store, topic, 5);
  const lines: string[] = [];

  if (forAgent) {
    lines.push(`Briefing for ${forAgent}:`);
  }

  if (retrieval.context.preferredScope && retrieval.context.preferredScope.scopeType !== 'project') {
    lines.push(`Scope: ${retrieval.context.preferredScope.scopeLabel}`);
  }

  if (retrieval.context.focus) {
    lines.push(`Focus: ${retrieval.context.focus}`);
  }

  if (retrieval.results.length === 0) {
    lines.push(`No context found for "${topic}".`);
    const renderedEmpty = lines.join('\n');
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

  lines.push(...ordered.map(item => renderMemoryLine(item, 2)));

  const rendered = lines.join('\n');
  logRetrieval(store, retrieval, rendered);
  return rendered;
}
