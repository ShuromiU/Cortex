// Contradiction detection over note content (FR-1).
//
// Deterministic, offline, synchronous, and free of any database handle — it
// takes two strings and returns a verdict. It lives in `memory/` rather than
// `query/` (where ARCHITECTURE-SPINE.md sketched it) because detection runs on
// the *write* path, inside `CortexStore.insertNote`, and AD-1 forbids `db/`
// importing `query/`. Both `db/` and `query/` may import `memory/`.
//
// The detector is deliberately conservative. PRD risk R-5 is that false
// positives turn contradiction detection into noise the user learns to ignore,
// and SM-5 reads a low conflict-resolution rate as evidence the detector is
// wrong rather than that users are lazy. So it reports a contradiction only on
// an explicit polarity flip over demonstrably shared context. Divergent choices
// ("use postgres" vs "use mysql") produce nothing — see NOT DETECTED below.

import { TOKEN_PATTERN, stemLite } from './text.js';

export interface ContradictionEvidence {
  signal: 'negation' | 'antonym';
  /** The token(s) carrying the polarity flip — for tests and SM-5 diagnosis. */
  trigger: string;
}

const TOKEN_SPLIT_PATTERN = /[._/-]+/g;
const APOSTROPHES = /['’]/g;

/**
 * Explicit negators. `TOKEN_PATTERN` has no apostrophe in its character class,
 * so contractions are normalized to their squashed form before tokenizing
 * ("don't" -> "dont") and listed that way here.
 */
const NEGATORS = new Set([
  'not',
  'no',
  'never',
  'none',
  'neither',
  'nor',
  'dont',
  'doesnt',
  'didnt',
  'cannot',
  'cant',
  'wont',
  'shouldnt',
  'isnt',
  'arent',
  'without',
  'avoid',
]);

/**
 * Curated technical opposites. Small and hand-picked on purpose: every pair
 * added here is a new way to produce a false positive, so a pair earns its
 * place only when the two members are genuinely mutually exclusive in the same
 * sentence. `on`/`off` was considered and rejected — `on` is overwhelmingly a
 * preposition, and `enable`/`disable` already covers the toggle case.
 */
const RAW_ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['enable', 'disable'],
  ['add', 'remove'],
  ['allow', 'deny'],
  ['include', 'exclude'],
  ['keep', 'drop'],
  ['always', 'never'],
  ['required', 'optional'],
  ['sync', 'async'],
  ['accept', 'reject'],
  ['start', 'stop'],
  ['show', 'hide'],
  ['increase', 'decrease'],
  ['true', 'false'],
];

interface AntonymPair {
  /** Stems, for matching against analyzed token sets. */
  left: string;
  right: string;
  /** Original spelling, for the human-readable trigger. */
  label: string;
}

const ANTONYM_PAIRS: readonly AntonymPair[] = RAW_ANTONYM_PAIRS.map(([a, b]) => ({
  left: stemLite(a),
  right: stemLite(b),
  label: `${a}/${b}`,
}));

/** Every token that participates in polarity, excluded from the shared core. */
const POLARITY_TOKENS = new Set<string>([
  ...NEGATORS,
  ...ANTONYM_PAIRS.flatMap(pair => [pair.left, pair.right]),
]);

/**
 * Structural words carry no claim, so they must not count toward shared
 * context — otherwise "the spool is appended by bash" and "the reflex is not
 * appended by node" overlap at 67% on `the`/`is`/`by` and read as a
 * contradiction. This is deliberately NOT `tokenize.ts`'s `LOW_SIGNAL_TOKENS`:
 * that set strips `without`, `do`, `does` and `did`, which are exactly the
 * polarity carriers this module exists to read. Nothing here may appear in
 * `POLARITY_TOKENS` — asserted below.
 */
const STRUCTURAL_STOPWORDS = new Set(
  [
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'by', 'for', 'of', 'to', 'in', 'into', 'at', 'with', 'from', 'as',
    'on', 'off', 'over', 'under', 'per', 'via', 'and', 'or', 'but', 'so',
    'if', 'then', 'than', 'that', 'this', 'these', 'those', 'it', 'its',
    'we', 'our', 'us', 'you', 'your', 'they', 'their', 'them',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
    'could', 'can', 'may', 'might', 'must', 'shall',
    'all', 'any', 'some', 'each', 'every', 'both', 'other', 'more', 'most',
    'less', 'least', 'very', 'just', 'only', 'also', 'too', 'still', 'yet',
    'now', 'here', 'there', 'when', 'while', 'where', 'before', 'after',
  ].map(stemLite),
);

