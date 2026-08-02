import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Content hashing and oversize policy for the read ledger (FR-5, Story 3.1).
 *
 * **This runs on the cold path only.** The PostToolUse hook appends a spool
 * line in pure bash and spawns nothing (N-4); the digest is computed when that
 * batch is flushed. Nothing in this module may be reached from a hook script.
 *
 * Consequence stated rather than hidden: a digest describes the file as of
 * *flush* time, not as of the read. Within one batch that is safe because an
 * edit replayed from the same spool wins the verdict (Story 3.3's
 * `edited-by-you-since`). A file changed by something outside Cortex between
 * the read and the flush records the changed bytes and will later read as
 * unchanged — a real, bounded imprecision, not a guarantee.
 */

/** 2 MiB. Past this the bytes are never read, so nothing is hashed. */
export const DEFAULT_DIGEST_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The `(scope_key, path)` key's path half is normalized by
 * `normalizeFilePathKey` in `scope/keys.ts`, and `CortexStore` applies it on
 * both write and read so a caller cannot derive the key differently. Nothing
 * in this module needs to normalize.
 */

export interface FileDigest {
  /** Lowercase hex sha256, or null when the file was not hashed (oversize). */
  sha256: string | null;
  byteSize: number;
  /** ISO-8601 UTC. Recorded for reporting only — never for change detection. */
  mtime: string;
  oversize: boolean;
}

/**
 * Parse with `Number`, never `parseInt`.
 *
 * `parseInt` succeeds on a *prefix*: `parseInt('2e6')` is 2, which would turn a
 * 2 MB ceiling into a 2-byte one and mark every file oversize. Story 2.6's
 * review found exactly this in `resolveWalMaxBytes`. `gc.ts`'s neighbouring
 * `envNumber` still uses `parseInt` — deliberately not copied.
 */
export function resolveDigestMaxBytes(
  raw: string | undefined = process.env['CORTEX_DIGEST_MAX_BYTES'],
): number {
  if (raw === undefined) {
    return DEFAULT_DIGEST_MAX_BYTES;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return DEFAULT_DIGEST_MAX_BYTES;
  }
  const parsed = Number(trimmed);
  // Floor BEFORE the range check, not after. `parsed <= 0` lets any value in
  // (0,1) through, and `Math.floor` then turns it into 0 — a ceiling of zero
  // marks every file oversize and silently disables hashing entirely. Measured:
  // `CORTEX_DIGEST_MAX_BYTES=0.5` recorded `sha256 NULL, oversize 1` for a
  // 20-byte file. That is byte-for-byte the failure this function's `Number`
  // choice exists to avoid, reached by a different route.
  const floored = Math.floor(parsed);
  if (!Number.isFinite(floored) || floored < 1) {
    return DEFAULT_DIGEST_MAX_BYTES;
  }
  return floored;
}

/**
 * A usable ceiling, whatever a caller passed. `maxBytes` is a public parameter
 * on an exported function: `NaN` compares false against everything and silently
 * disables the ceiling, and a negative marks every file oversize. Neither
 * should depend on the caller being careful.
 */
function usableCeiling(maxBytes: number): number {
  return Number.isFinite(maxBytes) && maxBytes >= 1
    ? Math.floor(maxBytes)
    : DEFAULT_DIGEST_MAX_BYTES;
}

/**
 * Hash a file's bytes, or record its size alone when it exceeds the ceiling.
 *
 * Returns `null` when the file cannot be measured at all (missing, unreadable,
 * a directory). Capture edges never throw into a hook (AD-12), and a read of
 * something unhashable is simply not ledgered.
 */
export function computeFileDigest(
  filePath: string,
  maxBytes: number = resolveDigestMaxBytes(),
  /**
   * Injected solely so the post-read ceiling re-check below is testable: the
   * bug it guards needs the file to change *between* the stat and the read,
   * which cannot be staged deterministically otherwise, and an untestable
   * correctness guarantee is one that regresses silently. Production always
   * takes the default.
   */
  deps: { statSync: typeof fs.statSync } = { statSync: fs.statSync },
): FileDigest | null {
  const ceiling = usableCeiling(maxBytes);

  let statSize: number;
  let mtime: string;
  try {
    const stat = deps.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    statSize = stat.size;
    // Inside the try: an out-of-range mtime makes `toISOString` throw a
    // RangeError, and this function's contract is to return null rather than
    // throw. Filesystems that permit such timestamps exist even though win32
    // rejects them.
    mtime = stat.mtime.toISOString();
  } catch {
    // Missing, permission-denied, a broken link, or an unrepresentable time.
    // Not worth surfacing: the ledger simply has no record for this path.
    return null;
  }

  // Decide from the stat, before reading. Reading a 500 MB file to discover it
  // is oversize would defeat the ceiling entirely.
  if (statSize > ceiling) {
    return { sha256: null, byteSize: statSize, mtime, oversize: true };
  }

  try {
    // Hash the raw Buffer. Decoding to UTF-8 first would corrupt binary and
    // non-UTF-8 content into replacement characters, so the same bytes would
    // not reproduce the same digest (AC #4: binary files are still digested).
    const bytes = fs.readFileSync(filePath);

    // Re-check against what was actually read, not what stat promised. The
    // stat and the read are two syscalls and anything may write between them:
    // measured with a concurrent writer, 36 of 17,147 calls hashed a 6 MiB file
    // under a 2 MiB ceiling, and 4.5% of rows ended up with a `byte_size` and a
    // `sha256` describing different states of the file. A row whose own two
    // columns disagree is worse than a missing row, because Story 3.3 would
    // trust it.
    if (bytes.length > ceiling) {
      return { sha256: null, byteSize: bytes.length, mtime, oversize: true };
    }

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    // byteSize from the bytes hashed, so the two columns always describe the
    // same snapshot even when the file changed under us.
    return { sha256, byteSize: bytes.length, mtime, oversize: false };
  } catch {
    // Readable by stat but not by read — a race with a delete, or a lock.
    return null;
  }
}

/**
 * Per-flush memo.
 *
 * A 256 KiB batch can hold hundreds of reads of the same file, and every digest
 * in one flush describes the same on-disk state — so hashing a path more than
 * once per batch is not merely wasteful, it is the same value by construction.
 * The cache is created per batch and discarded with it; it must never be
 * module-level, or a long-lived MCP process would serve a stale hash forever.
 */
export type DigestCache = (filePath: string) => FileDigest | null;

/** See `computeFileDigest`'s `deps`: a test seam, never used in production. */
export interface DigestDeps {
  statSync: typeof fs.statSync;
}

export function createDigestCache(
  maxBytes: number = resolveDigestMaxBytes(),
  deps?: DigestDeps,
): DigestCache {
  const seen = new Map<string, FileDigest | null>();
  return (filePath: string) => {
    if (seen.has(filePath)) {
      return seen.get(filePath) ?? null;
    }
    // A `null` is memoized too, deliberately: a path that cannot be measured at
    // flush time cannot be measured later in the same flush either.
    const digest = deps
      ? computeFileDigest(filePath, maxBytes, deps)
      : computeFileDigest(filePath, maxBytes);
    seen.set(filePath, digest);
    return digest;
  };
}
