#!/usr/bin/env node

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import { openDatabase, applySchema, initializeMeta } from '../db/schema.js';
import { CortexStore } from '../db/store.js';
import {
  handleReadEvent,
  handleEditEvent,
  handleWriteEvent,
  handleCmdEvent,
  handleAgentEvent,
} from '../capture/hooks.js';
import { consolidateLevel1, renderCompressed, mergeProjectState } from '../capture/consolidate.js';
import { buildHeader, formatTokens } from '../query/state.js';
import { deriveEngagementPath } from './mcp.js';

// ── Helpers ───────────────────────────────────────────────────────────

function findDbPath(startDir: string): string {
  return path.join(startDir, '.cortex.db');
}

function openCortexDb(startDir: string): { store: CortexStore; dbPath: string } {
  const dbPath = findDbPath(startDir);
  const db = openDatabase(dbPath);
  applySchema(db);

  // Initialize meta if not yet set
  const checkMeta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!checkMeta) {
    initializeMeta(db, startDir);
  }

  const store = new CortexStore(db);
  return { store, dbPath };
}

function ensureSession(store: CortexStore): string {
  const current = store.getCurrentSession();
  if (current) return current.id;
  const session = store.createSession();
  return session.id;
}

// ── Program ───────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cortex')
    .description('Cortex working memory for AI agents')
    .version('0.1.0');

  // ── log subcommand ────────────────────────────────────────────────

  const log = program.command('log').description('Log events to the working memory');

  log
    .command('read')
    .description('Log a file read event')
    .requiredOption('--file <path>', 'File path that was read')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store);
      handleReadEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('edit')
    .description('Log a file edit event')
    .requiredOption('--file <path>', 'File path that was edited')
    .option('--lines <range>', 'Line range (e.g. 10-50)')
    .action((opts: { file: string; lines?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store);
      handleEditEvent(store, sessionId, { file: opts.file, lines: opts.lines });
    });

  log
    .command('write')
    .description('Log a file write event')
    .requiredOption('--file <path>', 'File path that was written')
    .action((opts: { file: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store);
      handleWriteEvent(store, sessionId, { file: opts.file });
    });

  log
    .command('cmd')
    .description('Log a command execution event')
    .option('--exit <code>', 'Exit code of the command')
    .option('--cmd <text>', 'Command text')
    .action((opts: { exit?: string; cmd?: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store);
      handleCmdEvent(store, sessionId, { exit: opts.exit, cmd: opts.cmd });
    });

  log
    .command('agent')
    .description('Log a sub-agent delegation event')
    .requiredOption('--desc <text>', 'Description of the agent task')
    .action((opts: { desc: string }) => {
      const { store } = openCortexDb(process.cwd());
      const sessionId = ensureSession(store);
      handleAgentEvent(store, sessionId, { desc: opts.desc });
    });

  // ── inject-header ─────────────────────────────────────────────────

  program
    .command('inject-header')
    .description('Consolidate sessions, start a new session, print context header')
    .action(() => {
      const { store } = openCortexDb(process.cwd());

      // Consolidate unconsolidated ended sessions (Level 1)
      const unconsolidated = store.getUnconsolidatedSessions();
      for (const session of unconsolidated) {
        const compressed = consolidateLevel1(store, session.id);
        if (compressed.length > 0) {
          store.insertState({
            sessionId: session.id,
            layer: 'session',
            content: renderCompressed(compressed),
          });
        }
      }

      // Level 3: merge older session states into project state if threshold exceeded
      mergeProjectState(store);

      // End any currently active session
      const current = store.getCurrentSession();
      if (current) {
        store.endSession(current.id);
      }

      // Create new session
      store.createSession();

      // Reset engagement state file for the new session
      const engPath = deriveEngagementPath(process.cwd());
      try {
        fs.writeFileSync(engPath, 'enabled=false\nstate_called=false\n');
      } catch {
        // Non-fatal — /tmp/ write may fail on some systems
      }

      // Print header
      const header = buildHeader(store);
      process.stdout.write(header + '\n');
    });

  // ── status ────────────────────────────────────────────────────────

  program
    .command('status')
    .description('Print DB status')
    .action(() => {
      try {
        const { store, dbPath } = openCortexDb(process.cwd());
        const rootPath = store.getMeta('root_path') ?? process.cwd();
        const sessionCount = store.getSessionCount();
        process.stdout.write(`OK\n`);
        process.stdout.write(`DB: ${dbPath}\n`);
        process.stdout.write(`Root: ${rootPath}\n`);
        process.stdout.write(`Sessions: ${sessionCount}\n`);
      } catch (err) {
        process.stdout.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ── stats ─────────────────────────────────────────────────────────

  program
    .command('stats')
    .description('Token savings dashboard')
    .action(() => {
      const { store } = openCortexDb(process.cwd());

      // Focus
      const recentSessions = store.getRecentSessions(10);
      let focus = 'unfocused';
      for (const s of recentSessions) {
        if (s.focus !== null) {
          focus = s.focus;
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

  // ── consolidate ───────────────────────────────────────────────────

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
          store.insertState({
            sessionId: session.id,
            layer: 'session',
            content: renderCompressed(compressed),
          });
          count++;
        }
      }

      process.stdout.write(`Consolidated ${count} session(s).\n`);
    });

  // ── serve ─────────────────────────────────────────────────────────

  program
    .command('serve')
    .description('Start the MCP server')
    .action(async () => {
      const { startServer } = await import('./mcp.js');
      await startServer(process.cwd());
    });

  return program;
}

// ── Direct execution ──────────────────────────────────────────────────

const self = process.argv[1] ?? '';
if (self.endsWith('cli.js') || self.endsWith('cli.ts')) {
  const program = createProgram();
  program.parse(process.argv);
}
