import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { appendSpoolEntry, flushSpool, SCAN_STATUS_KEY } from '../src/capture/spool.js';
import {
  describeScan,
  failedOutcomes,
  outcomesByCommand,
  scanTranscriptTail,
  type TranscriptScan,
} from '../src/capture/transcript.js';

/**
 * FR-14 (Story 4.4, re-scoped): the command-outcome oracle.
 *
 * The caching half of this story was withdrawn by ruling after three review
 * layers found six reachable ways to falsely report "your tests still pass".
 * What remains is the discovery that made it necessary: **Cortex could never
 * see whether a command passed or failed at all**, which is why two shipped
 * features had never fired once in 4,881 recorded commands. Nothing here
 * asserts anything about the present.
 */

const T0 = '2026-08-03T12:00:00.000Z';

/** `os.tmpdir()`, never a literal `/tmp` — on win32 they are different filesystems. */
function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-out-')));
}

interface Fixture {
  store: CortexStore;
  root: string;
  sessionId: string;
}

function fixture(): Fixture {
  const root = tempRoot();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  const session = store.createSession({ worktreePath: root, scopeType: 'project', scopeKey: `project:${root}` });
  return { store, root, sessionId: session.id };
}

interface Call {
  id: string;
  command: string;
  failed?: boolean;
  ts?: string;
  content?: string;
  omitError?: boolean;
  tool?: string;
}

/** Build a transcript the way the host writes one. */
function writeTranscript(file: string, calls: Call[]): void {
  const lines: string[] = [];
  for (const c of calls) {
    lines.push(
      JSON.stringify({
        timestamp: c.ts ?? T0,
        message: {
          content: [
            { type: 'tool_use', name: c.tool ?? 'Bash', id: c.id, input: { command: c.command } },
          ],
        },
      }),
    );
    const result: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: c.id,
      content: c.content ?? (c.failed ? 'Exit code 1\nboom' : 'ok'),
    };
    if (c.omitError !== true) result['is_error'] = c.failed === true;
    lines.push(JSON.stringify({ timestamp: c.ts ?? T0, message: { content: [result] } }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function commandRuns(fx: Fixture): Array<{ command_summary: string; exit_code: number | null; stdout_tail: string | null }> {
  return fx.store.db
    .prepare('SELECT command_summary, exit_code, stdout_tail FROM command_runs ORDER BY rowid')
    .all() as never;
}

function episodeKinds(fx: Fixture): string[] {
  return (fx.store.db.prepare('SELECT kind FROM episodes ORDER BY rowid').all() as Array<{ kind: string }>).map(
    r => r.kind,
  );
}

// ── The oracle itself ────────────────────────────────────────────────

describe('scanTranscriptTail', () => {
  it('reports no-path when the host provides none', () => {
    expect(scanTranscriptTail(null)).toEqual({ status: 'unavailable', reason: 'no-path' });
    expect(scanTranscriptTail('')).toEqual({ status: 'unavailable', reason: 'no-path' });
  });

  it('reports missing for a path that does not exist', () => {
    expect(scanTranscriptTail(path.join(tempRoot(), 'nope.jsonl'))).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
  });

  it('pairs a Bash call with its structured outcome', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [
      { id: 'a1', command: 'npm test' },
      { id: 'a2', command: 'npx tsc --noEmit', failed: true },
    ]);
    const scan = scanTranscriptTail(f);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.outcomes.get('a1')?.failed).toBe(false);
    expect(scan.outcomes.get('a2')?.failed).toBe(true);
    // Decoration only — parsed when present, never load-bearing.
    expect(scan.outcomes.get('a2')?.exitCode).toBe(1);
  });

  it('treats a non-boolean is_error as no evidence at all', () => {
    // A host that switched to the string spelling must produce NO outcomes, not
    // a store full of unearned successes.
    const f = path.join(tempRoot(), 't.jsonl');
    for (const flag of ['true', 1, null, {}]) {
      fs.writeFileSync(
        f,
        [
          JSON.stringify({
            timestamp: T0,
            message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x', input: { command: 'npm test' } }] },
          }),
          JSON.stringify({
            timestamp: T0,
            message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: flag, content: 'ok' }] },
          }),
        ].join('\n') + '\n',
      );
      const scan = scanTranscriptTail(f);
      expect(scan.status).toBe('ok');
      if (scan.status !== 'ok') return;
      expect(scan.outcomes.size).toBe(0);
    }
  });

  it('drops a call that has no result yet', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    fs.writeFileSync(
      f,
      `${JSON.stringify({ timestamp: T0, message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x', input: { command: 'npm test' } }] } })}\n`,
    );
    const scan = scanTranscriptTail(f);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.outcomes.size).toBe(0);
  });

  it('skips one malformed line and keeps the batch', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'a1', command: 'npm test' }]);
    fs.appendFileSync(f, '{"torn": \n');
    const scan = scanTranscriptTail(f);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.outcomes.size).toBe(1);
  });

  it('reports unparseable when nothing in the file is JSON', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    fs.writeFileSync(f, 'not json at all\nnor this\n');
    expect(scanTranscriptTail(f)).toEqual({ status: 'unavailable', reason: 'unparseable' });
  });

  it('ignores tools that are not the shell tool, even when they carry a command', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'n1', command: 'npm test', tool: 'NotBash' }]);
    const scan = scanTranscriptTail(f);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.outcomes.size).toBe(0);
  });

  it('reads a bounded tail and keeps the NEWEST lines', () => {
    // A cap that kept the first N lines of a tail scan would discard the newest
    // calls and preserve the stalest — backwards for a reader built for recency.
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(
      f,
      Array.from({ length: 6 }, (_, i) => ({ id: `id${i}`, command: `npm run build ${i}` })),
    );
    const scan = scanTranscriptTail(f, { maxLines: 4 });
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    const kept = [...scan.outcomes.keys()];
    expect(kept).toContain('id5');
    expect(kept).not.toContain('id0');
  });

  it('truncation loses evidence, never gains it', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'a1', command: 'npm test' }]);
    const scan = scanTranscriptTail(f, { maxBytes: 40 });
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.truncated).toBe(true);
    expect(scan.outcomes.size).toBe(0);
  });
});

