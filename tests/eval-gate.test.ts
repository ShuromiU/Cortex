import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProgram } from '../src/transports/cli.js';
import { KIND_WEIGHTS } from '../src/memory/kind-weights.js';
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
function suiteFor(kind: string, extra: Record<string, unknown> = {}): unknown {
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
    fixtures: [{ topic: 'gate topic', expected_top: 'gate-item', ...extra }],
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

function writeSuite(dirs: GateDirs, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dirs.suitesDir, `${name}.json`), JSON.stringify(body, null, 2));
}

/** Write a suite plus a baseline generated from it, i.e. a green starting point. */
function seedSuite(dirs: GateDirs, name: string, kind = 'note:decision'): void {
  writeSuite(dirs, name, suiteFor(kind));
  regenerateBaseline(name, dirs);
}

/**
 * `KIND_WEIGHTS` is the single source of truth (CLAUDE.md). Importing it rather
 * than restating the list keeps a new kind from turning unrelated tests red and
 * training the grandfathering reflex this gate exists to resist.
 */
function grandfatherAllBut(dirs: GateDirs, covered: string[]): void {
  fs.writeFileSync(
    dirs.coveragePath,
    JSON.stringify({
      grandfathered: Object.keys(KIND_WEIGHTS).filter(kind => !covered.includes(kind)),
    }),
  );
}

function baselineOf(dirs: GateDirs, name: string): Record<string, never> & {
  quality: Record<string, number>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(dirs.baselinesDir, `${name}.json`), 'utf8'),
  ) as never;
}

function writeBaseline(dirs: GateDirs, name: string, value: unknown): void {
  fs.writeFileSync(
    path.join(dirs.baselinesDir, `${name}.json`),
    JSON.stringify(value, null, 2),
  );
}

// ── Suite comparison ──────────────────────────────────────────────────

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

    expect(runEvalGate(dirs).suites.map(suite => suite.suite).sort()).toEqual(['alpha', 'beta']);
  });

  it('reports the two non-gating metrics alongside the gated ones', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const rendered = runEvalGate(dirs).lines.join('\n');
    for (const metric of ['top1_hit', 'recall_at_3', 'output_tokens', 'noise_count', 'stale_count']) {
      expect(rendered).toContain(metric);
    }
  });

  it.each([
    ['top1_hit', (q: Record<string, number>) => { q['top1_hit'] = (q['top1_hit'] ?? 0) + 1; }],
    ['recall_at_3', (q: Record<string, number>) => { q['recall_at_3'] = (q['recall_at_3'] ?? 0) + 1; }],
    ['output_tokens', (q: Record<string, number>) => { q['output_tokens'] = (q['output_tokens'] ?? 0) - 5; }],
  ])('fails and names the suite and %s on a regression', (metric, mutate) => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baseline = baselineOf(dirs, 'alpha');
    mutate(baseline.quality);
    writeBaseline(dirs, 'alpha', baseline);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    const rendered = result.lines.join('\n');
    expect(rendered).toContain('alpha');
    expect(rendered).toContain(metric);
  });

  it('names the baseline value it regressed from', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baseline = baselineOf(dirs, 'alpha');
    const was = baseline.quality['output_tokens']!;
    baseline.quality['output_tokens'] = was - 5;
    writeBaseline(dirs, 'alpha', baseline);

    expect(runEvalGate(dirs).lines.join('\n')).toContain(`baseline ${was - 5} → now ${was}`);
  });

  it('passes when a metric improves', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baseline = baselineOf(dirs, 'alpha');
    baseline.quality['top1_hit'] = baseline.quality['top1_hit']! - 1;
    baseline.quality['output_tokens'] = baseline.quality['output_tokens']! + 20;
    writeBaseline(dirs, 'alpha', baseline);

    expect(runEvalGate(dirs).ok).toBe(true);
  });

  it('fails when a suite has no baseline, rather than skipping it', () => {
    const dirs = makeDirs();
    writeSuite(dirs, 'orphan', suiteFor('note:decision'));
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('orphan');
  });
});

