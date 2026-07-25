import * as fs from 'node:fs';
import * as path from 'node:path';
import { KIND_WEIGHTS } from '../memory/kind-weights.js';
import {
  evaluateDatabase,
  type EvaluationResult,
  type QualityFixture,
} from './harness.js';
import type { EvaluationScenario } from './seed.js';

/**
 * The locked retrieval-quality gate (FR-44, AD-5).
 *
 * `cortex evaluate --compare` reports deltas and exits 0; a human reading JSON
 * is not a gate. This module evaluates every locked suite, fails the build on a
 * quality regression naming the suite and metric, and refuses to let a new
 * `memory_items` kind ship without a fixture that exercises it.
 *
 * Design rule learned the hard way: **every ambiguous input is a failure.** A
 * gate that cannot fail is worse than no gate, because it manufactures
 * confidence. Missing metrics, orphaned baselines, assertion-free suites and
 * unreadable files all fail closed and say why.
 */

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_SUITES_DIR = 'eval/suites';
const DEFAULT_BASELINES_DIR = 'eval/baselines';
const DEFAULT_COVERAGE_PATH = 'eval/kind-coverage.json';

/** Gated: accuracy must not fall, cost must not rise. */
const GATED_METRICS = ['top1_hit', 'recall_at_3', 'output_tokens'] as const;
/** Reported for visibility but not gated — AD-5 names all five. */
const REPORTED_METRICS = ['noise_count', 'stale_count'] as const;

export const BASELINE_TRAILER = 'Baseline-Regenerated:';

/**
 * Changes to these need a justification trailer. `kind-coverage.json` is here
 * because grandfathering a kind is the same class of act as rewriting a
 * baseline: a one-line edit that turns the gate green without evidence.
 */
const JUSTIFIED_PATHS = ['eval/baselines/', 'eval/kind-coverage.json'];

// ── Types ─────────────────────────────────────────────────────────────

export interface EvalGateOptions {
  suitesDir?: string;
  baselinesDir?: string;
  coveragePath?: string;
  /** Project root used to seed the hermetic store. */
  rootPath?: string;
}

export interface GateSuiteResult {
  suite: string;
  ok: boolean;
  /** One entry per gated metric or fixture that failed. */
  regressions: string[];
}

export interface GateKindCoverage {
  ok: boolean;
  uncovered: string[];
  grandfathered: string[];
}

export interface GateResult {
  ok: boolean;
  suites: GateSuiteResult[];
  kindCoverage: GateKindCoverage;
  /** Rendered report, ready to print. */
  lines: string[];
}

/** A file touched by a commit, with its git status letter (A/M/D/R…). */
export interface ChangedFile {
  path: string;
  status: string;
}

/** One commit's contribution to a push or pull request. */
export interface CommitRecord {
  body: string;
  files: ChangedFile[];
}

export interface BaselineJustificationVerdict {
  ok: boolean;
  reason?: string;
}

interface QualitySuiteFile {
  fixtures: QualityFixture[];
  seed?: EvaluationScenario;
}

// ── Loading ───────────────────────────────────────────────────────────

function resolveDirs(options: EvalGateOptions): {
  suitesDir: string;
  baselinesDir: string;
  coveragePath: string;
  rootPath: string;
} {
  return {
    suitesDir: options.suitesDir ?? DEFAULT_SUITES_DIR,
    baselinesDir: options.baselinesDir ?? DEFAULT_BASELINES_DIR,
    coveragePath: options.coveragePath ?? DEFAULT_COVERAGE_PATH,
    rootPath: options.rootPath ?? process.cwd(),
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** `.json` files only, and anything else in the directory is reported. */
function listJsonNames(dir: string): { names: string[]; unrecognized: string[] } {
  if (!isDirectory(dir)) {
    return { names: [], unrecognized: [] };
  }
  const entries = fs.readdirSync(dir);
  return {
    names: entries
      .filter(file => file.endsWith('.json') && !isDirectory(path.join(dir, file)))
      .map(file => file.slice(0, -'.json'.length))
      .sort(),
    unrecognized: entries.filter(
      file => !file.endsWith('.json') || isDirectory(path.join(dir, file)),
    ),
  };
}

/**
 * A suite must assert something. Empty fixtures score zero on every metric and
 * self-baseline to a permanently green suite; a missing `seed` drops off the
 * hermetic path into an empty store where every fixture misses, which also
 * self-baselines to green.
 */
function loadSuite(suitesDir: string, name: string): QualitySuiteFile {
  const parsed = readJson(path.join(suitesDir, `${name}.json`));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('suite is not a JSON object');
  }

  const suite = parsed as { fixtures?: unknown; seed?: unknown };
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length === 0) {
    throw new Error('suite has no fixtures — it would assert nothing and pass forever');
  }
  if (!suite.seed || typeof suite.seed !== 'object') {
    throw new Error('suite has no seed — it would evaluate against an empty store');
  }
  if (!Array.isArray((suite.seed as { items?: unknown }).items)) {
    throw new Error('suite seed has no items array');
  }

  return { fixtures: suite.fixtures as QualityFixture[], seed: suite.seed as EvaluationScenario };
}

