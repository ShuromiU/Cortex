// `TOKEN_PATTERN` and `stemLite` live in `memory/` so the write path can reach
// them — `db/` may import `memory/` but never `query/` (AD-1). Re-exported here
// so this module's public surface is unchanged.
export { TOKEN_PATTERN, stemLite } from '../memory/text.js';

import { TOKEN_PATTERN, stemLite } from '../memory/text.js';

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

const MAX_TOPIC_TOKENS = 12;

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
