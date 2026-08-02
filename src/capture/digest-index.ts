import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CortexStore } from '../db/store.js';
import { normalizeFilePathKey, toScopeRelativeKey } from '../scope/keys.js';

/**
 * The flat digest index (AD-3): a derived, regenerable, line-oriented
 * projection of `content_digests` that the hot path can search with `grep`
 * alone — no SQLite, no JSON parser, no Node process.
 *
 * **It lives in the project root, and that is forced, not chosen.** Story 2.5
 * moved the store to `$CORTEX_HOME`, but recorded an architectural floor: the
 * hook scripts resolve their files as `"$CWD/.cortex.*"` in pure bash, and
 * finding a relocated file would mean hashing a path inside `PostToolUse` —
 * which needs either sha256 in bash or a Node process, and N-4 forbids a
 * process per tool call. The spool, `.cortex.state` and `.cortex.agent-used`
 * stay in the project root for exactly this reason, and so does this file.
 *
 * **Derived, never authoritative.** Deleting it loses nothing: it is rebuilt in
 * full from the table on the next cold-path run. That is why it is written as a
 * complete projection rather than appended per batch — an appended index would
 * satisfy "the flush writes it" while quietly failing "a deleted index is fully
 * regenerated".
 *
 * **Cold path is the sole writer** (AD-2). Nothing under `hooks/claude/` writes
 * this file; a test asserts that.
 */

export const DIGEST_INDEX_FILENAME = '.cortex.index';

/** Written when a record has no `agent_id`, so the column count is fixed. */
export const INDEX_ABSENT = '-';

/**
 * Temp-file suffix for the atomic write. Exported because `IGNORE_ENTRIES`
 * must cover it: a rename that fails and whose cleanup unlink also fails leaves
 * this file in the user's project root, breaking `cortex install`'s promise
 * that a checkout stays clean — the same reason `.cortex.spool.jsonl.processing`
 * is on that list beside `.cortex.spool.jsonl`.
 */
export const INDEX_TEMP_SUFFIX = '.tmp-';

let tempSeq = 0;
function nextTempSeq(): number {
  tempSeq += 1;
  return tempSeq;
}

export function deriveDigestIndexPath(projectRoot: string): string {
  return path.join(projectRoot, DIGEST_INDEX_FILENAME);
}

/**
 * Make one field safe for a tab-separated, newline-delimited record.
 *
 * Not defensive dressing: `path` comes from whatever the agent read, and
 * `scope_key` embeds a branch ref, which git permits to contain a startling
 * range of bytes. A raw tab forges a column and a raw newline forges an entire
 * record — the same class of hazard `inspect-memory` and `renderedAlternatives`
 * already guard, and here it would let one file's line claim another file's
 * digest. Percent-escaped rather than dropped, so the value stays reversible
 * and `grep` still matches a literal path.
 */
export function escapeIndexField(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\t/g, '%09')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

export function unescapeIndexField(value: string): string {
  return value
    .replace(/%09/g, '\t')
    .replace(/%0D/g, '\r')
    .replace(/%0A/g, '\n')
    .replace(/%25/g, '%');
}

export interface DigestIndexRecord {
  scopeKey: string;
  path: string;
  sha256: string | null;
  byteSize: number;
  sessionId: string;
  agentId: string | null;
}

/** One record, as the single line the hot path greps. */
export function formatIndexLine(record: DigestIndexRecord): string {
  // Every field is escaped, not merely the ones believed to be hostile today.
  // `sha256` is crypto hex and `byteSize` a number, so neither can currently
  // carry a delimiter — but the escaping is documented as a whole-record
  // guarantee, and a guarantee with two unprotected columns is one refactor
  // away from being false. A tab in `sha256` yields seven columns; a newline
  // forges a second record.
  return [
    escapeIndexField(record.scopeKey),
    escapeIndexField(record.path),
    record.sha256 === null ? INDEX_ABSENT : escapeIndexField(record.sha256),
    escapeIndexField(String(record.byteSize)),
    escapeIndexField(record.sessionId),
    record.agentId === null || record.agentId === '' ? INDEX_ABSENT : escapeIndexField(record.agentId),
  ].join('\t');
}

