#!/usr/bin/env node

import { CortexStore, type SessionRow } from '../db/store.js';
import {
  handleAgentEvent,
  handleCmdEvent,
  handleEditEvent,
  handleReadEvent,
  handleWriteEvent,
} from '../capture/hooks.js';
import {
  installStoreCloseOnExit,
  openProjectStore,
  resolveProjectStore,
} from '../scope/store-migration.js';
import { maybeCheckpointWal, UnopenableStoreError } from '../db/schema.js';
import { reflectMemory, type ReflexEvent } from '../query/reflex.js';
import { suggestNotes } from '../query/suggest-notes.js';
import { estimateTokens } from '../query/retrieval.js';
import { flushSpool } from '../capture/spool.js';
import { writeDigestIndex } from '../capture/digest-index.js';
import {
  ensureScopedSession,
  recordSubagentAmbiguity,
  recordSubagentBriefed,
  recordSubagentDispatch,
  recordSubagentPairing,
  recordSubagentStart,
  type ScopeSessionOptions,
} from '../scope/runtime.js';
import {
  buildSubagentBrief,
  dispatchCutoff,
  dispatchHorizonSeconds,
  subagentBriefEnabled,
  summarizeDispatchPrompt,
} from '../query/subagent-brief.js';
import { configureEngagementPath, readEngagement, writeEngagement } from './mcp.js';

const CORTEX_CONSULTED_KEY = 'cortex_consulted';
const CONSULT_GATE_FIRED_KEY = 'consult_gate_fired';
const CONSULT_GATE_SURFACED_COUNT_KEY = 'consult_gate_surfaced_count';
const AGENT_USED_KEY = 'agent_used';
const CONSULT_GATE_CONTEXT =
  'Cortex may have prior context for this work — cortex_recall(topic) checks; cortex_state for broad state.';
const MEMORY_RELEVANT_PROMPT_PATTERN =
  /\b(resume|resumed|resuming|continue|continuing|again|earlier|previous|prior|follow[- ]?up|pick up|fix|debug|bug|error|failure|failing|broken|regression|implement|plan|multi[- ]?step|decision|remember|memory|refactor)\b/i;
const STOP_NUDGE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * The context-injection envelope.
 *
 * Widened to `SubagentStart` for Story 5.2, on a MEASURED result rather than on
 * the documentation: a `SubagentStart` hook emitting this shape reaches the
 * dispatched subagent, which quoted the marker back verbatim and reported it
 * arrived before it did any work. Story 4.5's standing rule is that this
 * mechanism is probed, never inferred — a wrong-shaped payload costs nothing,
 * throws nothing, exits 0, and is indistinguishable from a miss.
 *
 * The near-identical `toHookJson` in `query/reflex.ts` is deliberately NOT
 * widened: it takes a `ReflexEvent`, and no reflex event can ever be a
 * `SubagentStart`, so the two are correctly divergent.
 */
function toHookJson(
  hookEventName: 'UserPromptSubmit' | 'PreToolUse' | 'SubagentStart',
  additionalContext: string,
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  });
}

export type HookAction =
  | 'post'
  | 'reflect-prompt'
  | 'reflect-pre'
  | 'reflect-edit'
  | 'reflect-cmd'
  | 'reflect-agent'
  | 'dispatch-pre'
  | 'subagent-start'
  | 'end-of-turn';

export interface HookRuntimeOptions {
  sessionId?: string;
  stateDir?: string;
  requireEngagement?: boolean;
}

