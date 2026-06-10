import Database from 'better-sqlite3';
import { applySchema, initializeMeta } from '../db/schema.js';
import { CortexStore, type SessionRow } from '../db/store.js';
import type { MemoryItemState } from '../memory/items.js';

const DAY_MS = 86_400_000;

export interface ScenarioMemoryItem {
  id?: string;
  kind: string;
  subject?: string | null;
  text: string;
  state?: MemoryItemState;
  importance?: number;
  access_count?: number;
  /** Age relative to the scenario clock; ignored when created_at is set. */
  age_days?: number;
  last_accessed_days_ago?: number;
  created_at?: string;
  scope_type?: string;
  scope_key?: string;
}

export interface ScenarioAppGraph {
  scope_type?: string;
  scope_key?: string;
  head_oid?: string;
  files: string[];
}

export interface ScenarioRename {
  old_path: string;
  new_path: string;
}

export interface EvaluationScenario {
  /** Scenario clock for age_days math; defaults to the real current time. */
  now?: string;
  scope?: { type?: string; key?: string };
  focus?: string;
  items: ScenarioMemoryItem[];
  app_graph?: ScenarioAppGraph;
  renames?: ScenarioRename[];
}

export interface SeededStore {
  db: Database.Database;
  store: CortexStore;
  session: SessionRow;
}

function scenarioNowMs(scenario: EvaluationScenario): number {
  if (scenario.now) {
    const parsed = Date.parse(scenario.now);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function isoDaysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

function itemCreatedAt(item: ScenarioMemoryItem, nowMs: number): string {
  if (item.created_at) {
    return item.created_at;
  }
  return isoDaysBefore(nowMs, item.age_days ?? 0);
}

/**
 * Seed a store from a declarative scenario so retrieval quality can be
 * evaluated against a deterministic memory population instead of whatever
 * happens to be in a live `.cortex.db`.
 */
export function seedStoreFromScenario(
  store: CortexStore,
  scenario: EvaluationScenario,
): SessionRow {
  const nowMs = scenarioNowMs(scenario);
  const scopeType = scenario.scope?.type ?? 'branch';
  const scopeKey = scenario.scope?.key ?? 'eval/scenario';

  const session = store.createSession({
    scopeType,
    scopeKey,
    ...(scenario.focus ? { focus: scenario.focus } : {}),
  });

  for (const item of scenario.items) {
    store.upsertMemoryItem({
      ...(item.id ? { id: item.id } : {}),
      sessionId: session.id,
      scopeType: item.scope_type ?? scopeType,
      scopeKey: item.scope_key ?? scopeKey,
      kind: item.kind,
      subject: item.subject ?? null,
      text: item.text,
      ...(item.state ? { state: item.state } : {}),
      ...(item.importance !== undefined ? { importance: item.importance } : {}),
      ...(item.access_count !== undefined ? { accessCount: item.access_count } : {}),
      ...(item.last_accessed_days_ago !== undefined
        ? { lastAccessedAt: isoDaysBefore(nowMs, item.last_accessed_days_ago) }
        : {}),
      createdAt: itemCreatedAt(item, nowMs),
    });
  }

  if (scenario.app_graph) {
    store.upsertCurrentAppGraph({
      scopeType: scenario.app_graph.scope_type ?? scopeType,
      scopeKey: scenario.app_graph.scope_key ?? scopeKey,
      ...(scenario.app_graph.head_oid ? { headOid: scenario.app_graph.head_oid } : {}),
      files: scenario.app_graph.files,
    });
  }

  if (scenario.renames && scenario.renames.length > 0) {
    store.insertFileRenames({
      scopeKey: scenario.app_graph?.scope_key ?? scopeKey,
      renames: scenario.renames.map(rename => ({
        oldPath: rename.old_path,
        newPath: rename.new_path,
      })),
      ...(scenario.app_graph?.head_oid ? { headOid: scenario.app_graph.head_oid } : {}),
    });
  }

  return session;
}

/**
 * Build an in-memory store seeded from a scenario. Hermetic: never touches a
 * real database or the working tree.
 */
export function createSeededStore(
  scenario: EvaluationScenario,
  rootPath = '/cortex/eval-scenario',
): SeededStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  initializeMeta(db, rootPath);
  const store = new CortexStore(db);
  const session = seedStoreFromScenario(store, scenario);
  return { db, store, session };
}
