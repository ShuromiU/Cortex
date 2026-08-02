import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HOOK_SCRIPTS,
  REQUIRED_WIRING,
  commandSatisfiesWiring,
  tokenizeCommand,
} from '../src/query/doctor.js';
import {
  IGNORE_ENTRIES,
  classifyInstalledScript,
  installedMatchesTemplate,
  mergeHookWiring,
  mergeIgnoreEntries,
  mergeMcpServer,
  renderHookScript,
  runInstall,
  writeFileAtomic,
  type InstallOptions,
  type InstallResult,
} from '../src/query/install.js';

// ── Fixture ───────────────────────────────────────────────────────────
//
// Everything is sandboxed: a temp HOME, a temp project, and injected Node/CLI
// paths. Nothing here may touch the developer's real ~/.claude or the
// repository's own files — an earlier version of the CLI round-trip test did
// exactly that and wrote to both.

let root: string;

interface Fixture {
  projectDir: string;
  homeDir: string;
  hooksDir: string;
  templateDir: string;
  nodePath: string;
  cliEntry: string;
  hookEntry: string;
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function buildFixture(): Fixture {
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const nodePath = path.join(binDir, 'node.exe');
  const cliEntry = path.join(binDir, 'cli.js');
  const hookEntry = path.join(binDir, 'hook-entry.js');
  for (const target of [nodePath, cliEntry, hookEntry]) fs.writeFileSync(target, '');

  return {
    projectDir,
    homeDir,
    hooksDir: path.join(homeDir, '.claude', 'hooks'),
    // The real shipped templates, so the round trip is against what users get.
    templateDir: path.resolve('hooks', 'claude'),
    nodePath,
    cliEntry,
    hookEntry,
  };
}

function install(fixture: Fixture, overrides: Partial<InstallOptions> = {}): InstallResult {
  return runInstall({
    projectDir: fixture.projectDir,
    homeDir: fixture.homeDir,
    hooksDir: fixture.hooksDir,
    templateDir: fixture.templateDir,
    nodePath: fixture.nodePath,
    cliEntry: fixture.cliEntry,
    hookEntry: fixture.hookEntry,
    ...overrides,
  });
}

function outcomeOf(result: InstallResult, id: string): string {
  const action = result.actions.find(entry => entry.id === id);
  if (!action) throw new Error(`no action ${id}; have ${result.actions.map(a => a.id).join(', ')}`);
  return action.outcome;
}

/** Every file under a root, with its bytes — for proving idempotency. */
function snapshotTree(dir: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else seen.set(full, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return seen;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-install-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── AC #1 ─────────────────────────────────────────────────────────────

describe('installing into a project with no Cortex configuration (AC #1)', () => {
  it('writes hook scripts with the placeholders substituted', () => {
    const fixture = buildFixture();
    const result = install(fixture);

    for (const script of HOOK_SCRIPTS) {
      expect(outcomeOf(result, `hook:${script}`)).toBe('created');
      const installed = fs.readFileSync(path.join(fixture.hooksDir, script), 'utf8');
      expect(installed).not.toMatch(/__CORTEX_[A-Z_]+__/);
      expect(installed).toMatch(/# cortex-hook-template: [0-9a-f]{16}/);
      expect(installed).toContain(fixture.nodePath);
    }
  });

  it('writes wiring that satisfies every check the diagnostic makes', () => {
    // The guarantee that matters: install and doctor share REQUIRED_WIRING, so
    // what one writes is what the other looks for. Asserted against the
    // predicate itself rather than against a literal string, because a literal
    // would pass even if the two constants drifted apart.
    const fixture = buildFixture();
    install(fixture);

    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };

    for (const required of REQUIRED_WIRING) {
      const entries = settings.hooks[required.event] ?? [];
      const satisfied = entries.some(entry =>
        entry.hooks.some(hook => commandSatisfiesWiring(hook.command, required)),
      );
      expect(satisfied, `${required.event} is not wired the way doctor checks for`).toBe(true);
    }
  });

  it('writes the matcher each event needs', () => {
    const fixture = buildFixture();
    install(fixture);
    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ matcher?: string }>> };

    expect(settings.hooks['PostToolUse']?.[0]?.matcher).toBe('Read|Edit|Write|Bash|Agent');
    expect(settings.hooks['PreToolUse']?.[0]?.matcher).toBe('Edit|Write');
    // Events with no matcher must not gain an empty one.
    expect(settings.hooks['Stop']?.[0]).not.toHaveProperty('matcher');
  });

  it('quotes paths containing spaces, so the wiring survives tokenization', () => {
    // Not hypothetical: this repository lives at `C:\Claude Code\cortex` and
    // Node at `C:\Program Files\nodejs\node.exe`. Unquoted, the shell splits
    // the command and the hook never runs — while the wiring check still
    // passes, because `inject-header` remains its own token.
    const fixture = buildFixture();
    const spaced = path.join(root, 'Program Files', 'node.exe');
    const spacedCli = path.join(root, 'Claude Code', 'cli.js');
    fs.mkdirSync(path.dirname(spaced), { recursive: true });
    fs.mkdirSync(path.dirname(spacedCli), { recursive: true });
    fs.writeFileSync(spaced, '');
    fs.writeFileSync(spacedCli, '');

    install(fixture, { nodePath: spaced, cliEntry: spacedCli });

    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const command = settings.hooks['SessionStart']![0]!.hooks[0]!.command;

    // The property, not the presence of a quote character: the command must
    // tokenize back to exactly the two paths it was built from.
    const tokens = tokenizeCommand(command);
    expect(tokens[0]).toBe(spaced);
    expect(tokens[1]).toBe(spacedCli);
  });

  it('registers the MCP server', () => {
    const fixture = buildFixture();
    install(fixture);
    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };

    expect(settings.mcpServers['cortex']?.command).toBe(fixture.nodePath);
    expect(settings.mcpServers['cortex']?.args).toEqual([fixture.cliEntry, 'serve']);
  });

  it('adds every runtime artifact to .gitignore', () => {
    const fixture = buildFixture();
    const result = install(fixture);
    expect(outcomeOf(result, 'ignore')).toBe('created');

    const ignore = fs.readFileSync(path.join(fixture.projectDir, '.gitignore'), 'utf8');
    for (const entry of IGNORE_ENTRIES) {
      expect(ignore.split(/\r?\n/)).toContain(entry);
    }
  });

  it('registers MCP in .mcp.json under project scope', () => {
    const fixture = buildFixture();
    install(fixture, { scope: 'project' });

    const mcp = JSON.parse(
      fs.readFileSync(path.join(fixture.projectDir, '.mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers['cortex']).toBeTruthy();
    expect(fs.existsSync(path.join(fixture.projectDir, '.claude', 'settings.json'))).toBe(true);
    // And it did not touch the user-scope file.
    expect(fs.existsSync(path.join(fixture.homeDir, '.claude', 'settings.json'))).toBe(false);
  });
});

// ── AC #2 ─────────────────────────────────────────────────────────────

describe('running again on an unmodified installation (AC #2)', () => {
  it('leaves every byte identical and reports that nothing changed', () => {
    // The property, not a proxy for it: capture the bytes of everything the
    // installer can touch, run again, and compare. Asserting only that the
    // command printed "nothing changed" would pass against an installer that
    // rewrote every file with identical content — and that still churns
    // mtimes, backups and, for settings.json, the user's formatting.
    const fixture = buildFixture();
    const first = install(fixture);
    expect(first.unchanged).toBe(false);

    const before = snapshotTree(root);
    const second = install(fixture);
    const after = snapshotTree(root);

    expect(second.unchanged).toBe(true);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, content] of after) {
      expect(content, `${file} changed on the second run`).toBe(before.get(file));
    }
  });

  it('reports each action as unchanged, not merely the run', () => {
    const fixture = buildFixture();
    install(fixture);
    const second = install(fixture);

    for (const action of second.actions) {
      expect(action.outcome, `${action.id} was not unchanged`).toBe('unchanged');
    }
  });

  it('does not append a second wiring entry', () => {
    const fixture = buildFixture();
    install(fixture);
    install(fixture);
    install(fixture);

    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]> };

    for (const required of REQUIRED_WIRING) {
      expect(settings.hooks[required.event], `${required.event} duplicated`).toHaveLength(1);
    }
  });

