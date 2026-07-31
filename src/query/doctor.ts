import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveSpoolPath } from '../capture/spool.js';
import { SCHEMA_VERSION, getSchemaVersion, openDatabaseReadOnly } from '../db/schema.js';

/**
 * Installation diagnostics (FR-23).
 *
 * The rule that shapes every check here: **diagnose the configuration that
 * exists, not the one the installer would have written.** A hook that Cortex
 * would install correctly is not evidence about the hook the host actually
 * runs — and the gap between those two is the entire failure mode this command
 * exists for, where a broken hook masquerades as an empty memory.
 *
 * Two disciplines follow from it and are load-bearing throughout:
 *
 *  - **Nothing here mutates what it observes.** No session, no engagement
 *    write, no `ensureCortexSchema`, no spool flush. A diagnostic that repairs
 *    the thing it is checking cannot report on it: opening the store the normal
 *    way would migrate `schema_version` to the value the check compares
 *    against, so the mismatch could never be seen. Same rule `list-memory` and
 *    `inspect-memory` follow, binding harder.
 *  - **No process is spawned.** `jq` and the hook interpreter are located on
 *    `PATH` rather than executed. That keeps the 3-second budget (B-7)
 *    structural rather than tuned on a platform where `bash -c 'exit 0'` alone
 *    measures ~36 ms, makes the negative cases testable by pointing `PATH` at a
 *    fixture directory, and avoids executing arbitrary binaries found on a
 *    user's `PATH` while diagnosing. The honest limit: a present-but-broken
 *    `jq` resolves and is reported as available.
 */

// ── Report shape ──────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Concrete command or edit. Required on every non-passing check (AC #3). */
  fix?: string;
}

export interface DoctorReport {
  project: string;
  hooks_dir: string | null;
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
  /** No failing check. Drives the exit code; warnings never do. */
  ok: boolean;
}

export interface DoctorOptions {
  projectDir: string;
  /** Overridable so tests need neither a real home directory nor a real PATH. */
  homeDir?: string;
  hooksDir?: string;
  templateDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: Date;
}

// ── Constants ─────────────────────────────────────────────────────────

export const HOOK_SCRIPTS = [
  'cortex-capture.sh',
  'cortex-reflect.sh',
  'cortex-end-of-turn.sh',
] as const;

/** Placeholder the installer substitutes with `hookTemplateDigest`. */
export const TEMPLATE_ID_PLACEHOLDER = '__CORTEX_TEMPLATE_ID__';
const TEMPLATE_STAMP_PREFIX = '# cortex-hook-template:';

/** Matches the detached-flush threshold in `cortex-capture.sh`. */
export const SPOOL_THRESHOLD_BYTES = 262144;
/** A non-empty spool older than this suggests the turn-end flush is not firing. */
export const SPOOL_STALE_MS = 60 * 60 * 1000;

/**
 * The wirings `install-hooks` prints, matched against a command's **tokens**.
 *
 * Not a raw substring of the command: the snippet `install-hooks` itself prints
 * quotes the script path (`bash "…/cortex-reflect.sh" reflect-pre`), so a
 * needle of `cortex-reflect.sh reflect-pre` never matches the canonical wiring
 * — the diagnostic would report a correct installation as unwired. Matching on
 * the script's basename and, where it matters, a separate action token, holds
 * for quoted and unquoted paths, `~` and absolute alike.
 */
interface RequiredWiring {
  event: string;
  label: string;
  script?: string;
  /** A token that must also be present, e.g. the reflect action. */
  action?: string;
  /** A token that must be present when `script` is not the discriminator. */
  token?: string;
  /** When the action may be omitted because the script defaults to it. */
  actionOptionalUnless?: string;
}

