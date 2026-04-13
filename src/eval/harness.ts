import type { CortexStore, TableCounts } from '../db/store.js';
import { openDatabase, ensureCortexSchema } from '../db/schema.js';
import { CortexStore as Store } from '../db/store.js';
import { buildHeader, buildFullState } from '../query/state.js';
import { recall } from '../query/recall.js';

export interface TextMetric {
  chars: number;
  est_tokens: number;
  preview: string;
}

export interface TopicEvaluation {
  topic: string;
  output: TextMetric;
}

export interface EvaluationResult {
  db_path?: string;
  generated_at: string;
  schema_version: number;
  tables: TableCounts;
  header: TextMetric;
  full_state: TextMetric;
  topics: TopicEvaluation[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildTextMetric(text: string, previewLength = 320): TextMetric {
  return {
    chars: text.length,
    est_tokens: estimateTokens(text),
    preview: text.slice(0, previewLength),
  };
}

function deriveTopics(store: CortexStore, requestedTopics: string[]): string[] {
  const cleaned = requestedTopics
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
  if (cleaned.length > 0) {
    return Array.from(new Set(cleaned));
  }

  const derived: string[] = [];
  const current = store.getCurrentSession();
  if (current?.focus) {
    derived.push(current.focus);
  }

  for (const session of store.getRecentSessions(5)) {
    if (session.focus) {
      derived.push(session.focus);
    }
  }

  for (const note of store.getActiveNotes()) {
    if (note.subject) {
      derived.push(note.subject);
    }
    if (derived.length >= 8) {
      break;
    }
  }

  return Array.from(new Set(derived.filter(topic => topic.length > 0))).slice(0, 5);
}

export function evaluateStore(
  store: CortexStore,
  requestedTopics: string[],
  dbPath?: string,
): EvaluationResult {
  const topics = deriveTopics(store, requestedTopics);
  const header = buildHeader(store);
  const fullState = buildFullState(store);

  return {
    ...(dbPath ? { db_path: dbPath } : {}),
    generated_at: new Date().toISOString(),
    schema_version: Number.parseInt(store.getMeta('schema_version') ?? '0', 10) || 0,
    tables: store.getTableCounts(),
    header: buildTextMetric(header),
    full_state: buildTextMetric(fullState),
    topics: topics.map(topic => ({
      topic,
      output: buildTextMetric(recall(store, topic)),
    })),
  };
}

export function evaluateDatabase(
  dbPath: string,
  rootPath: string,
  requestedTopics: string[],
): EvaluationResult {
  const db = openDatabase(dbPath);
  ensureCortexSchema(db, rootPath);
  const store = new Store(db);
  return evaluateStore(store, requestedTopics, dbPath);
}