  it('recognises an existing wiring that was re-quoted or moved', () => {
    // Matching by string equality would append a duplicate here, doubling
    // every hook invocation for a user whose wiring already works.
    const fixture = buildFixture();
    install(fixture);

    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const stop = settings.hooks['Stop']![0]!;
    stop.hooks[0]!.command = 'bash ~/.claude/hooks/cortex-end-of-turn.sh';
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    install(fixture);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(after.hooks['Stop']).toHaveLength(1);
  });

  it('does not duplicate ignore entries already present', () => {
    const fixture = buildFixture();
    fs.writeFileSync(
      path.join(fixture.projectDir, '.gitignore'),
      `node_modules/\n${IGNORE_ENTRIES.join('\n')}\n`,
    );

    const result = install(fixture);
    expect(outcomeOf(result, 'ignore')).toBe('unchanged');

    const lines = fs
      .readFileSync(path.join(fixture.projectDir, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .filter(line => line === '.cortex.db');
    expect(lines).toHaveLength(1);
  });
});

// ── AC #3 ─────────────────────────────────────────────────────────────

describe('a hook script the user modified (AC #3)', () => {
  it('refuses to overwrite it, and names the flag that would', () => {
    const fixture = buildFixture();
    install(fixture);

    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    // Precondition: the file the installer just wrote is recognised as its own.
    const template = fs.readFileSync(path.join(fixture.templateDir, 'cortex-capture.sh'), 'utf8');
    expect(classifyInstalledScript(template, fs.readFileSync(target, 'utf8'))).toBe('unmodified');

    const edited = `${fs.readFileSync(target, 'utf8')}\n# my own line\n`;
    fs.writeFileSync(target, edited);
    expect(classifyInstalledScript(template, edited)).toBe('modified');

    const result = install(fixture);
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('refused');
    expect(result.refusals).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe(edited);

    const action = result.actions.find(a => a.id === 'hook:cortex-capture.sh');
    expect(action?.fix).toContain('--force');
  });

  it('overwrites with --force, keeping the previous copy', () => {
    const fixture = buildFixture();
    install(fixture);
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    const edited = `${fs.readFileSync(target, 'utf8')}\n# my own line\n`;
    fs.writeFileSync(target, edited);

    const result = install(fixture, { force: true });
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('updated');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('# my own line');
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(edited);
  });

  it('refusing one script does not half-apply the others', () => {
    const fixture = buildFixture();
    install(fixture);
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\n# edited\n`);

    const result = install(fixture);
    expect(outcomeOf(result, 'hook:cortex-reflect.sh')).toBe('unchanged');
    expect(outcomeOf(result, 'hook:cortex-end-of-turn.sh')).toBe('unchanged');
  });

  it('upgrades a script stamped by an older template rather than refusing it', () => {
    // The stale-stamp case, which is distinct from the unstamped one and is
    // the one that guards the contract with the diagnostic: a hook from an
    // older Cortex carries a stamp, just not this build's. Classifying it as
    // `modified` would make `cortex install` refuse to perform the upgrade
    // that `cortex doctor` tells the user to run it for.
    const fixture = buildFixture();
    const script = 'cortex-capture.sh';
    const template = fs.readFileSync(path.join(fixture.templateDir, script), 'utf8');
    const target = path.join(fixture.hooksDir, script);
    fs.mkdirSync(fixture.hooksDir, { recursive: true });

    const older = renderHookScript(template, {
      nodePath: fixture.nodePath,
      cliEntry: fixture.cliEntry,
      hookEntry: fixture.hookEntry,
    })
      .replace(/# cortex-hook-template: [0-9a-f]{16}/, '# cortex-hook-template: 0123456789abcdef')
      .replace('exit 0', 'exit 0 # an older template');
    fs.writeFileSync(target, older);

    // Precondition: it carries a stamp, and it is not this build's.
    expect(older).toMatch(/# cortex-hook-template: 0123456789abcdef/);
    expect(classifyInstalledScript(template, older)).toBe('unknown');

    const result = install(fixture);
    expect(outcomeOf(result, `hook:${script}`)).toBe('updated');
    expect(result.refusals).toBe(0);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(older);
  });

  it('backs up and overwrites an unstamped script rather than refusing', () => {
    // Every hook installed before the template stamp is unstamped, and the
    // diagnostic names this command as the fix for exactly those. Refusing
    // here would break the documented repair path for the most common
    // installation there is.
    const fixture = buildFixture();
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    fs.mkdirSync(fixture.hooksDir, { recursive: true });
    const legacy = '#!/bin/bash\n# an install that predates stamping\nexit 0\n';
    fs.writeFileSync(target, legacy);

    const result = install(fixture);
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('updated');
    expect(result.refusals).toBe(0);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(legacy);
    expect(fs.readFileSync(target, 'utf8')).toMatch(/# cortex-hook-template: [0-9a-f]{16}/);
  });
});

// ── Settings safety ───────────────────────────────────────────────────

describe('writing a settings file the user owns', () => {
  it('preserves every key it does not own', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        effortLevel: 'xhigh',
        mcpServers: { other: { command: 'node', args: ['/x/y.js'] } },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'bash ~/other.sh' }] }],
        },
      }),
    );

    install(fixture);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(after['permissions']).toEqual({ allow: ['Bash(ls)'] });
    expect(after['effortLevel']).toBe('xhigh');
    expect((after['mcpServers'] as Record<string, unknown>)['other']).toEqual({
      command: 'node',
      args: ['/x/y.js'],
    });
    // The unrelated SessionStart hook survives alongside the new one.
    const sessionStart = (after['hooks'] as Record<string, unknown[]>)['SessionStart']!;
    expect(sessionStart).toHaveLength(2);
  });

  it('leaves an existing cortex MCP entry alone', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { cortex: { command: 'cortex', args: ['serve'] } } }),
    );

    install(fixture);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    // It may point at a checkout the user prefers; replacing it is not this
    // command's call.
    expect(after.mcpServers['cortex']?.command).toBe('cortex');
  });

  it('refuses a settings file that does not parse, and does not clobber it', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const broken = '{ "hooks": ';
    fs.writeFileSync(settingsPath, broken);

    const result = install(fixture);
    expect(outcomeOf(result, 'settings')).toBe('refused');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
    expect(result.actions.find(a => a.id === 'settings')?.fix).toContain('JSON syntax');
  });

  it('backs the settings file up before the first modification, and not after', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ effortLevel: 'high' }));

    install(fixture);
    expect(fs.existsSync(`${settingsPath}.bak`)).toBe(true);

    // A no-op run must not churn the backup.
    const backupBefore = fs.readFileSync(`${settingsPath}.bak`, 'utf8');
    install(fixture);
    expect(fs.readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(backupBefore);
  });

  it('leaves no temp file behind', () => {
    const fixture = buildFixture();
    install(fixture);
    const settingsDir = path.join(fixture.homeDir, '.claude');
    expect(fs.readdirSync(settingsDir).filter(name => name.includes('cortex-tmp'))).toEqual([]);
  });
});