describe('outcomesByCommand', () => {
  it('indexes by command text', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'a1', command: 'npm test', failed: true }]);
    const byCommand = outcomesByCommand(scanTranscriptTail(f));
    const entry = byCommand.get('npm test');
    expect(entry).not.toBe('ambiguous');
    expect(entry !== 'ambiguous' && entry?.failed).toBe(true);
  });

  it('marks CONFLICTING outcomes for one command as ambiguous rather than guessing', () => {
    // The spool line carries no tool_use_id, so pairing is by text. Two runs of
    // the same text with different results cannot be told apart, and guessing
    // which one a spool line belongs to is exactly the inference this avoids.
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [
      { id: 'a1', command: 'npm test' },
      { id: 'a2', command: 'npm test', failed: true },
    ]);
    expect(outcomesByCommand(scanTranscriptTail(f)).get('npm test')).toBe('ambiguous');
  });

  it('collapses identical outcomes for identical text', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [
      { id: 'a1', command: 'npm test' },
      { id: 'a2', command: 'npm test' },
    ]);
    const entry = outcomesByCommand(scanTranscriptTail(f)).get('npm test');
    // `not.toBe('ambiguous')` alone is satisfied by `undefined`, so an
    // implementation that produced nothing at all would pass it. Assert the
    // surviving entry and its outcome.
    expect(entry).toBeDefined();
    expect(entry !== 'ambiguous' && entry?.failed).toBe(false);
  });

  it('yields an empty map for every unavailable scan', () => {
    for (const reason of ['no-path', 'missing', 'unreadable', 'unparseable'] as const) {
      const scan: TranscriptScan = { status: 'unavailable', reason };
      expect(outcomesByCommand(scan).size).toBe(0);
    }
  });
});

// ── End to end through the flush ─────────────────────────────────────

