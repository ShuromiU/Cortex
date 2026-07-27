import { describe, it, expect } from 'vitest';
import {
  detectContradiction,
  polarityStopwordOverlap,
  NEGATOR_SURFACE_FORMS,
} from '../src/memory/conflict.js';
import { stemLite } from '../src/memory/text.js';

describe('detectContradiction — negation asymmetry', () => {
  it('fires when exactly one side negates a shared claim', () => {
    const result = detectContradiction(
      'we cache the session brief between runs',
      'we do not cache the session brief between runs',
    );
    expect(result).not.toBeNull();
    expect(result?.signal).toBe('negation');
  });

  it('fires regardless of which side carries the negator', () => {
    const forward = detectContradiction(
      'never retry the flaky upload step',
      'retry the flaky upload step',
    );
    const reverse = detectContradiction(
      'retry the flaky upload step',
      'never retry the flaky upload step',
    );
    expect(forward?.signal).toBe('negation');
    expect(reverse?.signal).toBe('negation');
  });

  it('does NOT fire when both sides are negated', () => {
    // "don't cache X" vs "never cache X" agree. A polarity *count* would
    // wrongly flag this; only an asymmetry is a contradiction.
    expect(
      detectContradiction(
        'do not cache the session brief between runs',
        'never cache the session brief between runs',
      ),
    ).toBeNull();
  });

  it('detects apostrophe contractions', () => {
    // TOKEN_PATTERN excludes apostrophes, so "don't" tokenizes to don + t
    // unless apostrophes are stripped first. Without the strip this returns null.
    const result = detectContradiction(
      "we don't vendor the sqlite binary into the package",
      'we vendor the sqlite binary into the package',
    );
    expect(result).not.toBeNull();
    expect(result?.signal).toBe('negation');
  });

  it('matches across inflections via stemming', () => {
    const result = detectContradiction(
      'the flush validates every spooled entry',
      'the flush does not validate every spooled entry',
    );
    expect(result?.signal).toBe('negation');
  });
});

describe('detectContradiction — antonym pairs', () => {
  it('fires on an opposed pair over shared context', () => {
    const result = detectContradiction(
      'enable the semantic reranker for branch scoped recall',
      'disable the semantic reranker for branch scoped recall',
    );
    expect(result).not.toBeNull();
    expect(result?.signal).toBe('antonym');
    expect(result?.trigger).toContain('enable');
  });

  it('does NOT fire when one side contains both members of the pair', () => {
    // "we enable it in dev and disable it in CI" is a single coherent position,
    // not half of a disagreement.
    expect(
      detectContradiction(
        'enable the reranker in dev and disable the reranker in ci',
        'disable the reranker in ci',
      ),
    ).toBeNull();
  });
});

describe('detectContradiction — the shared-context gate', () => {
  it('does NOT fire on a polarity flip over unrelated content', () => {
    // Both carry a polarity marker, but they are about different things.
    // Without the overlap gate this is a false positive.
    expect(
      detectContradiction(
        'never commit generated baselines by hand',
        'always run the linter before pushing',
      ),
    ).toBeNull();
  });

  it('does NOT fire when overlap is a single incidental token', () => {
    expect(
      detectContradiction(
        'the spool is appended by bash',
        'the reflex is not appended by node',
      ),
    ).toBeNull();
  });

  it('requires at least two shared tokens even when the ratio passes', () => {
    // Cores are {cach, brief} and {cach, session}: one shared token out of two,
    // so the ratio is exactly 0.5 and clears MIN_OVERLAP_RATIO. Only the
    // absolute MIN_SHARED_TOKENS floor blocks this. Pins that floor at 2 —
    // lowering it to 1 makes this pair a contradiction.
    expect(detectContradiction('cache briefs', 'do not cache sessions')).toBeNull();
  });

  it('requires half the smaller core to be shared even when the count passes', () => {
    // Cores are 5 tokens each sharing {stemm, token}: the count clears
    // MIN_SHARED_TOKENS, and only the 0.5 ratio blocks it. Pins the ratio —
    // dropping it to 0 makes this pair a contradiction.
    expect(
      detectContradiction(
        'reranker counts stemmed token hits',
        'the flush does not validate stemmed token digests',
      ),
    ).toBeNull();
  });
});

