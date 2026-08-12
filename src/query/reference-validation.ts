import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CortexStore,
  MemoryReferenceStatus,
  ParsedCurrentAppGraph,
  ParsedMemoryItem,
  ParsedMemoryReference,
} from '../db/store.js';

export interface MovedReference {
  from: string;
  to: string;
}

export interface MemoryReferenceValidation {
  references: ParsedMemoryReference[];
  exists: number;
  missing: number;
  moved: number;
  unknown: number;
  external: number;
  stale: boolean;
  missingReferences: string[];
  movedReferences: MovedReference[];
  label: string | null;
}

function emptyValidation(): MemoryReferenceValidation {
  return {
    references: [],
    exists: 0,
    missing: 0,
    moved: 0,
    unknown: 0,
    external: 0,
    stale: false,
    missingReferences: [],
    movedReferences: [],
    label: null,
  };
}

function isHomeRelativePath(normalizedPath: string): boolean {
  return (
    normalizedPath === '~' ||
    normalizedPath.startsWith('~/') ||
    normalizedPath.startsWith('~\\')
  );
}

/** Home-relative paths are root-anchored, so they take the filesystem branch
 * rather than being looked up in a scope's app graph. */
function isAbsolutePath(normalizedPath: string): boolean {
  return (
    /^[A-Za-z]:\//.test(normalizedPath) ||
    normalizedPath.startsWith('/') ||
    isHomeRelativePath(normalizedPath)
  );
}

/**
 * `~` is a shell convention Node does not resolve — `fs.existsSync('~/x')` is
 * always false — which is the same false-negative `expandHookPath` exists to
 * prevent in `doctor.ts`, where skipping it "reports every configured script
 * as missing". Here it labelled correct memory `[stale: missing …]`, and
 * `~/.claude/CLAUDE.md` is among the most-referenced paths there is.
 *
 * Returns null when no home directory is available, so the caller reports
 * `unknown` rather than asserting a file is gone that it never managed to
 * check. Expansion lives here, at the one place that touches the filesystem,
 * so the stored path keeps the tilde the note was written with.
 */
function expandHomePath(normalizedPath: string, homeDir: string | null): string | null {
  if (!isHomeRelativePath(normalizedPath)) {
    return normalizedPath;
  }
  if (!homeDir) {
    return null;
  }
  return normalizedPath === '~' ? homeDir : path.join(homeDir, normalizedPath.slice(2));
}

