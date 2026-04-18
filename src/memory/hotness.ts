import type { CortexStore, ParsedMemoryItem } from '../db/store.js';
import type { MemoryItemState } from './items.js';

const WORKING_SET_KIND_BONUS: Record<string, number> = {
  'note:decision': 3.4,
  'note:intent': 3.1,
  'note:blocker': 2.8,
  'note:focus': 2.8,
  'note:insight': 2.1,
  'episode:command_failure': 2.6,
  'episode:test_cycle': 2.3,
  'episode:session_summary': 1.6,
  session_state: 1.6,
  branch_snapshot: 1.4,
  project_snapshot: 1.0,
  command_run: 0.6,
};

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

  return penalty;
}

function kindBonus(kind: string): number {
  return WORKING_SET_KIND_BONUS[kind] ?? 0.5;
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

  const score = computeMemoryHotness(item, now);
  if (score >= 7) {
    return 'hot';
  }
  if (score >= 4.2) {
    return 'warm';
  }
  return 'cold';
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
