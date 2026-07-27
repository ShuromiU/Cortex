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
// wrong rather than that users are lazy. A false positive is not merely noisy
// here: it vetoes auto-supersede (AD-17), so both notes stay active and both
// keep rendering. Misses are the cheap failure; false alarms are not.

import { TOKEN_PATTERN, stemLite } from './text.js';

export interface ContradictionEvidence {
  signal: 'negation' | 'antonym';
  /** The token carrying the polarity flip — for tests and SM-5 diagnosis. */
  trigger: string;
}

const TOKEN_SPLIT_PATTERN = /[._/-]+/g;
const SPLIT_PROBE = /[._/-]/;
const APOSTROPHES = /['’]/g;

/**
 * Explicit negators, matched against the **raw** token only — never the stem.
 * `stemLite` strips `-ed`/`-ing`, so `noted` and `noting` both stem to `not`,
 * `avoided` to `avoid`, `canting` to `cant`. Matching on stems made "as noted
 * we cache X" a contradiction of "we cache X" — in a tool whose own write
 * confirmation is the word *Noted*.
 *
 * Contractions are listed squashed because apostrophes are stripped before
 * tokenizing ("don't" -> "dont"); `TOKEN_PATTERN` has no apostrophe in its
 * class and would otherwise split it into `don` + `t`.
 *
 * `without` and `avoid` were removed. Both are overwhelmingly scoping or
 * imperative rather than claim-negating — "a payload without an agent id
 * resolves to the primary session" negates nothing, and "avoid partial
 * batches" refines rather than contradicts.
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
  left: string;
  right: string;
  label: string;
}

const ANTONYM_PAIRS: readonly AntonymPair[] = RAW_ANTONYM_PAIRS.map(([a, b]) => ({
  left: stemLite(a),
  right: stemLite(b),
  label: `${a}/${b}`,
}));

/** Every stem that participates in polarity, excluded from the shared core. */
const POLARITY_STEMS = new Set<string>([
  ...[...NEGATORS].map(stemLite),
  ...ANTONYM_PAIRS.flatMap(pair => [pair.left, pair.right]),
]);

/**
 * Structural words carry no claim, so they must not count toward shared
 * context — otherwise "the spool is appended by bash" and "the reflex is not
 * appended by node" overlap on `the`/`is`/`by` and read as a contradiction.
 * This is deliberately NOT `tokenize.ts`'s `LOW_SIGNAL_TOKENS`: that set
 * strips `do`, `does` and `did`, which carry polarity here.
 */
export const STRUCTURAL_STOPWORDS = new Set(
  [
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'by', 'for', 'of', 'to', 'in', 'into', 'at', 'with', 'without', 'from', 'as',
    'on', 'off', 'over', 'under', 'per', 'via', 'and', 'or', 'but', 'so',
    'if', 'then', 'than', 'that', 'this', 'these', 'those', 'it', 'its',
    'we', 'our', 'us', 'you', 'your', 'they', 'their', 'them',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
    'could', 'can', 'may', 'might', 'must', 'shall',
    'all', 'any', 'some', 'each', 'every', 'both', 'other', 'more', 'most',
    'less', 'least', 'very', 'just', 'only', 'also', 'too', 'still', 'yet',
    'now', 'here', 'there', 'when', 'while', 'where', 'before', 'after',
    'between', 'during', 'because', 'about',
  ].map(stemLite),
);

/** Both signals require this much shared context before they may fire. */
const MIN_SHARED_TOKENS = 2;
const MIN_OVERLAP_RATIO = 0.5;

/**
 * An antonym flip only means something when the two claims are otherwise
 * near-identical. "the provider is required for rank mode" and "the provider
 * is optional for shadow mode" share most of their words and flip
 * required/optional, but they are about different modes and both are true.
 */
const ANTONYM_MIN_RATIO = 0.8;

/** How far past a negator to look for the predicate it governs. */
const NEGATION_SCOPE_WINDOW = 4;

/** Analyzing a note is linear in its length; cap it so a huge paste cannot stall a write. */
const MAX_ANALYZED_TOKENS = 4000;

interface Token {
  raw: string;
  stem: string;
  /** True when this came from splitting a compound (`no-op`, `src/a/no-op.ts`). */
  fromSplit: boolean;
}

export interface AnalyzedNote {
  tokens: Token[];
  all: Set<string>;
  core: Set<string>;
}

/**
 * Tokenize, stem, and partition a note.
 *
 * Exported so the write path can analyze the incoming note once and reuse it
 * across every candidate prior instead of re-analyzing per comparison.
 */
export function analyzeNote(text: string): AnalyzedNote {
  const normalized = text.toLowerCase().replace(APOSTROPHES, '');
  const matches = normalized.match(TOKEN_PATTERN) ?? [];
  const tokens: Token[] = [];
  const all = new Set<string>();
  const core = new Set<string>();

  for (const match of matches) {
    const fromSplit = SPLIT_PROBE.test(match);
    for (const part of match.split(TOKEN_SPLIT_PATTERN)) {
      if (part.length <= 1) continue;
      if (tokens.length >= MAX_ANALYZED_TOKENS) return { tokens, all, core };
      const stem = stemLite(part);
      tokens.push({ raw: part, stem, fromSplit });
      all.add(stem);
      if (!POLARITY_STEMS.has(stem) && !STRUCTURAL_STOPWORDS.has(stem)) {
        core.add(stem);
      }
    }
  }

  return { tokens, all, core };
}

function isNegator(token: Token): boolean {
  // A fragment of a compound is not a negation. Splitting `no-op` or
  // `--no-verify` or `src/capture/no-op.ts` yields a bare `no` that negates
  // nothing — and worse, when both sides carry it they read as agreeing,
  // which silently suppressed real contradictions.
  return !token.fromSplit && NEGATORS.has(token.raw);
}

function isCarrier(token: Token): boolean {
  return POLARITY_STEMS.has(token.stem) || STRUCTURAL_STOPWORDS.has(token.stem);
}

/**
 * The predicate a negator governs: the first contentful token after it.
 * "we do not **cache** the brief" -> `cach`.
 */
function negatedHeads(analyzed: AnalyzedNote): string[] {
  const heads: string[] = [];
  for (let i = 0; i < analyzed.tokens.length; i++) {
    if (!isNegator(analyzed.tokens[i]!)) continue;
    const limit = Math.min(analyzed.tokens.length, i + 1 + NEGATION_SCOPE_WINDOW);
    for (let j = i + 1; j < limit; j++) {
      const candidate = analyzed.tokens[j]!;
      if (isCarrier(candidate)) continue;
      heads.push(candidate.stem);
      break;
    }
  }
  return heads;
}

function sharedCount(a: AnalyzedNote, b: AnalyzedNote): number {
  let shared = 0;
  for (const token of a.core) {
    if (b.core.has(token)) shared++;
  }
  return shared;
}

/**
 * Do these two claims talk about the same thing? The denominator is the
 * *larger* core: dividing by the smaller one let any short note be "contained"
 * in a longer one, and since detection only ever runs against priors that
 * already share a subject, that made the gate a formality.
 */
function overlapRatio(a: AnalyzedNote, b: AnalyzedNote): number {
  if (a.core.size === 0 || b.core.size === 0) return 0;
  return sharedCount(a, b) / Math.max(a.core.size, b.core.size);
}

/**
 * Report whether `incoming` opposes `prior`.
 *
 * DETECTED:
 *   - negation asymmetry — exactly one side negates a predicate the other
 *     side also asserts
 *   - antonym flip — one side says A, the other says B, over near-identical
 *     remaining content
 *
 * NOT DETECTED (deliberate — do not "fix" these):
 *   - divergent choices ("use postgres" / "use mysql") — no polarity marker
 *   - refinements ("use postgres" / "use postgres, not mysql") — the negation
 *     governs `mysql`, which the other side never mentions
 *   - added caveats ("... at turn end" / "... at turn end, no exceptions")
 *   - both sides negated — they agree
 *   - a polarity flip over unrelated content — fails the shared-context gate
 *
 * KNOWN LIMIT: `TOKEN_PATTERN` is ASCII-only, so non-Latin content analyzes to
 * an empty core and never conflicts. A silent miss, consistent with the
 * conservative posture, but it is a miss.
 */
export function detectContradiction(
  prior: string,
  incoming: string,
): ContradictionEvidence | null {
  return compareAnalyzed(analyzeNote(prior), analyzeNote(incoming));
}

/** `detectContradiction` over pre-analyzed notes, for callers comparing many priors. */
export function compareAnalyzed(
  a: AnalyzedNote,
  b: AnalyzedNote,
): ContradictionEvidence | null {
  if (a.core.size === 0 || b.core.size === 0) return null;
  if (sharedCount(a, b) < MIN_SHARED_TOKENS) return null;

  const ratio = overlapRatio(a, b);
  if (ratio < MIN_OVERLAP_RATIO) return null;

  // Signal 1 — scoped negation asymmetry. A negation only contradicts when it
  // attaches to a predicate the other note actually asserts; otherwise it is
  // negating something the other note never claimed.
  const priorNegations = negatedHeads(a).filter(head => b.all.has(head));
  const incomingNegations = negatedHeads(b).filter(head => a.all.has(head));
  if (priorNegations.length > 0 !== incomingNegations.length > 0) {
    const heads = priorNegations.length > 0 ? priorNegations : incomingNegations;
    return { signal: 'negation', trigger: [...new Set(heads)].sort().join(',') };
  }

  // Signal 2 — antonym flip, held to a tighter overlap bar (see
  // ANTONYM_MIN_RATIO). A side holding both members states a position about
  // both cases rather than taking one side of a disagreement.
  if (ratio >= ANTONYM_MIN_RATIO) {
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
  }

  return null;
}

/**
 * No token may be both structural and polarity-bearing — the core filter and
 * the polarity filter would disagree about what the claim is. Exported and
 * asserted by a unit test rather than thrown at module load: `db/store.ts`
 * imports this module, so a load-time throw would fire on the capture path,
 * where project-context requires that a memory failure never break the turn.
 */
export function polarityStopwordOverlap(): string[] {
  return [...POLARITY_STEMS].filter(stem => STRUCTURAL_STOPWORDS.has(stem));
}

/** Exposed for the coverage test that pins the negator list against stem collisions. */
export const NEGATOR_SURFACE_FORMS: readonly string[] = [...NEGATORS];
