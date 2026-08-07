#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-subagent.sh — the subagent bridge (FR-17 Story 5.1, FR-18 Story 5.2).
# Spawns Node only when Cortex is engaged for this project, and only once per
# subagent DISPATCH — never per tool call, so N-4 is untouched.
#
# Two arms, two events:
#   dispatch-pre     PreToolUse on the Agent tool. Records the dispatch, because
#                    SubagentStart carries no description. Prints nothing.
#   subagent-start   SubagentStart. Creates the subagent's session and may emit
#                    an additionalContext envelope carrying its brief. Silence is
#                    the default (N-1); Node prints nothing when there is nothing
#                    to say, so no arm here needs to suppress a blank line.
#   subagent-stop    SubagentStop. Records what the subagent concluded. Prints
#                    nothing, ever.
#   guard-memory     PreToolUse on the two memory-writing MCP tools and Bash.
#                    Refuses a SUBAGENT retiring memory from an earlier session
#                    (FR-19, Story 5.3). Silent unless it denies.
#
# The first two arms cannot break a turn: SubagentStart cannot block a subagent
# (the host renders a non-zero exit as a notice and proceeds) and PreToolUse
# there returns no permission decision at all, so the worst either does is
# noise. The guard arm CAN deny, on purpose, and everything about it is built to
# fail open: Node emits nothing unless it can positively establish the target is
# outside the tree, and this script exits 0 regardless.
#
# THE THIRD IS DIFFERENT AND IS THE REASON THIS SCRIPT'S FINAL `exit 0` MATTERS.
# The host dispatches a blocking error for Stop and SubagentStop, so a non-zero
# exit here can stop a subagent finishing. The Node action swallows its own
# failures, and this script exits 0 unconditionally regardless of what Node did.

# No default. `install` and `doctor` share REQUIRED_WIRING so that what one
# writes is what the other checks, and both entries set an explicit `action`
# with no `actionOptionalUnless` — so an arg-less wiring is one `doctor` refuses.
# Defaulting the action here would make that refused form WORK, which is the one
# disagreement an installer/diagnostic pair must not have: `doctor` reporting a
# functioning install as unwired, and `install` then appending a second entry so
# every dispatch spawns Node twice. It is also what keeps the two arms apart —
# each REQUIRED_WIRING entry is discriminated by its action token, and a default
# would let either wiring satisfy the other.
ACTION="$1"
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && exit 0

grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0

case "$ACTION" in
  dispatch-pre)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" dispatch-pre
    ;;
  subagent-start)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" subagent-start
    ;;
  subagent-stop)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" subagent-stop
    ;;
  guard-memory)
    # N-4 / AD-2 IS THE WHOLE DESIGN OF THIS ARM. Its matcher includes `Bash`,
    # so it fires on every command the agent runs — and spawning Node per tool
    # call is the one thing the capture architecture forbids outright. Two pure
    # shell checks stand in front of Node, ordered cheapest first.
    #
    # 1. No agent_id means the PARENT, and the parent is exempt: it is the
    #    acceptance path a subagent's findings are supposed to travel through.
    #    Measured: a subagent's tool call carries agent_id; the parent's does
    #    not. This alone exits for every command the primary agent runs.
    GUARD_AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // .agentId // empty')
    [ -z "$GUARD_AGENT_ID" ] && exit 0

    # 2. For Bash, the command text must mention a memory-mutating subcommand.
    #    Kept as a literal `case` here and as SHELL_MEMORY_COMMANDS in
    #    src/query/memory-guard.ts, with a test asserting the two agree — the
    #    cheap check and the real one must not drift, or the guard silently
    #    stops covering a route. The MCP tools skip this and go straight to
    #    Node: they are already rare and always memory writes.
    GUARD_TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .toolName // empty')
    if [ "$GUARD_TOOL" = "Bash" ]; then
      GUARD_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
      case "$GUARD_CMD" in
        *note-resolve*|*edit-memory*|*delete-memory*) ;;
        *) exit 0 ;;
      esac
    fi

    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" guard-memory
    ;;
  *)
    # An unrecognised action must not reach Node. `handleHookPayload` routes
    # anything it does not know to the reflex path, which resolves — and can
    # create — a PRIMARY session; a mis-wired argument would then rotate the
    # parent's session on every subagent dispatch. Story 5.3 appends its own
    # arm here rather than widening either of these.
    exit 0
    ;;
esac

exit 0
