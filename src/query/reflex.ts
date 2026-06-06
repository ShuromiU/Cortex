import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CortexStore } from '../db/store.js';
import { renderMemoryLine } from './render.js';
import { estimateTokens, logRetrieval, retrieveMemory } from './retrieval.js';

export type ReflexEvent = 'prompt' | 'edit' | 'cmd' | 'agent';

export interface ReflexOptions {
  event: ReflexEvent;
  prompt?: string;
  file?: string;
  cmd?: string;
  desc?: string;
  sessionId?: string;
  stateDir?: string;
}

interface ReflexState {
  lastFocusKey?: string;
  surfacedByFocus?: Record<string, string[]>;
}

const LOAD_BEARING_KINDS = new Set([
  'note:decision',
  'note:blocker',
  'note:insight',
  'episode:command_failure',
]);

const ACTIVE_REFLEX_STATES = new Set(['pinned', 'hot', 'warm']);
const HIGH_CONFIDENCE_SCORE = 9;
const MAX_CONTEXT_CHARS = 460;

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePath(value: string): string {
  return normalizeText(value).replace(/\\/g, '/');
}

function buildAnchor(options: ReflexOptions): string {
  switch (options.event) {
    case 'prompt':
      return options.prompt ?? '';
    case 'edit':
      return options.file ?? '';
    case 'cmd':
      return options.cmd ?? '';
    case 'agent':
      return options.desc ?? '';
  }
}

function hookEventName(event: ReflexEvent): string {
  return event === 'prompt' ? 'UserPromptSubmit' : 'PreToolUse';
}

function statePath(options: ReflexOptions): string {
  const sessionKey = sanitizeKey(options.sessionId ?? 'session');
  return path.join(options.stateDir ?? os.tmpdir(), `cortex-reflex-${sessionKey}.json`);
}

function readState(options: ReflexOptions): ReflexState {
  try {
    const raw = fs.readFileSync(statePath(options), 'utf8');
    return JSON.parse(raw) as ReflexState;
  } catch {
    return {};
  }
}

function writeState(options: ReflexOptions, state: ReflexState): void {
  try {
    fs.mkdirSync(path.dirname(statePath(options)), { recursive: true });
    fs.writeFileSync(statePath(options), `${JSON.stringify(state)}\n`);
  } catch {
    // Hook context should never fail because the dedup marker could not be written.
  }
}

function anchorAppearsInItem(event: ReflexEvent, anchor: string, itemText: string): boolean {
  if (event === 'edit') {
    return itemText.includes(normalizePath(anchor));
  }

  if (event === 'cmd') {
    return itemText.includes(normalizeText(anchor));
  }

  return true;
}


function renderAdditionalContext(line: string): string {
  const context = `Cortex memory: ${line}`;
  if (context.length <= MAX_CONTEXT_CHARS) {
    return context;
  }

  return `${context.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

function toHookJson(event: ReflexEvent, additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEventName(event),
      additionalContext,
    },
  });
}

export function reflectMemory(store: CortexStore, options: ReflexOptions): string {
  if (options.event === 'prompt') {
    return '';
  }

  const anchor = buildAnchor(options);
  const normalizedAnchor = options.event === 'edit'
    ? normalizePath(anchor)
    : normalizeText(anchor);

  if (normalizedAnchor.length === 0) {
    return '';
  }

  const focusKey = `${options.event}:${normalizedAnchor}`;
  const state = readState(options);
  if (state.lastFocusKey === focusKey) {
    return '';
  }

  const retrieval = retrieveMemory(store, anchor, 6);
  const candidate = retrieval.results.find(item => {
    if (!ACTIVE_REFLEX_STATES.has(item.state)) {
      return false;
    }
    if (!LOAD_BEARING_KINDS.has(item.kind)) {
      return false;
    }
    if (item.retrieval_score < HIGH_CONFIDENCE_SCORE) {
      return false;
    }
    if (retrieval.context.preferredScope && item.scope_bonus < 2) {
      return false;
    }

    const itemText = `${item.subject ?? ''}\n${item.text}`.toLowerCase().replace(/\\/g, '/');
    return anchorAppearsInItem(options.event, normalizedAnchor, itemText);
  });

  state.lastFocusKey = focusKey;

  if (!candidate) {
    writeState(options, state);
    return '';
  }

  const surfacedByFocus = state.surfacedByFocus ?? {};
  const surfacedIds = surfacedByFocus[focusKey] ?? [];
  if (surfacedIds.includes(candidate.id)) {
    state.surfacedByFocus = surfacedByFocus;
    writeState(options, state);
    return '';
  }

  surfacedByFocus[focusKey] = [...surfacedIds, candidate.id];
  state.surfacedByFocus = surfacedByFocus;

  const additionalContext = renderAdditionalContext(renderMemoryLine(candidate, 3));
  logRetrieval(store, retrieval, additionalContext);
  if (options.sessionId) {
    store.insertLedgerEntry({
      sessionId: options.sessionId,
      type: 'reflex',
      direction: 'spent',
      tokens: estimateTokens(additionalContext),
    });
  }
  writeState(options, state);
  return toHookJson(options.event, additionalContext);
}
