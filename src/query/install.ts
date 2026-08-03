import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RequiredWiring } from './doctor.js';
import {
  HOOK_SCRIPTS,
  REQUIRED_WIRING,
  TEMPLATE_ID_PLACEHOLDER,
  collectHookCommands,
  commandSatisfiesWiring,
  hookTemplateDigest,
  readTemplateStamp,
} from './doctor.js';

/**
 * One-command installation (FR-26).
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
  // The flat digest index (AD-3). In the project root for the same reason the
  // spool is: the hot path resolves it in pure bash from $CWD and cannot hash a
  // store path per tool call. Derived and regenerable, so it is ignored rather
  // than committed.
  '.cortex.index',
  // Its atomic-write temp file, for the same reason `.cortex.spool.jsonl.processing`
  // is listed beside the spool: a failed rename whose cleanup also fails would
  // otherwise leave an untracked file in the user's checkout.
  '.cortex.index.tmp-*',
  // Verified read substitution (Story 4.5). Both are project-root files for the
  // same architectural reason every other entry here is: the hot path resolves
  // them as `"$CWD/.cortex.*"` in pure bash and cannot hash a store path per
  // tool call (N-4). The flag is a user preference; the turn marker is cleared
  // at every Stop. Literals rather than imports, matching `.cortex.index`
  // above — a test pins them against the exported constants so they cannot
  // drift apart.
  '.cortex.substitution',
  '.cortex.turn-reads',
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
  // Line endings normalised to LF, not preserved from the template. There is
  // no `.gitattributes`, so on a Windows checkout the templates are CRLF on
  // disk — and a CRLF script was written and then reported fully current,
  // because every validator (`hookTemplateDigest`, `installedMatchesTemplate`,
  // `extractBakedPaths`) normalises first and so cannot see it. Git Bash
  // tolerates CRLF; bash on Linux, macOS and WSL does not, and `package.json`
  // ships `hooks/`, so `npm pack` from a Windows checkout published it.
  return templateText
    .replace(/\r\n/g, '\n')
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

  // One pattern, used both to split and to recognise a fragment as a
  // placeholder. Two regexes that must agree is how a fragment matching some
  // *other* `__CORTEX_X__` token became an unconstrained wildcard.
  const pattern = template
    .split(PLACEHOLDER_SPLIT)
    .map(part => {
      if (!PLACEHOLDER_EXACT.test(part)) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const seen = groups.get(part);
      if (seen !== undefined) return `\\${seen}`;
      groupIndex += 1;
      groups.set(part, groupIndex);
      // Excludes `"` deliberately, not only `\n`. Every path placeholder sits
      // inside a double-quoted string in the shipped templates, so a legitimate
      // substitution can never contain one — while an unconstrained capture
      // accepts any edit that leaves the surrounding literal text intact.
      // Closing the quote, adding a command and reopening it read as
      // `unmodified`, so the script was overwritten with no refusal and no
      // backup: the exact case AC #3 exists to prevent. Exposure was uneven
      // and therefore hard to reason about — `cortex-reflect.sh` happens to be
      // safe because it uses `__CORTEX_NODE__` twice and the backreference
      // forces the two to agree.
      return '([^\\n"]+?)';
    })
    .join('');

  return new RegExp(`^${pattern}$`).test(installed);
}

const PLACEHOLDER_SPLIT = /(__CORTEX_(?:NODE|CLI|HOOK_ENTRY|TEMPLATE_ID)__)/;
const PLACEHOLDER_EXACT = /^__CORTEX_(?:NODE|CLI|HOOK_ENTRY|TEMPLATE_ID)__$/;

/**
 * Characters a shell expands inside a double-quoted string.
 *
 * A wiring command embeds the hooks directory into `bash "<dir>/<script>"`.
 * Double quotes do not protect `$`, a backtick or a backslash, so a path
 * containing one produces a command that silently resolves somewhere else —
 * and `doctor` reports it healthy, because it reads the literal string and
 * finds the file at the literal path. `$(...)` would be executed on every
 * hook fire. Rather than guess which shell the host uses (`bash` on POSIX,
 * possibly `cmd.exe` on Windows) and escape for it, this refuses and says so.
 */
