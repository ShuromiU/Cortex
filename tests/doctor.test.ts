import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema, initializeMeta, SCHEMA_VERSION } from '../src/db/schema.js';
import { resolveStoreIdentity } from '../src/scope/identity.js';
import type { GitCommandRunner } from '../src/scope/git.js';
import { deriveEngagementPath } from '../src/transports/mcp.js';
import { SCAN_STATUS_KEY } from '../src/capture/spool.js';
import {
  SUBAGENT_AMBIGUOUS_COUNT_KEY,
  SUBAGENT_BRIEFED_COUNT_KEY,
  SUBAGENT_DISPATCH_COUNT_KEY,
  SUBAGENT_DISPATCH_KEY,
  SUBAGENT_PAIRED_COUNT_KEY,
  SUBAGENT_START_COUNT_KEY,
  SUBAGENT_START_KEY,
} from '../src/scope/runtime.js';
import {
  HOOK_SCRIPTS,
  REQUIRED_WIRING,
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
const CAPTURE_MATCHER = REQUIRED_WIRING.find(w => w.event === 'PostToolUse')!.matcher!;


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
  'cortex-subagent.sh': [
    '#!/bin/bash',
    `# cortex-hook-template: ${TEMPLATE_ID_PLACEHOLDER}`,
    'printf %s "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" subagent-start',
    '',
  ].join('\n'),
};