describe('detectContradiction — deliberate false negatives', () => {
  it('does NOT treat a divergent choice as a contradiction', () => {
    // R-5 / SM-5: conservative by design. "use X" vs "use Y" carries no
    // polarity marker. Flagging it would make the detector noise.
    expect(
      detectContradiction(
        'use postgres for the primary store',
        'use mysql for the primary store',
      ),
    ).toBeNull();
  });

  it('does NOT treat a refinement as a contradiction', () => {
    expect(
      detectContradiction(
        'use postgres for the primary store',
        'use postgres for the primary store with connection pooling',
      ),
    ).toBeNull();
  });

  it('does NOT fire on identical content', () => {
    const text = 'the gate runs on every push to the branch';
    expect(detectContradiction(text, text)).toBeNull();
  });

  it('does NOT fire on empty or whitespace content', () => {
    expect(detectContradiction('', 'we do not cache anything')).toBeNull();
    expect(detectContradiction('   ', '   ')).toBeNull();
  });
});

describe('detectContradiction — determinism', () => {
  it('returns an identical verdict across repeated calls', () => {
    const a = 'we cache the session brief between runs';
    const b = 'we do not cache the session brief between runs';
    const first = detectContradiction(a, b);
    for (let i = 0; i < 25; i++) {
      expect(detectContradiction(a, b)).toEqual(first);
    }
  });

  it('is symmetric — argument order does not change the verdict', () => {
    const a = 'enable the semantic reranker for branch scoped recall';
    const b = 'disable the semantic reranker for branch scoped recall';
    expect(detectContradiction(a, b)?.signal).toBe(detectContradiction(b, a)?.signal);
  });
});

// ── Review regressions (story 1.1, round 2) ──────────────────────────
//
// Every case below was a reported false positive or a suppressed true
// positive found by the three review layers, grouped by root cause.

describe('detectContradiction — negation must scope the shared claim', () => {
  const REFINEMENTS: Array<[string, string, string]> = [
    ['negates content the other side never mentions',
      'use postgres for the primary store',
      'use postgres for the primary store, not mysql'],
    ['adds a caveat with "without"',
      'the gate runs every locked suite against its baseline',
      'the gate runs every locked suite against its baseline without regenerating'],
    ['asserts an orthogonal property',
      'the spool flush is idempotent',
      'the spool flush is not re-entrant'],
    ['adds an imperative with "avoid"',
      'validate every spooled entry before replay',
      'validate every spooled entry before replay, avoid partial batches'],
    ['adds a trailing "no other" clause',
      'the reflex emits additional context for focus shifts',
      'the reflex emits additional context for focus shifts and no other trigger'],
    ['adds a trailing "no exceptions" clause',
      'we flush the spool at turn end',
      'we flush the spool at turn end, no exceptions'],
    ['uses "without" as a scoping preposition',
      'a session is identified by scope key and agent id',
      'a payload without an agent id resolves to the primary session'],
    ['negates a different predicate on the same subject',
      'semantic mode defaults to off for every project',
      'semantic mode shadow does not change returned results'],
  ];

  for (const [name, prior, incoming] of REFINEMENTS) {
    it(`does NOT fire when the incoming note ${name}`, () => {
      expect(detectContradiction(prior, incoming)).toBeNull();
    });
  }

  it('still fires when the negation lands on a predicate both sides assert', () => {
    expect(
      detectContradiction(
        'we cache the rendered session brief between runs',
        'we do not cache the rendered session brief between runs',
      )?.signal,
    ).toBe('negation');
  });
});

