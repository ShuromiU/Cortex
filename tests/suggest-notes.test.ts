import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { suggestNotes } from '../src/query/suggest-notes.js';

function createStore(): { store: CortexStore; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  const store = new CortexStore(db);
  const session = store.createSession();
  return { store, sessionId: session.id };
}

describe('suggestNotes', () => {
  it('suggests decisions and intents with evidence snippets', () => {
    const { store, sessionId } = createStore();

    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Decided to use memory_items as the canonical retrieval layer.',
    });
    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Next: wire this into the MCP transport after the core lands.',
    });

    const suggestions = suggestNotes(store, sessionId);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'decision',
          subject: expect.any(String),
          content: expect.stringContaining('memory_items'),
          confidence: expect.any(Number),
          evidence: [
            expect.stringContaining(
              'Decided to use memory_items as the canonical retrieval layer.',
            ),
          ],
        }),
        expect.objectContaining({
          kind: 'intent',
          subject: expect.any(String),
          content: expect.stringContaining('wire this into the MCP transport'),
          evidence: [
            expect.stringContaining(
              'Next: wire this into the MCP transport after the core lands.',
            ),
          ],
        }),
      ]),
    );
  });

  it('suggests blockers from failed commands without mutating notes', () => {
    const { store, sessionId } = createStore();

    store.insertCommandRun({
      sessionId,
      category: 'test',
      commandSummary: 'npm run test -- suggest-notes',
      exitCode: 1,
      stderrTail: 'Error: blocker - query module is missing',
    });
    const before = store.getNotesBySession(sessionId);

    const suggestions = suggestNotes(store, sessionId);

    expect(store.getNotesBySession(sessionId)).toEqual(before);
    expect(suggestions).toEqual([
      expect.objectContaining({
        kind: 'blocker',
        subject: expect.any(String),
        content: expect.stringContaining('query module is missing'),
        confidence: expect.any(Number),
        evidence: [
          expect.stringContaining('npm run test -- suggest-notes'),
          expect.stringContaining('query module is missing'),
        ],
      }),
    ]);
  });

  it('skips routine successful progress noise', () => {
    const { store, sessionId } = createStore();

    store.insertEvent({ sessionId, type: 'read', target: 'src/query/state.ts' });
    store.insertCommandRun({
      sessionId,
      category: 'test',
      commandSummary: 'npm run test -- state',
      exitCode: 0,
      stdoutTail: 'PASS tests/state.test.ts',
    });
    store.insertEpisode({
      sessionId,
      kind: 'message',
      summary: 'Read state.ts and tests are passing.',
    });

    expect(suggestNotes(store, sessionId)).toEqual([]);
  });
});
