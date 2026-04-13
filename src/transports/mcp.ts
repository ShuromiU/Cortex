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

let engagementPath: string | null = null;

export function deriveEngagementPath(dir: string): string {
  let normalized = dir.replace(/\\/g, '/').toLowerCase();
  normalized = normalized.replace(/^([a-z]):\//, '/$1/');
  const sanitized = normalized.replace(/[^a-z0-9]/g, '_');
  return path.join(os.tmpdir(), `cortex-${sanitized}.state`);
}

function readEngagement(): Record<string, string> {
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

function writeEngagement(key: string, value: string): void {
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

export const TOOL_DEFINITIONS = [
  {
    name: 'cortex_state',
    description: 'Get the full cognitive state: active notes, recent session activity, project state.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_note',
    description: 'Record a note (insight, decision, intent, blocker, or focus) to working memory.',
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
    description: 'Search notes and consolidated state for a topic.',
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
    description: 'Generate a focused briefing on a topic, optionally for a named agent.',
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
    description: 'Activate Cortex working memory for this session. Enables event logging and enforcement gates, then returns the full cognitive state. Call this when you want Cortex to track your work.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_disengage',
    description: 'Deactivate Cortex working memory for this session. Disables event logging and enforcement gates.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_summarize',
    description: 'Generate a smart summary of the current session: files touched, directories, commands, test cycles, decisions. Use at the end of a session to preserve context for future sessions.',
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
] as const;

export function handleToolCall(
  store: CortexStore,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): string {
  switch (toolName) {
    case 'cortex_state': {
      ensureScopedSession(store, cwd);
      writeEngagement('state_called', 'true');
      return buildFullState(store);
    }

    case 'cortex_note': {
      const sessionId = ensureSession(store, cwd);
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
        return `Noted (${note.kind}${subjectStr}): ${preview}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'cortex_recall': {
      ensureScopedSession(store, cwd);
      const topic = args['topic'] as string;
      return recall(store, topic);
    }

    case 'cortex_brief': {
      ensureScopedSession(store, cwd);
      const topic = args['topic'] as string;
      const forAgent = args['for'] as string | undefined;
      return brief(store, topic, forAgent);
    }

    case 'cortex_engage': {
      ensureScopedSession(store, cwd);
      writeEngagement('enabled', 'true');
      writeEngagement('state_called', 'true');
      return buildFullState(store);
    }

    case 'cortex_disengage': {
      writeEngagement('enabled', 'false');
      return 'Cortex disengaged. Event logging and gates disabled for this session.';
    }

    case 'cortex_summarize': {
      const what = args['what'] as string | undefined;
      const summary = buildSessionSummary(store, what);
      const sessionId = ensureSession(store, cwd);
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
  engagementPath = deriveEngagementPath(dir);
  const { store } = openCortexDb(dir);
  ensureScopedSession(store, dir);

  const server = createMcpServer(store, dir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
