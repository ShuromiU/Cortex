import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema, initializeMeta, SCHEMA_VERSION } from '../src/db/schema.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import {
  HOOK_SCRIPTS,
  SPOOL_STALE_MS,
  SPOOL_THRESHOLD_BYTES,
  TEMPLATE_ID_PLACEHOLDER,
  collectHookCommands,
  expandHome,
  extractBakedPaths,
  hookTemplateDigest,
  readTemplateStamp,
  resolveExecutable,
  runDoctor,
  tokenizeCommand,
  type CheckStatus,
  type DoctorReport,
} from '../src/query/doctor.js';

// ── Fixture ───────────────────────────────────────────────────────────
//
// Builds a complete, *passing* installation on disk. Every red case below
// starts from this and breaks exactly one thing, then asserts that the check it
// broke is the one that went red — the discipline story 2.2's review named:
// a fixture that cannot fail proves nothing, so each test pre-asserts its own
// precondition (the baseline is green) before mutating it.

let root: string;

interface Fixture {
  projectDir: string;
  homeDir: string;
  hooksDir: string;
  templateDir: string;
  binDir: string;
  env: NodeJS.ProcessEnv;
}

/** Minimal stand-ins for the real templates: same placeholder vocabulary. */
const TEMPLATE_BODIES: Record<string, string> = {
  'cortex-capture.sh': [
    '#!/bin/bash',
    `# cortex-hook-template: ${TEMPLATE_ID_PLACEHOLDER}`,
    'SPOOL="$CWD/.cortex.spool.jsonl"',
    '(cd "$CWD" && "__CORTEX_NODE__" "__CORTEX_CLI__" flush-spool &)',
    '',
  ].join('\n'),
  'cortex-reflect.sh': [
    '#!/bin/bash',
    `# cortex-hook-template: ${TEMPLATE_ID_PLACEHOLDER}`,
    'printf %s "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" reflect-pre',
    '',
  ].join('\n'),
  'cortex-end-of-turn.sh': [
    '#!/bin/bash',
    `# cortex-hook-template: ${TEMPLATE_ID_PLACEHOLDER}`,
    'printf %s "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" end-of-turn',
    '',
  ].join('\n'),
};

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function buildFixture(): Fixture {
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const hooksDir = path.join(homeDir, '.claude', 'hooks');
  const templateDir = path.join(root, 'pkg', 'hooks', 'claude');
  const binDir = path.join(root, 'bin');
  const nodePath = path.join(binDir, 'node.exe');
  const cliPath = path.join(root, 'pkg', 'dist', 'transports', 'cli.js');
  const hookEntryPath = path.join(root, 'pkg', 'dist', 'transports', 'hook-entry.js');

  // Fake executables the doctor resolves on PATH.
  writeFile(path.join(binDir, 'jq.exe'), 'jq');
  writeFile(path.join(binDir, 'bash.exe'), 'bash');
  writeFile(nodePath, 'node');
  writeFile(cliPath, 'cli');
  writeFile(hookEntryPath, 'hook-entry');

  for (const script of HOOK_SCRIPTS) {
    const template = TEMPLATE_BODIES[script]!;
    writeFile(path.join(templateDir, script), template);
    writeFile(
      path.join(hooksDir, script),
      template
        .replaceAll(TEMPLATE_ID_PLACEHOLDER, hookTemplateDigest(template))
        .replaceAll('__CORTEX_NODE__', nodePath)
        .replaceAll('__CORTEX_CLI__', cliPath)
        .replaceAll('__CORTEX_HOOK_ENTRY__', hookEntryPath),
    );
  }

  writeFile(
    path.join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      mcpServers: { cortex: { command: 'cortex', args: ['serve'] } },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `"${nodePath}" "${cliPath}" inject-header --quiet` }] }],
        PostToolUse: [
          { matcher: 'Read|Edit|Write|Bash|Agent', hooks: [{ type: 'command', command: `bash ~/.claude/hooks/cortex-capture.sh` }] },
        ],
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `bash ~/.claude/hooks/cortex-reflect.sh reflect-pre` }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `bash ~/.claude/hooks/cortex-reflect.sh reflect-prompt` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `bash ~/.claude/hooks/cortex-end-of-turn.sh` }] }],
      },
    }),
  );

  writeFile(path.join(projectDir, '.cortex.state'), 'enabled=true\n');

  const db = new Database(path.join(projectDir, '.cortex.db'));
  applySchema(db);
  initializeMeta(db, projectDir);
  db.close();

  return {
    projectDir,
    homeDir,
    hooksDir,
    templateDir,
    binDir,
    env: { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  };
}

