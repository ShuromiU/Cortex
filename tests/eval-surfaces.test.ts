import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateDatabase } from '../src/eval/harness.js';
import { runEvalGate, regenerateBaseline } from '../src/eval/gate.js';
import type { EvaluationScenario } from '../src/eval/seed.js';

/**
 * Tests for the surface-assertion mechanism itself (Story 3.4).
 *
 * These exist because the mechanism shipped with **none**. A review mutated it
 * seven ways — `evaluateSurfaceFixture` returning `passed: true`
 * unconditionally, `excludesViolated` always empty, the `surfaces` passthrough
 * in `gate.ts` deleted so fixtures never reach the harness — and every one left
 * both `npx vitest run` and `npm run gate` fully green. A gate whose own
 * enforcement can be removed without anything noticing is decoration; the whole
 * point of Story 3.4 was to stop a surface regressing invisibly, and the
 * enforcement was itself in exactly that position.
 */

const SEED: EvaluationScenario = {
  scope: { type: 'branch', key: 'eval/surface-mechanism' },
  focus: 'cache policy',
  app_graph: { head_oid: 'eval0000000000000000000000000000000000aa', files: ['src/cache.ts'] },
  items: [
    {
      id: 'live-decision',
      kind: 'note:decision',
      subject: 'cache policy',
      text: 'Decision: evict by least-recently-used in src/cache.ts.\nSubject: cache policy',
      state: 'hot',
      importance: 2.5,
      age_days: 1,
    },
  ],
};

const FIXTURES = [{ topic: 'cache policy', expected_top: 'live-decision' }];

function evaluate(surfaces: unknown[]) {
  return evaluateDatabase(':memory:', process.cwd(), [], {
    fixtures: FIXTURES,
    surfaces: surfaces as never,
    scenario: SEED,
  });
}

describe('eval harness: surface assertions', () => {
  it('computes the session brief at all', () => {
    // The harness did not build the brief before this story, so no fixture
    // could ever have reached it. Everything else here depends on this.
    const result = evaluate([]);
    expect(result.session_brief.chars).toBeGreaterThan(0);
    expect(result.session_brief.preview).toContain('evict by least-recently-used');
  });

  it('fails a contains assertion the surface does not satisfy', () => {
    const [surface] = evaluate([
      { surface: 'brief', expect_contains: ['ABSENT-FROM-EVERY-BRIEF'] },
    ]).surfaces!;
    expect(surface!.passed).toBe(false);
    expect(surface!.contains_missed).toEqual(['ABSENT-FROM-EVERY-BRIEF']);
  });

  it('fails an excludes assertion the surface violates', () => {
    // The mutation that made `excludesViolated` always empty survived the whole
    // suite. This is the assertion that kills it.
    const [surface] = evaluate([
      { surface: 'brief', expect_excludes: ['evict by least-recently-used'] },
    ]).surfaces!;
    expect(surface!.passed).toBe(false);
    expect(surface!.excludes_violated).toEqual(['evict by least-recently-used']);
  });

  it('fails a token budget the surface exceeds', () => {
    const [surface] = evaluate([{ surface: 'brief', max_tokens: 1 }]).surfaces!;
    expect(surface!.passed).toBe(false);
    expect(surface!.token_budget.passed).toBe(false);
    expect(surface!.token_budget.actual_tokens).toBeGreaterThan(1);
  });

  it('passes when every assertion is satisfied', () => {
    const [surface] = evaluate([
      {
        surface: 'brief',
        expect_contains: ['evict by least-recently-used'],
        expect_excludes: ['ABSENT-FROM-EVERY-BRIEF'],
        max_tokens: 150,
      },
    ]).surfaces!;
    expect(surface!.passed).toBe(true);
  });

  it('renders the brief at a fixture-supplied budget', () => {
    // Without this the token budget is ungated: a seeded brief is far under
    // 150, so `max_tokens: 150` has ~100 tokens of headroom and can never bind.
    const wide = evaluate([{ surface: 'brief', max_tokens: 150 }]).surfaces![0]!;
    const tight = evaluate([{ surface: 'brief', budget: 8, max_tokens: 150 }]).surfaces![0]!;
    expect(tight.output.est_tokens).toBeLessThan(wide.output.est_tokens);
  });

  it('reaches header and full_state, not only the brief', () => {
    const result = evaluate([
      { surface: 'header', expect_contains: ['ABSENT-FROM-EVERY-HEADER'] },
      { surface: 'full_state', expect_contains: ['ABSENT-FROM-EVERY-STATE'] },
    ]);
    expect(result.surfaces!.map(s => s.surface)).toEqual(['header', 'full_state']);
    // Both must be genuinely rendered, or an assertion against either would
    // pass or fail for the wrong reason.
    expect(result.surfaces!.every(s => s.output.chars > 0)).toBe(true);
    expect(result.surfaces!.every(s => !s.passed)).toBe(true);
  });
});