function pathExistsRaw(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function buildValidationLabel(
  missingReferences: string[],
  movedReferences: MovedReference[],
): string | null {
  const parts: string[] = [];

  if (missingReferences.length > 0) {
    const shown = missingReferences.slice(0, 3).join(', ');
    const extra =
      missingReferences.length > 3 ? `, +${missingReferences.length - 3} more` : '';
    parts.push(`stale: missing ${shown}${extra}`);
  }

  if (movedReferences.length > 0) {
    const shown = movedReferences
      .slice(0, 2)
      .map(ref => `${ref.from} → ${ref.to}`)
      .join(', ');
    const extra =
      movedReferences.length > 2 ? `, +${movedReferences.length - 2} more` : '';
    parts.push(`moved: ${shown}${extra}`);
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

interface ResolvedStatus {
  status: MemoryReferenceStatus;
  movedTo: string | null;
}

export interface ReferenceValidatorOptions {
  /** Overrides `os.homedir()` when expanding home-relative references. */
  homeDir?: string | null;
}

interface ScopeGraphEntry {
  graph: ParsedCurrentAppGraph | undefined;
  files: Set<string> | null;
  /** basename -> unique relative path, or null when ambiguous. */
  basenames: Map<string, string | null> | null;
}

/**
 * Validates memory references against the current checkout with caching that
 * holds for one retrieval pass: app graphs become Sets, filesystem checks and
 * rename lookups are memoized, and status updates are queued for a single
 * batched flush instead of one write per candidate.
 */
export class ReferenceValidator {
  private readonly graphCache = new Map<string, ScopeGraphEntry>();
  private readonly pathExistsCache = new Map<string, boolean>();
  private readonly renameCache = new Map<string, string | null>();
  private readonly worktreeCache = new Map<string, string | null>();
  private readonly itemCache = new Map<string, MemoryReferenceValidation>();
  private pendingUpdates: Array<{
    id: string;
    status: MemoryReferenceStatus;
    checkedAt: string;
    movedTo: string | null;
  }> = [];
  private readonly checkedAt = new Date().toISOString();
  private readonly homeDir: string | null;

  constructor(
    private readonly store: CortexStore,
    options: ReferenceValidatorOptions = {},
  ) {
    // `??` would conflate "not supplied" with an explicit `null`, which means
    // "there is no home directory" and must not fall back to the real one.
    this.homeDir =
      options.homeDir === undefined ? os.homedir() || null : options.homeDir;
  }

  validate(item: ParsedMemoryItem): MemoryReferenceValidation {
    const cached = this.itemCache.get(item.id);
    if (cached) {
      return cached;
    }

    const refs = this.store.getMemoryReferences(item.id);
    if (refs.length === 0) {
      const empty = emptyValidation();
      this.itemCache.set(item.id, empty);
      return empty;
    }

    const references: ParsedMemoryReference[] = refs.map(ref => {
      const resolved = this.resolveStatus(item, ref);
      if (resolved.status !== ref.status || resolved.movedTo !== ref.moved_to) {
        this.pendingUpdates.push({
          id: ref.id,
          status: resolved.status,
          checkedAt: this.checkedAt,
          movedTo: resolved.movedTo,
        });
      }
      return { ...ref, status: resolved.status, moved_to: resolved.movedTo };
    });

    const missingReferences = references
      .filter(ref => ref.status === 'missing')
      .map(ref => ref.normalized_path);
    const movedReferences = references
      .filter(ref => ref.status === 'moved' && ref.moved_to)
      .map(ref => ({ from: ref.normalized_path, to: ref.moved_to! }));

    const validation: MemoryReferenceValidation = {
      references,
      exists: references.filter(ref => ref.status === 'exists').length,
      missing: missingReferences.length,
      moved: movedReferences.length,
      unknown: references.filter(ref => ref.status === 'unknown').length,
      external: references.filter(ref => ref.status === 'external').length,
      stale: missingReferences.length > 0,
      missingReferences,
      movedReferences,
      label: buildValidationLabel(missingReferences, movedReferences),
    };

    this.itemCache.set(item.id, validation);
    return validation;
  }

  /** Persist queued status changes in one transaction. Safe to call repeatedly. */
  flush(): void {
    if (this.pendingUpdates.length === 0) {
      return;
    }

    const updates = this.pendingUpdates;
    this.pendingUpdates = [];
    try {
      this.store.updateMemoryReferenceStatuses(updates);
    } catch {
      // Status persistence is an optimization; validation results stand.
    }
  }

  private resolveStatus(item: ParsedMemoryItem, ref: ParsedMemoryReference): ResolvedStatus {
    const normalizedPath = ref.normalized_path;

    if (isAbsolutePath(normalizedPath)) {
      const resolved = expandHomePath(normalizedPath, this.homeDir);
      if (resolved === null) {
        // No home directory to expand against: we could not check, so we must
        // not claim the file is gone.
        return { status: 'unknown', movedTo: null };
      }
      return {
        status: this.pathExists(resolved) ? 'exists' : 'missing',
        movedTo: null,
      };
    }

    const entry = this.scopeEntry(item.scope_key);
    if (entry.files) {
      if (entry.files.has(normalizedPath)) {
        return { status: 'exists', movedTo: null };
      }

      const renamed = this.resolveRename(item.scope_key, normalizedPath);
      if (renamed && entry.files.has(renamed)) {
        return { status: 'moved', movedTo: renamed };
      }

      const byBasename = entry.basenames?.get(path.posix.basename(normalizedPath));
      if (byBasename && byBasename !== normalizedPath) {
        return { status: 'moved', movedTo: byBasename };
      }

      return { status: 'missing', movedTo: null };
    }

    const worktreePath = this.resolveWorktree(item);
    if (!worktreePath || !this.pathExists(worktreePath)) {
      return { status: 'unknown', movedTo: null };
    }

    return {
      status: this.pathExists(path.join(worktreePath, normalizedPath))
        ? 'exists'
        : 'missing',
      movedTo: null,
    };
  }

  private scopeEntry(scopeKey: string): ScopeGraphEntry {
    const cached = this.graphCache.get(scopeKey);
    if (cached) {
      return cached;
    }

    const graph = this.store.getCurrentAppGraph(scopeKey);
    let files: Set<string> | null = null;
    let basenames: Map<string, string | null> | null = null;

    if (graph) {
      files = new Set(graph.files);
      basenames = new Map();
      for (const file of graph.files) {
        const base = path.posix.basename(file);
        basenames.set(base, basenames.has(base) ? null : file);
      }
    }

    const entry: ScopeGraphEntry = { graph, files, basenames };
    this.graphCache.set(scopeKey, entry);
    return entry;
  }

  private pathExists(filePath: string): boolean {
    const cached = this.pathExistsCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    const exists = pathExistsRaw(filePath);
    this.pathExistsCache.set(filePath, exists);
    return exists;
  }

  private resolveRename(scopeKey: string, oldPath: string): string | null {
    const key = `${scopeKey}\u0000${oldPath}`;
    const cached = this.renameCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let resolved: string | null = null;
    try {
      resolved = this.store.resolveFileRename(scopeKey, oldPath);
    } catch {
      resolved = null;
    }
    this.renameCache.set(key, resolved);
    return resolved;
  }

  private resolveWorktree(item: ParsedMemoryItem): string | null {
    const key = `${item.scope_key}\u0000${item.session_id ?? ''}`;
    const cached = this.worktreeCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let worktree: string | null = null;
    const graph = this.scopeEntry(item.scope_key).graph;
    if (graph?.worktree_path) {
      worktree = graph.worktree_path;
    } else if (item.session_id) {
      const session = this.store.getSession(item.session_id);
      if (session?.worktree_path) {
        worktree = session.worktree_path;
      }
    }
    worktree ??= this.store.getMeta('root_path') ?? null;

    this.worktreeCache.set(key, worktree);
    return worktree;
  }
}

/** One-shot validation with immediate flush; prefer ReferenceValidator for batch passes. */
export function validateMemoryReferences(
  store: CortexStore,
  item: ParsedMemoryItem,
  options: ReferenceValidatorOptions = {},
): MemoryReferenceValidation {
  const validator = new ReferenceValidator(store, options);
  const validation = validator.validate(item);
  validator.flush();
  return validation;
}

/**
 * Score current-truth validity for retrieval ranking. Missing references
 * demote with a graduated, capped penalty so stale memory stays reachable and
 * labeled instead of buried; moved references count as locatable.
 */
export function referenceValidationScore(
  validation: MemoryReferenceValidation,
  historicalIntent: boolean,
): number {
  if (validation.references.length === 0 || validation.missing === 0) {
    return validation.exists + validation.moved > 0 ? 3 : 0;
  }

  if (historicalIntent) {
    return -1.5 * validation.missing;
  }

  return Math.max(-8, -4 - validation.missing);
}