export function parseIndexLine(line: string): DigestIndexRecord | null {
  // A trailing CR was otherwise absorbed into the last field, so `agent_id`
  // came back as `"sub-9\r"` and the `-` sentinel as `"-\r"` — which stops
  // reading as absent. We always write LF, but the file sits in a Windows
  // checkout and is meant to be consumed by bash, so a normalizing tool can
  // put one there.
  const parts = line.replace(/\r$/, '').split('\t');
  if (parts.length !== 6) {
    return null;
  }
  const [scopeKey, filePath, sha256, byteSize, sessionId, agentId] = parts as [
    string, string, string, string, string, string,
  ];
  // A byte size is a whole non-negative count. `Number.isFinite` alone accepted
  // an EMPTY column as 0 — silently turning a truncated line into a valid
  // record — and accepted `-1`, `1.5` and `0x10`.
  const rawSize = unescapeIndexField(byteSize);
  if (!/^\d+$/.test(rawSize)) {
    return null;
  }
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size)) {
    return null;
  }
  return {
    scopeKey: unescapeIndexField(scopeKey),
    path: unescapeIndexField(filePath),
    sha256: sha256 === INDEX_ABSENT ? null : unescapeIndexField(sha256),
    byteSize: size,
    sessionId: unescapeIndexField(sessionId),
    agentId: agentId === INDEX_ABSENT ? null : unescapeIndexField(agentId),
  };
}

/**
 * Every scope that belongs to this project root.
 *
 * One store serves a whole repository and is partitioned by branch, so the
 * table holds scopes for sibling worktrees too. The index is per project root,
 * so it carries only the scopes actually checked out here — and carries
 * `scope_key` on each line anyway, because a worktree switches branches and a
 * line from the previous branch must be *recognisable* rather than silently
 * trusted.
 */
function scopeKeysForRoot(store: CortexStore, projectRoot: string): string[] {
  const target = normalizeFilePathKey(projectRoot);
  const rows = store.db
    .prepare(
      `SELECT DISTINCT scope_key, worktree_path
         FROM sessions
        WHERE scope_key IS NOT NULL AND worktree_path IS NOT NULL`,
    )
    .all() as { scope_key: string; worktree_path: string }[];

  const matched = new Set<string>();
  for (const row of rows) {
    const worktree = normalizeFilePathKey(row.worktree_path).replace(/\/+$/, '');
    // Equality is NOT the right test. The index is written at the directory the
    // flush was given — every caller passes cwd, or the hook payload's cwd —
    // while `worktree_path` is `git rev-parse --show-toplevel`. Those differ
    // whenever the agent works from a subdirectory, which a monorepo package is
    // by definition. Measured before this: a project root one level below the
    // git toplevel matched zero scopes and wrote a ZERO-BYTE index while the
    // digests were being recorded correctly — so Story 3.3 would grep an empty
    // file and conclude nothing had ever been read, the silent-wrong-answer
    // outcome AD-6 forbids.
    //
    // The right test is containment in either direction: a scope belongs here
    // if its checkout contains this directory (cwd inside the worktree), or if
    // its checkout lives under it (a nested checkout).
    const contains = target === worktree || target.startsWith(`${worktree}/`);
    const containedBy = worktree.startsWith(`${target}/`);
    if (contains || containedBy) {
      matched.add(row.scope_key);
    }
  }
  return [...matched];
}

export function collectIndexRecords(
  store: CortexStore,
  projectRoot: string,
): DigestIndexRecord[] {
  const scopes = scopeKeysForRoot(store, projectRoot);
  if (scopes.length === 0) {
    return [];
  }
  const placeholders = scopes.map(() => '?').join(', ');
  const rows = store.db
    .prepare(
      `SELECT scope_key, path, sha256, byte_size, session_id, agent_id
         FROM content_digests
        WHERE scope_key IN (${placeholders})
        ORDER BY scope_key, path`,
    )
    .all(...scopes) as {
    scope_key: string;
    path: string;
    sha256: string | null;
    byte_size: number;
    session_id: string;
    agent_id: string | null;
  }[];

  return rows.map(row => ({
    scopeKey: row.scope_key,
    path: row.path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    sessionId: row.session_id,
    agentId: row.agent_id,
  }));
}

export function renderDigestIndex(records: DigestIndexRecord[]): string {
  if (records.length === 0) {
    return '';
  }
  // Trailing newline so every record is a complete line — `grep` and `wc -l`
  // both treat a final unterminated line inconsistently across platforms.
  return `${records.map(formatIndexLine).join('\n')}\n`;
}

