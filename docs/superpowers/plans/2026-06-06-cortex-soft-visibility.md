# Cortex Soft Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cortex visibly available through a once-per-session prompt hook hint when Cortex has not been consulted, without forcing a Cortex tool call or injecting memory facts.

**Architecture:** Add a route-level visibility hint in the hook entry path for `reflect-prompt`. Track two line-oriented engagement flags in the existing engagement state file: `cortex_consulted=true` after explicit route/state/recall/brief use, and `visibility_hint_surfaced=true` after the prompt hint appears. Keep `reflectMemory()` prompt behavior fact-silent.

**Tech Stack:** TypeScript, Vitest, existing Cortex MCP/hook transports, existing line-oriented engagement state.

---

## File Structure

- Modify `src/transports/mcp.ts`: configure engagement path for direct `handleToolCall()` calls and mark Cortex as consulted for `cortex_route`, `cortex_state`, `cortex_engage`, `cortex_recall`, and `cortex_brief`.
- Modify `src/transports/hook-entry.ts`: add a prompt-route hint before prompt reflex runs, using existing engagement flags and the existing UserPromptSubmit JSON output shape.
- Modify `tests/hook-entry.test.ts`: update prompt tests to expect route guidance instead of total silence, verify no memory facts leak, verify one-shot behavior, verify suppression after a Cortex tool call, and verify disengage silence.
- Modify `tests/mcp.test.ts`: verify explicit Cortex tool calls set the consulted marker.
- Modify `README.md` and `CLAUDE.md`: document soft visibility as guidance, not a forced startup ritual.

---

### Task 1: Add Red Tests For Prompt Visibility Hint

**Files:**
- Modify: `tests/hook-entry.test.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Add a helper to parse prompt hook `additionalContext`**

In `tests/hook-entry.test.ts`, add this helper after `createTestStore()`:

```ts
function parseAdditionalContext(raw: string): string {
  if (!raw) {
    return '';
  }
  const parsed = JSON.parse(raw) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}
```

- [ ] **Step 2: Replace the old prompt-silent assertion with visibility guidance**

Replace the current test named `keeps UserPromptSubmit prompt reflex silent even when prompt text matches memory` with:

```ts
it('emits prompt visibility guidance without leaking matching memory facts', () => {
  const { store, sessionId } = createTestStore();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

  store.insertNote({
    sessionId,
    kind: 'insight',
    subject: 'living brain',
    content: 'The living brain reflex should stay whisper-only and deduped.',
  });

  const output = handleHookPayload(
    store,
    'reflect-prompt',
    JSON.stringify({ prompt: 'Can we implement the living brain reflex?' }),
    cwd,
    { sessionId, stateDir, requireEngagement: false },
  );
  const context = parseAdditionalContext(output);

  expect(context).toContain('Cortex is available');
  expect(context).toContain('cortex_recall(topic)');
  expect(context).toContain('cortex_state');
  expect(context).not.toContain('living brain reflex should stay whisper-only');
});
```

- [ ] **Step 3: Add one-shot prompt hint test**

Add this test in the same `describe('handleHookPayload')` block:

```ts
it('emits prompt visibility guidance only once per engagement state', () => {
  const { store, sessionId } = createTestStore();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

  const first = handleHookPayload(
    store,
    'reflect-prompt',
    JSON.stringify({ prompt: 'Resume the dashboard work' }),
    cwd,
    { sessionId, stateDir, requireEngagement: false },
  );
  const second = handleHookPayload(
    store,
    'reflect-prompt',
    JSON.stringify({ prompt: 'Continue the dashboard work' }),
    cwd,
    { sessionId, stateDir, requireEngagement: false },
  );

  expect(parseAdditionalContext(first)).toContain('Cortex is available');
  expect(second).toBe('');
});
```

- [ ] **Step 4: Add suppression-after-consulted test**

Import `handleToolCall` from `../src/transports/mcp.js` at the top of `tests/hook-entry.test.ts`:

```ts
import { handleToolCall } from '../src/transports/mcp.js';
```

Then add:

```ts
it('does not emit prompt visibility guidance after Cortex was explicitly consulted', () => {
  const { store, sessionId } = createTestStore();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));

  handleToolCall(store, 'cortex_route', {}, cwd);

  const output = handleHookPayload(
    store,
    'reflect-prompt',
    JSON.stringify({ prompt: 'Resume the dashboard work' }),
    cwd,
    { sessionId, stateDir, requireEngagement: false },
  );

  expect(output).toBe('');
});
```

- [ ] **Step 5: Add disengage silence test**

Import `configureEngagementPath` and `writeEngagement` from `../src/transports/mcp.js` in the same import as `handleToolCall`:

```ts
import { configureEngagementPath, handleToolCall, writeEngagement } from '../src/transports/mcp.js';
```

Then add:

```ts
it('keeps prompt visibility guidance silent when Cortex is disengaged', () => {
  const { store, sessionId } = createTestStore();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-reflex-'));
  configureEngagementPath(cwd);
  writeEngagement('enabled', 'false');

  const output = handleHookPayload(
    store,
    'reflect-prompt',
    JSON.stringify({ prompt: 'Resume the dashboard work' }),
    cwd,
    { sessionId, stateDir },
  );

  expect(output).toBe('');
});
```

- [ ] **Step 6: Add MCP consulted marker test**

In `tests/mcp.test.ts`, import `configureEngagementPath` and `readEngagement` from `../src/transports/mcp.js` in the existing MCP import:

```ts
import {
  TOOL_DEFINITIONS,
  handleToolCall,
  createMcpServer,
  configureEngagementPath,
  readEngagement,
} from '../src/transports/mcp.js';
```

Add this test under the `cortex_route` tests:

```ts
it('cortex_route marks Cortex as consulted for hook visibility suppression', () => {
  configureEngagementPath('/repo');
  handleToolCall(store, 'cortex_route', {}, '/repo');
  expect(readEngagement()['cortex_consulted']).toBe('true');
});
```

- [ ] **Step 7: Run red tests**

Run:

```powershell
npm.cmd run test -- tests/hook-entry.test.ts tests/mcp.test.ts
```

Expected: FAIL. Failures should show prompt output is still `''` and `cortex_consulted` is undefined.

- [ ] **Step 8: Commit red tests**

```powershell
git add tests/hook-entry.test.ts tests/mcp.test.ts
git commit -m "test: specify Cortex soft visibility"
```

---

### Task 2: Mark Cortex Tool Calls As Consulted

**Files:**
- Modify: `src/transports/mcp.ts`
- Test: `tests/mcp.test.ts`

- [ ] **Step 1: Add engagement marker constants and helper**

In `src/transports/mcp.ts`, after `let engagementPath: string | null = null;`, add:

```ts
const CORTEX_CONSULTED_KEY = 'cortex_consulted';

