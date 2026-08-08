import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { createProgram } from '../src/transports/cli.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SUBSTITUTION_FLAG_FILENAME,
  TURN_READS_FILENAME,
  DEFAULT_SUBST_MIN_BYTES,
  DEFAULT_SUBST_MAX_BYTES,
  deriveSubstitutionFlagPath,
  deriveTurnReadsPath,
  isSubstitutionEnabled,
  resolveSubstMaxBytes,
  resolveSubstMinBytes,
  setSubstitutionEnabled,
  renderHotPathStateLines,
  HOT_PATH_STATE_KEYS,
} from '../src/capture/substitution.js';
import { DEFAULT_DIGEST_MAX_BYTES } from '../src/capture/digest.js';
import { escapeIndexField } from '../src/capture/digest-index.js';
import { normalizeFilePathKey } from '../src/scope/keys.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subst-'));
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly; the temp dir is disposable either way.
  }
});

// ── The enable flag (AC #6) ───────────────────────────────────────────

describe('substitution enable flag', () => {
  it('is off when the marker file is absent', () => {
    expect(isSubstitutionEnabled(root)).toBe(false);
  });

  it('turns on by creating the marker and reports the change', () => {
    expect(setSubstitutionEnabled(root, true)).toBe(true);
    expect(isSubstitutionEnabled(root)).toBe(true);
    expect(fs.existsSync(path.join(root, SUBSTITUTION_FLAG_FILENAME))).toBe(true);
  });

  it('is idempotent in both directions', () => {
    setSubstitutionEnabled(root, true);
    expect(setSubstitutionEnabled(root, true)).toBe(false);
    expect(setSubstitutionEnabled(root, false)).toBe(true);
    expect(setSubstitutionEnabled(root, false)).toBe(false);
    expect(isSubstitutionEnabled(root)).toBe(false);
  });

  // The hot path tests `[ -f ]` and nothing else, so a directory at that path
  // must not read as enabled — otherwise the two sides disagree about the one
  // gate AC #6 rests on.
  it('does not read a directory at the marker path as enabled', () => {
    fs.mkdirSync(deriveSubstitutionFlagPath(root));
    expect(isSubstitutionEnabled(root)).toBe(false);
  });

  it('derives both hot-path filenames under the project root', () => {
    expect(deriveSubstitutionFlagPath(root)).toBe(path.join(root, SUBSTITUTION_FLAG_FILENAME));
    expect(deriveTurnReadsPath(root)).toBe(path.join(root, TURN_READS_FILENAME));
  });
});

// ── The state bridge (D2) ─────────────────────────────────────────────

