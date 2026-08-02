import type { CortexStore, TableCounts } from '../db/store.js';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore as Store } from '../db/store.js';
import { buildHeader, buildFullState } from '../query/state.js';
import { buildSessionBrief } from '../query/session-brief.js';
import { recall } from '../query/recall.js';
import { retrieveMemory, type RetrievedMemoryItem } from '../query/retrieval.js';
import { createSeededStore, type EvaluationScenario } from './seed.js';

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
  /** Substrings that must appear in the rendered recall output (e.g. staleness labels). */
  expect_output_contains?: string[];
  /** Substrings that must not appear in the rendered recall output. */
  expect_output_excludes?: string[];
}

/**
 * An assertion on a whole rendered **surface**, rather than on a recall query.
 *
 * The gate compared `top1_hit`, `recall_at_3` and `output_tokens` from
 * topic-driven fixtures only. `header` and `full_state` were computed on every
 * run and **nothing ever looked at them**, and the SessionStart brief was not
 * computed at all — so a change to any of those three could not turn the gate
 * red. Story 3.4 edits the brief, which made shipping without this the same as
 * shipping untested.
 *
 * Deliberately not a retrieval metric: these are `contains`/`excludes`/token
 * assertions on rendered text, so they can fail a suite without touching the
 * three gated numbers, and every existing baseline stays byte-identical.
 */
export type EvaluatedSurface = 'brief' | 'header' | 'full_state';

export interface SurfaceFixture {
  surface: EvaluatedSurface;
  expect_contains?: string[];
  expect_excludes?: string[];
  max_tokens?: number;
  /**
   * Render the brief at this budget instead of its 150 default.
   *
   * Without it the token budget cannot be gated at all: a seeded brief is 36–77
   * tokens against `max_tokens: 150`, so the assertion has ~100 tokens of
   * headroom and can never bind — and deleting the enforcement loop outright
   * left the whole gate green. A fixture that renders at a budget the content
   * genuinely exceeds is the only way this surface's budget code is exercised.
   * Ignored for `header` and `full_state`, which take no budget here.
   */
  budget?: number;
}

export interface SurfaceEvaluation {
  surface: EvaluatedSurface;
  output: TextMetric;
  contains_missed: string[];
  excludes_violated: string[];
  token_budget: {
    max_tokens: number | null;
    actual_tokens: number;
    passed: boolean;
  };
  passed: boolean;
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
  output_assertions: {
    contains_missed: string[];
    excludes_violated: string[];
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
  surfaces?: SurfaceFixture[];
  compareTo?: EvaluationResult;
  /** Hermetic seed: evaluate against an in-memory store built from this scenario. */
  scenario?: EvaluationScenario;
}

export interface EvaluationResult {
  db_path?: string;
  generated_at: string;
  schema_version: number;
  tables: TableCounts;
  header: TextMetric;
  full_state: TextMetric;
  /**
   * The SessionStart brief. Recorded even when no suite asserts on it, because
   * a surface the harness does not compute is a surface no future fixture can
   * reach — the exact reason this one went unmeasured until Story 3.4.
   */
  session_brief: TextMetric;
  topics: TopicEvaluation[];
  quality?: QualityEvaluation;
  quality_comparison?: QualityComparison;
  surfaces?: SurfaceEvaluation[];
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
  const outputText = recall(
    store,
    fixture.topic,
    fixture.max_output_tokens !== undefined ? { budget: fixture.max_output_tokens } : {},
  );
  const output = buildTextMetric(outputText);
  const loweredOutput = outputText.toLowerCase();
  const containsMissed = (fixture.expect_output_contains ?? []).filter(
    needle => !loweredOutput.includes(needle.toLowerCase()),
  );
  const excludesViolated = (fixture.expect_output_excludes ?? []).filter(
    needle => loweredOutput.includes(needle.toLowerCase()),
  );
  const outputAssertions = {
    contains_missed: containsMissed,
    excludes_violated: excludesViolated,
    passed: containsMissed.length === 0 && excludesViolated.length === 0,
  };
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
    output_assertions: outputAssertions,
    score_breakdown: retrieval.results.map(buildScoreBreakdown),
    passed:
      top1Hit &&
      recallAt3 === 1 &&
      noiseCount === 0 &&
      staleCount === 0 &&
      tokenBudget.passed &&
      outputAssertions.passed,
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
  // `includeReadLedger: false` — the FR-7 line names files that must exist on
  // disk with matching hashes, which a seeded in-memory scenario cannot stage.
  // Leaving it on would make the brief's content depend on the developer's
  // working tree, so a suite would pass or fail by what happened to be checked
  // out. The line has its own unit tests; what gates here is everything else
  // the brief renders.
  const sessionBrief = buildSessionBrief(store, { includeReadLedger: false });
  const quality =
    options.fixtures !== undefined
      ? evaluateQualitySuite(store, options.fixtures)
      : undefined;
  const qualityComparison = compareQuality(quality, options.compareTo);
  const surfaces = options.surfaces?.map(fixture =>
    evaluateSurfaceFixture(fixture, {
      // A fixture supplying its own budget re-renders the brief at it; the
      // default rendering is shared by every fixture that does not.
      brief:
        fixture.budget === undefined
          ? sessionBrief
          : buildSessionBrief(store, { includeReadLedger: false, budget: fixture.budget }),
      header,
      full_state: fullState,
    }),
  );

  return {
    ...(dbPath ? { db_path: dbPath } : {}),
    ...(quality ? { quality } : {}),
    ...(qualityComparison ? { quality_comparison: qualityComparison } : {}),
    ...(surfaces ? { surfaces } : {}),
    generated_at: new Date().toISOString(),
    schema_version: Number.parseInt(store.getMeta('schema_version') ?? '0', 10) || 0,
    tables: store.getTableCounts(),
    header: buildTextMetric(header),
    full_state: buildTextMetric(fullState),
    session_brief: buildTextMetric(sessionBrief),
    topics: topics.map(topic => ({
      topic,
      output: buildTextMetric(recall(store, topic)),
    })),
  };
}

function evaluateSurfaceFixture(
  fixture: SurfaceFixture,
  rendered: Record<EvaluatedSurface, string>,
): SurfaceEvaluation {
  const text = rendered[fixture.surface];
  const output = buildTextMetric(text);
  const containsMissed = (fixture.expect_contains ?? []).filter(
    needle => !text.includes(needle),
  );
  const excludesViolated = (fixture.expect_excludes ?? []).filter(needle =>
    text.includes(needle),
  );
  const tokenBudget = {
    max_tokens: fixture.max_tokens ?? null,
    actual_tokens: output.est_tokens,
    passed: fixture.max_tokens === undefined || output.est_tokens <= fixture.max_tokens,
  };
  return {
    surface: fixture.surface,
    output,
    contains_missed: containsMissed,
    excludes_violated: excludesViolated,
    token_budget: tokenBudget,
    passed:
      containsMissed.length === 0 && excludesViolated.length === 0 && tokenBudget.passed,
  };
}

export function evaluateDatabase(
  dbPath: string,
  rootPath: string,
  requestedTopics: string[],
  options?: EvaluationOptions,
): EvaluationResult {
  if (options?.scenario) {
    const { store } = createSeededStore(options.scenario, rootPath);
    return evaluateStore(store, requestedTopics, undefined, options);
  }

  const db = openDatabase(dbPath);
  ensureCortexSchema(db, rootPath);
  const store = new Store(db);
  return evaluateStore(store, requestedTopics, dbPath, options);
}