// A stand-in must exist for every entry in HOOK_SCRIPTS, or `buildFixture`
// throws on `template.replaceAll` of an undefined and every test in this file
// dies in setup rather than failing on its own terms. Asserted here so the next
// script to be added fails loudly at the right place.
for (const script of HOOK_SCRIPTS) {
  if (TEMPLATE_BODIES[script] === undefined) {
    throw new Error(`tests/doctor.test.ts: TEMPLATE_BODIES is missing a stand-in for ${script}`);
  }
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * The hooks block of a healthy installation, DERIVED from `REQUIRED_WIRING`.
 *
 * Hand-written before Story 5.2, which broke it: a seventh entry appeared and
 * every fixture-built report went `hook-wiring: fail`, `ok: false`, taking a
 * dozen unrelated tests with it. Story 5.1's `TEMPLATE_BODIES` guard covers a
 * new SCRIPT and says nothing about a new WIRING. Deriving it means the eighth
 * entry is not a third repair.
 *
 * The `~` form is kept deliberately: it is the shape the live machine actually
 * carries, and `expandHookPath` resolving it is part of what these tests cover.
 */
function healthyWiring(nodePath: string, cliPath: string): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {};
  for (const required of REQUIRED_WIRING) {
    const command =
      required.script === undefined
        ? `"${nodePath}" "${cliPath}" inject-header --quiet`
        : `bash ~/.claude/hooks/${required.script}${required.action === undefined ? '' : ` ${required.action}`}`;
    const entries = hooks[required.event] ?? [];
    entries.push({
      ...(required.matcher === undefined ? {} : { matcher: required.matcher }),
      hooks: [{ type: 'command', command }],
    });
    hooks[required.event] = entries;
  }
  return hooks;
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
      hooks: healthyWiring(nodePath, cliPath),
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
  // Canonical, in the same sense `resolveStoreIdentity` canonicalises — see the
  // longer note in `tests/store-identity.test.ts`. `identity.legacyDbPaths` is
  // built from the realpath of the project root, so a fixture root left in
  // win32 8.3 form (CI: `C:\Users\RUNNER~1\...`) makes the `migrated_from`
  // value written here by hand from `fixture.projectDir` unequal to the path
  // `doctor` computes, and the legacy-store row silently reports the store as
  // "present and not migrated" instead of naming its source.
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-doctor-'));
  root = fs.realpathSync.native(created);
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
        // Story 5.2: `PreToolUse` now carries two required wirings, and the
        // matcher is the only thing routing each to its own tool. `hook-wiring`
        // never inspects a matcher, so a dispatch hook left at `Edit|Write`
        // would be present, current, substituted and completely dead while
        // every other row read green — the same gap `capture-matcher` closes.
        'dispatch-matcher',
        'engagement',
        // Story 5.3: the same gap again, with a worse consequence. The memory
        // guard is the only thing stopping a subagent retiring an earlier
        // session's memory, and it protects three routes independently — a
        // matcher covering the two MCP tools but not `Bash` leaves `cortex
        // delete-memory` open while every other row reads green.
        'guard-matcher',
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
        // Story 4.5 review round: the substitution state, because on-but-inert
        // (armed with no hot-path facts) was reproducibly invisible on every
        // user-facing surface.
        'substitution',
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

  it('does not assume a POSIX default: an absolute POSIX path resolves via PATH on win32', () => {
    const fixture = buildFixture();
    // The measured case is Git Bash's `/usr/bin/bash` — `which bash` answers it
    // while `fs.existsSync` says false, because Node resolves a POSIX-absolute
    // path against the drive root. But that literal is absent only on Windows:
    // on Linux it is a real file, and `resolveExecutable` correctly returns it
    // literally there, which made this test's Windows-only precondition fail on
    // every POSIX runner. The probe therefore keeps the shape that matters —
    // POSIX-absolute, basename resolvable on the fixture's PATH — and takes its
    // directory from this run's unique temp name, which exists at no filesystem
    // root on any platform. The precondition is asserted rather than assumed, so
    // a probe that ever does exist fails here instead of quietly testing
    // something else.
    const absentPosixPath = path.posix.join('/', path.basename(root), 'bash');
    const presentPath = path.join(fixture.binDir, 'bash.exe');
    expect(fs.existsSync(absentPosixPath)).toBe(false);

    // win32: nothing to find literally, so the basename is resolved via PATH.
    expect(resolveExecutable(absentPosixPath, fixture.env, 'win32', fixture.homeDir)).toBe(
      presentPath,
    );
    // POSIX: checked literally, never via PATH. Both halves are asserted so that
    // "literal" means literal and not "happened to be missing" — the absent path
    // stays null even though `bash` IS on the fixture's PATH, and a path that
    // does exist resolves to itself.
    expect(resolveExecutable(absentPosixPath, fixture.env, 'linux', fixture.homeDir)).toBeNull();
    expect(resolveExecutable(presentPath, fixture.env, 'linux', fixture.homeDir)).toBe(presentPath);
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

describe('read substitution row (FR-6, Story 4.5)', () => {
  it('reports off as a PASS with the enable pointer — off is the default, not a defect', () => {
    const fixture = buildFixture();
    const report = doctor(fixture);
    expect(statusOf(report, 'substitution')).toBe('pass');
    expect(detailOf(report, 'substitution')).toContain('cortex substitution on');
  });

  it('reports on-with-facts as a pass', () => {
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, '.cortex.substitution'), 'on\n');
    fs.writeFileSync(
      deriveEngagementPath(fixture.projectDir),
      'enabled=true\nsession_id=s-1\nindex_scope=scope\nscope_root=c:/x\n',
    );
    const report = doctor(fixture);
    expect(statusOf(report, 'substitution')).toBe('pass');
    expect(detailOf(report, 'substitution')).toContain('on');
  });

  it('warns when the flag is armed but no hot-path facts are published', () => {
    // The silent-dead configuration the review reproduced: `.cortex.state`
    // without the session facts (a scope whose root cannot be resolved
    // publishes nothing), while both user-facing surfaces reported health.
    const fixture = buildFixture();
    fs.writeFileSync(path.join(fixture.projectDir, '.cortex.substitution'), 'on\n');
    const report = doctor(fixture);
    expect(statusOf(report, 'substitution')).toBe('warn');
    expect(detailOf(report, 'substitution')).toContain('cannot substitute');
  });

  it('a directory at the flag path is off, matching the hook and the module', () => {
    const fixture = buildFixture();
    fs.mkdirSync(path.join(fixture.projectDir, '.cortex.substitution'));
    expect(statusOf(doctor(fixture), 'substitution')).toBe('pass');
  });
});

describe('command outcomes row (FR-14, Story 4.4)', () => {
  // This whole capability exists because a feature was wired, running and dead
  // with nothing saying so — `command_failure` and `test_cycle` had never fired
  // across 4,881 recorded commands. Shipping it without a surface of its own
  // would repeat that one layer down.
  const seedMeta = (fixture: Fixture, value: string): void => {
    const db = new Database(fixture.dbPath);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SCAN_STATUS_KEY, value);
    db.close();
  };

  const seedCommandRun = (fixture: Fixture): void => {
    const db = new Database(fixture.dbPath);
    db.prepare('INSERT INTO sessions (id, started_at, worktree_path, scope_type, scope_key) VALUES (?,?,?,?,?)').run(
      's-cmd',
      '2026-08-03T12:00:00Z',
      fixture.projectDir,
      'project',
      `project:${fixture.projectDir}`,
    );
    db.prepare('INSERT INTO command_runs (id, session_id, timestamp, command_summary) VALUES (?,?,?,?)').run(
      'c-1',
      's-cmd',
      '2026-08-03T12:00:00Z',
      'npm test',
    );
    db.close();
  };

  it('says nothing at all on a project where nothing has run', () => {
    // Conditional like `store-legacy`: a row that warns on every fresh install
    // is noise that gets tuned out, which costs exactly the attention this
    // check exists to buy.
    const report = doctor(buildFixture());
    expect(report.checks.find(check => check.id === 'command-outcomes')).toBeUndefined();
  });

  it('reports what the last scan actually saw', () => {
    const fixture = buildFixture();
    seedMeta(fixture, '2026-08-03T12:00:00Z ok outcomes=12 failures=2 truncated=no synthesized=2');
    const report = doctor(fixture);
    expect(statusOf(report, 'command-outcomes')).toBe('pass');
    expect(detailOf(report, 'command-outcomes')).toContain('outcomes=12 failures=2');
  });

  it('warns when the scan found no usable transcript', () => {
    // The AD-12 case: a host that renames `transcript_path` or moves the file
    // produces silence indistinguishable from "nothing failed".
    const fixture = buildFixture();
    seedMeta(fixture, '2026-08-03T12:00:00Z unavailable:missing synthesized=0');
    const report = doctor(fixture);
    expect(statusOf(report, 'command-outcomes')).toBe('warn');
    expect(detailOf(report, 'command-outcomes')).toContain('missing');
    expect(report.checks.find(check => check.id === 'command-outcomes')?.fix).toContain('cortex install');
  });

  it('warns when commands were recorded but no scan ever ran', () => {
    // The exact shape of the original outage: activity in the store, no
    // outcomes, and nothing anywhere reporting the gap.
    const fixture = buildFixture();
    seedCommandRun(fixture);
    const report = doctor(fixture);
    expect(statusOf(report, 'command-outcomes')).toBe('warn');
    expect(detailOf(report, 'command-outcomes')).toContain('1 commands recorded');
  });

  it('never fails the run — a scan gap is not a broken installation', () => {
    const fixture = buildFixture();
    seedMeta(fixture, '2026-08-03T12:00:00Z unavailable:no-path synthesized=0');
    expect(doctor(fixture).ok).toBe(true);
  });
});

