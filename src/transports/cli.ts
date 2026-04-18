#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
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
import {
  consolidateLevel1,
  renderCompressed,
  mergeProjectState,
  writeSessionSummary,
} from '../capture/consolidate.js';
import { evaluateDatabase } from '../eval/harness.js';
import { buildHeader, formatTokens } from '../query/state.js';
import { deriveEngagementPath } from './mcp.js';
import { ensureScopedSession, syncBranchSnapshotForSession } from '../scope/runtime.js';

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

function parseTopics(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
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
    .action(() => {
      const { store } = openCortexDb(process.cwd());
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
        store.endSession(current.id);
      }

      ensureScopedSession(store, process.cwd());

      const engPath = deriveEngagementPath(process.cwd());
      try {
        fs.writeFileSync(engPath, 'enabled=true\nstate_called=false\n');
      } catch {
        // Non-fatal.
      }

      process.stdout.write(`${buildHeader(store)}\n`);
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
    .action((opts: { db: string; root: string; topics?: string }) => {
      const dbPath = path.isAbsolute(opts.db)
        ? opts.db
        : path.resolve(process.cwd(), opts.db);
      const rootPath = path.isAbsolute(opts.root)
        ? opts.root
        : path.resolve(process.cwd(), opts.root);
      const result = evaluateDatabase(dbPath, rootPath, parseTopics(opts.topics));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