// A word cannot be both structural and polarity-bearing; if it were, the core
// filter and the polarity filter would disagree about what the claim is.
for (const token of POLARITY_TOKENS) {
  if (STRUCTURAL_STOPWORDS.has(token)) {
    throw new Error(`conflict.ts: "${token}" is both a polarity token and a stopword`);
  }
}

/** Both signals require this much shared context before they may fire. */
const MIN_SHARED_TOKENS = 2;
const MIN_OVERLAP_RATIO = 0.5;

interface Analyzed {
  /** Every stemmed token, polarity included. */
  all: Set<string>;
  /** Stemmed tokens with polarity carriers removed — the claim being made. */
  core: Set<string>;
}

function analyze(text: string): Analyzed {
  const normalized = text.toLowerCase().replace(APOSTROPHES, '');
  const matches = normalized.match(TOKEN_PATTERN) ?? [];
  const all = new Set<string>();
  const core = new Set<string>();

  for (const match of matches) {
    for (const part of match.split(TOKEN_SPLIT_PATTERN)) {
      if (part.length <= 1) continue;
      const stem = stemLite(part);
      all.add(stem);
      if (!POLARITY_TOKENS.has(stem) && !STRUCTURAL_STOPWORDS.has(stem)) {
        core.add(stem);
      }
    }
  }

  return { all, core };
}

/**
 * Do these two claims talk about the same thing? Guards both signals: without
 * it, "never commit baselines by hand" and "always run the linter" would read
 * as a contradiction on the strength of never/always alone.
 */
function sharesContext(a: Analyzed, b: Analyzed): boolean {
  if (a.core.size === 0 || b.core.size === 0) return false;

  let shared = 0;
  for (const token of a.core) {
    if (b.core.has(token)) shared++;
  }
  if (shared < MIN_SHARED_TOKENS) return false;

  return shared / Math.min(a.core.size, b.core.size) >= MIN_OVERLAP_RATIO;
}

function negatorsIn(analyzed: Analyzed): string[] {
  return [...analyzed.all].filter(token => NEGATORS.has(token));
}

/**
 * Report whether `incoming` opposes `prior`.
 *
 * DETECTED:
 *   - negation asymmetry — exactly one side negates an otherwise shared claim
 *   - antonym flip — one side says A, the other says B, over a shared claim
 *
 * NOT DETECTED (deliberate, do not "fix" these):
 *   - divergent choices ("use postgres" / "use mysql") — no polarity marker
 *   - refinements ("use postgres" / "use postgres with pooling")
 *   - both sides negated — they agree
 *   - a polarity flip over unrelated content — fails the shared-context gate
 *
 * Adding a "different content" fallback would make this `consolidate.ts`'s
 * promotion predicate, which is far too loose for FR-1.
 */
export function detectContradiction(
  prior: string,
  incoming: string,
): ContradictionEvidence | null {
  const a = analyze(prior);
  const b = analyze(incoming);

  if (!sharesContext(a, b)) return null;

  // Signal 1 — negation asymmetry. Both sides negated means they agree.
  const priorNegators = negatorsIn(a);
  const incomingNegators = negatorsIn(b);
  if (priorNegators.length > 0 !== incomingNegators.length > 0) {
    const trigger = (priorNegators.length > 0 ? priorNegators : incomingNegators)
      .sort()
      .join(',');
    return { signal: 'negation', trigger };
  }

  // Signal 2 — antonym flip. A side holding both members states a position
  // about both cases rather than taking one side of a disagreement.
  for (const { left, right, label } of ANTONYM_PAIRS) {
    const priorHasBoth = a.all.has(left) && a.all.has(right);
    const incomingHasBoth = b.all.has(left) && b.all.has(right);
    if (priorHasBoth || incomingHasBoth) continue;

    const flipped =
      (a.all.has(left) && b.all.has(right)) || (a.all.has(right) && b.all.has(left));
    if (flipped) {
      return { signal: 'antonym', trigger: label };
    }
  }

  return null;
}
