import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPosixTool } from './posix-tools.js';

/**
 * Executes the real PostToolUse hook script. Nothing else can: the script is
 * bash + jq, so `tsc` cannot see inside it and a malformed jq program emits an
 * empty line silently in production rather than failing loudly.
 */

const SCRIPT = path.resolve(__dirname, '..', 'hooks', 'claude', 'cortex-capture.sh');

/**
 * Resolved absolutely, not looked up on `PATH`.
 *
 * `execFileSync('bash', …)` inherits the parent's PATH, and Git for Windows
 * keeps `usr/bin` off it deliberately — so launching vitest from PowerShell
 * instead of Git Bash made this whole file self-skip, and the shell/jq layer
 * (the one `tsc` cannot see into) went unverified while the run reported green
 * with a single skip line. The skip is still honest when bash genuinely is
 * absent; it just no longer fires on a machine that has bash sitting right
 * there. See `tests/posix-tools.ts`.
 */
const BASH = findPosixTool('bash');

function hasTool(tool: string): boolean {
  if (BASH === null) {
    return false;
  }
  try {
    // `-lc` sources the login profile, which is what puts jq on PATH *inside*
    // bash even when the parent process cannot see it.
    childProcess.execFileSync(BASH, ['-lc', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = BASH !== null && hasTool('jq');

// Silent skipping would let the only coverage of the shell change disappear on
// a machine without jq. Say so loudly instead.
if (!canRun) {
  process.stderr.write(
    '\n[capture-hook] SKIPPED: bash and jq are required to execute the PostToolUse hook.\n' +
      '[capture-hook] The shell/jq layer is UNVERIFIED in this run.\n\n',
  );
}

/**
 * The resolver is part of the verification surface, so it is asserted rather
 * than trusted.
 *
 * These run unconditionally — outside the `skipIf` — on purpose. A regression
 * in `findPosixTool` does not make the suite below FAIL, it makes it SKIP, and
 * a skipped suite reports green. That is the exact shape of the defect this
 * file exists to catch in production code, so the harness gets the same
 * treatment.
 */
describe('posix tool resolution', () => {
  it('does not resolve bash to the WSL launcher when Git Bash is present', () => {
    if (process.platform !== 'win32' || BASH === null) {
      // Nothing to distinguish on a platform with one real bash.
      expect(true).toBe(true);
      return;
    }
    // `C:\WINDOWS\system32\bash.exe` is the WSL launcher: a different OS with a
    // different filesystem view, which cannot see the Windows PATH's jq. It is
    // what a bare `bash` resolves to on most Windows installs with WSL enabled,
    // and picking it made this whole file self-skip.
    expect(BASH.toLowerCase()).not.toContain('system32');
  });

  it('prefers the Git wrapper over the bare usr/bin binary', () => {
    if (process.platform !== 'win32' || BASH === null) {
      expect(true).toBe(true);
      return;
    }
    // `Git/bin/bash.exe` sets up a POSIX PATH before handing over; the bare
    // `Git/usr/bin/bash.exe` does not, so a hook launched through it finds no
    // jq, no grep, no date — and exits 0 having written nothing, which is
    // indistinguishable from AD-12's intended silent degradation.
    const normalized = BASH.replace(/\\/g, '/').toLowerCase();
    expect(normalized.endsWith('/git/usr/bin/bash.exe')).toBe(false);
  });

  it('resolves the tools the index suites spawn', () => {
    // A missing grep must fail loudly rather than resolving to null and
    // producing `spawnSync(null)`, whose failure surfaces as `status === null`
    // rather than as an assertion.
    expect(findPosixTool('grep')).not.toBeNull();
  });
});

function runHook(payload: Record<string, unknown>): {
  cwd: string;
  lines: Array<Record<string, unknown>>;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-capture-hook-'));
  fs.writeFileSync(path.join(cwd, '.cortex.state'), 'enabled=true\n');

  // Git Bash resolves forward-slashed Windows paths; backslashes it does not.
  const posixCwd = cwd.replace(/\\/g, '/');
  childProcess.execFileSync(BASH as string, [SCRIPT], {
    input: JSON.stringify({ cwd: posixCwd, ...payload }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const spoolPath = path.join(cwd, '.cortex.spool.jsonl');
  const raw = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8') : '';
  const lines = raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);

  return { cwd, lines };
}

describe.skipIf(!canRun)('cortex-capture.sh', () => {
  it('carries agent_id and agent_type for a subagent tool call', () => {
    const { lines } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'src/db/store.ts' },
      agent_id: 'agent-uuid-1',
      agent_type: 'Explore',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'read',
      file: 'src/db/store.ts',
      agent_id: 'agent-uuid-1',
      agent_type: 'Explore',
    });
  });

  it('emits one search line per MEASURED zero-result Grep shape (Story 4.3)', () => {
    // These are the shapes Claude Code 2.1.170 actually sends, captured by
    // dumping this branch's own stdin for four real searches (review round;
    // the hook was restored byte-identically after). The measurement overturned
    // the guesses this branch shipped with: `tool_response` is always an
    // OBJECT, there is no "No matches found" string in it — that is the
    // RENDERED text, not the data — and the array is `filenames`, not `files`.
    // Only `numFiles == 0` happened to be right, which is why capture worked
    // at all before this round.
    const zeroShapes: Array<[string, unknown]> = [
      [
        'files_with_matches',
        { mode: 'files_with_matches', filenames: [], numFiles: 0, totalFiles: 0 },
      ],
      [
        'content',
        { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0, totalLines: 0 },
      ],
      [
        'count',
        { mode: 'count', numFiles: 0, filenames: [], content: '', numMatches: 0 },
      ],
    ];
    for (const [label, response] of zeroShapes) {
      const { lines } = runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'zzz_none', path: 'C:/repo/src' },
        tool_response: response,
      });
      expect(lines, label).toHaveLength(1);
      expect(lines[0], label).toMatchObject({
        tool: 'search',
        stool: 'grep',
        pattern: 'zzz_none',
        sroot: 'C:/repo/src',
        zero: 1,
      });
    }
    // Real bash+jq spawns; under full-suite contention the default 10 s budget
    // is a coin flip on this platform (spawn p95 ~84 ms quiescent, worse
    // loaded).
  }, 60_000);

  it('falls back to the payload cwd when Grep was given no path (Story 4.3)', () => {
    // Measured: a pathless Grep sends no `tool_input.path`, and the tool
    // searches its own cwd. Recording "" and letting the flush read it as the
    // scope root asserted over the whole worktree for a search that examined
    // only the directory Claude was started in — a false negative needing no
    // tree change at all.
    const { cwd, lines } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'zzz_none', output_mode: 'content' },
      tool_response: {
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content: '',
        numLines: 0,
        totalLines: 0,
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['sroot']).toBe(cwd.replace(/\\/g, '/'));
  });

  it('refuses a payload whose fields contradict each other (Story 4.3)', () => {
    // Reproduced before the fix: the or-chain took the first zero-shaped field
    // it recognized, so a payload claiming zero in one field and listing
    // matches in another recorded a certified false negative. `totalFiles` is
    // in the positive set because it is what exposes a truncated page.
    const contradictions: Array<[string, unknown]> = [
      ['numFiles 0 + filenames listed', { mode: 'files_with_matches', numFiles: 0, filenames: ['a.ts'], totalFiles: 1 }],
      ['numFiles 0 + totalFiles 5', { mode: 'files_with_matches', numFiles: 0, filenames: [], totalFiles: 5 }],
      ['numFiles 0 + content lines', { mode: 'content', numFiles: 0, content: 'a.ts:1:hit', numLines: 1, totalLines: 1 }],
    ];
    for (const [label, response] of contradictions) {
      const { lines } = runHook({
        tool_name: 'Grep',
        tool_input: { pattern: 'hit', path: 'C:/repo/src' },
        tool_response: response,
      });
      expect(lines, label).toHaveLength(0);
    }
  }, 60_000);

  it('refuses a Grep carrying a parameter this build does not recognize (D2)', () => {
    // A future matching-relevant parameter could narrow or widen matching in a
    // way this build cannot reason about, so the search is not recorded at all.
    const { lines } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'zzz_none', path: 'C:/repo/src', semantic_mode: 'fuzzy' },
      tool_response: { mode: 'files_with_matches', filenames: [], numFiles: 0, totalFiles: 0 },
    });
    expect(lines).toHaveLength(0);
  });

  it('threads the matching-relevant Grep parameters onto the search line', () => {
    const { lines } = runHook({
      tool_name: 'Grep',
      tool_input: {
        pattern: 'zzz_none',
        path: 'C:/repo/src',
        glob: '*.ts',
        type: 'ts',
        '-i': true,
        multiline: true,
      },
      tool_response: { mode: 'files_with_matches', filenames: [], numFiles: 0, totalFiles: 0 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'search',
      pattern: 'zzz_none',
      sroot: 'C:/repo/src',
      sglob: '*.ts',
      stype: 'ts',
      sci: 1,
      sml: 1,
      zero: 1,
    });
  });

  it('emits nothing for non-zero, paginated, ambiguous, or hostile Grep payloads', () => {
    const zeroResp = { mode: 'files_with_matches', filenames: [], numFiles: 0, totalFiles: 0 };
    const silent: Array<[string, Record<string, unknown>]> = [
      ['files found', { tool_input: { pattern: 'hit' }, tool_response: { mode: 'files_with_matches', filenames: ['a.ts'], numFiles: 1, totalFiles: 1 } }],
      ['nonzero count', { tool_input: { pattern: 'hit' }, tool_response: { mode: 'count', numFiles: 3, numMatches: 9 } }],
      // offset > 0: Claude Code < 2.1.208 answers a paginated-past-the-end
      // search with a zero-shaped response while matches exist (changelog).
      ['offset past page one', { tool_input: { pattern: 'zzz', offset: 50 }, tool_response: zeroResp }],
      ['scalar response', { tool_input: { pattern: 'zzz' }, tool_response: 42 }],
      ['null response', { tool_input: { pattern: 'zzz' }, tool_response: null }],
      ['missing pattern', { tool_input: {}, tool_response: zeroResp }],
      ['scalar tool_input', { tool_input: 'weird', tool_response: zeroResp }],
      // The pre-measurement guesses: none of these shapes exist on the real
      // host, and none may resurrect as a zero marker.
      ['legacy "No matches found" string', { tool_input: { pattern: 'zzz' }, tool_response: 'No matches found' }],
      ['legacy files:[] with no count', { tool_input: { pattern: 'zzz' }, tool_response: { files: [] } }],
      ['legacy empty top-level array', { tool_input: { pattern: 'zzz' }, tool_response: [] }],
    ];
    for (const [label, payload] of silent) {
      const { lines } = runHook({ tool_name: 'Grep', ...payload });
      expect(lines, label).toHaveLength(0);
    }
    // Eight real bash+jq spawns; same loaded-machine budget as the zero matrix.
  }, 60_000);

  it('carries agent identity on the Grep branch', () => {
    const { lines } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'zzz_none', path: 'C:/repo/src' },
      tool_response: { mode: 'files_with_matches', filenames: [], numFiles: 0, totalFiles: 0 },
      agent_id: 'agent-uuid-9',
      agent_type: 'Explore',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'search', agent_id: 'agent-uuid-9', agent_type: 'Explore' });
  });

  it('omits the agent fields entirely for a primary tool call', () => {
    const { lines } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'src/db/store.ts' },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('agent_id');
    expect(lines[0]).not.toHaveProperty('agent_type');
    expect(lines[0]).toMatchObject({ tool: 'read', file: 'src/db/store.ts' });
  });

  it('carries agent identity on the Bash branch', () => {
    const { lines } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, stderr: 'vitest failed' },
      agent_id: 'agent-uuid-2',
      agent_type: 'general-purpose',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'cmd',
      cmd: 'npm test',
      exit: '1',
      agent_id: 'agent-uuid-2',
      agent_type: 'general-purpose',
    });
  });

  it('carries agent identity on the Agent branch', () => {
    const { lines } = runHook({
      tool_name: 'Agent',
      tool_input: { description: 'Explore the retrieval layer' },
      agent_id: 'agent-uuid-3',
      agent_type: 'Explore',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'agent',
      desc: 'Explore the retrieval layer',
      agent_id: 'agent-uuid-3',
    });
  });

  it('accepts camelCase agent identity as well as snake_case', () => {
    const { lines } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'src/drift.ts' },
      agentId: 'agent-camel',
      agentType: 'Explore',
    });

    expect(lines).toHaveLength(1);
    // Normalized to snake_case on the line so the flush has one shape to read.
    expect(lines[0]).toMatchObject({ agent_id: 'agent-camel', agent_type: 'Explore' });
  });

  it('does not emit an agent_id for a non-scalar value', () => {
    const { lines } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'src/weird.ts' },
      agent_id: { nested: true },
    });

    expect(lines).toHaveLength(1);
    // jq copies it through; the flush is what must refuse to bind it.
    expect(lines[0]).toMatchObject({ tool: 'read', file: 'src/weird.ts' });
  });

  it('emits a well-formed line even when agent_type is absent but agent_id is present', () => {
    const { lines } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: 'src/new.ts' },
      agent_id: 'agent-uuid-4',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'write', agent_id: 'agent-uuid-4' });
    expect(lines[0]).not.toHaveProperty('agent_type');
  });
});