// ── The ways a gate silently stops gating ─────────────────────────────

describe('eval gate — cannot be silently disabled', () => {
  it.each(['top1_hit', 'recall_at_3', 'output_tokens'])(
    'fails when the baseline is missing %s rather than treating NaN as no-change',
    metric => {
      const dirs = makeDirs();
      seedSuite(dirs, 'alpha');
      grandfatherAllBut(dirs, ['note:decision']);

      const baseline = baselineOf(dirs, 'alpha');
      delete baseline.quality[metric];
      writeBaseline(dirs, 'alpha', baseline);

      const result = runEvalGate(dirs);
      expect(result.ok).toBe(false);
      expect(result.lines.join('\n')).toContain(metric);
    },
  );

  it('fails on a baseline whose quality block is empty', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baseline = baselineOf(dirs, 'alpha');
    baseline.quality = {};
    writeBaseline(dirs, 'alpha', baseline);

    expect(runEvalGate(dirs).ok).toBe(false);
  });

  it('fails when a suite file was deleted and left an orphaned baseline', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    seedSuite(dirs, 'beta');
    grandfatherAllBut(dirs, ['note:decision']);
    expect(runEvalGate(dirs).ok).toBe(true);

    fs.unlinkSync(path.join(dirs.suitesDir, 'beta.json'));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('beta');
  });

  it('fails a fixture whose output assertion is unsatisfiable', () => {
    const dirs = makeDirs();
    // Baseline the honest version first, so the aggregate deltas stay flat and
    // only the fixture assertion can be what fails.
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);
    writeSuite(dirs, 'alpha', suiteFor('note:decision', {
      expect_output_contains: ['THIS_STRING_WILL_NEVER_APPEAR'],
    }));

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('THIS_STRING_WILL_NEVER_APPEAR');
  });

  it('fails a suite with no fixtures instead of scoring it zero and passing', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);
    writeSuite(dirs, 'empty', { seed: { items: [] }, fixtures: [] });

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('empty');
  });

  it('fails a suite with no seed instead of evaluating against an empty store', () => {
    const dirs = makeDirs();
    const suite = suiteFor('note:decision') as Record<string, unknown>;
    delete suite['seed'];
    writeSuite(dirs, 'noseed', suite);
    grandfatherAllBut(dirs, ['note:decision']);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('noseed');
  });

  it('reports a malformed suite without aborting the suites that follow it', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'zzz-valid');
    grandfatherAllBut(dirs, ['note:decision']);
    fs.writeFileSync(path.join(dirs.suitesDir, 'aaa-broken.json'), '{ not json');

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    const rendered = result.lines.join('\n');
    expect(rendered).toContain('aaa-broken');
    // The valid suite sorted after the broken one still ran.
    expect(rendered).toContain('zzz-valid');
  });

  it('reports a malformed baseline rather than throwing', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);
    fs.writeFileSync(path.join(dirs.baselinesDir, 'alpha.json'), 'not json at all');

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('alpha');
  });

  it('fails on a coverage manifest that is null or malformed, grandfathering nothing', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    fs.writeFileSync(dirs.coveragePath, 'null');

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.kindCoverage.uncovered.length).toBeGreaterThan(0);
  });

  it('flags a non-suite file sitting in the suites directory', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);
    fs.writeFileSync(path.join(dirs.suitesDir, 'notes.txt'), 'stray');

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('notes.txt');
  });
});

// ── AD-5 kind coverage ────────────────────────────────────────────────

