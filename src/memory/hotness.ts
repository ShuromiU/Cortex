import type { CortexStore, ParsedMemoryItem } from '../db/store.js';
import { demoteMemoryState, isSupersededMemoryItem, type MemoryItemState } from './items.js';
import { workingSetKindBonus } from './kind-weights.js';

const STATE_WEIGHT: Record<MemoryItemState, number> = {
  pinned: 5,
  hot: 4,
  warm: 2,
  cold: 0.5,
  archived: -5,
};

export interface ScoredMemoryItem extends ParsedMemoryItem {
  hotness_score: number;
  working_score: number;
  desired_state: MemoryItemState;
}

function ageDays(timestamp: string | null | undefined, now: Date): number {
  if (!timestamp) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, (now.getTime() - parsed) / (1000 * 60 * 60 * 24));
}

function createdAtBonus(days: number): number {
  if (days <= 1) {
    return 2.6;
  }
  if (days <= 3) {
    return 2.1;
  }
  if (days <= 7) {
    return 1.4;
  }
  if (days <= 30) {
    return 0.5;
  }
  if (days <= 90) {
    return -0.6;
  }
  return -1.6;
}

function accessRecencyBonus(days: number): number {
  if (!Number.isFinite(days)) {
    return 0;
  }

  if (days <= 1) {
    return 3.2;
  }
  if (days <= 7) {
    return 1.8;
  }
  if (days <= 30) {
    return 0.7;
  }
  return -0.2;
}

function accessCountBonus(accessCount: number): number {
  return Math.min(accessCount * 0.85, 4.25);
}

function stalePenalty(item: ParsedMemoryItem, createdDays: number): number {
  let penalty = 0;

  if (item.access_count === 0 && createdDays > 14) {
    penalty -= 1.6;
  }
  if (item.access_count === 0 && createdDays > 45) {
    penalty -= 2.4;
  }
  if (item.kind === 'command_run') {
    penalty -= 0.8;
  }
  if (item.kind === 'note:insight' && item.access_count === 0 && createdDays > 30) {
    penalty -= 1.1;
  }
  if (item.kind === 'project_snapshot' && createdDays > 45) {
    penalty -= 0.7;
  }
  if (item.text.toLowerCase().includes('status: resolved')) {
    penalty -= 1.6;
  }
  // Superseded guidance is retired guidance: same decay push as resolved.
  // Kind-guarded: an episode's captured stderr can carry the line.
  if (isSupersededMemoryItem(item)) {
    penalty -= 1.6;
  }

  return penalty;
}

function kindBonus(kind: string): number {
  return workingSetKindBonus(kind);
}

export function computeMemoryHotness(
  item: ParsedMemoryItem,
  now: Date = new Date(),
): number {
  if (item.state === 'pinned') {
    return 100;
  }
  if (item.state === 'archived') {
    return -100;
  }

  const createdDays = ageDays(item.created_at, now);
  const accessedDays = ageDays(item.last_accessed_at, now);

  return (
    item.importance * 5 +
    kindBonus(item.kind) +
    createdAtBonus(createdDays) +
    accessRecencyBonus(accessedDays) +
    accessCountBonus(item.access_count) +
    stalePenalty(item, createdDays)
  );
}

export function deriveMemoryItemState(
  item: ParsedMemoryItem,
  now: Date = new Date(),
): MemoryItemState {
  if (item.state === 'pinned' || item.state === 'archived') {
    return item.state;
  }

  if (item.text.toLowerCase().includes('status: resolved')) {
    return 'cold';
  }

  const score = computeMemoryHotness(item, now);
  const tier: MemoryItemState = score >= 7 ? 'hot' : score >= 4.2 ? 'warm' : 'cold';

  // FR-4: a superseded item derives one tier below what its score would grant,
  // so refreshes AGREE with the transition-time demotion instead of flipping a
  // hot-scoring predecessor straight back to hot — and reinforcement (touch
  // raises the score) caps at warm rather than resurrecting retired guidance.
  // Floor at cold: history stays retrievable, never re-archived.
  if (isSupersededMemoryItem(item)) {
    return demoteMemoryState(tier);
  }

  return tier;
}

function scopeBonus(item: ParsedMemoryItem, preferredScopeKey: string | null): number {
  if (!preferredScopeKey) {
    return 0;
  }
  if (item.scope_key === preferredScopeKey) {
    return 2.8;
  }
  return 0.8;
}

function workingScore(
  item: ParsedMemoryItem,
  preferredScopeKey: string | null,
  now: Date,
): number {
  return (
    computeMemoryHotness(item, now) +
    STATE_WEIGHT[item.state] +
    scopeBonus(item, preferredScopeKey)
  );
}

export function refreshMemoryHotness(
  store: CortexStore,
  scopeKeys: string[],
  now: Date = new Date(),
): ScoredMemoryItem[] {
  const scoped = store.listMemoryItemsByScopes(scopeKeys, 500, true);
  const updates: Array<{ id: string; state: MemoryItemState }> = [];
  const scored: ScoredMemoryItem[] = [];

  for (const item of scoped) {
    const desired = deriveMemoryItemState(item, now);
    if (desired !== item.state) {
      updates.push({ id: item.id, state: desired });
    }

    scored.push({
      ...item,
      state: desired,
      desired_state: desired,
      hotness_score: computeMemoryHotness(item, now),
      working_score: workingScore({ ...item, state: desired }, scopeKeys[0] ?? null, now),
    });
  }

  if (updates.length > 0) {
    store.updateMemoryItemStates(updates);
  }

  return scored;
}

export function selectWorkingMemoryItems(
  store: CortexStore,
  scopeKeys: string[],
  preferredScopeKey: string | null,
  limit: number,
  now: Date = new Date(),
): ScoredMemoryItem[] {
  const refreshed = refreshMemoryHotness(store, scopeKeys, now).map(item => ({
    ...item,
    working_score: workingScore(item, preferredScopeKey, now),
  }));

  return refreshed
    .filter(item => {
      if (item.state === 'archived') {
        return false;
      }

      if (item.state === 'cold') {
        return item.kind === 'episode:command_failure' || item.kind === 'branch_snapshot';
      }

      if (item.kind === 'command_run' && item.state !== 'hot') {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      if (right.working_score !== left.working_score) {
        return right.working_score - left.working_score;
      }
      if (right.importance !== left.importance) {
        return right.importance - left.importance;
      }
      return right.created_at.localeCompare(left.created_at);
    })
    .slice(0, limit);
}