function openCortexDb(startDir: string): CortexStore {
  return new CortexStore(openProjectStore(startDir).db);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(root[key]);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const resolved = stringValue(value);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Subagent identity as the host reports it. Field-name drift must degrade to
 * primary-session attribution — today's behavior — rather than break capture,
 * so both snake_case and camelCase spellings are accepted and absence is fine.
 */
function agentIdentity(payload: Record<string, unknown>): ScopeSessionOptions {
  const agentId = firstString(payload['agent_id'], payload['agentId']);
  if (!agentId) {
    return {};
  }

  const agentType = firstString(payload['agent_type'], payload['agentType']);
  return { agentId, ...(agentType ? { agentType } : {}) };
}

function resolveSessionId(
  store: CortexStore,
  cwd: string,
  options: HookRuntimeOptions,
  identity: ScopeSessionOptions = {},
): string {
  return options.sessionId ?? ensureScopedSession(store, cwd, identity).id;
}

function isEnabled(cwd: string, options: HookRuntimeOptions): boolean {
  if (options.requireEngagement === false) {
    return true;
  }

  configureEngagementPath(cwd);
  return readEngagement()['enabled'] === 'true';
}

function hasPriorScopeSessions(store: CortexStore): boolean {
  const session = store.getCurrentSession() ?? store.getRecentPrimarySessions(1)[0];
  if (!session) {
    return false;
  }

  const scopeCount = session.scope_key
    ? store.getSessionCountByScope(session.scope_key)
    : store.getSessionCount();
  return scopeCount > 1;
}

function promptGateReason(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  return MEMORY_RELEVANT_PROMPT_PATTERN.test(prompt)
    ? 'prompt indicates resumed, debugging, implementation, or decision-heavy work'
    : undefined;
}

function incrementConsultGateCount(engagement: Record<string, string>): void {
  const surfaced = Number.parseInt(engagement[CONSULT_GATE_SURFACED_COUNT_KEY] ?? '0', 10);
  const next = Number.isFinite(surfaced) ? surfaced + 1 : 1;
  writeEngagement(CONSULT_GATE_SURFACED_COUNT_KEY, String(next));
}

/**
 * Book what a hook surface injected (AC #1).
 *
 * Guarded end to end: AD-12 binds every hook edge to silence, so accounting
 * must never turn an injection into a broken hook. A missing session simply
 * books nothing — there is no session to attribute it to, and inventing one
 * from a hook path is worse than an unbooked row.
 *
 * `sessionId` exists because `getCurrentSession()` is PRIMARY-ONLY by SQL, and
 * text injected into a SUBAGENT's context is not the parent's cost. Without it
 * Story 5.2's brief would bill every dispatch to the parent, and the P&L that
 * judges whether the feature is worth its tokens would be wrong about which
 * session paid. The two pre-existing callers — `renderConsultGate` and
 * `endOfTurn` — pass nothing and keep booking to the primary, deliberately:
 * both are parent-facing surfaces.
 */
function bookHookInjection(
  store: CortexStore,
  type: string,
  text: string,
  sessionId?: string,
): void {
  if (text.length === 0) {
    return;
  }
  try {
    const target = sessionId ?? store.getCurrentSession()?.id;
    if (!target) {
      return;
    }
    store.insertLedgerEntry({
      sessionId: target,
      type,
      direction: 'injected',
      tokens: estimateTokens(text),
    });
  } catch {
    // Never breaks a hook.
  }
}

/**
 * One-line, once-per-session hint. The SessionStart brief and the reflex are
 * the real memory channels; this only catches sessions where the brief was
 * empty but the prompt looks memory-relevant.
 */
function renderConsultGate(
  store: CortexStore,
  cwd: string,
  hookEventName: 'UserPromptSubmit' | 'PreToolUse',
  reason: string | undefined,
): string {
  configureEngagementPath(cwd);
  const engagement = readEngagement();
  if (engagement['enabled'] === 'false') {
    return '';
  }
  if (engagement[CORTEX_CONSULTED_KEY] === 'true') {
    return '';
  }
  if (engagement['state_called'] === 'true') {
    return '';
  }
  if (engagement[CONSULT_GATE_FIRED_KEY] === 'true') {
    return '';
  }

  const resolvedReason = reason ?? (
    hasPriorScopeSessions(store) ? 'current scope has prior Cortex sessions' : undefined
  );
  if (!resolvedReason) {
    return '';
  }

  writeEngagement(CONSULT_GATE_FIRED_KEY, 'true');
  incrementConsultGateCount(engagement);
  // AC #1: this injects into the agent's context, so it books what it cost.
  // `hook-entry` contained no ledger write at all — two surfaces that push
  // text unprompted were invisible to the P&L that judges whether Cortex is
  // worth its tokens, which is exactly the surface a cost figure must not miss.
  bookHookInjection(store, 'consult_gate', CONSULT_GATE_CONTEXT);
  return toHookJson(hookEventName, CONSULT_GATE_CONTEXT);
}

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  return nestedRecord(payload, 'tool_input');
}

