import type {
  CortexStore,
  ParsedMemoryItem,
  SearchMemoryItemResult,
  SemanticMemoryItemResult,
} from '../db/store.js';
import { deriveProjectScopeKey } from '../scope/keys.js';
import { getPreferredScope, type PreferredScope } from './scope.js';
import {
  referenceValidationScore,
  validateMemoryReferences,
  type MemoryReferenceValidation,
} from './reference-validation.js';

const TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gi;
const TOKEN_SPLIT_PATTERN = /[._/-]+/g;
const LOW_SIGNAL_TOKENS = new Set([
  'a',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'continue',
  'could',
  'did',
  'do',
  'does',
  'fix',
  'fixed',
  'fixes',
  'fixing',
  'for',
  'from',
  'has',
  'have',
  'implement',
  'implemented',
  'implementation',
  'in',
  'is',
  'it',
  'just',
  'latest',
  'now',
  'of',
  'old',
  'on',
  'or',
  'plan',
  'please',
  'recent',
  'resolved',
  'should',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'when',
  'will',
  'with',
  'without',
  'work',
  'would',
]);

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
  semantic_score: number | null;
  semantic_rank_applied: boolean;
  reference_validation: MemoryReferenceValidation;
  current_truth_bonus: number;
  temporal_bonus: number;
  scope_bonus: number;
  kind_bonus: number;
  recency_bonus: number;
  hotness_bonus: number;
  access_bonus: number;
  token_hits: number;
  exact_phrase: boolean;
  fts_rank: number | null;
}

export type SemanticMode = 'off' | 'shadow' | 'rank';

export interface SemanticProvider {
  embeddingModel: string;
  embed(topic: string): number[] | null;
}

export interface RetrieveMemoryOptions {
  semanticMode?: SemanticMode;
  semanticProvider?: SemanticProvider;
  semanticRankThreshold?: number;
}

export interface RetrievalContext {
  preferredScope: PreferredScope | undefined;
  projectScopeKey: string | undefined;
  focus: string | null;
  topic: string;
  lowerTopic: string;
  tokens: string[];
  queryText: string | null;
  temporalIntent: TemporalIntent;
}

