import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, SCHEMA_VERSION } from '../src/db/schema.js';
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
    expect(result.schema_version).toBe(SCHEMA_VERSION);
    expect(result.tables.sessions).toBe(1);
    expect(result.header.chars).toBeGreaterThan(0);
    expect(result.full_state.chars).toBeGreaterThan(0);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.output.preview).toContain('JWT');
  });

  it('evaluates fixture-backed retrieval quality suites', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({ focus: 'retrieval-quality' });

    store.upsertMemoryItem({
      id: 'fresh-auth-decision',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'default',
      kind: 'note',
      sourceTable: 'notes',
      sourceId: 'fresh-auth-decision',
      subject: 'auth',
      text: 'Auth decision: rotate refresh tokens after JWT renewal.',
      state: 'hot',
      importance: 5,
      createdAt: '2026-01-15T00:00:00.000Z',
    });
    store.upsertMemoryItem({
      id: 'old-auth-decision',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'default',
      kind: 'note',
      sourceTable: 'notes',
      sourceId: 'old-auth-decision',
      subject: 'auth',
      text: 'Auth decision: legacy refresh token rotation draft.',
      state: 'warm',
      importance: 1,
      createdAt: '2024-01-15T00:00:00.000Z',
    });
    store.upsertMemoryItem({
      id: 'forbidden-session-note',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'default',
      kind: 'note',
      sourceTable: 'notes',
      sourceId: 'forbidden-session-note',
      subject: 'auth',
      text: 'Auth note: use server sessions instead of JWT rotation.',
      state: 'warm',
      importance: 4,
      createdAt: '2026-01-16T00:00:00.000Z',
    });

    const result = evaluateStore(store, [], undefined, {
      fixtures: [
        {
          topic: 'auth refresh token rotation',
          expected_top: 'fresh-auth-decision',
          allowed: ['old-auth-decision'],
          forbidden: ['forbidden-session-note'],
          max_output_tokens: 120,
          fresh_after: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(result.quality).toBeDefined();
    expect(result.quality!.top1_hit).toBe(1);
    expect(result.quality!.recall_at_3).toBe(1);
    expect(result.quality!.noise_count).toBe(1);
    expect(result.quality!.stale_count).toBe(1);
    expect(result.quality!.output_tokens).toBeGreaterThan(0);
    expect(result.quality!.fixtures[0]!.passed).toBe(false);
    expect(result.quality!.fixtures[0]!.top_result_id).toBe('fresh-auth-decision');
    expect(result.quality!.fixtures[0]!.token_budget.passed).toBe(true);
    expect(result.quality!.fixtures[0]!.score_breakdown[0]).toMatchObject({
      id: 'fresh-auth-decision',
      subject: 'auth',
    });
    expect(result.quality!.fixtures[0]!.score_breakdown[0]!.scores).toHaveProperty(
      'retrieval_score',
    );
  });

  it('compares quality aggregates against a previous evaluation', () => {
    const db = createTestDb();
    const store = new CortexStore(db);
    const session = store.createSession({ focus: 'retrieval-quality' });
    store.upsertMemoryItem({
      id: 'fresh-auth-decision',
      sessionId: session.id,
      scopeType: 'project',
      scopeKey: 'default',
      kind: 'note',
      sourceTable: 'notes',
      sourceId: 'fresh-auth-decision',
      subject: 'auth',
      text: 'Auth decision: rotate refresh tokens after JWT renewal.',
      state: 'hot',
      importance: 5,
      createdAt: '2026-01-15T00:00:00.000Z',
    });

    const result = evaluateStore(store, [], undefined, {
      fixtures: [
        {
          topic: 'auth refresh token rotation',
          expected_top: 'fresh-auth-decision',
        },
      ],
      compareTo: {
        generated_at: '2026-01-01T00:00:00.000Z',
        schema_version: 2,
        tables: store.getTableCounts(),
        header: { chars: 0, est_tokens: 0, preview: '' },
        full_state: { chars: 0, est_tokens: 0, preview: '' },
        topics: [],
        quality: {
          fixtures: [],
          top1_hit: 0,
          recall_at_3: 0.5,
          noise_count: 2,
          stale_count: 1,
          output_tokens: 100,
        },
      },
    });

    expect(result.quality_comparison).toEqual({
      top1_hit_delta: 1,
      recall_at_3_delta: 0.5,
      noise_count_delta: -2,
      stale_count_delta: -1,
      output_tokens_delta: expect.any(Number),
    });
  });
});