function toolName(payload: Record<string, unknown>): string {
  return firstString(payload['tool_name'], payload['toolName']) ?? '';
}

function extractFile(input: Record<string, unknown>): string | undefined {
  const direct = firstString(input['file_path'], input['path'], input['file']);
  if (direct) {
    return direct;
  }

  const patch = firstString(input['patch'], input['input'], input['text']);
  const match = patch?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match?.[1]?.trim();
}

function extractCommand(input: Record<string, unknown>): string | undefined {
  return firstString(input['command'], input['cmd']);
}

function extractExit(payload: Record<string, unknown>): string | undefined {
  const toolResult = nestedRecord(payload, 'tool_result');
  const toolOutput = nestedRecord(payload, 'tool_output');
  const toolResponse = nestedRecord(payload, 'tool_response');
  const result = nestedRecord(payload, 'result');
  const exit = firstString(
    payload['exit_code'],
    toolResult['exit_code'],
    toolOutput['exit_code'],
    toolResponse['exit_code'],
    result['exit_code'],
  );
  if (exit) {
    return exit;
  }

  for (const value of [
    payload['exit_code'],
    toolResult['exit_code'],
    toolOutput['exit_code'],
    toolResponse['exit_code'],
    result['exit_code'],
  ]) {
    if (typeof value === 'number') {
      return String(value);
    }
  }

  return undefined;
}

function extractStream(payload: Record<string, unknown>, key: 'stdout' | 'stderr'): string | undefined {
  const toolResult = nestedRecord(payload, 'tool_result');
  const toolOutput = nestedRecord(payload, 'tool_output');
  const toolResponse = nestedRecord(payload, 'tool_response');
  const result = nestedRecord(payload, 'result');
  return firstString(
    payload[key],
    toolResult[key],
    toolOutput[key],
    toolResponse[key],
    result[key],
  );
}

function postToolUse(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): void {
  // A payload carrying agent_id is a subagent's tool call and is attributed to
  // that subagent's own session, never the parent's timeline (AD-9).
  const sessionId = resolveSessionId(store, cwd, options, agentIdentity(payload));
  const name = toolName(payload);
  const input = toolInput(payload);

  if (name === 'Read') {
    const file = extractFile(input);
    if (file) {
      handleReadEvent(store, sessionId, { file });
      // Same reason as the CLI path: this cold path records a digest the spool
      // flush will never see, and the flush gate cannot notice it.
      writeDigestIndex(store, cwd);
    }
    return;
  }

  if (name === 'Edit' || name === 'apply_patch' || name.endsWith('.apply_patch')) {
    const file = extractFile(input);
    if (file) {
      handleEditEvent(store, sessionId, { file });
    }
    return;
  }

  if (name === 'Write') {
    const file = extractFile(input);
    if (file) {
      handleWriteEvent(store, sessionId, { file });
    }
    return;
  }

  if (name === 'Bash' || name === 'shell_command' || name.endsWith('.shell_command')) {
    const cmd = extractCommand(input);
    if (cmd) {
      handleCmdEvent(store, sessionId, {
        cmd,
        exit: extractExit(payload),
        stdout: extractStream(payload, 'stdout'),
        stderr: extractStream(payload, 'stderr'),
      });
    }
    return;
  }

  if (name === 'Agent') {
    const desc = firstString(input['description'], input['desc']);
    if (desc) {
      handleAgentEvent(store, sessionId, { desc });
      try {
        configureEngagementPath(cwd);
        writeEngagement(AGENT_USED_KEY, 'true');
      } catch {
        // Marker is advisory; capture already succeeded.
      }
    }
  }
}

/**
 * `PreToolUse` on the `Agent` tool (FR-18, Story 5.2): record the dispatch, so
 * that `SubagentStart` — which carries no description — has one to brief from.
 *
 * Emits nothing, ever. This runs on the PARENT's `PreToolUse`, where a returned
 * envelope would inject context into the parent rather than the subagent — and
 * where the deny mechanism that event uniquely offers would gate the user's own
 * dispatch. AD-7 forbids that mechanism for economics, and a source-negative
 * test in `tests/substitution.test.ts` keeps its spelling out of this file
 * entirely, so a later change cannot reach for it unnoticed.
 */
