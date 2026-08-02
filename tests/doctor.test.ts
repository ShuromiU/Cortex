import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema, initializeMeta, SCHEMA_VERSION } from '../src/db/schema.js';
import { resolveStoreIdentity } from '../src/scope/identity.js';
import type { GitCommandRunner } from '../src/scope/git.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import {
  HOOK_SCRIPTS,
  SPOOL_STALE_MS,
  SPOOL_THRESHOLD_BYTES,
  TEMPLATE_ID_PLACEHOLDER,
  collectHookCommands,
  commandSatisfiesWiring,
  expandHookPath,
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
  /** Where the store actually lives now — under the fixture's CORTEX_HOME. */
  dbPath: string;
  storeDir: string;
  cortexHome: string;
  /** Canned git, so these unit fixtures need no real repository. */
  runGit: GitCommandRunner;
}

/** A stable fake root commit, so adoption logic has an anchor to match on. */
const FIXTURE_ROOT_COMMIT = 'a'.repeat(40);

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

  // `CORTEX_HOME` is not optional here. Without it `cortexHome()` falls back to
  // `os.homedir()`, and these fixtures would read — and the migration path
  // would write — the developer's real store. That is the incident story 2.4
  // recorded, in a shape that reads as harmless.
  const cortexHome = path.join(root, 'cortex-home');
  const gitCommonDir = path.join(projectDir, '.git');
  fs.mkdirSync(gitCommonDir, { recursive: true });

  // Canned git rather than a real repository: these are unit fixtures built ~40
  // times per run, and the store-identity ACs that genuinely need real git
  // (worktree convergence, two clones) live in `tests/store-identity.test.ts`
  // where they use `git init` and `git worktree add` for real.
  const runGit: GitCommandRunner = (args: string[]) => {
    if (args.includes('--show-toplevel')) {
      return `${projectDir}\n${gitCommonDir}`;
    }
    if (args[0] === 'rev-list') {
      return FIXTURE_ROOT_COMMIT;
    }
    return null;
  };

  const env: NodeJS.ProcessEnv = {
    PATH: binDir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    CORTEX_HOME: cortexHome,
  };
  const identity = resolveStoreIdentity(projectDir, { env, runGit });

  fs.mkdirSync(identity.storeDir, { recursive: true });
  const db = new Database(identity.dbPath);
  // WAL, matching `openDatabase` — the mode every real store is in, and the
  // reason a read-only open has anything to create.
  db.pragma('journal_mode = WAL');
  applySchema(db);
  initializeMeta(db, projectDir);
  db.close();

  return {
    projectDir,
    homeDir,
    hooksDir,
    templateDir,
    binDir,
    env,
    dbPath: identity.dbPath,
    storeDir: identity.storeDir,
    cortexHome,
    runGit,
  };
}

