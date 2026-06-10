import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema, initializeMeta, SCHEMA_VERSION } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { evaluateStore, evaluateDatabase, estimateTokens } from '../src/eval/harness.js';
import { createSeededStore } from '../src/eval/seed.js';

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

describe('scenario seeding', () => {
  it('builds a hermetic store from a declarative scenario', () => {
    const { store, session } = createSeededStore({
      scope: { type: 'branch', key: 'eval/seeded' },
      focus: 'auth login',
      items: [
        {
          id: 'seeded-decision',
          kind: 'note:decision',
          subject: 'auth login flow',
          text: 'Decision: keep the login flow in src/auth/login.ts behind the session guard.',
          state: 'hot',
          importance: 2.5,
          age_days: 2,
        },
        {
          id: 'seeded-old-insight',
          kind: 'note:insight',
          subject: 'auth legacy',
          text: 'Insight: legacy redirects double-encode the return url.',
          state: 'warm',
          importance: 1.8,
          age_days: 30,
          last_accessed_days_ago: 10,
        },
      ],
      app_graph: {
        head_oid: 'feedfacefeedfacefeedfacefeedfacefeedface',
        files: ['src/auth/login.ts', 'src/auth/session.ts'],
      },
    });

    expect(session.scope_key).toBe('eval/seeded');
    expect(store.getCurrentSession()?.focus).toBe('auth login');

    const decision = store.getMemoryItem('seeded-decision');
    expect(decision).toBeDefined();
    expect(decision!.scope_key).toBe('eval/seeded');
    const ageDays =
      (Date.now() - Date.parse(decision!.created_at)) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(1.9);
    expect(ageDays).toBeLessThan(2.1);

    expect(
      store.getMemoryReferences('seeded-decision').map(ref => ref.normalized_path),
    ).toContain('src/auth/login.ts');

    const graph = store.getCurrentAppGraph('eval/seeded');
    expect(graph?.files).toContain('src/auth/session.ts');
    expect(graph?.head_oid).toBe('feedfacefeedfacefeedfacefeedfacefeedface');
  });

  it('evaluates a scenario hermetically without touching the database path', () => {
    const dbPath = path.join(
      os.tmpdir(),
      `cortex-eval-hermetic-${process.pid}-${Date.now()}.db`,
    );

    const result = evaluateDatabase(dbPath, process.cwd(), [], {
      scenario: {
        scope: { type: 'branch', key: 'eval/hermetic' },
        focus: 'jwt refresh',
        items: [
          {
            id: 'hermetic-decision',
            kind: 'note:decision',
            subject: 'jwt refresh',
            text: 'Decision: rotate jwt refresh tokens server-side.',
            state: 'hot',
            importance: 2.5,
            age_days: 1,
          },
        ],
      },
      fixtures: [
        {
          topic: 'jwt refresh rotation',
          expected_top: 'hermetic-decision',
        },
      ],
    });

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(result.db_path).toBeUndefined();
    expect(result.quality!.top1_hit).toBe(1);
    expect(result.tables.memory_items).toBe(1);
  });

  it('enforces output assertions on rendered recall output', () => {
    const scenario = {
      scope: { type: 'branch' as const, key: 'eval/assertions' },
      items: [
        {
          id: 'assertion-target',
          kind: 'note:decision',
          subject: 'cache policy',
          text: 'Decision: cache invalidation uses tags, not ttl sweeps.',
          state: 'hot' as const,
          importance: 2.5,
          age_days: 1,
        },
      ],
    };

    const { store } = createSeededStore(scenario);
    const result = evaluateStore(store, [], undefined, {
      fixtures: [
        {
          topic: 'cache invalidation tags',
          expected_top: 'assertion-target',
          expect_output_contains: ['tags', 'not-in-output-sentinel'],
          expect_output_excludes: ['ttl'],
        },
      ],
    });

    const fixture = result.quality!.fixtures[0]!;
    expect(fixture.output_assertions.contains_missed).toEqual([
      'not-in-output-sentinel',
    ]);
    expect(fixture.output_assertions.excludes_violated).toEqual(['ttl']);
    expect(fixture.output_assertions.passed).toBe(false);
    expect(fixture.passed).toBe(false);
  });
});