describe('command outcomes through flushSpool', () => {
  it('attaches the exit code the hook could not carry', () => {
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npx vitest run' }]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npx vitest run' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const runs = commandRuns(fx);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.exit_code).toBe(0);
  });

  it('records nothing extra when there is no transcript', () => {
    // The state this feature replaces: 4,881 command runs, 2 exit codes.
    const fx = fixture();
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npx vitest run' });
    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: null });
    expect(commandRuns(fx)[0]?.exit_code).toBeNull();
  });

  it('attaches nothing when the window is ambiguous about a command', () => {
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [
      { id: 'a1', command: 'npm test' },
      { id: 'a2', command: 'npm test', failed: true },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm test' });
    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });
    expect(commandRuns(fx)[0]?.exit_code).toBeNull();
  });

  it('records a FAILED command that fired no hook at all', () => {
    // The half no hook can see: a host-failed command writes no spool line, so
    // before this it was invisible to Cortex entirely.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    const now = new Date().toISOString();
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build', ts: now },
      { id: 'a2', command: 'npx vitest run', failed: true, ts: now },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const runs = commandRuns(fx);
    const failed = runs.find(r => r.command_summary?.includes('vitest'));
    expect(failed).toBeDefined();
    expect(failed?.exit_code).toBe(1);
  });

  it('finally writes the command_failure episode that had never once fired', () => {
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    const now = new Date().toISOString();
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build', ts: now },
      { id: 'a2', command: 'npm test', failed: true, ts: now },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    expect(episodeKinds(fx)).toContain('command_failure');
  });

  it('an npx-prefixed failure is RECORDED but produces no episode — a stated gap', () => {
    // `classifyCommand` maps every `npx …` to the generic `npm` category, and
    // `writeCommandEpisodes` only writes for test/build/git. So `npx vitest run`
    // and `npx tsc --noEmit` — this project's actual verification commands —
    // get an exit code and a command_run, but no episode.
    //
    // Pinned rather than fixed: widening the classifier changes episode text and
    // the consolidation path for every existing caller, which is a different
    // change from this one, and `tests/redact.test.ts:23` deliberately asserts
    // the current mapping. Recorded in deferred-work.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    const now = new Date().toISOString();
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build', ts: now },
      { id: 'a2', command: 'npx vitest run', failed: true, ts: now },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const failed = commandRuns(fx).find(r => r.command_summary?.includes('vitest'));
    expect(failed?.exit_code).toBe(1);
    expect(episodeKinds(fx)).not.toContain('command_failure');
  });

  it('captures the output tail of a failed build, which was also dead', () => {
    // `shouldCaptureOutputTail` requires a non-zero exit code, so with no exit
    // codes ever arriving, zero tails were ever stored.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npm run build' , failed: true }]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build', stdout: 'boom\nfailed\n' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const runs = commandRuns(fx);
    expect(runs[0]?.exit_code).toBe(1);
    expect(runs[0]?.stdout_tail).toContain('failed');
  });

  it('never synthesizes a SUCCESS — only failures the hook could not report', () => {
    // A successful command already has a spool line. Inventing rows for
    // commands outside this session's capture would describe work Cortex never
    // observed.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    const now = new Date().toISOString();
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build', ts: now },
      { id: 'a2', command: 'npm run lint', ts: now },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const runs = commandRuns(fx);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command_summary).toContain('build');
  });

  it('synthesizes each failure exactly ONCE, however many times the spool is flushed', () => {
    // The tail spans many turns, so a failure stays visible long after it was
    // recorded. An earlier design bounded this by timestamp instead, and all
    // three review layers reproduced it writing one failure as two rows or
    // more. Identity, not a window: the host's own `tool_use_id` is remembered.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npx vitest run', failed: true }]);

    for (let i = 0; i < 3; i++) {
      appendSpoolEntry(fx.root, { tool: 'cmd', cmd: `npm run build ${i}` });
      flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });
    }

    const failures = commandRuns(fx).filter(r => r.command_summary?.includes('vitest'));
    expect(failures).toHaveLength(1);
  });

  it('synthesizes ONCE when an orphan claim and a fresh spool flush together', () => {
    // `flushSpool` consumes an orphaned `.processing` claim AND the live spool
    // in one call. Synthesis used to run per claim file against the same
    // outcomes, so one failure became two rows in a single flush. Orphan claims
    // are ordinary here — the claim unlink is best-effort and `end-of-turn`
    // overlaps `inject-header`.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npm test', failed: true }]);

    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'git status' });
    fs.renameSync(
      path.join(fx.root, '.cortex.spool.jsonl'),
      path.join(fx.root, '.cortex.spool.jsonl.processing'),
    );
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'git diff' });

    const result = flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    expect(commandRuns(fx).filter(r => r.command_summary?.includes('npm test'))).toHaveLength(1);
    expect(result.synthesized).toBe(1);
  });

  it('records THREE genuine failures of one command as three rows', () => {
    // The text-keyed map collapses them — correctly, because a spool line has
    // no id to match on. Synthesis has no spool line to match, so it keys off
    // the id the host already assigned and keeps all three.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [
      { id: 'a1', command: 'npm test', failed: true },
      { id: 'a2', command: 'npm test', failed: true },
      { id: 'a3', command: 'npm test', failed: true },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'git status' });

    const result = flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    expect(commandRuns(fx).filter(r => r.command_summary?.includes('npm test'))).toHaveLength(3);
    expect(result.synthesized).toBe(3);
  });

  it('bounds one flush to SYNTH_PER_FLUSH_MAX and reports what it wrote', () => {
    // Every synthesized row is an INSERT inside a write transaction; an
    // unbounded loop over a pathological tail held the write lock for seconds.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(
      t,
      Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, command: `fail-${i}`, failed: true })),
    );
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'git status' });

    const result = flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    expect(result.synthesized).toBe(50);
    expect(commandRuns(fx).filter(r => r.command_summary?.startsWith('fail-'))).toHaveLength(50);
    // Newest kept, oldest dropped — a resumed session needs the recent ones.
    const kept = commandRuns(fx).map(r => r.command_summary);
    expect(kept).toContain('fail-119');
    expect(kept).not.toContain('fail-0');
  });

  it('never breaks the turn when the transcript scan throws', () => {
    const fx = fixture();
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });
    expect(() =>
      flushSpool(fx.store, fx.root, fx.sessionId, undefined, {
        transcriptPath: 'anything',
        scanTranscript: () => {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
    expect(commandRuns(fx)).toHaveLength(1);
  });

  it('redacts a secret in a synthesized failure, like every other command path', () => {
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    const now = new Date().toISOString();
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build', ts: now },
      { id: 'a2', command: 'curl --token=ghp_abcdefghijklmnop x', failed: true, ts: now },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    const result = flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    // Assert the row EXISTS before asserting what it lacks. "The token is
    // absent" is trivially true of a store where synthesis wrote nothing, so
    // the absence assertion alone passed with the whole feature switched off.
    expect(result.synthesized).toBe(1);
    const synthesized = commandRuns(fx).find(r => r.command_summary?.includes('curl'));
    expect(synthesized).toBeDefined();
    expect(synthesized?.command_summary).toContain('[REDACTED]');
    expect(synthesized?.command_summary).not.toContain('ghp_abcdefghijklmnop');
  });
});

