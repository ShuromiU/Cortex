import type { CortexStore } from '../db/store.js';
import { selectWorkingMemoryItems, type ScoredMemoryItem } from '../memory/hotness.js';
import { ReferenceValidator } from './reference-validation.js';
import { getPreferredScope } from './scope.js';
import {
  resolveProjectScopeKey,
  resolveWorkingScopeKeys,
} from './state.js';
import { CONTESTED_MARKER, formatAgeLabel, isContested } from './render.js';
import { estimateTokens } from './retrieval.js';

export interface SessionBriefOptions {
  /** Estimated-token cap for the whole brief (default 150). */
  budget?: number;
}

export const DEFAULT_SESSION_BRIEF_BUDGET = 150;

const BRIEF_NOTE_KINDS = new Set(['note:decision', 'note:blocker', 'note:intent']);
const BRIEF_STATES = new Set(['pinned', 'hot', 'warm']);
const RESUME_MAX_AGE_DAYS = 7;
const MAX_BRIEF_ITEMS = 3;

function truncateLine(text: string, maxChars = 110): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function noteContent(item: ScoredMemoryItem): string {
  const firstLine = item.text.split('\n')[0] ?? '';
  return firstLine.includes(': ')
    ? firstLine.slice(firstLine.indexOf(': ') + 2)
    : firstLine;
}

function resumeLineFrom(items: ScoredMemoryItem[]): string | null {
  const summaries = items
    .filter(item => item.kind === 'episode:session_summary')
    .filter(item => {
      const ageMs = Date.now() - Date.parse(item.created_at);
      return Number.isFinite(ageMs) && ageMs <= RESUME_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  const newest = summaries[0];
  if (!newest) {
    return null;
  }

  const firstLine = newest.text
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(line => line.length > 0 && !/^Command \(/.test(line));
  if (!firstLine) {
    return null;
  }

  return `- resume: ${truncateLine(firstLine)}`;
}

/**
 * The pull channel: a tiny, validated, branch-scoped memory brief injected at
 * SessionStart. Lead with proof of value, never with a demand. Emits an empty
 * string when nothing qualifies so cold starts cost zero tokens.
 */
export function buildSessionBrief(
  store: CortexStore,
  options: SessionBriefOptions = {},
): string {
  const budget = options.budget ?? DEFAULT_SESSION_BRIEF_BUDGET;
  const scopeKeys = resolveWorkingScopeKeys(store);
  if (scopeKeys.length === 0) {
    return '';
  }

  const preferredScope = getPreferredScope(store);
  const selection = selectWorkingMemoryItems(
    store,
    scopeKeys,
    preferredScope?.scopeKey ?? resolveProjectScopeKey(store),
    24,
  );

  const validator = new ReferenceValidator(store);
  const bullets: string[] = [];
  for (const item of selection) {
    if (bullets.length >= MAX_BRIEF_ITEMS) {
      break;
    }
    if (!BRIEF_NOTE_KINDS.has(item.kind) || !BRIEF_STATES.has(item.state)) {
      continue;
    }

    const validation = validator.validate(item);
    const locatable = validation.exists + validation.moved;
    if (validation.references.length > 0 && locatable === 0) {
      // Every referenced file is gone: not trustworthy enough for the brief.
      continue;
    }

    let refSuffix = '';
    if (validation.missing > 0) {
      refSuffix = ` (refs: ${validation.missing} missing)`;
    } else if (validation.moved > 0) {
      refSuffix = ' (refs moved)';
    }

    const kindLabel = item.kind.slice('note:'.length);
    const age = formatAgeLabel(item.created_at);
    const agePart = age ? `[${age}] ` : '';
    const subjectPart = item.subject ? `[${item.subject}] ` : '';
    // This channel prints unprompted on every SessionStart and selects
    // note:decision in state warm — exactly an active contested decision — so
    // an unmarked side of an open contest is presented as settled memory
    // before the agent has asked anything. Same reason reflex carries it.
    const contested = isContested(item) ? CONTESTED_MARKER : '';
    bullets.push(
      `- ${agePart}${kindLabel}: ${subjectPart}${truncateLine(noteContent(item))}${contested}${refSuffix}`,
    );
  }
  validator.flush();

  const resume = resumeLineFrom(selection);
  if (bullets.length === 0 && !resume) {
    return '';
  }

  const scopeLabel =
    preferredScope && preferredScope.scopeType !== 'project'
      ? preferredScope.scopeLabel
      : 'project';
  const header = `Cortex memory (${scopeLabel}):`;
  const footer = 'More: cortex_recall(topic).';

  const lines = [header, ...bullets];
  if (resume) {
    lines.push(resume);
  }
  lines.push(footer);

  // Enforce the budget by dropping bullets from the bottom (header/footer stay).
  while (lines.length > 2 && estimateTokens(lines.join('\n')) > budget) {
    const removableIndex = lines.length - 2;
    lines.splice(removableIndex, 1);
  }

  if (lines.length <= 2) {
    return '';
  }

  return lines.join('\n');
}