function markCortexConsulted(): void {
  writeEngagement(CORTEX_CONSULTED_KEY, 'true');
}
```

- [ ] **Step 2: Configure engagement path at the top of `handleToolCall()`**

At the start of `handleToolCall()`, before the `switch`, add:

```ts
  configureEngagementPath(cwd);
```

The function should begin:

```ts
export function handleToolCall(
  store: CortexStore,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): string {
  configureEngagementPath(cwd);

  switch (toolName) {
```

- [ ] **Step 3: Mark route/state/engage/recall/brief as consulted**

Update these cases in `handleToolCall()`:

```ts
    case 'cortex_route':
      markCortexConsulted();
      return renderCortexRoute();
```

For `cortex_state`, add `markCortexConsulted();` after `writeEngagement('state_called', 'true');`.

For `cortex_recall`, add `markCortexConsulted();` before `const topic = args['topic'] as string;`.

For `cortex_brief`, add `markCortexConsulted();` before `const topic = args['topic'] as string;`.

For `cortex_engage`, add `markCortexConsulted();` after `writeEngagement('state_called', 'true');`.

Do not mark `cortex_note`, `cortex_suggest_notes`, `cortex_validate_memory`, or `cortex_disengage` as consulted in v1.

- [ ] **Step 4: Run MCP tests**

Run:

```powershell
npm.cmd run test -- tests/mcp.test.ts
```

Expected: PASS for the new marker test. Hook-entry tests still fail until Task 3.

- [ ] **Step 5: Commit MCP marker implementation**

```powershell
git add src/transports/mcp.ts tests/mcp.test.ts
git commit -m "feat: mark Cortex tools as consulted"
```

---

### Task 3: Add Prompt Hook Visibility Hint

**Files:**
- Modify: `src/transports/hook-entry.ts`
- Test: `tests/hook-entry.test.ts`

- [ ] **Step 1: Extend hook-entry imports from MCP transport**

Change the existing import:

```ts
import { configureEngagementPath, readEngagement } from './mcp.js';
```

to:

```ts
import { configureEngagementPath, readEngagement, writeEngagement } from './mcp.js';
```

- [ ] **Step 2: Add visibility constants and JSON renderer**

After the imports in `src/transports/hook-entry.ts`, add:

```ts
const CORTEX_CONSULTED_KEY = 'cortex_consulted';
const VISIBILITY_HINT_SURFACED_KEY = 'visibility_hint_surfaced';
const VISIBILITY_HINT_CONTEXT =
  'Cortex is available: for resumed/familiar work, call cortex_recall(topic); for broad state, call cortex_state.';

function toPromptHookJson(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  });
}
```

- [ ] **Step 3: Add visibility decision helper**

Below `isEnabled()`, add:

```ts
function renderPromptVisibilityHint(cwd: string): string {
  configureEngagementPath(cwd);
  const engagement = readEngagement();
  if (engagement[CORTEX_CONSULTED_KEY] === 'true') {
    return '';
  }
  if (engagement['state_called'] === 'true') {
    return '';
  }
  if (engagement[VISIBILITY_HINT_SURFACED_KEY] === 'true') {
    return '';
  }

  writeEngagement(VISIBILITY_HINT_SURFACED_KEY, 'true');
  return toPromptHookJson(VISIBILITY_HINT_CONTEXT);
}
```

- [ ] **Step 4: Call the hint before prompt reflex**

In `reflectFromPayload()`, inside the `if (action === 'reflect-prompt')` branch, add:

```ts
    const hint = renderPromptVisibilityHint(cwd);
    if (hint) {
      return hint;
    }
