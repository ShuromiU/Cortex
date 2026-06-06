#!/usr/bin/env node

import * as path from 'node:path';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import {
  handleAgentEvent,
  handleCmdEvent,
  handleEditEvent,
  handleReadEvent,
  handleWriteEvent,
} from '../capture/hooks.js';
import { reflectMemory, type ReflexEvent } from '../query/reflex.js';
import { ensureScopedSession } from '../scope/runtime.js';
import { configureEngagementPath, readEngagement, writeEngagement } from './mcp.js';

const CORTEX_CONSULTED_KEY = 'cortex_consulted';
const VISIBILITY_HINT_SURFACED_KEY = 'visibility_hint_surfaced';
const VISIBILITY_HINT_CONTEXT =
  'Cortex is available: for resumed/familiar work, call cortex_recall(topic); for broad state, call cortex_state.';

function toPromptHookJson(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  });
}

export type HookAction =
  | 'post'
  | 'reflect-prompt'
  | 'reflect-pre'
  | 'reflect-edit'
  | 'reflect-cmd'
  | 'reflect-agent';

export interface HookRuntimeOptions {
  sessionId?: string;
  stateDir?: string;
  requireEngagement?: boolean;
}

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): CortexStore {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, startDir);
  return new CortexStore(db);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(root[key]);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const resolved = stringValue(value);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function resolveSessionId(
  store: CortexStore,
  cwd: string,
  options: HookRuntimeOptions,
): string {
  return options.sessionId ?? ensureScopedSession(store, cwd).id;
}

function isEnabled(cwd: string, options: HookRuntimeOptions): boolean {
  if (options.requireEngagement === false) {
    return true;
  }

  configureEngagementPath(cwd);
  return readEngagement()['enabled'] === 'true';
}

function renderPromptVisibilityHint(cwd: string): string {
  configureEngagementPath(cwd);
  const engagement = readEngagement();
  if (engagement['enabled'] === 'false') {
    return '';
  }
  if (engagement[CORTEX_CONSULTED_KEY] === 'true') {
    return '';
  }
  if (engagement['state_called'] === 'true') {
    return '';
  }
  if (engagement[VISIBILITY_HINT_SURFACED_KEY] === 'true') {
    return '';
  }

  writeEngagement(VISIBILITY_HINT_SURFACED_KEY, 'true');
  return toPromptHookJson(VISIBILITY_HINT_CONTEXT);
}

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  return nestedRecord(payload, 'tool_input');
}

function toolName(payload: Record<string, unknown>): string {
  return firstString(payload['tool_name'], payload['toolName']) ?? '';
}

function extractFile(input: Record<string, unknown>): string | undefined {
  const direct = firstString(input['file_path'], input['path'], input['file']);
  if (direct) {
    return direct;
  }

  const patch = firstString(input['patch'], input['input'], input['text']);
  const match = patch?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match?.[1]?.trim();
}

function extractCommand(input: Record<string, unknown>): string | undefined {
  return firstString(input['command'], input['cmd']);
}

function extractExit(payload: Record<string, unknown>): string | undefined {
  const toolResult = nestedRecord(payload, 'tool_result');
  const toolOutput = nestedRecord(payload, 'tool_output');
  const toolResponse = nestedRecord(payload, 'tool_response');
  const result = nestedRecord(payload, 'result');
  const exit = firstString(
    payload['exit_code'],
    toolResult['exit_code'],
    toolOutput['exit_code'],
    toolResponse['exit_code'],
    result['exit_code'],
  );
  if (exit) {
    return exit;
  }

  for (const value of [
    payload['exit_code'],
    toolResult['exit_code'],
    toolOutput['exit_code'],
    toolResponse['exit_code'],
    result['exit_code'],
  ]) {
    if (typeof value === 'number') {
      return String(value);
    }
  }

  return undefined;
}

function extractStream(payload: Record<string, unknown>, key: 'stdout' | 'stderr'): string | undefined {
  const toolResult = nestedRecord(payload, 'tool_result');
  const toolOutput = nestedRecord(payload, 'tool_output');
  const toolResponse = nestedRecord(payload, 'tool_response');
  const result = nestedRecord(payload, 'result');
  return firstString(
    payload[key],
    toolResult[key],
    toolOutput[key],
    toolResponse[key],
    result[key],
  );
}