// ── --dry-run ─────────────────────────────────────────────────────────

describe('--dry-run', () => {
  it('computes every outcome and writes nothing at all', () => {
    const fixture = buildFixture();
    const before = snapshotTree(root);

    const result = install(fixture, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.unchanged).toBe(false);
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('created');

    const after = snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('reports the same outcomes the real run then produces', () => {
    const fixture = buildFixture();
    const planned = install(fixture, { dryRun: true });
    const applied = install(fixture);
    expect(applied.actions.map(a => `${a.id}:${a.outcome}`)).toEqual(
      planned.actions.map(a => `${a.id}:${a.outcome}`),
    );
  });
});

// ── Primitives ────────────────────────────────────────────────────────

describe('installedMatchesTemplate', () => {
  const template = '#!/bin/bash\n# id: __CORTEX_TEMPLATE_ID__\n"__CORTEX_NODE__" "__CORTEX_CLI__"\n"__CORTEX_NODE__" x\n';

  it('accepts the template rendered with any paths', () => {
    const rendered = renderHookScript(template, {
      nodePath: '/a b/node',
      cliEntry: '/c/cli.js',
      hookEntry: '/c/hook.js',
    });
    expect(installedMatchesTemplate(template, rendered)).toBe(true);
  });

  it('rejects an added line', () => {
    const rendered = `${renderHookScript(template, { nodePath: '/n', cliEntry: '/c', hookEntry: '/h' })}# extra\n`;
    expect(installedMatchesTemplate(template, rendered)).toBe(false);
  });

  it('requires repeated placeholders to have the same value', () => {
    // A script whose two Node references disagree was edited, whatever else
    // about it looks right. A per-occurrence wildcard would accept it.
    const forged = '#!/bin/bash\n# id: abc\n"/one/node" "/c/cli.js"\n"/two/node" x\n';
    expect(installedMatchesTemplate(template, forged)).toBe(false);
  });

  it('ignores line-ending style', () => {
    const rendered = renderHookScript(template, {
      nodePath: '/n',
      cliEntry: '/c',
      hookEntry: '/h',
    });
    expect(installedMatchesTemplate(template, rendered.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('treats an unrecognised __CORTEX_*__ token as literal text, not a wildcard', () => {
    // The split pattern lists four placeholders; a second, broader test for
    // "is this a placeholder" would turn any other `__CORTEX_X__` token into an
    // unconstrained capture that matches anything. No shipped template has one
    // — this pins that the two patterns cannot drift apart.
    // Adjacency is what makes it reachable: splitting on the four known
    // placeholders leaves an unknown one as a fragment of its own only when
    // nothing separates it from a known token.
    const template = '#!/bin/bash\n"__CORTEX_NODE____CORTEX_SPOOL____CORTEX_CLI__"\n';
    const rendered = renderHookScript(template, {
      nodePath: '/n/node',
      cliEntry: '/c/cli.js',
      hookEntry: '/h',
    });
    expect(rendered).toContain('__CORTEX_SPOOL__');
    expect(installedMatchesTemplate(template, rendered)).toBe(true);
    expect(
      installedMatchesTemplate(template, rendered.replace('__CORTEX_SPOOL__', 'ANYTHING-AT-ALL')),
    ).toBe(false);
  });

  it('is not fooled by regex metacharacters in the template', () => {
    const tricky = '#!/bin/bash\ncase "$X" in\n  a|b) echo "(.+?)" ;;\nesac\n"__CORTEX_NODE__"\n';
    const rendered = renderHookScript(tricky, {
      nodePath: '/n',
      cliEntry: '/c',
      hookEntry: '/h',
    });
    expect(installedMatchesTemplate(tricky, rendered)).toBe(true);
    expect(installedMatchesTemplate(tricky, rendered.replace('esac', 'done'))).toBe(false);
  });
});

describe('mergeIgnoreEntries', () => {
  it('appends only what is missing', () => {
    const result = mergeIgnoreEntries('node_modules/\n.cortex.db\n', ['.cortex.db', '.cortex.state']);
    expect(result.added).toEqual(['.cortex.state']);
    expect(result.text.split(/\n/).filter(line => line === '.cortex.db')).toHaveLength(1);
  });

  it('matches after trimming, so an indented entry counts', () => {
    const result = mergeIgnoreEntries('  .cortex.db  \n', ['.cortex.db']);
    expect(result.added).toEqual([]);
    expect(result.text).toBe('  .cortex.db  \n');
  });

  it('adds a newline before appending to a file that lacks one', () => {
    const result = mergeIgnoreEntries('dist/', ['.cortex.db']);
    expect(result.text).toContain('dist/\n');
    expect(result.text.split(/\n/)).toContain('.cortex.db');
  });

  it('returns the input untouched when nothing is missing', () => {
    const original = 'a\nb\n';
    expect(mergeIgnoreEntries(original, ['a', 'b'])).toEqual({ text: original, added: [] });
  });
});

describe('mergeHookWiring / mergeMcpServer', () => {
  const paths = { nodePath: '/n/node', cliEntry: '/n/cli.js', hookEntry: '/n/hook.js' };

  it('reports changed only when it adds something', () => {
    const first = mergeHookWiring({}, '/hooks', paths);
    expect(first.changed).toBe(true);
    const second = mergeHookWiring(first.value, '/hooks', paths);
    expect(second.changed).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it('tolerates a hooks value of the wrong shape rather than throwing', () => {
    const result = mergeHookWiring({ hooks: 'nonsense' }, '/hooks', paths);
    expect(result.changed).toBe(true);
    expect(result.value['hooks']).toHaveProperty('Stop');
  });

  it('does not replace an existing cortex server', () => {
    const existing = { mcpServers: { cortex: { command: 'x' } } };
    expect(mergeMcpServer(existing, { command: 'y' })).toEqual({ value: existing, changed: false });
  });
});

describe('writeFileAtomic', () => {
  it('creates parent directories and leaves no temp file', () => {
    const target = path.join(root, 'deep', 'nested', 'file.json');
    writeFileAtomic(target, '{}\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('{}\n');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.json']);
  });

  it('replaces existing content', () => {
    const target = path.join(root, 'file.txt');
    writeFileAtomic(target, 'one');
    writeFileAtomic(target, 'two');
    expect(fs.readFileSync(target, 'utf8')).toBe('two');
  });
});

// ── Repairs from the story 2.4 review ─────────────────────────────────

describe('repairing an existing wiring, not just detecting one', () => {
  it('rewrites a PostToolUse matcher that has lost Agent', () => {
    // `doctor` warns about this and its fix says "or run `cortex install`,
    // which writes it". Presence was decided by the command alone, so the
    // matcher was never touched and the fix was a no-op — the exact loop
    // doctor.ts says must never exist.
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const posixHooks = fixture.hooksDir.split(path.sep).join('/');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Read|Edit|Write|Bash',
              hooks: [{ type: 'command', command: `bash "${posixHooks}/cortex-capture.sh"` }],
            },
          ],
        },
      }),
    );

    install(fixture);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };
    expect(after.hooks['PostToolUse']).toHaveLength(1);
    expect(after.hooks['PostToolUse']![0]!.matcher).toBe('Read|Edit|Write|Bash|Agent');
  });

  it('rewrites a SessionStart command whose Node moved', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: '"/gone/node.exe" "/gone/cli.js" inject-header --quiet' }] },
          ],
        },
      }),
    );

    install(fixture);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(after.hooks['SessionStart']).toHaveLength(1);
    const tokens = tokenizeCommand(after.hooks['SessionStart']![0]!.hooks[0]!.command);
    expect(tokens[0]).toBe(fixture.nodePath);
    expect(tokens[1]).toBe(fixture.cliEntry);
  });

  it('converges: a second run after a repair reports unchanged', () => {
    const fixture = buildFixture();
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const posixHooks = fixture.hooksDir.split(path.sep).join('/');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Read|Edit|Write|Bash',
              hooks: [{ type: 'command', command: `bash "${posixHooks}/cortex-capture.sh"` }],
            },
          ],
        },
      }),
    );
    install(fixture);
    expect(install(fixture).unchanged).toBe(true);
  });

  it('reports the number of events it actually wired', () => {
    const fixture = buildFixture();
    install(fixture);

    // Remove one wiring, leaving four.
    const settingsPath = path.join(fixture.homeDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks['Stop'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = install(fixture);
    const detail = result.actions.find(action => action.id === 'settings')?.detail ?? '';
    expect(detail).toContain('wired 1 event');
    expect(detail).not.toContain('5 events');
  });
});

