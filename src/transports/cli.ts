#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import {
  handleReadEvent,
  handleEditEvent,
  handleWriteEvent,
  handleCmdEvent,
  handleAgentEvent,
} from '../capture/hooks.js';
import { flushSpool } from '../capture/spool.js';
import { runGc, shouldAutoGc } from '../db/gc.js';
import {
  consolidateLevel1,
  renderCompressed,
  mergeProjectState,
  writeSessionSummary,
} from '../capture/consolidate.js';
import {
  evaluateDatabase,
  type EvaluationOptions,
  type EvaluationResult,
  type QualityFixture,
} from '../eval/harness.js';
import { BASELINE_TRAILER, regenerateBaseline, runEvalGate } from '../eval/gate.js';
import type { EvaluationScenario } from '../eval/seed.js';
import { buildHeader, formatTokens } from '../query/state.js';
import { buildSessionBrief } from '../query/session-brief.js';
import { estimateTokens } from '../query/retrieval.js';
import { reflectMemory, type ReflexEvent } from '../query/reflex.js';
import {
  configureEngagementPath,
  deriveEngagementPath,
  readEngagement,
  renderCortexRoute,
} from './mcp.js';
import { ensureScopedSession, syncBranchSnapshotForSession } from '../scope/runtime.js';
import { refreshCurrentAppGraph } from '../scope/app-graph.js';
import { suggestNotes } from '../query/suggest-notes.js';
import { validateMemory } from '../query/validate-memory.js';

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): { store: CortexStore; dbPath: string } {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, startDir);
  const store = new CortexStore(db);
  return { store, dbPath };
}

function ensureSession(store: CortexStore, cwd: string): string {
  return ensureScopedSession(store, cwd).id;
}

function refreshCurrentGraphQuietly(store: CortexStore, cwd: string): void {
  try {
    refreshCurrentAppGraph(store, cwd);
  } catch {
    // Current-truth refresh should never block memory access.
  }
}

function parseTopics(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
}

function readJsonFile(filePath: string): unknown {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

interface QualitySuite {
  fixtures: QualityFixture[];
  seed?: EvaluationScenario;
}

function parseQualitySuite(filePath: string): QualitySuite {
  const parsed = readJsonFile(filePath);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { fixtures?: unknown }).fixtures)
  ) {
    throw new Error('Quality suite must be a JSON object with a fixtures array');
  }

  const suite = parsed as { fixtures: QualityFixture[]; seed?: unknown };
  if (suite.seed !== undefined) {
    if (
      !suite.seed ||
      typeof suite.seed !== 'object' ||
      !Array.isArray((suite.seed as { items?: unknown }).items)
    ) {
      throw new Error('Quality suite seed must be an object with an items array');
    }
    return { fixtures: suite.fixtures, seed: suite.seed as EvaluationScenario };
  }

  return { fixtures: suite.fixtures };
}

