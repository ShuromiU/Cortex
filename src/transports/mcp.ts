#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import type { InsertNoteOpts } from '../db/store.js';
import { writeSessionSummary } from '../capture/consolidate.js';
import { buildFullState } from '../query/state.js';
import { recall } from '../query/recall.js';
import { brief } from '../query/brief.js';
import { buildSessionSummary } from '../query/summarize.js';
import { ensureScopedSession, syncBranchSnapshotForSession } from '../scope/runtime.js';
import { refreshCurrentAppGraph } from '../scope/app-graph.js';
import { estimateTokens } from '../query/retrieval.js';
import { formatMemoryTimestamp } from '../query/render.js';
import { suggestNotes } from '../query/suggest-notes.js';
import { validateMemory } from '../query/validate-memory.js';

let engagementPath: string | null = null;
const CORTEX_CONSULTED_KEY = 'cortex_consulted';
const CONSULT_GATE_REQUIRED_KEY = 'consult_gate_required';

function markCortexConsulted(): void {
  writeEngagement(CORTEX_CONSULTED_KEY, 'true');
  writeEngagement(CONSULT_GATE_REQUIRED_KEY, 'false');
}

/** Engagement state lives next to the database; key=value so bash can grep it. */
export function deriveEngagementPath(dir: string): string {
  return path.join(dir, '.cortex.state');
}