describe('hot-path state bridge', () => {
  const scopeKey = 'branch:c:/repo/.git:c:/repo:feature/a b';
  const sessionId = '38a01dc3-f429-42f6-b515-bacbe4541055';

  it('publishes the session, the escaped scope and the normalized root', () => {
    const lines = renderHotPathStateLines({ sessionId, scopeKey, scopeRoot: 'C:\\repo' });
    const parsed = new Map(
      lines
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1)] as [string, string];
        }),
    );

    expect(parsed.get(HOT_PATH_STATE_KEYS.sessionId)).toBe(sessionId);
    // The scope must arrive in exactly the form `formatIndexLine` wrote it, or
    // the needle cannot match a single record.
    expect(parsed.get(HOT_PATH_STATE_KEYS.indexScope)).toBe(escapeIndexField(scopeKey));
    expect(parsed.get(HOT_PATH_STATE_KEYS.scopeRoot)).toBe(normalizeFilePathKey('C:\\repo'));
    expect(parsed.get(HOT_PATH_STATE_KEYS.pathFold)).toBe(
      process.platform === 'win32' || process.platform === 'darwin' ? 'lower' : 'none',
    );
  });

  it('emits nothing when the scope root is unknown', () => {
    expect(renderHotPathStateLines({ sessionId, scopeKey, scopeRoot: null })).toBe('');
  });

  // A newline in a published value would forge a `key=value` line in the file
  // whose FIRST line is the `enabled=true` gate. The two halves are handled
  // differently on purpose, and the difference is the point:
  //
  //  - the scope key is published ESCAPED, because that is the form the index
  //    holds; escaping neutralises the newline and keeps a legitimately odd
  //    branch name working (git permits a startling range of bytes in a ref);
  //  - the scope root is published RAW, because the hook strips it as a literal
  //    prefix, so it cannot be escaped — a dangerous value is refused instead.
  it('escapes a control character in the scope key rather than refusing it', () => {
    const hostile = 'branch:x\nenabled=false';
    const lines = renderHotPathStateLines({ sessionId, scopeKey: hostile, scopeRoot: 'C:\\repo' });

    expect(lines).not.toBe('');
    expect(lines).toContain(`${HOT_PATH_STATE_KEYS.indexScope}=${escapeIndexField(hostile)}`);
    // The forged line must not exist, and the escaped form is what the index
    // actually holds — so the lookup still works for this branch.
    expect(lines.split('\n')).not.toContain('enabled=false');
    expect(escapeIndexField(hostile)).not.toContain('\n');
  });

  it('emits nothing when an unescapable value carries a control character', () => {
    expect(
      renderHotPathStateLines({ sessionId, scopeKey, scopeRoot: 'C:\\repo\nenabled=false' }),
    ).toBe('');
    expect(
      renderHotPathStateLines({ sessionId: 'a\u0000b', scopeKey, scopeRoot: 'C:\\repo' }),
    ).toBe('');
  });

  it('renders every line as key=value terminated by a newline', () => {
    const lines = renderHotPathStateLines({ sessionId, scopeKey, scopeRoot: 'C:\\repo' });
    expect(lines.endsWith('\n')).toBe(true);
    for (const line of lines.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^[a-z_]+=/);
    }
  });
});

// ── Economics constants ───────────────────────────────────────────────

describe('cortex substitution (CLI)', () => {
  async function run(args: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
    const originalCwd = process.cwd();
    let out = '';
    let err = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err += chunk.toString();
      return true;
    });
    process.exitCode = undefined;
    try {
      process.chdir(root);
      await createProgram().parseAsync(['node', 'cortex', 'substitution', ...args]);
      return { out, err, code: process.exitCode };
    } finally {
      process.exitCode = undefined;
      outSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
    }
  }

  it('reports off, turns on, and reports on', async () => {
    expect((await run([])).out).toContain('Substitution: off');
    expect((await run(['on'])).out).toContain('Substitution: on');
    expect(isSubstitutionEnabled(root)).toBe(true);
    expect((await run(['status'])).out).toContain('Substitution: on');
  });

  it('reports what actually happened, not what was asked', async () => {
    // The `install` lesson: an outcome computed from state the action already
    // changed reports `created` for something it updated. A second `on` changed
    // nothing and must say so.
    await run(['on']);
    expect((await run(['on'])).out).toContain('already on, nothing changed');
    expect((await run(['off'])).out).toContain('Substitution: off');
    expect((await run(['off'])).out).toContain('already off, nothing changed');
  });

  it('refuses an unknown mode instead of falling back to one', async () => {
    // The `install --scope` rule: a typo that silently means something else is
    // worse than a refusal. `--scope` fell back to `user` and wrote the wrong
    // settings file for someone who asked for project scope.
    const result = await run(['ON']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unknown mode');
    expect(isSubstitutionEnabled(root)).toBe(false);
  });

  it('tells a disabled project how to enable it', async () => {
    expect((await run([])).out).toContain('cortex substitution on');
  });

  it('reports the EFFECTIVE size gate when env overrides are set', async () => {
    // Review-reproduced: the status line printed the compiled defaults while
    // naming the env variables that override them — a report of the effective
    // gate that was not one.
    const prevMax = process.env['CORTEX_SUBST_MAX_BYTES'];
    process.env['CORTEX_SUBST_MAX_BYTES'] = '4096';
    try {
      const { out } = await run(['status']);
      expect(out).toContain('..4096 bytes');
      expect(out).toContain('env override active');
    } finally {
      if (prevMax === undefined) delete process.env['CORTEX_SUBST_MAX_BYTES'];
      else process.env['CORTEX_SUBST_MAX_BYTES'] = prevMax;
    }
  });

  it('warns when armed with no hot-path facts published — on-but-inert is visible', async () => {
    await run(['on']);
    const { out } = await run(['status']);
    expect(out).toContain('WARNING');
    expect(out).toContain('hot-path session facts');
  });

  it('arms the git toplevel, not the subdirectory the shell happens to be in', async () => {
    // Review-reproduced: run from `<repo>/src`, the flag landed at
    // `src/.cortex.substitution` where no hook ever looks, and `status`
    // reported it on — armed and silently dead, forever.
    childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub, { recursive: true });

    const originalCwd = process.cwd();
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.chdir(sub);
      await createProgram().parseAsync(['node', 'cortex', 'substitution', 'on']);
    } finally {
      outSpy.mockRestore();
      process.chdir(originalCwd);
    }

    const toplevel = fs.realpathSync(root);
    expect(fs.existsSync(path.join(toplevel, SUBSTITUTION_FLAG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(sub, SUBSTITUTION_FLAG_FILENAME))).toBe(false);
  });
});