function doctor(fixture: Fixture, overrides: Record<string, unknown> = {}): DoctorReport {
  return runDoctor({
    projectDir: fixture.projectDir,
    homeDir: fixture.homeDir,
    templateDir: fixture.templateDir,
    env: fixture.env,
    platform: 'win32',
    ...overrides,
  });
}

function statusOf(report: DoctorReport, id: string): CheckStatus {
  const check = report.checks.find(entry => entry.id === id);
  if (!check) throw new Error(`no check with id ${id}; have ${report.checks.map(c => c.id).join(', ')}`);
  return check.status;
}

function detailOf(report: DoctorReport, id: string): string {
  return report.checks.find(entry => entry.id === id)?.detail ?? '';
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-doctor-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── AC #4: a clean installation passes ────────────────────────────────

describe('runDoctor on a healthy installation', () => {
  it('passes every check and reports ok', () => {
    const report = doctor(buildFixture());
    const failing = report.checks.filter(check => check.status !== 'pass');
    expect(failing.map(check => `${check.id}: ${check.detail}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.failures).toBe(0);
  });

  it('reports every check AC #1 names', () => {
    const report = doctor(buildFixture());
    expect(report.checks.map(check => check.id).sort()).toEqual(
      [
        'database',
        'engagement',
        'hook-currency',
        'hook-interpreter',
        'hook-scripts',
        'hook-substitution',
        'hook-wiring',
        'jq',
        'mcp',
        'node',
        'settings',
        'spool',
      ].sort(),
    );
  });

  it('completes well within the 3-second budget (B-7)', () => {
    const fixture = buildFixture();
    const started = process.hrtime.bigint();
    doctor(fixture);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('every non-passing check names a fix (AC #3)', () => {
    const fixture = buildFixture();
    // Break one of each severity so both branches are exercised.
    fs.writeFileSync(deriveEngagementPath(fixture.projectDir), 'enabled=false\n');
    fs.rmSync(path.join(fixture.projectDir, '.cortex.db'));
    const report = doctor(fixture);

    const nonPassing = report.checks.filter(check => check.status !== 'pass');
    expect(nonPassing.length).toBeGreaterThanOrEqual(2);
    for (const check of nonPassing) {
      expect(check.fix, `check ${check.id} has no fix`).toBeTruthy();
    }
  });
});

// ── A diagnostic must not change what it diagnoses ────────────────────

describe('runDoctor is non-mutating', () => {
  it('creates no database, state file or spool in an empty project', () => {
    const fixture = buildFixture();
    const empty = path.join(root, 'empty-project');
    fs.mkdirSync(empty, { recursive: true });

    const report = doctor(fixture, { projectDir: empty });

    expect(report.ok).toBe(false);
    expect(fs.readdirSync(empty)).toEqual([]);
  });

  it('does not migrate an out-of-date store — the version it reports survives the run', () => {
    const fixture = buildFixture();
    const dbPath = path.join(fixture.projectDir, '.cortex.db');

    const seed = new Database(dbPath);
    seed.prepare('UPDATE meta SET value = ? WHERE key = ?').run('4', 'schema_version');
    seed.close();

    // Precondition: the store really is behind before the doctor runs.
    const before = new Database(dbPath, { readonly: true });
    expect(before.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: '4',
    });
    before.close();

    const report = doctor(fixture);
    expect(statusOf(report, 'database')).toBe('fail');
    expect(detailOf(report, 'database')).toContain(`is 4, this build expects ${SCHEMA_VERSION}`);

    // The load-bearing half: opening the store the normal way would have
    // rewritten schema_version and made this check unfailable.
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: '4',
    });
    after.close();
  });
});

// ── AC #2: currency ───────────────────────────────────────────────────

describe('hook version currency (AC #2)', () => {
  it('fails a script that is valid and substituted but predates the template', () => {
    const fixture = buildFixture();

    // Precondition: this exact installation is current before we age it.
    const baseline = doctor(fixture);
    expect(statusOf(baseline, 'hook-currency')).toBe('pass');
    expect(baseline.ok).toBe(true);

    // Age the template the build ships, leaving the installed script valid,
    // fully substituted, and stamped — just stamped with an older identity.
    const templatePath = path.join(fixture.templateDir, 'cortex-capture.sh');
    fs.writeFileSync(
      templatePath,
      `${fs.readFileSync(templatePath, 'utf8')}# a line the shipped template gained\n`,
    );

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-currency')).toBe('fail');
    expect(detailOf(report, 'hook-currency')).toContain('cortex-capture.sh');
    expect(report.ok).toBe(false);

    // AC #2: nothing else about the hook is broken.
    expect(statusOf(report, 'hook-scripts')).toBe('pass');
    expect(statusOf(report, 'hook-substitution')).toBe('pass');
    expect(statusOf(report, 'hook-interpreter')).toBe('pass');

    // AC #2: names re-running the install command as the fix.
    const fix = report.checks.find(check => check.id === 'hook-currency')?.fix ?? '';
    expect(fix).toContain('cortex install-hooks');
  });

  it('fails a script with no stamp at all — every pre-stamping install', () => {
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'hook-currency')).toBe('pass');

    const installed = path.join(fixture.hooksDir, 'cortex-reflect.sh');
    fs.writeFileSync(
      installed,
      fs
        .readFileSync(installed, 'utf8')
        .split('\n')
        .filter(line => !line.includes('cortex-hook-template:'))
        .join('\n'),
    );

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-currency')).toBe('fail');
    expect(detailOf(report, 'hook-currency')).toContain('no template stamp');
    expect(detailOf(report, 'hook-currency')).toContain('cortex-reflect.sh');
  });

  it('fails when the build ships no template to compare against', () => {
    const fixture = buildFixture();
    fs.rmSync(path.join(fixture.templateDir, 'cortex-capture.sh'));

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-currency')).toBe('fail');
    expect(detailOf(report, 'hook-currency')).toContain('no template shipped');
  });

  it('digests ignore line-ending style but not content', () => {
    const lf = 'a\nb\nc\n';
    expect(hookTemplateDigest(lf)).toBe(hookTemplateDigest(lf.replace(/\n/g, '\r\n')));
    expect(hookTemplateDigest(lf)).not.toBe(hookTemplateDigest('a\nb\nd\n'));
  });

  it('reads the stamp, and reads nothing when it is blank', () => {
    expect(readTemplateStamp('#!/bin/bash\n# cortex-hook-template: abc123\n')).toBe('abc123');
    expect(readTemplateStamp('#!/bin/bash\n# cortex-hook-template:\n')).toBeNull();
    expect(readTemplateStamp('#!/bin/bash\n')).toBeNull();
    // CRLF installs must still be readable.
    expect(readTemplateStamp('#!/bin/bash\r\n# cortex-hook-template: abc123\r\n')).toBe('abc123');
  });
});