const SHELL_UNSAFE = /[$`\\]/;

export function hooksDirIsShellSafe(hooksDir: string): boolean {
  // Backslashes are normalised to `/` before interpolation, so only the
  // remaining expanders matter.
  return !SHELL_UNSAFE.test(hooksDir.replace(/\\/g, '/'));
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
export function mergeHookWiring(
  settings: Json,
  hooksDir: string,
  paths: BakedPaths,
  /**
   * Wirings already present in the *other* settings files Claude Code merges.
   * Claude Code reads the union of `<project>/.claude/settings.json`,
   * `settings.local.json` and `~/.claude/settings.json`, so an entry written
   * here while an equivalent one lives in another file does not replace it —
   * both fire. That doubled every spool line, every reflex and every flush,
   * and neither `install` nor `doctor` could see it.
   */
  wiredElsewhere: ReadonlySet<string> = new Set(),
): MergeResult {
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

    // Repair, not merely detect. `commandSatisfiesWiring` answers "is
    // something here", never "is what is here correct" — so a matcher that
    // lost `Agent`, or a SessionStart command naming a Node that moved, was
    // left exactly as it was while the run reported success. `doctor` then
    // named this command as the fix for a condition it could not fix.
    let repaired = false;
    const updated = entries.map(entry => {
      if (entry === null || typeof entry !== 'object') return entry;
      const record = { ...(entry as Json) };
      const inner = record['hooks'];
      if (!Array.isArray(inner)) return entry;

      const index = inner.findIndex(hook => {
        if (hook === null || typeof hook !== 'object') return false;
        const value = (hook as Json)['command'];
        return typeof value === 'string' && commandSatisfiesWiring(value, required);
      });
      if (index < 0) return entry;

      let entryChanged = false;
      const hook = { ...(inner[index] as Json) };
      if (hook['command'] !== command) {
        hook['command'] = command;
        entryChanged = true;
      }
      if (required.matcher !== undefined && record['matcher'] !== required.matcher) {
        record['matcher'] = required.matcher;
        entryChanged = true;
      }
      if (!entryChanged) {
        repaired = true;
        return entry;
      }

      const nextInner = [...inner];
      nextInner[index] = hook;
      record['hooks'] = nextInner;
      repaired = true;
      changed = true;
      return record;
    });

    if (repaired) {
      hooks[required.event] = updated;
      continue;
    }

    // Nothing in this file wires it. If another settings file already does,
    // adding one here would double the invocation rather than fix anything.
    if (wiredElsewhere.has(required.event)) continue;

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

/** How many of the required wirings a settings object already satisfies. */
function countSatisfiedWirings(settings: Json): number {
  const commands = collectHookCommands(settings);
  return REQUIRED_WIRING.filter(required =>
    commands.some(
      entry => entry.event === required.event && commandSatisfiesWiring(entry.command, required),
    ),
  ).length;
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
  // A blank separator line only when there is something to separate from —
  // a file created from nothing otherwise begins with one.
  const separator = current.length === 0 ? '' : `${needsNewline ? '\n' : ''}\n`;
  return {
    text: `${current}${separator}# Cortex runtime artifacts\n${missing.join('\n')}\n`,
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

/** `dist/query/install.js` → `dist/transports/<name>`. */
function defaultEntry(moduleUrl: string, name: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', 'transports', name);
}

/** Expand a leading `~`, which the shell does and Node does not. */
function expandHome(target: string, homeDir: string): string {
  if (target === '~') return homeDir;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(homeDir, target.slice(2));
  }
  return target;
}

// ── The command ───────────────────────────────────────────────────────

