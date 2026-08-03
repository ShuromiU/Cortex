import * as fs from 'node:fs';

/**
 * The command-outcome oracle (FR-14, Story 4.4).
 *
 * **Why this file exists.** Measured against the running host on 2026-08-03 by
 * dumping raw hook stdin: the Bash `PostToolUse` payload contains no exit code
 * in any form — `tool_response` is exactly `stdout`, `stderr`, `interrupted`,
 * `isImage`, `noOutputExpected`, and no key anywhere in the payload matches
 * /exit|code|status/i. Worse, **a command the host deems FAILED fires no
 * `PostToolUse` at all** (`exit 3`, `exit 7`, `process.exit(2)` and a bare
 * failing `npx vitest run` each produced zero payloads), so the capture hook is
 * structurally blind to failure. "The hook fired" is not a usable success
 * signal either: `grep -c <no-match>` exits 1 and the host still reports
 * success.
 *
 * **This was not a latent gap — it was a live, silent outage.** The store held
 * **4,881 `command_runs` of which 2 carried an exit code** (both fixtures),
 * **0** stdout tails, and `writeCommandEpisodes`' two outcome-gated writers
 * (`command_failure`, `test_cycle`) had **never fired in production**. Both are
 * gated on `exitCode !== undefined`, so they failed safe — the AD-12 shape:
 * wired, running, and dead, with nothing anywhere saying so.
 *
 * **What this reads instead.** The host transcript (`transcript_path`, present
 * in every hook payload) is JSONL in the Anthropic messages shape: a Bash call
 * appears as a `tool_use` block (`name: "Bash"`, `id`, `input.command`) and its
 * result as a `tool_result` block carrying the same id and a structured
 * **`is_error` boolean**.
 *
 * **`is_error: true` is not the same question as "did this command fail".** It
 * also covers calls the host never ran at all. Measured over all 45 transcripts
 * on this machine (6,456 paired Bash calls, 130 failures): **5 of the 130 carry
 * no `Exit code N` line**, and every one of those five never executed — three
 * `Blocked:` refusals, one `InputValidationError`, and one the **user
 * explicitly denied**. Recording those as failed runs would fabricate an
 * execution that never happened, and the user-denial case would record a
 * command the user refused. So the exit line is required as the witness that a
 * process actually ran and returned a status; the remaining 125 all carry it,
 * so the gate costs no real failure. What is *never* branched on is the exit
 * value itself — only its presence gates, and its value is stored as recorded.
 *
 * **What this deliberately does NOT do.** It makes no claim about the present.
 * An earlier draft of this story used the same oracle to answer "would this
 * command still pass?", which requires knowing a command's complete input set
 * and that nothing has changed it. Three review layers over two rounds found
 * six reachable ways to answer that wrongly — the failure the PRD names as the
 * worst this product can produce — and every fix narrowed the answerable set
 * further, to a measured **4 eligible commands out of 2,051**, all four of them
 * the developer's own probes. That half was withdrawn by ruling (ShuromiU,
 * 2026-08-03). Recording *"the build failed at 14:32"* carries none of that
 * risk, because it asserts nothing about now.
 *
 * **Cost.** Runs only in the cold-path flush (AD-2/N-4: never a Node spawn per
 * tool call), and reads only a bounded TAIL of the file — never the whole
 * transcript, which reached 11 MB in the session that specified this story.
 *
 * **Failure direction.** Every unreadable, missing, malformed or truncated case
 * yields *less* evidence, and less evidence means fewer outcomes attached. An
 * outcome that cannot be established is simply not attached. Nothing here can
 * manufacture one (AD-6).
 */

export const TRANSCRIPT_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const TRANSCRIPT_DEFAULT_MAX_LINES = 20_000;

export interface TranscriptLimits {
  maxBytes: number;
  maxLines: number;
}

export interface TranscriptOutcome {
  toolUseId: string;
  /** Raw command text, exactly as the host recorded it. Redaction is the caller's. */
  command: string;
  /** True = the host reported this call as failed AND it demonstrably executed. */
  failed: boolean;
  /**
   * Non-null exactly when `failed` is true: a failure with no `Exit code N`
   * line never executed and yields no outcome at all (see the file header).
   * Its presence is the gate; its value is stored, never branched on.
   */
  exitCode: number | null;
  /** ISO timestamp of the tool_use line, when the host recorded one. */
  ts: string | null;
}

