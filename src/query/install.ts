import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RequiredWiring } from './doctor.js';
import {
  HOOK_SCRIPTS,
  REQUIRED_WIRING,
  TEMPLATE_ID_PLACEHOLDER,
  commandSatisfiesWiring,
  hookTemplateDigest,
  readTemplateStamp,
} from './doctor.js';

/**
 * One-command installation (FR-24).
 *
 * The command `doctor` diagnoses. Everything here is written so that the two
 * agree by construction rather than by coincidence: the wiring `install` writes
 * is `REQUIRED_WIRING`, the same constant `doctor` checks against, and the
 * stamp it substitutes is the digest `doctor` recomputes. An installer and a
 * diagnostic that drift apart produce the worst outcome available — a correct
 * installation that reports itself broken, or a broken one that reports clean.
 *
 * The paranoid part is `~/.claude/settings.json`. It holds the user's other
 * hooks, other MCP servers, permissions and plugin configuration, and losing
 * any of it is worse than not shipping this story. Every write here merges,
 * never replaces; refuses a file that does not parse rather than clobbering it;
 * lands atomically; and backs up before the first modification.
 */

// ── Outcomes ──────────────────────────────────────────────────────────

export type ActionOutcome = 'created' | 'updated' | 'unchanged' | 'refused';

export interface InstallAction {
  id: string;
  target: string;
  outcome: ActionOutcome;
  detail: string;
  /** Required on every `refused` action: the flag or edit that resolves it. */
  fix?: string;
}

export interface InstallResult {
  actions: InstallAction[];
  /** True when nothing on disk needed to change. */
  unchanged: boolean;
  refusals: number;
  dry_run: boolean;
  hooks_dir: string;
  settings_path: string;
}

export interface InstallOptions {
  projectDir: string;
  homeDir?: string;
  hooksDir?: string;
  templateDir?: string;
  /** `user` writes ~/.claude/settings.json; `project` writes <project>/.claude. */
  scope?: 'user' | 'project';
  /** Overwrite a hook script this command can prove the user edited. */
  force?: boolean;
  /** Compute every outcome and write nothing. */
  dryRun?: boolean;
  nodePath?: string;
  cliEntry?: string;
  hookEntry?: string;
}

/** Cortex runtime artifacts, which must never enter git or the app graph. */
export const IGNORE_ENTRIES = [
  '.cortex.db',
  '.cortex.db-wal',
  '.cortex.db-shm',
  '.cortex.spool.jsonl',
  '.cortex.spool.jsonl.processing',
  '.cortex.state',
  '.cortex.agent-used',
] as const;

// ── Hook script rendering and modification detection ──────────────────

export interface BakedPaths {
  nodePath: string;
  cliEntry: string;
  hookEntry: string;
}

/**
 * The single rendering. Used to write a script and, indirectly, to decide
 * whether one on disk is still what we would have written.
 */
export function renderHookScript(templateText: string, paths: BakedPaths): string {
  return templateText
    .replaceAll(TEMPLATE_ID_PLACEHOLDER, hookTemplateDigest(templateText))
    .replaceAll('__CORTEX_NODE__', paths.nodePath)
    .replaceAll('__CORTEX_CLI__', paths.cliEntry)
    .replaceAll('__CORTEX_HOOK_ENTRY__', paths.hookEntry);
}

/**
 * True when the installed text is the template with *some* set of paths
 * substituted — whatever those paths are.
 *
 * Built as one regex over the whole template rather than a re-render, because
 * a re-render needs to know which recovered path belongs to which placeholder,
 * and getting that mapping wrong reads as "user modified" for a file nobody
 * touched. A placeholder appearing more than once becomes a backreference, so
 * a script whose two Node references disagree is correctly seen as edited.
 *
 * Captures are `[^\n]+?`: a substituted path never spans a line, and bounding
 * them to one line keeps the match from swallowing unrelated content and keeps
 * backtracking linear.
 */
export function installedMatchesTemplate(templateText: string, installedText: string): boolean {
  const template = templateText.replace(/\r\n/g, '\n');
  const installed = installedText.replace(/\r\n/g, '\n');

  const groups = new Map<string, number>();
  let groupIndex = 0;

  const pattern = template
    .split(/(__CORTEX_(?:NODE|CLI|HOOK_ENTRY|TEMPLATE_ID)__)/)
    .map(part => {
      if (!/^__CORTEX_[A-Z_]+__$/.test(part)) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const seen = groups.get(part);
      if (seen !== undefined) return `\\${seen}`;
      groupIndex += 1;
      groups.set(part, groupIndex);
      return '([^\\n]+?)';
    })
    .join('');

  return new RegExp(`^${pattern}$`).test(installed);
}

