import { describe, it, expect } from 'vitest';
import { detectContradiction } from '../src/memory/conflict.js';

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
    expect(forward?.signal).toBe('negation');
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
