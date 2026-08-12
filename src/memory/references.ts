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

function collectMatches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), match => match[0]);
}

function isReferenceBoundary(value: string | undefined): boolean {
  return value === undefined || /\s|[)"'\],.;]/.test(value);
}

function collectWindowsAbsoluteReferences(text: string): string[] {
  const matches: string[] = [];

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

      matches.push(rest.slice(0, extEnd));
      break;
    }
  }

  return matches;
}

export function extractMemoryReferences(...parts: Array<string | null | undefined>): ExtractedMemoryReference[] {
  const text = parts.filter((part): part is string => typeof part === 'string').join('\n');
  // Home-relative before relative: `~/.claude/CLAUDE.md` must reach
  // `absolutePaths` first so the relative pass's `.claude/CLAUDE.md` is
  // suppressed as the duplicate it is.
  const rawMatches = [
    ...collectWindowsAbsoluteReferences(text),
    ...collectMatches(text, HOME_RELATIVE_PATTERN),
    ...collectMatches(text, POSIX_ABSOLUTE_PATTERN),
    ...collectMatches(text, RELATIVE_PATH_PATTERN),
  ];
  const seen = new Set<string>();
  const absolutePaths = new Set<string>();
  const refs: ExtractedMemoryReference[] = [];

  for (const raw of rawMatches) {
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