// ── AC #5 / N-6: interpreter resolution ───────────────────────────────

describe('interpreter resolution (AC #5, N-6)', () => {
  it('resolves a bare-word interpreter through PATH with PATHEXT', () => {
    const fixture = buildFixture();
    const report = doctor(fixture);
    expect(statusOf(report, 'hook-interpreter')).toBe('pass');
    expect(detailOf(report, 'hook-interpreter')).toContain(path.join(fixture.binDir, 'bash.exe'));
  });

  it('does not assume a POSIX default: /usr/bin/bash resolves via PATH on win32', () => {
    const fixture = buildFixture();
    // Precondition: the literal path does not exist as Node sees it. This is
    // the measured Git Bash case — `which bash` answers /usr/bin/bash and
    // fs.existsSync says false.
    expect(fs.existsSync('/usr/bin/bash')).toBe(false);

    expect(resolveExecutable('/usr/bin/bash', fixture.env, 'win32', fixture.homeDir)).toBe(
      path.join(fixture.binDir, 'bash.exe'),
    );
    // The same path on a POSIX platform is checked literally, not via PATH.
    expect(resolveExecutable('/usr/bin/bash', fixture.env, 'linux', fixture.homeDir)).toBeNull();
  });

  it('fails when the configured interpreter resolves nowhere', () => {
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'hook-interpreter')).toBe('pass');

    fs.rmSync(path.join(fixture.binDir, 'bash.exe'));
    const report = doctor(fixture);
    expect(statusOf(report, 'hook-interpreter')).toBe('fail');
    expect(detailOf(report, 'hook-interpreter')).toContain('bash');
  });

  it('does not match a directory that shares the interpreter name', () => {
    const fixture = buildFixture();
    fs.rmSync(path.join(fixture.binDir, 'bash.exe'));
    fs.mkdirSync(path.join(fixture.binDir, 'bash.exe'), { recursive: true });
    expect(resolveExecutable('bash', fixture.env, 'win32', fixture.homeDir)).toBeNull();
  });

  it('expands ~ the way the shell does', () => {
    expect(expandHome('~/x/y', '/home/me')).toBe(path.join('/home/me', 'x/y'));
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    // Not a home reference: leave it alone.
    expect(expandHome('~user/x', '/home/me')).toBe('~user/x');
    expect(expandHome('/abs/x', '/home/me')).toBe('/abs/x');
  });

  it('tokenizes commands the way a shell would', () => {
    expect(tokenizeCommand('bash ~/.claude/hooks/cortex-reflect.sh reflect-pre')).toEqual([
      'bash',
      '~/.claude/hooks/cortex-reflect.sh',
      'reflect-pre',
    ]);
    expect(
      tokenizeCommand('"C:/Program Files/nodejs/node.exe" "C:/a b/cli.js" inject-header --quiet'),
    ).toEqual(['C:/Program Files/nodejs/node.exe', 'C:/a b/cli.js', 'inject-header', '--quiet']);
    expect(tokenizeCommand("bash 'a b.sh'")).toEqual(['bash', 'a b.sh']);
    expect(tokenizeCommand('   ')).toEqual([]);
    // An empty quoted argument is a token, not nothing.
    expect(tokenizeCommand('bash ""')).toEqual(['bash', '']);
  });
});

