import type { CortexStore } from '../db/store.js';
import { selectWorkingMemoryItems, type ScoredMemoryItem } from '../memory/hotness.js';
import { ReferenceValidator } from './reference-validation.js';
import { getPreferredScope } from './scope.js';
import {
  resolveProjectScopeKey,
  resolveWorkingScopeKeys,
} from './state.js';
import { isSupersededMemoryItem } from '../memory/items.js';
import { CONTESTED_MARKER, formatAgeLabel, isContested } from './render.js';
import { estimateTokens } from './retrieval.js';
import { knownUnchangedFiles } from './read-ledger.js';

export interface SessionBriefOptions {
  /** Estimated-token cap for the whole brief (default 150). */
  budget?: number;
  /**
   * Off switch for the FR-7 read-ledger line. Exists so the eval harness can
   * measure the brief deterministically: the line's content depends on files
   * existing on disk with matching hashes, which a seeded in-memory scenario
   * has no way to stage.
   */
  includeReadLedger?: boolean;
}

export const DEFAULT_SESSION_BRIEF_BUDGET = 150;

/**
 * The one seam this module needs, and it exists for a specific failed test.
 *
 * AD-12's guarantee — a throw from the ledger path costs the line, never the
 * brief — cannot be exercised from outside: a Proxy broad enough to break the
 * ledger also breaks `resolveWorkingScopeKeys`, so the brief dies before the
 * `try` is reached and the `catch` is never entered. The first version of that
 * test built such a Proxy, asserted it broke the helper, then called the real
 * store — so deleting the entire `try`/`catch` was invisible to the suite.
 */
export interface SessionBriefDeps {
  knownUnchangedFiles: typeof knownUnchangedFiles;
}

const DEFAULT_BRIEF_DEPS: SessionBriefDeps = { knownUnchangedFiles };

/** Test-only entry point carrying the seam; production calls `buildSessionBrief`. */
export function buildSessionBriefForTest(
  store: CortexStore,
  options: SessionBriefOptions,
  deps: Partial<SessionBriefDeps>,
): string {
  return buildBrief(store, options, { ...DEFAULT_BRIEF_DEPS, ...deps });
}

const BRIEF_NOTE_KINDS = new Set(['note:decision', 'note:blocker', 'note:intent']);
const BRIEF_STATES = new Set(['pinned', 'hot', 'warm']);
const RESUME_MAX_AGE_DAYS = 7;
const MAX_BRIEF_ITEMS = 3;

function truncateLine(text: string, maxChars = 110): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function noteContent(item: ScoredMemoryItem): string {
  const firstLine = item.text.split('\n')[0] ?? '';
  return firstLine.includes(': ')
    ? firstLine.slice(firstLine.indexOf(': ') + 2)
    : firstLine;
}

