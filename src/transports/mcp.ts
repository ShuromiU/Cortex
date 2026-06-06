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

export function deriveEngagementPath(dir: string): string {
  let normalized = dir.replace(/\\/g, '/').toLowerCase();
  normalized = normalized.replace(/^([a-z]):\//, '/$1/');
  const sanitized = normalized.replace(/[^a-z0-9]/g, '_');
  return path.join(os.tmpdir(), `cortex-${sanitized}.state`);
}

export function configureEngagementPath(dir: string): string {
  engagementPath = deriveEngagementPath(dir);
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
    fs.writeFileSync(engagementPath, out);
  } catch {
    // Non-fatal.
  }
}

export function renderCortexRoute(): string {
  return [
    'Cortex route: ambient memory for coding agents.',
    'Default behavior: ambient capture is enabled at session start, and the reflex may whisper short prior context on focus shifts.',
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
    description: 'Load the broader Cortex working set when you explicitly need more context than ambient reflex whispers provide, especially after context loss, dense resumptions, or unclear current direction. Returns current-valid notes first, recent decisions, branch snapshot, and the last-session tail.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
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
    name: 'cortex_recall',
    description: 'Pull evidence from prior sessions on a topic before re-investigating familiar ground, revisiting recurring bugs or tests, proposing changes in an area with history, or touching a system where prior decisions may matter. Returns current-valid memories first and labels stale file references because repo truth beats memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to search for',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'cortex_brief',
    description: 'Compact topical context to paste into a subagent prompt. Call before dispatching an Agent on a non-trivial task in a topic with history in this repo. Returns a smaller, focused subset than cortex_state. Paste the result into the agent prompt yourself; do not ask subagents to call cortex_brief because they do not share your session context reliably.',
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
  switch (toolName) {
    case 'cortex_route':
      return renderCortexRoute();

    case 'cortex_state': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      writeEngagement('enabled', 'true');
      writeEngagement('state_called', 'true');
      const output = buildFullState(store);
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
        const preview = note.content.length > 60
          ? `${note.content.slice(0, 60)}…`
          : note.content;
        const timestamp = formatMemoryTimestamp(note.timestamp);
        const timestampPart = timestamp ? ` [${timestamp}]` : '';
        return `Noted (${note.kind}${subjectStr})${timestampPart}: ${preview}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'cortex_recall': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      const topic = args['topic'] as string;
      const output = recall(store, topic);
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
      const topic = args['topic'] as string;
      const forAgent = args['for'] as string | undefined;
      const output = brief(store, topic, forAgent);
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
      return JSON.stringify(validateMemory(store, topic), null, 2);
    }

    case 'cortex_engage': {
      const session = ensureScopedSession(store, cwd);
      refreshCurrentGraphQuietly(store, cwd);
      writeEngagement('enabled', 'true');
      writeEngagement('state_called', 'true');
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
