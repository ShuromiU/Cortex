// Text primitives shared by the memory layer and the query layer above it.
//
// These live here rather than in `query/` because the write path needs them:
// AD-1 lets `db/` import `memory/` for text shaping, but never `query/`.
// Query-specific tokenization (`tokenizeTopic`, `countTokenHits`) stays in
// `src/query/tokenize.ts`, which re-exports this module's surface unchanged.

export const TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gi;

const VOWEL_PATTERN = /[aeiouy]/;
const MIN_STEM_LENGTH = 3;

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