// ── Outcomes that must never be recorded ─────────────────────────────

describe('what is refused', () => {
  it('records NOTHING for a command the host refused to run', () => {
    // `is_error: true` is not the same question as "did this command fail".
    // Measured over all 45 transcripts on this machine — 6,456 paired Bash
    // calls, 130 failures — 5 carry no `Exit code N` line and every one of the
    // five never executed: three `Blocked:`, one `InputValidationError`, and
    // one the USER EXPLICITLY DENIED. Recording those as failed runs would
    // fabricate an execution, and the denial case would record a command the
    // user refused to allow.
    const refusals = [
      '<tool_use_error>Blocked: sleep 60 followed by: cat /etc/hosts</tool_use_error>',
      '<tool_use_error>InputValidationError: command contains control characters</tool_use_error>',
      "The user doesn't want to proceed with this tool use. The tool use was rejected",
    ];
    for (const content of refusals) {
      const f = path.join(tempRoot(), 't.jsonl');
      writeTranscript(f, [{ id: 'a1', command: 'git push --force origin main', failed: true, content }]);
      const scan = scanTranscriptTail(f);
      expect(scan.status).toBe('ok');
      if (scan.status !== 'ok') return;
      expect(scan.outcomes.size).toBe(0);
    }
  });

  it('still records a real failure, which always carries its exit line', () => {
    // The gate costs nothing real: 125 of the 130 measured failures carry it.
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'a1', command: 'npm test', failed: true, content: 'Error: Exit code 7\nboom' }]);
    const scan = scanTranscriptTail(f);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.outcomes.get('a1')?.exitCode).toBe(7);
  });

  it('never attaches an outcome to a BACKGROUNDED launch', () => {
    // PostToolUse fires at LAUNCH for a backgrounded command and the host's own
    // result for the launch is a success. So a backgrounded `npm test` stored
    // `exit 0` — which is exactly the gate `writeCommandEpisodes` reads to emit
    // a `test_cycle`, i.e. "tests passed", for a process that had not finished.
    // That is the worst thing this product can say.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npm test' }]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm test', bg: 1 });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    expect(commandRuns(fx)[0]?.exit_code).toBeNull();
    expect(episodeKinds(fx)).not.toContain('test_cycle');
  });

  it('never stamps the primary transcript verdict onto a SUBAGENT command', () => {
    // A subagent's turns are written to its own transcript (measured: 0
    // sidechain entries in 2,733 real Bash calls), so its runs are invisible
    // here and the `ambiguous` guard cannot fire. Without this, a subagent's
    // successful `npm run build` inherits the parent's failure. The same defeat
    // applies to a second window on the same directory: shared spool file,
    // separate transcripts.
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [{ id: 'a1', command: 'npm run build', failed: true }]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build', agent_id: 'sub-7' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const runs = commandRuns(fx);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.exit_code).toBeNull();
  });

  it('treats a directory as unreadable rather than as an empty transcript', () => {
    // A directory reports size 0 on win32 and would otherwise scan as a
    // perfectly healthy transcript containing nothing.
    expect(scanTranscriptTail(tempRoot())).toEqual({ status: 'unavailable', reason: 'unreadable' });
  });
});