function dispatchPre(
  store: CortexStore,
  payload: Record<string, unknown>,
): void {
  try {
    captureDispatch(store, payload);
  } catch {
    // AD-12 / N-3: same contract as `subagentStart` below. A dispatch that goes
    // unrecorded costs one brief; a dispatch that prints a stack trace costs the
    // user's turn.
  }
}

function captureDispatch(store: CortexStore, payload: Record<string, unknown>): void {
  // The off switch is checked HERE too, not only where the brief is emitted.
  // Reproduced in review: with `CORTEX_SUBAGENT_BRIEF=off` — the spelling the
  // README tells users to flip — every dispatch still wrote a row that nothing
  // would ever consume, and `doctor`'s "captures with no pairings" rule then
  // warned FOREVER on a deliberately configured install, naming
  // `cortex install` as a fix that repairs nothing. That is the cries-wolf half
  // of AD-12 arriving through the one switch documented to prevent all of this.
  if (!subagentBriefEnabled()) {
    return;
  }

  // The matcher is the host's job, but a hand-edited or broadened matcher would
  // otherwise file every Edit and Bash into the dispatch table.
  if (toolName(payload) !== 'Agent') {
    return;
  }

  const input = toolInput(payload);
  const hostSessionId = firstString(payload['session_id'], payload['sessionId']);
  const promptId = firstString(payload['prompt_id'], payload['promptId']);
  const description = firstString(input['description'], input['desc']);
  // STRICT, with no default. `subagent_type` is optional on the `Agent` tool, so
  // it is tempting to substitute the host's documented default — but the default
  // agent's reported name is a host detail (this machine's own agent list names
  // its catch-all `claude`, not `general-purpose`), and a wrong guess does not
  // merely fail to pair: it puts a foreign row into the queue for a type that
  // IS dispatched, where FIFO would hand it to a legitimate subagent. That is
  // SM-C3 — telling an agent something untrue — bought for a convenience.
  // Refusing to capture costs one brief and can never mislead anyone.
  const agentType = firstString(input['subagent_type'], input['subagentType']);
  if (!hostSessionId || !promptId || !agentType || !description) {
    return;
  }

  // Read, never resolve. `ensureScopedSession` here would rotate the parent's
  // live session mid-turn whenever this cwd resolved to a different scope, and
  // a dispatch is not a session boundary. With no active primary there is
  // nothing to scope the capture to and nothing to brief from later.
  const primary = store.getCurrentSession();
  if (!primary?.scope_key) {
    return;
  }

  const prompt = summarizeDispatchPrompt(firstString(input['prompt']));
  store.insertSubagentDispatch({
    scopeKey: primary.scope_key,
    hostSessionId,
    promptId,
    agentType,
    // Not read by this story. Recorded because Story 5.3 wires `SubagentStop`,
    // where the per-agent sidecar's `toolUseId` is finally readable and the
    // pairing this story performs becomes auditable rather than merely
    // unambiguous.
    toolUseId: firstString(payload['tool_use_id'], payload['toolUseId']) ?? null,
    description,
    promptDigest: prompt.digest,
    promptPrefix: prompt.prefix,
    promptChars: prompt.chars,
  });
  recordSubagentDispatch(store);
}

/**
 * `SubagentStart` (FR-17/FR-18): give a dispatched subagent its own session
 * before it does anything, then brief it from the dispatch this hook can now
 * pair with.
 *
 * The measured payload is seven fields — `agent_id`, `agent_type`, `cwd`,
 * `hook_event_name`, `prompt_id`, `session_id`, `transcript_path` — and carries
 * neither the dispatch description nor `tool_input`, whatever the hook docs list
 * as conditionally present. Nothing here may depend on more than that.
 *
 * Two independently guarded halves, deliberately. The session is the deliverable
 * Story 5.1 shipped and every later story depends on; the brief is an
 * optimisation on top of it. A brief that throws must not cost the attribution,
 * and a session that throws must not be retried by the brief path.
 */
