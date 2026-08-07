import * as crypto from 'node:crypto';

import type { CortexStore, ParsedMemoryItem } from '../db/store.js';
import { brief } from './brief.js';
import { renderMemoryLine } from './render.js';
import { retrieveMemory } from './retrieval.js';
import { DEFAULT_SESSION_BRIEF_BUDGET } from './session-brief.js';

/**
 * The automatic subagent brief (FR-18, Story 5.2).
 *
 * A dispatched subagent starts with none of the memory its parent has. This
 * module turns the dispatch description — captured one event earlier, at
 * `PreToolUse` on the `Agent` tool — into the brief that is injected into the
 * subagent's context at `SubagentStart`.
 *
 * Silence is the default and is a correctness property here, not politeness:
 * no matching memory, a parent that already pasted the same thing, or any
 * failure at all must emit nothing (N-1, AD-12).
 */

/**
 * The budget, and it is the SessionStart cap rather than `cortex_brief`'s 450
 * (ruling, ShuromiU, 2026-08-06). This brief is paid on EVERY dispatch, including
 * the many that need nothing, and a long preamble competes with the instructions
 * the parent actually wrote. Raising it later is a one-line change with evidence
 * behind it; lowering it after agents have come to rely on it is not.
 */
export const SUBAGENT_BRIEF_BUDGET = DEFAULT_SESSION_BRIEF_BUDGET;

/** Matches `brief()`'s own default, so the emptiness pre-check and the brief see one candidate set. */
export const SUBAGENT_BRIEF_LIMIT = 5;

/**
 * How much of the dispatch prompt is kept, in NORMALIZED characters, purely to
 * answer AC #3.
 *
 * A dispatch prompt runs to tens of kilobytes and the capture table is not a
 * transcript, so this is bounded — and `prompt_chars` records the full
 * normalized length beside it, so a suppression decision can state how much of
 * the prompt it actually examined instead of implying it saw all of it (AD-6).
 * The residual is stated rather than hidden: a brief pasted past this point is
 * not detected and is injected twice.
 */
export const PROMPT_PREFIX_MAX_CHARS = 8192;

/**
 * How long a capture stays eligible for pairing.
 *
 * CORRECTNESS, not housekeeping. A dispatch reaches `SubagentStart` within about
 * a second (measured: `PreToolUse` 17:04:38.743 → `SubagentStart` 39.530), so
 * five minutes is generous for the honest case while bounding the dishonest one:
 * a capture whose dispatch never started — the user denied the `Agent` call, or
 * the host errored — must not stay eligible to mis-brief a later same-type
 * subagent. The GC rule that also prunes this table runs at most once per 24
 * hours and cannot serve this purpose. Two horizons, two mechanisms.
 */
export const DEFAULT_DISPATCH_HORIZON_SECONDS = 300;

/**
 * Clamp for the horizon override.
 *
 * Past a day the GC rule removes the rows anyway, so a larger value cannot mean
 * "disabled" however it is spelled — and clamping DOWN only ever makes pairing
 * stricter, which costs a brief rather than producing a wrong one. To turn the
 * feature off, set `CORTEX_SUBAGENT_BRIEF=off`; that is the switch, and it says
 * what it does.
 */
export const MAX_DISPATCH_HORIZON_SECONDS = 86_400;

export const DISPATCH_HORIZON_ENV = 'CORTEX_SUBAGENT_DISPATCH_HORIZON_SECONDS';
export const SUBAGENT_BRIEF_ENV = 'CORTEX_SUBAGENT_BRIEF';

/** Explicit off switch, matching `CORTEX_STOP_NUDGE=off`. */
export function subagentBriefEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUBAGENT_BRIEF_ENV] !== 'off';
}

/**
 * The pairing horizon in seconds.
 *
 * `Number`, never `Number.parseInt`. `parseInt` succeeds on a PREFIX, so `1e9`
 * becomes 1 and `6e1` becomes 6 — this repository has paid for that four times
 * (`CORTEX_WAL_MAX_BYTES`, `CORTEX_DIGEST_MAX_BYTES`, `CORTEX_GC_DIGEST_DAYS`,
 * `CORTEX_GC_COMMAND_RUN_CAP`), and a fifth arrived through SQL's `CAST` in
 * Story 5.1. Here a silently-tiny horizon would disable pairing entirely and the
 * feature would look like "no relevant memory" forever.
 */
export function dispatchHorizonSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DISPATCH_HORIZON_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_DISPATCH_HORIZON_SECONDS;
  }
  const parsed = Number(raw.trim());
  // `<= 0` falls through to the default rather than meaning "pair nothing":
  // zero is what an operator types to switch something off, and here it would
  // silently kill the feature while every diagnostic still read healthy.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DISPATCH_HORIZON_SECONDS;
  }
  return Math.min(Math.floor(parsed), MAX_DISPATCH_HORIZON_SECONDS);
}

