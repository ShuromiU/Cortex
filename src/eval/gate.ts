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
 */

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_SUITES_DIR = 'eval/suites';
const DEFAULT_BASELINES_DIR = 'eval/baselines';
const DEFAULT_COVERAGE_PATH = 'eval/kind-coverage.json';

/** Only these three gate. See project-context.md § Retrieval-Quality Gate. */
const GATED_METRICS = ['top1_hit', 'recall_at_3', 'output_tokens'] as const;

export const BASELINE_TRAILER = 'Baseline-Regenerated:';

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
  /** One entry per gated metric that moved the wrong way. */
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

export interface BaselineJustificationVerdict {
  ok: boolean;
  reason?: string;
}

interface QualitySuiteFile {
  fixtures: QualityFixture[];
  seed?: EvaluationScenario;
}

// ── Suite loading ─────────────────────────────────────────────────────

function resolveDirs(options: EvalGateOptions): Required<Omit<EvalGateOptions, 'rootPath'>> & {
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

function listSuiteNames(suitesDir: string): string[] {
  if (!fs.existsSync(suitesDir)) {
    return [];
  }
  return fs
    .readdirSync(suitesDir)
    .filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -'.json'.length))
    .sort();
}

function loadSuite(suitesDir: string, name: string): QualitySuiteFile {
  const parsed = readJson(path.join(suitesDir, `${name}.json`));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { fixtures?: unknown }).fixtures)
  ) {
    throw new Error(`Quality suite ${name} must be a JSON object with a fixtures array`);
  }
  return parsed as QualitySuiteFile;
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
 * A metric regressed when accuracy fell or cost rose. Deltas are
 * `current - baseline`, so accuracy gates on negative and cost on positive.
 */
function findRegressions(result: EvaluationResult): string[] {
  const comparison = result.quality_comparison;
  if (!comparison) {
    return ['no comparison produced — the suite or its baseline carries no quality block'];
  }

  const regressions: string[] = [];
  for (const metric of GATED_METRICS) {
    const delta = comparison[`${metric}_delta` as keyof typeof comparison];
    if (typeof delta !== 'number') {
      continue;
    }
    const regressed = metric === 'output_tokens' ? delta > 0 : delta < 0;
    if (regressed) {
      const current = result.quality?.[metric];
      regressions.push(
        `${metric} ${delta > 0 ? '+' : ''}${delta}` +
          (typeof current === 'number' ? ` (now ${current})` : ''),
      );
    }
  }
  return regressions;
}

// ── AD-5 kind coverage ────────────────────────────────────────────────

function readGrandfathered(coveragePath: string): string[] {
  if (!fs.existsSync(coveragePath)) {
    return [];
  }
  const parsed = readJson(coveragePath) as { grandfathered?: unknown };
  return Array.isArray(parsed.grandfathered) ? (parsed.grandfathered as string[]) : [];
}

function kindsExercisedBy(suite: QualitySuiteFile): string[] {
  const items = suite.seed?.items ?? [];
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
  const names = listSuiteNames(suitesDir);
  const lines: string[] = [];
  const suites: GateSuiteResult[] = [];
  const loaded: QualitySuiteFile[] = [];

  if (names.length === 0) {
    lines.push(`FAIL  no locked suites found in ${suitesDir}`);
    return {
      ok: false,
      suites,
      kindCoverage: { ok: false, uncovered: [], grandfathered: [] },
      lines,
    };
  }

  for (const name of names) {
    const suite = loadSuite(suitesDir, name);
    loaded.push(suite);

    const baselinePath = path.join(baselinesDir, `${name}.json`);
    if (!fs.existsSync(baselinePath)) {
      // Skipping would make the suite invisible to the gate — the exact failure
      // mode the gate exists to prevent. Baselining is a deliberate act.
      suites.push({ suite: name, ok: false, regressions: ['no baseline'] });
      lines.push(
        `FAIL  ${name}: no baseline at ${baselinePath} — ` +
          `run 'cortex eval-gate --regenerate-baseline ${name}' and justify it in the commit body`,
      );
      continue;
    }

    const result = evaluateSuite(suite, rootPath, readJson(baselinePath) as EvaluationResult);
    const regressions = findRegressions(result);
    suites.push({ suite: name, ok: regressions.length === 0, regressions });

    if (regressions.length === 0) {
      const quality = result.quality;
      lines.push(
        `ok    ${name}` +
          (quality
            ? `  top1_hit=${quality.top1_hit} recall_at_3=${quality.recall_at_3} output_tokens=${quality.output_tokens}`
            : ''),
      );
    } else {
      for (const regression of regressions) {
        lines.push(`FAIL  ${name}: ${regression}`);
      }
    }
  }

  const kindCoverage = checkKindCoverage(loaded, coveragePath);
  if (!kindCoverage.ok) {
    for (const kind of kindCoverage.uncovered) {
      lines.push(
        `FAIL  memory_items kind '${kind}' is registered but no locked suite exercises it — ` +
          'AD-5 requires a fixture in the same change that introduces the kind',
      );
    }
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
  /** Deltas the regeneration bakes in, when a previous baseline existed. */
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
  const accepted = previous ? findRegressions(result) : [];

  fs.mkdirSync(baselinesDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(result, null, 2)}\n`);

  return { suite: suiteName, baselinePath, accepted };
}

// ── Baseline justification ────────────────────────────────────────────

/**
 * A baseline change must carry its reasoning into history. Enforced in CI over
 * the commit bodies in the pushed range, because the flag alone is only a speed
 * bump — the point is that the justification survives for the next reader.
 */
export function checkBaselineJustification(
  changedFiles: string[],
  commitBodies: string,
): BaselineJustificationVerdict {
  const touched = changedFiles.filter(file =>
    file.replace(/\\/g, '/').includes('eval/baselines/'),
  );
  if (touched.length === 0) {
    return { ok: true };
  }

  const justified = commitBodies
    .split('\n')
    .filter(line => line.trim().startsWith(BASELINE_TRAILER))
    .some(line => line.slice(line.indexOf(BASELINE_TRAILER) + BASELINE_TRAILER.length).trim().length > 0);

  if (justified) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `Locked baseline changed (${touched.join(', ')}) with no justification. ` +
      `Add a '${BASELINE_TRAILER} <reason>' line to the commit body explaining why the ` +
      'quality change is intended.',
  };
}