const REQUIRED_WIRING: readonly RequiredWiring[] = [
  { event: 'SessionStart', label: 'SessionStart (session brief)', token: 'inject-header' },
  { event: 'PostToolUse', label: 'PostToolUse (capture)', script: 'cortex-capture.sh' },
  {
    event: 'PreToolUse',
    label: 'PreToolUse (reflex)',
    script: 'cortex-reflect.sh',
    action: 'reflect-pre',
  },
  {
    event: 'UserPromptSubmit',
    label: 'UserPromptSubmit (consult hint)',
    script: 'cortex-reflect.sh',
    action: 'reflect-prompt',
    // `cortex-reflect.sh` runs `ACTION="${1:-reflect-prompt}"`, so a wiring
    // that omits the argument is functionally the prompt reflex. Only an
    // explicit `reflect-pre` makes it something else.
    actionOptionalUnless: 'reflect-pre',
  },
  { event: 'Stop', label: 'Stop (flush + nudge)', script: 'cortex-end-of-turn.sh' },
];

/** True when a settings command implements the given wiring. */
export function commandSatisfiesWiring(command: string, required: RequiredWiring): boolean {
  const tokens = tokenizeCommand(command);

  if (required.token !== undefined && !tokens.includes(required.token)) return false;

  if (required.script !== undefined) {
    const hasScript = tokens.some(token => {
      const normalized = token.replace(/\\/g, '/');
      return normalized.endsWith(`/${required.script}`) || normalized === required.script;
    });
    if (!hasScript) return false;
  }

  if (required.action !== undefined && !tokens.includes(required.action)) {
    if (required.actionOptionalUnless === undefined) return false;
    if (tokens.includes(required.actionOptionalUnless)) return false;
  }

  return true;
}

const INSTALL_FIX = 'Run `cortex install-hooks --claude` and merge the printed hooks JSON.';

// ── Primitives ────────────────────────────────────────────────────────

/**
 * Identity of a hook template, stamped into the script at install time and
 * recompared here.
 *
 * Line endings are normalised first: templates are checked out through git and
 * working files in this repository are CRLF, so an unnormalised digest reports
 * a false "out of date" against a clone with a different `core.autocrlf`. False
 * stale is the safe direction — the fix is idempotent — but it is still noise.
 *
 * A content digest rather than a hand-maintained version number on purpose: a
 * number you must remember to bump fails in exactly the shape this check
 * exists to catch, where the hook is stale while everything about it looks
 * fine.
 */