function subagentStart(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
): string {
  let child: SessionRow | undefined;
  try {
    child = createSubagentSession(store, payload, cwd);
  } catch {
    // AD-12 / N-3, and the wrapper script's promise that it prints nothing and
    // exits 0. `main()` guards only `openCortexDb` and rethrows everything
    // else, so an escape here reaches the turn as a stack trace on stderr and a
    // non-zero exit. `ensureAgentSession` genuinely can throw — it rethrows
    // when it loses the create race and the re-find misses, reachable on a
    // store whose unique index degraded to non-unique — and SQLITE_BUSY from a
    // second hook lands in the same place. A subagent losing its session is a
    // miss; a subagent's dispatch printing a stack trace is a broken turn.
    return '';
  }

  if (!child) {
    return '';
  }

  try {
    return renderSubagentBrief(store, payload, child);
  } catch {
    // Same contract. Retrieval, rendering and the ledger write all sit under
    // here, and `SubagentStart` cannot block a subagent — the host renders a
    // non-zero exit as a notice and proceeds — so the only harm this half can do
    // is noise. Silence is the correct failure.
    return '';
  }
}

function createSubagentSession(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
): SessionRow | undefined {
  const identity = agentIdentity(payload);
  if (!identity.agentId) {
    // Host drift, or an event for something that is not a subagent. Doing
    // nothing is the only safe answer: `resolveSessionId` without an identity
    // resolves — and creates — a PRIMARY session, so the obvious fallback would
    // manufacture a primary as a side effect of a subagent event, and rotate the
    // real one whenever this `cwd` resolved to a different scope.
    return undefined;
  }

  // AC #1 says the child records "the parent's scope_key", so a parent has to
  // exist. With no active primary `ensureScopedSession` would fall through to
  // `ensurePrimarySession` and MINT one from the subagent's own cwd — running
  // `detectGitScope` on this path and attaching the child to a scope the parent
  // never had. A subagent event must never be the thing that creates a primary.
  // Unreachable in the installed wiring (engagement implies `inject-header`
  // ran, which always leaves an active primary), so the cost of being strict
  // here is nil and the cost of being permissive is a wrong parent.
  const primary = store.getCurrentSession();
  if (!primary?.scope_key) {
    return undefined;
  }

  // AD-12: a wired-but-dead path must not look like an idle one. `doctor` reads
  // these to tell "never fired" from "nothing dispatched lately", and to catch
  // the case in between — subagents running that this hook never saw.
  //
  // BEFORE the session, not after. `doctor` counts children with
  // `started_at >= <marker>`, and stamping the marker after the create put it
  // ONE MILLISECOND past the child it had just made — so the very first child of
  // every store fell outside its own window and the row printed a count one too
  // low, permanently. Measured in Story 5.2's sandbox proof: child at
  // ...33.211Z, marker at ...33.212Z, "4 fired, 3 recorded" against four real
  // children. Moving it here also fails in the safe direction: a fire counted
  // whose `ensureScopedSession` then throws leaves fires > children, which is
  // the quiet side of the comparison.
  recordSubagentStart(store);

  // `ensureScopedSession` adopts that primary rather than resolving one from
  // the subagent's cwd, so it cannot end or rotate the parent (AD-9); it
  // find-or-creates by (scope_key, agent_id) behind a partial unique index; and
  // it inherits the parent's scope fields.
  return ensureScopedSession(store, cwd, identity);
}

/**
 * Pair this start with the dispatch that produced it, and brief from it.
 *
 * **The pairing key is `(session_id, prompt_id, agent_type)`**, all three of
 * which appear in BOTH measured payloads, and each part earns its place:
 * `session_id` separates two host windows open on one branch (they share a
 * `scope_key`, so scope alone does not divide them); `prompt_id` separates a
 * stale capture from an earlier turn, which is the mispairing that would hand a
 * subagent context from genuinely unrelated work; `agent_type` separates
 * concurrent dispatches of different types.
 *
 * `scope_key` is stored on the capture but deliberately NOT part of the key:
 * `session_id` is already one host window on one project, and adding scope could
 * only turn a correct pairing into a miss if the primary rotated between the
 * dispatch and the start — about 800 ms apart, measured.
 *
 * **More than one candidate means say nothing** (ruling: ShuromiU, 2026-08-07).
 *
 * The story shipped the opposite — take the oldest — and justified it with
 * "refusing would silence exactly the fan-out case, which is where briefing is
 * worth most". **Review proved that premise false.** The measured host ordering
 * is strictly interleaved — `PreToolUse(alpha) → SubagentStart(alpha) →
 * PreToolUse(bravo) → SubagentStart(bravo)` — so a genuine same-message fan-out
 * never has two captures pending at a start, and kept its briefs either way.
 * What first-come-first-served actually resolved was the BROKEN shapes, and it
 * resolved them wrongly: an `Agent` call the user denies fires `PreToolUse` and
 * never starts, the assistant re-dispatches in the SAME turn — same
 * `session_id`, same `prompt_id`, same `agent_type`, inside the horizon — and
 * the real subagent is handed the orphan. Reproduced: a subagent sent to audit
 * the read ledger opened with `Most relevant — Decision [kafka pipeline]`. That
 * is SM-C3, reached by an ordinary user action, and the story's stated residual
 * explicitly did not cover it: an orphan is not a sibling.
 *
 * The refusal does NOT consume anything. Draining to one and briefing from the
 * survivor would just be the same guess with an extra step, and which row is the
 * orphan is exactly what cannot be known here. Stated consequence: one denied
 * dispatch makes every later same-type subagent in that turn silent. Silence is
 * this feature's documented default, so the cost is a missed brief, never a
 * wrong one — and the count is reported so the shape's frequency is visible.
 */