// ── AC #7 / D8: PreToolUse never denies for economics ────────────────

describe('no ECONOMICS surface can emit a permission decision (AC #7, AD-7)', () => {
  // AC #7 is a negative, and negatives rot quietly. Story 4.5 added the repo's
  // first decision-influencing hook stdout, which is exactly when a later
  // change could reach for `permissionDecision: "deny"` — the one mechanism
  // AD-7 forbids for economics.
  //
  // **Narrowed by Story 5.3 (FR-19), deliberately and with the reason stated.**
  // That story adds a `PreToolUse` guard that DOES deny: a subagent may not
  // retire memory belonging to an earlier session. The original form of this
  // scan — the string appears nowhere in the bridge at all — would have failed
  // on a capability AD-7 never forbade, and the wrong response would have been
  // to hide the denial behind a helper in another file so the scan stayed green
  // while the property it named stopped being true. AD-7's actual guarantee is
  // narrower and still holds: nothing on the ECONOMICS path denies. So the scan
  // now pins where a decision may come from rather than whether one exists.
  it('appears in no shipped hook template on an economics path', () => {
    // `cortex-subagent.sh` is excluded BY NAME: it carries the Story 5.3 guard
    // arm and is not a substitution surface. The other three are the whole
    // read/refund path and must stay decision-free.
    for (const name of ['cortex-capture.sh', 'cortex-reflect.sh', 'cortex-end-of-turn.sh']) {
      const script = fs.readFileSync(
        path.resolve(__dirname, '..', 'hooks', 'claude', name),
        'utf8',
      );
      expect(script, name).not.toContain('permissionDecision');
      expect(script, name).not.toContain('permission_decision');
    }
  });

  it('appears in the hook bridge only inside the memory guard', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'transports', 'hook-entry.ts'),
      'utf8',
    );

    // The guard function's extent, start of `function guardMemory` to the start
    // of the next top-level declaration.
    const start = source.indexOf('function guardMemory(');
    expect(start, 'hook-entry.ts has no guardMemory function').toBeGreaterThan(-1);
    const after = source.slice(start + 1);
    const nextDecl = after.search(/\n(?:export )?(?:async )?function /);
    const end = nextDecl < 0 ? source.length : start + 1 + nextDecl;

    const occurrences: number[] = [];
    for (let index = source.indexOf('permissionDecision'); index >= 0; ) {
      occurrences.push(index);
      index = source.indexOf('permissionDecision', index + 1);
    }
    // Present at all — a guard that stopped denying would be the other failure.
    expect(occurrences.length).toBeGreaterThan(0);
    for (const index of occurrences) {
      expect(
        index >= start && index < end,
        `permissionDecision at offset ${index} is outside guardMemory`,
      ).toBe(true);
    }

    // The substitution path's own output shape is unchanged: additionalContext,
    // and no `decision` key riding in beside it.
    expect(source).toContain('additionalContext');
    expect(source).not.toContain('"decision"');
    expect(source).not.toContain('permission_decision');
  });
});

