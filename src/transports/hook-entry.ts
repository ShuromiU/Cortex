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
import { openProjectStore } from '../scope/store-migration.js';
import { reflectMemory, type ReflexEvent } from '../query/reflex.js';
import { suggestNotes } from '../query/suggest-notes.js';
import { flushSpool } from '../capture/spool.js';
import { ensureScopedSession, type ScopeSessionOptions } from '../scope/runtime.js';
import { configureEngagementPath, readEngagement, writeEngagement } from './mcp.js';

const CORTEX_CONSULTED_KEY = 'cortex_consulted';
const CONSULT_GATE_FIRED_KEY = 'consult_gate_fired';
const CONSULT_GATE_SURFACED_COUNT_KEY = 'consult_gate_surfaced_count';
const AGENT_USED_KEY = 'agent_used';
const CONSULT_GATE_CONTEXT =
  'Cortex may have prior context for this work — cortex_recall(topic) checks; cortex_state for broad state.';
const MEMORY_RELEVANT_PROMPT_PATTERN =
  /\b(resume|resumed|resuming|continue|continuing|again|earlier|previous|prior|follow[- ]?up|pick up|fix|debug|bug|error|failure|failing|broken|regression|implement|plan|multi[- ]?step|decision|remember|memory|refactor)\b/i;
const STOP_NUDGE_CONFIDENCE_THRESHOLD = 0.6;

function toHookJson(hookEventName: 'UserPromptSubmit' | 'PreToolUse', additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
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
  | 'reflect-agent'
  | 'end-of-turn';

export interface HookRuntimeOptions {
  sessionId?: string;
  stateDir?: string;
  requireEngagement?: boolean;
}

function openCortexDb(startDir: string): CortexStore {
  return new CortexStore(openProjectStore(startDir).db);
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

/**
 * Subagent identity as the host reports it. Field-name drift must degrade to
 * primary-session attribution — today's behavior — rather than break capture,
 * so both snake_case and camelCase spellings are accepted and absence is fine.
 */
function agentIdentity(payload: Record<string, unknown>): ScopeSessionOptions {
  const agentId = firstString(payload['agent_id'], payload['agentId']);
  if (!agentId) {
    return {};
  }

  const agentType = firstString(payload['agent_type'], payload['agentType']);
  return { agentId, ...(agentType ? { agentType } : {}) };
}

function resolveSessionId(
  store: CortexStore,
  cwd: string,
  options: HookRuntimeOptions,
  identity: ScopeSessionOptions = {},
): string {
  return options.sessionId ?? ensureScopedSession(store, cwd, identity).id;
}

function isEnabled(cwd: string, options: HookRuntimeOptions): boolean {
  if (options.requireEngagement === false) {
    return true;
  }

  configureEngagementPath(cwd);
  return readEngagement()['enabled'] === 'true';
}

function hasPriorScopeSessions(store: CortexStore): boolean {
  const session = store.getCurrentSession() ?? store.getRecentPrimarySessions(1)[0];
  if (!session) {
    return false;
  }

  const scopeCount = session.scope_key
    ? store.getSessionCountByScope(session.scope_key)
    : store.getSessionCount();
  return scopeCount > 1;
}

function promptGateReason(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  return MEMORY_RELEVANT_PROMPT_PATTERN.test(prompt)
    ? 'prompt indicates resumed, debugging, implementation, or decision-heavy work'
    : undefined;
}

function incrementConsultGateCount(engagement: Record<string, string>): void {
  const surfaced = Number.parseInt(engagement[CONSULT_GATE_SURFACED_COUNT_KEY] ?? '0', 10);
  const next = Number.isFinite(surfaced) ? surfaced + 1 : 1;
  writeEngagement(CONSULT_GATE_SURFACED_COUNT_KEY, String(next));
}

/**
 * One-line, once-per-session hint. The SessionStart brief and the reflex are
 * the real memory channels; this only catches sessions where the brief was
 * empty but the prompt looks memory-relevant.
 */
function renderConsultGate(
  store: CortexStore,
  cwd: string,
  hookEventName: 'UserPromptSubmit' | 'PreToolUse',
  reason: string | undefined,
): string {
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
  if (engagement[CONSULT_GATE_FIRED_KEY] === 'true') {
    return '';
  }

  const resolvedReason = reason ?? (
    hasPriorScopeSessions(store) ? 'current scope has prior Cortex sessions' : undefined
  );
  if (!resolvedReason) {
    return '';
  }

  writeEngagement(CONSULT_GATE_FIRED_KEY, 'true');
  incrementConsultGateCount(engagement);
  return toHookJson(hookEventName, CONSULT_GATE_CONTEXT);
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
  // A payload carrying agent_id is a subagent's tool call and is attributed to
  // that subagent's own session, never the parent's timeline (AD-9).
  const sessionId = resolveSessionId(store, cwd, options, agentIdentity(payload));
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
      try {
        configureEngagementPath(cwd);
        writeEngagement(AGENT_USED_KEY, 'true');
      } catch {
        // Marker is advisory; capture already succeeded.
      }
    }
  }
}

function truncateSuggestion(text: string, maxChars = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars
    ? collapsed
    : `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Stop-hook nudge, conditional: only blocks the turn end when this turn used a
 * subagent AND suggest-notes has concrete high-confidence candidates to show.
 * Silence is the default. Disable entirely with CORTEX_STOP_NUDGE=off.
 */
function endOfTurn(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): string {
  if (payload['stop_hook_active'] === true) {
    return '';
  }

  // Replay this turn's spooled capture first so suggestions see fresh evidence.
  try {
    flushSpool(store, cwd, resolveSessionId(store, cwd, options));
  } catch {
    // Spool replay is best-effort at turn end; next flush picks it up.
  }

  if (process.env['CORTEX_STOP_NUDGE'] === 'off') {
    return '';
  }

  configureEngagementPath(cwd);
  const engagement = readEngagement();
  const agentUsed =
    engagement[AGENT_USED_KEY] === 'true' || payload['agent_used'] === true;
  if (!agentUsed) {
    return '';
  }
  writeEngagement(AGENT_USED_KEY, 'false');

  let suggestions;
  try {
    const sessionId = resolveSessionId(store, cwd, options);
    // The nudge fires only when a subagent ran, and a subagent's evidence lives
    // in its own session — so collecting from the primary alone would blind it
    // in exactly the case it exists for. Walk the whole tree and dedupe.
    const seen = new Set<string>();
    suggestions = store
      .getSessionTreeIds(sessionId)
      .flatMap(id => suggestNotes(store, id))
      .filter(suggestion => suggestion.confidence >= STOP_NUDGE_CONFIDENCE_THRESHOLD)
      .filter(suggestion => {
        const key = `${suggestion.kind} ${suggestion.content}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  } catch {
    return '';
  }

  if (suggestions.length === 0) {
    return '';
  }

  const shown = suggestions
    .slice(0, 3)
    .map(suggestion => `- ${suggestion.kind}: ${truncateSuggestion(suggestion.content)}`);
  const reason = [
    'Cortex found candidate notes from this turn:',
    ...shown,
    'Write the load-bearing ones with cortex_note(kind, content); if none apply, reply DONE.',
  ].join('\n');

  return JSON.stringify({ decision: 'block', reason });
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
    const gate = renderConsultGate(store, cwd, 'UserPromptSubmit', promptGateReason(prompt));
    if (gate) {
      return gate;
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

  if (action === 'end-of-turn') {
    return endOfTurn(store, payload, cwd, options);
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
