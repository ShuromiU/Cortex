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
#
# The first two arms cannot break a turn: SubagentStart cannot block a subagent
# (the host renders a non-zero exit as a notice and proceeds) and PreToolUse here
# returns no permission decision at all, so the worst either does is noise.
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
