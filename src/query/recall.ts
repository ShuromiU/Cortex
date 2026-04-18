import type { CortexStore } from '../db/store.js';
import { renderMemoryLine } from './render.js';
import { logRetrieval, retrieveMemory } from './retrieval.js';

export function recall(store: CortexStore, topic: string): string {
  const retrieval = retrieveMemory(store, topic, 8);

  if (retrieval.results.length === 0) {
    const empty = `No matches for "${topic}".`;
    logRetrieval(store, retrieval, empty);
    return empty;
  }

  const rendered = retrieval.results.map(item => renderMemoryLine(item, 3)).join('\n');
  logRetrieval(store, retrieval, rendered);
  return rendered;
}
