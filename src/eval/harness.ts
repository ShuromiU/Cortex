import type { CortexStore, TableCounts } from '../db/store.js';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore as Store } from '../db/store.js';
import { buildHeader, buildFullState } from '../query/state.js';
import { recall } from '../query/recall.js';
import { retrieveMemory, type RetrievedMemoryItem } from '../query/retrieval.js';

export interface TextMetric {
  chars: number;
  est_tokens: number;
  preview: string;
}

export interface TopicEvaluation {
  topic: string;
  output: TextMetric;
}

export interface QualityFixture {
  topic: string;
  expected_top: string;
  allowed?: string[];
  forbidden?: string[];
  max_output_tokens?: number;
  fresh_after?: string;
}

export interface QualityScoreBreakdown {
  id: string;
  subject: string | null;
  text_preview: string;
    scores: {
      retrieval_score: number;
      lexical_score: number;
      temporal_bonus: number;
      scope_bonus: number;
    kind_bonus: number;
    recency_bonus: number;
    hotness_bonus: number;
    access_bonus: number;
    token_hits: number;
    exact_phrase: boolean;
    fts_rank: number | null;
  };
}

export interface QualityFixtureEvaluation {
  topic: string;
  expected_top: string;
  top_result_id: string | null;
  top1_hit: boolean;
  recall_at_3: number;
  noise_count: number;
  stale_count: number;
  output: TextMetric;
  token_budget: {
    max_tokens: number | null;
    actual_tokens: number;
    passed: boolean;
  };
  score_breakdown: QualityScoreBreakdown[];
  passed: boolean;
}

export interface QualityEvaluation {
  fixtures: QualityFixtureEvaluation[];
  top1_hit: number;
  recall_at_3: number;
  noise_count: number;
  stale_count: number;
  output_tokens: number;
}

export interface QualityComparison {
  top1_hit_delta: number;
  recall_at_3_delta: number;
  noise_count_delta: number;
  stale_count_delta: number;
  output_tokens_delta: number;
}

export interface EvaluationOptions {
  fixtures?: QualityFixture[];
  compareTo?: EvaluationResult;
}