// ── Saying what it saw ───────────────────────────────────────────────

describe('observability', () => {
  it('records what the last scan saw, so a dead scan cannot look like a quiet one', () => {
    const fx = fixture();
    const t = path.join(fx.root, 'transcript.jsonl');
    writeTranscript(t, [
      { id: 'a1', command: 'npm run build' },
      { id: 'a2', command: 'npm test', failed: true },
    ]);
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });

    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: t });

    const status = fx.store.getMeta(SCAN_STATUS_KEY);
    expect(status).toBeDefined();
    expect(status).toContain('ok outcomes=2 failures=1 truncated=no');
    expect(status).toContain('synthesized=1');
  });

  it('distinguishes an ABSENT transcript from a quiet one', () => {
    const fx = fixture();
    appendSpoolEntry(fx.root, { tool: 'cmd', cmd: 'npm run build' });
    flushSpool(fx.store, fx.root, fx.sessionId, undefined, { transcriptPath: null });
    expect(fx.store.getMeta(SCAN_STATUS_KEY)).toContain('unavailable:no-path');
  });

  it('reports truncation, which otherwise looks like a complete scan', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [{ id: 'a1', command: 'npm test' }]);
    expect(describeScan(scanTranscriptTail(f, { maxBytes: 40 }))).toContain('truncated=yes');
  });

  it('failedOutcomes keeps only failures, in transcript order', () => {
    const f = path.join(tempRoot(), 't.jsonl');
    writeTranscript(f, [
      { id: 'a1', command: 'one', failed: true },
      { id: 'a2', command: 'two' },
      { id: 'a3', command: 'three', failed: true },
    ]);
    expect(failedOutcomes(scanTranscriptTail(f)).map(o => o.command)).toEqual(['one', 'three']);
    expect(failedOutcomes({ status: 'unavailable', reason: 'missing' })).toEqual([]);
  });
});
