export const TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gi;
const TOKEN_SPLIT_PATTERN = /[._/-]+/g;

const LOW_SIGNAL_TOKENS = new Set([
  'a',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'continue',
  'could',
  'did',
  'do',
  'does',
  'fix',
  'fixed',
  'fixes',
  'fixing',
  'for',
  'from',
  'has',
  'have',
  'implement',
  'implemented',
  'implementation',
  'in',
  'is',
  'it',
  'just',
  'latest',
  'now',
  'of',
  'old',
  'on',
  'or',
  'plan',
  'please',
  'recent',
  'resolved',
  'should',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'when',
  'will',
  'with',
  'without',
  'work',
  'would',
]);

export interface TopicToken {
  raw: string;
  stem: string;
}

const VOWEL_PATTERN = /[aeiouy]/;
const MIN_STEM_LENGTH = 3;
const MAX_TOPIC_TOKENS = 12;

/**
 * Suffix-stripping stem tuned for substring matching against raw text: the
 * result must stay a common prefix of the token's inflected forms (so
 * "testing" -> "test" matches "test", "tested", "tests" via `includes`).
 * Intentionally close to the FTS5 porter tokenizer for hit counting, but it
 * never needs to agree exactly — both raw and stem are tried.
 */
export function stemLite(token: string): string {
  let stem = token;

  // Pass 1: plural family.
  if (stem.endsWith('sses')) {
    stem = stem.slice(0, -4) + 'ss';
  } else if (stem.endsWith('ies') && stem.length - 3 >= MIN_STEM_LENGTH) {
    stem = stem.slice(0, -3);
  } else if (
    stem.endsWith('s') &&
    !stem.endsWith('ss') &&
    !stem.endsWith('us') &&
    !stem.endsWith('is') &&
    stem.length - 1 >= MIN_STEM_LENGTH
  ) {
    stem = stem.slice(0, -1);
  }

  // Pass 2: verb inflections.
  if (stem.endsWith('ing') && stem.length - 3 >= MIN_STEM_LENGTH) {
    const base = stem.slice(0, -3);
    if (VOWEL_PATTERN.test(base)) {
      stem = base;
    }
  } else if (stem.endsWith('ed') && stem.length - 2 >= MIN_STEM_LENGTH) {
    const base = stem.slice(0, -2);
    if (VOWEL_PATTERN.test(base)) {
      stem = base;
    }
  }

  // Pass 3: -ion nominalization ("rotation" -> "rotat" matches "rotate").
  if (stem.endsWith('ion') && stem.length - 3 >= MIN_STEM_LENGTH) {
    const base = stem.slice(0, -3);
    if (VOWEL_PATTERN.test(base)) {
      stem = base;
    }
  }

  // Pass 4: trailing 'e' hides inflections from substring matching ("rotate"
  // misses "rotating"); drop it once the stem stays distinctive without it.
  if (stem.endsWith('e') && stem.length - 1 >= MIN_STEM_LENGTH + 1) {
    stem = stem.slice(0, -1);
  }

  return stem;
}

export function tokenizeTopic(topic: string): TopicToken[] {
  const matches = topic.toLowerCase().match(TOKEN_PATTERN) ?? [];
  const parts = matches.flatMap(match => match.split(TOKEN_SPLIT_PATTERN));
  const seen = new Set<string>();
  const tokens: TopicToken[] = [];

  for (const part of parts) {
    if (part.length <= 1 || LOW_SIGNAL_TOKENS.has(part) || seen.has(part)) {
      continue;
    }
    seen.add(part);
    tokens.push({ raw: part, stem: stemLite(part) });
    if (tokens.length >= MAX_TOPIC_TOKENS) {
      break;
    }
  }

  return tokens;
}

/** Count tokens that match the text via raw or stemmed form (each token at most once). */
export function countTokenHits(text: string, tokens: TopicToken[]): number {
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token.raw) || (token.stem !== token.raw && text.includes(token.stem))) {
      hits++;
    }
  }
  return hits;
}

export function tokenMatchesText(text: string, token: TopicToken): boolean {
  return text.includes(token.raw) || (token.stem !== token.raw && text.includes(token.stem));
}
