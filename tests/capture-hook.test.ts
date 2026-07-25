import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Executes the real PostToolUse hook script. Nothing else can: the script is
 * bash + jq, so `tsc` cannot see inside it and a malformed jq program emits an
 * empty line silently in production rather than failing loudly.
 */

const SCRIPT = path.resolve(__dirname, '..', 'hooks', 'claude', 'cortex-capture.sh');

function hasTool(tool: string): boolean {
  try {
    childProcess.execFileSync('bash', ['-lc', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = hasTool('bash') && hasTool('jq');

// Silent skipping would let the only coverage of the shell change disappear on
// a machine without jq. Say so loudly instead.
if (!canRun) {
  process.stderr.write(
    '\n[capture-hook] SKIPPED: bash and jq are required to execute the PostToolUse hook.\n' +
      '[capture-hook] The shell/jq layer is UNVERIFIED in this run.\n\n',
  );
}

function runHook(payload: Record<string, unknown>): {
  cwd: string;
  lines: Array<Record<string, unknown>>;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-capture-hook-'));
  fs.writeFileSync(path.join(cwd, '.cortex.state'), 'enabled=true\n');

  // Git Bash resolves forward-slashed Windows paths; backslashes it does not.
  const posixCwd = cwd.replace(/\\/g, '/');
  childProcess.execFileSync('bash', [SCRIPT], {
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
    // this test exists to catch. Setup reads tool_name and cwd; each of the
    // three event branches builds its line with exactly one jq.
    const branchStarts = ['  Read|Edit|Write)', '  Bash)', '  Agent)'];
    const boundaries = branchStarts.map(marker => {
      const index = lines.findIndex(line => line.startsWith(marker));
      expect(index, `branch ${marker} not found`).toBeGreaterThan(-1);
      return index;
    });
    const esacIndex = lines.findIndex(line => line.startsWith('esac'));
    expect(esacIndex).toBeGreaterThan(boundaries[2]!);

    const countJq = (from: number, to: number): number =>
      (lines.slice(from, to).join('\n').match(/\|\s*jq\s+-|\$\(\s*jq\s|<<<|xargs/g) ?? []).length;

    expect(countJq(0, boundaries[0]!)).toBe(2); // setup: tool_name, cwd
    expect(countJq(boundaries[0]!, boundaries[1]!)).toBe(1);
    expect(countJq(boundaries[1]!, boundaries[2]!)).toBe(1);
    expect(countJq(boundaries[2]!, esacIndex)).toBe(1);
  });
});