describe('subagent sessions (FR-17)', () => {
  const seedSubagentMarker = (fixture: Fixture, firstSeen: string, fires: string): void => {
    const db = new Database(fixture.dbPath);
    const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    set.run(SUBAGENT_START_KEY, firstSeen);
    set.run(SUBAGENT_START_COUNT_KEY, fires);
    db.close();
  };

  const seedChildSessions = (fixture: Fixture, startedAt: string, count: number): void => {
    const db = new Database(fixture.dbPath);
    db.prepare(
      'INSERT INTO sessions (id, started_at, worktree_path, scope_type, scope_key) VALUES (?,?,?,?,?)',
    ).run('s-parent', startedAt, fixture.projectDir, 'project', `project:${fixture.projectDir}`);
    const insert = db.prepare(
      `INSERT INTO sessions (id, parent_session_id, started_at, agent_type, agent_id, worktree_path, scope_type, scope_key)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < count; i += 1) {
      insert.run(
        `s-child-${i}`,
        's-parent',
        startedAt,
        'general-purpose',
        `agent-${i}`,
        fixture.projectDir,
        'project',
        `project:${fixture.projectDir}`,
      );
    }
    db.close();
  };

  it('says nothing on a project where no subagent has ever started', () => {
    const report = doctor(buildFixture());
    expect(report.checks.find(check => check.id === 'subagent-sessions')).toBeUndefined();
  });

  it('stays silent on a store whose subagent history predates the feature', () => {
    // The day-one case, and the one that made `command-outcomes` flap: both
    // live stores already hold child sessions and no marker. Warning here would
    // fire on a healthy install the moment this ships.
    const fixture = buildFixture();
    seedChildSessions(fixture, '2026-08-02T01:00:00Z', 40);
    const report = doctor(fixture);
    expect(report.checks.find(check => check.id === 'subagent-sessions')).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('passes once the path has fired and accounts for every child', () => {
    const fixture = buildFixture();
    seedSubagentMarker(fixture, '2026-08-06T10:00:00Z', '3');
    seedChildSessions(fixture, '2026-08-06T11:00:00Z', 3);
    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('pass');
    expect(detailOf(report, 'subagent-sessions')).toContain('fired 3 times');
  });

  it('warns when subagents ran that the hook never saw', () => {
    // Wired, apparently fine, missing dispatches — the state nothing else sees.
    const fixture = buildFixture();
    seedSubagentMarker(fixture, '2026-08-06T10:00:00Z', '1');
    seedChildSessions(fixture, '2026-08-06T11:00:00Z', 5);
    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('warn');
    // The numbers and the reason, not the sentence they sit in. Story 5.2 folded
    // the dispatch counters into this row and reworded the detail; pinning the
    // phrasing made an unrelated wording change look like a broken diagnostic.
    expect(detailOf(report, 'subagent-sessions')).toContain('fired 1 time');
    expect(detailOf(report, 'subagent-sessions')).toContain('5 subagent sessions');
    expect(detailOf(report, 'subagent-sessions')).toContain(
      'not reaching the SubagentStart hook',
    );
    expect(report.checks.find(check => check.id === 'subagent-sessions')?.fix).toContain(
      'cortex install',
    );
  });

  it('ignores children that predate the first fire', () => {
    const fixture = buildFixture();
    seedChildSessions(fixture, '2026-08-01T09:00:00Z', 12);
    seedSubagentMarker(fixture, '2026-08-06T10:00:00Z', '1');
    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('pass');
  });

  it('never fails the run — a missed dispatch is not a broken installation', () => {
    const fixture = buildFixture();
    seedSubagentMarker(fixture, '2026-08-06T10:00:00Z', '0');
    seedChildSessions(fixture, '2026-08-06T11:00:00Z', 9);
    expect(doctor(fixture).ok).toBe(true);
  });

  it('reads a corrupt fire count as zero rather than throwing', () => {
    const fixture = buildFixture();
    seedSubagentMarker(fixture, '2026-08-06T10:00:00Z', 'many');
    seedChildSessions(fixture, '2026-08-06T11:00:00Z', 2);
    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('warn');
    expect(detailOf(report, 'subagent-sessions')).toContain('fired 0 times');
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
    //
    // Anchored on `$SIZE`, not on the first `-ge` in the file. The script holds
    // several numeric comparisons, and a first-match scan silently re-points at
    // whichever one moves above this line: measured, when the fold's
    // `"${BASH_VERSINFO[0]}" -ge 4` guard was added the assertion began
    // comparing 4 against 262144 — a real failure, but naming the wrong line.
    const script = fs.readFileSync('hooks/claude/cortex-capture.sh', 'utf8');
    const match = /\$\{SIZE:-0\}"\s+-ge\s+(\d+)/.exec(script);
    expect(match, 'no spool-size threshold comparison found in cortex-capture.sh').toBeTruthy();
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
      fs.readFileSync(settingsPath, 'utf8').replace('Agent|', ''),
    );

    const report = doctor(fixture);
    expect(statusOf(report, 'capture-matcher')).toBe('warn');
    expect(detailOf(report, 'capture-matcher')).toContain('Agent');
    expect(detailOf(report, 'capture-matcher')).toContain('primary session');
    // A narrowed matcher can be deliberate, so it must not break CI.
    expect(report.ok).toBe(true);
  });

  it('warns when the matcher lost Grep — dead search capture (Story 4.3)', () => {
    // The 4.5-era matcher, exactly what every pre-4.3 install carries. The
    // check must name Grep, or the negative cache silently never records and
    // nothing anywhere says why.
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsPath,
      fs
        .readFileSync(settingsPath, 'utf8')
        .replace('|Grep', ''),
    );
    const report = doctor(fixture);
    expect(statusOf(report, 'capture-matcher')).toBe('warn');
    expect(detailOf(report, 'capture-matcher')).toContain('Grep');
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

// ── The automatic brief's own observability (FR-18, Story 5.2) ───────
//
// Folded into the `subagent-sessions` row rather than given one of its own,
// because the two are one capability. What these counters catch is a state the
// session counters cannot see: the dispatch hook fires, the start hook fires,
// every other row reads green, and no subagent is ever briefed — because
// nothing pairs.
describe('subagent dispatch counters (FR-18)', () => {
  const seedDispatchMeta = (
    fixture: Fixture,
    values: Record<string, string>,
  ): void => {
    const db = new Database(fixture.dbPath);
    const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(values)) set.run(key, value);
    db.close();
  };

  it('stays silent on a store where no dispatch has ever been captured', () => {
    // Same day-one rule the session marker follows: a store that accumulated
    // subagent history before this shipped must not be warned about.
    const report = doctor(buildFixture());
    expect(report.checks.find(check => check.id === 'subagent-sessions')).toBeUndefined();
  });

  it('reports captured, paired and briefed once the capture path has run', () => {
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '9',
      [SUBAGENT_PAIRED_COUNT_KEY]: '8',
      [SUBAGENT_BRIEFED_COUNT_KEY]: '5',
    });

    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('pass');
    const detail = detailOf(report, 'subagent-sessions');
    expect(detail).toContain('SubagentStart has not fired here yet');
    expect(detail).toContain('9 dispatches captured');
    expect(detail).toContain('8 paired');
    expect(detail).toContain('5 briefed');
  });

  it('reports refusals without warning about them', () => {
    // A refusal is the SAFE outcome under the 2026-08-07 ruling — more than one
    // candidate means say nothing — and silence is this feature's documented
    // default, so warning on it would fire whenever the design worked as ruled.
    // That is the "cries wolf" half of AD-12.
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '30',
      [SUBAGENT_PAIRED_COUNT_KEY]: '30',
      [SUBAGENT_BRIEFED_COUNT_KEY]: '12',
      [SUBAGENT_AMBIGUOUS_COUNT_KEY]: '18',
    });

    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('pass');
    expect(detailOf(report, 'subagent-sessions')).toContain('18 starts refused as ambiguous');
    expect(report.ok).toBe(true);
  });

  it('warns once captures have accumulated and NOTHING has ever paired', () => {
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '7',
      [SUBAGENT_PAIRED_COUNT_KEY]: '0',
    });

    const report = doctor(fixture);
    expect(statusOf(report, 'subagent-sessions')).toBe('warn');
    expect(detailOf(report, 'subagent-sessions')).toContain('no dispatch has ever paired');
    expect(report.checks.find(check => check.id === 'subagent-sessions')?.fix).toContain(
      'cortex install',
    );
    // A missed brief is not a broken installation.
    expect(report.ok).toBe(true);
  });

  it('does not warn on the first unpaired captures, which are ordinary', () => {
    // An `Agent` call the user denied fires `PreToolUse` and never starts, and
    // `doctor` can run in the ~800 ms between a capture and its start. A `> 0`
    // threshold would warn on both.
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '2',
      [SUBAGENT_PAIRED_COUNT_KEY]: '0',
    });

    expect(statusOf(doctor(fixture), 'subagent-sessions')).toBe('pass');
  });

  it('reads a corrupt dispatch counter as zero rather than throwing', () => {
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '12 dispatches',
      [SUBAGENT_PAIRED_COUNT_KEY]: 'lots',
    });

    // `Number`, never `parseInt`: a prefix parse would read 12 and then warn on
    // `12 captured, 0 paired`, inventing a fault out of corruption.
    const report = doctor(fixture);
    expect(detailOf(report, 'subagent-sessions')).toContain('0 dispatches captured');
    expect(detailOf(report, 'subagent-sessions')).toContain('not a number');
    expect(report.ok).toBe(true);
  });

  it('does not manufacture the never-paired warn from ONE corrupt counter', () => {
    // The asymmetric case, which the both-corrupt test above cannot reach: a
    // VALID capture count beside an unparseable paired count reads as
    // "9 captured, 0 paired" and would warn on a healthy, briefing install.
    const fixture = buildFixture();
    seedDispatchMeta(fixture, {
      [SUBAGENT_DISPATCH_KEY]: '2026-08-06T10:00:00Z',
      [SUBAGENT_DISPATCH_COUNT_KEY]: '9',
      [SUBAGENT_PAIRED_COUNT_KEY]: 'lots',
    });

    const report = doctor(fixture);
    // MUTATION ANCHOR: dropping the `dispatchCountersCorrupt` branch in
    // `runDoctor` must turn this red.
    expect(detailOf(report, 'subagent-sessions')).not.toContain('no dispatch has ever paired');
    expect(detailOf(report, 'subagent-sessions')).toContain('not a number');
  });
});

// ── The dispatch matcher (FR-18, Story 5.2) ──────────────────────────

describe('dispatch matcher', () => {
  const rewireDispatch = (fixture: Fixture, matcher: string | undefined): void => {
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    for (const entry of settings.hooks['PreToolUse'] ?? []) {
      if (!entry.hooks.some(hook => hook.command.includes('dispatch-pre'))) continue;
      if (matcher === undefined) delete entry.matcher;
      else entry.matcher = matcher;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
  };

  it('passes on the canonical wiring', () => {
    expect(statusOf(doctor(buildFixture()), 'dispatch-matcher')).toBe('pass');
  });

  it('passes on an absent matcher, which is broader than the canonical one', () => {
    const fixture = buildFixture();
    rewireDispatch(fixture, undefined);
    expect(statusOf(doctor(fixture), 'dispatch-matcher')).toBe('pass');
  });

  it('warns when the matcher can never fire on Agent, and names what that costs', () => {
    // Present, current, substituted and completely dead. `hook-wiring` never
    // inspects a matcher, so without this row every other check reads green.
    const fixture = buildFixture();
    rewireDispatch(fixture, 'Edit|Write');
    const report = doctor(fixture);

    expect(statusOf(report, 'dispatch-matcher')).toBe('warn');
    expect(detailOf(report, 'dispatch-matcher')).toContain('no subagent is briefed');
    // `warn`, not `fail`: narrowing a matcher is a supported choice.
    expect(report.ok).toBe(true);
  });

  it('says nothing when no dispatch hook is wired at all', () => {
    // `hook-wiring` already fails on the entry by name; a second row would only
    // repeat it.
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    settings.hooks['PreToolUse'] = (settings.hooks['PreToolUse'] ?? []).filter(
      entry => !entry.hooks.some(hook => hook.command.includes('dispatch-pre')),
    );
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const report = doctor(fixture);
    expect(report.checks.find(check => check.id === 'dispatch-matcher')).toBeUndefined();
    expect(statusOf(report, 'hook-wiring')).toBe('fail');
  });
});