/**
 * Rebuild the index from the table.
 *
 * Written temp-file-plus-rename because the hot path reads it concurrently:
 * a partial in-place write does not fail a `grep`, it answers it *wrongly*,
 * which is the one outcome AD-6 forbids. LF explicitly, never the platform's
 * line ending — there is no `.gitattributes`, and a CRLF file breaks bash
 * everywhere except Windows (Story 2.4's finding).
 *
 * Returns the number of records written, or `null` when nothing was written
 * because the write failed. Failure is not thrown: this runs on ambient paths
 * and AD-12 binds them to silence. The index is derived, so a failed write
 * costs a rebuild, never data.
 */
export interface IndexWriteDeps {
  writeFileSync: typeof fs.writeFileSync;
  renameSync: typeof fs.renameSync;
}

export function writeDigestIndex(
  store: CortexStore,
  projectRoot: string,
  /**
   * Injected only so the write can be shown to be temp-file-plus-rename rather
   * than an in-place overwrite. Atomicity has no observable difference in the
   * success case — a direct write produces the same final bytes — so without a
   * seam a mutation removing the rename survives every behavioural test, which
   * is exactly what happened. Production always takes the default.
   */
  deps: IndexWriteDeps = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync },
): number | null {
  const indexPath = deriveDigestIndexPath(projectRoot);
  let records: DigestIndexRecord[];
  try {
    records = collectIndexRecords(store, projectRoot);
  } catch {
    return null;
  }

  const body = renderDigestIndex(records);
  // The pid alone is not unique enough: PostToolUse backgrounds a flush, so two
  // Cortex processes can write concurrently, and on a pid rollover or a reused
  // pid two writers would share one temp path and interleave their bytes.
  const temp = `${indexPath}${INDEX_TEMP_SUFFIX}${process.pid}-${nextTempSeq()}`;
  try {
    deps.writeFileSync(temp, body, { encoding: 'utf8' });
    deps.renameSync(temp, indexPath);
    return records.length;
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best effort; a stray temp file is harmless and gets overwritten.
    }
    return null;
  }
}

/**
 * Whether a *usable* index is present, so a caller can rebuild it (AC #3).
 *
 * A zero-byte file counts as absent. `isFile()` alone is true for one, so an
 * index that was written empty — which is exactly what a scope-matching failure
 * produces — satisfied the regeneration guard forever and never self-healed.
 * Measured: zero-byte index, one row in the table, an idle flush, still zero
 * bytes. Treating empty as absent costs one cheap rewrite on a genuinely empty
 * project and buys unconditional recovery everywhere else.
 */
export function digestIndexExists(projectRoot: string): boolean {
  try {
    const stat = fs.statSync(deriveDigestIndexPath(projectRoot));
    if (!stat.isFile() || stat.size === 0) {
      return false;
    }
  } catch {
    return false;
  }

  // Present and non-empty is not the same as usable. AC #3 says the index is
  // rebuilt when it is deleted *or unreadable*, and a file holding garbage —
  // a truncated write from a killed process, a merge artifact, anything — was
  // being trusted forever because only `isFile()` was checked. Validating the
  // first record is enough to distinguish "our format" from "not our format"
  // and costs one small read rather than a full parse.
  try {
    const head = fs.readFileSync(deriveDigestIndexPath(projectRoot), 'utf8');
    const firstLine = head.slice(0, head.indexOf('\n') === -1 ? undefined : head.indexOf('\n'));
    return parseIndexLine(firstLine) !== null;
  } catch {
    return false;
  }
}

/**
 * The exact literal a consumer must search for to find one file's record.
 *
 * Exported because the lookup is **not** "grep the path you have", and every
 * way of getting it wrong fails silently as a false "unread" rather than as an
 * error. Three transformations stand between a caller's path and the stored
 * key, all measured:
 *
 * - **Case is folded** on win32 and darwin, so grepping a mixed-case path
 *   returns nothing.
 * - **The key is scope-root-relative**, so grepping an absolute path returns
 *   nothing.
 * - **The field is percent-escaped**, so a path containing `%` is stored as
 *   `%25` and the raw path returns nothing.
 *
 * The delimiters matter too: without the surrounding tabs, `store.ts` also
 * matches `store.tsx`, and a path containing `.` or `[` matches the wrong
 * record — or none — unless the consumer passes `-F`. **`grep -F` is required,
 * not advisory.**
 */
export function indexLookupNeedle(filePath: string, scopeRoot: string | null | undefined): string {
  return `\t${escapeIndexField(toScopeRelativeKey(filePath, scopeRoot))}\t`;
}