export interface EvaluationResult {
  db_path?: string;
  generated_at: string;
  schema_version: number;
  tables: TableCounts;
  header: TextMetric;
  full_state: TextMetric;
  topics: TopicEvaluation[];
  quality?: QualityEvaluation;
  quality_comparison?: QualityComparison;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildTextMetric(text: string, previewLength = 320): TextMetric {
  return {
    chars: text.length,
    est_tokens: estimateTokens(text),
    preview: text.slice(0, previewLength),
  };
}

function deriveTopics(store: CortexStore, requestedTopics: string[]): string[] {
  const cleaned = requestedTopics
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
  if (cleaned.length > 0) {
    return Array.from(new Set(cleaned));
  }

  const derived: string[] = [];
  const current = store.getCurrentSession();
  if (current?.focus) {
    derived.push(current.focus);
  }

  for (const session of store.getRecentSessions(5)) {
    if (session.focus) {
      derived.push(session.focus);
    }
  }

  for (const note of store.getActiveNotes()) {
    if (note.subject) {
      derived.push(note.subject);
    }
    if (derived.length >= 8) {
      break;
    }
  }

  return Array.from(new Set(derived.filter(topic => topic.length > 0))).slice(0, 5);
}

function matchesFixtureRef(item: RetrievedMemoryItem, ref: string): boolean {
  const normalized = ref.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return (
    item.id.toLowerCase() === normalized ||
    item.source_id?.toLowerCase() === normalized ||
    item.subject?.toLowerCase() === normalized ||
    item.text.toLowerCase().includes(normalized)
  );
}

function countMatchingRefs(items: RetrievedMemoryItem[], refs: string[]): number {
  return refs.filter(ref => items.some(item => matchesFixtureRef(item, ref))).length;
}

function buildScoreBreakdown(item: RetrievedMemoryItem): QualityScoreBreakdown {
  return {
    id: item.id,
    subject: item.subject,
    text_preview: item.text.slice(0, 160),
    scores: {
      retrieval_score: item.retrieval_score,
      lexical_score: item.lexical_score,
      temporal_bonus: item.temporal_bonus,
      scope_bonus: item.scope_bonus,
      kind_bonus: item.kind_bonus,
      recency_bonus: item.recency_bonus,
      hotness_bonus: item.hotness_bonus,
      access_bonus: item.access_bonus,
      token_hits: item.token_hits,
      exact_phrase: item.exact_phrase,
      fts_rank: item.fts_rank,
    },
  };
}

function evaluateQualityFixture(
  store: CortexStore,
  fixture: QualityFixture,
): QualityFixtureEvaluation {
  const retrieval = retrieveMemory(store, fixture.topic, 8);
  const top3 = retrieval.results.slice(0, 3);
  const topResult = retrieval.results[0] ?? null;
  const output = buildTextMetric(recall(store, fixture.topic));
  const allowed = fixture.allowed ?? [];
  const forbidden = fixture.forbidden ?? [];
  const relevantRefs = Array.from(new Set([fixture.expected_top, ...allowed]));
  const recallHits = countMatchingRefs(top3, relevantRefs);
  const noiseCount = countMatchingRefs(retrieval.results, forbidden);
  const freshAfter = fixture.fresh_after ? Date.parse(fixture.fresh_after) : null;
  const staleCount =
    freshAfter === null || Number.isNaN(freshAfter)
      ? 0
      : top3.filter(item => {
          if (!relevantRefs.some(ref => matchesFixtureRef(item, ref))) {
            return false;
          }
          const createdAt = Date.parse(item.created_at);
          return Number.isNaN(createdAt) || createdAt < freshAfter;
        }).length;
  const tokenBudget = {
    max_tokens: fixture.max_output_tokens ?? null,
    actual_tokens: output.est_tokens,
    passed:
      fixture.max_output_tokens === undefined ||
      output.est_tokens <= fixture.max_output_tokens,
  };
  const top1Hit =
    topResult !== null && matchesFixtureRef(topResult, fixture.expected_top);
  const recallAt3 = relevantRefs.length === 0 ? 0 : recallHits / relevantRefs.length;

  return {
    topic: fixture.topic,
    expected_top: fixture.expected_top,
    top_result_id: topResult?.id ?? null,
    top1_hit: top1Hit,
    recall_at_3: recallAt3,
    noise_count: noiseCount,
    stale_count: staleCount,
    output,
    token_budget: tokenBudget,
    score_breakdown: retrieval.results.map(buildScoreBreakdown),
    passed: top1Hit && recallAt3 === 1 && noiseCount === 0 && staleCount === 0 && tokenBudget.passed,
  };
}

function evaluateQualitySuite(
  store: CortexStore,
  fixtures: QualityFixture[],
): QualityEvaluation {
  const evaluated = fixtures.map(fixture => evaluateQualityFixture(store, fixture));
  const fixtureCount = evaluated.length;

  return {
    fixtures: evaluated,
    top1_hit:
      fixtureCount === 0
        ? 0
        : evaluated.filter(fixture => fixture.top1_hit).length / fixtureCount,
    recall_at_3:
      fixtureCount === 0
        ? 0
        : evaluated.reduce((sum, fixture) => sum + fixture.recall_at_3, 0) / fixtureCount,
    noise_count: evaluated.reduce((sum, fixture) => sum + fixture.noise_count, 0),
    stale_count: evaluated.reduce((sum, fixture) => sum + fixture.stale_count, 0),
    output_tokens: evaluated.reduce(
      (sum, fixture) => sum + fixture.output.est_tokens,
      0,
    ),
  };
}

function compareQuality(
  current: QualityEvaluation | undefined,
  previous: EvaluationResult | undefined,
): QualityComparison | undefined {
  if (!current || !previous?.quality) {
    return undefined;
  }

  return {
    top1_hit_delta: current.top1_hit - previous.quality.top1_hit,
    recall_at_3_delta: current.recall_at_3 - previous.quality.recall_at_3,
    noise_count_delta: current.noise_count - previous.quality.noise_count,
    stale_count_delta: current.stale_count - previous.quality.stale_count,
    output_tokens_delta: current.output_tokens - previous.quality.output_tokens,
  };
}

export function evaluateStore(
  store: CortexStore,
  requestedTopics: string[],
  dbPath?: string,
  options: EvaluationOptions = {},
): EvaluationResult {
  const topics = deriveTopics(store, requestedTopics);
  const header = buildHeader(store);
  const fullState = buildFullState(store);
  const quality =
    options.fixtures !== undefined
      ? evaluateQualitySuite(store, options.fixtures)
      : undefined;
  const qualityComparison = compareQuality(quality, options.compareTo);

  return {
    ...(dbPath ? { db_path: dbPath } : {}),
    ...(quality ? { quality } : {}),
    ...(qualityComparison ? { quality_comparison: qualityComparison } : {}),
    generated_at: new Date().toISOString(),
    schema_version: Number.parseInt(store.getMeta('schema_version') ?? '0', 10) || 0,
    tables: store.getTableCounts(),
    header: buildTextMetric(header),
    full_state: buildTextMetric(fullState),
    topics: topics.map(topic => ({
      topic,
      output: buildTextMetric(recall(store, topic)),
    })),
  };
}

export function evaluateDatabase(
  dbPath: string,
  rootPath: string,
  requestedTopics: string[],
  options?: EvaluationOptions,
): EvaluationResult {
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, rootPath);
  const store = new Store(db);
  return evaluateStore(store, requestedTopics, dbPath, options);
}
