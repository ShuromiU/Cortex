import type { CortexStore } from '../db/store.js';
import { classifyCommand, redactCommand, extractTouchedFiles } from './redact.js';

// ── Argument interfaces ───────────────────────────────────────────────

export interface ReadArgs {
  file: string;
  lines?: string;
}

export interface EditArgs {
  file: string;
  lines?: string;
}

export interface WriteArgs {
  file: string;
}

export interface CmdArgs {
  exit?: string;
  cmd?: string;
}

export interface AgentArgs {
  desc: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse a "start-end" line range string into discrete fields.
 * Returns an empty object if lines is undefined or unparseable.
 */
export function parseLineRange(lines?: string): { line_start?: number; line_end?: number } {
  if (!lines) return {};
  const match = /^(\d+)-(\d+)$/.exec(lines.trim());
  if (!match) return {};
  const line_start = parseInt(match[1]!, 10);
  const line_end = parseInt(match[2]!, 10);
  return { line_start, line_end };
}

// ── Event handlers ────────────────────────────────────────────────────

/**
 * Record a file-read event.
 */
export function handleReadEvent(
  store: CortexStore,
  sessionId: string,
  args: ReadArgs,
): void {
  const range = parseLineRange(args.lines);
  store.insertEvent({
    sessionId,
    type: 'read',
    target: args.file,
    ...(Object.keys(range).length > 0 ? { metadata: range } : {}),
  });
}

/**
 * Record a file-edit event.
 */
export function handleEditEvent(
  store: CortexStore,
  sessionId: string,
  args: EditArgs,
): void {
  const range = parseLineRange(args.lines);
  store.insertEvent({
    sessionId,
    type: 'edit',
    target: args.file,
    ...(Object.keys(range).length > 0 ? { metadata: range } : {}),
  });
}

/**
 * Record a file-write event.
 */
export function handleWriteEvent(
  store: CortexStore,
  sessionId: string,
  args: WriteArgs,
): void {
  store.insertEvent({
    sessionId,
    type: 'write',
    target: args.file,
  });
}

/**
 * Record a command-execution event with classification and redaction.
 */
export function handleCmdEvent(
  store: CortexStore,
  sessionId: string,
  args: CmdArgs,
): void {
  const exitCode = args.exit !== undefined ? parseInt(args.exit, 10) : undefined;
  const category = args.cmd !== undefined ? classifyCommand(args.cmd) : undefined;
  const safeSummary = args.cmd !== undefined ? redactCommand(args.cmd) : undefined;
  const filesTouched =
    args.cmd !== undefined ? extractTouchedFiles(args.cmd) : undefined;

  const metadata: Record<string, unknown> = {
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(safeSummary !== undefined ? { safe_summary: safeSummary } : {}),
    ...(filesTouched !== undefined ? { files_touched: filesTouched } : {}),
  };

  store.insertEvent({
    sessionId,
    type: 'cmd',
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}

/**
 * Record a sub-agent delegation event.
 */
export function handleAgentEvent(
  store: CortexStore,
  sessionId: string,
  args: AgentArgs,
): void {
  store.insertEvent({
    sessionId,
    type: 'agent',
    metadata: { description: args.desc },
  });
}