export function runInstall(options: InstallOptions): InstallResult {
  const projectDir = options.projectDir;
  const homeDir = options.homeDir ?? os.homedir();
  const scope = options.scope ?? 'user';
  const dryRun = options.dryRun ?? false;
  const templateDir = options.templateDir ?? defaultTemplateDir(import.meta.url);
  const hooksDir = path.normalize(
    expandHome(options.hooksDir ?? path.join(homeDir, '.claude', 'hooks'), homeDir),
  );
  const nodePath = options.nodePath ?? process.execPath;
  // Real defaults, resolved the same way `defaultTemplateDir` resolves its own.
  // Defaulting these to `''` produced a hook invoking `"<node>" "" flush-spool`,
  // an MCP entry with an empty argument, a SessionStart wiring silently skipped
  // (`wiringCommand` returns null for an empty CLI path) — and a *second* run
  // that refused all three scripts as user-edited, because an empty
  // substitution cannot match the capture. The installer accusing the user of
  // editing a file it wrote itself is the worst outcome available here.
  const cliEntry = options.cliEntry ?? defaultEntry(import.meta.url, 'cli.js');
  const hookEntry = options.hookEntry ?? defaultEntry(import.meta.url, 'hook-entry.js');
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

  /**
   * Every filesystem step runs through this. `readJson` was guarded and
   * nothing else was, so a `.gitignore` that is a directory threw `EISDIR`
   * out of `runInstall` *after* three hook scripts and the settings file had
   * been written — the caller printed a bare errno with no path and no action
   * list, under a summary claiming nothing was left half-done. This is the
   * rule Story 2.3 already established for `runDoctor`.
   */
  const guarded = (id: string, target: string, fix: string, step: () => void): boolean => {
    try {
      step();
      return true;
    } catch (error) {
      add({
        id,
        target,
        outcome: 'refused',
        detail: `${target}: ${error instanceof Error ? error.message : String(error)}`,
        fix,
      });
      return false;
    }
  };

  if (!hooksDirIsShellSafe(hooksDir)) {
    add({
      id: 'hooks-dir',
      target: hooksDir,
      outcome: 'refused',
      detail:
        'the hooks directory contains a character the shell expands inside double quotes ($, backtick or backslash), so the wiring written from it would resolve somewhere else',
      fix: 'Install the hooks somewhere without those characters: `cortex install --dir <path>`.',
    });
    return {
      actions,
      unchanged: false,
      refusals: 1,
      dry_run: dryRun,
      hooks_dir: hooksDir,
      settings_path:
        scope === 'project'
          ? path.join(projectDir, '.claude', 'settings.json')
          : path.join(homeDir, '.claude', 'settings.json'),
    };
  }

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

    const SCRIPT_FIX = `Check that \`${target}\` is a writable file, then re-run.`;
    let templateText = '';
    let installedText: string | null = null;
    let exists = false;
    const read = guarded(`hook:${script}`, target, SCRIPT_FIX, () => {
      templateText = fs.readFileSync(templatePath, 'utf8');
      exists = fs.existsSync(target);
      installedText = exists ? fs.readFileSync(target, 'utf8') : null;
    });
    if (!read) continue;

    const rendered = renderHookScript(templateText, paths);
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
    // Any overwrite of existing content keeps a copy, not only the `unknown`
    // and `--force` paths. The one case that previously got no backup was
    // `unmodified` with differing bytes — which the story names as the
    // *expected* case (a user whose Node moved), and which was also the case
    // the unconstrained capture let an edited script fall into.
    const backup = installedText !== null;
    const wrote = guarded(`hook:${script}`, target, SCRIPT_FIX, () => {
      if (dryRun) return;
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
    });
    if (!wrote) continue;

    const provenance =
      state === 'unknown'
        ? 'not written by this build'
        : state === 'modified'
          ? 'edited, overwritten with --force'
          : state === 'absent'
            ? 'installed'
            : 'refreshed';
    add({
      id: `hook:${script}`,
      target,
      outcome: exists ? 'updated' : 'created',
      // Past tense only for a write that happened: a dry run reported a `.bak`
      // it had not made, under a header saying nothing was written.
      detail: backup
        ? `${provenance}; previous copy ${dryRun ? 'would be saved' : 'saved'} to ${path.basename(target)}.bak`
        : provenance,
    });
  }

  // ── Settings: hook wiring ───────────────────────────────────────────
  //
  // Which events the *other* files Claude Code merges already wire. Adding a
  // second entry for one of those does not replace it — both fire.
  const wiredElsewhere = new Set<string>();
  for (const other of [
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ]) {
    if (path.resolve(other) === path.resolve(settingsPath)) continue;
    const file = readJson(other);
    if (!file.existed || file.value === null) continue;
    for (const entry of collectHookCommands(file.value)) {
      for (const required of REQUIRED_WIRING) {
        if (entry.event === required.event && commandSatisfiesWiring(entry.command, required)) {
          wiredElsewhere.add(required.event);
        }
      }
    }
  }

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
    const before = countSatisfiedWirings(settings.value);
    const merged = mergeHookWiring(settings.value, hooksDir, paths, wiredElsewhere);
    const after = countSatisfiedWirings(merged.value);
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
      // What actually happened, not `REQUIRED_WIRING.length`. The constant was
      // printed unconditionally, so a file already carrying four of five
      // wirings still reported "wired 5 events" — and so did a run that wired
      // none at all.
      const added = after - before;
      const parts: string[] = [];
      if (added > 0) parts.push(`wired ${added} event${added === 1 ? '' : 's'}`);
      if (merged.changed && added === 0) parts.push('repaired an existing wiring');
      if (withMcp.changed) parts.push('registered the MCP server');
      add({
        id: 'settings',
        target: settingsPath,
        outcome: settings.existed ? 'updated' : 'created',
        detail: parts.join(' and '),
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
  const IGNORE_FIX = `Check that \`${ignorePath}\` is a writable file, then re-run.`;
  let ignoreExisted = false;
  let existingIgnore = '';
  const readIgnore = guarded('ignore', ignorePath, IGNORE_FIX, () => {
    ignoreExisted = fs.existsSync(ignorePath);
    existingIgnore = ignoreExisted ? fs.readFileSync(ignorePath, 'utf8') : '';
  });

  const ignore = readIgnore
    ? mergeIgnoreEntries(existingIgnore, IGNORE_ENTRIES)
    : { text: '', added: [] as string[] };

  if (!readIgnore) {
    // Already reported by the guard.
  } else if (ignore.added.length > 0) {
    const wroteIgnore = guarded('ignore', ignorePath, IGNORE_FIX, () => {
      if (!dryRun) writeFileAtomic(ignorePath, ignore.text);
    });
    if (wroteIgnore) {
      add({
        id: 'ignore',
        target: ignorePath,
        outcome: ignoreExisted ? 'updated' : 'created',
        detail: `added ${ignore.added.length} entr${ignore.added.length === 1 ? 'y' : 'ies'}: ${ignore.added.join(', ')}`,
      });
    }
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