/** The ISO instant a capture must be newer than to still be pairable. */
export function dispatchCutoff(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

/**
 * One normalization, used on both sides of every comparison. Whitespace and
 * case differ between what `cortex_brief` returned and what a parent pasted
 * into a prompt — indentation inside a fenced block, a quoted `> ` prefix, a
 * re-wrapped line — and raw equality would find none of them.
 */
export function normalizeForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface DispatchPromptSummary {
  digest: string | null;
  prefix: string | null;
  chars: number;
}

/**
 * What is kept of a dispatch prompt: a digest of the whole thing, a bounded
 * normalized prefix, and the full normalized length. The digest is what makes
 * the prefix accountable — it identifies the prompt the prefix was truncated
 * from without persisting the prompt itself.
 */
export function summarizeDispatchPrompt(prompt: string | undefined): DispatchPromptSummary {
  if (prompt === undefined || prompt.length === 0) {
    return { digest: null, prefix: null, chars: 0 };
  }
  const normalized = normalizeForComparison(prompt);
  return {
    digest: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16),
    prefix: normalized.slice(0, PROMPT_PREFIX_MAX_CHARS),
    chars: normalized.length,
  };
}

/**
 * True when the parent already pasted this memory into the dispatch prompt.
 *
 * Built from the retrieved ITEMS, never by scanning the rendered brief for a
 * display string: `docs/invariants.md` records what honouring rendered text as
 * data costs, and the header alone would be the worst needle available —
 * `cortex_brief` emits `Briefing for …:` only when `for` is passed, and a parent
 * may strip it.
 *
 * `renderMemoryLine(item, 2)` is exactly what `brief()` puts on the page and
 * exactly what an explicit `cortex_brief` for the same topic put in front of the
 * parent, so a pasted brief contains these lines verbatim.
 *
 * Strict on purpose: EVERY matched item must already be present. The set
 * `brief()` renders is a budget-trimmed subset of this one, so requiring all of
 * them under-suppresses rather than over-suppresses — under-suppressing costs
 * tokens, over-suppressing costs the whole feature.
 */
export function briefAlreadyInPrompt(
  items: readonly ParsedMemoryItem[],
  normalizedPromptPrefix: string | null | undefined,
): boolean {
  if (!normalizedPromptPrefix || normalizedPromptPrefix.length === 0) {
    return false;
  }
  if (items.length === 0) {
    return false;
  }
  return items.every(item =>
    normalizedPromptPrefix.includes(normalizeForComparison(renderMemoryLine(item, 2))),
  );
}

export interface SubagentBriefOptions {
  /**
   * The dispatch DESCRIPTION, not the prompt. The description is the
   * human-written summary of the job; the prompt is the whole instruction and
   * would swamp retrieval with its own boilerplate.
   */
  description: string;
  agentType: string;
  /** The normalized prefix stored on the capture row, for AC #3. */
  promptPrefix?: string | null;
  budget?: number;
  limit?: number;
}

export interface SubagentBriefResult {
  /** Empty means emit nothing. */
  text: string;
  /** How many memory items matched. Zero is AC #2's silence. */
  matched: number;
  /** Memory matched, but the parent had already pasted it (AC #3). */
  suppressed: boolean;
}

/**
 * Build the brief for one dispatch, or decide there is nothing to say.
 *
 * **The emptiness check runs BEFORE `brief()`, and that ordering is the whole
 * trap.** `brief()` never returns an empty string: with no results it returns
 * `No context found for "<topic>"`, two lines when `forAgent` is set, *and*
 * calls `logRetrieval` on that path. So "call it and discard when empty" would
 * put a sentence at the top of a fresh subagent's context announcing there was
 * nothing to say — worse than silence, because it spends tokens to say nothing —
 * and would write a retrieval-log row on every no-match dispatch.
 *
 * Emptiness is decided STRUCTURALLY, from the retrieval result count, never by
 * matching the rendered `No context found` text.
 *
 * **Reinforcement is deliberate, not incidental.** `brief()` calls
 * `logRetrieval`, which calls `store.touchMemoryItems` and therefore moves
 * hotness — and hotness moves ranking on every future retrieval surface. That
 * makes an automatic brief a retrieval-QUALITY decision, so it was made
 * explicitly: memory is reinforced, because the pre-check means `brief()` is
 * reached only when memory actually matched AND was actually delivered into an
 * agent's context, which is precisely the event hotness exists to record. The
 * alternative — serve the memory and pretend it was never used — would make a
 * real usage channel invisible to decay, so genuinely live memory would age out
 * because the surface serving it did not count. Stated residual: a topic that is
 * repeatedly dispatched about climbs without anyone asking for it, visible in
 * `cortex stats` retrieval health. Note also that `logRetrieval` attributes its
 * row to `retrieval.context.preferredScope?.session.id` — a different resolution
 * path from the token-ledger attribution the caller fixes, and one that resolves
 * to the primary.
 */
export function buildSubagentBrief(
  store: CortexStore,
  options: SubagentBriefOptions,
): SubagentBriefResult {
  const topic = options.description.trim();
  if (topic.length === 0) {
    return { text: '', matched: 0, suppressed: false };
  }

  const limit = options.limit ?? SUBAGENT_BRIEF_LIMIT;
  const retrieval = retrieveMemory(store, topic, limit);
  if (retrieval.results.length === 0) {
    return { text: '', matched: 0, suppressed: false };
  }

  if (briefAlreadyInPrompt(retrieval.results, options.promptPrefix)) {
    return { text: '', matched: retrieval.results.length, suppressed: true };
  }

  const text = brief(store, topic, options.agentType, {
    budget: options.budget ?? SUBAGENT_BRIEF_BUDGET,
    limit,
  });
  return { text, matched: retrieval.results.length, suppressed: false };
}