describe('settings files Claude Code merges', () => {
  it('does not add a second entry for an event another file already wires', () => {
    // Claude Code reads the union of the project and user settings files, so a
    // second entry does not replace the first — both fire, doubling every
    // spool line, reflex and flush, and neither install nor doctor can see it.
    const fixture = buildFixture();
    const posixHooks = fixture.hooksDir.split(path.sep).join('/');
    writeFile(
      path.join(fixture.projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `bash "${posixHooks}/cortex-end-of-turn.sh"` }] }],
        },
      }),
    );

    install(fixture);

    const userSettings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[] | undefined> };
    expect(userSettings.hooks['Stop']).toBeUndefined();
    // The events that file does not wire are still written here.
    expect(userSettings.hooks['PostToolUse']).toHaveLength(1);
  });
});

describe('an edit confined to a placeholder slot (AC #3)', () => {
  it('is detected as modified, not silently overwritten', () => {
    // The capture was `[^\n]+?`, so any edit leaving the surrounding literal
    // text intact read as `unmodified` — and `unmodified` overwrote with no
    // backup. Verified against every shipped script, not only the one that
    // happens to repeat a placeholder.
    const fixture = buildFixture();
    install(fixture);

    for (const script of HOOK_SCRIPTS) {
      const template = fs.readFileSync(path.join(fixture.templateDir, script), 'utf8');
      const target = path.join(fixture.hooksDir, script);
      const clean = fs.readFileSync(target, 'utf8');
      expect(classifyInstalledScript(template, clean)).toBe('unmodified');

      // Close the quote, add a command, reopen it. Nothing outside the slot moves.
      const injected = clean.replace(
        `"${fixture.nodePath}"`,
        `"${fixture.nodePath}" ; echo edited ; "${fixture.nodePath}"`,
      );
      expect(injected, `${script} has no node placeholder to edit`).not.toBe(clean);
      expect(classifyInstalledScript(template, injected), script).toBe('modified');
    }
  });

  it('refuses such a script and leaves it on disk', () => {
    const fixture = buildFixture();
    install(fixture);
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    const injected = fs
      .readFileSync(target, 'utf8')
      .replace(`"${fixture.nodePath}"`, `"${fixture.nodePath}" ; echo edited ; "${fixture.nodePath}"`);
    fs.writeFileSync(target, injected);

    const result = install(fixture);
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('refused');
    expect(fs.readFileSync(target, 'utf8')).toBe(injected);
  });

  it('keeps a backup on every overwrite of existing content', () => {
    // Including the `unmodified` path, which previously got none — and which
    // is where an edited script landed.
    const fixture = buildFixture();
    install(fixture);
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    const original = fs.readFileSync(target, 'utf8');

    const moved = path.join(root, 'moved-node.exe');
    fs.writeFileSync(moved, '');
    install(fixture, { nodePath: moved });

    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(original);
  });
});

