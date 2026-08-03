import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapeIndexField } from './digest-index.js';
import { normalizeFilePathKey } from '../scope/keys.js';

/**
 * The contract between the cold path (Node) and the hot path (bash) for
 * verified read substitution (FR-6, Story 4.5).
 *
 * **Everything the hook cannot compute for itself lives here**, in one module,
 * so the two sides cannot drift. The hook resolves files as `"$CWD/.cortex.*"`
 * in pure bash and may not open SQLite (AD-2) or spawn Node (N-4), which means
 * three facts have to be *published* to it rather than derived by it:
 *
 * - which Cortex session is the current primary (AD-16 refund eligibility —
 *   the payload's own `session_id` is Claude Code's, not Cortex's);
 * - the scope key in the exact escaped form `formatIndexLine` wrote it, so the
 *   index lookup is one anchored `grep -F -m1` rather than a multi-line scan;
 * - the scope root, normalized the way `normalizeFilePathKey` normalizes it,
 *   so bash can derive the scope-relative key with builtins alone.
 *
 * They are published as `key=value` lines in `<project>/.cortex.state`, which
 * `inject-header` already rewrites wholesale at every SessionStart. Per-session
 * facts in a per-session file is the right coupling: a stale session id would
 * be the AD-16 failure this whole mechanism exists to prevent, and rewriting
 * them together with the session that produced them makes staleness
 * unreachable.
 *
 * The **enable flag** deliberately does *not* live there. `.cortex.state` is
 * read with `grep`, and a second key would mean a second process on every tool
 * call including `Edit`, `Write`, `Bash` and `Agent` — a tax on paths that can
 * never substitute. A marker file is `[ -f ]`, a bash builtin, and it survives
 * the wholesale rewrite for free.
 */

/** Existence is "on" (AC #6). Tested with `[ -f ]`, so the check costs nothing. */
export const SUBSTITUTION_FLAG_FILENAME = '.cortex.substitution';

/**
 * Paths evaluated for substitution during the current turn (AC #4).
 *
 * Appended by the hook, removed by `cortex-end-of-turn.sh` at Stop — the
 * lifecycle `.cortex.agent-used` already established. Over-suppression (a
 * subagent's reads accumulate until the parent's Stop, because SubagentStop is
 * a different event) degrades to a miss, which is the safe direction.
 */
export const TURN_READS_FILENAME = '.cortex.turn-reads';

/**
 * Below this a refund is not worth taking: the substitution payload itself
 * costs tokens, so a small file's "saving" is noise or negative.
 */
export const DEFAULT_SUBST_MIN_BYTES = 2048;

/**
 * B-4a's amendment requires a ceiling above which substitution is skipped, and
 * this is it — but the honest reason is not the one the amendment gives.
 *
 * Measured on the reference platform (Git Bash 5.2.37, median of 25 warm runs):
 * `sha256sum` of nothing costs 55 ms, of 512 KiB 57 ms, of 2 MiB 62 ms. Hashing
 * is ~2–7 ms; the **process** is the whole cost. So the ceiling is not what
 * keeps the hit path inside its budget (B-4a as re-based 2026-08-03: hit
 * ≤800 ms p95 end-to-end, structural spawn count primary) — the spawn count
 * is. It ships anyway because the amendment requires it and because a platform
 * with a slower `sha256sum` is a real possibility.
 *
 * 1 MiB, deliberately **below** `CORTEX_DIGEST_MAX_BYTES` (2 MiB): a ceiling
 * equal to the digest ceiling could never fire, because past that the recorded
 * `sha256` is NULL and no record can match. In practice the full-read check
 * subsumes most of this — `Read` truncates at 2000 lines — and the ceiling is
 * documented as belt-and-braces rather than credited with the budget.
 */
export const DEFAULT_SUBST_MAX_BYTES = 1024 * 1024;

/**
 * The effective bounds, env override included — what the hook will actually
 * enforce, parsed the way the repo parses every numeric env: `Number` with a
 * whole-number guard, never `parseInt` (`parseInt('2e6')` is 2). `cortex
 * substitution status` reports THESE, because printing the compiled defaults
 * beside the env variable names reads as a report of the effective gate and is
 * not one.
 */
