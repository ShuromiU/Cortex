#!/usr/bin/env node

import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, applySchema, initializeMeta } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import type { InsertNoteOpts } from '../db/store.js';
import { buildFullState } from '../query/state.js';
import { recall } from '../query/recall.js';
import { brief } from '../query/brief.js';

// ── Helpers ───────────────────────────────────────────────────────────

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): { store: CortexStore; dbPath: string } {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  applySchema(db);

  const checkMeta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!checkMeta) {
    initializeMeta(db, startDir);
  }

  const store = new CortexStore(db);
  return { store, dbPath };
}

function ensureSession(store: CortexStore): string {
  const current = store.getCurrentSession();
  if (current) return current.id;
  const session = store.createSession();
  return session.id;
}

// ── Tool definitions ──────────────────────────────────────────────────

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
] as const;

// ── Tool handler ──────────────────────────────────────────────────────

export function handleToolCall(
  store: CortexStore,
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'cortex_state': {
      return buildFullState(store);
    }

    case 'cortex_note': {
      const sessionId = ensureSession(store);
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
        const subjectStr = note.subject ? `[${note.subject}]` : '';
        const preview = note.content.length > 60 ? note.content.slice(0, 60) + '…' : note.content;
        return `Noted (${note.kind}${subjectStr}): ${preview}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'cortex_recall': {
      const topic = args['topic'] as string;
      return recall(store, topic);
    }

    case 'cortex_brief': {
      const topic = args['topic'] as string;
      const forAgent = args['for'] as string | undefined;
      return brief(store, topic, forAgent);
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── MCP Server ────────────────────────────────────────────────────────

export function createMcpServer(store: CortexStore): Server {
  const server = new Server(
    { name: 'cortex', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const result = handleToolCall(store, name, args);
    return {
      content: [{ type: 'text' as const, text: result }],
    };
  });

  return server;
}

// ── startServer ───────────────────────────────────────────────────────

export async function startServer(startDir?: string): Promise<void> {
  const dir = startDir ?? process.cwd();
  const { store } = openCortexDb(dir);
  ensureSession(store);

  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