function parseEvaluationResult(filePath: string): EvaluationResult {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Compare file must be a Cortex evaluation JSON object');
  }

  return parsed as EvaluationResult;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cortex')
    .description('Cortex working memory for AI agents')
    .version('0.1.0');

  const log = program.command('log').description('Log events to the working memory');

  log
    .command('read')
    .description('Log a file read event')
    .requiredOption('--file <path>', 'File path that was read')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleReadEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('edit')
    .description('Log a file edit event')
    .requiredOption('--file <path>', 'File path that was edited')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleEditEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('write')
    .description('Log a file write event')
    .requiredOption('--file <path>', 'File path that was written')
    .action((opts: { file: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleWriteEvent(store, sessionId, { file: opts.file });
    });

  log
    .command('cmd')
    .description('Log a command execution event')
    .option('--exit <code>', 'Exit code of the command')
    .option('--cmd <text>', 'Command text')
    .option('--stdout <text>', 'Captured stdout for the command (optional)')
    .option('--stderr <text>', 'Captured stderr for the command (optional)')
    .action((opts: { exit?: string; cmd?: string; stdout?: string; stderr?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleCmdEvent(store, sessionId, {
        exit: opts.exit,
        cmd: opts.cmd,
        stdout: opts.stdout,
        stderr: opts.stderr,
      });
    });

  log
    .command('agent')
    .description('Log a sub-agent delegation event')
    .requiredOption('--desc <text>', 'Description of the agent task')
    .action((opts: { desc: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store, process.cwd());
      handleAgentEvent(store, sessionId, { desc: opts.desc });
    });

  program
    .command('inject-header')
    .description('Consolidate sessions, start a new session, print context header')
    .option('--quiet', 'Engage capture without printing the working-memory header')
    .action((opts: { quiet?: boolean }) => {
      configureEngagementPath(process.cwd());
      const { store } = openCortexDb(process.cwd());

      // Replay leftover spooled capture into the session it belongs to,
      // before that session is consolidated and ended.
      const previous = store.getCurrentSession();
      if (previous) {
        try {
          flushSpool(store, process.cwd(), previous.id);
        } catch {
          // Leftovers stay in the spool for the next flush.
        }
      }

      const unconsolidated = store.getUnconsolidatedSessions();

      for (const session of unconsolidated) {
        const compressed = consolidateLevel1(store, session.id);
        if (compressed.length > 0) {
          writeSessionSummary(store, session.id, renderCompressed(compressed));
        }
      }

      mergeProjectState(store);

      const current = store.getCurrentSession();
      if (current) {
        syncBranchSnapshotForSession(store, current.id);
        store.endSessionTree(current.id);
      }

      const scopedSession = ensureScopedSession(store, process.cwd());
      if (!previous) {
        try {
          flushSpool(store, process.cwd(), scopedSession.id);
        } catch {
          // Leftovers stay in the spool for the next flush.
        }
      }
      refreshCurrentGraphQuietly(store, process.cwd());

      const engPath = deriveEngagementPath(process.cwd());
      try {
        fs.writeFileSync(engPath, 'enabled=true\nstate_called=false\n');
      } catch {
        // Non-fatal.
      }

      // Opt-in automatic GC, at most once per 24h.
      if (process.env['CORTEX_GC_AUTO'] === 'apply') {
        try {
          const gcDb = openDatabase(findDbPath(process.cwd()));
          if (shouldAutoGc(gcDb)) {
            runGc(gcDb, { dryRun: false });
          }
          gcDb.close();
        } catch {
          // GC must never block session start.
        }
      }

      if (opts.quiet) {
        // Quiet mode still leads with value: a tiny validated brief, or silence.
        const sessionBrief = buildSessionBrief(store);
        if (sessionBrief) {
          const scoped = store.getCurrentSession();
          if (scoped) {
            try {
              store.insertLedgerEntry({
                sessionId: scoped.id,
                type: 'session_brief',
                direction: 'spent',
                tokens: estimateTokens(sessionBrief),
              });
            } catch {
              // Ledger accounting must never block startup.
            }
          }
          process.stdout.write(`${sessionBrief}\n`);
        }
        return;
      }

      process.stdout.write(`${buildHeader(store)}\n`);
    });

  program
    .command('route')
    .description('Show Cortex ambient-memory capabilities and routing guidance')
    .action(() => {
      process.stdout.write(`${renderCortexRoute()}\n`);
    });

  program
    .command('reflect')
    .description('Emit hook additionalContext when remembered context matches the current focus')
    .requiredOption('--event <event>', 'Hook event anchor type: prompt, edit, cmd, or agent')
    .option('--prompt <text>', 'User prompt text for prompt events')
    .option('--file <path>', 'File path for edit events')
    .option('--cmd <text>', 'Command text for command events')
    .option('--desc <text>', 'Agent task description for agent events')
    .action((opts: { event: ReflexEvent; prompt?: string; file?: string; cmd?: string; desc?: string }) => {
      configureEngagementPath(process.cwd());
      if (readEngagement()['enabled'] !== 'true') {
        return;
      }

      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      refreshCurrentGraphQuietly(store, process.cwd());
      const output = reflectMemory(store, {
        event: opts.event,
        prompt: opts.prompt,
        file: opts.file,
        cmd: opts.cmd,
        desc: opts.desc,
        sessionId: session.id,
      });

      if (output) {
        process.stdout.write(`${output}\n`);
      }
    });

  program
    .command('status')
    .description('Print DB status')
    .action(() => {
      try {
        const { store, dbPath } = openCortexDb(process.cwd());
        const rootPath = store.getMeta('root_path') ?? process.cwd();
        const sessionCount = store.getSessionCount();
        process.stdout.write('OK\n');
        process.stdout.write(`DB: ${dbPath}\n`);
        process.stdout.write(`Root: ${rootPath}\n`);
        process.stdout.write(`Sessions: ${sessionCount}\n`);
      } catch (err) {
        process.stdout.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  program
    .command('stats')
    .description('Token savings dashboard')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const recentSessions = store.getRecentSessions(10);
      let focus = 'unfocused';
      for (const session of recentSessions) {
        if (session.focus !== null) {
          focus = session.focus;
          break;
        }
      }

      const sessionCount = store.getSessionCount();
      const activeNotes = store.getActiveNotes();
      const { spent, saved } = store.getTotalTokens();
      const net = saved - spent;
      const efficiency = spent > 0 ? Math.round((saved / (spent + saved)) * 100) : 0;

      process.stdout.write(`Focus:         ${focus}\n`);
      process.stdout.write(`Sessions:      ${sessionCount}\n`);
      process.stdout.write(`Active notes:  ${activeNotes.length}\n`);
      process.stdout.write(`Spent:         ${formatTokens(spent)}\n`);
      process.stdout.write(`Saved:         ${formatTokens(saved)}\n`);
      process.stdout.write(`Net:           ${formatTokens(net)}\n`);
      process.stdout.write(`Efficiency:    ${efficiency}%\n`);
    });

  program
    .command('consolidate')
    .description('Manually trigger Level 1 consolidation for unconsolidated sessions')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const unconsolidated = store.getUnconsolidatedSessions();

      if (unconsolidated.length === 0) {
        process.stdout.write('No unconsolidated sessions.\n');
        return;
      }

      let count = 0;
      for (const session of unconsolidated) {
        const compressed = consolidateLevel1(store, session.id);
        if (compressed.length > 0) {
          writeSessionSummary(store, session.id, renderCompressed(compressed));
          count++;
        }
      }

      process.stdout.write(`Consolidated ${count} session(s).\n`);
    });

  program
    .command('evaluate')
    .description('Evaluate current memory state and recall output sizes for a Cortex DB')
    .option('--db <path>', 'Path to the Cortex SQLite database', '.cortex.db')
    .option('--root <path>', 'Project root path for schema initialization', process.cwd())
    .option('--topics <items>', 'Comma-separated topics to replay')
    .option('--suite <path>', 'Path to a JSON quality suite with retrieval fixtures')
    .option('--compare <path>', 'Path to a previous cortex evaluate JSON result')
    .action((opts: { db: string; root: string; topics?: string; suite?: string; compare?: string }) => {
      const dbPath = path.isAbsolute(opts.db)
        ? opts.db
        : path.resolve(process.cwd(), opts.db);
      const rootPath = path.isAbsolute(opts.root)
        ? opts.root
        : path.resolve(process.cwd(), opts.root);
      const suite = opts.suite ? parseQualitySuite(opts.suite) : undefined;
      const options: EvaluationOptions = {
        ...(suite ? { fixtures: suite.fixtures } : {}),
        ...(suite?.seed ? { scenario: suite.seed } : {}),
        ...(opts.compare ? { compareTo: parseEvaluationResult(opts.compare) } : {}),
      };
      const result = evaluateDatabase(dbPath, rootPath, parseTopics(opts.topics), options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  program
    .command('eval-gate')
    .description('Run every locked retrieval-quality suite against its baseline (FR-44, AD-5)')
    .option('--suites <dir>', 'Directory of locked suites', 'eval/suites')
    .option('--baselines <dir>', 'Directory of locked baselines', 'eval/baselines')
    .option('--coverage <path>', 'Kind-coverage manifest', 'eval/kind-coverage.json')
    .option(
      '--regenerate-baseline <suite>',
      'Rewrite one locked baseline. Deliberate act — justify it in the commit body.',
    )
    .action((opts: {
      suites: string;
      baselines: string;
      coverage: string;
      regenerateBaseline?: string;
    }) => {
      const options = {
        suitesDir: opts.suites,
        baselinesDir: opts.baselines,
        coveragePath: opts.coverage,
        rootPath: process.cwd(),
      };

      if (opts.regenerateBaseline) {
        const report = regenerateBaseline(opts.regenerateBaseline, options);
        process.stdout.write(`rewrote ${report.baselinePath}\n`);
        if (report.accepted.length > 0) {
          process.stdout.write(
            `accepting these regressions into the baseline:\n${report.accepted
              .map(line => `  ${line}`)
              .join('\n')}\n`,
          );
        }
        process.stdout.write(
          `\nState the reason in the commit body:\n  ${BASELINE_TRAILER} <why this quality change is intended>\n`,
        );
        return;
      }

      const result = runEvalGate(options);
      process.stdout.write(`${result.lines.join('\n')}\n`);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command('flush-spool')
    .description('Replay spooled hook capture (.cortex.spool.jsonl) into the store')
    .action(() => {
      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      const result = flushSpool(store, process.cwd(), session.id);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

  program
    .command('note-resolve')
    .description('Mark a saved note as resolved or superseded')
    .option('--id <id>', 'Note id')
    .option('--subject <text>', 'Subject of the active note (when id is unknown)')
    .option('--status <status>', 'resolved | superseded', 'resolved')
    .action((opts: { id?: string; subject?: string; status?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const status = opts.status === 'superseded' ? 'superseded' : 'resolved';
      const note = opts.id
        ? store.getNote(opts.id)
        : opts.subject
          ? store.findActiveNoteBySubject(opts.subject)
          : undefined;
      if (!note) {
        process.stderr.write('No matching note found (pass --id or --subject).\n');
        process.exitCode = 1;
        return;
      }
      store.updateNoteStatus(note.id, status);
      process.stdout.write(`Marked ${note.kind}${note.subject ? `[${note.subject}]` : ''} as ${status}.\n`);
    });

  program
    .command('gc')
    .description('Prune derived data (events, retrieval log, ledger, archived items). Dry-run by default.')
    .option('--apply', 'Actually delete (default is a dry-run report)')
    .option('--vacuum <mode>', 'auto | always | never', 'auto')
    .action((opts: { apply?: boolean; vacuum?: string }) => {
      const dbPath = findDbPath(process.cwd());
      const db = openDatabase(dbPath);
      ensureCortexSchema(db, process.cwd());
      const vacuum =
        opts.vacuum === 'always' || opts.vacuum === 'never' ? opts.vacuum : 'auto';
      const report = runGc(db, { dryRun: !opts.apply, vacuum });
      db.close();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    });

  program
    .command('install-hooks')
    .description('Install canonical Cortex hook scripts for a harness')
    .option('--claude', 'Install for Claude Code (~/.claude/hooks)')
    .option('--codex', 'Install for Codex (~/.codex/hooks)')
    .option('--dir <path>', 'Override the hooks directory')
    .action((opts: { claude?: boolean; codex?: boolean; dir?: string }) => {
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const templateDir = path.resolve(moduleDir, '..', '..', 'hooks', 'claude');
      const nodePath = process.execPath;
      const cliEntry = path.resolve(moduleDir, 'cli.js');
      const hookEntry = path.resolve(moduleDir, 'hook-entry.js');

      const targetDir =
        opts.dir ??
        (opts.codex
          ? path.join(os.homedir(), '.codex', 'hooks')
          : path.join(os.homedir(), '.claude', 'hooks'));
      fs.mkdirSync(targetDir, { recursive: true });

      const scripts = ['cortex-capture.sh', 'cortex-reflect.sh', 'cortex-end-of-turn.sh'];
      for (const script of scripts) {
        const template = fs.readFileSync(path.join(templateDir, script), 'utf8');
        const rendered = template
          .replaceAll('__CORTEX_NODE__', nodePath)
          .replaceAll('__CORTEX_CLI__', cliEntry)
          .replaceAll('__CORTEX_HOOK_ENTRY__', hookEntry);
        const target = path.join(targetDir, script);
        fs.writeFileSync(target, rendered);
        try {
          fs.chmodSync(target, 0o755);
        } catch {
          // chmod is a no-op on Windows.
        }
        process.stdout.write(`installed ${target}\n`);
      }

      const hooksDirForSnippet = targetDir.replace(/\\/g, '/');
      const snippet = {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `"${nodePath}" "${cliEntry}" inject-header --quiet` }] },
          ],
          PostToolUse: [
            {
              matcher: 'Read|Edit|Write|Bash|Agent',
              hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-capture.sh"` }],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-reflect.sh" reflect-pre` }],
            },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-reflect.sh" reflect-prompt` }] },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: `bash "${hooksDirForSnippet}/cortex-end-of-turn.sh"` }] },
          ],
        },
      };
      process.stdout.write(
        `\nMerge into ${opts.codex ? 'Codex' : 'Claude'} settings (hooks section):\n${JSON.stringify(snippet, null, 2)}\n`,
      );
      process.stdout.write(
        '\nNotes: capture is spooled (no Node per tool call); reflex runs only on Edit|Write and prompts; the Stop nudge fires only with high-confidence suggestions. Remove any old cortex-hook.sh / cortex-mark-agent-used.sh wiring.\n',
      );
    });

  program
    .command('suggest-notes')
    .description('Suggest load-bearing notes from the current session without writing them')
    .option('--session <id>', 'Session id to inspect. Defaults to the current scoped session')
    .action((opts: { session?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const session = ensureScopedSession(store, process.cwd());
      const sessionId = opts.session ?? session.id;
      const suggestions = suggestNotes(store, sessionId);
      process.stdout.write(`${JSON.stringify({ session_id: sessionId, suggestions }, null, 2)}\n`);
    });

  program
    .command('validate-memory')
    .description('Audit retrieved memory against the current checkout without deleting notes')
    .option('--topic <text>', 'Topic to validate. Defaults to recent memory')
    .action((opts: { topic?: string }) => {
      const { store } = openCortexDb(process.cwd());
      ensureScopedSession(store, process.cwd());
      refreshCurrentGraphQuietly(store, process.cwd());
      const report = validateMemory(store, opts.topic);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    });

  program
    .command('serve')
    .description('Start the MCP server')
    .action(async () => {
      const { startServer } = await import('./mcp.js');
      await startServer(process.cwd());
    });

  return program;
}

const self = process.argv[1] ?? '';
if (self.endsWith('cli.js') || self.endsWith('cli.ts')) {
  const program = createProgram();
  program.parse(process.argv);
}
