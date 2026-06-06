# Cortex Soft Visibility Design

## Goal

Make Cortex visible at the moments an agent decides whether to use memory, without forcing Cortex tool calls or injecting unsolicited memory facts.

## Problem

Cortex currently captures useful memory quietly, but Codex often ignores custom MCP tools unless a tool is already visible in the prompt or hook context. Tool descriptions and silent startup are not enough. The current design optimizes for low noise but under-signals when prior context may matter.

## Design

Use a soft visibility gate instead of a hard requirement.

- Keep capture ambient and quiet.
- Keep prompt reflex from injecting memory facts from user prompt text.
- Add route-level guidance through hooks when Cortex has not been consulted in the current session.
- Let the agent ignore the guidance when the work is new, trivial, or throwaway.

The guidance should mention tools, not memory content:

```text
Cortex is available: for resumed/familiar work, call cortex_recall(topic); for broad state, call cortex_state.
```

When a prompt or tool action looks like resumed or familiar work, the guidance may be stronger:

```text
Cortex hint: this looks like resumed work. Consider cortex_recall("<topic>") before planning.
```

## Trigger Rules

The first implementation should be conservative:

- Emit at most one route-level hint per session until a Cortex memory tool is called.
- Prefer `UserPromptSubmit` for visibility before the model starts acting.
- Do not emit retrieved memories from prompt text.
- Do not block tool use.
- Suppress hints after `cortex_state`, `cortex_recall`, `cortex_brief`, or `cortex_route` records that Cortex was consulted.
- Continue allowing `cortex_disengage` to silence capture and reflex.

## Interfaces

No new MCP tools are required.

Existing engagement state can be extended with lightweight flags:

- `enabled=true|false`
- `state_called=true|false`
- new or reused consulted marker for route/state/recall/brief usage
- new once-per-session visibility marker for whether a route hint has already surfaced

The exact file format may remain line-oriented key/value text as used today.

## Testing

Add tests that prove:

- `UserPromptSubmit` still does not emit memory facts from prompt keyword matches.
- A first eligible prompt can emit route-level guidance when Cortex has not been consulted.
- A second prompt in the same session does not repeat the same guidance.
- Calling `cortex_route`, `cortex_state`, `cortex_recall`, or `cortex_brief` suppresses later route-level guidance.
- `cortex_disengage` keeps hooks silent.

## Non-Goals

- Do not force every agent to call Cortex before work.
- Do not make `cortex_state` a startup ritual.
- Do not restore noisy prompt-memory injection.
- Do not add an LLM classifier for v1; deterministic heuristics are enough.
