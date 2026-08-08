import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { findPosixTool } from './posix-tools.js';
import {
  SUBSTITUTION_FLAG_FILENAME,
  TURN_READS_FILENAME,
  HOT_PATH_STATE_KEYS,
} from '../src/capture/substitution.js';
import { escapeIndexField, formatIndexLine } from '../src/capture/digest-index.js';
import { normalizeFilePathKey, normalizeScopePath, toScopeRelativeKey } from '../src/scope/keys.js';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { appendSpoolEntry, flushSpool } from '../src/capture/spool.js';

/**
 * Verified read substitution, executed through the REAL hook (FR-6, Story 4.5).
 *
 * Nothing else can verify it: the decision lives entirely in bash + jq, so
 * `tsc` sees none of it, and every failure mode here is silent by design — the
 * hook exits 0 and the agent simply gets the file. A JavaScript reimplementation
 * of the gate would prove the gate is implementable in JavaScript.
 */

const SCRIPT = path.resolve(__dirname, '..', 'hooks', 'claude', 'cortex-capture.sh');
const BASH = findPosixTool('bash');

function hasTool(tool: string): boolean {
  if (BASH === null) return false;
  try {
    childProcess.execFileSync(BASH, ['-lc', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = BASH !== null && hasTool('jq') && hasTool('sha256sum');

if (!canRun) {
  process.stderr.write(
    '\n[substitution-hook] SKIPPED: bash, jq and sha256sum are required.\n' +
      '[substitution-hook] The FR-6 substitution path is UNVERIFIED in this run.\n\n',
  );
}

const SESSION = 'sess-primary-1';

/**
 * The fold the COLD path publishes on THIS platform — the same predicate
 * `renderHotPathStateLines` uses, already asserted against it in
 * `tests/substitution.test.ts` and `tests/cli.test.ts`.
 *
 * Hardcoding `'lower'` here pinned Windows/macOS semantics onto fixtures whose
 * index records come from the real, platform-conditional `toScopeRelativeKey`.
 * On linux the writer leaves `Module.TS` exact while the hook was told to fold,
 * so every mixed-case lookup missed: green on the maintainer's Windows box,
 * red on ubuntu, and invisible for two weeks because every other fixture path
 * in this file is already all-lowercase and folding is the identity on those.
 *
 * Re-derived rather than imported: the shell and the cold path AGREEING is what
 * is under test, and a fixture that asks the writer what it thinks the answer
 * is can only watch the two agree on the wrong answer together.
 */
const PATH_FOLD: 'lower' | 'none' =
  process.platform === 'win32' || process.platform === 'darwin' ? 'lower' : 'none';

/** `Module.TS` and `module.ts` are ONE file here, and TWO files elsewhere. */
const CASE_INSENSITIVE_FS = PATH_FOLD === 'lower';

interface Fixture {
  cwd: string;
  posixCwd: string;
  scopeKey: string;
  filePath: string;
  storedKey: string;
  bytes: number;
  sha: string;
}

interface FixtureOptions {
  /** File body; defaults to a comfortably-above-the-floor blob. */
  body?: string;
  /** Written with CRLF, to pin the F1 finding. */
  crlf?: boolean;
  enabled?: boolean;
  /** Overrides for the index record, applied after the truthful defaults. */
  record?: Partial<{ sha256: string | null; byteSize: number; sessionId: string; agentId: string | null }>;
  /** Omit named keys from `.cortex.state`. */
  omitStateKeys?: string[];
  relPath?: string;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subst-hook-')));
  const posixCwd = cwd.replace(/\\/g, '/');
  const scopeKey = `branch:${posixCwd.toLowerCase()}/.git:${posixCwd.toLowerCase()}:main`;

  const rel = options.relPath ?? 'src/module.ts';
  const filePath = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = options.body ?? `${'const x = 1;\n'.repeat(400)}`;
  const written = options.crlf ? body.replace(/\n/g, '\r\n') : body;
  fs.writeFileSync(filePath, written, { encoding: 'utf8' });

  const raw = fs.readFileSync(filePath);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const storedKey = toScopeRelativeKey(filePath, cwd);

  const stateLines: Record<string, string> = {
    enabled: 'true',
    [HOT_PATH_STATE_KEYS.sessionId]: SESSION,
    [HOT_PATH_STATE_KEYS.indexScope]: escapeIndexField(scopeKey),
    [HOT_PATH_STATE_KEYS.scopeRoot]: normalizeFilePathKey(cwd),
    [HOT_PATH_STATE_KEYS.pathFold]: PATH_FOLD,
  };
  for (const key of options.omitStateKeys ?? []) delete stateLines[key];
  fs.writeFileSync(
    path.join(cwd, '.cortex.state'),
    `${Object.entries(stateLines)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  );

  fs.writeFileSync(
    path.join(cwd, '.cortex.index'),
    `${formatIndexLine({
      scopeKey,
      path: storedKey,
      sha256: options.record?.sha256 !== undefined ? options.record.sha256 : sha,
      byteSize: options.record?.byteSize ?? raw.length,
      sessionId: options.record?.sessionId ?? SESSION,
      agentId: options.record?.agentId !== undefined ? options.record.agentId : null,
    })}\n`,
  );

  if (options.enabled !== false) {
    fs.writeFileSync(path.join(cwd, SUBSTITUTION_FLAG_FILENAME), 'on\n');
  }

  return { cwd, posixCwd, scopeKey, filePath, storedKey, bytes: raw.length, sha };
}

interface HookRun {
  stdout: string;
  stderr: string;
  spool: Array<Record<string, unknown>>;
  substituted: boolean;
  /** How many times the hook actually invoked `sha256sum`; see `installHashShim`. */
  hashCalls: number;
}

/**
 * A `sha256sum` shim earlier on `PATH` that records each invocation and then
 * delegates to the real one.
 *
 * The hot path's cost is its process count, and "did not spawn" is not
 * observable from stdout: every guard that skips the hash produces the same
 * *verdict* as one that hashes and then rejects the result. A mutation removing
 * the oversize guard survived the whole suite for exactly that reason — the
 * record can never verify either way, so the only difference is a wasted hash of
 * a file over 2 MiB on a path that runs for every `Read`. This makes the
 * difference assertable.
 */
/** `C:\a\b` → `/c/a/b`, the form Git Bash resolves on `PATH`. */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

function installHashShim(cwd: string): { shimDir: string; logPath: string } {
  const shimDir = path.join(cwd, '.shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const logPath = path.join(cwd, '.hash-calls');
  fs.writeFileSync(
    path.join(shimDir, 'sha256sum'),
    '#!/bin/bash\nprintf \'call\\n\' >> "$CORTEX_TEST_HASH_LOG"\nexec /usr/bin/sha256sum "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  return { shimDir, logPath };
}

/** Drive the hook with a fully caller-controlled payload object. */
function runRaw(
  fx: Fixture,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): HookRun {
  const shim = installHashShim(fx.cwd);
  // PATH is prepended INSIDE the shell, not in the spawn env. `Git/bin/bash.exe`
  // is the wrapper that rebuilds a POSIX `PATH` before handing control over, so
  // an inherited entry lands *after* `/usr/bin` and the real `sha256sum` wins —
  // measured: the shim was never invoked and the hit-path assertion read 0.
  const result = childProcess.spawnSync(
    BASH as string,
    ['-c', 'PATH="$CORTEX_TEST_SHIM:$PATH"; exec bash "$CORTEX_TEST_SCRIPT"'],
    {
      input: JSON.stringify({ cwd: fx.posixCwd, hook_event_name: 'PostToolUse', ...payload }),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        CORTEX_TEST_SHIM: toPosixPath(shim.shimDir),
        CORTEX_TEST_SCRIPT: toPosixPath(SCRIPT),
        CORTEX_TEST_HASH_LOG: toPosixPath(shim.logPath),
      },
    },
  );
  return finishRun(fx, shim, result);
}

function runRead(
  fx: Fixture,
  overrides: Record<string, unknown> = {},
  toolInput: Record<string, unknown> = {},
  responseFile: Record<string, unknown> | null | undefined = undefined,
  extraEnv: Record<string, string> = {},
): HookRun {
  const content = fs.readFileSync(fx.filePath, 'utf8');
  const totalLines = content.split('\n').length;
  const file =
    responseFile === null
      ? undefined
      : {
          filePath: fx.filePath,
          content,
          numLines: totalLines,
          startLine: 1,
          totalLines,
          ...(responseFile ?? {}),
        };

  return runRaw(
    fx,
    {
      session_id: 'cc-session',
      tool_name: 'Read',
      tool_input: { file_path: fx.filePath, ...toolInput },
      tool_response: file === undefined ? { type: 'text' } : { type: 'text', file },
      ...overrides,
    },
    extraEnv,
  );
}

function finishRun(
  fx: Fixture,
  shim: { shimDir: string; logPath: string },
  result: childProcess.SpawnSyncReturns<string>,
): HookRun {
  const hashCalls = fs.existsSync(shim.logPath)
    ? fs.readFileSync(shim.logPath, 'utf8').split('\n').filter(Boolean).length
    : 0;

  const spoolPath = path.join(fx.cwd, '.cortex.spool.jsonl');
  const raw = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8') : '';
  const spool = raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spool,
    substituted: (result.stdout ?? '').includes('updatedToolOutput'),
    hashCalls,
  };
}

function parsePayload(stdout: string): Record<string, any> {
  return JSON.parse(stdout.trim()) as Record<string, any>;
}

// ── AC #1: the happy path, and the shape the host actually honours ────

describe.skipIf(!canRun)('substitution: verified hit (AC #1, AC #3)', () => {
  it('substitutes a re-read whose file still hashes to the recorded digest', () => {
    const fx = makeFixture();
    const run = runRead(fx);

    expect(run.substituted).toBe(true);
    expect(run.stderr).toBe('');

    const payload = parsePayload(run.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse');

    // The envelope MIRRORS the tool's own result object. Measured with two
    // probes against the installed hook: the documented `{content:[…]}` form is
    // accepted and silently ignored, so asserting merely "JSON was printed"
    // would pass against a payload the host discards.
    const updated = payload.hookSpecificOutput.updatedToolOutput;
    expect(Object.keys(updated).sort()).toEqual(['file', 'type']);
    expect(updated.content).toBeUndefined();
    expect(typeof updated.file.content).toBe('string');
  });

  it('names itself, names the file, states the cost, and states the way back', () => {
    const fx = makeFixture();
    const text = parsePayload(runRead(fx).stdout).hookSpecificOutput.updatedToolOutput.file.content;

    expect(text).toContain('[cortex] substituted:');
    expect(text).toContain(fx.storedKey);
    // The token figure is the same ceil(bytes/4) the ledger books, so the
    // number shown and the number credited cannot diverge.
    expect(text).toContain(`~${Math.ceil(fx.bytes / 4)} tokens`);
    // AC #4 is the escape hatch; a payload that does not say so strands the
    // agent with a summary it did not ask for.
    expect(text).toMatch(/[Rr]ead it again/);
  });

  it('substitutes a CRLF file — the case a payload-content hash could never match', () => {
    // F1, pinned. Claude Code normalises CRLF to LF in `tool_response`, so
    // hashing the returned text can never reproduce a digest taken over the
    // file's bytes. A fixture set of LF-only files cannot see this at all, and
    // this repository ships CRLF files on the reference platform.
    const fx = makeFixture({ crlf: true });
    expect(fs.readFileSync(fx.filePath).includes(Buffer.from('\r\n'))).toBe(true);
    expect(runRead(fx).substituted).toBe(true);
  });

  it('books exactly one credit line carrying its own evidence (AD-15)', () => {
    const fx = makeFixture();
    const run = runRead(fx);

    const credits = run.spool.filter(line => line['tool'] === 'credit');
    expect(credits).toHaveLength(1);
    const credit = credits[0]!;
    expect(credit['credit_kind']).toBe('read');
    expect(credit['credit_ref']).toBe(fx.storedKey);
    expect(Number(credit['credit_size'])).toBe(fx.bytes);
    // `assertCreditIsEvidenced` caps tokens at ceil(size/4) and THROWS above
    // it — a credit that overclaims is dropped on the floor by the flush, so
    // the ceiling is a shipping constraint, not a nicety.
    expect(Number(credit['credit_tokens'])).toBeLessThanOrEqual(Math.ceil(fx.bytes / 4));
    expect(Number(credit['credit_tokens'])).toBeGreaterThan(0);
  });

  it('marks the read line so the flush does not book a false unrealized decline', () => {
    const fx = makeFixture();
    const reads = runRead(fx).spool.filter(line => line['tool'] === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]!['subst']).toBe(1);
  });
});

// ── AC #2 / AD-6 / AD-16: every reason to pass through ───────────────

describe.skipIf(!canRun)('substitution: passthrough (AC #2, AD-6, AD-16)', () => {
  it('passes through when the file changed since the record', () => {
    const fx = makeFixture();
    // Same byte length, different content: the miss must come from the HASH,
    // not from a size comparison that would be cheaper and wrong.
    const original = fs.readFileSync(fx.filePath);
    const mutated = Buffer.from(original);
    mutated[0] = original[0] === 0x63 ? 0x64 : 0x63;
    fs.writeFileSync(fx.filePath, mutated);
    expect(fs.statSync(fx.filePath).size).toBe(fx.bytes);

    expect(runRead(fx).substituted).toBe(false);
  });

  it('passes through for an oversize record WITHOUT hashing it (AC #2)', () => {
    // Both halves are the assertion. Every guard that skips the hash produces
    // the same verdict as one that hashes and then rejects, so a mutation
    // removing this guard survived a verdict-only test — while costing a
    // pointless hash of a file over 2 MiB on the path that runs for every read.
    const run = runRead(makeFixture({ record: { sha256: null } }));
    expect(run.substituted).toBe(false);
    expect(run.hashCalls).toBe(0);
  });

  it('never hashes on the miss path — the unconditional tax stays one process', () => {
    // B-4a's miss budget, asserted behaviorally rather than by reading the
    // source: the file is not in the index, so nothing may be hashed.
    const fx = makeFixture();
    fs.rmSync(path.join(fx.cwd, '.cortex.index'));
    expect(runRead(fx).hashCalls).toBe(0);
  });

  it('hashes exactly once on a verified hit', () => {
    expect(runRead(makeFixture()).hashCalls).toBe(1);
  });

  it('passes through when the recorder is a different session', () => {
    const fx = makeFixture({ record: { sessionId: 'sess-someone-else' } });
    expect(runRead(fx).substituted).toBe(false);
  });

  it('passes through when the recorder was a subagent — even the requesting one', () => {
    // AD-16 in its narrowest provable form (story F2). A subagent's own earlier
    // read is recorded under a child session that does not exist while this
    // hook runs, so it cannot be proven to be the requester. Pinned so a later
    // widening is a deliberate change rather than an accident.
    const fx = makeFixture({ record: { agentId: 'agent-7' } });
    expect(runRead(fx, { agent_id: 'agent-7', agent_type: 'Explore' }).substituted).toBe(false);
  });

  it('passes through when the state file lacks the published session id', () => {
    const fx = makeFixture({ omitStateKeys: [HOT_PATH_STATE_KEYS.sessionId] });
    expect(runRead(fx).substituted).toBe(false);
  });

  it('passes through when the state file lacks the scope root', () => {
    const fx = makeFixture({ omitStateKeys: [HOT_PATH_STATE_KEYS.scopeRoot] });
    expect(runRead(fx).substituted).toBe(false);
  });

  it('passes through when the index is missing, and writes nothing to stderr', () => {
    const fx = makeFixture();
    fs.rmSync(path.join(fx.cwd, '.cortex.index'));
    const run = runRead(fx);
    expect(run.substituted).toBe(false);
    // An unredirected grep would complain on EVERY read of a project that has
    // never flushed.
    expect(run.stderr).toBe('');
  });

  it('passes through a partial read even when the digest matches', () => {
    const fx = makeFixture();
    // The agent holds a slice; the digest describes the whole file. Telling it
    // otherwise is exactly the false-confidence AD-6 forbids.
    expect(runRead(fx, {}, { offset: 10, limit: 5 }, { startLine: 10, numLines: 5 }).substituted).toBe(
      false,
    );
  });

  it('passes through a truncated full-file read (no offset, but not all lines)', () => {
    // `Read` truncates at 2000 lines with NO `offset` in tool_input, so gating
    // on tool_input alone would substitute here and claim the agent holds a
    // file it has two fifths of.
    const fx = makeFixture();
    expect(runRead(fx, {}, {}, { numLines: 2000, totalLines: 5000 }).substituted).toBe(false);
  });

  it('passes through when the response carries no file object at all', () => {
    const fx = makeFixture();
    expect(runRead(fx, {}, {}, null).substituted).toBe(false);
  });

  it('passes through a file below the size floor', () => {
    const fx = makeFixture({ body: 'tiny\n' });
    expect(runRead(fx).substituted).toBe(false);
  });

  it('passes through a non-numeric byte size rather than erroring', () => {
    const fx = makeFixture();
    const indexPath = path.join(fx.cwd, '.cortex.index');
    fs.writeFileSync(
      indexPath,
      fs.readFileSync(indexPath, 'utf8').replace(`\t${fx.bytes}\t`, '\tnot-a-number\t'),
    );
    const run = runRead(fx);
    expect(run.substituted).toBe(false);
    expect(run.stderr).toBe('');
  });

  it('never substitutes while the flag file is absent (AC #6)', () => {
    const fx = makeFixture({ enabled: false });
    const run = runRead(fx);
    // Asserted as exact emptiness, not as "no substitution marker": a payload
    // in the wrong shape would satisfy the weaker form.
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    // Capture is unaffected — the read is still spooled.
    expect(run.spool.filter(l => l['tool'] === 'read')).toHaveLength(1);
  });

  it('never substitutes while the project is disengaged', () => {
    const fx = makeFixture();
    fs.writeFileSync(path.join(fx.cwd, '.cortex.state'), 'enabled=false\n');
    const run = runRead(fx);
    expect(run.stdout).toBe('');
    expect(run.spool).toHaveLength(0);
  });
});

// ── AC #4: the escape hatch ──────────────────────────────────────────

describe.skipIf(!canRun)('substitution: second read in one turn (AC #4)', () => {
  it('substitutes the first read and passes the second through', () => {
    const fx = makeFixture();
    expect(runRead(fx).substituted).toBe(true);
    const second = runRead(fx);
    expect(second.substituted).toBe(false);
    expect(second.stdout).toBe('');
  });

  it('substitutes again once the turn marker is cleared', () => {
    const fx = makeFixture();
    expect(runRead(fx).substituted).toBe(true);
    // What `cortex-end-of-turn.sh` does at Stop.
    fs.rmSync(path.join(fx.cwd, TURN_READS_FILENAME));
    expect(runRead(fx).substituted).toBe(true);
  });

  it('suppresses a full read that follows a partial read of the same file', () => {
    // The literal AC: "read a second time within one turn". The partial read
    // does not substitute, but it still marks the file — otherwise the full
    // read that follows would be the turn's first substitution of a file the
    // agent has already touched.
    const fx = makeFixture();
    expect(runRead(fx, {}, { offset: 5 }, { startLine: 5, numLines: 5 }).substituted).toBe(false);
    expect(runRead(fx).substituted).toBe(false);
  });
});

// ── Key derivation: bash must agree with the TypeScript writer ───────

describe.skipIf(!canRun)('substitution: the shell finds what the cold path wrote', () => {
  // Bash-versus-bash proves only that the reimplementation is self-consistent.
  // These seed the record through `formatIndexLine`/`toScopeRelativeKey` — the
  // real writers — and require the SHELL to find it. Each transformation these
  // cover fails silently as a false "unread" if the two sides drift.
  for (const rel of [
    'src/nested/deep/Module.TS', // mixed case: FOLDED on win32/darwin, EXACT on linux
    'src/one hundred%/mod.ts', // percent escaping
    'src/a-b.c[d]/mod.ts', // regex metacharacters, which is why grep -F is required
    'mod.ts', // scope root itself
  ]) {
    it(`finds the record for ${rel}`, () => {
      const fx = makeFixture({ relPath: rel });
      expect(runRead(fx).substituted).toBe(true);
    });
  }

  it.skipIf(!CASE_INSENSITIVE_FS)(
    'finds it without `${key,,}` too — the fold stock macOS has to fall back to',
    () => {
      // `${key,,}` is bash 4.0+. Stock macOS ships bash 3.2 at `/bin/bash`, and
      // that is the interpreter `cortex install` names: it wires
      // `bash "<script>"`, so the shebang does not decide. Measured on 3.2.57 —
      // the script PARSES (`bash -n` is clean, which is why no syntax gate ever
      // saw it), but reaching the expansion raises `bad substitution`, aborts
      // `try_substitute`, and writes to stderr. Since darwin is the one platform
      // where the cold path publishes `path_fold=lower` unconditionally, the
      // cost was a feature that silently never fired on exactly the machines
      // that always take that branch.
      //
      // No runner has bash 3.2, so the fallback is FORCED rather than waited
      // for. Skipped where `path_fold` is `none`, because there the fold branch
      // is never entered and the flag would prove nothing.
      const fx = makeFixture({ relPath: 'src/nested/deep/Module.TS' });
      expect(runRead(fx, {}, {}, undefined, { CORTEX_FOLD_ASCII: '1' }).substituted).toBe(true);
    },
  );

  it(
    CASE_INSENSITIVE_FS
      ? 'matches a differently-cased record — one file on this filesystem'
      : 'refuses a differently-cased record — a DIFFERENT file on this filesystem',
    () => {
      // The judgement the hot path must not get wrong, asserted in BOTH
      // directions rather than on the platform that happens to run it.
      //
      // `src/Module.TS` and `src/module.ts` are one file on win32/darwin and two
      // files on linux. Folding the lookup unconditionally would hand the agent
      // `module.ts`'s digest for a read of `Module.TS` — reporting a file it has
      // never seen as already in its context, which is the AD-6 false-confidence
      // failure this whole mechanism exists to make unreachable.
      //
      // The hook cannot work this out for itself: it may not spawn Node (N-4)
      // and no bash builtin reports filesystem case sensitivity. It is TOLD, by
      // `path_fold` in `.cortex.state`, which `renderHotPathStateLines` computes
      // from `process.platform` at SessionStart and the hook applies at the one
      // `${key,,}` in the script.
      //
      // Both verdicts are asserted on purpose. Asserting only the one that holds
      // where the suite usually runs is exactly how this arrived.
      const fx = makeFixture({ relPath: 'src/Module.TS' });
      // The record under the CASE-FOLDED key. A no-op on win32/darwin, where
      // `toScopeRelativeKey` folded it already; on linux it is a record for a
      // genuinely different file, which a folding lookup would wrongly find and
      // a correct one must miss.
      fs.writeFileSync(
        path.join(fx.cwd, '.cortex.index'),
        `${formatIndexLine({
          scopeKey: fx.scopeKey,
          path: fx.storedKey.toLowerCase(),
          sha256: fx.sha,
          byteSize: fx.bytes,
          sessionId: SESSION,
          agentId: null,
        })}\n`,
      );
      expect(runRead(fx).substituted).toBe(CASE_INSENSITIVE_FS);
    },
  );

  it('does not match a record belonging to another scope', () => {
    const fx = makeFixture();
    const indexPath = path.join(fx.cwd, '.cortex.index');
    const other = `${fx.scopeKey}-other-branch`;
    // The other branch's record sits FIRST and would match a needle that is not
    // anchored to the scope — and it carries a digest that does not verify, so
    // an unanchored lookup produces a miss rather than a wrong substitution.
    // The assertion is that the correct record is still found past it.
    fs.writeFileSync(
      indexPath,
      `${formatIndexLine({
        scopeKey: other,
        path: fx.storedKey,
        sha256: 'f'.repeat(64),
        byteSize: fx.bytes,
        sessionId: SESSION,
        agentId: null,
      })}\n${fs.readFileSync(indexPath, 'utf8')}`,
    );
    expect(runRead(fx).substituted).toBe(true);
  });

  it('does not match a record whose path merely EXTENDS the read path', () => {
    // The needle's trailing tab is what stops `src/mod.ts` matching
    // `src/mod.tsx` — `indexLookupNeedle` says so and requires `grep -F`.
    //
    // Direction matters, and the first version of this test had it backwards:
    // reading `mod.tsx` with a `mod.ts` record present passes either way,
    // because `…\tsrc/mod.tsx` is not a prefix of `…\tsrc/mod.ts\t`. The
    // discriminating case is the reverse — read `mod.ts` with a `mod.tsx`
    // record sitting EARLIER in the file, where a needle missing its trailing
    // delimiter matches the wrong line first and `-m1` stops there. Caught by
    // the mutation campaign: the original fixture let that mutant survive.
    const fx = makeFixture({ relPath: 'src/mod.ts' });
    const indexPath = path.join(fx.cwd, '.cortex.index');
    fs.writeFileSync(
      indexPath,
      `${formatIndexLine({
        scopeKey: fx.scopeKey,
        path: 'src/mod.tsx',
        sha256: 'e'.repeat(64),
        byteSize: fx.bytes,
        sessionId: SESSION,
        agentId: null,
      })}\n${fs.readFileSync(indexPath, 'utf8')}`,
    );
    expect(runRead(fx).substituted).toBe(true);
  });
});

// ── Review round (2026-08-03): the reproduced defects, pinned ────────

describe.skipIf(!canRun)('substitution: review-round guards', () => {
  it('never substitutes for a SUBAGENT requester, even against an eligible primary record', () => {
    // Review-reproduced (HIGH): the record gates proved the PRIMARY read the
    // file; nothing checked the REQUESTER was the primary, so a subagent with
    // a fresh context was told the content was "already in this session's
    // context". The requester gate is the sufficient half of AD-16.
    const fx = makeFixture();
    const run = runRead(fx, { agent_id: 'sub-42', agent_type: 'Explore' });
    expect(run.substituted).toBe(false);
    expect(run.stdout).toBe('');
    // Capture is intact and attributed: the read line carries the agent id.
    const reads = run.spool.filter(line => line['tool'] === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]!['agent_id']).toBe('sub-42');
  });

  it('a failed append is a miss even when the marker already lists the file', () => {
    // The mutation campaign showed why the append's own exit status matters
    // and the count alone does not: with the marker READ-ONLY and already
    // carrying this file (an earlier read this turn wrote it), the append
    // fails but a count-only gate reads 1 — its own line and the pre-existing
    // one are indistinguishable — and substitutes what is actually the second
    // read of the turn, violating AC #4 exactly where the escape hatch was
    // already spent. "Could not record" must mean "may not substitute",
    // independently of what the marker happens to contain.
    const fx = makeFixture();
    const marker = path.join(fx.cwd, TURN_READS_FILENAME);
    fs.writeFileSync(marker, `${fx.storedKey}\n`);
    fs.chmodSync(marker, 0o444);
    try {
      const run = runRead(fx);
      expect(run.substituted).toBe(false);
      expect(run.stderr).toBe('');
    } finally {
      fs.chmodSync(marker, 0o644);
    }
  });

  it('misses when the turn marker cannot be written — the escape hatch is not optional', () => {
    // Review-reproduced (HIGH): with the marker unwritable (here: a directory)
    // the append failed silently, `seen` stayed 0, and three consecutive reads
    // of one file all substituted — three credits and no way back to the real
    // bytes. If the read cannot be recorded, the recovery AC #4 promises
    // cannot be guaranteed, so nothing may be substituted.
    const fx = makeFixture();
    fs.mkdirSync(path.join(fx.cwd, TURN_READS_FILENAME));
    const first = runRead(fx);
    const second = runRead(fx);
    expect(first.substituted).toBe(false);
    expect(second.substituted).toBe(false);
    expect(first.stderr).toBe('');
  });

  it('at most one of N concurrent identical reads substitutes (AC #4 under races)', async () => {
    // Review-measured (HIGH): check-then-append let 1-3 of 4 concurrent hooks
    // substitute the same file in one turn. Append-then-count makes the bound
    // provable: both lines are in the file after both appends, each scanner
    // runs after its own append, so only the first appender can ever count 1.
    const fx = makeFixture();
    const content = fs.readFileSync(fx.filePath, 'utf8');
    const totalLines = content.split('\n').length;
    const payload = JSON.stringify({
      cwd: fx.posixCwd,
      hook_event_name: 'PostToolUse',
      session_id: 'cc-session',
      tool_name: 'Read',
      tool_input: { file_path: fx.filePath },
      tool_response: {
        type: 'text',
        file: { filePath: fx.filePath, content, numLines: totalLines, startLine: 1, totalLines },
      },
    });

    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<string>(resolve => {
          const child = childProcess.spawn(BASH as string, [SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
          let out = '';
          child.stdout.on('data', chunk => { out += String(chunk); });
          child.on('close', () => resolve(out));
          child.stdin.write(payload);
          child.stdin.end();
        }),
      ),
    );

    const substitutions = runs.filter(out => out.includes('updatedToolOutput')).length;
    expect(substitutions).toBeLessThanOrEqual(1);
  });

  it('misses without hashing when the recorded size disagrees with the disk', () => {
    // Review-measured (MED): the size gates ran on the RECORDED size while the
    // hash ran on the disk, so a 6 KB record pulled a 300 MB file into ~1.3 s
    // of hashing on a path that could only miss — the FR-7 cost-scales-with-
    // bytes defect on a hotter path. A mismatched size also proves the bytes
    // cannot match, so nothing true is ever skipped.
    const fx = makeFixture({ record: { byteSize: 5200 + 100 } });
    const run = runRead(fx);
    expect(run.substituted).toBe(false);
    expect(run.hashCalls).toBe(0);
  });

  it('carries the REAL path in the payload and the credit, not the index encoding', () => {
    // Review-measured (MED): a `%` in the path reached the agent and the
    // ledger as `%25` — the payload named a file that does not exist, and
    // `credit_ref` stopped joining back to `content_digests.path`.
    const fx = makeFixture({ relPath: 'src/100%done/mod.ts' });
    const run = runRead(fx);
    expect(run.substituted).toBe(true);

    const text = parsePayload(run.stdout).hookSpecificOutput.updatedToolOutput.file.content;
    expect(text).toContain('src/100%done/mod.ts');
    expect(text).not.toContain('%25');

    const credit = run.spool.find(line => line['tool'] === 'credit')!;
    expect(credit['credit_ref']).toBe(fx.storedKey);
    expect(String(credit['credit_ref'])).not.toContain('%25');
  });

  it('mirrors the requested absolute path in filePath, not the index key', () => {
    // The host maintains per-path read-state from the Read result (the guard
    // that gates Edit); handing it a scope-relative name it never requested is
    // unspecified behaviour on that path.
    const fx = makeFixture();
    const payload = parsePayload(runRead(fx).stdout);
    expect(payload.hookSpecificOutput.updatedToolOutput.file.filePath).toBe(fx.filePath);
  });

  it('keeps capturing when tool_response is not an object', () => {
    // Review-reproduced (MED): six payload shapes aborted the branch jq with
    // "Cannot index", and the read vanished from capture entirely — a capture
    // regression, since the pre-4.5 branch never indexed tool_response.
    for (const toolResponse of ['oops', ['a'], 7, true, { file: 'nope' }, { file: [1] }]) {
      const fx = makeFixture();
      const run = runRaw(fx, {
        session_id: 'cc-session',
        tool_name: 'Read',
        tool_input: { file_path: fx.filePath },
        tool_response: toolResponse,
      });
      expect(
        run.spool.filter(line => line['tool'] === 'read'),
        `tool_response=${JSON.stringify(toolResponse)} must still be captured`,
      ).toHaveLength(1);
      expect(run.substituted).toBe(false);
      expect(run.stderr).toBe('');
    }
  });

  it('refuses a substitution whose credit is not positive — a stub for a tiny file is a net loss', () => {
    const fx = makeFixture({ body: 'x'.repeat(120) });
    fs.writeFileSync(
      path.join(fx.cwd, '.cortex.index'),
      `${formatIndexLine({
        scopeKey: fx.scopeKey,
        path: fx.storedKey,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(fx.filePath)).digest('hex'),
        byteSize: 120,
        sessionId: SESSION,
        agentId: null,
      })}\n`,
    );
    const run = runRead(fx, {}, {}, undefined, { CORTEX_SUBST_MIN_BYTES: '0' });
    expect(run.substituted).toBe(false);
    expect(run.stdout).toBe('');
  });

  it('treats numLines 0 == totalLines 0 as not-a-full-read', () => {
    const fx = makeFixture();
    expect(runRead(fx, {}, {}, { numLines: 0, totalLines: 0 }).substituted).toBe(false);
  });

  it('misses silently on a size bash cannot compare', () => {
    // Review-reproduced (LOW-MED): a 20-digit size passed the digits-only
    // guard and the -ge test printed "integer expression expected" on the
    // hook's stderr for every affected read.
    const fx = makeFixture({ record: { byteSize: 5200 } });
    const indexPath = path.join(fx.cwd, '.cortex.index');
    fs.writeFileSync(
      indexPath,
      fs.readFileSync(indexPath, 'utf8').replace('\t5200\t', '\t99999999999999999999\t'),
    );
    const run = runRead(fx);
    expect(run.substituted).toBe(false);
    expect(run.stderr).toBe('');
  });

  it('a record the flush marked ineligible never reaches the hook at all (end to end)', () => {
    // The cardinal finding, closed where it must be closed: the digest is
    // recorded at flush time, so a read followed in its batch by an edit or a
    // command has a digest describing bytes the read never returned. The
    // WRITER refuses to publish such a record; the hook, which cannot see
    // eligibility, simply finds nothing. This test runs the REAL flush and the
    // REAL index writer against the REAL hook — the divergence the fixture
    // family above cannot represent by construction.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subst-e2e-')));
    const posixRoot = root.replace(/\\/g, '/');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    initializeMeta(db, root);
    const store = new CortexStore(db);
    const scopeKey = `project:${normalizeScopePath(root)}`;
    const session = store.createSession({ worktreePath: root, scopeType: 'project', scopeKey });

    const rel = 'src/target.ts';
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'const original = 1;\n'.repeat(200));

    // Turn 1: read, then a command — the reproduced attack shape.
    appendSpoolEntry(root, { tool: 'read', file, ts: '2026-08-03T10:00:00.000Z' });
    appendSpoolEntry(root, { tool: 'cmd', cmd: 'sed -i rewrite', ts: '2026-08-03T10:00:01.000Z' });
    flushSpool(store, root, session.id);

    fs.writeFileSync(
      path.join(root, '.cortex.state'),
      `enabled=true\n${HOT_PATH_STATE_KEYS.sessionId}=${session.id}\n` +
        `${HOT_PATH_STATE_KEYS.indexScope}=${escapeIndexField(scopeKey)}\n` +
        `${HOT_PATH_STATE_KEYS.scopeRoot}=${normalizeFilePathKey(root)}\n` +
        `${HOT_PATH_STATE_KEYS.pathFold}=${PATH_FOLD}\n`,
    );
    fs.writeFileSync(path.join(root, SUBSTITUTION_FLAG_FILENAME), 'on\n');

    const digest = store.getContentDigest(scopeKey, file);
    expect(digest).not.toBeNull();
    expect(digest!.refundEligible).toBe(false);

    const fakeFx = { cwd: root, posixCwd: posixRoot, filePath: file } as Fixture;
    const ineligibleRun = runRead(fakeFx);
    expect(ineligibleRun.substituted).toBe(false);

    // Turn 2: a clean re-read re-earns eligibility, and the hook substitutes.
    appendSpoolEntry(root, { tool: 'read', file, ts: '2026-08-03T10:05:00.000Z' });
    flushSpool(store, root, session.id);
    expect(store.getContentDigest(scopeKey, file)!.refundEligible).toBe(true);

    fs.rmSync(path.join(root, TURN_READS_FILENAME), { force: true });
    const eligibleRun = runRead(fakeFx);
    expect(eligibleRun.substituted).toBe(true);
    db.close();
  });
});

// ── Structural: the other branches stay silent ───────────────────────

describe.skipIf(!canRun)('substitution: stdout discipline', () => {
  for (const [toolName, toolInput] of [
    ['Edit', { file_path: 'src/module.ts' }],
    ['Write', { file_path: 'src/module.ts' }],
    ['Bash', { command: 'echo hi' }],
    ['Agent', { description: 'do a thing' }],
  ] as const) {
    it(`prints nothing for ${toolName}`, () => {
      const fx = makeFixture();
      const result = childProcess.spawnSync(BASH as string, [SCRIPT], {
        input: JSON.stringify({
          cwd: fx.posixCwd,
          tool_name: toolName,
          tool_input: toolInput,
        }),
        encoding: 'utf8',
      });
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  }
});