function resumeLineFrom(items: ScoredMemoryItem[]): string | null {
  const summaries = items
    .filter(item => item.kind === 'episode:session_summary')
    .filter(item => {
      const ageMs = Date.now() - Date.parse(item.created_at);
      return Number.isFinite(ageMs) && ageMs <= RESUME_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  const newest = summaries[0];
  if (!newest) {
    return null;
  }

  const firstLine = newest.text
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(line => line.length > 0 && !/^Command \(/.test(line));
  if (!firstLine) {
    return null;
  }

  return `- resume: ${truncateLine(firstLine)}`;
}

/**
 * One line naming files this scope has read that are still unchanged (FR-7).
 *
 * **Phrased about the files, never about the reader.** `inject-header` creates
 * a fresh primary session on every SessionStart, so essentially every recorded
 * read belongs to an earlier session — "files you already read" would be false
 * on the surface that runs at session start, which is the whole surface. Story
 * 3.3 hit the same wall and stopped rendering `read by primary` over it.
 *
 * **Wrapped, because this is a hook path — and the wrap buys less than the
 * obvious reasons suggest.** An earlier version of this comment justified the
 * `try`/`catch` with "a permission change, a vanished mount, or a path that
 * became a directory". None of those can throw *out*: `probeCurrentState`
 * wraps `statSync` and `computeFileDigest` wraps both `statSync` and
 * `readFileSync`, and all of permission-denied, replaced-by-directory, deleted,
 * grown-past-ceiling and oversize were measured returning verdicts rather than
 * raising. The reachable throw is the **store**, not the filesystem — a second
 * connection holding `BEGIN EXCLUSIVE` yields `SQLITE_BUSY`. In that case
 * `buildSessionBrief` dies earlier anyway, at `resolveWorkingScopeKeys`, so the
 * catch does not save the brief there either.
 *
 * It is kept because AD-12 binds SessionStart to silence and a brief that dies
 * takes the notes with it, so the cheap guard is worth having on a path that
 * newly touches the filesystem at all — but it is a backstop, not a mechanism,
 * and claiming otherwise would be the kind of doc assertion this repo treats as
 * code.
 */
function readLedgerLine(
  store: CortexStore,
  scopeKeys: string[],
  options: SessionBriefOptions,
  deps: SessionBriefDeps,
): string | null {
  if (options.includeReadLedger === false) {
    return null;
  }
  try {
    const files = deps.knownUnchangedFiles(store, scopeKeys);
    if (files.length === 0) {
      return null;
    }
    return `- read in this scope, still unchanged: ${files.map(formatLedgerPath).join(', ')}`;
  } catch {
    return null;
  }
}

/** Longest a single path may render before the middle is elided. */
const LEDGER_PATH_MAX = 44;

/**
 * Make one path safe to place in a comma-joined brief line.
 *
 * **This was the only line in the brief that was neither collapsed nor
 * truncated**, and both omissions are reachable:
 *
 * - **A newline forges a whole line.** Digest paths keep whatever the agent
 *   read, and `toScopeRelativeKey` preserves control characters, so on Linux,
 *   macOS and WSL — the platforms `hooks/` ships for — a file named
 *   `a.ts\n- resume: …` rendered a `- resume:` line the store never produced,
 *   in the unprompted SessionStart channel. A lone CR overwrites the line on a
 *   terminal. This is the class already bound in `digest-index` ("a raw newline
 *   forges a whole record"), in `inspect-memory` ("a newline in `subject`
 *   forges a second listing row") and by `renderReadLedgerLine`'s own
 *   `collapse()` — the rule existed and this line skipped it.
 * - **A comma forges an entry**, on every platform, with an ordinary filename:
 *   two real files `a,b.ts` and `z.ts` render as three names. Quoted rather
 *   than escaped, so the path stays readable and greppable.
 * - **An unbounded path can eat the whole brief.** Reads outside the scope root
 *   keep absolute keys by design, and this repo's live store already holds
 *   agent task outputs under `AppData`. Measured: five 78-character paths cost
 *   108 tokens, 72% of the 150-token budget, and the line then drops
 *   all-or-nothing — so a deep-path repo silently got *no* line rather than a
 *   shorter one. `renderReadLedgerLine` caps each file for the same reason.
 */
export function formatLedgerPath(filePath: string): string {
  // eslint-disable-next-line no-control-regex
  const collapsed = filePath
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Elide the MIDDLE: the leading directories disambiguate siblings and the
  // basename identifies the file, so cutting either end alone loses more.
  const shown =
    collapsed.length <= LEDGER_PATH_MAX
      ? collapsed
      : `${collapsed.slice(0, 12)}…${collapsed.slice(-(LEDGER_PATH_MAX - 13))}`;
  return shown.includes(',') ? `"${shown}"` : shown;
}

/**
 * The pull channel: a tiny, validated, branch-scoped memory brief injected at
 * SessionStart. Lead with proof of value, never with a demand. Emits an empty
 * string when nothing qualifies so cold starts cost zero tokens.
 */
export function buildSessionBrief(
  store: CortexStore,
  options: SessionBriefOptions = {},
): string {
  return buildBrief(store, options, DEFAULT_BRIEF_DEPS);
}

function buildBrief(
  store: CortexStore,
  options: SessionBriefOptions,
  deps: SessionBriefDeps,
): string {
  const budget = options.budget ?? DEFAULT_SESSION_BRIEF_BUDGET;
  const scopeKeys = resolveWorkingScopeKeys(store);
  if (scopeKeys.length === 0) {
    return '';
  }

  const preferredScope = getPreferredScope(store);
  const selection = selectWorkingMemoryItems(
    store,
    scopeKeys,
    preferredScope?.scopeKey ?? resolveProjectScopeKey(store),
    24,
  );

  const validator = new ReferenceValidator(store);
  const bullets: string[] = [];
  for (const item of selection) {
    if (bullets.length >= MAX_BRIEF_ITEMS) {
      break;
    }
    if (!BRIEF_NOTE_KINDS.has(item.kind) || !BRIEF_STATES.has(item.state)) {
      continue;
    }
    // A superseded decision demotes to warm at best (FR-4) — inside
    // BRIEF_STATES, unlike resolved, which lands cold and filters itself. This
    // channel prints unprompted on every SessionStart; a retired decision here
    // would read as settled context.
    if (isSupersededMemoryItem(item)) {
      continue;
    }

    const validation = validator.validate(item);
    const locatable = validation.exists + validation.moved;
    if (validation.references.length > 0 && locatable === 0) {
      // Every referenced file is gone: not trustworthy enough for the brief.
      continue;
    }

    let refSuffix = '';
    if (validation.missing > 0) {
      refSuffix = ` (refs: ${validation.missing} missing)`;
    } else if (validation.moved > 0) {
      refSuffix = ' (refs moved)';
    }

    const kindLabel = item.kind.slice('note:'.length);
    const age = formatAgeLabel(item.created_at);
    const agePart = age ? `[${age}] ` : '';
    const subjectPart = item.subject ? `[${item.subject}] ` : '';
    // This channel prints unprompted on every SessionStart and selects
    // note:decision in state warm — exactly an active contested decision — so
    // an unmarked side of an open contest is presented as settled memory
    // before the agent has asked anything. Same reason reflex carries it.
    const contested = isContested(item) ? CONTESTED_MARKER : '';
    bullets.push(
      `- ${agePart}${kindLabel}: ${subjectPart}${truncateLine(noteContent(item))}${contested}${refSuffix}`,
    );
  }
  validator.flush();

  const resume = resumeLineFrom(selection);
  const ledger = readLedgerLine(store, scopeKeys, options, deps);
  if (bullets.length === 0 && !resume && !ledger) {
    return '';
  }

  const scopeLabel =
    preferredScope && preferredScope.scopeType !== 'project'
      ? preferredScope.scopeLabel
      : 'project';
  const header = `Cortex memory (${scopeLabel}):`;
  const footer = 'More: cortex_recall(topic).';

  const lines = [header, ...bullets];
  if (resume) {
    lines.push(resume);
  }
  if (ledger) {
    lines.push(ledger);
  }
  lines.push(footer);

  // AC #2: the read-ledger line drops FIRST, and that is enforced explicitly
  // rather than by where it sits. The generic loop below removes the last line
  // before the footer, so appending the ledger line last would make the AC true
  // *by accident* — and any later reordering, or a `resume` line arriving after
  // it, would break the guarantee silently while every test still passed. It is
  // the least valuable line here (notes are load-bearing memory; this is an
  // orientation hint), so it is also the right thing to lose.
  if (ledger && estimateTokens(lines.join('\n')) > budget) {
    lines.splice(lines.indexOf(ledger), 1);
  }

  // Enforce the budget by dropping bullets from the bottom (header/footer stay).
  while (lines.length > 2 && estimateTokens(lines.join('\n')) > budget) {
    const removableIndex = lines.length - 2;
    lines.splice(removableIndex, 1);
  }

  if (lines.length <= 2) {
    return '';
  }

  return lines.join('\n');
}
