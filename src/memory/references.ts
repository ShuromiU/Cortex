export type MemoryReferenceType = 'file' | 'absolute_path';

export interface ExtractedMemoryReference {
  referenceType: MemoryReferenceType;
  rawReference: string;
  normalizedPath: string;
}

const WINDOWS_ABSOLUTE_START_PATTERN = /[A-Za-z]:[\\/]/g;
const POSIX_ABSOLUTE_PATTERN = /(?<![A-Za-z0-9_.@-])\/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,10}/g;
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
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
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
  const rawMatches = [
    ...collectWindowsAbsoluteReferences(text),
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