describe('eval gate — AD-5 kind coverage', () => {
  it('fails and names a registered kind that no suite exercises', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision', 'note:blocker']);

    const result = runEvalGate(dirs);
    expect(result.ok).toBe(false);
    expect(result.kindCoverage.uncovered).toContain('note:blocker');
    expect(result.lines.join('\n')).toContain('note:blocker');
  });

  it('passes when an unexercised kind is grandfathered', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    expect(runEvalGate(dirs).kindCoverage.ok).toBe(true);
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

// ── The repository's own locked artifacts ─────────────────────────────

describe('the repository gate', () => {
  it('passes against the real suites and baselines', () => {
    expect(runEvalGate().ok).toBe(true);
  });

  it('grandfathers exactly the kinds no real suite exercises, and no more', () => {
    // Pins the escape hatch: widening `grandfathered` now requires editing this
    // assertion, so it cannot be done quietly in a JSON array.
    const manifest = JSON.parse(fs.readFileSync('eval/kind-coverage.json', 'utf8')) as {
      grandfathered: string[];
    };
    const covered = new Set(
      fs
        .readdirSync('eval/suites')
        .filter(file => file.endsWith('.json'))
        .flatMap(file => {
          const suite = JSON.parse(fs.readFileSync(path.join('eval/suites', file), 'utf8')) as {
            seed?: { items?: Array<{ kind?: string }> };
          };
          return (suite.seed?.items ?? []).map(item => item.kind).filter(Boolean) as string[];
        }),
    );

    expect([...manifest.grandfathered].sort()).toEqual(
      Object.keys(KIND_WEIGHTS).filter(kind => !covered.has(kind)).sort(),
    );
  });

  it('registers every memory_items kind that source code writes', () => {
    // AC #4 detects a new key in KIND_WEIGHTS, but memory_items.kind has no
    // constraint — so a kind could ship unregistered and stay invisible.
    const literals = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          for (const match of source.matchAll(/kind:\s*'((?:note|episode):[a-z_]+)'/g)) {
            literals.add(match[1]!);
          }
        }
      }
    };
    walk('src');

    const unregistered = [...literals].filter(kind => !(kind in KIND_WEIGHTS));
    expect(unregistered).toEqual([]);
  });
});

// ── Regeneration ──────────────────────────────────────────────────────

describe('eval gate — baseline regeneration', () => {
  it('writes a baseline only when explicitly asked', () => {
    const dirs = makeDirs();
    writeSuite(dirs, 'alpha', suiteFor('note:decision'));
    grandfatherAllBut(dirs, ['note:decision']);

    runEvalGate(dirs);
    expect(fs.existsSync(path.join(dirs.baselinesDir, 'alpha.json'))).toBe(false);

    regenerateBaseline('alpha', dirs);
    expect(fs.existsSync(path.join(dirs.baselinesDir, 'alpha.json'))).toBe(true);
  });

  it('refuses to regenerate a suite that does not exist', () => {
    const dirs = makeDirs();
    expect(() => regenerateBaseline('nope', dirs)).toThrow(/nope/);
  });

  it.each(['../escape', 'nested/alpha', '', '  '])(
    'refuses the suite name %j so a baseline cannot be written outside the directory',
    name => {
      const dirs = makeDirs();
      seedSuite(dirs, 'alpha');
      expect(() => regenerateBaseline(name, dirs)).toThrow(/bare file name|No locked suite/);
    },
  );

  it('reports the regressions it is about to bake in', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    const baseline = baselineOf(dirs, 'alpha');
    baseline.quality['output_tokens'] = baseline.quality['output_tokens']! - 5;
    writeBaseline(dirs, 'alpha', baseline);

    expect(regenerateBaseline('alpha', dirs).accepted.join('\n')).toContain('output_tokens');
  });
});

// ── The CLI: the line that makes it a gate ────────────────────────────

