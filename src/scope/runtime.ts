import type { CortexStore, SessionRow, UpsertBranchSnapshotOpts, ParsedNote } from '../db/store.js';
import { consolidateLevel1, renderCompressed } from '../capture/consolidate.js';
import { detectGitScope, type GitScopeIdentity } from './git.js';

export interface ScopeSessionOptions {
  resolveScope?: (cwd: string) => GitScopeIdentity;
  /** Host-provided subagent id. Present → resolve a child session (AD-9). */
  agentId?: string;
  /** Host-provided subagent type, recorded on the child session. */
  agentType?: string;
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
    const nonCommandEvents = compressed.filter(event => event.type !== 'cmd');
    if (nonCommandEvents.length > 0) {
      return renderCompressed(nonCommandEvents);
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

  // A subagent's reads must not rewrite the branch snapshot — the snapshot is
  // the primary timeline's summary, and every capture handler calls this.
  if (session.parent_session_id) {
    return;
  }

  const payload = buildSnapshotPayload(store, session);
  if (!payload) {
    return;
  }

  store.upsertBranchSnapshot(payload);
}

/**
 * Find or create the child session for `agentId` under `primary`. Identity is
 * `(scope_key, agent_id)` per AD-9, so the same subagent resolves to the same
 * session for as long as it runs, and two subagents never share one.
 */
function findAgentSession(
  store: CortexStore,
  primary: SessionRow,
  agentId: string,
): SessionRow | undefined {
  return primary.scope_key
    ? store.getSessionByAgentId(primary.scope_key, agentId)
    // A primary with no scope key yet cannot be searched by AD-9 identity;
    // fall back to its own children so a repeat payload still reuses one
    // rather than creating an unbounded run of duplicates.
    : store.getChildSessions(primary.id).find(child => child.agent_id === agentId);
}

function ensureAgentSession(
  store: CortexStore,
  primary: SessionRow,
  agentId: string,
  agentType: string | undefined,
): SessionRow {
  const existing = findAgentSession(store, primary, agentId);
  if (existing) {
    // The host may not report agent_type on an agent's first captured call.
    // Upgrade the placeholder rather than freezing it for the session's life.
    if (agentType && agentType !== existing.agent_type) {
      store.updateSessionAgentType(existing.id, agentType);
      return store.getSession(existing.id) ?? existing;
    }
    return existing;
  }

  let created: SessionRow;
  try {
    created = store.createSession({
      parentSessionId: primary.id,
      agentId,
      agentType: agentType ?? 'subagent',
      ...(primary.git_root ? { gitRoot: primary.git_root } : {}),
      ...(primary.worktree_path ? { worktreePath: primary.worktree_path } : {}),
      ...(primary.branch_ref ? { branchRef: primary.branch_ref } : {}),
      ...(primary.head_oid ? { headOid: primary.head_oid } : {}),
      scopeType: primary.scope_type,
      ...(primary.scope_key ? { scopeKey: primary.scope_key } : {}),
    });
  } catch (error) {
    // Lost the race to a concurrent hook process; its row is authoritative.
    const winner = findAgentSession(store, primary, agentId);
    if (winner) {
      return winner;
    }
    throw error;
  }

  // A batch can be flushed after its primary ended. Nothing would ever end a
  // child created at that point — `endSessionTree` only runs on the active
  // primary — leaving it permanently invisible to consolidation and event GC,
  // both of which require `status = 'ended'`.
  if (primary.status === 'ended') {
    store.endSession(created.id);
    return store.getSession(created.id) ?? created;
  }

  return created;
}

/**
 * Resolve the session a spooled entry belongs to, given the primary session the
 * batch is being flushed into. Deliberately keyed off the *recorded* primary
 * rather than whatever is active now: a batch can be replayed long after its
 * turn, and the work belongs to the session that produced it.
 *
 * Returns `primarySessionId` unchanged when the primary row is gone, so a
 * flush degrades to today's attribution instead of failing (AD-12).
 */
export function resolveAgentSessionId(
  store: CortexStore,
  primarySessionId: string,
  agentId: string,
  agentType?: string,
): string {
  const primary = store.getSession(primarySessionId);
  if (!primary) {
    return primarySessionId;
  }

  return ensureAgentSession(store, primary, agentId, agentType).id;
}

export function ensureScopedSession(
  store: CortexStore,
  cwd: string,
  options: ScopeSessionOptions = {},
): SessionRow {
  if (!options.agentId) {
    return ensurePrimarySession(store, cwd, options);
  }

  // A subagent belongs to the session that dispatched it. Its cwd can differ
  // from the parent's — worktree-isolated agents, nested repos, submodules —
  // and resolving scope from it would end and rotate the parent's live session
  // mid-turn, then parent the child to the replacement. Take the active
  // primary as-is; only resolve scope when there is none to inherit.
  const active = store.getCurrentSession();
  const primary = active?.scope_key ? active : ensurePrimarySession(store, cwd, options);
  return ensureAgentSession(store, primary, options.agentId, options.agentType);
}

/**
 * Resolve the scope's primary session, rotating it when the scope changed.
 * Rotation, snapshot sync and session end happen here and only here — a
 * subagent payload must never end or rotate the primary it belongs to.
 */
function ensurePrimarySession(
  store: CortexStore,
  cwd: string,
  options: ScopeSessionOptions,
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
    store.endSessionTree(current.id);
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