export type TranscriptScan =
  | {
      status: 'ok';
      outcomes: Map<string, TranscriptOutcome>;
      /** The byte cap was hit before the file start; older calls are absent. */
      truncated: boolean;
    }
  | { status: 'unavailable'; reason: TranscriptUnavailableReason };

export type TranscriptUnavailableReason =
  | 'no-path'
  | 'missing'
  | 'unreadable'
  | 'unparseable';

function resolveLimits(limits?: Partial<TranscriptLimits>): TranscriptLimits {
  return {
    maxBytes: limits?.maxBytes ?? TRANSCRIPT_DEFAULT_MAX_BYTES,
    maxLines: limits?.maxLines ?? TRANSCRIPT_DEFAULT_MAX_LINES,
  };
}

/** Read at most `maxBytes` from the END of the file, dropping a partial first line. */
function readTail(file: string, maxBytes: number): { text: string; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    // A directory reports `size` 0 on win32 and would otherwise scan as a
    // perfectly healthy transcript containing nothing — the exact "wired,
    // running, dead" shape this file exists because of.
    if (!stat.isFile()) return null;
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      // The first line is almost certainly cut mid-JSON; dropping it keeps
      // "unparseable" meaningful rather than an expected side effect of tailing.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, truncated };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a descriptor we are done with cannot change the answer, and
        // this runs on the capture path where nothing may throw.
      }
    }
  }
}

const EXIT_CODE_RE = /^Error: Exit code (\d{1,5})\b|^Exit code (\d{1,5})\b/;

/**
 * The witness that a failed call actually ran a process.
 *
 * `null` means the host reported an error for something it never executed —
 * a refusal, an input rejection, or a user denial (see the file header for the
 * measured shapes). Callers treat `null` as "no evidence", not as "exit 1".
 */
function parseExecutedExitCode(content: unknown): number | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map(part =>
              part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join('\n')
        : '';
  const m = EXIT_CODE_RE.exec(text.trimStart());
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (raw === undefined) return null;
  // `Number`, never `parseInt`: the repo rule. Non-integral values fall back.
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function contentBlocks(line: unknown): unknown[] {
  if (line === null || typeof line !== 'object') return [];
  const message = (line as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * Scan the transcript tail and pair Bash calls with their outcome.
 *
 * `toolName` is a parameter so a future host that names the shell tool
 * differently degrades to "no outcomes" rather than to a wrong pairing.
 */
export function scanTranscriptTail(
  transcriptPath: string | null | undefined,
  limits?: Partial<TranscriptLimits>,
  toolName = 'Bash',
): TranscriptScan {
  if (transcriptPath === null || transcriptPath === undefined || transcriptPath === '') {
    return { status: 'unavailable', reason: 'no-path' };
  }
  if (!fs.existsSync(transcriptPath)) {
    return { status: 'unavailable', reason: 'missing' };
  }
  const resolved = resolveLimits(limits);
  const tail = readTail(transcriptPath, resolved.maxBytes);
  if (tail === null) {
    return { status: 'unavailable', reason: 'unreadable' };
  }

  const commands = new Map<string, { command: string; ts: string | null }>();
  const results = new Map<string, { failed: boolean; exitCode: number | null }>();
  let parsedAny = false;
  let sawAny = false;

  const lines = tail.text.split('\n');
  // From the END. A cap that kept the FIRST N lines of a tail scan would discard
  // the newest calls and preserve the stalest — backwards for a reader whose
  // whole purpose is recency.
  const first = Math.max(0, lines.length - resolved.maxLines);
  for (let i = first; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    sawAny = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // One malformed line must not abort the scan: a transcript being appended
      // to concurrently can present a torn final line.
      continue;
    }
    parsedAny = true;
    const ts =
      parsed !== null && typeof parsed === 'object' && typeof (parsed as { timestamp?: unknown }).timestamp === 'string'
        ? (parsed as { timestamp: string }).timestamp
        : null;

    for (const block of contentBlocks(parsed)) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'tool_use' && b['name'] === toolName && typeof b['id'] === 'string') {
        const input = b['input'];
        const command =
          input !== null && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
            ? (input as { command: string }).command
            : '';
        if (command !== '') commands.set(b['id'], { command, ts });
      } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        // Only an EXPLICIT boolean is evidence. `undefined` is not "passed":
        // a host that stops emitting the field must produce no outcomes, not a
        // store full of unearned successes.
        const flag = b['is_error'];
        if (typeof flag !== 'boolean') continue;
        if (flag) {
          // A reported error with no exit line never ran (Blocked:, an input
          // rejection, a user denial). Recording it would invent an execution.
          const exitCode = parseExecutedExitCode(b['content']);
          if (exitCode === null) continue;
          results.set(b['tool_use_id'], { failed: true, exitCode });
        } else {
          results.set(b['tool_use_id'], { failed: false, exitCode: null });
        }
      }
    }
  }

  if (sawAny && !parsedAny) {
    return { status: 'unavailable', reason: 'unparseable' };
  }

  const outcomes = new Map<string, TranscriptOutcome>();
  for (const [id, use] of commands) {
    const result = results.get(id);
    // A call with no result in the window is still running, was interrupted, or
    // sits across the tail boundary. No evidence, no outcome.
    if (result === undefined) continue;
    outcomes.set(id, {
      toolUseId: id,
      command: use.command,
      failed: result.failed,
      exitCode: result.exitCode,
      ts: use.ts,
    });
  }

  return { status: 'ok', outcomes, truncated: tail.truncated };
}