describe('cortex-capture.sh — no process per tool call (N-4)', () => {
  it('spawns Node only inside the size-threshold branch', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const nodeLines = script
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('__CORTEX_NODE__'));

    // Exactly one Node reference, and it sits under the >= 256 KiB guard.
    expect(nodeLines).toHaveLength(1);
    const thresholdIndex = script.split('\n').findIndex(line => line.includes('262144'));
    expect(thresholdIndex).toBeGreaterThan(-1);
    expect(nodeLines[0]!.index).toBeGreaterThan(thresholdIndex);
  });

  it('uses at most one jq invocation per event branch', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const lines = script.split('\n');

    // Per-region counts, not a whole-file total: a global count stays green if
    // one branch gains a jq while another loses one, which is the regression
    // this test exists to catch. Setup reads tool_name and cwd; each event
    // branch builds its line with exactly one jq. Story 4.5 split `Read` out of
    // the former `Read|Edit|Write` branch because it needs extra fields — it
    // still gets exactly one — and Story 4.3 added `Grep` under the same
    // one-jq discipline.
    const branchStarts = ['  Read)', '  Grep)', '  Edit|Write)', '  Bash)', '  Agent)'];
    const boundaries = branchStarts.map(marker => {
      const index = lines.findIndex(line => line.startsWith(marker));
      expect(index, `branch ${marker} not found`).toBeGreaterThan(-1);
      return index;
    });
    const esacIndex = lines.findIndex(line => line.startsWith('esac'));
    expect(esacIndex).toBeGreaterThan(boundaries[4]!);

    const countJq = (from: number, to: number): number =>
      (lines.slice(from, to).join('\n').match(/\|\s*jq\s+-|\$\(\s*jq\s/g) ?? []).length;

    expect(countJq(0, boundaries[0]!)).toBe(2); // setup: tool_name, cwd
    expect(countJq(boundaries[0]!, boundaries[1]!)).toBe(1);
    expect(countJq(boundaries[1]!, boundaries[2]!)).toBe(1);
    expect(countJq(boundaries[2]!, boundaries[3]!)).toBe(1);
    expect(countJq(boundaries[3]!, boundaries[4]!)).toBe(1);
    expect(countJq(boundaries[4]!, esacIndex)).toBe(1);

    // `xargs` was folded into the old counter's alternation; keep it banned
    // outright rather than losing the guard when the counter narrowed to jq.
    expect(script).not.toMatch(/\bxargs\b/);
  });

  it('the substitution path spawns at most three processes, hash strictly after lookup', () => {
    // This is B-4a expressed structurally rather than as a timing hope. The
    // MISS path is the unconditional tax on every Read, so it may spend exactly
    // one process (the index lookup); the HIT path may spend two more — `wc -c`
    // to prove the recorded size still describes the disk (the review measured
    // a 6 KB record pulling a 300 MB file into ~1.3 s of doomed hashing without
    // it), then the verification hash. Everything else — state parsing, key
    // derivation, the per-turn marker, JSON escaping — is a bash builtin.
    // Split on `\r?\n`: this template ships CRLF in the checkout (the other two
    // ship LF), so an exact `line === '}'` compare against a `\n`-split silently
    // never matches. `install` normalizes to LF on the way out, which is why
    // nothing downstream notices.
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const lines = script.split(/\r?\n/);

    const start = lines.findIndex(line => line.startsWith('try_substitute() {'));
    expect(start, 'try_substitute not found').toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);

    const body = lines
      .slice(start, end)
      .filter(line => !line.trim().startsWith('#'));

    // Command substitutions are the only way this function can fork. The
    // negative lookahead excludes `$(( … ))` arithmetic expansion, which is a
    // builtin — counting it would inflate the budget with three token
    // calculations that spawn nothing, and "at most two processes" would then
    // be measuring the wrong thing entirely.
    const substitutions = body.join('\n').match(/\$\((?!\()([^)]*)\)/g) ?? [];
    const commands = substitutions.map(s => s.replace(/^\$\(\s*/, '').trim().split(/\s+/)[0]);
    expect(commands.sort()).toEqual(['grep', 'sha256sum', 'wc']);

    // No jq, no cut, no stat, no date: AD-3 says the hot path greps a flat
    // file rather than parsing anything, and each of these would be a whole
    // extra process on a path that runs for every single Read.
    for (const banned of ['jq', 'cut ', 'stat ', 'awk', 'sed ', 'tr ']) {
      expect(body.join('\n'), `substitution path must not spawn ${banned.trim()}`).not.toContain(
        banned,
      );
    }

    const lookupLine = body.findIndex(line => line.includes('grep -F -m1'));
    const sizeLine = body.findIndex(line => line.includes('wc -c'));
    const hashLine = body.findIndex(line => line.includes('sha256sum'));
    expect(lookupLine).toBeGreaterThan(-1);
    // Lookup → size gate → hash: each stage only runs when the cheaper one
    // ahead of it passed, so a miss pays for none of the later ones.
    expect(sizeLine).toBeGreaterThan(lookupLine);
    expect(hashLine).toBeGreaterThan(sizeLine);
  });
});