describe('paths the shell would mangle', () => {
  it('refuses a hooks directory containing a shell expander', () => {
    // Double quotes do not protect `$` or a backtick, so the written wiring
    // would resolve somewhere else — and `doctor` would report it healthy,
    // because it reads the literal string and finds the file at the literal
    // path. `$(...)` would be executed on every hook fire.
    const fixture = buildFixture();
    const unsafe = path.join(root, 'ho$me', 'hooks');
    const result = install(fixture, { hooksDir: unsafe });

    expect(outcomeOf(result, 'hooks-dir')).toBe('refused');
    expect(result.refusals).toBe(1);
    expect(result.actions.find(a => a.id === 'hooks-dir')?.fix).toContain('--dir');
    expect(fs.existsSync(unsafe)).toBe(false);
  });

  it('accepts an ordinary path with spaces', () => {
    const fixture = buildFixture();
    const spaced = path.join(root, 'Program Files', 'hooks');
    const result = install(fixture, { hooksDir: spaced });
    expect(result.refusals).toBe(0);
    expect(fs.existsSync(path.join(spaced, 'cortex-capture.sh'))).toBe(true);
  });

  it('expands ~ in an explicit hooks directory', () => {
    const fixture = buildFixture();
    const result = install(fixture, { hooksDir: '~/elsewhere' });
    expect(result.hooks_dir).toBe(path.normalize(path.join(fixture.homeDir, 'elsewhere')));
    expect(fs.existsSync(path.join(fixture.homeDir, 'elsewhere', 'cortex-capture.sh'))).toBe(true);
  });
});

