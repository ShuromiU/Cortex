import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import { recall } from '../src/query/recall.js';
import { brief } from '../src/query/brief.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function makeStore(): CortexStore {
  return new CortexStore(createTestDb());
}

// ── recall ────────────────────────────────────────────────────────────

describe('recall — finds notes matching topic', () => {
  it('finds notes by subject match', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT tokens' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'unrelated info' });

    const result = recall(store, 'auth');
    expect(result).toContain('Decision:');
    expect(result).toContain('[auth] use JWT tokens');
    expect(result).not.toContain('unrelated info');
  });

  it('finds notes by content match', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'JWT is stateless and scalable' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'sessions have server overhead' });

    const result = recall(store, 'JWT');
    expect(result).toContain('JWT is stateless');
    expect(result).not.toContain('server overhead');
  });

  it('returns no-matches message for unrelated topics', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth is good' });

    const result = recall(store, 'kubernetes');
    expect(result).toBe('No matches for "kubernetes".');
  });

  it('excludes superseded notes (only shows active and resolved)', () => {
    const store = makeStore();
    const session = store.createSession();
    // Insert a decision that gets superseded by a second one
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'caching', content: 'use Redis' });
    // This supersedes the first
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'caching', content: 'use in-memory cache' });

    const result = recall(store, 'caching');
    // Only the active one (in-memory) should be in the result
    expect(result).toContain('in-memory cache');
    // The superseded one should NOT appear
    expect(result).not.toContain('use Redis');
  });

  it('includes resolved notes with lower relevance score', () => {
    const store = makeStore();
    const session = store.createSession();
    const note = store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'deploy', content: 'missing env var for deploy' });
    store.updateNoteStatus(note.id, 'resolved');

    const result = recall(store, 'deploy');
    expect(result).toContain('missing env var');
    expect(result).toContain('(resolved)');
  });

  it('searches consolidated state content', () => {
    const store = makeStore();
    const session = store.createSession();
    store.endSession(session.id);
    store.insertState({ sessionId: session.id, layer: 'session', content: 'Completed auth module refactoring.' });

    const result = recall(store, 'auth');
    expect(result).toContain('[session state]');
    expect(result).toContain('Completed auth module refactoring.');
  });

  it('searches project state content', () => {
    const store = makeStore();
    store.insertState({ layer: 'project', content: 'Focus on performance optimization for the API.' });

    const result = recall(store, 'performance');
    expect(result).toContain('[project state]');
    expect(result).toContain('performance optimization');
  });

  it('returns no matches when topic not in any note or state', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth notes here' });
    store.insertState({ layer: 'project', content: 'auth project' });

    const result = recall(store, 'blockchain');
    expect(result).toBe('No matches for "blockchain".');
  });

  it('subject match scores higher than content match — subject results appear first', () => {
    const store = makeStore();
    const session = store.createSession();
    // Content-only match
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'jwt mentioned in passing' });
    // Subject match (higher score)
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'jwt', content: 'use HS256 signing' });

    const result = recall(store, 'jwt');
    const decisionIdx = result.indexOf('Decision:');
    const insightIdx = result.indexOf('Insight:');
    expect(decisionIdx).toBeLessThan(insightIdx);
  });

  it('limits results to top 10', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 15; i++) {
      store.insertNote({ sessionId: session.id, kind: 'insight', content: `auth tip ${i}` });
    }

    const result = recall(store, 'auth');
    const lines = result.split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});

// ── brief ─────────────────────────────────────────────────────────────

describe('brief — scoped briefing', () => {
  it('generates a scoped briefing for a topic', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use JWT' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'auth', content: 'add refresh tokens' });
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'unrelated CSS info' });

    const result = brief(store, 'auth');
    expect(result).toContain('use JWT');
    expect(result).toContain('add refresh tokens');
    expect(result).not.toContain('CSS info');
  });

  it('includes agent context when forAgent is provided', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'api', content: 'REST over GraphQL' });

    const result = brief(store, 'api', 'deployment-agent');
    expect(result).toContain('Briefing for deployment-agent:');
    expect(result).toContain('REST over GraphQL');
  });

  it('does not include agent context header when forAgent is not provided', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth insight' });

    const result = brief(store, 'auth');
    expect(result).not.toContain('Briefing for');
  });

  it('returns no context message when no relevant notes found', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'auth notes' });

    const result = brief(store, 'kubernetes');
    expect(result).toContain('No context found for "kubernetes".');
  });

  it('sorts by kind priority: decision > intent > blocker > insight', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'insight', content: 'cache insight' });
    store.insertNote({ sessionId: session.id, kind: 'blocker', subject: 'cache', content: 'cache blocked' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'cache', content: 'cache intent' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'cache', content: 'use Redis' });

    const result = brief(store, 'cache');
    const decisionIdx = result.indexOf('Decision:');
    const intentIdx = result.indexOf('Intent:');
    const blockerIdx = result.indexOf('Blocker:');
    const insightIdx = result.indexOf('Insight:');

    expect(decisionIdx).toBeLessThan(intentIdx);
    expect(intentIdx).toBeLessThan(blockerIdx);
    expect(blockerIdx).toBeLessThan(insightIdx);
  });

  it('limits to max 5 notes', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let i = 0; i < 8; i++) {
      store.insertNote({ sessionId: session.id, kind: 'insight', content: `cache tip ${i}` });
    }

    const result = brief(store, 'cache');
    const lines = result.split('\n').filter(l => l.startsWith('Insight:'));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('includes current session focus when available', () => {
    const store = makeStore();
    const session = store.createSession({ focus: 'auth-redesign' });
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'auth', content: 'use OIDC' });

    const result = brief(store, 'auth');
    expect(result).toContain('Focus: auth-redesign');
  });

  it('is concise — under 400 chars for a small briefing', () => {
    const store = makeStore();
    const session = store.createSession();
    store.insertNote({ sessionId: session.id, kind: 'decision', subject: 'api', content: 'REST' });
    store.insertNote({ sessionId: session.id, kind: 'intent', subject: 'api', content: 'add v2 endpoint' });

    const result = brief(store, 'api');
    expect(result.length).toBeLessThan(400);
  });
});
