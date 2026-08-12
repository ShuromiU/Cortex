export type MemoryReferenceType = 'file' | 'absolute_path';

export interface ExtractedMemoryReference {
  referenceType: MemoryReferenceType;
  rawReference: string;
  normalizedPath: string;
}

const WINDOWS_ABSOLUTE_START_PATTERN = /[A-Za-z]:[\\/]/g;
/**
 * `~` belongs in the excluded lookbehind set. Without it the leading tilde of
 * `~/.claude/CLAUDE.md` fell outside the match and the reference was stored as
 * `/.claude/CLAUDE.md` — an absolute-looking path that resolves against
 * nothing, so a correct memory rendered as `[stale: missing …]` and was
 * dropped from the working set by `state.ts`. See HOME_RELATIVE_PATTERN.
 */
const POSIX_ABSOLUTE_PATTERN = /(?<![A-Za-z0-9_.@~-])\/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,10}/g;
/**
 * Home-relative references (`~/.claude/settings.json`) are root-anchored like
 * an absolute path, just at a root only the shell knows — so they are typed
 * `absolute_path` and never looked up in a scope's app graph. The tilde is
 * kept in the stored path so memory reads back what the note actually said;
 * expansion happens once, at the filesystem boundary in
 * `query/reference-validation.ts`.
 */
const HOME_RELATIVE_PATTERN =
  /(?<![A-Za-z0-9_.@-])~[\\/](?:[A-Za-z0-9_.@-]+[\\/])*[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,10}/g;