export type ScriptState = 'absent' | 'unmodified' | 'modified' | 'unknown';

/**
 * Whether an installed script is still ours.
 *
 * `unknown` is not a failure state. Every hook installed before Story 2.3 is
 * unstamped, and `doctor` names this command as the fix for exactly those — so
 * refusing on `unknown` would break the documented repair path for the most
 * common installation there is. It is backed up and overwritten instead.
 */
export function classifyInstalledScript(
  templateText: string,
  installedText: string,
): Exclude<ScriptState, 'absent'> {
  const stamp = readTemplateStamp(installedText);
  if (stamp === null || stamp !== hookTemplateDigest(templateText)) return 'unknown';
  return installedMatchesTemplate(templateText, installedText) ? 'unmodified' : 'modified';
}

// ── JSON settings merging ─────────────────────────────────────────────

type Json = Record<string, unknown>;

export interface MergeResult {
  value: Json;
  changed: boolean;
}

/**
 * Add each required wiring that is not already present.
 *
 * Presence is decided by `commandSatisfiesWiring`, not string equality: a user
 * who re-quoted the path or moved the hooks directory already has a working
 * wiring, and appending a second entry would double every hook invocation.
 */
export function mergeHookWiring(settings: Json, hooksDir: string, paths: BakedPaths): MergeResult {
  const existing = settings['hooks'];
  const hooks: Json =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Json) }
      : {};

  let changed = false;
  const posixHooks = hooksDir.replace(/\\/g, '/');

  for (const required of REQUIRED_WIRING) {
    const command = wiringCommand(required, posixHooks, paths);
    if (command === null) continue;

    const current = hooks[required.event];
    const entries = Array.isArray(current) ? [...current] : [];

    const alreadyWired = entries.some(entry => {
      if (entry === null || typeof entry !== 'object') return false;
      const inner = (entry as Json)['hooks'];
      if (!Array.isArray(inner)) return false;
      return inner.some(hook => {
        if (hook === null || typeof hook !== 'object') return false;
        const value = (hook as Json)['command'];
        return typeof value === 'string' && commandSatisfiesWiring(value, required);
      });
    });
    if (alreadyWired) continue;

    entries.push({
      ...(required.matcher === undefined ? {} : { matcher: required.matcher }),
      hooks: [{ type: 'command', command }],
    });
    hooks[required.event] = entries;
    changed = true;
  }

  return changed ? { value: { ...settings, hooks }, changed } : { value: settings, changed: false };
}

/**
 * The command text for a wiring.
 *
 * `SessionStart` has no script — it invokes the CLI directly, so it is built
 * from the resolved Node and CLI paths and quoted, because both routinely
 * contain spaces on Windows (`C:\Program Files\nodejs\node.exe`).
 */
function wiringCommand(
  required: RequiredWiring,
  posixHooksDir: string,
  paths: BakedPaths,
): string | null {
  if (required.script !== undefined) {
    const action = required.action === undefined ? '' : ` ${required.action}`;
    return `bash "${posixHooksDir}/${required.script}"${action}`;
  }
  if (required.token === 'inject-header') {
    if (paths.cliEntry.length === 0) return null;
    return `"${paths.nodePath}" "${paths.cliEntry}" inject-header --quiet`;
  }
  return null;
}

export function mergeMcpServer(settings: Json, entry: Json): MergeResult {
  const existing = settings['mcpServers'];
  const servers: Json =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Json) }
      : {};

  // Any existing `cortex` entry is left alone: it may point at a checkout the
  // user prefers, and replacing it is not this command's call.
  if (Object.prototype.hasOwnProperty.call(servers, 'cortex')) {
    return { value: settings, changed: false };
  }

  servers['cortex'] = entry;
  return { value: { ...settings, mcpServers: servers }, changed: true };
}

/** Append missing ignore entries, matched line-exact after trimming. */
export function mergeIgnoreEntries(
  current: string,
  entries: readonly string[],
): { text: string; added: string[] } {
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = entries.filter(entry => !present.has(entry));
  if (missing.length === 0) return { text: current, added: [] };

  const needsNewline = current.length > 0 && !current.endsWith('\n');
  const header = current.length === 0 ? '' : `${needsNewline ? '\n' : ''}`;
  return {
    text: `${current}${header}\n# Cortex runtime artifacts\n${missing.join('\n')}\n`,
    added: missing,
  };
}

