import type { CortexStore, ParsedNote } from '../db/store.js';
import { tokenizeCommand } from './command-tokens.js';

/**
 * Refuse a subagent retiring, editing or deleting memory that belongs to an
 * earlier session (FR-19, Story 5.3, AC #3).
 *
 * ## Why this lives on `PreToolUse` and not in the MCP server
 *
 * Cortex's MCP server cannot tell a subagent's call from its parent's. The
 * twelve `ensureScopedSession` call sites in `src/transports/mcp.ts` pass only
 * `(store, cwd)`, and MCP carries no caller id — measured, not assumed. The
 * `PreToolUse` hook payload DOES carry `agent_id` for a subagent's tool call
 * (probed live: an `mcp__cortex__cortex_note` call from a subagent arrives with
 * it, while the parent's own calls arrive without), and `PreToolUse` is the one
 * event that can deny. So enforcement is possible here and nowhere else.
 *
 * ## "Its own session" means its own session TREE
 *
 * Ruling (a), ShuromiU, 2026-08-06. No note is ever stamped with a subagent's
 * session id: both MCP write paths resolve through `ensureSession(store, cwd)`,
 * which carries no identity and lands on the PRIMARY. Comparing a note's
 * `session_id` against the calling subagent's own child id would therefore deny
 * every subagent memory operation — including on a note that same subagent
 * wrote seconds earlier — which is the fail-closed outcome the AC forbids.
 * `getSessionTreeIds` is the right set: this conversation, primary and
 * children.
 *
 * ## Three routes retire other people's decisions, not one
 *
 * `insertNote`'s auto-supersede filters by neither session nor scope, so:
 * `cortex_resolve` on a named note (the route AC #3 names), `cortex_note`
 * itself (a `decision` retires every other active `decision` on that subject,
 * anywhere in the store), and `cortex_resolve` WITH `replacement` (it calls
 * `insertNote`, so a named-target check alone passes it straight through).
 * Ruling (b) adds a fourth: the shell reaches the same memory through
 * `note-resolve`, `edit-memory` and `delete-memory`, and that delete is more
 * destructive than anything the AC names.
 *
 * ## Fail OPEN, everywhere, without exception
 *
 * Any inability to establish that a target lies outside the tree allows the
 * call: no current session, an unknown agent, an unresolvable target, a
 * malformed payload, a thrown store. A blocking hook that errs toward blocking
 * stops the user's own work, which is a worse failure than the one it prevents.
 * The residual is stated rather than wished away — a shell command whose target
 * is built at runtime (`cortex delete-memory "$ID"`) resolves to nothing here
 * and is allowed.
 *
 * ## What is deliberately NOT guarded
 *
 * Contest marking. `insertNote` also flags a prior note `[contested]` when the
 * incoming note contradicts it, and that flag lands on notes outside the tree
 * the same way a supersede does. It is excluded because it is not a retirement:
 * both sides stay active and visible, and the marker is the product working —
 * FR-1 exists to surface disagreement, and a subagent noticing one is a good
 * outcome. Denying it would turn contradiction detection off for subagents
 * entirely.
 *
 * AD-7 companion: refunds are scoped to `PostToolUse` substitution and
 * explicitly not to `PreToolUse` deny. This is a different capability on a
 * different path and books no refund; the two do not contradict.
 */

/** Every tool this guard inspects. Nothing else — not the read-only tools. */
export const MEMORY_GUARD_TOOLS = [
  'mcp__cortex__cortex_note',
  'mcp__cortex__cortex_resolve',
  'Bash',
] as const;

/** The `PreToolUse` matcher `install` writes and `doctor` checks. */
export const MEMORY_GUARD_MATCHER = MEMORY_GUARD_TOOLS.join('|');

/**
 * The shell subcommands that reach memory.
 *
 * Duplicated as a literal `case` in `hooks/claude/cortex-subagent.sh`, which is
 * the point: N-4 forbids spawning Node per tool call, and `PreToolUse` on
 * `Bash` fires for every command the agent runs. The shell pre-filter decides
 * without Node, and a test asserts the two lists agree so the cheap check and
 * the real one cannot drift apart.
 */
export const SHELL_MEMORY_COMMANDS = ['note-resolve', 'edit-memory', 'delete-memory'] as const;

/** The pure-text pre-filter, mirrored in the hook script. */
export function shellCommandTargetsMemory(command: string): boolean {
  return SHELL_MEMORY_COMMANDS.some(name => command.includes(name));
}

export type GuardedAction = 'retire' | 'edit' | 'delete';

export interface GuardedTarget {
  /** The id the call named, or the note id behind it. */
  id: string;
  /** Plain-language identification for the denial reason. */
  label: string;
}