function postToolUse(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): void {
  const sessionId = resolveSessionId(store, cwd, options);
  const name = toolName(payload);
  const input = toolInput(payload);

  if (name === 'Read') {
    const file = extractFile(input);
    if (file) {
      handleReadEvent(store, sessionId, { file });
    }
    return;
  }

  if (name === 'Edit' || name === 'apply_patch' || name.endsWith('.apply_patch')) {
    const file = extractFile(input);
    if (file) {
      handleEditEvent(store, sessionId, { file });
    }
    return;
  }

  if (name === 'Write') {
    const file = extractFile(input);
    if (file) {
      handleWriteEvent(store, sessionId, { file });
    }
    return;
  }

  if (name === 'Bash' || name === 'shell_command' || name.endsWith('.shell_command')) {
    const cmd = extractCommand(input);
    if (cmd) {
      handleCmdEvent(store, sessionId, {
        cmd,
        exit: extractExit(payload),
        stdout: extractStream(payload, 'stdout'),
        stderr: extractStream(payload, 'stderr'),
      });
    }
    return;
  }

  if (name === 'Agent') {
    const desc = firstString(input['description'], input['desc']);
    if (desc) {
      handleAgentEvent(store, sessionId, { desc });
    }
  }
}

function reflectFromPayload(
  store: CortexStore,
  action: HookAction,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): string {
  const sessionId = resolveSessionId(store, cwd, options);
  const input = toolInput(payload);
  let event: ReflexEvent | undefined;
  let prompt: string | undefined;
  let file: string | undefined;
  let cmd: string | undefined;
  let desc: string | undefined;

  if (action === 'reflect-prompt') {
    event = 'prompt';
    prompt = firstString(payload['prompt'], payload['message'], payload['user_prompt']);
    const hint = renderPromptVisibilityHint(cwd);
    if (hint) {
      return hint;
    }
  } else if (action === 'reflect-edit') {
    event = 'edit';
    file = extractFile(input) ?? firstString(payload['file']);
  } else if (action === 'reflect-cmd') {
    event = 'cmd';
    cmd = extractCommand(input) ?? firstString(payload['cmd']);
  } else if (action === 'reflect-agent') {
    event = 'agent';
    desc = firstString(input['description'], input['desc'], payload['desc']);
  } else {
    const name = toolName(payload);
    if (name === 'Bash' || name === 'shell_command' || name.endsWith('.shell_command')) {
      event = 'cmd';
      cmd = extractCommand(input);
    } else if (name === 'Edit' || name === 'Write' || name === 'apply_patch' || name.endsWith('.apply_patch')) {
      event = 'edit';
      file = extractFile(input);
    } else if (name === 'Agent') {
      event = 'agent';
      desc = firstString(input['description'], input['desc']);
    }
  }

  if (!event) {
    return '';
  }

  return reflectMemory(store, {
    event,
    prompt,
    file,
    cmd,
    desc,
    sessionId,
    stateDir: options.stateDir,
  });
}

export function handleHookPayload(
  store: CortexStore,
  action: HookAction,
  rawPayload: string,
  cwd: string,
  options: HookRuntimeOptions = {},
): string {
  if (!isEnabled(cwd, options)) {
    return '';
  }

  const payload = parsePayload(rawPayload);
  if (action === 'post') {
    postToolUse(store, payload, cwd, options);
    return '';
  }

  return reflectFromPayload(store, action, payload, cwd, options);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const action = process.argv[2] as HookAction | undefined;
  if (!action) {
    return;
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);
  const cwd = stringValue(payload['cwd']) ?? process.cwd();
  const store = openCortexDb(cwd);
  const output = handleHookPayload(store, action, raw, cwd);
  if (output) {
    process.stdout.write(`${output}\n`);
  }
}

const self = process.argv[1] ?? '';
if (self.endsWith('hook-entry.js') || self.endsWith('hook-entry.ts')) {
  void main();
}