export function hookTemplateDigest(templateText: string): string {
  const normalized = templateText.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/** Read the `# cortex-hook-template:` stamp from an installed script. */
export function readTemplateStamp(scriptText: string): string | null {
  for (const line of scriptText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(TEMPLATE_STAMP_PREFIX)) {
      const value = trimmed.slice(TEMPLATE_STAMP_PREFIX.length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Expand a leading `~`, which the shell expands and Node does not — the live
 * wiring on this machine is `bash ~/.claude/hooks/cortex-capture.sh`, so
 * skipping this reports every configured script as missing.
 */
export function expandHome(target: string, homeDir: string): string {
  if (target === '~') return homeDir;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(homeDir, target.slice(2));
  }
  return target;
}

/**
 * Split a settings hook command into shell-ish tokens, honouring both quote
 * styles. Needed because the SessionStart command quotes two absolute paths
 * that contain spaces (`"C:/Program Files/nodejs/node.exe"`).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

function statIsFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate an executable the way the shell would (N-6).
 *
 * `which bash` inside Git Bash answers `/usr/bin/bash`, which Node resolves
 * against the drive root and does not find — so `existsSync` on the configured
 * interpreter reports it missing on the exact platform the user runs. A bare
 * word is therefore resolved through `PATH` honouring `PATHEXT`, and a
 * POSIX-absolute path that does not exist on win32 falls back to resolving its
 * basename the same way, because under Git Bash that path does name a real
 * interpreter.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string | null {
  if (name.length === 0) return null;

  const expanded = expandHome(name, homeDir);
  const looksLikePath = expanded.includes('/') || expanded.includes('\\');

  if (looksLikePath) {
    if (statIsFile(expanded)) return expanded;
    if (platform === 'win32' && expanded.startsWith('/')) {
      const viaPath = searchPath(path.posix.basename(expanded), env, platform);
      if (viaPath) return viaPath;
    }
    return null;
  }

  return searchPath(expanded, env, platform);
}

function searchPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const extensions =
    platform === 'win32'
      ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext.length > 0)
      : [];

  for (const dir of raw.split(separator)) {
    if (dir.length === 0) continue;
    const base = path.join(dir, name);
    if (statIsFile(base)) return base;
    for (const ext of extensions) {
      // Lowercase first: `PATHEXT` is conventionally uppercase (`.EXE`) while
      // the files on disk are not, and Windows' case-insensitive lookup would
      // otherwise report `bash.EXE` for a file named `bash.exe`. The reported
      // path is what a user compares against `where`, so it should be the one
      // that exists. Exact fidelity for a genuinely uppercase filename would
      // need a directory read; this costs one extra stat only when it misses.
      for (const candidate of [base + ext.toLowerCase(), base + ext]) {
        if (statIsFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

const PATH_PLACEHOLDERS = ['__CORTEX_NODE__', '__CORTEX_CLI__', '__CORTEX_HOOK_ENTRY__'] as const;

/**
 * Recover the absolute paths `install-hooks` substituted into a script, by
 * anchoring on the template line each placeholder sits in.
 *
 * Deliberately not a content pattern over the installed file. The obvious
 * version — "any quoted token containing `node` or `.js`" — matches
 * `SPOOL="$CWD/.cortex.spool.jsonl"`, because `.jsonl` contains `.js`, and
 * then reports the spool file as a missing Node installation. Measured against
 * the live install before this was rewritten. Anchoring on the template makes
 * the extraction exact: whatever the placeholder expanded to is whatever sits
 * at that position on that line.
 *
 * A stale script may no longer contain the template's line, in which case
 * nothing is recovered from it — acceptable, because the currency check has
 * already failed by then and names the same fix.
 */
export function extractBakedPaths(templateText: string, installedText: string): string[] {
  const installed = installedText.replace(/\r\n/g, '\n');
  const found: string[] = [];

  for (const line of templateText.replace(/\r\n/g, '\n').split('\n')) {
    const placeholders = PATH_PLACEHOLDERS.filter(placeholder => line.includes(placeholder));
    if (placeholders.length === 0) continue;

    const pattern = line
      .split(/(__CORTEX_(?:NODE|CLI|HOOK_ENTRY)__)/)
      .map(part =>
        (PATH_PLACEHOLDERS as readonly string[]).includes(part)
          ? '(.+?)'
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');

    const match = new RegExp(`^${pattern}$`, 'm').exec(installed);
    if (!match) continue;
    for (const captured of match.slice(1)) {
      if (captured && captured.length > 0) found.push(captured);
    }
  }
  return found;
}

interface JsonFile {
  path: string;
  value: Record<string, unknown> | null;
  /** Present when the file exists but does not parse. */
  error: string | null;
}

function readJsonFile(target: string): JsonFile | null {
  if (!fs.existsSync(target)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path: target, value: null, error: 'not a JSON object' };
    }
    return { path: target, value: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return {
      path: target,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Every `.hooks.<Event>[].hooks[].command` string in a settings object, with
 * the event it is wired to. Tolerant of shape: a settings file is user-edited
 * and a malformed branch must not abort discovery of the rest.
 */
export function collectHookCommands(
  settings: Record<string, unknown>,
): Array<{ event: string; command: string }> {
  const found: Array<{ event: string; command: string }> = [];
  const hooks = settings['hooks'];
  if (hooks === null || typeof hooks !== 'object') return found;

  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (matcher === null || typeof matcher !== 'object') continue;
      const entries = (matcher as Record<string, unknown>)['hooks'];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const command = (entry as Record<string, unknown>)['command'];
        if (typeof command === 'string' && command.length > 0) {
          found.push({ event, command });
        }
      }
    }
  }
  return found;
}

/** True when `mcpServers.cortex` is registered in a settings-shaped object. */
function hasCortexServer(container: Record<string, unknown> | null): boolean {
  if (!container) return false;
  const servers = container['mcpServers'];
  if (servers === null || typeof servers !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(servers, 'cortex');
}

// ── The command ───────────────────────────────────────────────────────

/**
 * Engagement state path. Re-derived rather than imported: the canonical writer
 * is `transports/mcp.ts`, and `query/` must not import from `transports/`. The
 * two are pinned equal by test rather than by comment.
 */
function deriveStatePath(dir: string): string {
  return path.join(dir, '.cortex.state');
}

/**
 * `dist/query/doctor.js` → `<package root>/hooks/claude`, the same resolution
 * `install-hooks` uses, so the two always compare against one set of templates.
 * `fileURLToPath` rather than `new URL(...).pathname`, which yields `/C:/...`
 * on Windows.
 */
function defaultTemplateDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..', '..', 'hooks', 'claude');
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const projectDir = options.projectDir;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const templateDir = options.templateDir ?? defaultTemplateDir();
  const now = options.now ?? new Date();

  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => {
    checks.push(check);
  };

  // ── Settings discovery ──────────────────────────────────────────────
  const settingsPaths = [
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ];
  const settingsFiles = settingsPaths
    .map(readJsonFile)
    .filter((file): file is JsonFile => file !== null);
  const malformed = settingsFiles.filter(file => file.error !== null);

  if (settingsFiles.length === 0) {
    add({
      id: 'settings',
      label: 'Settings files',
      status: 'fail',
      detail: `No settings file found (looked in ${settingsPaths.join(', ')})`,
      fix: INSTALL_FIX,
    });
  } else if (malformed.length > 0) {
    add({
      id: 'settings',
      label: 'Settings files',
      status: 'fail',
      detail: malformed.map(file => `${file.path}: ${file.error ?? 'unreadable'}`).join('; '),
      fix: 'Fix the JSON syntax in the named file; Claude Code ignores a settings file it cannot parse.',
    });
  } else {
    add({
      id: 'settings',
      label: 'Settings files',
      status: 'pass',
      detail: `${settingsFiles.length} readable (${settingsFiles.map(f => f.path).join(', ')})`,
    });
  }

  const commands = settingsFiles.flatMap(file =>
    file.value ? collectHookCommands(file.value) : [],
  );

  // ── Engagement ──────────────────────────────────────────────────────
  const statePath = deriveStatePath(projectDir);
  if (!fs.existsSync(statePath)) {
    add({
      id: 'engagement',
      label: 'Engagement state',
      status: 'fail',
      detail: `${statePath} does not exist — the SessionStart hook has never run in this project`,
      fix: 'Run `cortex inject-header --quiet` here, then check the SessionStart wiring.',
    });
  } else {
    const stateText = fs.readFileSync(statePath, 'utf8');
    const enabled = /^enabled=true$/m.test(stateText);
    add(
      enabled
        ? {
            id: 'engagement',
            label: 'Engagement state',
            status: 'pass',
            detail: 'enabled=true',
          }
        : {
            id: 'engagement',
            label: 'Engagement state',
            status: 'warn',
            detail: 'Cortex is disengaged for this project (capture and reflex are off)',
            fix: 'Call `cortex_engage` to re-enable capture.',
          },
    );
  }

  // ── Hook wiring ─────────────────────────────────────────────────────
  const missingWiring = REQUIRED_WIRING.filter(
    required =>
      !commands.some(
        entry =>
          entry.event === required.event && commandSatisfiesWiring(entry.command, required),
      ),
  );
  add(
    missingWiring.length === 0
      ? {
          id: 'hook-wiring',
          label: 'Hook wiring',
          status: 'pass',
          detail: `all ${REQUIRED_WIRING.length} events wired`,
        }
      : {
          id: 'hook-wiring',
          label: 'Hook wiring',
          status: 'fail',
          detail: `not wired: ${missingWiring.map(w => w.label).join(', ')}`,
          fix: INSTALL_FIX,
        },
  );

  // ── Hooks directory: the configured one, not the default ────────────
  const scriptCommands = commands.filter(entry => entry.command.includes('.sh'));
  let hooksDir = options.hooksDir ?? null;
  if (!hooksDir) {
    for (const entry of scriptCommands) {
      const token = tokenizeCommand(entry.command).find(
        candidate => candidate.endsWith('.sh') && candidate.includes('cortex-'),
      );
      if (token) {
        // Normalised because a settings file may spell the path with forward
        // slashes on Windows, and the directory is reported to the user.
        hooksDir = path.normalize(path.dirname(expandHome(token, homeDir)));
        break;
      }
    }
  }
  const resolvedHooksDir = hooksDir ?? path.join(homeDir, '.claude', 'hooks');

  // ── Hook scripts: presence, substitution, currency ───────────────────
  const missingScripts: string[] = [];
  const unsubstituted: string[] = [];
  const stale: string[] = [];
  const unstamped: string[] = [];
  const missingTemplates: string[] = [];
  const bakedPaths = new Set<string>();

  for (const script of HOOK_SCRIPTS) {
    const installedPath = path.join(resolvedHooksDir, script);
    if (!statIsFile(installedPath)) {
      missingScripts.push(script);
      continue;
    }
    const installed = fs.readFileSync(installedPath, 'utf8');

    if (/__CORTEX_[A-Z_]+__/.test(installed)) {
      unsubstituted.push(script);
    }

    const templatePath = path.join(templateDir, script);
    if (!statIsFile(templatePath)) {
      missingTemplates.push(script);
      continue;
    }
    const templateText = fs.readFileSync(templatePath, 'utf8');

    for (const baked of extractBakedPaths(templateText, installed)) {
      bakedPaths.add(baked);
    }

    const expected = hookTemplateDigest(templateText);
    const actual = readTemplateStamp(installed);
    if (actual === null) unstamped.push(script);
    else if (actual !== expected) stale.push(script);
  }

  add(
    missingScripts.length === 0
      ? {
          id: 'hook-scripts',
          label: 'Hook scripts',
          status: 'pass',
          detail: `${HOOK_SCRIPTS.length} present in ${resolvedHooksDir}`,
        }
      : {
          id: 'hook-scripts',
          label: 'Hook scripts',
          status: 'fail',
          detail: `missing from ${resolvedHooksDir}: ${missingScripts.join(', ')}`,
          fix: INSTALL_FIX,
        },
  );

  add(
    unsubstituted.length === 0
      ? {
          id: 'hook-substitution',
          label: 'Placeholder substitution',
          status: 'pass',
          detail: 'no unsubstituted placeholders',
        }
      : {
          id: 'hook-substitution',
          label: 'Placeholder substitution',
          status: 'fail',
          detail: `__CORTEX_*__ placeholders left in: ${unsubstituted.join(', ')}`,
          fix: INSTALL_FIX,
        },
  );

  if (missingTemplates.length > 0) {
    add({
      id: 'hook-currency',
      label: 'Hook version currency',
      status: 'fail',
      detail: `no template shipped by this build to compare against: ${missingTemplates.join(', ')}`,
      fix: 'Reinstall the cortex-memory package; its `hooks/` directory is missing or incomplete.',
    });
  } else if (stale.length > 0 || unstamped.length > 0) {
    const parts: string[] = [];
    if (stale.length > 0) parts.push(`out of date: ${stale.join(', ')}`);
    if (unstamped.length > 0) {
      parts.push(`no template stamp (predates stamping): ${unstamped.join(', ')}`);
    }
    add({
      id: 'hook-currency',
      label: 'Hook version currency',
      status: 'fail',
      detail: `${parts.join('; ')} — valid and substituted, but older than the template this build ships`,
      fix: INSTALL_FIX,
    });
  } else {
    add({
      id: 'hook-currency',
      label: 'Hook version currency',
      status: 'pass',
      detail: 'installed scripts match the templates shipped by this build',
    });
  }

  // ── Interpreter (N-6) ───────────────────────────────────────────────
  const interpreters = new Map<string, string | null>();
  for (const entry of scriptCommands) {
    const first = tokenizeCommand(entry.command)[0];
    if (first === undefined || first.length === 0) continue;
    if (!interpreters.has(first)) {
      interpreters.set(first, resolveExecutable(first, env, platform, homeDir));
    }
  }
  if (interpreters.size === 0) {
    add({
      id: 'hook-interpreter',
      label: 'Hook interpreter',
      status: 'fail',
      detail: 'no hook script command is configured, so no interpreter could be checked',
      fix: INSTALL_FIX,
    });
  } else {
    const unresolved = [...interpreters.entries()].filter(([, resolved]) => resolved === null);
    add(
      unresolved.length === 0
        ? {
            id: 'hook-interpreter',
            label: 'Hook interpreter',
            status: 'pass',
            detail: [...interpreters.entries()]
              .map(([name, resolved]) => `${name} → ${resolved ?? '?'}`)
              .join(', '),
          }
        : {
            id: 'hook-interpreter',
            label: 'Hook interpreter',
            status: 'fail',
            detail: `configured interpreter not found: ${unresolved.map(([name]) => name).join(', ')}`,
            fix: 'Install the interpreter the hooks are configured with, or rewire the hooks to one on PATH.',
          },
    );
  }

  // ── jq ──────────────────────────────────────────────────────────────
  const jqPath = resolveExecutable('jq', env, platform, homeDir);
  add(
    jqPath
      ? { id: 'jq', label: 'jq availability', status: 'pass', detail: jqPath }
      : {
          id: 'jq',
          label: 'jq availability',
          status: 'fail',
          detail: 'jq is not on PATH; every hook script parses its payload with jq',
          fix: 'Install jq (https://jqlang.github.io/jq/) and make sure it is on the PATH Claude Code runs hooks with.',
        },
  );

  // ── Node resolution: the paths baked into the installed hooks ───────
  const missingBaked = [...bakedPaths].filter(target => !statIsFile(target));
  if (bakedPaths.size === 0) {
    add({
      id: 'node',
      label: 'Node resolution',
      status: missingScripts.length === HOOK_SCRIPTS.length ? 'fail' : 'warn',
      detail: 'no Node or CLI path is baked into the installed hooks',
      fix: INSTALL_FIX,
    });
  } else {
    add(
      missingBaked.length === 0
        ? {
            id: 'node',
            label: 'Node resolution',
            status: 'pass',
            detail: `${bakedPaths.size} baked path(s) resolve`,
          }
        : {
            id: 'node',
            label: 'Node resolution',
            status: 'fail',
            detail: `baked into the hooks but missing on disk: ${missingBaked.join(', ')}`,
            fix: INSTALL_FIX,
          },
    );
  }

  // ── Database ────────────────────────────────────────────────────────
  const dbPath = path.join(projectDir, '.cortex.db');
  if (!fs.existsSync(dbPath)) {
    add({
      id: 'database',
      label: 'Database',
      status: 'fail',
      detail: `${dbPath} does not exist`,
      fix: 'Run `cortex inject-header --quiet` in this project to create the store.',
    });
  } else {
    let version: number | null = null;
    let openError: string | null = null;
    try {
      const db = openDatabaseReadOnly(dbPath);
      try {
        version = getSchemaVersion(db);
      } finally {
        db.close();
      }
    } catch (error) {
      openError = error instanceof Error ? error.message : String(error);
    }

    if (openError !== null) {
      add({
        id: 'database',
        label: 'Database',
        status: 'fail',
        detail: `${dbPath} could not be opened: ${openError}`,
        fix: 'Check file permissions on the store and its -wal/-shm siblings.',
      });
    } else if (version !== SCHEMA_VERSION) {
      add({
        id: 'database',
        label: 'Database',
        status: 'fail',
        detail: `schema_version is ${version}, this build expects ${SCHEMA_VERSION}`,
        fix: 'Run any `cortex` command (for example `cortex status`) to apply pending migrations.',
      });
    } else {
      add({
        id: 'database',
        label: 'Database',
        status: 'pass',
        detail: `reachable, schema_version ${version}`,
      });
    }
  }

  // ── Spool ───────────────────────────────────────────────────────────
  const spoolPath = deriveSpoolPath(projectDir);
  let spoolSize = 0;
  let spoolAgeMs = 0;
  let spoolExists = false;
  try {
    const stat = fs.statSync(spoolPath);
    spoolExists = true;
    spoolSize = stat.size;
    spoolAgeMs = now.getTime() - stat.mtime.getTime();
  } catch {
    spoolExists = false;
  }

  if (!spoolExists || spoolSize === 0) {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'pass',
      detail: spoolExists ? 'empty' : 'no spool file (nothing pending)',
    });
  } else if (spoolSize >= SPOOL_THRESHOLD_BYTES) {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'fail',
      detail: `${spoolSize} bytes — at or past the ${SPOOL_THRESHOLD_BYTES}-byte threshold that should have triggered a flush`,
      fix: 'Run `cortex flush-spool` here, then check that the Stop hook is wired and that Node resolves.',
    });
  } else if (spoolAgeMs > SPOOL_STALE_MS) {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'warn',
      detail: `${spoolSize} bytes, last written ${Math.round(spoolAgeMs / 60000)} minutes ago — the turn-end flush may not be running`,
      fix: 'Run `cortex flush-spool` here, then check the Stop hook wiring.',
    });
  } else {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'pass',
      detail: `${spoolSize} bytes pending, written ${Math.round(spoolAgeMs / 1000)}s ago`,
    });
  }

  // ── MCP registration ────────────────────────────────────────────────
  const mcpSources: Array<{ path: string; registered: boolean }> = [];
  const projectMcp = readJsonFile(path.join(projectDir, '.mcp.json'));
  if (projectMcp) {
    mcpSources.push({ path: projectMcp.path, registered: hasCortexServer(projectMcp.value) });
  }
  for (const file of settingsFiles) {
    if (hasCortexServer(file.value)) {
      mcpSources.push({ path: file.path, registered: true });
    }
  }
  const claudeConfig = readJsonFile(path.join(homeDir, '.claude.json'));
  if (claudeConfig) {
    let registered = hasCortexServer(claudeConfig.value);
    const projects = claudeConfig.value?.['projects'];
    if (!registered && projects !== null && typeof projects === 'object') {
      const entry = (projects as Record<string, unknown>)[projectDir];
      if (entry !== null && typeof entry === 'object') {
        registered = hasCortexServer(entry as Record<string, unknown>);
      }
    }
    mcpSources.push({ path: claudeConfig.path, registered });
  }

  const registeredIn = mcpSources.filter(source => source.registered);
  add(
    registeredIn.length > 0
      ? {
          id: 'mcp',
          label: 'MCP server registration',
          status: 'pass',
          detail: `registered in ${registeredIn.map(source => source.path).join(', ')}`,
        }
      : {
          id: 'mcp',
          label: 'MCP server registration',
          status: 'fail',
          detail: 'no `cortex` entry under mcpServers in .mcp.json, settings.json or ~/.claude.json',
          fix: 'Add {"mcpServers": {"cortex": {"command": "cortex", "args": ["serve"]}}} to .mcp.json or ~/.claude/settings.json.',
        },
  );

  const failures = checks.filter(check => check.status === 'fail').length;
  const warnings = checks.filter(check => check.status === 'warn').length;

  return {
    project: projectDir,
    hooks_dir: resolvedHooksDir,
    checks,
    failures,
    warnings,
    ok: failures === 0,
  };
}