const RELATIVE_PATH_PATTERN =
  /(?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+(?:[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,10})/g;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;
/**
 * Spans that look like a path but are not rooted anywhere checkable. No
 * reference may be extracted from them — not by the absolute pass, and not by
 * the relative one either.
 *
 * Rejecting every match that BEGINS inside the span is what makes the
 * suppression real. Each pattern scans the full text independently, so
 * blocking only the posix-absolute pass moves the defect rather than fixing
 * it: `<worktree>/.nexus/overlay.db` would stop yielding `/.nexus/overlay.db`
 * and start yielding `.nexus/overlay.db`, still absent from the scope's app
 * graph, still `missing`, still dropped from the working set by `state.ts`.
 * Simulated over every live store on 2026-08-12, a lookbehind-only fix
 * introduced 170 such replacements.
 *
 * Rejection is by offset and not by blanking the span out of the text, which
 * was tried and rejected: `collectWindowsAbsoluteReferences` scans from a
 * drive letter to the first extension followed by a boundary, so deleting a
 * URL's `.git` lets that scan run on to the next extension. Measured over the
 * same stores, blanking moved 600 references that have nothing to do with this
 * defect. Only a match that starts inside a span is this pattern's business; a
 * pre-existing over-long Windows match that merely ends inside one is left
 * exactly as it was.
 *
 * Unlike `~`, these roots cannot be expanded instead: `<worktree>` has no
 * value at validation time. Four measured producers, every one of them
 * emitting a leading-slash path, and not one of the 174 rows they account for
 * has ever resolved to a file:
 *  - a URL authority — `https://github.com/obra/superpowers.git` (157 rows)
 *  - a placeholder root — `<worktree>/`, `${HOME}/`, `{root}/`, `%APPDATA%/` (8)
 *  - a concatenation fragment — `homedir()+'/.claude/settings.json'` (7)
 *  - a glob root — a doubled star before the separator, as `rg -g` writes (2)
 *
 * The fragment rule keys on the `+`, never on the quote. A quoted absolute
 * path that is not being concatenated stays extracted, because
 * `open('/tmp/_allow.sql')` is the shape behind the only quote-preceded
 * references on this machine that do resolve.
 */
const UNROOTED_SPAN_PATTERN =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|<[^<>\s\\/]*>[\\/]|\$?\{[^{}\s\\/]*\}[\\/]|%[A-Za-z0-9_]+%[\\/]|\*+[\\/]|\+\s*["'`][\\/])[A-Za-z0-9_.@$%:~+\\/-]*/g;

interface TextSpan {
  start: number;
  end: number;
}

/** A match is discarded when it BEGINS inside an unrooted span. */
function unrootedSpans(text: string): TextSpan[] {
  return Array.from(text.matchAll(UNROOTED_SPAN_PATTERN), match => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  });
}

function beginsInsideSpan(index: number, spans: TextSpan[]): boolean {
  return spans.some(span => index >= span.start && index < span.end);
}

function trimReference(raw: string): string {
  return raw
    .replace(/^[([{<]+/, '')
    .replace(/:\d+(?::\d+)?$/g, '')
    .replace(/[)\]}>,.;:'"!]+$/g, '');
}

function normalizeReference(raw: string): string {
  let normalized = trimReference(raw).replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function isAbsoluteReference(normalized: string): boolean {
  return (
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('~/')
  );
}

/** A candidate reference plus where it started, so spans can reject it. */
interface RawMatch {
  value: string;
  index: number;
}

function collectMatches(text: string, pattern: RegExp): RawMatch[] {
  return Array.from(text.matchAll(pattern), match => ({
    value: match[0],
    index: match.index ?? 0,
  }));
}

function isReferenceBoundary(value: string | undefined): boolean {
  return value === undefined || /\s|[)"'\],.;]/.test(value);
}

function collectWindowsAbsoluteReferences(text: string): RawMatch[] {
  const matches: RawMatch[] = [];

  for (const startMatch of text.matchAll(WINDOWS_ABSOLUTE_START_PATTERN)) {
    const startIndex = startMatch.index ?? 0;
    const rest = text.slice(startIndex).split(/\r?\n/, 1)[0] ?? '';
    FILE_EXTENSION_PATTERN.lastIndex = 0;

    for (const extMatch of rest.matchAll(FILE_EXTENSION_PATTERN)) {
      const extEnd = (extMatch.index ?? 0) + extMatch[0].length;
      const nextChar = rest[extEnd];
      if (nextChar === '/' || nextChar === '\\' || !isReferenceBoundary(nextChar)) {
        continue;
      }

      matches.push({ value: rest.slice(0, extEnd), index: startIndex });
      break;
    }
  }

  return matches;
}

export function extractMemoryReferences(...parts: Array<string | null | undefined>): ExtractedMemoryReference[] {
  const text = parts.filter((part): part is string => typeof part === 'string').join('\n');
  const spans = unrootedSpans(text);
  // Home-relative before relative: `~/.claude/CLAUDE.md` must reach
  // `absolutePaths` first so the relative pass's `.claude/CLAUDE.md` is
  // suppressed as the duplicate it is.
  const rawMatches = [
    ...collectWindowsAbsoluteReferences(text),
    ...collectMatches(text, HOME_RELATIVE_PATTERN),
    ...collectMatches(text, POSIX_ABSOLUTE_PATTERN),
    ...collectMatches(text, RELATIVE_PATH_PATTERN),
  ].filter(match => !beginsInsideSpan(match.index, spans));
  const seen = new Set<string>();
  const absolutePaths = new Set<string>();
  const refs: ExtractedMemoryReference[] = [];

  for (const { value: raw } of rawMatches) {
    const rawReference = trimReference(raw);
    const normalizedPath = normalizeReference(rawReference);
    if (!normalizedPath.includes('/') || seen.has(normalizedPath)) {
      continue;
    }

    const absolute = isAbsoluteReference(normalizedPath);
    if (!absolute && Array.from(absolutePaths).some(abs => abs.includes(normalizedPath))) {
      continue;
    }

    seen.add(normalizedPath);
    if (absolute) {
      absolutePaths.add(normalizedPath);
    }
    refs.push({
      referenceType: absolute ? 'absolute_path' : 'file',
      rawReference,
      normalizedPath,
    });
  }

  return refs;
}