export interface MemoryGuardDenial {
  action: GuardedAction;
  targets: GuardedTarget[];
  reason: string;
}

export interface MemoryGuardRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Present only for a subagent. The parent is untouched by this guard. */
  agentId: string;
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function noteLabel(note: ParsedNote): string {
  return note.subject ? `${note.kind}[${note.subject}]` : note.kind;
}

/**
 * Decide whether to deny. `undefined` is allow-and-say-nothing, which is both
 * the ordinary outcome and every failure outcome.
 */
export function evaluateMemoryGuard(
  store: CortexStore,
  request: MemoryGuardRequest,
): MemoryGuardDenial | undefined {
  if (!request.agentId) {
    return undefined;
  }

  const primary = store.getCurrentSession();
  if (!primary?.scope_key) {
    return undefined;
  }

  const child = store.getSessionByAgentId(primary.scope_key, request.agentId);
  if (!child) {
    return undefined;
  }

  // Ruling (a). Resolved from the CHILD so that a subagent whose parent has
  // rotated is judged against the tree it actually belongs to.
  const tree = new Set(store.getSessionTreeIds(child.id));
  const outside = (sessionId: string | null | undefined): boolean =>
    typeof sessionId === 'string' && sessionId.length > 0 && !tree.has(sessionId);

  const collected = collectTargets(store, request, primary.id, outside);
  if (!collected || collected.targets.length === 0) {
    return undefined;
  }

  return {
    ...collected,
    reason: renderReason(collected.action, collected.targets),
  };
}

function collectTargets(
  store: CortexStore,
  request: MemoryGuardRequest,
  writerSessionId: string,
  outside: (sessionId: string | null | undefined) => boolean,
): { action: GuardedAction; targets: GuardedTarget[] } | undefined {
  switch (request.toolName) {
    case 'mcp__cortex__cortex_note':
      return {
        action: 'retire',
        targets: supersedeTargets(store, request.toolInput, writerSessionId, outside),
      };

    case 'mcp__cortex__cortex_resolve':
      return resolveTargets(store, request.toolInput, writerSessionId, outside);

    case 'Bash':
      return shellTargets(store, request.toolInput, outside);

    default:
      return undefined;
  }
}

/**
 * What a `cortex_note` write would auto-supersede outside the tree.
 *
 * `previewNoteWrite` runs `insertNote`'s own decision phase rather than a
 * re-derivation of it — same-kind only, AD-17 veto applied, subject normalised
 * — so this guard and the behaviour it guards cannot drift.
 *
 * `writerSessionId` is the PRIMARY, because that is the session the write will
 * actually land on: both MCP write paths resolve without identity. It matters
 * because contradiction detection is scope-filtered against the writer, and the
 * AD-17 veto is computed from the detected conflicts.
 */
function supersedeTargets(
  store: CortexStore,
  input: Record<string, unknown>,
  writerSessionId: string,
  outside: (sessionId: string | null | undefined) => boolean,
  overrides: { kind?: string; content?: string; subject?: string; skipConflictDetection?: boolean } = {},
): GuardedTarget[] {
  const kind = overrides.kind ?? stringField(input, 'kind');
  const content = overrides.content ?? stringField(input, 'content');
  const subject = overrides.subject ?? stringField(input, 'subject');
  if (!kind || !content) {
    return [];
  }

  const preview = store.previewNoteWrite({
    kind,
    content,
    sessionId: writerSessionId,
    ...(subject ? { subject } : {}),
    ...(overrides.skipConflictDetection ? { skipConflictDetection: true } : {}),
  });

  const targets: GuardedTarget[] = [];
  for (const id of preview.supersededIds) {
    const note = store.getNote(id);
    if (note && outside(note.session_id)) {
      targets.push({ id, label: noteLabel(note) });
    }
  }
  return targets;
}

