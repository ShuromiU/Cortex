import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CortexStore, ParsedEpisode, SessionRow } from '../db/store.js';
import { resolveEnvCeiling } from '../capture/census.js';

/**
 * What a subagent concluded, kept after the subagent is gone (FR-19, Story 5.3).
 *
 * A dispatched subagent can burn a very large context and leave one paragraph
 * behind. This records that paragraph where the rest of Cortex can see it —
 * and the ORDERING is the whole point, not an implementation detail.
 *
 * **`collectEvidence` (`src/query/suggest-notes.ts`) reads exactly three things
 * for a session: episode `summary`, events, and command runs.** It never reads
 * `last_assistant_message`. For a child session the other two are close to
 * empty — `handleReadEvent` records only a line range, so a subagent's reads
 * produce no evidence text at all, and command runs count only on a non-zero
 * exit. So a subagent that only THINKS, which is precisely the case Story 5.1
 * exists to make visible, yields zero suggestions unless its conclusion is
 * written as an episode summary FIRST. Everything downstream — the Stop nudge,
 * `suggestNotes`, the whole AC #2 path — is already wired and sees nothing
 * without this write.
 */

/**
 * The episode kind. Registered in THREE places, two of which fail silently:
 * `KIND_WEIGHTS` (`src/memory/kind-weights.ts`), which the eval gate's
 * `checkKindCoverage` reads, plus `episodeState` and `episodeImportance`
 * (`src/memory/items.ts`), which switch on kind and otherwise fall through to
 * `'warm'` / `0.6` with no error and no gate failure.
 */
export const SUBAGENT_CONCLUSION_KIND = 'subagent_conclusion';

/**
 * How much of a conclusion is kept.
 *
 * A final message can run long and a transcript can run to megabytes. Four
 * thousand characters is roughly a thousand tokens — enough for a real summary
 * with its reasoning, far short of pasting a transcript into memory. The
 * episode records whether it truncated, so a reader is never shown a cut answer
 * that looks complete.
 */
export const DEFAULT_CONCLUSION_MAX_CHARS = 4000;
export const CONCLUSION_MAX_CHARS_ENV = 'CORTEX_SUBAGENT_CONCLUSION_MAX_CHARS';

/** Never parse more than this from a transcript, and only on the fallback path. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * `Number`, never `parseInt` — reused rather than re-implemented, which is the
 * sixth time this repository would otherwise have written its own numeric
 * option parser and the fifth time one of those was wrong.
 */
export function conclusionMaxChars(): number {
  return resolveEnvCeiling(CONCLUSION_MAX_CHARS_ENV, DEFAULT_CONCLUSION_MAX_CHARS);
}

export interface ConclusionText {
  text: string;
  truncated: boolean;
  /** `message` on the normal path, `transcript` only when the message was absent. */
  source: 'message' | 'transcript';
}

function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\r\n/g, '\n').trim();
  if (maxChars <= 0) {
    return { text: '', truncated: collapsed.length > 0 };
  }
  if (collapsed.length <= maxChars) {
    return { text: collapsed, truncated: false };
  }
  return { text: `${collapsed.slice(0, maxChars - 1).trimEnd()}…`, truncated: true };
}

/**
 * The last assistant text in a per-agent transcript, read from the TAIL only.
 *
 * The fallback path and nothing more: `last_assistant_message` is both
 * documented and measured present, so this exists for the host that stops
 * sending it. `agent_transcript_path` is measured but NOT documented, so every
 * step here is defensive — absent, unreadable, not JSONL, or shaped differently
 * all degrade to "no conclusion", never to a throw and never to a guess.
 */