function renderSubagentBrief(
  store: CortexStore,
  payload: Record<string, unknown>,
  child: SessionRow,
): string {
  if (!subagentBriefEnabled()) {
    return '';
  }

  const agentId = agentIdentity(payload).agentId;
  const hostSessionId = firstString(payload['session_id'], payload['sessionId']);
  const promptId = firstString(payload['prompt_id'], payload['promptId']);
  const agentType = firstString(payload['agent_type'], payload['agentType']);
  if (!agentId || !hostSessionId || !promptId || !agentType) {
    return '';
  }

  const key = { hostSessionId, promptId, agentType };
  const cutoff = dispatchCutoff(new Date(), dispatchHorizonSeconds());

  const pending = store.countPendingSubagentDispatches(key, cutoff);
  if (pending === 0) {
    return '';
  }
  if (pending > 1) {
    recordSubagentAmbiguity(store);
    return '';
  }

  // One conditional statement, never read-then-write: two `SubagentStart` hooks
  // are independent processes and `busy_timeout` does not make read-then-write
  // atomic, so the naive shape would hand ONE capture to TWO subagents. The same
  // statement also refuses a second claim by an agent that already has one.
  const dispatch = store.consumeSubagentDispatch(key, cutoff, agentId);
  if (!dispatch) {
    return '';
  }

  // Booked HERE, before the brief is built. Booking it afterwards left a
  // throwing brief with the capture consumed and `paired` un-incremented —
  // reproduced with retrieval stubbed to throw: four consumed rows, `paired`
  // unset, and `doctor` warning "no dispatch has ever paired" with a fix wrong
  // for that cause.
  recordSubagentPairing(store);

  const result = buildSubagentBrief(store, {
    description: dispatch.description,
    agentType,
    promptPrefix: dispatch.promptPrefix,
  });

  if (result.text.length === 0) {
    return '';
  }
  recordSubagentBriefed(store);

  // The CHILD, not the primary. This text lands in the subagent's context and is
  // the subagent's cost; billing it to the parent would make the P&L wrong about
  // the one thing this story is measured on.
  bookHookInjection(store, 'subagent_brief', result.text, child.id);
  return toHookJson('SubagentStart', result.text);
}