describe('eval gate: surface enforcement end to end', () => {
  function stageSuite(surfaces: unknown[]): { dir: string; run: () => ReturnType<typeof runEvalGate> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-surfgate-'));
    const suitesDir = path.join(dir, 'suites');
    const baselinesDir = path.join(dir, 'baselines');
    fs.mkdirSync(suitesDir);
    fs.mkdirSync(baselinesDir);
    const suite = { seed: SEED, fixtures: FIXTURES, ...(surfaces.length > 0 ? { surfaces } : {}) };
    fs.writeFileSync(path.join(suitesDir, 'probe.json'), JSON.stringify(suite, null, 2));
    // A baseline whose fixture passes, so only the surface can fail the run.
    const baseline = evaluateDatabase(':memory:', process.cwd(), [], {
      fixtures: FIXTURES,
      scenario: SEED,
    });
    fs.writeFileSync(path.join(baselinesDir, 'probe.json'), JSON.stringify(baseline, null, 2));
    return {
      dir,
      run: () =>
        runEvalGate({
          suitesDir,
          baselinesDir,
          rootPath: process.cwd(),
          coveragePath: path.join(process.cwd(), 'eval', 'kind-coverage.json'),
        }),
    };
  }

  // Assertions are SUITE-level, never `result.ok`. A single-suite probe cannot
  // satisfy AD-5 kind coverage — it exercises `note:decision` alone — so the
  // run is red for an unrelated reason and `expect(result.ok).toBe(false)`
  // would pass for every one of these tests no matter what the surface code
  // did. That is exactly the vacuous green this file exists to prevent.
  function suiteOf(run: () => ReturnType<typeof runEvalGate>) {
    const suites = run().suites;
    expect(suites).toHaveLength(1);
    return suites[0]!;
  }

  it('fails the SUITE when a surface assertion fails', () => {
    // The `surfaces` passthrough in `evaluateSuite` could be deleted with the
    // whole gate still green — the feature disabled outright and nothing
    // noticing. This asserts the wiring, not just the evaluator.
    const suite = suiteOf(
      stageSuite([{ surface: 'brief', expect_contains: ['ABSENT-FROM-EVERY-BRIEF'] }]).run,
    );
    expect(suite.ok).toBe(false);
    expect(suite.regressions.some(r => r.includes("surface 'brief'"))).toBe(true);
  });

  it('passes the suite when the surface assertion holds', () => {
    const suite = suiteOf(
      stageSuite([{ surface: 'brief', expect_contains: ['evict by least-recently-used'] }]).run,
    );
    expect(suite.regressions).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  it('refuses a surface entry that asserts nothing', () => {
    for (const entry of [
      { surface: 'brief' },
      { surface: 'brief', expect_contains: [], expect_excludes: [] },
    ]) {
      const suite = suiteOf(stageSuite([entry]).run);
      expect(suite.ok).toBe(false);
      expect(suite.regressions.some(r => /asserts nothing/.test(r))).toBe(true);
    }
  });

  it('reports a failing fixture when writing a FIRST baseline', () => {
    // The escape hatch that excuses baseline-failing fixtures has no previous
    // baseline to compare against here, so a new suite could enter the locked
    // set with a dead assertion and no warning. Measured exactly that: a needle
    // missing four words, excused forever, gate printing `ok`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-firstbase-'));
    const suitesDir = path.join(dir, 'suites');
    const baselinesDir = path.join(dir, 'baselines');
    fs.mkdirSync(suitesDir);
    fs.mkdirSync(baselinesDir);
    fs.writeFileSync(
      path.join(suitesDir, 'fresh.json'),
      JSON.stringify({
        seed: SEED,
        fixtures: [
          {
            topic: 'cache policy',
            expected_top: 'live-decision',
            expect_output_contains: ['A NEEDLE THAT NEVER MATCHES'],
          },
        ],
      }),
    );

    const report = regenerateBaseline('fresh', {
      suitesDir,
      baselinesDir,
      rootPath: process.cwd(),
      coveragePath: path.join(process.cwd(), 'eval', 'kind-coverage.json'),
    });

    expect(report.accepted.length).toBeGreaterThan(0);
    expect(report.accepted.join(' ')).toMatch(/FAILING in this first baseline/);
    expect(report.accepted.join(' ')).toContain('A NEEDLE THAT NEVER MATCHES');
  });

  it('refuses an unknown surface name rather than asserting against nothing', () => {
    // A typo'd name would read every assertion against `undefined`: `contains`
    // fails loudly, but `excludes` and the token budget pass vacuously.
    const suite = suiteOf(stageSuite([{ surface: 'breif', expect_contains: ['x'] }]).run);
    expect(suite.ok).toBe(false);
    expect(suite.regressions.some(r => /unknown surface/.test(r))).toBe(true);
  });
});
