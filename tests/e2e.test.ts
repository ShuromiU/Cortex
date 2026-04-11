import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { CortexStore } from '../src/db/store.js';
import {
  handleReadEvent,
  handleEditEvent,
  handleCmdEvent,
  handleAgentEvent,
} from '../src/capture/hooks.js';
import { consolidateLevel1, renderCompressed } from '../src/capture/consolidate.js';
import { buildHeader, buildFullState } from '../src/query/state.js';
import { recall } from '../src/query/recall.js';
import { brief } from '../src/query/brief.js';
import { handleToolCall } from '../src/transports/mcp.js';

// ── Helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

// ── E2E Lifecycle Test ─────────────────────────────────────────────────

describe('E2E: multi-session lifecycle', () => {
  it('simulates a full auth-refactor workflow', () => {
    const db = createTestDb();
    const store = new CortexStore(db);

    // ── Session 1: auth-refactor work ─────────────────────────────────

    const session1 = store.createSession({ focus: 'auth-refactor' });
    const sid1 = session1.id;

    // Hook events: multiple reads of auth.ts
    handleReadEvent(store, sid1, { file: 'auth.ts' });
    handleReadEvent(store, sid1, { file: 'auth.ts' });
    handleReadEvent(store, sid1, { file: 'auth.ts' });

    // Edit auth.ts
    handleEditEvent(store, sid1, { file: 'auth.ts', lines: '10-30' });

    // Test fail → edit → test pass (use vitest which classifies as 'test')
    handleCmdEvent(store, sid1, { cmd: 'vitest run', exit: '1' });
    handleEditEvent(store, sid1, { file: 'auth.ts', lines: '15-25' });
    handleCmdEvent(store, sid1, { cmd: 'vitest run', exit: '0' });

    // AI writes notes
    store.insertNote({
      sessionId: sid1,
      kind: 'intent',
      subject: 'auth-refactor',
      content: 'Refactor auth module to use JWT instead of sessions',
    });

    store.insertNote({
      sessionId: sid1,
      kind: 'decision',
      subject: 'jwt-strategy',
      content: 'Chose JWT over sessions for stateless auth',
      alternatives: ['sessions', 'OAuth tokens'],
    });

    store.insertNote({
      sessionId: sid1,
      kind: 'blocker',
      subject: 'jwt-secret',
      content: 'Need to decide where to store JWT secret key',
    });

    // End session 1
    store.endSession(sid1);

    // ── Level 1 Consolidation ─────────────────────────────────────────

    const compressed = consolidateLevel1(store, sid1);

    // Verify test cycle detected
    const testCycle = compressed.find(e => e.type === 'test_cycle');
    expect(testCycle).toBeDefined();
    expect(testCycle?.iterations).toBe(1);

    // Store compressed state
    const rendered = renderCompressed(compressed);
    store.insertState({
      sessionId: sid1,
      layer: 'session',
      content: rendered,
    });

    // ── Session 2: follow-up ──────────────────────────────────────────

    const session2 = store.createSession({ focus: 'auth-refactor' });
    const sid2 = session2.id;

    // Verify header shows auth-refactor and session count
    const header = buildHeader(store);
    expect(header).toContain('auth-refactor');
    expect(header).toContain('session');

    // Check full state contains JWT and blocker info
    const fullState = buildFullState(store);
    expect(fullState).toContain('JWT');
    expect(fullState).toContain('Blocker');

    // Recall "auth" finds JWT
    const recallResult = recall(store, 'auth');
    expect(recallResult).toContain('JWT');

    // Agent event
    handleAgentEvent(store, sid2, { desc: 'test-runner subagent' });

    // Brief for "test-runner" includes agent context
    store.insertNote({
      sessionId: sid2,
      kind: 'insight',
      content: 'test-runner subagent handles async test execution',
    });

    const briefResult = brief(store, 'test-runner', 'test-runner');
    expect(briefResult).toContain('test-runner');

    // ── Supersede JWT decision ────────────────────────────────────────

    // Use handleToolCall to supersede the JWT decision with Redis revocation
    const noteResult = handleToolCall(store, 'cortex_note', {
      kind: 'decision',
      subject: 'jwt-strategy',
      content: 'JWT with revocation via Redis',
      alternatives: ['sessions', 'OAuth tokens', 'stateless JWT'],
    });
    expect(noteResult).toContain('JWT with revocation via Redis');

    // Verify original decision superseded
    const jwtNotes = store.getNotesByKindAndSubject('decision', 'jwt-strategy');
    const superseded = jwtNotes.find(n => n.content.includes('Chose JWT over sessions'));
    expect(superseded).toBeDefined();
    expect(superseded?.status).toBe('superseded');

    const newDecision = jwtNotes.find(n => n.content.includes('JWT with revocation via Redis'));
    expect(newDecision).toBeDefined();
    expect(newDecision?.status).toBe('active');

    // ── Resolve blocker ───────────────────────────────────────────────

    const blockerNotes = store.getNotesByKindAndSubject('blocker', 'jwt-secret');
    expect(blockerNotes.length).toBeGreaterThan(0);
    const blocker = blockerNotes[0]!;
    store.updateNoteStatus(blocker.id, 'resolved');

    // End session 2
    store.endSession(sid2);

    // ── Final recall verification ─────────────────────────────────────

    const finalRecall = recall(store, 'jwt');
    // Should find "revocation"
    expect(finalRecall).toContain('revocation');
    // Should NOT contain the old superseded "chose JWT over sessions" as an active note
    // (it may appear in superseded status, but the active decision should be the new one)
    const activeNotes = store.getActiveNotes();
    const oldDecisionActive = activeNotes.find(n => n.content.includes('Chose JWT over sessions'));
    expect(oldDecisionActive).toBeUndefined();
  });
});
