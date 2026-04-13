import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { evaluateStore, estimateTokens } from '../src/eval/harness.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, '/test/root');
  return db;
}

describe('evaluation harness', () => {
  it('estimates tokens from text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('evaluates current state and replay topics', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({ focus: 'auth-refactor' });

    store.insertNote({
      sessionId: session.id,
      kind: 'decision',
      subject: 'auth',
      content: 'Use JWT with refresh token rotation',
      alternatives: ['sessions'],
    });

    store.insertState({
      layer: 'project',
      content: 'Project state: auth rewrite is in progress.',
    });

    const result = evaluateStore(store, ['auth']);
    expect(result.schema_version).toBe(2);
    expect(result.tables.sessions).toBe(1);
    expect(result.header.chars).toBeGreaterThan(0);
    expect(result.full_state.chars).toBeGreaterThan(0);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.output.preview).toContain('JWT');
  });
});
