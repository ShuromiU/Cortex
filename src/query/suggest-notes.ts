import { CortexStore } from '../db/store.js';

export type SuggestedNoteKind =
  | 'insight'
  | 'decision'
  | 'intent'
  | 'blocker'
  | 'focus';

export interface SuggestedNote {
  kind: SuggestedNoteKind;
  subject?: string;
  content: string;
  confidence: number;
  evidence: string[];
}

interface EvidenceItem {
  source: string;
  text: string;
  evidence?: string[];
}

const DECISION_RE =
  /\b(decided|decision|we'll use|use|using|chose|chosen|picked|settled on)\b/i;
const BLOCKER_RE =
  /\b(blocked|blocker|blocking|stuck|failed|failure|cannot|can't|unable|missing|error)\b/i;
const INTENT_RE =
  /\b(next|plan|planned|todo|to-do|follow-?up|later|need to|will|going to)\b/i;
const ROUTINE_RE =
  /\b(pass(?:ed|ing)?|success(?:ful)?|done|completed|progress|read|looked at|inspected)\b/i;

export function suggestNotes(
  store: CortexStore,
  sessionId?: string,
): SuggestedNote[] {
  const resolvedSessionId = sessionId ?? store.getCurrentSession()?.id;
  if (!resolvedSessionId) return [];

  const candidates: SuggestedNote[] = [];

  for (const item of collectEvidence(store, resolvedSessionId)) {
    const normalized = normalizeWhitespace(item.text);
    if (!normalized) continue;
    const snippets =
      item.evidence?.map(text => evidenceSnippet(item.source, text)) ?? [
        evidenceSnippet(item.source, normalized),
      ];

    if (DECISION_RE.test(normalized)) {
      candidates.push(
        buildSuggestion('decision', normalized, 0.82, snippets),
      );
      continue;
    }

    if (BLOCKER_RE.test(normalized)) {
      candidates.push(
        buildSuggestion('blocker', normalized, 0.8, snippets),
      );
      continue;
    }

    if (INTENT_RE.test(normalized)) {
      candidates.push(
        buildSuggestion('intent', normalized, 0.72, snippets),
      );
    }
  }

  return dedupeSuggestions(candidates).filter(suggestion => {
    if (suggestion.evidence.length === 0) return false;
    if (suggestion.confidence < 0.6) return false;
    return !isRoutineNoise(suggestion.content);
  });
}

function collectEvidence(
  store: CortexStore,
  sessionId: string,
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  for (const episode of store.getEpisodesBySession(sessionId)) {
    evidence.push({
      source: `episode:${episode.kind}`,
      text: episode.summary,
    });
  }

  for (const event of store.getEventsBySession(sessionId)) {
    const text = eventText(event.type, event.target, event.metadata);
    if (text) {
      evidence.push({
        source: `event:${event.type}`,
        text,
      });
    }
  }

  for (const run of store.getCommandRunsBySession(sessionId)) {
    if (run.exit_code !== null && run.exit_code !== 0) {
      const parts = [
        run.command_summary,
        run.stderr_tail,
        run.stdout_tail,
      ].filter(isNonEmptyString);
      evidence.push({
        source: `command:${run.category ?? 'run'}`,
        text: parts.join(' '),
        evidence: parts,
      });
    }
  }

  return evidence;
}

function eventText(
  type: string,
  target: string | null,
  metadata: Record<string, unknown>,
): string {
  const textParts = [
    metadata.description,
    metadata.summary,
    metadata.message,
    metadata.text,
    metadata.error,
    metadata.stderr,
    metadata.stdout,
    metadata.command,
  ].filter(isNonEmptyString);

  if (textParts.length > 0) return textParts.join(' ');
  if (target && !isRoutineEventType(type)) return `${type} ${target}`;
  return '';
}

function buildSuggestion(
  kind: SuggestedNoteKind,
  rawContent: string,
  confidence: number,
  evidence: string[],
): SuggestedNote {
  const content = cleanContent(rawContent);
  const suggestion: SuggestedNote = {
    kind,
    content,
    confidence,
    evidence,
  };

  const subject = inferSubject(content);
  if (kind !== 'insight' || subject) {
    suggestion.subject = subject ?? kind;
  }

  return suggestion;
}

function cleanContent(content: string): string {
  return normalizeWhitespace(
    content
      .replace(/^(decided|decision|next|plan|todo|to-do|follow-?up)\s*[:,-]?\s*/i, '')
      .replace(/^we'll\s+/i, '')
      .replace(/^will\s+/i, ''),
  );
}

function inferSubject(content: string): string | undefined {
  const lower = content.toLowerCase();
  const match = lower.match(
    /\b(?:use|using|chose|chosen|picked|settled on|wire|into|for|about|on)\s+([a-z0-9_.@/-]+)/i,
  );
  if (match?.[1]) return match[1].replace(/[.,:;)]$/, '');

  const words = normalizeWhitespace(content)
    .split(/\s+/)
    .map(word => word.replace(/^[^a-z0-9_@/-]+|[^a-z0-9_.@/-]+$/gi, ''))
    .filter(word => word.length > 2 && !isStopWord(word.toLowerCase()));

  return words[0]?.toLowerCase();
}

function dedupeSuggestions(suggestions: SuggestedNote[]): SuggestedNote[] {
  const seen = new Set<string>();
  const deduped: SuggestedNote[] = [];

  for (const suggestion of suggestions) {
    const key = `${suggestion.kind}:${suggestion.content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(suggestion);
  }

  return deduped;
}

function isRoutineNoise(content: string): boolean {
  return (
    ROUTINE_RE.test(content) &&
    !DECISION_RE.test(content) &&
    !BLOCKER_RE.test(content) &&
    !INTENT_RE.test(content)
  );
}

function isRoutineEventType(type: string): boolean {
  return ['read', 'edit', 'write', 'cmd', 'agent'].includes(type);
}

function evidenceSnippet(source: string, text: string): string {
  return `${source}: ${truncate(text, 180)}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStopWord(word: string): boolean {
  return [
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'into',
    'after',
    'before',
    'query',
  ].includes(word);
}