function doctor(fixture: Fixture, overrides: Record<string, unknown> = {}): DoctorReport {
  return runDoctor({
    projectDir: fixture.projectDir,
    homeDir: fixture.homeDir,
    templateDir: fixture.templateDir,
    env: fixture.env,
    platform: 'win32',
    runGit: fixture.runGit,
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
        'capture-matcher',
        'database',
        // Story 3.2: the flat index has three silent-by-design failure modes
        // (a rename that could not complete, a project root matching no scope,
        // a prune outrunning the rebuild). Reporting-only — it never rebuilds,
        // because a diagnostic must not repair what it observes.
        'digest-index',
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
        // Story 2.5: the store is no longer at a fixed path, so "where is it"
        // became a question a diagnostic has to answer. `store-legacy` and
        // `store-adoption` are conditional and absent from a healthy fixture.
        'store',
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
    fs.rmSync(fixture.dbPath);
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
    const dbPath = fixture.dbPath;

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
    expect(fix).toContain('cortex install');
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
    expect(expandHookPath('~/x/y', '/home/me', '/proj')).toBe(path.join('/home/me', 'x/y'));
    expect(expandHookPath('~', '/home/me', '/proj')).toBe('/home/me');
    // Not a home reference: leave it alone.
    expect(expandHookPath('~user/x', '/home/me', '/proj')).toBe('~user/x');
    expect(expandHookPath('/abs/x', '/home/me', '/proj')).toBe('/abs/x');
  });

  it('expands $CLAUDE_PROJECT_DIR, both spellings', () => {
    // Claude Code's documented form for a project-relative hook path. Left
    // unexpanded it produced three false FAILs and printed the literal
    // variable back at the user as the hooks directory.
    expect(expandHookPath('$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh', '/home/me', '/proj')).toBe(
      '/proj/.claude/hooks/x.sh',
    );
    expect(expandHookPath('${CLAUDE_PROJECT_DIR}/x.sh', '/home/me', '/proj')).toBe('/proj/x.sh');
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
      { event: 'Stop', command: 'a', matcher: null },
      { event: 'Stop', command: 'b', matcher: null },
      { event: 'PreToolUse', command: 'c', matcher: 'Edit' },
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

describe('the legacy-store row reports evidence, not coincidence', () => {
  it('does not claim "migrated" merely because a store and a legacy file both exist', () => {
    // Inferring migration from the coexistence of the two was wrong for every
    // cause except a completed migration — and the fix it printed told the user
    // to delete the original, which after a *failed* migration is the only
    // surviving copy of their memory.
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, '.cortex.db'), 'SQLite format 3\u0000legacy');

    const report = doctor(fixture);

    expect(statusOf(report, 'store-legacy')).toBe('warn');
    expect(detailOf(report, 'store-legacy')).toContain('not migrated');
    expect(detailOf(report, 'store-legacy')).not.toContain('migrated from');
  });

  it('reports a recorded migration as migrated, and names the source', () => {
    const fixture = buildFixture();
    const legacy = path.join(fixture.projectDir, '.cortex.db');
    fs.writeFileSync(legacy, 'SQLite format 3\u0000legacy');
    const db = new Database(fixture.dbPath);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'migrated_from',
      legacy,
    );
    db.close();

    const report = doctor(fixture);

    expect(statusOf(report, 'store-legacy')).toBe('warn');
    expect(detailOf(report, 'store-legacy')).toContain('migrated from');
    expect(detailOf(report, 'store-legacy')).toContain(legacy);
  });

  it('fails loudly when the store records that its migration failed', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, '.cortex.db'), 'SQLite format 3\u0000legacy');
    const db = new Database(fixture.dbPath);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'migration_failed',
      'C:\\proj\\.cortex.db: database disk image is malformed',
    );
    db.close();

    const report = doctor(fixture);

    expect(statusOf(report, 'store-legacy')).toBe('fail');
    expect(detailOf(report, 'store-legacy')).toContain('migration failed');
    // And it must not tell the user to delete the only copy they have left.
    const check = report.checks.find(entry => entry.id === 'store-legacy');
    expect(check?.fix).toContain('Do NOT delete the original');
  });
});

describe('database reachability', () => {
  it('fails when the store does not exist, without creating one', () => {
    const fixture = buildFixture();
    const dbPath = fixture.dbPath;
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

  it('fails a file that is not a database, and does not blame permissions', () => {
    const fixture = buildFixture();
    fs.writeFileSync(fixture.dbPath, 'not a database at all');
    const report = doctor(fixture);
    expect(statusOf(report, 'database')).toBe('fail');

    // A corrupt store and an unreadable one need different answers. Naming
    // permissions for a file SQLite rejected as "not a database" sends the
    // user after the wrong thing — AC #3 asks for the *specific* fix.
    const fix = report.checks.find(check => check.id === 'database')?.fix ?? '';
    expect(fix).not.toMatch(/permission/i);
    expect(fix).toContain('Move it aside');
  });

  it('names upgrading, not migrating, for a store written by a newer build', () => {
    const fixture = buildFixture();
    const dbPath = fixture.dbPath;
    const seed = new Database(dbPath);
    seed.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 4), 'schema_version');
    seed.close();

    const report = doctor(fixture);
    expect(statusOf(report, 'database')).toBe('fail');
    // Migrations are additive only, and the "run any cortex command" path
    // rewrites schema_version *down* — the one action that destroys the
    // evidence this check just reported.
    const fix = report.checks.find(check => check.id === 'database')?.fix ?? '';
    expect(fix).not.toContain('apply pending migrations');
    expect(fix).toContain('Upgrade the package');
  });
});

// ── The non-mutation claim, checked against a real store ──────────────

