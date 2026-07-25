import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runEvalGate,
  regenerateBaseline,
  checkBaselineJustification,
  type EvalGateOptions,
} from '../src/eval/gate.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * A minimal but real suite: the gate evaluates it through the same hermetic
 * seeded path production uses, so these tests exercise the actual comparison
 * rather than a mock of it.
 */
function suiteFor(kind: string): unknown {
  return {
    _comment: 'gate test fixture',
    seed: {
      scope: { type: 'project', key: 'project:/gate', worktreePath: '/gate' },
      focus: 'gate',
      items: [
        {
          id: 'gate-item',
          kind,
          subject: 'gate topic',
          text: 'decision: the gate topic resolution uses src/gate.ts.',
          state: 'hot',
          importance: 3,
          created_at: '2026-07-24T00:00:00.000Z',
        },
      ],
    },
    fixtures: [{ topic: 'gate topic', expected_top: 'gate-item' }],
  };
}

interface GateDirs extends EvalGateOptions {
  root: string;
  suitesDir: string;
  baselinesDir: string;
  coveragePath: string;
}

function makeDirs(): GateDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-gate-'));
  const suitesDir = path.join(root, 'suites');
  const baselinesDir = path.join(root, 'baselines');
  fs.mkdirSync(suitesDir);
  fs.mkdirSync(baselinesDir);
  const coveragePath = path.join(root, 'kind-coverage.json');
  fs.writeFileSync(coveragePath, JSON.stringify({ grandfathered: [] }));
  return { root, suitesDir, baselinesDir, coveragePath, rootPath: root };
}

/** Write a suite plus a baseline generated from it, i.e. a green starting point. */
function seedSuite(dirs: GateDirs, name: string, kind = 'note:decision'): void {
  fs.writeFileSync(
    path.join(dirs.suitesDir, `${name}.json`),
    JSON.stringify(suiteFor(kind), null, 2),
  );
  regenerateBaseline(name, dirs);
}

/**
 * The real KIND_WEIGHTS registry carries kinds no minimal fixture exercises.
 * Grandfathering everything except the kinds under test isolates the behavior
 * being asserted from the repository's real coverage backlog.
 */
function grandfatherAllBut(dirs: GateDirs, covered: string[]): void {
  fs.writeFileSync(
    dirs.coveragePath,
    JSON.stringify({ grandfathered: KNOWN_KINDS.filter(kind => !covered.includes(kind)) }),
  );
}

const KNOWN_KINDS = [
  'note:decision',
  'note:intent',
  'note:focus',
  'note:blocker',
  'note:insight',
  'episode:command_failure',
  'episode:test_cycle',
  'episode:session_summary',
  'session_state',
  'branch_snapshot',
  'project_snapshot',
  'command_run',
];

// ── Tests ─────────────────────────────────────────────────────────────

describe('eval gate — suite comparison', () => {
  it('passes when every suite matches its baseline', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(true);
    expect(result.suites.map(suite => suite.suite)).toEqual(['alpha']);
  });

  it('evaluates every suite in the directory, not just one', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    seedSuite(dirs, 'beta');
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.suites.map(suite => suite.suite).sort()).toEqual(['alpha', 'beta']);
  });

  it('fails and names the suite and metric on a negative top1_hit delta', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    // Inflate the baseline so the current run reads as a regression.
    const baselinePath = path.join(dirs.baselinesDir, 'alpha.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      quality: { top1_hit: number };
    };
    baseline.quality.top1_hit += 1;
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    const rendered = result.lines.join('\n');
    expect(rendered).toContain('alpha');
    expect(rendered).toContain('top1_hit');
  });

  it('fails and names the metric on a negative recall_at_3 delta', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baselinePath = path.join(dirs.baselinesDir, 'alpha.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      quality: { recall_at_3: number };
    };
    baseline.quality.recall_at_3 += 1;
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('recall_at_3');
  });

  it('fails and names the metric when output_tokens grows', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baselinePath = path.join(dirs.baselinesDir, 'alpha.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      quality: { output_tokens: number };
    };
    baseline.quality.output_tokens -= 5;
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('output_tokens');
  });

  it('passes when a metric improves', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baselinePath = path.join(dirs.baselinesDir, 'alpha.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      quality: { top1_hit: number; output_tokens: number };
    };
    baseline.quality.top1_hit -= 1; // current run is better
    baseline.quality.output_tokens += 20; // current run is cheaper
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(true);
  });

  it('fails when a suite has no baseline, rather than skipping it', () => {
    const dirs = makeDirs();
    fs.writeFileSync(
      path.join(dirs.suitesDir, 'orphan.json'),
      JSON.stringify(suiteFor('note:decision'), null, 2),
    );
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('orphan');
  });
});

