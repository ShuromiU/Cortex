import type { CortexStore, SessionRow } from '../db/store.js';
import { formatScopeLabel } from '../scope/keys.js';

export interface PreferredScope {
  session: SessionRow;
  scopeKey: string | null;
  scopeType: string;
  scopeLabel: string;
}

export function getPreferredScope(store: CortexStore): PreferredScope | undefined {
  const session = store.getCurrentSession() ?? store.getRecentSessions(1)[0];
  if (!session) {
    return undefined;
  }

  return {
    session,
    scopeKey: session.scope_key,
    scopeType: session.scope_type,
    scopeLabel: formatScopeLabel({
      scopeType: session.scope_type === 'branch' || session.scope_type === 'detached-head'
        ? session.scope_type
        : 'project',
      branchRef: session.branch_ref,
      headOid: session.head_oid,
      worktreePath: session.worktree_path,
    }),
  };
}