// ── Baked Node paths ──────────────────────────────────────────────────

describe('Node resolution', () => {
  it('fails when the Node path baked into a hook no longer exists', () => {
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'node')).toBe('pass');

    fs.rmSync(path.join(fixture.binDir, 'node.exe'));
    const report = doctor(fixture);
    expect(statusOf(report, 'node')).toBe('fail');
    expect(detailOf(report, 'node')).toContain('node.exe');
  });

  it('does not mistake the spool filename for a JS entry point', () => {
    // `.cortex.spool.jsonl` contains `.js`. A content pattern over the
    // installed script matches it and reports the spool as a missing Node
    // installation — measured against the live install.
    const template = TEMPLATE_BODIES['cortex-capture.sh']!;
    const installed = template
      .replaceAll(TEMPLATE_ID_PLACEHOLDER, 'x')
      .replaceAll('__CORTEX_NODE__', '/n/node')
      .replaceAll('__CORTEX_CLI__', '/n/cli.js');

    expect(extractBakedPaths(template, installed)).toEqual(['/n/node', '/n/cli.js']);
    expect(extractBakedPaths(template, installed)).not.toContain('$CWD/.cortex.spool.jsonl');
  });

  it('recovers nothing from a script whose anchoring line is gone', () => {
    const template = TEMPLATE_BODIES['cortex-reflect.sh']!;
    expect(extractBakedPaths(template, '#!/bin/bash\necho nothing\n')).toEqual([]);
  });
});