function resolveTargets(
  store: CortexStore,
  input: Record<string, unknown>,
  writerSessionId: string,
  outside: (sessionId: string | null | undefined) => boolean,
): { action: GuardedAction; targets: GuardedTarget[] } {
  const noteId = stringField(input, 'note_id', 'noteId');
  const subject = stringField(input, 'subject');
  // Mirrors the handler: id when given, else the active note for the subject.
  const note = noteId
    ? store.getNote(noteId)
    : subject
      ? store.findActiveNoteBySubject(subject)
      : undefined;
  if (!note) {
    return { action: 'retire', targets: [] };
  }

  const targets: GuardedTarget[] = [];
  if (outside(note.session_id)) {
    targets.push({ id: note.id, label: noteLabel(note) });
  }

  // `replacement` is the third auto-supersede route: the handler calls
  // `insertNote` with the OUTGOING note's kind and subject and
  // `skipConflictDetection: true`, so it can retire further notes the named
  // target check never sees. Mirrored exactly, including the skip flag — with
  // detection on, the AD-17 veto would spare priors the real write retires.
  const replacement = stringField(input, 'replacement');
  if (replacement) {
    const extra = supersedeTargets(store, input, writerSessionId, outside, {
      kind: note.kind,
      content: replacement,
      ...(note.subject ? { subject: note.subject } : {}),
      skipConflictDetection: true,
    });
    for (const target of extra) {
      if (!targets.some(existing => existing.id === target.id)) {
        targets.push(target);
      }
    }
  }

  return { action: 'retire', targets };
}

/** The shell route (ruling (b)). Anything unparseable resolves to nothing. */
function shellTargets(
  store: CortexStore,
  input: Record<string, unknown>,
  outside: (sessionId: string | null | undefined) => boolean,
): { action: GuardedAction; targets: GuardedTarget[] } | undefined {
  const command = stringField(input, 'command');
  if (!command || !shellCommandTargetsMemory(command)) {
    return undefined;
  }

  const tokens = tokenizeCommand(command);

  if (tokens.includes('note-resolve')) {
    const id = flagValue(tokens, '--id');
    const subject = flagValue(tokens, '--subject');
    const note = id ? store.getNote(id) : subject ? store.findActiveNoteBySubject(subject) : undefined;
    if (note && outside(note.session_id)) {
      return { action: 'retire', targets: [{ id: note.id, label: noteLabel(note) }] };
    }
    return { action: 'retire', targets: [] };
  }

  for (const [name, action] of [
    ['edit-memory', 'edit'],
    ['delete-memory', 'delete'],
  ] as const) {
    const index = tokens.indexOf(name);
    if (index < 0) {
      continue;
    }
    // `delete-memory` previews unless `--yes` is passed. A preview reads and
    // changes nothing, and denying a read would block the subagent from even
    // LOOKING at what it must not delete — which is both over-blocking and
    // worse advice than letting it look and refusing the delete.
    if (name === 'delete-memory' && !tokens.includes('--yes')) {
      return { action, targets: [] };
    }
    const id = positionalAfter(tokens, index);
    if (!id) {
      return { action, targets: [] };
    }
    // The same two-step `correct.ts` uses: a memory-item id, or the id of the
    // note behind it, so an id copied out of `list-memory` resolves either way.
    const item = store.getMemoryItem(id) ?? store.getMemoryItemBySource('notes', id);
    if (item && outside(item.session_id)) {
      return {
        action,
        targets: [{ id: item.id, label: item.subject ? `${item.kind}[${item.subject}]` : item.kind }],
      };
    }
    return { action, targets: [] };
  }

  return undefined;
}

function flagValue(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  if (index >= 0) {
    const value = tokens[index + 1];
    return value && !value.startsWith('-') ? value : undefined;
  }
  const inline = tokens.find(token => token.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) || undefined : undefined;
}

/** The first non-flag token after a subcommand — its `<id>` argument. */
function positionalAfter(tokens: string[], index: number): string | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (token.startsWith('-')) {
      // `--text <value>` and `--file <path>` take an argument; skipping only
      // the flag would read its value as the id.
      if (token === '--text' || token === '--file') {
        cursor += 1;
      }
      continue;
    }
    return token;
  }
  return undefined;
}

const ACTION_PHRASE: Record<GuardedAction, string> = {
  retire: 'retire',
  edit: 'rewrite',
  delete: 'delete',
};

/**
 * The denial the subagent reads. User-facing text, so it says plainly what
 * happened and what to do instead (SM-C3: a denial reason that misstates why is
 * the worst thing this guard can produce). Named targets are capped — a reason
 * listing forty notes is not more informative than one listing three.
 */
function renderReason(action: GuardedAction, targets: GuardedTarget[]): string {
  const named = targets.slice(0, 3).map(target => `  - ${target.label} (${target.id})`);
  const remainder = targets.length - named.length;
  const count = targets.length === 1 ? '1 memory' : `${targets.length} memories`;

  return [
    `Cortex refused this: a subagent may not ${ACTION_PHRASE[action]} memory from an earlier session.`,
    `This call would ${ACTION_PHRASE[action]} ${count} written outside this conversation:`,
    ...named,
    ...(remainder > 0 ? [`  - …and ${remainder} more`] : []),
    'Put the finding in your final message instead — it is recorded automatically, and the parent can act on it.',
  ].join('\n');
}