/**
 * Index outcomes by their command TEXT, for attaching to spool lines.
 *
 * The spool line carries no `tool_use_id` (adding one is a hook-template change
 * and a machine-wide reinstall), so the pairing is by exact command text. When
 * one text appears in the window with **conflicting** outcomes the entry is
 * `'ambiguous'` and nothing is attached — guessing which run a spool line
 * belongs to is exactly the kind of inference this file exists to avoid.
 * Identical outcomes for identical text collapse harmlessly.
 */
export type CommandOutcomeMap = Map<string, TranscriptOutcome | 'ambiguous'>;

export function outcomesByCommand(scan: TranscriptScan): CommandOutcomeMap {
  const byCommand: CommandOutcomeMap = new Map();
  if (scan.status !== 'ok') return byCommand;
  for (const outcome of scan.outcomes.values()) {
    const seen = byCommand.get(outcome.command);
    if (seen === undefined) {
      byCommand.set(outcome.command, outcome);
      continue;
    }
    if (seen === 'ambiguous') continue;
    if (seen.failed !== outcome.failed || seen.exitCode !== outcome.exitCode) {
      byCommand.set(outcome.command, 'ambiguous');
    }
  }
  return byCommand;
}

/**
 * The exit status to record, or `null` when there is nothing evidenced to record.
 *
 * A failure always carries its status (one with no exit line never executed and
 * never becomes an outcome at all), so the `null` arm is unreachable through
 * `scanTranscriptTail`. It exists so that callers **skip** rather than
 * substitute a plausible-looking `1` if that ever stops holding — inventing a
 * status is precisely the fabrication this module is built to refuse (AD-6).
 */
export function outcomeExitCode(outcome: TranscriptOutcome): number | null {
  return outcome.failed ? outcome.exitCode : 0;
}

/**
 * Failures in transcript order, keyed by their own `tool_use_id`.
 *
 * The synthesis path uses THIS rather than the text-keyed map, and the
 * distinction is load-bearing. Attaching to a spool line must go by text,
 * because the spool line carries no id — so two runs of one text collapse, and
 * a conflicting pair has to be dropped. Synthesis has no spool line to match
 * against, so it can use the id the host already assigned: three genuine
 * failures of `npm test` in one window are three records, not one, and each is
 * written exactly once ever because its id is remembered.
 */
export function failedOutcomes(scan: TranscriptScan): TranscriptOutcome[] {
  if (scan.status !== 'ok') return [];
  return [...scan.outcomes.values()].filter(o => o.failed);
}

/**
 * One compact line describing what the last scan actually saw.
 *
 * Recorded in meta and surfaced by `cortex doctor`. Without it this feature has
 * the shape of the outage it exists to fix: a host that renames
 * `transcript_path`, stops emitting `is_error`, or moves the file produces
 * silence indistinguishable from "nothing failed". `truncated` is reported here
 * rather than computed and discarded — a tail that dropped most of the file
 * must not look like a complete one.
 */
export function describeScan(scan: TranscriptScan): string {
  if (scan.status !== 'ok') return `unavailable:${scan.reason}`;
  let failures = 0;
  for (const outcome of scan.outcomes.values()) if (outcome.failed) failures++;
  return `ok outcomes=${scan.outcomes.size} failures=${failures} truncated=${scan.truncated ? 'yes' : 'no'}`;
}