describe('detectContradiction — negators match surface forms, never stems', () => {
  // stemLite strips -ed/-ing, so "noted" and "noting" both stem to "not",
  // "avoided" to "avoid", "canting" to "cant". Matching negators on the stem
  // made "as noted we cache X" contradict "we cache X" — in a tool whose own
  // write confirmation is the word Noted.
  it('does NOT treat "noted" as a negation', () => {
    expect(
      detectContradiction(
        'we cache the session brief between runs',
        'as noted we cache the session brief between runs',
      ),
    ).toBeNull();
  });

  it('does NOT treat "noting" as a negation', () => {
    expect(
      detectContradiction(
        'the flush validates every spooled entry',
        'noting that the flush validates every spooled entry',
      ),
    ).toBeNull();
  });

  it('pins why the lookup uses the raw token: stems still collide', () => {
    // stemLite is unchanged and still maps these onto negators. That is the
    // hazard, not the bug — the bug was looking negators up BY stem. If anyone
    // "simplifies" isNegator back to stem matching, these words become
    // negations again.
    expect(stemLite('noted')).toBe('not');
    expect(stemLite('noting')).toBe('not');
    expect(NEGATOR_SURFACE_FORMS).toContain('not');
  });

  it('does NOT treat any ordinary -ed/-ing word that stems to a negator as one', () => {
    // Class-level behavioral guard: for every negator whose -ed/-ing form
    // stems back onto it, that inflected word must not flip polarity.
    const hazards = NEGATOR_SURFACE_FORMS.flatMap(negator =>
      [`${negator}ed`, `${negator}ing`].filter(
        inflected => NEGATOR_SURFACE_FORMS.includes(stemLite(inflected)),
      ),
    );
    expect(hazards.length).toBeGreaterThan(0); // the hazard class is non-empty

    const misfires = hazards.filter(
      word =>
        detectContradiction(
          'we cache the session brief between runs',
          `${word} we cache the session brief between runs`,
        ) !== null,
    );
    expect(misfires).toEqual([]);
  });
});

describe('detectContradiction — compound fragments are not negators', () => {
  // TOKEN_SPLIT_PATTERN splits on [._/-], so "no-op", "--no-verify" and
  // "src/capture/no-op.ts" all yield a bare "no".
  it('does NOT fire on a --no-verify flag name', () => {
    expect(
      detectContradiction(
        'push with --no-verify only when the hook itself is broken',
        'push with --strict only when the hook itself is broken',
      ),
    ).toBeNull();
  });

  it('does NOT fire on a no-op path segment', () => {
    expect(
      detectContradiction(
        'the spool writer lives in src/capture/no-op.ts today',
        'the spool writer lives in src/capture/batch.ts today',
      ),
    ).toBeNull();
  });

  it('does NOT fire on "no-op" used as a term', () => {
    expect(
      detectContradiction(
        'a second flush of a claimed batch is a no-op',
        'a second flush of a claimed batch is skipped by the processed marker',
      ),
    ).toBeNull();
  });

  it('STILL detects a real contradiction about a no-op', () => {
    // The inverse failure: when "no" from "no-op" counted as a negator, both
    // sides carried one, read as agreeing, and the real contradiction vanished.
    expect(
      detectContradiction(
        'a second flush of a claimed batch is a no-op',
        'a second flush of a claimed batch is never a no-op',
      )?.signal,
    ).toBe('negation');
  });
});

describe('detectContradiction — overlap is measured against the larger claim', () => {
  it('does NOT let a short note be contained in a longer one', () => {
    // Dividing by the smaller core let any brief note on the subject clear the
    // gate. Detection only ever runs against priors that already share a
    // subject, which made the gate a formality.
    expect(
      detectContradiction(
        'we do not cache the session brief between runs',
        'session brief formatting matters',
      ),
    ).toBeNull();
  });

  it('does NOT let a short negation contradict a long elaboration', () => {
    // Isolates the denominator: the negated head ("cach") IS shared, so
    // negation-scoping passes it, and there is no antonym involved. Only
    // dividing by the LARGER core blocks this — with min() the short note is
    // wholly contained in the long one and scores 1.0.
    expect(
      detectContradiction(
        'we do not cache the brief',
        'the cache layer for the rendered brief writes through redis with a ttl and a digest guard',
      ),
    ).toBeNull();
  });

  it('does NOT fire on an antonym pair applied to different objects', () => {
    expect(
      detectContradiction(
        'add the agent id to every spool line',
        'remove the agent id from ended child sessions',
      ),
    ).toBeNull();
  });

  it('does NOT fire on an antonym pair applied to different conditions', () => {
    expect(
      detectContradiction(
        'start the language server lazily per repository',
        'stop the language server on idle repository',
      ),
    ).toBeNull();
  });
});

