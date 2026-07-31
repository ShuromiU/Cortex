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
 *  - **Nothing here changes what it observes.** No session, no engagement
 *    write, no `ensureCortexSchema`, no spool flush, no store created where
 *    none exists. A diagnostic that repairs the thing it is checking cannot
 *    report on it: opening the store the normal way would migrate
 *    `schema_version` to the value the check compares against, so the mismatch
 *    could never be seen. Same rule `list-memory` and `inspect-memory` follow,
 *    binding harder.
 *
 *    One honest exception, which the docs state rather than hide: reading a
 *    **WAL-mode** database creates its `-shm` and `-wal` sidecars if they are
 *    absent. That is SQLite's requirement for reading WAL at all, not a choice
 *    this module makes — `readonly: true` prevents content writes, not sidecar
 *    creation — and the alternative (opening `immutable=1`) would read past the
 *    WAL and could report a stale `schema_version`, which is a wrong answer
 *    rather than a tidier one.
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
  /** Always set: falls back to the default location when nothing is wired. */
  hooks_dir: string;
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
export interface RequiredWiring {
  event: string;
  label: string;
  script?: string;
  /** A token that must also be present, e.g. the reflect action. */
  action?: string;
  /** A token that must be present when `script` is not the discriminator. */
  token?: string;
  /** When the action may be omitted because the script defaults to it. */
  actionOptionalUnless?: string;
  /**
   * The tool matcher this event needs. Carried here rather than in the
   * installer so that what `install` writes and what `doctor` checks are the
   * same declaration.
   */
  matcher?: string;
}

/**
 * Exported so `install` writes exactly what `doctor` checks for. One source of
 * truth: an installer and a diagnostic that disagree about what "wired" means
 * is the shape where a correct installation reports itself broken.
 */