// ── Engagement, wiring, substitution, settings ────────────────────────

describe('engagement state', () => {
  it('fails when the state file has never been written', () => {
    const fixture = buildFixture();
    fs.rmSync(deriveEngagementPath(fixture.projectDir));
    const report = doctor(fixture);
    expect(statusOf(report, 'engagement')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('warns — but does not fail — on a deliberate disengagement', () => {
    const fixture = buildFixture();
    fs.writeFileSync(deriveEngagementPath(fixture.projectDir), 'enabled=false\n');
    const report = doctor(fixture);
    expect(statusOf(report, 'engagement')).toBe('warn');
    expect(report.ok).toBe(true);
    expect(report.warnings).toBe(1);
  });

  it('agrees with the path the MCP server writes', () => {
    // `query/` may not import from `transports/`, so the doctor re-derives this
    // path. Pinning the two equal here is what stops them drifting.
    const fixture = buildFixture();
    expect(fs.existsSync(deriveEngagementPath(fixture.projectDir))).toBe(true);
    expect(statusOf(doctor(fixture), 'engagement')).toBe('pass');
  });

  it('does not read enabled=true out of a substring', () => {
    const fixture = buildFixture();
    fs.writeFileSync(deriveEngagementPath(fixture.projectDir), 'was_enabled=true\n');
    expect(statusOf(doctor(fixture), 'engagement')).toBe('warn');
  });
});

describe('hook wiring and scripts', () => {
  it('fails when a script exists on disk but is wired nowhere', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    delete (settings['hooks'] as Record<string, unknown>)['Stop'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-wiring')).toBe('fail');
    expect(detailOf(report, 'hook-wiring')).toContain('Stop');
    // The script itself is still on disk — that is the point.
    expect(statusOf(report, 'hook-scripts')).toBe('pass');
  });

  it('distinguishes reflect-pre from reflect-prompt', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    // Both events wired to the same action: one of them is now missing.
    (settings['hooks'] as Record<string, unknown>)['UserPromptSubmit'] = [
      { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/cortex-reflect.sh reflect-pre' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-wiring')).toBe('fail');
    expect(detailOf(report, 'hook-wiring')).toContain('UserPromptSubmit');
  });

  it('recognises the wiring install-hooks itself prints, quotes and all', () => {
    // The snippet the installer prints quotes the script path:
    //   bash "C:/Users/x/.claude/hooks/cortex-reflect.sh" reflect-pre
    // A raw-substring needle of `cortex-reflect.sh reflect-pre` does not match
    // that, so the diagnostic reported a correct installation as unwired.
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const quoted = fs
      .readFileSync(settingsPath, 'utf8')
      .replace(
        /bash ~\/\.claude\/hooks\/cortex-reflect\.sh reflect-pre/,
        'bash \\"C:/h/cortex-reflect.sh\\" reflect-pre',
      )
      .replace(
        /bash ~\/\.claude\/hooks\/cortex-end-of-turn\.sh/,
        'bash \\"C:/h/cortex-end-of-turn.sh\\"',
      );
    fs.writeFileSync(settingsPath, quoted);

    expect(statusOf(doctor(fixture, { hooksDir: fixture.hooksDir }), 'hook-wiring')).toBe('pass');
  });

  it('accepts a reflect wiring that relies on the script default action', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    // `cortex-reflect.sh` runs ACTION="${1:-reflect-prompt}", so omitting the
    // argument on UserPromptSubmit is the prompt reflex.
    (settings['hooks'] as Record<string, unknown>)['UserPromptSubmit'] = [
      { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/cortex-reflect.sh' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    expect(statusOf(doctor(fixture), 'hook-wiring')).toBe('pass');
  });

  it('does not accept a bare script name as a path match by accident', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    // A path that merely *ends with* the letters is not the script.
    (settings['hooks'] as Record<string, unknown>)['Stop'] = [
      { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/not-cortex-end-of-turn.sh' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-wiring')).toBe('fail');
    expect(detailOf(report, 'hook-wiring')).toContain('Stop');
  });

  it('fails a missing script and names it', () => {
    const fixture = buildFixture();
    fs.rmSync(path.join(fixture.hooksDir, 'cortex-capture.sh'));
    const report = doctor(fixture);
    expect(statusOf(report, 'hook-scripts')).toBe('fail');
    expect(detailOf(report, 'hook-scripts')).toContain('cortex-capture.sh');
  });

  it('fails an unsubstituted placeholder', () => {
    const fixture = buildFixture();
    const installed = path.join(fixture.hooksDir, 'cortex-end-of-turn.sh');
    fs.writeFileSync(
      installed,
      fs.readFileSync(installed, 'utf8').replace(/^printf.*$/m, 'printf %s | "__CORTEX_NODE__" x'),
    );
    const report = doctor(fixture);
    expect(statusOf(report, 'hook-substitution')).toBe('fail');
    expect(detailOf(report, 'hook-substitution')).toContain('cortex-end-of-turn.sh');
  });

  it('reads the hooks directory from the wiring, not from a default', () => {
    const fixture = buildFixture();
    const moved = path.join(root, 'elsewhere', 'hooks');
    fs.mkdirSync(moved, { recursive: true });
    for (const script of HOOK_SCRIPTS) {
      fs.renameSync(path.join(fixture.hooksDir, script), path.join(moved, script));
    }
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsPath,
      fs
        .readFileSync(settingsPath, 'utf8')
        .replaceAll('~/.claude/hooks/', `${moved.replace(/\\/g, '/')}/`),
    );

    const report = doctor(fixture);
    expect(report.hooks_dir).toBe(moved);
    expect(statusOf(report, 'hook-scripts')).toBe('pass');
  });
});

describe('settings discovery', () => {
  it('reports a settings file that does not parse, rather than treating it as absent', () => {
    const fixture = buildFixture();
    writeFile(path.join(fixture.projectDir, '.claude', 'settings.json'), '{ "hooks": ');
    const report = doctor(fixture);
    expect(statusOf(report, 'settings')).toBe('fail');
    expect(detailOf(report, 'settings')).toContain('settings.json');
  });

  it('survives a settings file whose hooks section is the wrong shape', () => {
    const fixture = buildFixture();
    writeFile(
      path.join(fixture.projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: 'not-an-array', PreToolUse: [null, { hooks: [42] }] } }),
    );
    // Parses, so `settings` passes; the real wiring in the home file still counts.
    const report = doctor(fixture);
    expect(statusOf(report, 'settings')).toBe('pass');
    expect(statusOf(report, 'hook-wiring')).toBe('pass');
  });

  it('collects commands from every event', () => {
    expect(
      collectHookCommands({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
          PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'c' }] }],
        },
      }),
    ).toEqual([
      { event: 'Stop', command: 'a' },
      { event: 'Stop', command: 'b' },
      { event: 'PreToolUse', command: 'c' },
    ]);
    expect(collectHookCommands({})).toEqual([]);
    expect(collectHookCommands({ hooks: null })).toEqual([]);
  });
});