function evaluateSuite(
  suite: QualitySuiteFile,
  rootPath: string,
  compareTo?: EvaluationResult,
): EvaluationResult {
  return evaluateDatabase(':memory:', rootPath, [], {
    fixtures: suite.fixtures,
    ...(suite.seed ? { scenario: suite.seed } : {}),
    ...(compareTo ? { compareTo } : {}),
  });
}

// ── Comparison ────────────────────────────────────────────────────────

/**
 * Deltas are `current - baseline`, so accuracy gates on negative and cost on
 * positive. A non-finite delta means the baseline lacked the metric — `NaN`
 * compares false against everything, so without this check a baseline whose
 * `quality` block is `{}` would silently un-gate every metric while printing
 * plausible current numbers.
 */
function findMetricRegressions(result: EvaluationResult): string[] {
  const comparison = result.quality_comparison;
  if (!comparison) {
    return ['no comparison produced — the suite or its baseline carries no quality block'];
  }

  const regressions: string[] = [];
  for (const metric of GATED_METRICS) {
    const delta = comparison[`${metric}_delta` as keyof typeof comparison];
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      regressions.push(
        `${metric}: baseline value missing or non-numeric — the baseline cannot gate this metric`,
      );
      continue;
    }

    const regressed = metric === 'output_tokens' ? delta > 0 : delta < 0;
    if (regressed) {
      const current = result.quality?.[metric];
      const baseline = typeof current === 'number' ? current - delta : undefined;
      regressions.push(
        `${metric} ${delta > 0 ? '+' : ''}${delta}` +
          (baseline !== undefined ? ` (baseline ${baseline} → now ${current})` : ''),
      );
    }
  }
  return regressions;
}

/**
 * Absolute, not comparative. Two suites exist only to lock output content
 * (`[stale:`, `[moved:`), and a fixture's own assertions are invisible to the
 * aggregate deltas — worse, losing a label shrinks the output, so the delta
 * reads as an improvement. `passed` folds top-1, recall, token budget and the
 * contains/excludes assertions.
 */
function findFixtureFailures(result: EvaluationResult): string[] {
  const fixtures = result.quality?.fixtures ?? [];
  const failures: string[] = [];

  for (const fixture of fixtures) {
    if (fixture.passed) {
      continue;
    }
    const reasons: string[] = [];
    if (!fixture.top1_hit) {
      reasons.push(`expected top '${fixture.expected_top}', got '${fixture.top_result_id ?? 'none'}'`);
    }
    if (fixture.output_assertions.contains_missed.length > 0) {
      reasons.push(`missing ${JSON.stringify(fixture.output_assertions.contains_missed)}`);
    }
    if (fixture.output_assertions.excludes_violated.length > 0) {
      reasons.push(`forbidden ${JSON.stringify(fixture.output_assertions.excludes_violated)}`);
    }
    if (!fixture.token_budget.passed) {
      reasons.push(
        `over token budget (${fixture.token_budget.actual_tokens} > ${fixture.token_budget.max_tokens})`,
      );
    }
    failures.push(
      `fixture '${fixture.topic}' failed${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}`,
    );
  }

  return failures;
}

// ── AD-5 kind coverage ────────────────────────────────────────────────

