import { describe, it, expect } from 'vitest';
import {
  countTokenHits,
  stemLite,
  tokenizeTopic,
  tokenMatchesText,
} from '../src/query/tokenize.js';

describe('stemLite', () => {
  it('strips common inflection suffixes to substring-safe stems', () => {
    expect(stemLite('testing')).toBe('test');
    expect(stemLite('tested')).toBe('test');
    expect(stemLite('flakes')).toBe('flak');
    expect(stemLite('classes')).toBe('class');
    expect(stemLite('dependencies')).toBe('dependenc');
    expect(stemLite('rotated')).toBe('rotat');
    expect(stemLite('rotating')).toBe('rotat');
    expect(stemLite('rotate')).toBe('rotat');
  });

  it('keeps short or guarded tokens intact', () => {
    expect(stemLite('bug')).toBe('bug');
    expect(stemLite('focus')).toBe('focus');
    expect(stemLite('analysis')).toBe('analysis');
    expect(stemLite('pass')).toBe('pass');
    expect(stemLite('db')).toBe('db');
  });

  it('produces stems that substring-match all inflected forms', () => {
    for (const [query, text] of [
      ['testing', 'the test flake comes from teardown'],
      ['flakes', 'a flake in the suite'],
      ['rotation', 'rotate refresh tokens'],
      ['caching', 'the cache layer'],
    ] as const) {
      expect(text.includes(stemLite(query))).toBe(true);
    }
  });
});

describe('tokenizeTopic', () => {
  it('returns raw/stem pairs and filters low-signal words', () => {
    const tokens = tokenizeTopic('Continue testing the auth flakes fix');
    expect(tokens.map(token => token.raw)).toEqual(['testing', 'auth', 'flakes']);
    expect(tokens.map(token => token.stem)).toEqual(['test', 'auth', 'flak']);
  });

  it('caps tokens at 12 without dropping earlier distinctive terms', () => {
    const topic = Array.from({ length: 20 }, (_, i) => `term${i}word`).join(' ');
    const tokens = tokenizeTopic(topic);
    expect(tokens).toHaveLength(12);
    expect(tokens[0]!.raw).toBe('term0word');
    expect(tokens[11]!.raw).toBe('term11word');
  });

  it('dedupes repeated raw tokens', () => {
    const tokens = tokenizeTopic('cache cache caching');
    expect(tokens.map(token => token.raw)).toEqual(['cache', 'caching']);
  });
});

describe('countTokenHits', () => {
  it('counts stem matches that raw includes would miss', () => {
    const tokens = tokenizeTopic('testing flakes');
    const text = 'the vitest test flake comes from store teardown';
    expect(countTokenHits(text, tokens)).toBe(2);
  });

  it('counts each token at most once even when raw and stem both match', () => {
    const tokens = tokenizeTopic('cache');
    expect(countTokenHits('cache caching cached', tokens)).toBe(1);
  });

  it('matches via tokenMatchesText for fallback filtering', () => {
    const [token] = tokenizeTopic('rotation');
    expect(tokenMatchesText('rotate refresh tokens server-side', token!)).toBe(true);
    expect(tokenMatchesText('unrelated text', token!)).toBe(false);
  });
});