// ── jq, spool, MCP ────────────────────────────────────────────────────

describe('jq availability', () => {
  it('fails when jq is not on PATH', () => {
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'jq')).toBe('pass');
    fs.rmSync(path.join(fixture.binDir, 'jq.exe'));
    const report = doctor(fixture);
    expect(statusOf(report, 'jq')).toBe('fail');
    expect(report.checks.find(check => check.id === 'jq')?.fix).toContain('jq');
  });
});

describe('spool size and staleness', () => {
  const spoolName = '.cortex.spool.jsonl';

  it('passes on a fresh, small spool', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, spoolName), '{"v":1}\n');
    expect(statusOf(doctor(fixture), 'spool')).toBe('pass');
  });

  it('passes on an empty spool file', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, spoolName), '');
    expect(statusOf(doctor(fixture), 'spool')).toBe('pass');
  });

  it('fails at the threshold that should have triggered a flush', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, spoolName), 'x'.repeat(SPOOL_THRESHOLD_BYTES));
    const report = doctor(fixture);
    expect(statusOf(report, 'spool')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('warns on a non-empty spool the turn-end flush has not collected', () => {
    const fixture = buildFixture();
    const spoolPath = path.join(fixture.projectDir, spoolName);
    fs.writeFileSync(spoolPath, '{"v":1}\n');
    const now = new Date(fs.statSync(spoolPath).mtime.getTime() + SPOOL_STALE_MS + 60_000);

    const report = doctor(fixture, { now });
    expect(statusOf(report, 'spool')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('says nothing is pending when there is no spool at all', () => {
    const report = doctor(buildFixture());
    expect(statusOf(report, 'spool')).toBe('pass');
    expect(detailOf(report, 'spool')).toContain('no spool file');
  });
});

describe('MCP server registration', () => {
  it('accepts registration in the project .mcp.json', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    delete settings['mcpServers'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(statusOf(doctor(fixture), 'mcp')).toBe('fail');

    writeFile(
      path.join(fixture.projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { cortex: { command: 'cortex', args: ['serve'] } } }),
    );
    expect(statusOf(doctor(fixture), 'mcp')).toBe('pass');
  });

  it('accepts a per-project registration in ~/.claude.json', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    delete settings['mcpServers'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    writeFile(
      path.join(fixture.homeDir, '.claude.json'),
      JSON.stringify({
        projects: { [fixture.projectDir]: { mcpServers: { cortex: { command: 'cortex' } } } },
      }),
    );
    expect(statusOf(doctor(fixture), 'mcp')).toBe('pass');
  });

  it('matches on the server key, not on a command substring', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    // A different server whose command happens to mention cortex.
    settings['mcpServers'] = { other: { command: 'node', args: ['/x/cortex/serve.js'] } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(statusOf(doctor(fixture), 'mcp')).toBe('fail');
  });
});

// ── Database ──────────────────────────────────────────────────────────

describe('database reachability', () => {
  it('fails when the store does not exist, without creating one', () => {
    const fixture = buildFixture();
    const dbPath = path.join(fixture.projectDir, '.cortex.db');
    fs.rmSync(dbPath);
    const report = doctor(fixture);
    expect(statusOf(report, 'database')).toBe('fail');
    expect(fs.existsSync(dbPath)).toBe(false);

    // Not merely "fail": a missing store and an unreadable one need different
    // fixes, and `openDatabaseReadOnly` throws for both. Reporting the
    // permissions fix to someone who simply has no store yet is a wrong answer
    // that still exits non-zero, so the diagnosis is pinned, not just the code.
    expect(detailOf(report, 'database')).toContain('does not exist');
    expect(report.checks.find(check => check.id === 'database')?.fix).toContain('inject-header');
  });

  it('reports the schema version when current', () => {
    const report = doctor(buildFixture());
    expect(detailOf(report, 'database')).toContain(`schema_version ${SCHEMA_VERSION}`);
  });

  it('fails a file that is not a database', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, '.cortex.db'), 'not a database at all');
    const report = doctor(fixture);
    expect(statusOf(report, 'database')).toBe('fail');
  });
});
