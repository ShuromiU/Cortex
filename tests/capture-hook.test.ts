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

  it('uses one jq invocation per event branch', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    // Count actual invocations, not the word: two setup reads (tool_name,
    // cwd) plus one per branch — read/edit/write, Bash, Agent. Any more means
    // an extra process on the hot path.
    const invocations = (script.match(/\|\s*jq\s+-/g) ?? []).length;
    expect(invocations).toBe(5);
  });
});