// ── The hazard this repo has paid for three times ────────────────────

describe('no shipped source file carries a raw control byte', () => {
  it('is greppable — every source file, no exceptions', () => {
    // `grep` and `ripgrep` both classify a file
    // containing a NUL as binary and skip it **silently**. That is how one of
    // four copies of `findDbPath` stayed invisible while a grep-only
    // enumeration returned a confident, complete-looking, wrong answer — the
    // reason this repository mandates symbol tools over grep.
    //
    // Story 2.7 recorded the set as exactly two files and deferred the fix.
    // Story 4.5's byte-scan found a **third** (`src/capture/spool.ts`, a NUL
    // used as a separator in `creditRowId`'s join — squarely on the capture
    // path this epic works in), which is what a hand-maintained enumeration
    // does. All four occurrences were the same shape: a composite-key
    // separator, replaced by the six-character escape, which is the identical character at
    // runtime and byte-identical in behaviour.
    //
    // A test rather than a note, because the note was already written twice.
    const roots = ['src', 'hooks', 'tests'];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|sh|js|mjs)$/.test(entry.name)) continue;
        const bytes = fs.readFileSync(full);
        for (const byte of bytes) {
          // Tab, LF and CR are the only control bytes a source file may hold.
          // 0x7F is a control byte too — the review found this scan claiming
          // "any control byte" while skipping DEL, the exact gap between a
          // guarantee's wording and its implementation this test exists to
          // close for others.
          if ((byte < 0x20 || byte === 0x7f) && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            offenders.push(full);
            break;
          }
        }
      }
    };

    for (const root of roots) walk(path.resolve(__dirname, '..', root));
    expect(offenders, 'write control characters as \\uXXXX escapes').toEqual([]);
  });
});

describe('substitution size bounds', () => {
  it('keeps the ceiling below the digest ceiling so it is a live gate', () => {
    // Against the imported constant, not a hard-coded 2 MiB: the invariant is
    // relational ("below the digest ceiling"), and a literal keeps this green
    // while a lowered digest default silently falsifies the claim — the drift
    // the neighbouring install-test binding exists to prevent.
    expect(DEFAULT_SUBST_MAX_BYTES).toBeLessThan(DEFAULT_DIGEST_MAX_BYTES);
    expect(DEFAULT_SUBST_MIN_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_SUBST_MIN_BYTES).toBeLessThan(DEFAULT_SUBST_MAX_BYTES);
  });

  it('resolves env overrides with Number semantics and whole-byte guards', () => {
    expect(resolveSubstMinBytes(undefined)).toBe(DEFAULT_SUBST_MIN_BYTES);
    expect(resolveSubstMaxBytes('4096')).toBe(4096);
    // `parseInt('2e6')` is 2 — the fourth time this repo has had to say so.
    expect(resolveSubstMaxBytes('2e6')).toBe(DEFAULT_SUBST_MAX_BYTES);
    expect(resolveSubstMinBytes('-1')).toBe(DEFAULT_SUBST_MIN_BYTES);
    expect(resolveSubstMinBytes('abc')).toBe(DEFAULT_SUBST_MIN_BYTES);
    expect(resolveSubstMinBytes(' 64 ')).toBe(64);
  });
});
