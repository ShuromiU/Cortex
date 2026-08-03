import * as crypto from 'node:crypto';
import { normalizeFilePathKey, toScopeRelativeKey } from '../scope/keys.js';

/**
 * The negative cache's query identity and certifiability gates (FR-12,
 * Story 4.3) — shared verbatim by the capture flush (which records) and the
 * search ledger (which answers), and living at the capture layer because
 * layer direction forbids `capture/` importing `query/` while the reverse is
 * established precedent (`read-ledger` → `capture/digest`).
 */

/**
 * A pattern is certifiable only when it cannot be an invalid regex — plain
 * word-ish literals. This is not cosmetic: Claude Code < 2.1.208 answers an
 * INVALID regex with a zero-shaped "no matches" response (changelog: "Grep
 * silently returning 'No files found' for invalid regex patterns"), and the
 * reference platform runs 2.1.170 — so without this gate, a typo'd regex
 * records a negative for a search that never ran (SM-C3). Characters that can
 * never fail to parse: word characters plus punctuation no regex dialect
 * treats as structural — and `.`, which is always valid and only WIDENS
 * matching, so a zero result under it implies a zero for the literal reading
 * and the record (keyed on the pattern string) stays correct. `$`, `^`, and
 * every bracketing/quantifier character stay out: some of them can fail to
 * parse, and the allowlist must be verifiable at a glance rather than a
 * dialect argument.
 */
export const CERTIFIABLE_PATTERN = /^[A-Za-z0-9_\-./:@#'", =]+$/;

/** Globs that cannot error: no braces (rg rejects unbalanced `{`), no `!`, no escapes. */
export const CERTIFIABLE_GLOB = /^[A-Za-z0-9_\-./*?]+$/;

/**
 * ripgrep built-in type names this cache will certify against. Deliberately a
 * short allowlist of types that exist in every rg version this could meet: an
 * unknown `--type` makes rg error, which pre-2.1.208 is zero-shaped (same bug
 * class as the pattern gate). Unlisted type → the search is simply never
 * certified; a miss, never a wrong answer.
 */
export const CERTIFIABLE_TYPES: ReadonlySet<string> = new Set([
  'c', 'cpp', 'css', 'go', 'html', 'java', 'js', 'json', 'md', 'php',
  'py', 'rb', 'rust', 'sh', 'sql', 'toml', 'ts', 'xml', 'yaml',
]);

/** The matching-relevant parameters. Output shaping (mode, limits, context) is excluded by design. */
export interface SearchQuery {
  pattern: string;
  /** Search root, scope-relative or absolute; '' or undefined = the scope root itself. */
  root?: string;
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
}

/**
 * NUL via fromCharCode rather than an escape: the one byte no path or pattern
 * can contain, and this spelling cannot be collapsed into a literal control
 * byte by any tool edit (the repo's control-byte rule, enforced by test).
 */
const NUL = String.fromCharCode(0);

/**
 * Stable, versioned serialization. The key hashes the RAW pattern — hashing
 * the redacted form would merge distinct secret-bearing searches — and the
 * hash is one-way, so the secret itself never persists. Root is normalized to
 * its stored (scope-relative, forward-slashed) form by the caller before this
 * runs; `canonicalSearchQuery` is deliberately dumb about paths.
 */
export function canonicalSearchQuery(q: SearchQuery): string {
  return [
    'v1',
    'grep',
    q.pattern,
    q.root ?? '',
    q.glob ?? '',
    q.type ?? '',
    q.caseInsensitive ? '1' : '0',
    q.multiline ? '1' : '0',
  ].join(NUL);
}

export function searchQueryKey(q: SearchQuery): string {
  return crypto.createHash('sha256').update(canonicalSearchQuery(q), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The stored form of a search root, shared verbatim by capture and query — one
 * function so the two sides cannot disagree on a key. `toScopeRelativeKey`
 * leaves an input equal to the scope root ABSOLUTE (its file callers never hit
 * that case); a search rooted at the scope root is the common default, and
 * without this fold the same semantic search would key two ways ('' when the
 * hook saw no path, the absolute root when a caller passed one).
 */
export function normalizeSearchRoot(root: string | undefined, scopeRoot: string | null): string {
  const raw = root ?? '';
  if (raw === '') return '';
  const key = toScopeRelativeKey(raw, scopeRoot);
  if (scopeRoot) {
    const rootKey = normalizeFilePathKey(scopeRoot).replace(/\/+$/, '');
    if (key === rootKey) return '';
  }
  return key;
}

/**
 * Whether a search's parameters are in the class this cache will assert about.
 * Anything outside degrades to a miss at capture time — never a wrong answer.
 */
export function isCertifiableSearch(q: SearchQuery): boolean {
  if (q.pattern.length === 0 || q.pattern.length > 512) return false;
  // A leading `-` is regex-valid but flag-shaped (review round): if the host
  // ever passes the pattern positionally rather than after `-e`/`--`, it parses
  // as an unknown option, the invocation errors, and a pre-2.1.208 host answers
  // errors with a zero-shaped response — recording a negative for a search that
  // never ran, undetectable by any later tree change. The allowlist's
  // glance-verifiability argument covers regex parsing only; this covers the
  // other way an argument can fail to mean what it says.
  if (q.pattern.startsWith('-')) return false;
  if (!CERTIFIABLE_PATTERN.test(q.pattern)) return false;
  if (q.glob !== undefined && q.glob !== '' && !CERTIFIABLE_GLOB.test(q.glob)) return false;
  if (q.type !== undefined && q.type !== '' && !CERTIFIABLE_TYPES.has(q.type)) return false;
  return true;
}