```

The branch should become:

```ts
  if (action === 'reflect-prompt') {
    event = 'prompt';
    prompt = firstString(payload['prompt'], payload['message'], payload['user_prompt']);
    const hint = renderPromptVisibilityHint(cwd);
    if (hint) {
      return hint;
    }
  } else if (action === 'reflect-edit') {
```

This keeps `reflectMemory()` prompt behavior fact-silent after the one-shot route hint.

- [ ] **Step 5: Run hook-entry tests**

Run:

```powershell
npm.cmd run test -- tests/hook-entry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run targeted hook/MCP tests**

Run:

```powershell
npm.cmd run test -- tests/hook-entry.test.ts tests/reflex.test.ts tests/mcp.test.ts
```

Expected: PASS. `tests/reflex.test.ts` should continue proving `reflectMemory()` itself returns `''` for prompt events.

- [ ] **Step 7: Commit prompt visibility implementation**

```powershell
git add src/transports/hook-entry.ts tests/hook-entry.test.ts
git commit -m "feat: surface Cortex prompt visibility hint"
```

---

### Task 4: Document Soft Visibility Behavior

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Reference: `docs/superpowers/specs/2026-06-06-cortex-soft-visibility-design.md`

- [ ] **Step 1: Update README Core Behavior**

In `README.md`, under Core Behavior near the existing `UserPromptSubmit prompt hooks stay silent...` bullet, replace that bullet with:

```md
- UserPromptSubmit prompt hooks may emit a once-per-session route-level Cortex hint, but do not inject memory facts from prompt text; edit and command reflexes still require high-confidence prior context.
```

- [ ] **Step 2: Update CLAUDE Expected Behavior**

In `CLAUDE.md`, replace:

```md
- Prompt reflex should stay silent for UserPromptSubmit regardless of prompt text.
```

with:

```md
- Prompt hooks may emit a once-per-session route-level Cortex hint, but prompt reflex should not inject memory facts from UserPromptSubmit text.
```

- [ ] **Step 3: Run doc diff check**

Run:

```powershell
git diff -- README.md CLAUDE.md docs/superpowers/specs/2026-06-06-cortex-soft-visibility-design.md
```

Expected: README/CLAUDE describe soft visibility consistently with the approved design.

- [ ] **Step 4: Commit docs**

```powershell
git add README.md CLAUDE.md
git commit -m "docs: describe Cortex soft visibility"
```

---

### Task 5: Full Verification And Final Commit Hygiene

**Files:**
- Verify all changed files from Tasks 1-4.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
npm.cmd run test -- tests/hook-entry.test.ts tests/reflex.test.ts tests/mcp.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run full build**

Run:

```powershell
npm.cmd run build
```

Expected: `tsc` exits 0.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd run test
```

Expected: all Vitest files pass. CRLF warnings about fixture files are acceptable if no tracked fixture changes remain in `git status`.

- [ ] **Step 4: Run lint**

Run:

```powershell
npm.cmd run lint
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 5: Check whitespace and working tree**

Run:

```powershell
git diff --check
git status --short --branch
```

Expected: `git diff --check` exits 0. `git status` shows only intentional files, or a clean tree after commits.

- [ ] **Step 6: Push if requested by the user**

If the user asks to publish:

```powershell
git push origin main
```

Expected: `main -> main` push succeeds.

---

## Acceptance Criteria

- First eligible `reflect-prompt` hook emits route-level guidance mentioning `cortex_recall(topic)` and `cortex_state`.
- Prompt hook guidance does not include note content, retrieved memory text, or keyword-matched facts.
- Prompt hook guidance appears only once per engagement state unless the engagement file is reset by a new session.
- Explicit use of `cortex_route`, `cortex_state`, `cortex_engage`, `cortex_recall`, or `cortex_brief` suppresses later prompt route hints.
- `cortex_disengage` keeps prompt hooks silent.
- Existing edit/cmd/agent reflex behavior stays unchanged.
- Existing `reflectMemory()` prompt tests still prove prompt reflex itself is fact-silent.