function readGrandfathered(coveragePath: string): string[] {
  if (!fs.existsSync(coveragePath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = readJson(coveragePath);
  } catch {
    // Unreadable manifest grandfathers nothing, so every uncovered kind fails.
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const list = (parsed as { grandfathered?: unknown }).grandfathered;
  return Array.isArray(list) ? list.filter((kind): kind is string => typeof kind === 'string') : [];
}

function kindsExercisedBy(suite: QualitySuiteFile): string[] {
  const items = Array.isArray(suite.seed?.items) ? suite.seed.items : [];
  return items
    .map(item => (item as { kind?: unknown }).kind)
    .filter((kind): kind is string => typeof kind === 'string');
}

/**
 * A kind that no fixture seeds is not penalised by the suites — it is invisible
 * to them, and they report green (AD-5). So the registry, not the suites, is the
 * source of truth for what must be covered.
 */
export function checkKindCoverage(
  suites: QualitySuiteFile[],
  coveragePath: string,
): GateKindCoverage {
  const grandfathered = readGrandfathered(coveragePath);
  const covered = new Set(suites.flatMap(kindsExercisedBy));
  const uncovered = Object.keys(KIND_WEIGHTS)
    .filter(kind => !covered.has(kind))
    .filter(kind => !grandfathered.includes(kind))
    .sort();

  return { ok: uncovered.length === 0, uncovered, grandfathered };
}

// ── The gate ──────────────────────────────────────────────────────────

export function runEvalGate(options: EvalGateOptions = {}): GateResult {
  const { suitesDir, baselinesDir, coveragePath, rootPath } = resolveDirs(options);
  const lines: string[] = [];
  const suites: GateSuiteResult[] = [];
  const loaded: QualitySuiteFile[] = [];

  const suiteFiles = listJsonNames(suitesDir);
  const baselineFiles = listJsonNames(baselinesDir);

  const fail = (suite: string, reasons: string[]): void => {
    suites.push({ suite, ok: false, regressions: reasons });
    for (const reason of reasons) {
      lines.push(`FAIL  ${suite}: ${reason}`);
    }
  };

  if (suiteFiles.names.length === 0) {
    lines.push(`FAIL  no locked suites found in ${suitesDir}`);
    return {
      ok: false,
      suites,
      kindCoverage: { ok: false, uncovered: [], grandfathered: [] },
      lines,
    };
  }

  for (const stray of suiteFiles.unrecognized) {
    lines.push(`FAIL  ${suitesDir}/${stray} is not a suite file — it would be silently ignored`);
    suites.push({ suite: stray, ok: false, regressions: ['unrecognized file in suites directory'] });
  }

  // A baseline with no suite means a suite was deleted. Removing a file is
  // cheaper than regenerating a baseline and evades the justification guard,
  // so it must be louder, not quieter.
  for (const orphan of baselineFiles.names.filter(name => !suiteFiles.names.includes(name))) {
    fail(orphan, [
      `baseline exists but ${suitesDir}/${orphan}.json does not — a locked suite was removed`,
    ]);
  }

  for (const name of suiteFiles.names) {
    let suite: QualitySuiteFile;
    try {
      suite = loadSuite(suitesDir, name);
    } catch (error) {
      // Per-suite, so one malformed file cannot abort the run and leave a
      // partial pass indistinguishable from a complete one.
      fail(name, [`unreadable suite (${(error as Error).message})`]);
      continue;
    }
    loaded.push(suite);

    const baselinePath = path.join(baselinesDir, `${name}.json`);
    if (!fs.existsSync(baselinePath)) {
      fail(name, [
        `no baseline at ${baselinePath} — run 'cortex eval-gate --regenerate-baseline ${name}' ` +
          'and justify it in the commit body',
      ]);
      continue;
    }

    let baseline: EvaluationResult;
    try {
      baseline = readJson(baselinePath) as EvaluationResult;
    } catch (error) {
      fail(name, [`unreadable baseline (${(error as Error).message})`]);
      continue;
    }

    let result: EvaluationResult;
    try {
      result = evaluateSuite(suite, rootPath, baseline);
    } catch (error) {
      fail(name, [`evaluation threw (${(error as Error).message})`]);
      continue;
    }

    const regressions = [...findMetricRegressions(result), ...findFixtureFailures(result)];
    if (regressions.length > 0) {
      fail(name, regressions);
      continue;
    }

    suites.push({ suite: name, ok: true, regressions: [] });
    const quality = result.quality;
    lines.push(
      `ok    ${name}` +
        (quality
          ? `  ${[...GATED_METRICS, ...REPORTED_METRICS]
              .map(metric => `${metric}=${quality[metric]}`)
              .join(' ')}`
          : ''),
    );
  }

  const kindCoverage = checkKindCoverage(loaded, coveragePath);
  for (const kind of kindCoverage.uncovered) {
    lines.push(
      `FAIL  memory_items kind '${kind}' is registered but no locked suite exercises it — ` +
        'AD-5 requires a fixture in the same change that introduces the kind',
    );
  }

  const ok = suites.every(suite => suite.ok) && kindCoverage.ok;
  lines.push(
    ok
      ? `\nRetrieval quality gate passed (${suites.length} suite${suites.length === 1 ? '' : 's'}).`
      : '\nRetrieval quality gate FAILED. Baselines are locked artifacts — regenerating one is a ' +
        'deliberate act that must be justified in the commit body, never a way to turn this green.',
  );

  return { ok, suites, kindCoverage, lines };
}

// ── Regeneration ──────────────────────────────────────────────────────

export interface RegenerationReport {
  suite: string;
  baselinePath: string;
  /** Regressions the regeneration bakes in, when a previous baseline existed. */
  accepted: string[];
}

/**
 * Write a baseline. Reachable only behind an explicit flag: the gate itself
 * never writes one, so a red build cannot quietly become green.
 */
export function regenerateBaseline(
  suiteName: string,
  options: EvalGateOptions = {},
): RegenerationReport {
  const { suitesDir, baselinesDir, rootPath } = resolveDirs(options);

  // A suite name is a bare file name. Without this, `../outside/x` writes a
  // baseline beyond eval/baselines and escapes the CI justification check.
  if (suiteName.trim().length === 0 || suiteName !== path.basename(suiteName)) {
    throw new Error(`Suite name must be a bare file name, got '${suiteName}'`);
  }

  const suitePath = path.join(suitesDir, `${suiteName}.json`);
  if (!fs.existsSync(suitePath)) {
    throw new Error(`No locked suite named '${suiteName}' in ${suitesDir}`);
  }

  const suite = loadSuite(suitesDir, suiteName);
  const baselinePath = path.join(baselinesDir, `${suiteName}.json`);
  const previous = fs.existsSync(baselinePath)
    ? (readJson(baselinePath) as EvaluationResult)
    : undefined;

  const result = evaluateSuite(suite, rootPath, previous);
  const accepted = previous
    ? [...findMetricRegressions(result), ...findFixtureFailures(result)]
    : findFixtureFailures(result);

  fs.mkdirSync(baselinesDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(result, null, 2)}\n`);

  return { suite: suiteName, baselinePath, accepted };
}

// ── Baseline justification ────────────────────────────────────────────

function touchesGuardedPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return JUSTIFIED_PATHS.some(
    guarded =>
      normalized === guarded.replace(/\/$/, '') ||
      normalized.startsWith(guarded) ||
      normalized === guarded,
  );
}

function justificationIn(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(BASELINE_TRAILER)) {
      continue;
    }
    const reason = trimmed.slice(BASELINE_TRAILER.length).trim();
    // The CLI prints `<why this quality change is intended>` as a template.
    if (reason.length > 0 && !/^<.*>$/.test(reason)) {
      return reason;
    }
  }
  return undefined;
}

/**
 * A locked artifact may change, but the reason must travel with the commit that
 * changed it. Checking the range as a whole let an unrelated commit's trailer —
 * or one written by someone else on the base branch — launder the change.
 */
export function checkBaselineJustification(
  commits: CommitRecord[],
): BaselineJustificationVerdict {
  const offenders: string[] = [];

  for (const commit of commits) {
    const touched = commit.files
      // Adding a locked artifact is not regenerating one — a new suite needs a
      // new baseline, and the suite's own correctness is gated separately.
      // Modifying or deleting an existing one is the act that needs a reason.
      .filter(file => file.status.toUpperCase() !== 'A')
      .filter(file => touchesGuardedPath(file.path))
      .map(file => file.path);
    if (touched.length === 0) {
      continue;
    }
    if (justificationIn(commit.body) === undefined) {
      offenders.push(...touched);
    }
  }

  if (offenders.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `Locked artifact changed (${[...new Set(offenders)].join(', ')}) by a commit with no ` +
      `justification. Add a '${BASELINE_TRAILER} <reason>' line to the body of the commit that ` +
      'makes the change, explaining why the quality change is intended.',
  };
}
