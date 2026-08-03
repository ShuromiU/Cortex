import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The working-tree census (FR-12/FR-13, Story 4.3): a bounded, deterministic
 * fingerprint of everything under a search root, shared by the capture flush
 * (records it) and the search-ledger query (re-derives and compares it).
 *
 * The census is the negative cache's ENTIRE evidence (AD-6). A byte-identical
 * tree provably still returns zero for the recorded search — dirty-vs-clean is
 * irrelevant because the census reads the same working tree the search read,
 * and `head_oid` is deliberately never part of it (a rebase over an identical
 * tree changes head and nothing else). `mtime` is never consulted anywhere
 * here: it is the exact proxy AD-6 forbids.
 *
 * Determinism: entries are ordered by their forward-slashed relative path
 * (UTF-16 code-unit order — any total order works as long as it is stable on
 * the same machine over time; this one needs no locale and no case folding,
 * and folding would merge distinct files on case-sensitive filesystems). Each
 * entry contributes `relpath NUL kind:payload NUL size`, and entries join
 * with a double NUL. NUL (written as the six-character escape in this source,
 * per the repo's control-byte rule) is the one byte a path cannot contain, so
 * a hostile filename — including one carrying newlines or the literal text
 * "file:" — cannot forge another entry or shift a boundary.
 *
 * Exclusions are exactly two, and both are principled rather than tuned:
 * `.git` (object churn describes history, not the searched tree) and any
 * basename beginning `.cortex.` — Cortex must not observe its own exhaust:
 * the spool grows on every tool call and would invalidate every census one
 * turn after it was taken. Both sets are gitignored in practice, so the
 * search tool (ripgrep-backed, ignore-respecting) never saw them either.
 * Everything else — including gitignored build output — is INCLUDED:
 * over-strict invalidation costs a re-search; under-strict invalidation is
 * SM-C3.
 */

export const CENSUS_DEFAULT_MAX_FILES = 2000;
export const CENSUS_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `Number`, never `parseInt`: `parseInt('2e6')` is 2, which would turn a
 * ceiling into a near-zero one (the third repo occurrence of this rule).
 * Anything non-integral, non-positive, or non-numeric falls back.
 */
function resolveEnvCeiling(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  // `0` is honoured as "record nothing" rather than inverted into the default
  // (review round): an operator setting a ceiling to zero means off, and
  // silently restoring 2000 turns a deliberate disable into full operation.
  if (parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function resolveCensusMaxFiles(): number {
  return resolveEnvCeiling('CORTEX_NEGATIVE_MAX_FILES', CENSUS_DEFAULT_MAX_FILES);
}

export function resolveCensusMaxBytes(): number {
  return resolveEnvCeiling('CORTEX_NEGATIVE_MAX_BYTES', CENSUS_DEFAULT_MAX_BYTES);
}

export interface CensusLimits {
  maxFiles: number;
  maxBytes: number;
}

export type RootCensus =
  | {
      status: 'ok';
      sha256: string;
      files: number;
      bytes: number;
      /**
       * Cortex runtime files skipped by `isExcludedBasename`, scope-relative.
       *
       * The exclusion is only sound if the SEARCH skipped them too, and the
       * review round disproved the assumption it shipped on: measured against
       * the real Grep tool, a token inside `.cortex.spool.jsonl` **is found**
       * in any repository whose ignore file has not been swept — which is
       * every fresh project, because hooks arrive machine-wide while the
       * ignore entries are written per-repo. So the caller must verify these
       * are genuinely unsearchable before asserting anything; an empty list
       * (every search rooted below the project root) needs no check at all.
       * `.git` is NOT reported: its contents were measured unsearchable.
       */
      excludedCortex: string[];
    }
  /** The root does not exist (or is not a file/directory) — a *provable* state. */
  | { status: 'missing' }
  /** The walk exceeded the limits before completing. */
  | { status: 'overflow' }
  /** Something under the root could not be fingerprinted (permissions, a
   *  special file type, an entry that vanished mid-walk). Never an assertion
   *  in either direction. */
  | { status: 'unreadable' };

function isExcludedBasename(name: string): boolean {
  return name === '.git' || isCortexRuntimeName(name);
}

/** The runtime artifacts whose searchability the caller must verify. */
function isCortexRuntimeName(name: string): boolean {
  return name.startsWith('.cortex.') || name === '.cortex';
}

interface CensusEntry {
  rel: string;
  line: string;
  bytes: number;
}

/**
 * Fingerprint the tree under `absRoot`. A root that is a plain FILE is a
 * one-entry census — Claude Code's Grep accepts file targets, and a search
 * scoped to one file is the cheapest, most cacheable kind.
 */
export function computeRootCensus(absRoot: string, limits?: Partial<CensusLimits>): RootCensus {
  const maxFiles = limits?.maxFiles ?? resolveCensusMaxFiles();
  const maxBytes = limits?.maxBytes ?? resolveCensusMaxBytes();

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(absRoot);
  } catch {
    return { status: 'missing' };
  }

  const entries: CensusEntry[] = [];
  const excludedCortex: string[] = [];
  let totalBytes = 0;
  // Directories count against the same ceiling as files (review round): the
  // walk was bounded by file count and bytes but recursed into directories
  // freely, so a tree grown only by (even empty) directories never tripped
  // `overflow` — unbounded work on the flush path, and at pathological depth a
  // stack overflow escaping every per-syscall catch.
  let dirCount = 0;

  const addFile = (absFile: string, rel: string, size: number): 'ok' | 'overflow' | 'unreadable' => {
    if (entries.length + 1 > maxFiles) return 'overflow';
    totalBytes += size;
    if (totalBytes > maxBytes) return 'overflow';
    let sha: string;
    try {
      // Raw Buffer, never decoded: decoding corrupts binary/non-UTF-8 content
      // into replacement characters and the same bytes stop reproducing the
      // same digest (the computeFileDigest rule).
      const bytes = fs.readFileSync(absFile);
      if (bytes.length !== size) {
        // Changed between lstat and read; charge what was actually hashed so
        // the byte ceiling stays honest about work performed.
        totalBytes += bytes.length - size;
        if (totalBytes > maxBytes) return 'overflow';
        size = bytes.length;
      }
      sha = crypto.createHash('sha256').update(bytes).digest('hex');
    } catch {
      return 'unreadable';
    }
    entries.push({ rel, line: `${rel}\u0000file:${sha}\u0000${size}`, bytes: size });
    return 'ok';
  };

  const walk = (absDir: string, relDir: string): 'ok' | 'overflow' | 'unreadable' => {
    let names: string[];
    try {
      names = fs.readdirSync(absDir);
    } catch {
      return 'unreadable';
    }
    names.sort();
    for (const name of names) {
      if (isExcludedBasename(name)) {
        if (isCortexRuntimeName(name)) {
          excludedCortex.push(relDir === '' ? name : `${relDir}/${name}`);
        }
        continue;
      }
      const absEntry = path.join(absDir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absEntry);
      } catch {
        return 'unreadable';
      }
      if (stat.isSymbolicLink()) {
        // Recorded, never followed: a cycle must not hang the walk, and the
        // link's own identity (its target string) is what the tree holds.
        let target: string;
        try {
          target = fs.readlinkSync(absEntry);
        } catch {
          return 'unreadable';
        }
        if (entries.length + 1 > maxFiles) return 'overflow';
        entries.push({ rel, line: `${rel}\u0000link:${target}\u00000`, bytes: 0 });
      } else if (stat.isDirectory()) {
        dirCount++;
        if (dirCount + entries.length > maxFiles) return 'overflow';
        const sub = walk(absEntry, rel);
        if (sub !== 'ok') return sub;
      } else if (stat.isFile()) {
        const added = addFile(absEntry, rel, stat.size);
        if (added !== 'ok') return added;
      } else {
        // FIFO, socket, device: not fingerprintable, so nothing under this
        // root can be asserted (AD-6).
        return 'unreadable';
      }
    }
    return 'ok';
  };

  let outcome: 'ok' | 'overflow' | 'unreadable';
  // A symlinked or junctioned root RESOLVES (review round): `lstat` reports a
  // junction as a symlink that is not a directory, which classified a real,
  // searchable root as `missing` — contradicting that verdict's documented
  // meaning ("does not exist") and losing every such record. Child links stay
  // recorded-never-followed; only the root itself is resolved, and a broken
  // link still falls through to `missing`.
  let effective = rootStat;
  if (rootStat.isSymbolicLink()) {
    try {
      effective = fs.statSync(absRoot);
    } catch {
      return { status: 'missing' };
    }
  }
  if (effective.isFile()) {
    const rootName = path.basename(absRoot).replace(/\\/g, '/');
    // The file-root branch bypassed the exclusion entirely, so a search rooted
    // at `.cortex.state` censused Cortex's own exhaust (review round).
    if (isExcludedBasename(rootName)) {
      return { status: 'unreadable' };
    }
    outcome = addFile(absRoot, rootName, effective.size);
  } else if (effective.isDirectory()) {
    outcome = walk(absRoot, '');
  } else {
    return { status: 'missing' };
  }

  if (outcome !== 'ok') {
    return { status: outcome };
  }

  // Directory recursion emits children in sorted order per level, which is
  // already a total order over rel paths within one walk — the explicit sort
  // makes the ORDER a property of the output rather than of the traversal, so
  // a future traversal change cannot silently change existing fingerprints.
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.line);
    hash.update('\u0000\u0000');
  }
  return {
    status: 'ok',
    sha256: hash.digest('hex'),
    files: entries.length,
    bytes: totalBytes,
    excludedCortex,
  };
}