export interface RetrievalResult {
  context: RetrievalContext;
  candidates: RetrievedMemoryItem[];
  semanticCandidates: RetrievedMemoryItem[];
  results: RetrievedMemoryItem[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TemporalIntent {
  preferRecent: boolean;
  preferOld: boolean;
  preferResolved: boolean;
}

function tokenizeTopic(topic: string): string[] {
  const matches = topic.toLowerCase().match(TOKEN_PATTERN) ?? [];
  const tokens = matches.flatMap(match => match.split(TOKEN_SPLIT_PATTERN));
  return Array.from(new Set(tokens.filter(token => token.length > 1 && !LOW_SIGNAL_TOKENS.has(token)))).slice(0, 8);
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

function ageDays(createdAt: string): number | null {
  const ageMs = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs)) {
    return null;
  }

  return Math.max(0, ageMs / (1000 * 60 * 60 * 24));
}

function deriveTemporalIntent(lowerTopic: string): TemporalIntent {
  const words = new Set(lowerTopic.match(TOKEN_PATTERN) ?? []);
  return {
    preferRecent: ['latest', 'current', 'recent', 'newest', 'now'].some(word => words.has(word)),
    preferOld: ['old', 'older', 'oldest', 'previous', 'prior', 'history', 'historical'].some(word => words.has(word)),
    preferResolved: ['resolved', 'fixed', 'closed', 'done'].some(word => words.has(word)),
  };
}

function temporalBonus(item: ParsedMemoryItem, intent: TemporalIntent): number {
  let bonus = 0;
  const days = ageDays(item.created_at);

  if (days !== null) {
    if (intent.preferRecent) {
      bonus += Math.max(0, 5 - Math.log1p(days) * 0.9);
    }
    if (intent.preferOld) {
      bonus += Math.min(5, Math.log1p(days) * 0.9);
    }
  }

  if (intent.preferResolved) {
    bonus += item.text.toLowerCase().includes('status: resolved') ? 8 : -2;
  }

  return bonus;
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
  store: CortexStore,
  item: SearchMemoryItemResult | ParsedMemoryItem,
  context: RetrievalContext,
  semanticScore: number | null = null,
  semanticRankApplied = false,
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
  const temporal = temporalBonus(parsed, context.temporalIntent);
  const hotness = hotnessBonus(parsed);
  const access = Math.min(parsed.access_count * 0.15, 1.5);
  const referenceValidation = validateMemoryReferences(store, parsed);
  const currentTruth = referenceValidationScore(
    referenceValidation,
    context.temporalIntent.preferOld,
  );
  const score =
    textScore +
    scope +
    kind +
    recency +
    temporal +
    hotness +
    access +
    currentTruth +
    parsed.importance * 3 +
    ftsBonus('fts_rank' in item ? item.fts_rank : null) +
    (semanticRankApplied && semanticScore !== null ? semanticScore * 30 : 0);

  return {
    ...parsed,
    retrieval_score: score,
    lexical_score: textScore,
    semantic_score: semanticScore,
    semantic_rank_applied: semanticRankApplied,
    reference_validation: referenceValidation,
    current_truth_bonus: currentTruth,
    temporal_bonus: temporal,
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

function semanticModeFromEnv(): SemanticMode {
  const raw = process.env.CORTEX_SEMANTIC_MODE;
  if (raw === 'shadow' || raw === 'rank') {
    return raw;
  }
  return 'off';
}

function resolveSemanticMode(options: RetrieveMemoryOptions | undefined): SemanticMode {
  return options?.semanticMode ?? semanticModeFromEnv();
}

function retrieveSemanticCandidates(
  store: CortexStore,
  context: RetrievalContext,
  limit: number,
  options: RetrieveMemoryOptions | undefined,
): SemanticMemoryItemResult[] {
  const mode = resolveSemanticMode(options);
  if (mode === 'off' || !options?.semanticProvider) {
    return [];
  }

  const embedding = options.semanticProvider.embed(context.topic);
  if (!embedding || embedding.length === 0) {
    return [];
  }

  return store.searchMemoryItemSemantics(
    embedding,
    Math.max(limit * 5, 20),
    options.semanticProvider.embeddingModel,
  );
}

function mergeRankedSemanticCandidates(
  store: CortexStore,
  lexicalCandidates: RetrievedMemoryItem[],
  semanticCandidates: SemanticMemoryItemResult[],
  context: RetrievalContext,
  threshold: number,
): RetrievedMemoryItem[] {
  const byId = new Map<string, RetrievedMemoryItem>();
  for (const candidate of lexicalCandidates) {
    byId.set(candidate.id, candidate);
  }

  for (const semantic of semanticCandidates) {
    if (semantic.semantic_score < threshold) {
      continue;
    }

    const existing = byId.get(semantic.id);
    byId.set(
      semantic.id,
      rerankCandidate(store, existing ?? semantic, context, semantic.semantic_score, true),
    );
  }

  return Array.from(byId.values());
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
    temporalIntent: deriveTemporalIntent(lowerTopic),
  };
}

export function retrieveMemory(
  store: CortexStore,
  topic: string,
  limit = 8,
  options?: RetrieveMemoryOptions,
): RetrievalResult {
  const context = buildRetrievalContext(store, topic);
  let candidates: RetrievedMemoryItem[] = [];

  if (context.queryText) {
    candidates = store
      .searchMemoryItems(context.queryText, Math.max(limit * 5, 20))
      .map(item => rerankCandidate(store, item, context));
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
    candidates = filtered.map(item => rerankCandidate(store, item, context));
  }

  const semanticMatches = retrieveSemanticCandidates(store, context, limit, options);
  const semanticCandidates = semanticMatches.map(item =>
    rerankCandidate(store, item, context, item.semantic_score, false),
  );
  if (resolveSemanticMode(options) === 'rank') {
    candidates = mergeRankedSemanticCandidates(
      store,
      candidates,
      semanticMatches,
      context,
      options?.semanticRankThreshold ?? 0.86,
    );
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
  return { context, candidates, semanticCandidates, results };
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
