import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPosixTool } from './posix-tools.js';
import { renderHookScript } from '../src/query/install.js';
import { REQUIRED_WIRING } from '../src/query/doctor.js';
import { SHELL_MEMORY_COMMANDS } from '../src/query/memory-guard.js';

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

// ── cortex-subagent.sh (FR-17, Story 5.1) ───────────────────────────
//
// The raw template is executed, not a rendered copy: the surviving
// `__CORTEX_NODE__` placeholder is not a real executable, so any path that
// reaches the Node invocation fails loudly. That makes it the stronger harness
// for a guard whose whole job is to NOT reach it.
const SUBAGENT_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'claude', 'cortex-subagent.sh');

function runSubagentHook(
  payload: Record<string, unknown>,
  engagement: string | null,
  action?: string,
): { status: number | null; stdout: string; stderr: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-hook-'));
  if (engagement !== null) {
    fs.writeFileSync(path.join(cwd, '.cortex.state'), engagement);
  }
  const posixCwd = cwd.replace(/\\/g, '/');
  const result = childProcess.spawnSync(
    BASH as string,
    action === undefined ? [SUBAGENT_SCRIPT] : [SUBAGENT_SCRIPT, action],
    {
      input: JSON.stringify({ cwd: posixCwd, ...payload }),
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!canRun)('cortex-subagent.sh', () => {
  const payload = {
    hook_event_name: 'SubagentStart',
    agent_id: 'a1b2c3d4e5f60718',
    agent_type: 'general-purpose',
  };

  // Every case below passes the action EXPLICITLY, because that is the only
  // form `install` writes and the only form `doctor` accepts. Testing the
  // arg-less form would exercise an invocation that never ships.
  const WIRED = 'subagent-start';

  // AC #3, bash half. If this leaks, the placeholder is invoked and the run
  // fails — so a pass here really does mean Node was never reached.
  it('exits silently without reaching Node when the project is disengaged', () => {
    const result = runSubagentHook(payload, 'enabled=false\n', WIRED);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits silently when there is no state file at all', () => {
    const result = runSubagentHook(payload, null, WIRED);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('does not read enabled=true out of a substring', () => {
    const result = runSubagentHook(payload, 'not_enabled=true\n', WIRED);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  // The action carries no default, so an arg-less wiring — the form `doctor`
  // refuses — must also do nothing. Otherwise a refused wiring silently works
  // and `install` appends a second entry beside it.
  it('does nothing when invoked with no action at all', () => {
    const result = runSubagentHook(payload, 'enabled=true\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits without reaching Node when the payload carries no cwd', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-hook-'));
    fs.writeFileSync(path.join(cwd, '.cortex.state'), 'enabled=true\n');
    const result = childProcess.spawnSync(BASH as string, [SUBAGENT_SCRIPT], {
      input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'x' }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr ?? '').toBe('');
  });

  // An unrecognised action must not reach Node: `handleHookPayload` routes
  // anything it does not know to the reflex path, which resolves — and can
  // create — a PRIMARY session. A mis-wired argument would then rotate the
  // parent's session on every dispatch.
  it('refuses an action it does not recognise, even when engaged', () => {
    const result = runSubagentHook(payload, 'enabled=true\n', 'reflect-prompt');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('reaches Node for subagent-start when engaged — proving the guards above are load-bearing', () => {
    // The placeholder is not an executable, so a non-zero exit or a populated
    // stderr is the evidence that this path DOES try to invoke Node. Without
    // this, every assertion above would pass with the invocation deleted.
    const result = runSubagentHook(payload, 'enabled=true\n', WIRED);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  // ── guard-memory: N-4 asserted on PROCESS BEHAVIOUR ────────────────
  //
  // This arm's matcher includes `Bash`, so it fires on every command the agent
  // runs, and spawning Node there is the one thing AD-2/N-4 forbids outright.
  // Reading the script would only prove the lines are in some order; running it
  // against an unsubstituted `__CORTEX_NODE__` proves Node was never invoked,
  // because invoking it fails loudly.
  const GUARD = 'guard-memory';

  it('never reaches Node for an ordinary shell command from a subagent', () => {
    const result = runSubagentHook(
      {
        hook_event_name: 'PreToolUse',
        agent_id: 'a1b2c3d4e5f60718',
        tool_name: 'Bash',
        tool_input: { command: 'npm run build && git status' },
      },
      'enabled=true\n',
      GUARD,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('never reaches Node for the PARENT, whose tool call carries no agent_id', () => {
    const result = runSubagentHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__cortex__cortex_note',
        tool_input: { kind: 'decision', subject: 'x', content: 'y' },
      },
      'enabled=true\n',
      GUARD,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  for (const command of SHELL_MEMORY_COMMANDS) {
    it(`reaches Node for a subagent running \`cortex ${command}\``, () => {
      // The other half of the same guarantee: if the text screen were too
      // narrow the guard would simply never be asked, and every deny-path test
      // in the TypeScript suite would still pass.
      const result = runSubagentHook(
        {
          hook_event_name: 'PreToolUse',
          agent_id: 'a1b2c3d4e5f60718',
          tool_name: 'Bash',
          tool_input: { command: `cortex ${command} abc123 --yes` },
        },
        'enabled=true\n',
        GUARD,
      );
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  }

  it('reaches Node for a subagent’s cortex_note without any text screening', () => {
    const result = runSubagentHook(
      {
        hook_event_name: 'PreToolUse',
        agent_id: 'a1b2c3d4e5f60718',
        tool_name: 'mcp__cortex__cortex_note',
        tool_input: { kind: 'decision', subject: 'x', content: 'y' },
      },
      'enabled=true\n',
      GUARD,
    );
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// These read files and assert on their text. They must NOT sit inside
// `describe.skipIf(!canRun)`: a machine where bash cannot be resolved would
// skip them silently and report green, which is the exact shape
// `docs/invariants.md:101` records — the shell layer going unverified while the
// run looks clean. They need no shell, so they always run.
describe('cortex-subagent.sh — structure', () => {
  it('is a per-dispatch path only: one Node invocation, no hot-path work (N-4)', () => {
    const script = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8');
    const lines = script.split(/\r?\n/).filter(line => !line.trim().startsWith('#'));
    const body = lines.join('\n');

    // ONE Node invocation per FIRE, which is the invariant — not one per file.
    // Story 5.2 added a second arm (`dispatch-pre` on PreToolUse), and a `case`
    // executes exactly one arm, so the count that matters is per arm. Asserted
    // as "every Node line sits inside its own case arm, and there are exactly as
    // many as there are arms": a second invocation smuggled into ONE arm still
    // fails, which is the regression this guards.
    const armLines = lines.filter(line => /^\s{2}[a-z-]+\)\s*$/.test(line));
    const nodeLines = lines.filter(line => line.includes('__CORTEX_NODE__'));
    expect(armLines.length).toBeGreaterThan(0);
    expect(nodeLines).toHaveLength(armLines.length);
    for (const line of nodeLines) {
      expect(line.match(/__CORTEX_NODE__/g) ?? [], line).toHaveLength(1);
    }
    // Exactly one jq OUTSIDE the case — the payload read — so it is paid once
    // however many arms exist. Story 5.3's `guard-memory` arm adds more, and
    // that is the point rather than an exception: its matcher includes `Bash`,
    // so it fires on every command the agent runs, and the way it honours N-4
    // is by deciding in SHELL and spawning Node only for the rare call that
    // survives both gates. So the assertion is placement, not a count — a jq
    // added anywhere else still fails, and the arm's own jq calls are pinned to
    // sit before Node in the test below.
    const caseLine = lines.findIndex(line => /^case\s/.test(line.trim()));
    expect(caseLine).toBeGreaterThan(-1);
    const preamble = lines.slice(0, caseLine).join('\n');
    expect(preamble.match(/\bjq\b/g) ?? []).toHaveLength(1);

    const armOf = (index: number): string | undefined => {
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const opened = /^\s{2}([a-z][a-z-]*|\*)\)\s*$/.exec(lines[cursor]!);
        if (opened) return opened[1];
      }
      return undefined;
    };
    lines.forEach((line, index) => {
      if (index <= caseLine || !/\bjq\b/.test(line)) return;
      expect(armOf(index), `jq inside the \`${armOf(index)}\` arm`).toBe('guard-memory');
    });
    // No SQLite, no network, and nothing that blocks waiting on a file.
    for (const banned of ['sqlite', 'curl', 'wget', 'sleep', 'sha256sum']) {
      expect(body, `subagent hook must not use ${banned}`).not.toContain(banned);
    }
    // The engagement guard must precede the dispatch, so `cortex_disengage`
    // turns this off with everything else.
    const guardLine = lines.findIndex(line => line.includes("'^enabled=true'"));
    const nodeLine = lines.findIndex(line => line.includes('__CORTEX_NODE__'));
    expect(guardLine).toBeGreaterThan(-1);
    expect(nodeLine).toBeGreaterThan(guardLine);
  });

  it('has exactly one arm for each action REQUIRED_WIRING points at it', () => {
    // `install` and `doctor` share `REQUIRED_WIRING`, and the script is the
    // third party to that agreement: a wiring naming an action the script has
    // no arm for installs cleanly, passes every `doctor` check, and does
    // nothing — the arm falls through to `exit 0`, which is the correct
    // response to an UNKNOWN action and the silent-death response to a wired
    // one. Story 5.2 added a second arm and this is what keeps the third one
    // honest.
    const script = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8');
    const arms = script
      .split(/\r?\n/)
      .map(line => /^\s{2}([a-z][a-z-]*)\)\s*$/.exec(line)?.[1])
      .filter((arm): arm is string => arm !== undefined);

    const wiredActions = REQUIRED_WIRING.filter(
      required => required.script === 'cortex-subagent.sh',
    ).map(required => required.action);

    expect(wiredActions.length).toBeGreaterThan(0);
    for (const action of wiredActions) {
      expect(action, 'a cortex-subagent.sh wiring with no action token').toBeDefined();
      expect(arms, `cortex-subagent.sh has no arm for the wired action ${action}`).toContain(
        action,
      );
    }
    // And no arm the wiring never reaches, which would be dead shell.
    expect(arms.slice().sort()).toEqual([...wiredActions].sort());
  });

  it('decides the guard arm in shell before it will spawn Node (N-4)', () => {
    // The guard's matcher includes `Bash`, so this arm sees every command the
    // agent runs. Spawning Node there is precisely what AD-2/N-4 forbids, and
    // the protection is entirely ordering: both cheap exits must come first.
    // A reordering that moves the Node line above either gate is type-clean,
    // silent, and would put a process spawn on every shell command.
    const lines = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8').split(/\r?\n/);
    const armStart = lines.findIndex(line => /^\s{2}guard-memory\)\s*$/.test(line));
    expect(armStart).toBeGreaterThan(-1);
    const armEnd = lines.findIndex(
      (line, index) => index > armStart && /^\s{4};;\s*$/.test(line),
    );
    expect(armEnd).toBeGreaterThan(armStart);
    const arm = lines.slice(armStart, armEnd);

    const agentGate = arm.findIndex(line => /GUARD_AGENT_ID.*exit 0/.test(line));
    const bashGate = arm.findIndex(line => /\*\)\s*exit 0\s*;;/.test(line));
    const nodeLine = arm.findIndex(line => line.includes('__CORTEX_NODE__'));
    expect(agentGate, 'no agent_id gate in the guard arm').toBeGreaterThan(-1);
    expect(bashGate, 'no Bash command-text gate in the guard arm').toBeGreaterThan(-1);
    expect(nodeLine).toBeGreaterThan(agentGate);
    expect(nodeLine).toBeGreaterThan(bashGate);
  });

  it('screens the same shell commands the guard module knows about', () => {
    // The cheap check and the real one are two lists in two languages, and a
    // route dropped from the shell `case` disables the guard for it while every
    // TypeScript test still passes — the guard would simply never be asked.
    const script = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8');
    const armStart = script.indexOf('guard-memory)');
    const caseLine = /case "\$GUARD_CMD" in\s*\n\s*([^\n]*)\)/.exec(script.slice(armStart));
    expect(caseLine, 'no command-text case in the guard arm').not.toBeNull();
    const screened = caseLine![1]!
      .split('|')
      .map(pattern => pattern.replace(/\*/g, '').trim())
      .filter(pattern => pattern.length > 0);
    expect(screened.slice().sort()).toEqual([...SHELL_MEMORY_COMMANDS].sort());
  });

  it('passes each arm its OWN action token through to Node', () => {
    // The gap review found: the structure test above checks arm NAMES and that
    // each arm invokes Node exactly once, and the shell-level suite runs only
    // `subagent-start`. Swap the two argument tokens in the script and every
    // dispatch runs the wrong handler — no session is created and no dispatch is
    // captured — while lint, vitest and `doctor` all stay green.
    const lines = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8').split(/\r?\n/);
    let arm: string | null = null;
    const seen = new Map<string, string>();
    for (const line of lines) {
      const opened = /^\s{2}([a-z][a-z-]*)\)\s*$/.exec(line);
      if (opened) {
        arm = opened[1]!;
        continue;
      }
      if (arm !== null && line.includes('__CORTEX_NODE__')) {
        const tokens = line.trim().split(/\s+/);
        seen.set(arm, (tokens[tokens.length - 1] ?? '').replace(/["']/g, ''));
        arm = null;
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    for (const [name, passed] of seen) {
      expect(passed, `the \`${name}\` arm passes \`${passed}\` to Node`).toBe(name);
    }
  });

  // The property that matters is the INSTALLED script's line endings, not the
  // template's. There is no `.gitattributes` and `core.autocrlf` is on for this
  // platform, so a Windows checkout legitimately has CRLF templates —
  // `cortex-capture.sh` already does (`git ls-files --eol`: `i/lf w/crlf`).
  // Asserting the template is LF would therefore go red on any fresh clone
  // while guarding nothing, because `renderHookScript` normalises CRLF to LF
  // before substituting. Assert the thing that ships instead.
  it('renders to LF whatever the checkout did to the template (invariants: bash outside Git Bash)', () => {
    const template = fs.readFileSync(SUBAGENT_SCRIPT, 'utf8');
    const crlfTemplate = template.replace(/\r?\n/g, '\r\n');
    for (const source of [template, crlfTemplate]) {
      const rendered = renderHookScript(source, {
        nodePath: '/usr/bin/node',
        cliEntry: '/pkg/cli.js',
        hookEntry: '/pkg/hook-entry.js',
      });
      expect(rendered).not.toContain('\r');
      expect(rendered).not.toMatch(/__CORTEX_[A-Z_]+__/);
    }
  });

  it('leaves the PostToolUse hot path untouched (N-4)', () => {
    // This story must not add per-tool-call cost. The capture script is the
    // hot path; it must know nothing about subagent starts.
    const capture = fs.readFileSync(SCRIPT, 'utf8');
    expect(capture).not.toContain('subagent-start');
    expect(capture).not.toContain('SubagentStart');
  });
});