describe('detectContradiction — antonyms need near-identical remaining content', () => {
  const COMPATIBLE: Array<[string, string, string]> = [
    ['required/optional across different modes',
      'the semantic provider is required for rank mode',
      'the semantic provider is optional for shadow mode'],
    ['show/hide across different surfaces',
      'we show the branch snapshot in cortex state',
      'we hide the branch snapshot in cortex recall'],
  ];

  for (const [name, prior, incoming] of COMPATIBLE) {
    it(`does NOT fire on ${name}`, () => {
      expect(detectContradiction(prior, incoming)).toBeNull();
    });
  }

  it('still fires when only the antonym differs', () => {
    expect(
      detectContradiction(
        'enable the semantic reranker for branch scoped recall',
        'disable the semantic reranker for branch scoped recall',
      )?.signal,
    ).toBe('antonym');
  });
});

describe('detectContradiction — double negation', () => {
  it('does NOT report two agreeing statements as opposed', () => {
    expect(
      detectContradiction(
        'we do not skip caching the session brief',
        'we cache the session brief',
      ),
    ).toBeNull();
  });
});

describe('conflict module invariants', () => {
  it('no token is both a polarity carrier and a structural stopword', () => {
    // Previously a module-load throw, which armed on the capture path through
    // db/store.ts. project-context requires that a memory failure never break
    // the user's turn, so the check lives here instead.
    expect(polarityStopwordOverlap()).toEqual([]);
  });
});

describe('detectContradiction — reversal phrasings the scope window must not swallow', () => {
  // negatedHeads takes the first non-carrier token after the negator as the
  // governed predicate. An intervening content adverb became the "head", was
  // absent from the other note, and the negation was discarded — silently
  // dropping "no longer", the canonical way to record a reversal.
  const REVERSALS: Array<[string, string, string]> = [
    ['no longer', 'we flush the spool at turn end', 'we no longer flush the spool at turn end'],
    ['not currently', 'the reranker is enabled for recall', 'the reranker is not currently enabled for recall'],
    ['never again', 'we retry the flaky upload step', 'we never again retry the flaky upload step'],
    ['do not ever', 'we vendor the sqlite binary', 'we do not ever vendor the sqlite binary'],
    ['is not required', 'the semantic provider is required for recall', 'the semantic provider is not required for recall'],
  ];

  for (const [name, prior, incoming] of REVERSALS) {
    it(`detects a "${name}" reversal`, () => {
      expect(detectContradiction(prior, incoming)?.signal).toBe('negation');
    });
  }

  it('does NOT treat "not only" as a reversal', () => {
    // "not only X" adds a case rather than denying one.
    expect(
      detectContradiction(
        'the spool flush runs at turn end',
        'the spool flush runs at the 256 kib threshold, not only at turn end',
      ),
    ).toBeNull();
  });

  it('does NOT treat "not just" as a reversal', () => {
    expect(
      detectContradiction(
        'the gate runs on every push',
        'the gate runs on every push, not just on pull requests',
      ),
    ).toBeNull();
  });

  it('still ignores a negation whose predicate the other note never asserts', () => {
    // The adverb skip must not become a general "any token in the window" rule
    // — that would make this double negation fire.
    expect(
      detectContradiction(
        'we do not skip caching the session brief',
        'we cache the session brief',
      ),
    ).toBeNull();
  });
});