// ── Atomic write ──────────────────────────────────────────────────────

/**
 * Write via a sibling temp file and rename. A half-written `settings.json` is
 * a Claude Code that will not start, and the window for that is exactly as
 * long as a naive `writeFileSync` takes.
 */
export function writeFileAtomic(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.cortex-tmp`);
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, target);
}

function readJson(target: string): { value: Json | null; error: string | null; existed: boolean } {
  if (!fs.existsSync(target)) return { value: {}, error: null, existed: false };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: 'not a JSON object', existed: true };
    }
    return { value: parsed as Json, error: null, existed: true };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : String(error),
      existed: true,
    };
  }
}

/**
 * `fileURLToPath`, never `new URL(...).pathname` — the latter leaves the path
 * percent-encoded, so a checkout under `C:\Claude Code\` resolves to a
 * directory containing `%20` and every template reads as missing. Same
 * resolution `doctor` uses, so the two always see one set of templates.
 */
function defaultTemplateDir(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', 'hooks', 'claude');
}

// ── The command ───────────────────────────────────────────────────────

export function runInstall(options: InstallOptions): InstallResult {
  const projectDir = options.projectDir;
  const homeDir = options.homeDir ?? os.homedir();
  const scope = options.scope ?? 'user';
  const dryRun = options.dryRun ?? false;
  const templateDir = options.templateDir ?? defaultTemplateDir(import.meta.url);
  const hooksDir = options.hooksDir ?? path.join(homeDir, '.claude', 'hooks');
  const nodePath = options.nodePath ?? process.execPath;
  const cliEntry = options.cliEntry ?? '';
  const hookEntry = options.hookEntry ?? '';
  const paths: BakedPaths = { nodePath, cliEntry, hookEntry };

  const settingsPath =
    scope === 'project'
      ? path.join(projectDir, '.claude', 'settings.json')
      : path.join(homeDir, '.claude', 'settings.json');
  const mcpPath = scope === 'project' ? path.join(projectDir, '.mcp.json') : settingsPath;

  const actions: InstallAction[] = [];
  const add = (action: InstallAction): void => {
    actions.push(action);
  };

  // ── Hook scripts ────────────────────────────────────────────────────
  for (const script of HOOK_SCRIPTS) {
    const templatePath = path.join(templateDir, script);
    const target = path.join(hooksDir, script);

    if (!fs.existsSync(templatePath)) {
      add({
        id: `hook:${script}`,
        target,
        outcome: 'refused',
        detail: `this build ships no template for ${script}`,
        fix: 'Reinstall the cortex-memory package; its `hooks/` directory is incomplete.',
      });
      continue;
    }

    const templateText = fs.readFileSync(templatePath, 'utf8');
    const rendered = renderHookScript(templateText, paths);
    const exists = fs.existsSync(target);
    const installedText = exists ? fs.readFileSync(target, 'utf8') : null;
    const state: ScriptState =
      installedText === null ? 'absent' : classifyInstalledScript(templateText, installedText);

    if (state === 'unmodified' && installedText === rendered) {
      add({ id: `hook:${script}`, target, outcome: 'unchanged', detail: 'already current' });
      continue;
    }

    if (state === 'modified' && !options.force) {
      add({
        id: `hook:${script}`,
        target,
        outcome: 'refused',
        detail: 'the installed script was edited after Cortex wrote it',
        fix: `Re-run with --force to overwrite it, or move \`${target}\` aside first.`,
      });
      continue;
    }

    // `unknown` keeps a copy. It is the pre-Story-2.3 install, which `doctor`
    // tells users to fix by running this command — refusing there would break
    // the documented repair path, and overwriting without a backup would lose
    // any customisation it happens to carry.
    const backup = state === 'unknown' || (state === 'modified' && options.force === true);
    if (!dryRun) {
      if (backup && installedText !== null) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(`${target}.bak`, installedText);
      }
      writeFileAtomic(target, rendered);
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        // chmod is a no-op on Windows.
      }
    }

    add({
      id: `hook:${script}`,
      target,
      outcome: exists ? 'updated' : 'created',
      detail: backup
        ? `${state === 'unknown' ? 'not written by this build' : 'edited, overwritten with --force'}; previous copy saved to ${path.basename(target)}.bak`
        : state === 'absent'
          ? 'installed'
          : 'refreshed',
    });
  }

  // ── Settings: hook wiring ───────────────────────────────────────────
  const settings = readJson(settingsPath);
  if (settings.value === null) {
    add({
      id: 'settings',
      target: settingsPath,
      outcome: 'refused',
      detail: `${settingsPath} does not parse: ${settings.error ?? 'unknown error'}`,
      fix: 'Fix the JSON syntax in that file, then re-run. Cortex will not overwrite a settings file it cannot read.',
    });
  } else {
    const merged = mergeHookWiring(settings.value, hooksDir, paths);
    // MCP goes into the same document when the scope shares a file, so both
    // merges are applied before a single write.
    const sameFile = path.resolve(mcpPath) === path.resolve(settingsPath);
    const mcpEntry: Json = { command: nodePath, args: [cliEntry, 'serve'] };
    const withMcp = sameFile ? mergeMcpServer(merged.value, mcpEntry) : { value: merged.value, changed: false };

    if (merged.changed || withMcp.changed) {
      if (!dryRun) {
        if (settings.existed) {
          fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
        }
        writeFileAtomic(settingsPath, `${JSON.stringify(withMcp.value, null, 2)}\n`);
      }
      add({
        id: 'settings',
        target: settingsPath,
        outcome: settings.existed ? 'updated' : 'created',
        detail: merged.changed
          ? `wired ${REQUIRED_WIRING.length} events${withMcp.changed ? ' and registered the MCP server' : ''}`
          : 'registered the MCP server',
      });
    } else {
      add({
        id: 'settings',
        target: settingsPath,
        outcome: 'unchanged',
        detail: 'hooks and MCP registration already present',
      });
    }

    if (!sameFile) {
      const mcpFile = readJson(mcpPath);
      if (mcpFile.value === null) {
        add({
          id: 'mcp',
          target: mcpPath,
          outcome: 'refused',
          detail: `${mcpPath} does not parse: ${mcpFile.error ?? 'unknown error'}`,
          fix: 'Fix the JSON syntax in that file, then re-run.',
        });
      } else {
        const registered = mergeMcpServer(mcpFile.value, {
          command: nodePath,
          args: [cliEntry, 'serve'],
        });
        if (registered.changed) {
          if (!dryRun) {
            if (mcpFile.existed) fs.copyFileSync(mcpPath, `${mcpPath}.bak`);
            writeFileAtomic(mcpPath, `${JSON.stringify(registered.value, null, 2)}\n`);
          }
          add({
            id: 'mcp',
            target: mcpPath,
            outcome: mcpFile.existed ? 'updated' : 'created',
            detail: 'registered the cortex MCP server',
          });
        } else {
          add({
            id: 'mcp',
            target: mcpPath,
            outcome: 'unchanged',
            detail: 'cortex MCP server already registered',
          });
        }
      }
    }
  }

  // ── Ignore entries ──────────────────────────────────────────────────
  const ignorePath = path.join(projectDir, '.gitignore');
  // Captured *before* the write: reading it afterwards reports `updated` for a
  // file this run created, and makes a dry run disagree with the real one.
  const ignoreExisted = fs.existsSync(ignorePath);
  const existingIgnore = ignoreExisted ? fs.readFileSync(ignorePath, 'utf8') : '';
  const ignore = mergeIgnoreEntries(existingIgnore, IGNORE_ENTRIES);
  if (ignore.added.length > 0) {
    if (!dryRun) writeFileAtomic(ignorePath, ignore.text);
    add({
      id: 'ignore',
      target: ignorePath,
      outcome: ignoreExisted ? 'updated' : 'created',
      detail: `added ${ignore.added.length} entr${ignore.added.length === 1 ? 'y' : 'ies'}: ${ignore.added.join(', ')}`,
    });
  } else {
    add({
      id: 'ignore',
      target: ignorePath,
      outcome: 'unchanged',
      detail: `all ${IGNORE_ENTRIES.length} runtime artifacts already ignored`,
    });
  }

  const refusals = actions.filter(action => action.outcome === 'refused').length;
  return {
    actions,
    unchanged: actions.every(action => action.outcome === 'unchanged'),
    refusals,
    dry_run: dryRun,
    hooks_dir: hooksDir,
    settings_path: settingsPath,
  };
}