describe('cortex eval-gate command', () => {
  const previousExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  function run(dirs: GateDirs, extra: string[] = []): { exitCode: number | undefined; out: string } {
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = undefined;
    try {
      createProgram().parse(
        [
          'node', 'cortex', 'eval-gate',
          '--suites', dirs.suitesDir,
          '--baselines', dirs.baselinesDir,
          '--coverage', dirs.coveragePath,
          ...extra,
        ],
      );
    } finally {
      process.stdout.write = write;
    }
    return { exitCode: process.exitCode as number | undefined, out };
  }

  it('exists as a subcommand', () => {
    expect(createProgram().commands.map(command => command.name())).toContain('eval-gate');
  });

  it('exits 0 and prints the report when every suite passes', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const { exitCode, out } = run(dirs);
    expect(exitCode).toBeFalsy();
    expect(out).toContain('gate passed');
  });

  it('exits NON-ZERO on a regression — the line that makes this a gate', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    const baseline = baselineOf(dirs, 'alpha');
    baseline.quality['top1_hit'] = baseline.quality['top1_hit']! + 1;
    writeBaseline(dirs, 'alpha', baseline);

    const { exitCode, out } = run(dirs);
    expect(exitCode).toBe(1);
    expect(out).toContain('FAIL');
    expect(out).toContain('top1_hit');
  });

  it('exits non-zero when a registered kind has no fixture', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision', 'note:blocker']);

    expect(run(dirs).exitCode).toBe(1);
  });

  it('exits non-zero rather than running the gate when the suite name is empty', () => {
    const dirs = makeDirs();
    seedSuite(dirs, 'alpha');
    grandfatherAllBut(dirs, ['note:decision']);

    expect(run(dirs, ['--regenerate-baseline', '']).exitCode).toBe(1);
  });
});

// ── Justification ─────────────────────────────────────────────────────

describe('baseline justification', () => {
  const commit = (
    body: string,
    files: string[],
    status = 'M',
  ): { body: string; files: Array<{ path: string; status: string }> } => ({
    body,
    files: files.map(path => ({ path, status })),
  });

  it('passes when no guarded artifact changed', () => {
    expect(checkBaselineJustification([commit('chore: unrelated', ['src/a.ts'])]).ok).toBe(true);
  });

  it('fails when a baseline changed with no justification trailer', () => {
    const verdict = checkBaselineJustification([
      commit('feat: make recall better\n\nNo trailer here.', ['eval/baselines/budget.json']),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('eval/baselines/budget.json');
  });

  it('passes when the same commit carries a non-empty trailer', () => {
    expect(
      checkBaselineJustification([
        commit(
          'feat: reshape recall output\n\nBaseline-Regenerated: the contested marker is now\nrendered; the accuracy gain is measured in 1.2.',
          ['eval/baselines/budget.json'],
        ),
      ]).ok,
    ).toBe(true);
  });

  it('rejects an empty or placeholder trailer', () => {
    for (const body of [
      'feat: x\n\nBaseline-Regenerated:   ',
      'feat: x\n\nBaseline-Regenerated: <why this quality change is intended>',
    ]) {
      expect(checkBaselineJustification([commit(body, ['eval/baselines/budget.json'])]).ok).toBe(false);
    }
  });

  it('does not let another commit in the range launder the change', () => {
    const verdict = checkBaselineJustification([
      commit('fix: unrelated tweak', ['eval/baselines/budget.json']),
      commit('docs: tidy\n\nBaseline-Regenerated: n/a', ['README.md']),
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('guards the kind-coverage manifest as well as baselines', () => {
    const verdict = checkBaselineJustification([
      commit('feat: add a kind', ['eval/kind-coverage.json']),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('kind-coverage');
  });

  it('handles Windows path separators', () => {
    expect(
      checkBaselineJustification([commit('feat: x', ['eval\\baselines\\budget.json'])]).ok,
    ).toBe(false);
  });

  it('does not fire on a path that merely contains the guarded name', () => {
    expect(
      checkBaselineJustification([commit('docs: x', ['docs/eval/baselines-notes.md'])]).ok,
    ).toBe(true);
  });

  it('does not demand justification for ADDING a locked artifact', () => {
    // A new suite needs a new baseline; the suite's own correctness is gated
    // separately. Only changing or removing an existing one is a regeneration.
    expect(
      checkBaselineJustification([
        commit('feat: add a suite', ['eval/baselines/new-suite.json'], 'A'),
      ]).ok,
    ).toBe(true);
  });

  it('demands justification for DELETING a locked artifact', () => {
    expect(
      checkBaselineJustification([
        commit('chore: drop a suite', ['eval/baselines/budget.json'], 'D'),
      ]).ok,
    ).toBe(false);
  });
});
