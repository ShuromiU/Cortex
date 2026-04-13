import type {
  CortexStore,
  ParsedMemoryItem,
  SearchMemoryItemResult,
} from '../db/store.js';
import { deriveProjectScopeKey } from '../scope/keys.js';
import { getPreferredScope, type PreferredScope } from './scope.js';

const TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gi;

const KIND_BONUS: Record<string, number> = {
  'note:decision': 3.4,
  'note:intent': 3.0,
  'note:blocker': 2.6,
  'note:focus': 2.8,
  'episode:command_failure': 3.2,
  'episode:test_cycle': 2.8,
  branch_snapshot: 2.4,
  'note:insight': 2.0,
  project_snapshot: 1.8,
  'episode:session_summary': 1.6,
  command_run: 1.2,
};

const STATE_BONUS: Record<string, number> = {
  pinned: 3.0,
  hot: 2.2,
  warm: 1.2,
  cold: 0.2,
  archived: -3.0,
};

export interface RetrievedMemoryItem extends ParsedMemoryItem {
  retrieval_score: number;
  lexical_score: number;
  scope_bonus: number;
  kind_bonus: number;
  recency_bonus: number;
  hotness_bonus: number;
  access_bonus: number;
  token_hits: number;
  exact_phrase: boolean;
  fts_rank: number | null;
}

export interface RetrievalContext {
  preferredScope: PreferredScope | undefined;
  projectScopeKey: string | undefined;
  focus: string | null;
  topic: string;
  lowerTopic: string;
  tokens: string[];
  queryText: string | null;
}

export interface RetrievalResult {
  context: RetrievalContext;
  candidates: RetrievedMemoryItem[];
  results: RetrievedMemoryItem[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function tokenizeTopic(topic: string): string[] {
  const matches = topic.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return Array.from(new Set(matches)).slice(0, 8);
}

function buildFtsQuery(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }

  return tokens.map(token => `"${token}"`).join(' OR ');
}

function resolveProjectScopeKey(store: CortexStore, preferredScope: PreferredScope | undefined): string | undefined {
  const basePath = preferredScope?.session.worktree_path ?? store.getMeta('root_path');
  return basePath ? deriveProjectScopeKey(basePath) : 'project:default';
}

function countTokenHits(text: string, tokens: string[]): number {
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      hits++;
    }
  }
  return hits;
}

function scopeBonus(
  item: ParsedMemoryItem,
  preferredScope: PreferredScope | undefined,
  projectScopeKey: string | undefined,
): number {
  if (!preferredScope) {
    return 0;
  }

  if (preferredScope.scopeKey && item.scope_key === preferredScope.scopeKey) {
    return 6;
  }

  if (projectScopeKey && item.scope_key === projectScopeKey) {
    return preferredScope.scopeType === 'project' ? 4 : 2;
  }

  if (preferredScope.scopeType !== 'project') {
    return -1.5;
  }

  return 0;
}

function kindBonus(kind: string): number {
  return KIND_BONUS[kind] ?? 1;
}

function hotnessBonus(item: ParsedMemoryItem): number {
  return STATE_BONUS[item.state] ?? 0;
}

function recencyBonus(createdAt: string): number {
  const ageMs = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs)) {
    return 0;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) {
    return 2.2;
  }
  if (ageDays <= 7) {
    return 1.4;
  }
  if (ageDays <= 30) {
    return 0.8;
  }
  return 0.2;
}

function ftsBonus(rank: number | null): number {
  if (rank === null || !Number.isFinite(rank)) {
    return 0;
  }

  return Math.max(0, 3 - Math.log10(Math.abs(rank) + 1) * 2);
}

function lexicalScore(
  item: ParsedMemoryItem,
  lowerTopic: string,
  tokens: string[],
  focus: string | null,
): {
  lexicalScore: number;
  tokenHits: number;
  exactPhrase: boolean;
} {
  const lowerSubject = item.subject?.toLowerCase() ?? '';
  const lowerText = item.text.toLowerCase();
  const combined = `${lowerSubject}\n${lowerText}`;
  const tokenHits = countTokenHits(combined, tokens);
  const exactPhrase = lowerTopic.length > 0 && combined.includes(lowerTopic);
  const subjectHits = countTokenHits(lowerSubject, tokens);
  const focusHit = focus ? combined.includes(focus.toLowerCase()) : false;
  const coverage = tokens.length > 0 ? tokenHits / tokens.length : 0;

  let score = coverage * 12;
  score += subjectHits * 3;
  if (exactPhrase) {
    score += 4;
  }
  if (focusHit) {
    score += 1.5;
  }

  return { lexicalScore: score, tokenHits, exactPhrase };
}

