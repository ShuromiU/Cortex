import type { CortexStore, SessionRow, UpsertBranchSnapshotOpts, ParsedNote } from '../db/store.js';
import { consolidateLevel1, renderCompressed } from '../capture/consolidate.js';
import { detectGitScope, type GitScopeIdentity } from './git.js';

export interface ScopeSessionOptions {
  resolveScope?: (cwd: string) => GitScopeIdentity;
}

function collectRecentFiles(store: CortexStore, scopeKey: string): string[] {
  const sessions = store.getRecentSessionsByScope(scopeKey, 3);
  const counts = new Map<string, number>();

  for (const session of sessions) {
    for (const event of store.getEventsBySession(session.id)) {
      if (!event.target) {
        continue;
      }
      if (event.type !== 'read' && event.type !== 'edit' && event.type !== 'write') {
        continue;
      }
      counts.set(event.target, (counts.get(event.target) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort(([, left], [, right]) => right - left)
    .slice(0, 6)
    .map(([file]) => file);
}

function noteList(notes: ParsedNote[]): string[] {
  return notes.map(note => {
    const subject = note.subject ? `[${note.subject}] ` : '';
    return `${subject}${note.content}`;
  });
}

function summarizeScope(store: CortexStore, scopeKey: string): string {
  const scopedSessions = store.getRecentSessionsByScope(scopeKey, 5);

  for (const session of scopedSessions) {
    const state = store.getSessionState(session.id);
    if (state) {
      return state.content;
    }
  }

  for (const session of scopedSessions) {
    const compressed = consolidateLevel1(store, session.id);
    if (compressed.length > 0) {
      return renderCompressed(compressed);
    }
  }

  const notes = store.getActiveNotesByScope(scopeKey).slice(0, 4);
  if (notes.length > 0) {
    return noteList(notes).join('\n');
  }

  return '';
}

function buildSnapshotPayload(
  store: CortexStore,
  session: SessionRow,
): UpsertBranchSnapshotOpts | undefined {
  if (!session.scope_key) {
    return undefined;
  }

  if (session.scope_type !== 'branch' && session.scope_type !== 'detached-head') {
    return undefined;
  }

  const scopedSessions = store.getRecentSessionsByScope(session.scope_key, 5);
  const summary = summarizeScope(store, session.scope_key);
  const notes = store.getActiveNotesByScope(session.scope_key);
  const intents = noteList(notes.filter(note => note.kind === 'intent').slice(0, 5));
  const blockers = noteList(notes.filter(note => note.kind === 'blocker').slice(0, 5));
  const recentFiles = collectRecentFiles(store, session.scope_key);
  const focus = session.focus ?? scopedSessions.find(row => row.focus !== null)?.focus ?? null;

  if (!summary && intents.length === 0 && blockers.length === 0 && recentFiles.length === 0 && !focus) {
    return undefined;
  }

  return {
    scopeKey: session.scope_key,
    gitRoot: session.git_root,
    worktreePath: session.worktree_path,
    branchRef: session.branch_ref,
    headOid: session.head_oid,
    focus,
    summary: summary || 'No summarized activity yet.',
    recentFiles,
    intents,
    blockers,
    lastSessionId: scopedSessions[0]?.id ?? session.id,
  };
}

export function syncBranchSnapshotForSession(
  store: CortexStore,
  sessionId: string,
): void {
  const session = store.getSession(sessionId);
  if (!session) {
    return;
  }

  const payload = buildSnapshotPayload(store, session);
  if (!payload) {
    return;
  }

  store.upsertBranchSnapshot(payload);
}

export function ensureScopedSession(
  store: CortexStore,
  cwd: string,
  options: ScopeSessionOptions = {},
): SessionRow {
  const scope = (options.resolveScope ?? detectGitScope)(cwd);
  const current = store.getCurrentSession();

  if (current && !current.scope_key) {
    store.updateSessionScope(current.id, {
      gitRoot: scope.gitRoot,
      worktreePath: scope.worktreePath,
      branchRef: scope.branchRef,
      headOid: scope.headOid,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    });
    return store.getSession(current.id)!;
  }

  if (current?.scope_key === scope.scopeKey) {
    return current;
  }

  if (current) {
    syncBranchSnapshotForSession(store, current.id);
    store.endSession(current.id);
  }

  return store.createSession({
    gitRoot: scope.gitRoot ?? undefined,
    worktreePath: scope.worktreePath,
    branchRef: scope.branchRef ?? undefined,
    headOid: scope.headOid ?? undefined,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  });
}