function truncateSuggestion(text: string, maxChars = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars
    ? collapsed
    : `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Stop-hook nudge, conditional: only blocks the turn end when this turn used a
 * subagent AND suggest-notes has concrete high-confidence candidates to show.
 * Silence is the default. Disable entirely with CORTEX_STOP_NUDGE=off.
 */
function endOfTurn(
  store: CortexStore,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): string {
  if (payload['stop_hook_active'] === true) {
    return '';
  }

  // Replay this turn's spooled capture first so suggestions see fresh evidence.
  try {
    // `transcript_path` is the ONLY channel through which a command pass/fail
    // is observable (FR-14): measured 2026-08-03, the Bash PostToolUse payload
    // carries no exit code at all, and a host-failed command fires no
    // PostToolUse whatsoever. Passed straight from the payload rather than
    // derived — a path reconstructed by mangling the cwd would be a guess, and
    // this is the one hook that already receives the real value. A host that
    // provides none simply attaches no outcomes.
    const transcriptPath = stringValue(payload['transcript_path']) ?? null;
    flushSpool(store, cwd, resolveSessionId(store, cwd, options), undefined, {
      transcriptPath,
    });
  } catch {
    // Spool replay is best-effort at turn end; next flush picks it up.
  }

  // The one hook path where a checkpoint is safe (FR-25 AC #2). `PostToolUse`
  // is pure bash and spawns no Node at all (N-4), and `reflect-pre` sits on the
  // Edit/Write path where latency is the user's, so end-of-turn — after the
  // turn's work is done — is where a size-triggered checkpoint belongs.
  try {
    // Both arguments from ONE resolution. Taking the handle from `store` and
    // the path from a separate `resolveProjectStore(cwd)` let the size gate read
    // one file while the checkpoint acted on another — production agreed only
    // because `main()` derives both from the same cwd, and `handleHookPayload`
    // is exported with `store` and `cwd` as independent parameters.
    maybeCheckpointWal(store.db, store.db.name);
  } catch {
    // AD-12: a checkpoint that cannot run degrades to silence.
  }

  if (process.env['CORTEX_STOP_NUDGE'] === 'off') {
    return '';
  }

  configureEngagementPath(cwd);
  const engagement = readEngagement();
  const agentUsed =
    engagement[AGENT_USED_KEY] === 'true' || payload['agent_used'] === true;
  if (!agentUsed) {
    return '';
  }
  writeEngagement(AGENT_USED_KEY, 'false');

  let suggestions;
  try {
    const sessionId = resolveSessionId(store, cwd, options);
    // The nudge fires only when a subagent ran, and a subagent's evidence lives
    // in its own session — so collecting from the primary alone would blind it
    // in exactly the case it exists for. Walk the whole tree and dedupe.
    const seen = new Set<string>();
    suggestions = store
      .getSessionTreeIds(sessionId)
      .flatMap(id => suggestNotes(store, id))
      .filter(suggestion => suggestion.confidence >= STOP_NUDGE_CONFIDENCE_THRESHOLD)
      .filter(suggestion => {
        const key = `${suggestion.kind}\u0000${suggestion.content}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  } catch {
    return '';
  }

  if (suggestions.length === 0) {
    return '';
  }

  const shown = suggestions
    .slice(0, 3)
    .map(suggestion => `- ${suggestion.kind}: ${truncateSuggestion(suggestion.content)}`);
  const reason = [
    'Cortex found candidate notes from this turn:',
    ...shown,
    'Write the load-bearing ones with cortex_note(kind, content); if none apply, reply DONE.',
  ].join('\n');

  bookHookInjection(store, 'stop_nudge', reason);
  return JSON.stringify({ decision: 'block', reason });
}