describe('filesystem errors', () => {
  it('reports a .gitignore that is a directory instead of throwing', () => {
    const fixture = buildFixture();
    fs.mkdirSync(path.join(fixture.projectDir, '.gitignore'));

    // Previously this threw EISDIR out of runInstall, after three hook scripts
    // and the settings file had already been written.
    const result = install(fixture);
    expect(outcomeOf(result, 'ignore')).toBe('refused');
    expect(result.actions.find(a => a.id === 'ignore')?.fix).toBeTruthy();
    // And the actions that did succeed are still reported.
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('created');
  });

  it('reports a hook script path that is a directory instead of throwing', () => {
    const fixture = buildFixture();
    fs.mkdirSync(path.join(fixture.hooksDir, 'cortex-capture.sh'), { recursive: true });

    const result = install(fixture);
    expect(outcomeOf(result, 'hook:cortex-capture.sh')).toBe('refused');
    expect(outcomeOf(result, 'hook:cortex-reflect.sh')).toBe('created');
  });
});

describe('defaults', () => {
  it('resolves real CLI and hook-entry paths rather than empty strings', () => {
    // Defaulting these to '' wrote `"<node>" "" flush-spool`, skipped
    // SessionStart silently, and made the next run refuse all three scripts as
    // user-edited — the installer accusing the user of editing its own output.
    const fixture = buildFixture();
    const result = runInstall({
      projectDir: fixture.projectDir,
      homeDir: fixture.homeDir,
      hooksDir: fixture.hooksDir,
      templateDir: fixture.templateDir,
      nodePath: fixture.nodePath,
    });
    expect(result.refusals).toBe(0);

    const settings = JSON.parse(
      fs.readFileSync(path.join(fixture.homeDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]>; mcpServers: Record<string, { args: string[] }> };
    expect(settings.hooks['SessionStart']).toHaveLength(1);
    expect(settings.mcpServers['cortex']?.args[0]).not.toBe('');
    // The invocation line must name a real CLI path, not an empty argument.
    // (`LINE=""` appears legitimately in the template, so a bare `""` search
    // would be a false positive.)
    const capture = fs.readFileSync(path.join(fixture.hooksDir, 'cortex-capture.sh'), 'utf8');
    expect(capture).not.toMatch(/"[^"\n]*node[^"\n]*"\s+""/);
    expect(capture).toContain('cli.js');

    // And it converges rather than refusing its own output.
    const second = runInstall({
      projectDir: fixture.projectDir,
      homeDir: fixture.homeDir,
      hooksDir: fixture.hooksDir,
      templateDir: fixture.templateDir,
      nodePath: fixture.nodePath,
    });
    expect(second.refusals).toBe(0);
    expect(second.unchanged).toBe(true);
  });
});

describe('line endings', () => {
  it('writes LF scripts even from a CRLF template', () => {
    // No .gitattributes, so a Windows checkout has CRLF templates. Every
    // validator normalises before comparing, so a CRLF script was written and
    // reported fully current — while bash on Linux, macOS and WSL rejects it,
    // and `npm pack` from Windows shipped it.
    const fixture = buildFixture();
    const crlfDir = path.join(root, 'crlf-templates');
    fs.mkdirSync(crlfDir, { recursive: true });
    for (const script of HOOK_SCRIPTS) {
      const text = fs.readFileSync(path.join(fixture.templateDir, script), 'utf8');
      fs.writeFileSync(path.join(crlfDir, script), text.replace(/\r?\n/g, '\r\n'));
    }

    install(fixture, { templateDir: crlfDir });

    for (const script of HOOK_SCRIPTS) {
      const bytes = fs.readFileSync(path.join(fixture.hooksDir, script));
      expect(bytes.includes(0x0d), `${script} carries CR bytes`).toBe(false);
    }
  });
});

describe('the ignore list', () => {
  it('is exactly the nine runtime artifacts, by literal', () => {
    // Not `for (entry of IGNORE_ENTRIES) expect(text).toContain(entry)` —
    // that can never fail for a missing entry, because the loop is over the
    // same constant the code used.
    expect([...IGNORE_ENTRIES]).toEqual([
      '.cortex.db',
      '.cortex.db-wal',
      '.cortex.db-shm',
      '.cortex.spool.jsonl',
      '.cortex.spool.jsonl.processing',
      '.cortex.state',
      '.cortex.agent-used',
      // Story 3.2's flat digest index. In the project root for the same reason
      // the spool is — the hot path resolves it in pure bash from $CWD and
      // cannot hash a store path per tool call.
      '.cortex.index',
      // And its atomic-write temp file, for the same reason
      // `.cortex.spool.jsonl.processing` is listed beside the spool.
      '.cortex.index.tmp-*',
    ]);
  });

  it('does not begin a new .gitignore with a blank line', () => {
    const fixture = buildFixture();
    install(fixture);
    const text = fs.readFileSync(path.join(fixture.projectDir, '.gitignore'), 'utf8');
    expect(text.startsWith('\n')).toBe(false);
    expect(text.startsWith('# Cortex runtime artifacts')).toBe(true);
  });
});

describe('--dry-run reporting', () => {
  it('does not claim a backup it did not write', () => {
    const fixture = buildFixture();
    const target = path.join(fixture.hooksDir, 'cortex-capture.sh');
    fs.mkdirSync(fixture.hooksDir, { recursive: true });
    fs.writeFileSync(target, '#!/bin/bash\n# a pre-stamp install\nexit 0\n');

    const result = install(fixture, { dryRun: true });
    const detail = result.actions.find(a => a.id === 'hook:cortex-capture.sh')?.detail ?? '';
    expect(detail).toContain('would be saved');
    expect(detail).not.toContain('; previous copy saved to');
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });
});

// ── Missing templates ─────────────────────────────────────────────────

describe('a build shipping no templates', () => {
  it('refuses rather than writing an empty hook', () => {
    const fixture = buildFixture();
    const result = install(fixture, { templateDir: path.join(root, 'nowhere') });

    for (const script of HOOK_SCRIPTS) {
      expect(outcomeOf(result, `hook:${script}`)).toBe('refused');
      expect(fs.existsSync(path.join(fixture.hooksDir, script))).toBe(false);
    }
    expect(result.refusals).toBe(HOOK_SCRIPTS.length);
  });
});