function readTranscriptTail(transcriptPath: string): string | undefined {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) {
      return undefined;
    }
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const handle = fs.openSync(transcriptPath, 'r');
    let raw: string;
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_TAIL_BYTES));
      const read = fs.readSync(handle, buffer, 0, buffer.length, start);
      raw = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }

    // A tail read can start mid-line; that first partial line is dropped.
    const lines = raw.split('\n').slice(start > 0 ? 1 : 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractAssistantText(parsed);
      if (text !== undefined && text.trim().length > 0) {
        return text;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Tolerant of shape by design: an undocumented format may change without notice. */
function extractAssistantText(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const message = record['message'];
  if (message === null || typeof message !== 'object') return undefined;
  const inner = message as Record<string, unknown>;
  if (inner['role'] !== 'assistant') return undefined;

  const content = inner['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const typed = block as Record<string, unknown>;
    if (typed['type'] === 'text' && typeof typed['text'] === 'string') {
      parts.push(typed['text']);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * The host's own record of what a subagent was dispatched with (FR-19, Task 5).
 *
 * `<session dir>/subagents/agent-<agent_id>.meta.json`, carrying
 * `{agentType, description, toolUseId, spawnDepth}` — verified live on this
 * machine. Story 5.1 measured that it is written strictly AFTER every
 * `SubagentStart` hook returns (a 5,259 ms bounded poll inside the hook never
 * saw it), which is exactly why Story 5.2 could prove its pairing *unambiguous*
 * and not *right*, and why `SubagentStop` is the first place the check is
 * possible at all.
 *
 * **Everything here is defensive on purpose.** The path is derived, the file is
 * host-internal and undocumented, and its shape can change without notice.
 * Every failure returns `undefined`, and the caller must treat that as "no
 * audit was performed" rather than "the audit failed" — 5.1's review found the
 * false-alarm class twice, and an absent audit reported as a fault is the same
 * mistake in a new place.
 */
export function readDispatchSidecar(
  agentTranscriptPath: string | undefined,
  transcriptPath: string | undefined,
  agentId: string,
): { toolUseId?: string; description?: string } | undefined {
  for (const candidate of sidecarCandidates(agentTranscriptPath, transcriptPath, agentId)) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const toolUseId = typeof record['toolUseId'] === 'string' ? record['toolUseId'] : undefined;
      const description =
        typeof record['description'] === 'string' ? record['description'] : undefined;
      if (toolUseId === undefined && description === undefined) {
        continue;
      }
      return {
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Two derivations, best first.
 *
 * `agent_transcript_path` is the subagent's own JSONL and sits beside its meta
 * file, so swapping the extension needs no assumption about the session-directory
 * layout — but that field is measured, NOT documented. The fallback rebuilds the
 * path from `transcript_path`, which is documented: the parent transcript is
 * `<dir>/<session>.jsonl` and the session directory is its name without the
 * extension. Neither is guaranteed; that is what the caller's silence is for.
 */
function sidecarCandidates(
  agentTranscriptPath: string | undefined,
  transcriptPath: string | undefined,
  agentId: string,
): string[] {
  const candidates: string[] = [];

  if (agentTranscriptPath && agentTranscriptPath.endsWith('.jsonl')) {
    candidates.push(`${agentTranscriptPath.slice(0, -'.jsonl'.length)}.meta.json`);
  }

  if (transcriptPath && transcriptPath.endsWith('.jsonl') && agentId.length > 0) {
    const sessionDir = transcriptPath.slice(0, -'.jsonl'.length);
    candidates.push(path.join(sessionDir, 'subagents', `agent-${agentId}.meta.json`));
  }

  return candidates;
}

/**
 * Choose and bound the conclusion text. Returns `undefined` when there is
 * nothing to record — the ordinary outcome for a subagent that said nothing.
 */
export function resolveConclusionText(
  lastAssistantMessage: string | undefined,
  transcriptPath: string | undefined,
  maxChars: number = conclusionMaxChars(),
): ConclusionText | undefined {
  const direct = (lastAssistantMessage ?? '').trim();
  if (direct.length > 0) {
    const { text, truncated } = clamp(direct, maxChars);
    return text.length > 0 ? { text, truncated, source: 'message' } : undefined;
  }

  if (transcriptPath === undefined || transcriptPath.length === 0) {
    return undefined;
  }
  const fromTranscript = readTranscriptTail(transcriptPath);
  if (fromTranscript === undefined) {
    return undefined;
  }
  const { text, truncated } = clamp(fromTranscript, maxChars);
  return text.length > 0 ? { text, truncated, source: 'transcript' } : undefined;
}

/**
 * The metadata key marking a conclusion the Stop nudge has already offered.
 *
 * **The bound this story would otherwise need and not have.** `endOfTurn`
 * collects suggestions across `getSessionTreeIds`, which is the root primary
 * plus `getChildSessions` — a bare `SELECT * FROM sessions WHERE
 * parent_session_id = ?` with no status, recency or limit filter. `suggestNotes`
 * has no recency filter either, and the primary rarely rotates: `endSessionTree`
 * runs from `ensurePrimarySession` only when the SCOPE KEY changes, so a
 * SessionStart on the same branch and worktree ends nothing and children stay
 * `active` for days. Without a marker, every conclusion written here would
 * re-surface in the nudge on every later turn that used any subagent, for the
 * life of the primary — `endOfTurn`'s `seen` set dedupes within one invocation
 * and nothing dedupes across them. An accepted suggestion that keeps being
 * re-offered is the cries-wolf half of AD-12: it trains the user to dismiss the
 * nudge, which costs more than the nudge ever earned.
 *
 * A marker rather than a time window, because time is the wrong axis. A
 * subagent can run for half an hour, so any window short enough to bound the
 * noise is also short enough to discard the conclusion of a long investigation —
 * exactly the run this story exists to preserve.
 */
export const CONCLUSION_SURFACED_KEY = 'surfaced_at';

/** The conclusion episode for a session, if it has one. */
export function findSubagentConclusion(
  store: CortexStore,
  sessionId: string,
): ParsedEpisode | undefined {
  return store
    .getEpisodesBySession(sessionId)
    .find(episode => episode.kind === SUBAGENT_CONCLUSION_KIND);
}

/** Whether the Stop nudge has already offered this conclusion. */
export function conclusionSurfaced(episode: ParsedEpisode): boolean {
  return typeof episode.metadata[CONCLUSION_SURFACED_KEY] === 'string';
}

/**
 * Mark a conclusion as offered. Best-effort by contract: this runs on the turn's
 * critical path and a failed mark must cost a duplicate nudge, never the turn.
 */
export function markConclusionSurfaced(
  store: CortexStore,
  episode: ParsedEpisode,
  now: string = new Date().toISOString(),
): void {
  try {
    if (conclusionSurfaced(episode)) {
      return;
    }
    store.setEpisodeMetadata(episode.id, {
      ...episode.metadata,
      [CONCLUSION_SURFACED_KEY]: now,
    });
  } catch {
    // Re-offering a conclusion is noise; throwing here would block turn end.
  }
}

export interface RecordConclusionOptions {
  /** The CHILD session. The conclusion belongs to the subagent that reached it. */
  child: SessionRow;
  conclusion: ConclusionText;
  agentType?: string | undefined;
  transcriptPath?: string | undefined;
}

/**
 * Write the conclusion as an episode on the child session.
 *
 * Idempotent per child: a second `SubagentStop` for the same agent — which the
 * host can send, and which Story 5.1's deferred work already records as
 * reachable for a recycled id — updates nothing and inserts nothing. Replay
 * produces identical state (N-7).
 */
export function recordSubagentConclusion(
  store: CortexStore,
  options: RecordConclusionOptions,
): ParsedEpisode | undefined {
  const existing = store
    .getEpisodesBySession(options.child.id)
    .find(episode => episode.kind === SUBAGENT_CONCLUSION_KIND);
  if (existing) {
    return undefined;
  }

  return store.insertEpisode({
    sessionId: options.child.id,
    kind: SUBAGENT_CONCLUSION_KIND,
    // The field `collectEvidence` reads. Putting the conclusion anywhere else —
    // metadata, target, a note — makes every downstream surface blind to it.
    summary: options.conclusion.text,
    target: options.agentType ?? options.child.agent_type ?? null,
    metadata: {
      agent_id: options.child.agent_id,
      source: options.conclusion.source,
      truncated: options.conclusion.truncated,
      ...(options.transcriptPath ? { transcript_path: options.transcriptPath } : {}),
    },
  });
}