function rerankCandidate(
  item: SearchMemoryItemResult | ParsedMemoryItem,
  context: RetrievalContext,
): RetrievedMemoryItem {
  const parsed: ParsedMemoryItem = 'fts_rank' in item ? item : item;
  const { lexicalScore: textScore, tokenHits, exactPhrase } = lexicalScore(
    parsed,
    context.lowerTopic,
    context.tokens,
    context.focus,
  );
  const scope = scopeBonus(parsed, context.preferredScope, context.projectScopeKey);
  const kind = kindBonus(parsed.kind);
  const recency = recencyBonus(parsed.created_at);
  const hotness = hotnessBonus(parsed);
  const access = Math.min(parsed.access_count * 0.15, 1.5);
  const score =
    textScore +
    scope +
    kind +
    recency +
    hotness +
    access +
    parsed.importance * 3 +
    ftsBonus('fts_rank' in item ? item.fts_rank : null);

  return {
    ...parsed,
    retrieval_score: score,
    lexical_score: textScore,
    scope_bonus: scope,
    kind_bonus: kind,
    recency_bonus: recency,
    hotness_bonus: hotness,
    access_bonus: access,
    token_hits: tokenHits,
    exact_phrase: exactPhrase,
    fts_rank: 'fts_rank' in item ? item.fts_rank : null,
  };
}

function dedupeResults(results: RetrievedMemoryItem[]): RetrievedMemoryItem[] {
  const seen = new Set<string>();
  const deduped: RetrievedMemoryItem[] = [];

  for (const item of results) {
    const key = `${item.kind}\u0000${item.subject ?? ''}\u0000${item.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export function buildRetrievalContext(
  store: CortexStore,
  topic: string,
): RetrievalContext {
  const preferredScope = getPreferredScope(store);
  const lowerTopic = topic.trim().toLowerCase();
  const tokens = tokenizeTopic(lowerTopic);

  return {
    preferredScope,
    projectScopeKey: resolveProjectScopeKey(store, preferredScope),
    focus: preferredScope?.session.focus ?? null,
    topic,
    lowerTopic,
    tokens,
    queryText: buildFtsQuery(tokens),
  };
}

export function retrieveMemory(
  store: CortexStore,
  topic: string,
  limit = 8,
): RetrievalResult {
  const context = buildRetrievalContext(store, topic);
  let candidates: RetrievedMemoryItem[] = [];

  if (context.queryText) {
    candidates = store
      .searchMemoryItems(context.queryText, Math.max(limit * 5, 20))
      .map(item => rerankCandidate(item, context));
  }

  if (candidates.length === 0) {
    const fallbacks = store.listRecentMemoryItems(Math.max(limit * 4, 16));
    const filtered = fallbacks.filter(item => {
      if (context.tokens.length === 0) {
        return true;
      }

      const combined = `${item.subject ?? ''}\n${item.text}`.toLowerCase();
      return context.tokens.some(token => combined.includes(token));
    });
    candidates = filtered.map(item => rerankCandidate(item, context));
  }

  candidates.sort((left, right) => {
    if (right.retrieval_score !== left.retrieval_score) {
      return right.retrieval_score - left.retrieval_score;
    }
    if (right.importance !== left.importance) {
      return right.importance - left.importance;
    }
    return right.created_at.localeCompare(left.created_at);
  });

  const results = dedupeResults(candidates).slice(0, limit);
  return { context, candidates, results };
}

export function logRetrieval(
  store: CortexStore,
  retrieval: RetrievalResult,
  rendered: string,
): void {
  const sessionId = retrieval.context.preferredScope?.session.id ?? null;
  if (retrieval.results.length > 0) {
    store.touchMemoryItems(retrieval.results.map(item => item.id));
  }

  store.insertRetrievalLog({
    sessionId,
    topic: retrieval.context.topic,
    queryText: retrieval.context.queryText,
    resultIds: retrieval.results.map(item => item.id),
    totalCandidates: retrieval.candidates.length,
    returnedCount: retrieval.results.length,
    tokenEstimate: estimateTokens(rendered),
  });
}