describe('eval gate — AD-5 kind coverage', () => {
  it('fails and names a registered kind that no suite exercises', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    // note:blocker is registered, unexercised, and deliberately not grandfathered.
    fs.writeFileSync(
      dirs.coveragePath,
      JSON.stringify({
        grandfathered: KNOWN_KINDS.filter(
          kind => kind !== 'note:decision' && kind !== 'note:blocker',
        ),
      }),
    );

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.kindCoverage.ok).toBe(false);
    expect(result.kindCoverage.uncovered).toContain('note:blocker');
    expect(result.lines.join('\n')).toContain('note:blocker');
  });

  it('passes when an unexercised kind is grandfathered', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.kindCoverage.ok).toBe(true);
  });

  it('counts a kind as covered once any suite seeds it', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha', 'note:decision');
    seedSuite(dirs, 'beta', 'note:blocker');
    grandfatherAllBut(dirs, ['note:decision', 'note:blocker']);

    const result = runEvalGate(dirs);
    expect(result.kindCoverage.ok).toBe(true);
    expect(result.kindCoverage.uncovered).toEqual([]);
  });
});

describe('eval gate — baseline regeneration', () => {
  it('writes a baseline only when explicitly asked', () => {
    const dirs = makeDirs();
    fs.writeFileSync(
      path.join(dirs.suitesDir, 'alpha.json'),
      JSON.stringify(suiteFor('note:decision'), null, 2),
    );
    grandfatherAllBut(dirs, ['note:decision']);

    // Running the gate must never create the missing baseline for you.
    runEvalGate(dirs);
    expect(fs.existsSync(path.join(dirs.baselinesDir, 'alpha.json'))).toBe(false);

    regenerateBaseline('alpha', dirs);
    expect(fs.existsSync(path.join(dirs.baselinesDir, 'alpha.json'))).toBe(true);
  });

  it('refuses to regenerate a suite that does not exist', () => {
    const dirs = makeDirs();
    expect(() => regenerateBaseline('nope', dirs)).toThrow(/nope/);
  });
});

describe('baseline justification check', () => {
  it('passes when no baseline file changed', () => {
    const verdict = checkBaselineJustification([], 'chore: unrelated change');
    expect(verdict.ok).toBe(true);
  });

  it('fails when a baseline changed with no justification trailer', () => {
    const verdict = checkBaselineJustification(
      ['eval/baselines/budget.json'],
      'feat: make recall better\n\nNo trailer here.',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('eval/baselines/budget.json');
  });

  it('passes when the commit body carries a non-empty justification trailer', () => {
    const verdict = checkBaselineJustification(
      ['eval/baselines/budget.json'],
      'feat: reshape recall output\n\nBaseline-Regenerated: budget grew by 4 tokens because\nthe contested marker is now rendered; the gain is measured in 1.2.',
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects an empty justification trailer', () => {
    const verdict = checkBaselineJustification(
      ['eval/baselines/budget.json'],
      'feat: something\n\nBaseline-Regenerated:   ',
    );
    expect(verdict.ok).toBe(false);
  });
});