export const REQUIRED_WIRING: readonly RequiredWiring[] = [
  { event: 'SessionStart', label: 'SessionStart (session brief)', token: 'inject-header' },
  {
    event: 'PostToolUse',
    label: 'PostToolUse (capture)',
    script: 'cortex-capture.sh',
    matcher: 'Read|Edit|Write|Bash|Agent',
  },
  {
    event: 'PreToolUse',
    label: 'PreToolUse (reflex)',
    script: 'cortex-reflect.sh',
    action: 'reflect-pre',
    matcher: 'Edit|Write',
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

const INSTALL_FIX = 'Run `cortex install`.';

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
 * Expand the two substitutions a hook command's path can carry that Node does
 * not resolve on its own.
 *
 * `~` is expanded by the shell — the live wiring on this machine is
 * `bash ~/.claude/hooks/cortex-capture.sh`, so skipping it reports every
 * configured script as missing. `$CLAUDE_PROJECT_DIR` is expanded by Claude
 * Code itself and is its documented form for a project-relative hook path;
 * `install-hooks` never emits it, but this module diagnoses the configuration
 * that exists rather than the one the installer would have written, and left
 * unexpanded it produces three false failures plus a nonsense path printed
 * back at a user whose installation is fine.
 */
export function expandHookPath(target: string, homeDir: string, projectDir: string): string {
  let expanded = target;

  if (expanded === '~') return homeDir;
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(homeDir, expanded.slice(2));
  }

  // Both spellings; `${VAR}` is what a cautious author writes next to a path.
  expanded = expanded
    .replaceAll('${CLAUDE_PROJECT_DIR}', projectDir)
    .replaceAll('$CLAUDE_PROJECT_DIR', projectDir);

  return expanded;
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
  projectDir = '',
): string | null {
  if (name.length === 0) return null;

  const expanded = expandHookPath(name, homeDir, projectDir);
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
  // An empty `PATHEXT` must fall back, not disable extension probing: `??`
  // alone keeps the empty string, and every `.exe` on the machine then
  // resolves to null. Windows itself treats an empty PATHEXT as unset.
  const pathext = env['PATHEXT'];
  const extensions =
    platform === 'win32'
      ? (pathext !== undefined && pathext.length > 0 ? pathext : '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(ext => ext.length > 0)
      : [];

  for (const rawDir of raw.split(separator)) {
    // cmd.exe accepts and strips quotes around a PATH entry, so a quoted entry
    // is a real configuration that must not report every binary in it missing.
    const dir = rawDir.replace(/^"+|"+$/g, '');
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
): Array<{ event: string; command: string; matcher: string | null }> {
  const found: Array<{ event: string; command: string; matcher: string | null }> = [];
  const hooks = settings['hooks'];
  if (hooks === null || typeof hooks !== 'object') return found;

  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (matcher === null || typeof matcher !== 'object') continue;
      const entries = (matcher as Record<string, unknown>)['hooks'];
      if (!Array.isArray(entries)) continue;
      const matcherValue = (matcher as Record<string, unknown>)['matcher'];
      const matcherText = typeof matcherValue === 'string' ? matcherValue : null;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const command = (entry as Record<string, unknown>)['command'];
        if (typeof command === 'string' && command.length > 0) {
          found.push({ event, command, matcher: matcherText });
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
      detail: `${statePath} does not exist — nothing has engaged Cortex in this project (SessionStart, \`cortex_engage\` or \`inject-header\` all write it)`,
      fix: 'Run `cortex inject-header --quiet` here, then check the SessionStart wiring.',
    });
  } else {
    // Guarded: `.cortex.state` is a path a user (or a stray `mkdir`) controls,
    // and an unguarded read of a directory throws EISDIR out of runDoctor,
    // losing the entire report to one malformed path.
    let stateText: string | null = null;
    let stateError: string | null = null;
    try {
      stateText = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      stateError = error instanceof Error ? error.message : String(error);
    }

    if (stateText === null) {
      add({
        id: 'engagement',
        label: 'Engagement state',
        status: 'fail',
        detail: `${statePath} could not be read: ${stateError ?? 'unknown error'}`,
        fix: 'Remove whatever sits at that path, then run `cortex inject-header --quiet` here.',
      });
    } else {
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

  // ── Capture matcher ─────────────────────────────────────────────────
  //
  // The tools PostToolUse fires on. A matcher that has lost `Agent` is the
  // pre-Story-0.2 value, and it breaks subagent capture exactly as a stale
  // script does — silently, with every subagent tool call filed under the
  // primary session. Without this check, a user who hits the currency failure,
  // re-copies the scripts but never re-merges the printed JSON gets a green
  // currency row and dead subagent capture: the fix `doctor` prints would turn
  // a detectable failure into an undetectable one.
  const captureMatchers = commands
    .filter(entry => entry.event === 'PostToolUse' && entry.command.includes('cortex-capture.sh'))
    .map(entry => entry.matcher);
  const CAPTURE_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Agent'] as const;
  if (captureMatchers.length > 0) {
    // An empty or absent matcher matches every tool, which is broader than the
    // canonical wiring and therefore fine.
    const covers = (matcher: string | null, tool: string): boolean =>
      matcher === null || matcher.trim().length === 0 || matcher.includes(tool);
    const uncovered = CAPTURE_TOOLS.filter(
      tool => !captureMatchers.some(matcher => covers(matcher, tool)),
    );
    add(
      uncovered.length === 0
        ? {
            id: 'capture-matcher',
            label: 'Capture matcher',
            status: 'pass',
            detail: `PostToolUse fires on all ${CAPTURE_TOOLS.length} captured tools`,
          }
        : {
            // `warn`, not `fail`: narrowing the matcher is a supported choice,
            // and a deliberate one must not break CI. The detail names what is
            // lost so the far more common accidental case is actionable.
            status: 'warn',
            id: 'capture-matcher',
            label: 'Capture matcher',
            detail: `PostToolUse matcher does not cover ${uncovered.join(', ')} — those tool calls are never captured${uncovered.includes('Agent') ? ', so subagent activity is filed under the primary session' : ''}`,
            fix: `Set the PostToolUse matcher to \`${CAPTURE_TOOLS.join('|')}\`, or run \`cortex install\`, which writes it.`,
          },
    );
  }

  // ── Hooks directory: the configured one, not the default ────────────
  const scriptCommands = commands.filter(entry => entry.command.includes('.sh'));

  /** The `.sh` path token inside a settings command, expanded and absolute. */
  const wiredScriptPath = (command: string): string | null => {
    const token = tokenizeCommand(command).find(
      candidate => candidate.endsWith('.sh') && candidate.includes('cortex-'),
    );
    if (token === undefined) return null;
    const expanded = expandHookPath(token, homeDir, projectDir);
    // A token with no directory component (`bash cortex-capture.sh`) is
    // relative to wherever the host runs the hook; resolving it against the
    // project is the only defensible reading, and beats reporting `.` as the
    // hooks directory and probing scripts against process.cwd().
    return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(projectDir, expanded));
  };

  const wiredScripts = new Map<string, string>();
  for (const entry of scriptCommands) {
    const resolved = wiredScriptPath(entry.command);
    if (resolved !== null) wiredScripts.set(resolved, entry.event);
  }

  const resolvedHooksDir = options.hooksDir
    ? path.normalize(expandHookPath(options.hooksDir, homeDir, projectDir))
    : ([...wiredScripts.keys()][0] !== undefined
        ? path.dirname([...wiredScripts.keys()][0]!)
        : path.join(homeDir, '.claude', 'hooks'));

  // ── Hook scripts: presence, substitution, currency ───────────────────
  //
  // Presence is checked at **every wired path**, not only inside the resolved
  // hooks directory. Wiring matches a command by the script's basename, so a
  // hook pointing at a directory that does not exist satisfied the wiring
  // check while presence was checked somewhere else entirely — the two never
  // met on the same path, and a hook wired to nowhere reported fully healthy.
  const missingScripts: string[] = [];
  const unsubstituted: string[] = [];
  const stale: string[] = [];
  const unstamped: string[] = [];
  const missingTemplates: string[] = [];
  const unstampableTemplates: string[] = [];
  /** Installed scripts that no longer contain the template's Node invocation. */
  const gutted: string[] = [];
  const bakedPaths = new Set<string>();
  /** Scripts actually opened. Currency and substitution may only speak about these. */
  const inspected: string[] = [];

  const candidatePaths = new Map<string, string>();
  for (const script of HOOK_SCRIPTS) {
    candidatePaths.set(path.normalize(path.join(resolvedHooksDir, script)), script);
  }
  for (const [wiredPath] of wiredScripts) {
    const base = path.basename(wiredPath);
    if ((HOOK_SCRIPTS as readonly string[]).includes(base)) {
      candidatePaths.set(wiredPath, base);
    }
  }

  for (const [installedPath, script] of candidatePaths) {
    if (!statIsFile(installedPath)) {
      missingScripts.push(wiredScripts.has(installedPath) ? installedPath : script);
      continue;
    }
    const installed = fs.readFileSync(installedPath, 'utf8');
    inspected.push(script);

    if (/__CORTEX_[A-Z_]+__/.test(installed)) {
      unsubstituted.push(script);
    }

    const templatePath = path.join(templateDir, script);
    if (!statIsFile(templatePath)) {
      missingTemplates.push(script);
      continue;
    }
    const templateText = fs.readFileSync(templatePath, 'utf8');

    const recovered = extractBakedPaths(templateText, installed);
    for (const baked of recovered) {
      bakedPaths.add(baked);
    }
    // Every shipped template invokes Node on some line. An installed script
    // that yields none has lost that line — it was truncated, hand-edited or
    // replaced with a stub, and it can no longer reach Cortex at all. The
    // stamp is the only other thing read from an installed file, so without
    // this a script gutted to `exit 0` passes every check that inspects it.
    if (recovered.length === 0 && templateText.includes('__CORTEX_NODE__')) {
      gutted.push(script);
    }

    // A template that never carried the placeholder can never be stamped, so
    // reporting the install stale would be a permanent failure whose named fix
    // is a no-op. That is a packaging fault, and it says so.
    if (!templateText.includes(TEMPLATE_ID_PLACEHOLDER)) {
      unstampableTemplates.push(script);
      continue;
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
          detail: `${inspected.length} present (${resolvedHooksDir})`,
        }
      : {
          id: 'hook-scripts',
          label: 'Hook scripts',
          status: 'fail',
          detail: `missing: ${missingScripts.join(', ')}`,
          fix: INSTALL_FIX,
        },
  );

  // Substitution and currency may only report on scripts that were actually
  // opened. Falling through to a pass branch when nothing was read printed
  // "no unsubstituted placeholders" and "installed scripts match the templates
  // shipped by this build" about files that do not exist — two of the nine
  // things AC #1 names, reported as verified when nothing was verified.
  const nothingInspected = inspected.length === 0;

  add(
    nothingInspected
      ? {
          id: 'hook-substitution',
          label: 'Placeholder substitution',
          status: 'fail',
          detail: 'not checked — no installed hook script could be opened',
          fix: INSTALL_FIX,
        }
      : unsubstituted.length === 0
        ? {
            id: 'hook-substitution',
            label: 'Placeholder substitution',
            status: 'pass',
            detail: `no unsubstituted placeholders in ${inspected.length} script(s)`,
          }
        : {
            id: 'hook-substitution',
            label: 'Placeholder substitution',
            status: 'fail',
            detail: `__CORTEX_*__ placeholders left in: ${unsubstituted.join(', ')}`,
            fix: INSTALL_FIX,
          },
  );

  if (nothingInspected) {
    add({
      id: 'hook-currency',
      label: 'Hook version currency',
      status: 'fail',
      detail: 'not checked — no installed hook script could be opened',
      fix: INSTALL_FIX,
    });
  } else if (unstampableTemplates.length > 0) {
    add({
      id: 'hook-currency',
      label: 'Hook version currency',
      status: 'fail',
      detail: `template ships without a ${TEMPLATE_ID_PLACEHOLDER} line, so currency cannot be established: ${unstampableTemplates.join(', ')}`,
      fix: 'Reinstall the cortex-memory package; its shipped hook templates are malformed. Re-running install-hooks cannot fix this.',
    });
  } else if (missingTemplates.length > 0) {
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
  //
  // Every cortex-related command, not only the `.sh` ones. The SessionStart
  // wiring names its own Node binary and CLI entry point, and those can differ
  // from the pair baked into the hook scripts — an upgraded Node with the
  // scripts reinstalled, or a hand-edited settings file. Excluding it left the
  // one case the README advertises ("a Node that moved") undetected.
  const cortexCommands = commands.filter(
    entry => entry.command.includes('.sh') || entry.command.includes('inject-header'),
  );
  const interpreters = new Map<string, string | null>();
  for (const entry of cortexCommands) {
    const first = tokenizeCommand(entry.command)[0];
    if (first === undefined || first.length === 0) continue;
    if (!interpreters.has(first)) {
      interpreters.set(first, resolveExecutable(first, env, platform, homeDir, projectDir));
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
  const jqPath = resolveExecutable('jq', env, platform, homeDir, projectDir);
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

  // ── Node resolution: the paths the wiring will actually invoke ──────
  //
  // Both sources: the pair substituted into each hook script, and the Node and
  // CLI paths the SessionStart command names directly.
  for (const entry of cortexCommands) {
    if (entry.command.includes('.sh')) continue;
    for (const token of tokenizeCommand(entry.command)) {
      if (!token.includes('/') && !token.includes('\\')) continue;
      if (!/node|\.js$|\.cjs$|\.mjs$/i.test(token)) continue;
      bakedPaths.add(expandHookPath(token, homeDir, projectDir));
    }
  }

  const missingBaked = [...bakedPaths].filter(target => !statIsFile(target));
  if (gutted.length > 0) {
    add({
      id: 'node',
      label: 'Node resolution',
      status: 'fail',
      detail: `installed but no longer invoke cortex — the template's Node call is gone: ${gutted.join(', ')}`,
      fix: INSTALL_FIX,
    });
  } else if (bakedPaths.size === 0) {
    add({
      id: 'node',
      label: 'Node resolution',
      // No path at all is strictly worse than a path that is missing: it means
      // nothing in the wiring will ever invoke Cortex. Grading it `warn`
      // (unless every script was missing) let three hooks gutted to `exit 0`
      // produce a fully green report and exit 0.
      status: 'fail',
      detail: 'no Node or CLI path is named by the hook scripts or the SessionStart wiring',
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
      // A corrupt file and an unreadable one need different answers; naming
      // permissions for a file SQLite rejected as "not a database" sends the
      // user after the wrong thing entirely.
      const corrupt = /not a database|malformed|file is encrypted/i.test(openError);
      add({
        id: 'database',
        label: 'Database',
        status: 'fail',
        detail: `${dbPath} could not be opened: ${openError}`,
        fix: corrupt
          ? `\`${dbPath}\` is not a readable SQLite database. Move it aside and run \`cortex inject-header --quiet\` to start a new store; the old memory cannot be recovered by this command.`
          : `Check read permissions on \`${dbPath}\` and its -wal/-shm siblings.`,
      });
    } else if (version !== SCHEMA_VERSION) {
      // Direction matters. Migrations are additive-only, so for a store from a
      // newer build "run any cortex command" is not a fix — that path rewrites
      // schema_version *down* to this build's value, destroying the evidence
      // the check just reported.
      const newerStore = version !== null && version > SCHEMA_VERSION;
      add({
        id: 'database',
        label: 'Database',
        status: 'fail',
        detail: `schema_version is ${version}, this build expects ${SCHEMA_VERSION}`,
        fix: newerStore
          ? 'This store was written by a newer cortex. Upgrade the package (`npm install -g cortex-memory`) rather than running a command against it — migrations are additive only and cannot downgrade a store.'
          : 'Run any `cortex` command (for example `cortex status`) to apply pending migrations.',
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
  //
  // The path the capture hook actually writes, which is `$CWD/.cortex.spool.jsonl`
  // hard-coded in `cortex-capture.sh`. Deliberately NOT `deriveSpoolPath`,
  // which honours `CORTEX_SPOOL_DIR`: with that variable set, the Node side
  // reads one path while the hook writes another, and the check reported
  // "nothing pending" over a backlog that no flush would ever collect.
  const spoolPath = path.join(projectDir, '.cortex.spool.jsonl');
  const spoolOverride = deriveSpoolPath(projectDir);
  let spoolSize = 0;
  let spoolAgeMs = 0;
  let spoolExists = false;
  let spoolNotAFile = false;
  try {
    const stat = fs.statSync(spoolPath);
    spoolExists = true;
    spoolNotAFile = !stat.isFile();
    spoolSize = stat.size;
    // Clamped: a restored backup, a network filesystem or plain clock skew can
    // put the mtime ahead of now, and a negative age makes the stale branch
    // unreachable while printing "written -10800s ago".
    spoolAgeMs = Math.max(0, now.getTime() - stat.mtime.getTime());
  } catch {
    spoolExists = false;
  }

  if (spoolNotAFile) {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'fail',
      detail: `${spoolPath} exists but is not a file, so the capture hook cannot append to it`,
      fix: `Remove whatever sits at \`${spoolPath}\`.`,
    });
  } else if (spoolOverride !== spoolPath) {
    add({
      id: 'spool',
      label: 'Capture spool',
      status: 'warn',
      detail: `CORTEX_SPOOL_DIR redirects the Node side to ${spoolOverride}, but cortex-capture.sh always appends to ${spoolPath} — the two halves disagree`,
      fix: 'Unset CORTEX_SPOOL_DIR, or run `cortex flush-spool` with it unset to collect what the hook wrote.',
    });
  } else if (!spoolExists || spoolSize === 0) {
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
  /**
   * Registration files that exist but do not parse. A swallowed parse error
   * here produced the worst possible answer: "no `cortex` entry", telling a
   * user to add a registration that is already sitting in the broken file.
   */
  const mcpMalformed: string[] = [];

  const projectMcp = readJsonFile(path.join(projectDir, '.mcp.json'));
  if (projectMcp) {
    if (projectMcp.error !== null) mcpMalformed.push(`${projectMcp.path}: ${projectMcp.error}`);
    mcpSources.push({ path: projectMcp.path, registered: hasCortexServer(projectMcp.value) });
  }
  for (const file of settingsFiles) {
    if (hasCortexServer(file.value)) {
      mcpSources.push({ path: file.path, registered: true });
    }
  }
  const claudeConfig = readJsonFile(path.join(homeDir, '.claude.json'));
  if (claudeConfig) {
    if (claudeConfig.error !== null) {
      mcpMalformed.push(`${claudeConfig.path}: ${claudeConfig.error}`);
    }
    let registered = hasCortexServer(claudeConfig.value);
    const projects = claudeConfig.value?.['projects'];
    if (!registered && projects !== null && typeof projects === 'object') {
      // Matched on a normalised key: the same project is recorded with either
      // separator and, on Windows, either case, so an exact string lookup
      // makes a real per-project registration invisible.
      const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const wanted = normalize(projectDir);
      const match = Object.keys(projects as Record<string, unknown>).find(
        key => normalize(key) === wanted,
      );
      const entry = match === undefined ? undefined : (projects as Record<string, unknown>)[match];
      if (entry !== null && typeof entry === 'object') {
        registered = hasCortexServer(entry as Record<string, unknown>);
      }
    }
    mcpSources.push({ path: claudeConfig.path, registered });
  }

  const registeredIn = mcpSources.filter(source => source.registered);
  if (registeredIn.length > 0) {
    add({
      id: 'mcp',
      label: 'MCP server registration',
      status: 'pass',
      detail: `registered in ${registeredIn.map(source => source.path).join(', ')}`,
    });
  } else if (mcpMalformed.length > 0) {
    add({
      id: 'mcp',
      label: 'MCP server registration',
      status: 'fail',
      detail: `no readable \`cortex\` entry, and a registration file does not parse — ${mcpMalformed.join('; ')}`,
      fix: 'Fix the JSON syntax in the named file; Claude Code ignores a file it cannot parse, so any registration inside it is not in effect.',
    });
  } else {
    add({
      id: 'mcp',
      label: 'MCP server registration',
      status: 'fail',
      detail: 'no `cortex` entry under mcpServers in .mcp.json, settings.json or ~/.claude.json',
      fix: 'Add {"mcpServers": {"cortex": {"command": "cortex", "args": ["serve"]}}} to .mcp.json or ~/.claude/settings.json.',
    });
  }

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