function resolveSubstBytes(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function resolveSubstMinBytes(
  raw: string | undefined = process.env['CORTEX_SUBST_MIN_BYTES'],
): number {
  return resolveSubstBytes(raw, DEFAULT_SUBST_MIN_BYTES);
}

export function resolveSubstMaxBytes(
  raw: string | undefined = process.env['CORTEX_SUBST_MAX_BYTES'],
): number {
  return resolveSubstBytes(raw, DEFAULT_SUBST_MAX_BYTES);
}

/**
 * The `.cortex.state` keys the hook reads. Exported so the shell script's
 * literals can be asserted against them by test instead of matching by
 * inspection.
 */
export const HOT_PATH_STATE_KEYS = {
  sessionId: 'session_id',
  indexScope: 'index_scope',
  scopeRoot: 'scope_root',
  pathFold: 'path_fold',
} as const;

export function deriveSubstitutionFlagPath(projectRoot: string): string {
  return path.join(projectRoot, SUBSTITUTION_FLAG_FILENAME);
}

export function deriveTurnReadsPath(projectRoot: string): string {
  return path.join(projectRoot, TURN_READS_FILENAME);
}

/**
 * `statSync().isFile()`, not `existsSync`.
 *
 * The hook's gate is `[ -f ]`, which is false for a directory. `existsSync`
 * is true for one, and the two sides disagreeing about the single gate AC #6
 * rests on is exactly the drift this module exists to prevent.
 */
export function isSubstitutionEnabled(projectRoot: string): boolean {
  try {
    return fs.statSync(deriveSubstitutionFlagPath(projectRoot)).isFile();
  } catch {
    return false;
  }
}

/** Returns whether the state actually changed, so callers can report honestly. */
export function setSubstitutionEnabled(projectRoot: string, enabled: boolean): boolean {
  const target = deriveSubstitutionFlagPath(projectRoot);
  const current = isSubstitutionEnabled(projectRoot);
  if (current === enabled) {
    return false;
  }
  if (enabled) {
    // Content is never read — the gate is existence — but a human who finds
    // this file deserves to know what it is.
    fs.writeFileSync(target, 'on\n', { encoding: 'utf8' });
  } else {
    fs.rmSync(target, { force: true });
  }
  return true;
}

export interface HotPathStateFacts {
  /** Cortex's current primary session id. */
  sessionId: string;
  /** The session's scope key, unescaped. */
  scopeKey: string;
  /** `worktree_path` for that scope, or null when it cannot be resolved. */
  scopeRoot: string | null;
}

/**
 * Whether a value can survive a `key=value` line the hook parses by line.
 *
 * A newline in a published value forges a line in the file whose *first* line
 * is the `enabled=true` gate — the forgery class `formatIndexLine` and
 * `inspect-memory` already bind. The two halves are treated differently on
 * purpose:
 *
 * - the **scope key** is published already run through `escapeIndexField`,
 *   because that is the form the index holds. Escaping neutralises the newline
 *   *and* keeps a legitimately odd branch name working — git permits a
 *   startling range of bytes in a ref, and refusing would silently disable
 *   substitution on such a branch rather than protecting anything.
 * - the **scope root** is published raw, because the hook strips it as a
 *   literal prefix and an escaped root would match no path at all. It cannot be
 *   escaped, so a dangerous value is refused and the hook misses.
 *
 * This function guards the raw half.
 */
function isPublishable(value: string): boolean {
  // Escaped classes, never literal bytes: a raw control character authored into
  // a regex is how two files in this repository became invisible to grep.
  return !/[\u0000-\u001F\u007F]/.test(value);
}

/**
 * The lines `inject-header` appends to `.cortex.state`, or `''` when the facts
 * cannot be published safely or completely.
 *
 * An empty result is not a failure to handle — it is the AD-6 answer. Without
 * these keys the hook cannot establish eligibility and misses, which costs a
 * refund and can never grant a false one.
 */
export function renderHotPathStateLines(facts: HotPathStateFacts): string {
  if (facts.scopeRoot === null || facts.scopeRoot.length === 0) {
    return '';
  }

  const indexScope = escapeIndexField(facts.scopeKey);
  const scopeRoot = normalizeFilePathKey(facts.scopeRoot);
  // The hook folds case with the `${v,,}` builtin only when told to. Publishing
  // the flag rather than baking win32 into the script keeps the shell and
  // `normalizeFilePathKey` agreeing on Linux, where `Makefile` and `makefile`
  // are two files and folding them would merge two ledger keys into one.
  const pathFold =
    process.platform === 'win32' || process.platform === 'darwin' ? 'lower' : 'none';

  const values = [facts.sessionId, indexScope, scopeRoot];
  if (values.some(value => value.length === 0 || !isPublishable(value))) {
    return '';
  }

  return [
    `${HOT_PATH_STATE_KEYS.sessionId}=${facts.sessionId}`,
    `${HOT_PATH_STATE_KEYS.indexScope}=${indexScope}`,
    `${HOT_PATH_STATE_KEYS.scopeRoot}=${scopeRoot}`,
    `${HOT_PATH_STATE_KEYS.pathFold}=${pathFold}`,
    '',
  ].join('\n');
}
