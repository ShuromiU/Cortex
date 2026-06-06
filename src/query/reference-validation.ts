import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CortexStore,
  MemoryReferenceStatus,
  ParsedMemoryItem,
  ParsedMemoryReference,
} from '../db/store.js';

export interface MemoryReferenceValidation {
  references: ParsedMemoryReference[];
  exists: number;
  missing: number;
  unknown: number;
  external: number;
  stale: boolean;
  missingReferences: string[];
  label: string | null;
}

function isAbsolutePath(normalizedPath: string): boolean {
  return /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/');
}

function resolveWorktreePath(store: CortexStore, item: ParsedMemoryItem): string | null {
  const graph = store.getCurrentAppGraph(item.scope_key);
  if (graph?.worktree_path) {
    return graph.worktree_path;
  }

  if (item.session_id) {
    const session = store.getSession(item.session_id);
    if (session?.worktree_path) {
      return session.worktree_path;
    }
  }

  return store.getMeta('root_path') ?? null;
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveReferenceStatus(
  store: CortexStore,
  item: ParsedMemoryItem,
  ref: ParsedMemoryReference,
): MemoryReferenceStatus {
  const normalizedPath = ref.normalized_path;

  if (isAbsolutePath(normalizedPath)) {
    return pathExists(normalizedPath) ? 'exists' : 'missing';
  }

  const graph = store.getCurrentAppGraph(item.scope_key);
  if (graph) {
    return graph.files.includes(normalizedPath) ? 'exists' : 'missing';
  }

  const worktreePath = resolveWorktreePath(store, item);
  if (!worktreePath || !pathExists(worktreePath)) {
    return 'unknown';
  }

  return pathExists(path.join(worktreePath, normalizedPath)) ? 'exists' : 'missing';
}

function labelForMissing(missingReferences: string[]): string | null {
  if (missingReferences.length === 0) {
    return null;
  }

  const shown = missingReferences.slice(0, 3).join(', ');
  const extra = missingReferences.length > 3 ? `, +${missingReferences.length - 3} more` : '';
  return `Stale references: missing ${shown}${extra}`;
}

export function validateMemoryReferences(
  store: CortexStore,
  item: ParsedMemoryItem,
): MemoryReferenceValidation {
  const refs = store.getMemoryReferences(item.id);
  if (refs.length === 0) {
    return {
      references: [],
      exists: 0,
      missing: 0,
      unknown: 0,
      external: 0,
      stale: false,
      missingReferences: [],
      label: null,
    };
  }

  const checkedAt = new Date().toISOString();
  const updates = refs.map(ref => ({
    id: ref.id,
    status: resolveReferenceStatus(store, item, ref),
    checkedAt,
  }));
  store.updateMemoryReferenceStatuses(updates);

  const references = store.getMemoryReferences(item.id);
  const missingReferences = references
    .filter(ref => ref.status === 'missing')
    .map(ref => ref.normalized_path);

  return {
    references,
    exists: references.filter(ref => ref.status === 'exists').length,
    missing: missingReferences.length,
    unknown: references.filter(ref => ref.status === 'unknown').length,
    external: references.filter(ref => ref.status === 'external').length,
    stale: missingReferences.length > 0,
    missingReferences,
    label: labelForMissing(missingReferences),
  };
}

export function referenceValidationScore(
  validation: MemoryReferenceValidation,
  historicalIntent: boolean,
): number {
  if (validation.references.length === 0 || validation.missing === 0) {
    return validation.exists > 0 ? 1.5 : 0;
  }

  if (historicalIntent) {
    return -1.5 * validation.missing;
  }

  return -18 - validation.missing * 4;
}