describe('what a doctor run actually writes', () => {
  it('creates the WAL sidecars a read-only open requires, and nothing else', () => {
    // The original non-mutation test ran only against a project with NO store,
    // so the single code path that writes was the one path it never executed.
    // Reading a WAL database materialises its -shm; `readonly: true` prevents
    // content writes, not sidecar creation. Pinned so the documented claim and
    // the behaviour cannot drift apart again.
    const fixture = buildFixture();
    const dbPath = fixture.dbPath;
    for (const sidecar of ['-shm', '-wal']) {
      fs.rmSync(`${dbPath}${sidecar}`, { force: true });
    }

    const storeBefore = fs.readdirSync(fixture.storeDir).sort();
    expect(storeBefore).toEqual(['cortex.db']);
    const projectBefore = fs.readdirSync(fixture.projectDir).sort();
    expect(projectBefore).toEqual(['.cortex.state', '.git']);

    doctor(fixture);

    const storeAfter = fs.readdirSync(fixture.storeDir).sort();
    expect(storeAfter).toEqual(['cortex.db', 'cortex.db-shm', 'cortex.db-wal']);
    // And the relocation's own claim: a diagnostic run leaves the project root
    // exactly as it found it. Story 2.5 moved the store out; nothing may put a
    // database back into the working tree, least of all the read-only command.
    const projectAfter = fs.readdirSync(fixture.projectDir).sort();
    expect(projectAfter).toEqual(['.cortex.state', '.git']);
  });

  it('does not alter the store contents it reads', () => {
    const fixture = buildFixture();
    const dbPath = fixture.dbPath;
    // Closed explicitly: an open handle blocks the temp-dir cleanup on Windows.
    const readMeta = (): unknown[] => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.prepare('SELECT key, value FROM meta ORDER BY key').all();
      } finally {
        db.close();
      }
    };

    const before = readMeta();
    doctor(fixture);
    expect(readMeta()).toEqual(before);
  });
});

// ── Repairs from the story 2.3 review ─────────────────────────────────

