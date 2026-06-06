import type { CortexStore, ParsedMemoryItem } from '../db/store.js';
import { retrieveMemory, type RetrievedMemoryItem } from './retrieval.js';
import { validateMemoryReferences } from './reference-validation.js';

export interface MemoryValidationReportItem {
  id: string;
  kind: string;
  subject: string | null;
  status: 'current' | 'stale' | 'unknown';
  retrieval_score?: number;
  missing_references: string[];
  references: Array<{
    raw_reference: string;
    normalized_path: string;
    status: string;
  }>;
}

export interface MemoryValidationReport {
  topic: string | null;
  current_app: {
    scope_key: string;
    head_oid: string | null;
    file_count: number;
    updated_at: string;
  } | null;
  memories: MemoryValidationReportItem[];
}

function reportItem(store: CortexStore, item: ParsedMemoryItem | RetrievedMemoryItem): MemoryValidationReportItem {
  const validation = 'reference_validation' in item
    ? item.reference_validation
    : validateMemoryReferences(store, item);
  const status = validation.stale
    ? 'stale'
    : validation.references.length === 0 || validation.unknown > 0
      ? 'unknown'
      : 'current';

  return {
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    status,
    ...('retrieval_score' in item ? { retrieval_score: item.retrieval_score } : {}),
    missing_references: validation.missingReferences,
    references: validation.references.map(ref => ({
      raw_reference: ref.raw_reference,
      normalized_path: ref.normalized_path,
      status: ref.status,
    })),
  };
}

export function validateMemory(
  store: CortexStore,
  topic?: string,
  limit = 8,
): MemoryValidationReport {
  const currentSession = store.getCurrentSession();
  const currentGraph = currentSession?.scope_key
    ? store.getCurrentAppGraph(currentSession.scope_key)
    : undefined;
  const items = topic && topic.trim().length > 0
    ? retrieveMemory(store, topic, limit).results
    : store.listRecentMemoryItems(limit);

  return {
    topic: topic?.trim() || null,
    current_app: currentGraph
      ? {
          scope_key: currentGraph.scope_key,
          head_oid: currentGraph.head_oid,
          file_count: currentGraph.file_count,
          updated_at: currentGraph.updated_at,
        }
      : null,
    memories: items.map(item => reportItem(store, item)),
  };
}