/** Pre-move tmpdir location; read-fallback for one release. */
function deriveLegacyEngagementPath(dir: string): string {
  let normalized = dir.replace(/\\/g, '/').toLowerCase();
  normalized = normalized.replace(/^([a-z]):\//, '/$1/');
  const sanitized = normalized.replace(/[^a-z0-9]/g, '_');
  return path.join(os.tmpdir(), `cortex-${sanitized}.state`);
}

export function configureEngagementPath(dir: string): string {
  engagementPath = deriveEngagementPath(dir);

  // Migrate state written by older versions into the project-local file.
  try {
    if (!fs.existsSync(engagementPath)) {
      const legacyPath = deriveLegacyEngagementPath(dir);
      if (fs.existsSync(legacyPath)) {
        fs.copyFileSync(legacyPath, engagementPath);
      }
    }
  } catch {
    // Migration is best-effort.
  }

  return engagementPath;
}

export function readEngagement(): Record<string, string> {
  if (!engagementPath) {
    return {};
  }

  try {
    const raw = fs.readFileSync(engagementPath, 'utf8');
    const result: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeEngagement(key: string, value: string): void {
  if (!engagementPath) {
    return;
  }

  const content = readEngagement();
  content[key] = value;
  const out = Object.entries(content)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  try {
    // Atomic replace: a concurrent reader sees the old or the new file, never a torn write.
    const tempPath = `${engagementPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, out);
    try {
      fs.renameSync(tempPath, engagementPath);
    } catch {
      fs.writeFileSync(engagementPath, out);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Leftover temp file is harmless.
      }
    }
  } catch {
    // Non-fatal.
  }
}

export function renderCortexRoute(): string {
  return [
    'Cortex route: ambient memory for coding agents.',
    'Default behavior: ambient capture is enabled at session start, and the reflex may whisper short prior context on focus shifts.',
    'Deferred schema discovery: use ToolSearch/tool_search by callable name (`cortex_recall`, `cortex_state`, `cortex_route`) or server name (`Cortex`).',
    'Canonical `select:mcp__cortex__...` selectors may return 0 on current Codex app-server builds and are not proof Cortex is unavailable.',
    'Use cortex_recall(topic) proactively before non-trivial work in a familiar area, recurring bug, resumed feature, or system with prior decisions.',
    'Use cortex_state for a broader working set when resuming dense work, and cortex_brief(topic) before delegating with context.',
    'Use cortex_validate_memory(topic) when retrieved notes mention files/plans and you need to check them against the current checkout.',
    'Use cortex_note for durable decisions, blockers, and non-obvious insights; use cortex_disengage to silence capture and reflex.',
  ].join('\n');
}

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): { store: CortexStore; dbPath: string } {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, startDir);
  const store = new CortexStore(db);
  return { store, dbPath };
}

function ensureSession(store: CortexStore, cwd: string): string {
  return ensureScopedSession(store, cwd).id;
}

function refreshCurrentGraphQuietly(store: CortexStore, cwd: string): void {
  try {
    refreshCurrentAppGraph(store, cwd);
  } catch {
    // Current-truth refresh is advisory and should not block MCP tools.
  }
}

const NOTE_PREVIEW_LIMIT = 60;

/** Note text trimmed for agent-facing confirmation lines. */
function notePreview(content: string): string {
  return content.length > NOTE_PREVIEW_LIMIT
    ? `${content.slice(0, NOTE_PREVIEW_LIMIT)}…`
    : content;
}

function note0Plural(count: number): string {
  return count === 1 ? 'note' : 'notes';
}

/**
 * Contested priors are exempt from auto-supersede, so several can be active on
 * one subject at once. Cap what a single write reports — every output surface
 * is budgeted, and this one is on the write path.
 */
const MAX_REPORTED_CONFLICTS = 3;

export const TOOL_DEFINITIONS = [
  {
    name: 'cortex_route',
    description: 'Cold-callable route/help entry point for Cortex ambient memory. Explains automatic capture, reflex whispers, and when to use recall, state, brief, note, engage, or disengage.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_state',
    description: 'Load the broader Cortex working set when you explicitly need more context than the session brief and ambient reflex whispers provide, especially after context loss, dense resumptions, or unclear current direction. Returns current-valid notes first, recent decisions, branch snapshot, and the last-session tail, within a token budget (default 800).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget: {
          type: 'number',
          description: 'Optional output token budget (default 800); lower-priority sections drop first',
        },
      },
      required: [],
    },
  },
  {
    name: 'cortex_note',
    description: 'Save durable memory for future sessions only. Use it for decisions (include rejected alternatives), blockers, committed approaches, and non-obvious constraints or gotchas. Do not use it for acknowledgments, routine progress, or anything obvious from code or git. Notes compete for retrieval, so keep them load-bearing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['insight', 'decision', 'intent', 'blocker', 'focus'],
          description: 'Type of note',
        },
        content: {
          type: 'string',
          description: 'Note content',
        },
        subject: {
          type: 'string',
          description: 'Subject/topic the note concerns (required for decision, intent, blocker, focus)',
        },
        alternatives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alternative options considered (optional)',
        },
      },
      required: ['kind', 'content'],
    },
  },
  {
    name: 'cortex_resolve',
    description: 'Close out a previously saved note: mark a decision/blocker/intent as resolved (done, no longer load-bearing) or superseded. Resolved notes go cold and stop appearing in briefs and default state. Pass replacement content to supersede with an updated note in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        note_id: {
          type: 'string',
          description: 'Exact note id to resolve (preferred when known)',
        },
        subject: {
          type: 'string',
          description: 'Subject of the active note to resolve (used when note_id is not given)',
        },
        status: {
          type: 'string',
          enum: ['resolved', 'superseded'],
          description: "Default 'resolved'",
        },
        replacement: {
          type: 'string',
          description: 'Optional new content; writes a replacement note that supersedes the old one',
        },
      },
      required: [],
    },
  },
  {
    name: 'cortex_recall',
    description: 'Pull evidence from prior sessions on a topic before re-investigating familiar ground, revisiting recurring bugs or tests, proposing changes in an area with history, or touching a system where prior decisions may matter. Answer-shaped: a lead line naming the most relevant memory and its trust level, then timestamped evidence. Current-valid memories rank first; stale or moved file references are labeled because repo truth beats memory. Output stays within a token budget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to search for',
        },
        budget: {
          type: 'number',
          description: 'Optional output token budget (default 600); evidence drops from the bottom',
        },
        detail: {
          type: 'string',
          enum: ['none', 'scores'],
          description: "Optional: 'scores' appends per-result rank breakdowns for debugging retrieval quality",
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'cortex_brief',
    description: 'Compact topical context to paste into a subagent prompt, within a token budget (default 450). Call before dispatching an Agent on a non-trivial task in a topic with history in this repo. Returns a smaller, focused subset than cortex_state, decisions first. Paste the result into the agent prompt yourself; do not ask subagents to call cortex_brief because they do not share your session context reliably.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to brief on',
        },
        for: {
          type: 'string',
          description: 'Name of the agent being briefed (optional)',
        },
        budget: {
          type: 'number',
          description: 'Optional output token budget (default 450)',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'cortex_engage',
    description: 'Activate Cortex capture for this session and immediately load the current working memory. Usually already engaged by `cortex inject-header` at session start. Call it after cortex_disengage or if startup wiring did not run.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_disengage',
    description: 'Turn off Cortex capture and enforcement gates for this session. Use sparingly: when running throwaway or destructive work you do not want memorialized, or while debugging Cortex itself. Call cortex_engage to re-enable.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_summarize',
    description: 'Checkpoint the session before it ends so the next one resumes gracefully. Call it after a meaningful unit of work, before a long break, or when the user explicitly stops for the day. Next-session inject-header uses this summary as the resume tail. Skip throwaway sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        what: {
          type: 'string',
          description: 'Brief description of what the session accomplished (optional; auto-inferred from events if omitted)',
        },
      },
      required: [],
    },
  },
  {
    name: 'cortex_suggest_notes',
    description: 'Suggest load-bearing Cortex notes from the current session without writing them. Use this to review possible decisions, blockers, intents, or insights before calling cortex_note explicitly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session id to inspect. Defaults to the current scoped session.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cortex_validate_memory',
    description: 'Audit Cortex memories against the current checkout without deleting notes. Use when retrieved memory mentions files, plans, or app state that may be stale; returns current/stale status and missing references.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic to validate. Defaults to recent memory.',
        },
      },
      required: [],
    },
  },
] as const;

export function handleToolCall(
  store: CortexStore,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): string {
  configureEngagementPath(cwd);

  switch (toolName) {
    case 'cortex_route':
      markCortexConsulted();
      return renderCortexRoute();

    case 'cortex_state': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      writeEngagement('enabled', 'true');
      writeEngagement('state_called', 'true');
      markCortexConsulted();
      const output = buildFullState(store, {
        ...(typeof args['budget'] === 'number' ? { budget: args['budget'] } : {}),
      });
      store.insertLedgerEntry({
        sessionId: session.id,
        type: 'state',
        direction: 'spent',
        tokens: estimateTokens(output),
      });
      return output;
    }

    case 'cortex_note': {
      const sessionId = ensureSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      const kind = args['kind'] as InsertNoteOpts['kind'];
      const content = args['content'] as string;
      const subject = args['subject'] as string | undefined;
      const alternatives = args['alternatives'] as string[] | undefined;

      try {
        const note = store.insertNote({
          sessionId,
          kind,
          content,
          ...(subject !== undefined ? { subject } : {}),
          ...(alternatives !== undefined ? { alternatives } : {}),
        });
        syncBranchSnapshotForSession(store, sessionId);
        const subjectStr = note.subject ? `[${note.subject}]` : '';
        const timestamp = formatMemoryTimestamp(note.timestamp);
        const timestampPart = timestamp ? ` [${timestamp}]` : '';
        const confirmation = `Noted (${note.kind}${subjectStr})${timestampPart}: ${notePreview(note.content)}`;

        // FR-1: the write always succeeds; a conflict is advisory metadata
        // reported alongside it, never a rejection.
        if (!note.conflicts || note.conflicts.length === 0) {
          return confirmation;
        }
        const total = note.conflicts.length;
        const lines = [
          confirmation,
          `Contested — opposes ${total} active decision${total === 1 ? '' : 's'} on this subject. Both sides are now marked contested:`,
        ];
        for (const conflict of note.conflicts.slice(0, MAX_REPORTED_CONFLICTS)) {
          const priorStamp = formatMemoryTimestamp(conflict.timestamp);
          lines.push(
            `  - ${conflict.id}${priorStamp ? ` [${priorStamp}]` : ''}: ${notePreview(conflict.content)}`,
          );
        }
        if (total > MAX_REPORTED_CONFLICTS) {
          lines.push(`  … and ${total - MAX_REPORTED_CONFLICTS} more (cortex_recall for the rest)`);
        }
        lines.push('Close it with cortex_resolve(note_id) once you know which one holds.');
        return lines.join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'cortex_resolve': {
      ensureScopedSession(store, cwd);
      const noteId = args['note_id'] as string | undefined;
      const subject = args['subject'] as string | undefined;
      const status = (args['status'] as 'resolved' | 'superseded' | undefined) ?? 'resolved';
      const replacement = args['replacement'] as string | undefined;

      const scopeKey = ensureScopedSession(store, cwd).scope_key;

      // Resolving by subject used to lean on an invariant that no longer holds:
      // before contested priors were exempted from auto-supersede, a
      // (kind, subject) pair had at most one active note, so
      // `findActiveNoteBySubject`'s LIMIT 1 was unambiguous. With a live contest
      // there are two, and taking the newest resolved the agent's *current*
      // position while leaving the retracted one as the sole active decision —
      // telling the next session the opposite of what was last decided. When the
      // subject is contested, make the caller name the side.
      if (!noteId && subject) {
        const active = store.getActiveNotesBySubjectAndScope(subject, scopeKey);
        if (active.length > 1) {
          const lines = active.map(candidate => {
            const stamp = formatMemoryTimestamp(candidate.timestamp);
            return `  - ${candidate.id}${stamp ? ` [${stamp}]` : ''}: ${notePreview(candidate.content)}`;
          });
          return [
            `Error: subject "${subject}" has ${active.length} active ${note0Plural(active.length)} — resolving by subject would pick one arbitrarily.`,
            'Re-run with the note_id of the side you want to close:',
            ...lines,
          ].join('\n');
        }
      }

      const note = noteId
        ? store.getNote(noteId)
        : subject
          ? store.findActiveNoteBySubject(subject)
          : undefined;
      if (!note) {
        return `Error: no ${noteId ? `note with id ${noteId}` : `active note with subject "${subject ?? ''}"`} found.`;
      }

      try {
        if (replacement) {
          const replacementNote = store.insertNote({
            sessionId: ensureSession(store, cwd),
            kind: note.kind as InsertNoteOpts['kind'],
            content: replacement,
            ...(note.subject ? { subject: note.subject } : {}),
            // The outgoing note is still active at this point, so detection
            // would fire against it — and a replacement that reverses its
            // predecessor is the common shape here. That produced a brand-new
            // note permanently flagged as contested with a note the same call
            // just retired. This is explicit user resolution; there is nothing
            // to contest.
            skipConflictDetection: true,
          });
          // Set the outgoing note's status explicitly rather than leaning on
          // insertNote's auto-supersede, which the AD-17 veto can suppress.
          store.updateNoteStatus(note.id, status === 'resolved' ? 'resolved' : 'superseded');
          if (note.subject) {
            store.clearConflictsForSubject(note.subject, scopeKey);
          }
          return `Superseded (${note.kind}${note.subject ? `[${note.subject}]` : ''}) with note ${replacementNote.id}.`;
        }

        store.updateNoteStatus(note.id, status);
        // Closing a side closes the contest — otherwise the survivor renders
        // `[contested]` forever against a note nobody is arguing with.
        const cleared = note.subject ? store.clearConflictsForSubject(note.subject, scopeKey) : [];
        const clearedNote = cleared.length > 0 ? ' Contest closed.' : '';
        return `Marked ${note.kind}${note.subject ? `[${note.subject}]` : ''} as ${status}.${clearedNote}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'cortex_recall': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      markCortexConsulted();
      const topic = args['topic'] as string;
      const output = recall(store, topic, {
        ...(typeof args['budget'] === 'number' ? { budget: args['budget'] } : {}),
        ...(args['detail'] === 'scores' ? { detail: 'scores' as const } : {}),
      });
      store.insertLedgerEntry({
        sessionId: session.id,
        type: 'recall',
        direction: 'spent',
        tokens: estimateTokens(output),
      });
      return output;
    }

    case 'cortex_brief': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      markCortexConsulted();
      const topic = args['topic'] as string;
      const forAgent = args['for'] as string | undefined;
      const output = brief(store, topic, forAgent, {
        ...(typeof args['budget'] === 'number' ? { budget: args['budget'] } : {}),
      });
      store.insertLedgerEntry({
        sessionId: session.id,
        type: 'brief',
        direction: 'spent',
        tokens: estimateTokens(output),
      });
      return output;
    }

    case 'cortex_suggest_notes': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      const sessionId = (args['sessionId'] as string | undefined) ?? session.id;
      const suggestions = suggestNotes(store, sessionId);
      return JSON.stringify({ session_id: sessionId, suggestions }, null, 2);
    }

    case 'cortex_validate_memory': {
      ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      const topic = args['topic'] as string | undefined;
      if (topic) {
        markCortexConsulted();
      }
      return JSON.stringify(validateMemory(store, topic), null, 2);
    }

    case 'cortex_engage': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      writeEngagement('enabled', 'true');
      writeEngagement('state_called', 'true');
      markCortexConsulted();
      const output = buildFullState(store);
      store.insertLedgerEntry({
        sessionId: session.id,
        type: 'state',
        direction: 'spent',
        tokens: estimateTokens(output),
      });
      return output;
    }

    case 'cortex_disengage': {
      writeEngagement('enabled', 'false');
      return 'Cortex disengaged. Event logging and gates disabled for this session.';
    }

    case 'cortex_summarize': {
      const what = args['what'] as string | undefined;
      const summary = buildSessionSummary(store, what);
      const sessionId = ensureSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      writeSessionSummary(store, sessionId, summary);
      syncBranchSnapshotForSession(store, sessionId);
      return summary;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

export function createMcpServer(store: CortexStore, cwd: string = process.cwd()): Server {
  const server = new Server(
    { name: 'cortex', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const result = handleToolCall(store, name, args, cwd);
    return {
      content: [{ type: 'text' as const, text: result }],
    };
  });

  return server;
}

export async function startServer(startDir?: string): Promise<void> {
  const dir = startDir ?? process.cwd();
  configureEngagementPath(dir);
  const { store } = openCortexDb(dir);
  ensureScopedSession(store, dir);

  const server = createMcpServer(store, dir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