describe('a hook wired to a script that does not exist', () => {
  it('fails, rather than passing because another hook found its directory', () => {
    // Wiring matches a command by the script's basename; presence used to be
    // checked only inside the directory derived from the FIRST wired command.
    // The two never met on the same path, so a hook pointing at a directory
    // that does not exist reported fully healthy.
    const fixture = buildFixture();
    expect(doctor(fixture).ok).toBe(true);

    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    (settings['hooks'] as Record<string, unknown>)['Stop'] = [
      { hooks: [{ type: 'command', command: 'bash /nonexistent/dir/cortex-end-of-turn.sh' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-wiring')).toBe('pass');
    expect(statusOf(report, 'hook-scripts')).toBe('fail');
    expect(detailOf(report, 'hook-scripts')).toContain('cortex-end-of-turn.sh');
    expect(report.ok).toBe(false);
  });
});

describe('hooks gutted to a stub', () => {
  it('does not produce a green report', () => {
    // Three scripts replaced with `exit 0`, each carrying a valid stamp.
    // Capture, reflex and end-of-turn are all dead. Only the stamp line is
    // read from an installed script, so currency cannot catch this — the
    // Node-resolution check is what must.
    const fixture = buildFixture();
    expect(doctor(fixture).ok).toBe(true);

    for (const script of HOOK_SCRIPTS) {
      const template = fs.readFileSync(path.join(fixture.templateDir, script), 'utf8');
      fs.writeFileSync(
        path.join(fixture.hooksDir, script),
        `#!/bin/bash\n# cortex-hook-template: ${hookTemplateDigest(template)}\nexit 0\n`,
      );
    }

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-currency')).toBe('pass');
    expect(statusOf(report, 'node')).toBe('fail');
    expect(report.ok).toBe(false);
  });
});

describe('checks that must not speak about files they never opened', () => {
  it('reports currency and substitution as not checked when no script exists', () => {
    const fixture = buildFixture();
    for (const script of HOOK_SCRIPTS) {
      fs.rmSync(path.join(fixture.hooksDir, script));
    }

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-scripts')).toBe('fail');
    // Previously both fell through to their pass branches and asserted
    // positive facts about files that do not exist — two of the nine things
    // AC #1 names, reported as verified when nothing was verified.
    expect(statusOf(report, 'hook-substitution')).toBe('fail');
    expect(detailOf(report, 'hook-substitution')).toContain('not checked');
    expect(statusOf(report, 'hook-currency')).toBe('fail');
    expect(detailOf(report, 'hook-currency')).toContain('not checked');
  });

  it('fails Node resolution when nothing in the wiring names a Node path at all', () => {
    // Reachable with the wiring the README documents: `cortex inject-header
    // --quiet` invokes the installed bin rather than an absolute node path, so
    // with the scripts also missing there is no baked path anywhere. Nothing
    // in the wiring can reach Cortex — strictly worse than a path that is
    // merely missing, so it must not be graded `warn`.
    const fixture = buildFixture();
    for (const script of HOOK_SCRIPTS) {
      fs.rmSync(path.join(fixture.hooksDir, script));
    }
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    (settings['hooks'] as Record<string, unknown>)['SessionStart'] = [
      { hooks: [{ type: 'command', command: 'cortex inject-header --quiet' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'node')).toBe('fail');
    expect(detailOf(report, 'node')).toContain('no Node or CLI path');
    expect(report.ok).toBe(false);
  });

  it('fails a template that ships without the stamp placeholder, and says re-installing will not help', () => {
    const fixture = buildFixture();
    const templatePath = path.join(fixture.templateDir, 'cortex-capture.sh');
    fs.writeFileSync(
      templatePath,
      fs
        .readFileSync(templatePath, 'utf8')
        .split('\n')
        .filter(line => !line.includes(TEMPLATE_ID_PLACEHOLDER))
        .join('\n'),
    );

    const report = doctor(fixture);
    expect(statusOf(report, 'hook-currency')).toBe('fail');
    // Naming the install command here would be a fix that cannot work: the
    // installer has nothing to substitute, so the failure is permanent.
    const fix = report.checks.find(check => check.id === 'hook-currency')?.fix ?? '';
    expect(fix).toContain('Reinstall the cortex-memory package');
    expect(fix).toContain('cannot fix this');
  });
});

describe('engagement state that is not a readable file', () => {
  it('reports it instead of losing the whole report', () => {
    const fixture = buildFixture();
    const statePath = deriveEngagementPath(fixture.projectDir);
    fs.rmSync(statePath);
    fs.mkdirSync(statePath);

    // The unguarded read threw EISDIR out of runDoctor: one malformed path
    // took down every other check with it.
    const report = doctor(fixture);
    expect(statusOf(report, 'engagement')).toBe('fail');
    expect(detailOf(report, 'engagement')).toContain('could not be read');
    expect(report.checks.length).toBeGreaterThan(10);
  });
});

describe('malformed registration files', () => {
  it('reports a .mcp.json that does not parse instead of calling it absent', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    delete settings['mcpServers'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    writeFile(path.join(fixture.projectDir, '.mcp.json'), '{ "mcpServers": { "cortex":');

    const report = doctor(fixture);
    expect(statusOf(report, 'mcp')).toBe('fail');
    // The old message told a user to add a registration that may already be
    // sitting in the file that does not parse.
    expect(detailOf(report, 'mcp')).toContain('does not parse');
    expect(report.checks.find(check => check.id === 'mcp')?.fix).toContain('JSON syntax');
  });

  it('matches the ~/.claude.json project key across separator and case', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    delete settings['mcpServers'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const otherSpelling = fixture.projectDir.replace(/\\/g, '/').toUpperCase();
    writeFile(
      path.join(fixture.homeDir, '.claude.json'),
      JSON.stringify({
        projects: { [otherSpelling]: { mcpServers: { cortex: { command: 'cortex' } } } },
      }),
    );

    expect(statusOf(doctor(fixture), 'mcp')).toBe('pass');
  });
});

describe('PATH parsing', () => {
  it('resolves through a quoted PATH entry, which cmd.exe accepts', () => {
    const fixture = buildFixture();
    const quoted = { ...fixture.env, PATH: `"${fixture.binDir}"` };
    expect(resolveExecutable('jq', quoted, 'win32', fixture.homeDir)).toBe(
      path.join(fixture.binDir, 'jq.exe'),
    );
  });

  it('falls back when PATHEXT is present but empty', () => {
    const fixture = buildFixture();
    // `??` alone keeps the empty string and probes no extension at all, so
    // every .exe on the machine resolves to null.
    const empty = { PATH: fixture.binDir, PATHEXT: '' };
    expect(resolveExecutable('jq', empty, 'win32', fixture.homeDir)).toBe(
      path.join(fixture.binDir, 'jq.exe'),
    );
  });

  it('ignores a trailing separator without treating it as a directory', () => {
    const fixture = buildFixture();
    const trailing = { ...fixture.env, PATH: `${fixture.binDir};;` };
    expect(resolveExecutable('jq', trailing, 'win32', fixture.homeDir)).toBe(
      path.join(fixture.binDir, 'jq.exe'),
    );
  });
});

describe('spool boundaries', () => {
  const spoolName = '.cortex.spool.jsonl';

  it('does not report a negative age when the mtime is in the future', () => {
    const fixture = buildFixture();
    const spoolPath = path.join(fixture.projectDir, spoolName);
    fs.writeFileSync(spoolPath, '{"v":1}\n');
    // Clock skew, a restored backup, or a network filesystem.
    const past = new Date(fs.statSync(spoolPath).mtime.getTime() - 3 * 60 * 60 * 1000);

    const report = doctor(fixture, { now: past });
    expect(statusOf(report, 'spool')).toBe('pass');
    expect(detailOf(report, 'spool')).toContain('0s ago');
    expect(detailOf(report, 'spool')).not.toContain('-');
  });

  it('warns when CORTEX_SPOOL_DIR points the Node side away from what the hook writes', () => {
    // `cortex-capture.sh` hard-codes `$CWD/.cortex.spool.jsonl`, while
    // `deriveSpoolPath` honours the override — so with it set, the flush reads
    // one path while the hook appends to another and the backlog is never
    // collected. Reading through `deriveSpoolPath` here reported "nothing
    // pending" over exactly that backlog.
    const fixture = buildFixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-spool-'));
    const original = process.env['CORTEX_SPOOL_DIR'];
    try {
      process.env['CORTEX_SPOOL_DIR'] = elsewhere;
      fs.writeFileSync(path.join(fixture.projectDir, spoolName), '{"v":1}\n');

      const report = doctor(fixture);
      expect(statusOf(report, 'spool')).toBe('warn');
      expect(detailOf(report, 'spool')).toContain('CORTEX_SPOOL_DIR');
      expect(detailOf(report, 'spool')).toContain('disagree');
    } finally {
      if (original === undefined) delete process.env['CORTEX_SPOOL_DIR'];
      else process.env['CORTEX_SPOOL_DIR'] = original;
    }
  });

  it('fails a directory sitting at the spool path', () => {
    const fixture = buildFixture();
    fs.mkdirSync(path.join(fixture.projectDir, spoolName));
    const report = doctor(fixture);
    expect(statusOf(report, 'spool')).toBe('fail');
    expect(detailOf(report, 'spool')).toContain('not a file');
  });

  it('pins the flush threshold to the value the capture hook uses', () => {
    // Duplicated constant: `doctor.ts` and `cortex-capture.sh` each carry the
    // literal. CLAUDE.md requires this class of duplication to be pinned by
    // test rather than by comment.
    const script = fs.readFileSync('hooks/claude/cortex-capture.sh', 'utf8');
    const match = /-ge\s+(\d+)/.exec(script);
    expect(match, 'no threshold comparison found in cortex-capture.sh').toBeTruthy();
    expect(Number(match![1])).toBe(SPOOL_THRESHOLD_BYTES);
  });
});

describe('capture matcher', () => {
  it('warns when the matcher has lost Agent, and names what that costs', () => {
    // The pre-Story-0.2 value. Without this check, a user who re-copies the
    // scripts after a currency failure but never re-merges the printed JSON
    // gets a green currency row and dead subagent capture.
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'capture-matcher')).toBe('pass');

    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsPath,
      fs.readFileSync(settingsPath, 'utf8').replace('Read|Edit|Write|Bash|Agent', 'Read|Edit|Write|Bash'),
    );

    const report = doctor(fixture);
    expect(statusOf(report, 'capture-matcher')).toBe('warn');
    expect(detailOf(report, 'capture-matcher')).toContain('Agent');
    expect(detailOf(report, 'capture-matcher')).toContain('primary session');
    // A narrowed matcher can be deliberate, so it must not break CI.
    expect(report.ok).toBe(true);
  });

  it('accepts an absent matcher, which fires on every tool', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const post = (settings['hooks'] as Record<string, Array<Record<string, unknown>>>)['PostToolUse']!;
    delete post[0]!['matcher'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    expect(statusOf(doctor(fixture), 'capture-matcher')).toBe('pass');
  });
});

describe('the SessionStart wiring names its own Node and CLI', () => {
  it('fails when that Node path no longer exists', () => {
    // Excluded before, because only `.sh` commands were inspected — so the one
    // case the README advertises ("a Node that moved") went undetected
    // whenever the settings path differed from the pair baked into the scripts.
    const fixture = buildFixture();
    expect(statusOf(doctor(fixture), 'node')).toBe('pass');

    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    (settings['hooks'] as Record<string, unknown>)['SessionStart'] = [
      { hooks: [{ type: 'command', command: '"C:/gone/node.exe" "C:/gone/cli.js" inject-header --quiet' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(statusOf(report, 'node')).toBe('fail');
    expect(detailOf(report, 'node')).toContain('node.exe');
  });
});

describe('commandSatisfiesWiring', () => {
  const wiring = {
    reflectPre: { event: 'PreToolUse', label: '', script: 'cortex-reflect.sh', action: 'reflect-pre' },
    prompt: {
      event: 'UserPromptSubmit',
      label: '',
      script: 'cortex-reflect.sh',
      action: 'reflect-prompt',
      actionOptionalUnless: 'reflect-pre',
    },
    session: { event: 'SessionStart', label: '', token: 'inject-header' },
  };

  it('matches quoted and unquoted, ~ and absolute', () => {
    expect(commandSatisfiesWiring('bash ~/.claude/hooks/cortex-reflect.sh reflect-pre', wiring.reflectPre)).toBe(true);
    expect(commandSatisfiesWiring('bash "C:/h/cortex-reflect.sh" reflect-pre', wiring.reflectPre)).toBe(true);
    expect(commandSatisfiesWiring('bash C:\\h\\cortex-reflect.sh reflect-pre', wiring.reflectPre)).toBe(true);
  });

  it('rejects a path that merely ends with the letters', () => {
    expect(commandSatisfiesWiring('bash ~/h/not-cortex-reflect.sh reflect-pre', wiring.reflectPre)).toBe(false);
  });

  it('applies the default-action rule only when no explicit action contradicts it', () => {
    expect(commandSatisfiesWiring('bash ~/h/cortex-reflect.sh', wiring.prompt)).toBe(true);
    expect(commandSatisfiesWiring('bash ~/h/cortex-reflect.sh reflect-prompt', wiring.prompt)).toBe(true);
    expect(commandSatisfiesWiring('bash ~/h/cortex-reflect.sh reflect-pre', wiring.prompt)).toBe(false);
  });

  it('requires a plain token when the wiring names one', () => {
    expect(commandSatisfiesWiring('cortex inject-header --quiet', wiring.session)).toBe(true);
    expect(commandSatisfiesWiring('cortex status', wiring.session)).toBe(false);
  });
});

describe('hooks directory resolution', () => {
  it('resolves a wiring token with no directory against the project', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsPath,
      fs.readFileSync(settingsPath, 'utf8').replaceAll('~/.claude/hooks/', ''),
    );

    // Previously `path.dirname('cortex-capture.sh')` yielded '.', which was
    // reported as the hooks directory and probed against process.cwd().
    const report = doctor(fixture);
    expect(report.hooks_dir).toBe(path.normalize(fixture.projectDir));
    expect(report.hooks_dir).not.toBe('.');
  });

  it('expands ~ in an explicit --hooks-dir', () => {
    const fixture = buildFixture();
    const report = doctor(fixture, { hooksDir: '~/.claude/hooks' });
    expect(report.hooks_dir).toBe(path.normalize(path.join(fixture.homeDir, '.claude', 'hooks')));
    expect(statusOf(report, 'hook-scripts')).toBe('pass');
  });
});
