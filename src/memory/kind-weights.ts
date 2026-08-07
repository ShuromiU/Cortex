/**
 * Single source of truth for memory-kind weighting.
 *
 * The two columns answer different questions and are intentionally not equal:
 * - `retrieval`: query-time rerank bonus — how much a kind matters when the
 *   agent asks about a topic (fresh failures rank high because they are what
 *   you search for).
 * - `workingSet`: ambient working-set selection — how much a kind deserves a
 *   default-state slot (raw command noise stays low even when recent).
 *
 * Divergence between the columns is a per-kind decision made here, in one
 * place; eval/suites/kind-ordering.json locks the resulting orderings.
 */
export interface KindWeight {
  retrieval: number;
  workingSet: number;
}

export const KIND_WEIGHTS: Record<string, KindWeight> = {
  'note:decision': { retrieval: 3.4, workingSet: 3.4 },
  'note:intent': { retrieval: 3.0, workingSet: 3.1 },
  'note:focus': { retrieval: 2.8, workingSet: 2.8 },
  'note:blocker': { retrieval: 2.6, workingSet: 2.8 },
  'note:insight': { retrieval: 2.0, workingSet: 2.1 },
  'episode:command_failure': { retrieval: 3.2, workingSet: 2.6 },
  'episode:test_cycle': { retrieval: 2.8, workingSet: 2.3 },
  'episode:session_summary': { retrieval: 1.6, workingSet: 1.6 },
  // A subagent's conclusion (FR-19, Story 5.3). Weighted between a test cycle
  // and a session summary: it is a deliberate finding rather than an automatic
  // digest, so it outranks a summary — but it is one agent's read of a task,
  // not an authored decision, so it must not outrank a captured failure.
  'episode:subagent_conclusion': { retrieval: 2.4, workingSet: 2.0 },
  // session_state never had a retrieval entry; 1.0 preserves the old fallback.
  session_state: { retrieval: 1.0, workingSet: 1.6 },
  branch_snapshot: { retrieval: 2.4, workingSet: 1.4 },
  project_snapshot: { retrieval: 1.8, workingSet: 1.0 },
  command_run: { retrieval: 1.2, workingSet: 0.6 },
};

export const DEFAULT_KIND_WEIGHT: KindWeight = { retrieval: 1.0, workingSet: 0.5 };

export function retrievalKindBonus(kind: string): number {
  return (KIND_WEIGHTS[kind] ?? DEFAULT_KIND_WEIGHT).retrieval;
}

export function workingSetKindBonus(kind: string): number {
  return (KIND_WEIGHTS[kind] ?? DEFAULT_KIND_WEIGHT).workingSet;
}