function reflectFromPayload(
  store: CortexStore,
  action: HookAction,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookRuntimeOptions,
): string {
  // Identity, not bare resolution. `reflect-pre` fires on every Edit and Write
  // INCLUDING a subagent's, and a subagent's `PreToolUse` carries `agent_id`
  // (measured). Without it two defects rode together, both re-filed onto this
  // story as one question: the reflex was billed to the primary, and — because
  // `statePath()` keys the dedupe file on the session id — a subagent consumed
  // the PARENT's once-per-anchor marker, so the parent then edited the same file
  // and got no reflex at all. Nothing RENDERED depends on the session id
  // (`reflectMemory` uses it only for that state file and the ledger row), so
  // per invocation this corrects attribution without moving a character of
  // output. In AGGREGATE it does move: the marker is now per session, so a
  // parent and three subagents editing one file produce four whispers where one
  // fired before. Kept by ruling (ShuromiU, 2026-08-07) — each subagent has a fresh
  // context and genuinely has not seen it — with the cost stated rather than
  // discovered later in `cortex stats`.
  //
  // Identity is dropped when no primary is active, mirroring
  // `createSubagentSession`'s guard. `ensureScopedSession` with an `agentId` and
  // no active primary falls through to `ensurePrimarySession` and MINTS one from
  // the subagent's cwd; the child it then creates has no corresponding
  // `SubagentStart` fire, and `doctor`'s `fires < children` rule reads that as
  // missed dispatches. Reproduced: five subagent `Edit` payloads with no start at
  // all produced five children, zero fires, and a warn whose named fix repairs
  // nothing.
  const identity = store.getCurrentSession()?.scope_key ? agentIdentity(payload) : {};
  const sessionId = resolveSessionId(store, cwd, options, identity);
  const input = toolInput(payload);
  let event: ReflexEvent | undefined;
  let prompt: string | undefined;
  let file: string | undefined;
  let cmd: string | undefined;
  let desc: string | undefined;

  if (action === 'reflect-prompt') {
    event = 'prompt';
    prompt = firstString(payload['prompt'], payload['message'], payload['user_prompt']);
    const gate = renderConsultGate(store, cwd, 'UserPromptSubmit', promptGateReason(prompt));
    if (gate) {
      return gate;
    }
  } else if (action === 'reflect-edit') {
    event = 'edit';
    file = extractFile(input) ?? firstString(payload['file']);
  } else if (action === 'reflect-cmd') {
    event = 'cmd';
    cmd = extractCommand(input) ?? firstString(payload['cmd']);
  } else if (action === 'reflect-agent') {
    event = 'agent';
    desc = firstString(input['description'], input['desc'], payload['desc']);
  } else {
    const name = toolName(payload);
    if (name === 'Bash' || name === 'shell_command' || name.endsWith('.shell_command')) {
      event = 'cmd';
      cmd = extractCommand(input);
    } else if (name === 'Edit' || name === 'Write' || name === 'apply_patch' || name.endsWith('.apply_patch')) {
      event = 'edit';
      file = extractFile(input);
    } else if (name === 'Agent') {
      event = 'agent';
      desc = firstString(input['description'], input['desc']);
    }
  }

  if (!event) {
    return '';
  }

  return reflectMemory(store, {
    event,
    prompt,
    file,
    cmd,
    desc,
    sessionId,
    stateDir: options.stateDir,
  });
}

export function handleHookPayload(
  store: CortexStore,
  action: HookAction,
  rawPayload: string,
  cwd: string,
  options: HookRuntimeOptions = {},
): string {
  if (!isEnabled(cwd, options)) {
    return '';
  }

  const payload = parsePayload(rawPayload);
  if (action === 'post') {
    postToolUse(store, payload, cwd, options);
    return '';
  }

  // BOTH branches are load-bearing, and a missing one is TYPE-CLEAN. This
  // function is a chain of `if`s ending in `return reflectFromPayload(...)`,
  // `main()` casts `process.argv[2] as HookAction` unchecked, and there is no
  // exhaustive switch and no `never` guard — so adding a member to `HookAction`
  // and forgetting its branch compiles, and every dispatch then falls into the
  // reflex path, whose else-branch maps `toolName === 'Agent'` to the `agent`
  // reflex and injects `additionalContext` into the PARENT.
  if (action === 'dispatch-pre') {
    dispatchPre(store, payload);
    return '';
  }

  if (action === 'subagent-start') {
    return subagentStart(store, payload, cwd);
  }

  if (action === 'end-of-turn') {
    return endOfTurn(store, payload, cwd, options);
  }

  return reflectFromPayload(store, action, payload, cwd, options);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const action = process.argv[2] as HookAction | undefined;
  if (!action) {
    return;
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);
  const cwd = stringValue(payload['cwd']) ?? process.cwd();

  let store;
  try {
    store = openCortexDb(cwd);
  } catch (err) {
    // AD-12: every hook path degrades to silence. A store written by a newer
    // build is refused (P-5), and this is the one place that refusal must NOT
    // be spoken: `reflect-pre` fires on every Edit and Write, so surfacing it
    // would print a stack trace on every tool call and exit non-zero. The user
    // learns about it from `cortex doctor`, which is built to report it and is
    // unaffected because it opens read-only.
    if (err instanceof UnopenableStoreError) {
      return;
    }
    throw err;
  }

  const output = handleHookPayload(store, action, raw, cwd);
  if (output) {
    process.stdout.write(`${output}\n`);
  }
}

const self = process.argv[1] ?? '';
if (self.endsWith('hook-entry.js') || self.endsWith('hook-entry.ts')) {
  // Same rule as the CLI: one hook fire is one process, so exit is the close.
  installStoreCloseOnExit();
  void main();
}
