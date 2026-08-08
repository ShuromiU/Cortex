#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-subagent.sh — the subagent bridge (FR-17 Story 5.1, FR-18 Story 5.2,
# FR-19 Story 5.3). Spawns Node only when Cortex is engaged for this project,
# and — on the three subagent-lifecycle arms — only once per subagent DISPATCH.
#
# Four arms, four wirings across three events:
#   dispatch-pre     PreToolUse on the Agent tool. Records the dispatch, because
#                    SubagentStart carries no description. Prints nothing.
#   subagent-start   SubagentStart. Creates the subagent's session and may emit
#                    an additionalContext envelope carrying its brief. Silence is
#                    the default (N-1); Node prints nothing when there is nothing
#                    to say, so no arm here needs to suppress a blank line.
#   subagent-stop    SubagentStop. Records what the subagent concluded. Prints
#                    nothing, ever.
#   guard-memory     PreToolUse on the two memory-writing MCP tools and on every
#                    shell tool. Refuses a SUBAGENT retiring memory from earlier
#                    work on this branch (FR-19). Silent unless it denies.
#
# Three of the four cannot break a turn: SubagentStart cannot block a subagent
# (the host renders a non-zero exit as a notice and proceeds), and dispatch-pre
# returns no permission decision at all, so the worst either does is noise.
#
# `guard-memory` CAN deny, on purpose, and everything about it is built to fail
# open: Node emits nothing unless it can positively establish the target is
# outside this branch's current work, and this script exits 0 regardless.
#
# `subagent-stop` IS THE REASON THIS SCRIPT'S FINAL `exit 0` MATTERS. The host
# dispatches a blocking error for Stop and SubagentStop, so a non-zero exit here
# can stop a subagent finishing. The Node action swallows its own failures, and
# this script exits 0 unconditionally regardless of what Node did. Verified by
# probe: deleting that line turns a Node failure into exit 127.

# No default. `install` and `doctor` share REQUIRED_WIRING so that what one
# writes is what the other checks, and every entry sets an explicit `action`
# with no `actionOptionalUnless` — so an arg-less wiring is one `doctor` refuses.
# Defaulting the action here would make that refused form WORK, which is the one
# disagreement an installer/diagnostic pair must not have: `doctor` reporting a
# functioning install as unwired, and `install` then appending a second entry so
# every dispatch spawns Node twice. It is also what keeps the arms apart — each
# REQUIRED_WIRING entry is discriminated by its action token, and a default
# would let any wiring satisfy any other.
ACTION="$1"
INPUT=$(cat)

# THE PARENT PATH EXITS HERE, HAVING SPAWNED NOTHING AT ALL.
#
# `guard-memory` runs before EVERY command the agent executes, and ~100% of
# those are the parent's — the case this arm exits by design. Measured on this
# machine: the original four-jq version cost 318 ms per parent command against a
# bash+`cat` floor of ~105 ms, and a single jq is worth ~120 ms of that. So the
# cheapest possible screen is a pure-bash pattern match against the raw payload,
# which spawns no process whatsoever. A subagent's tool call carries `agent_id`;
# the parent's does not (measured). A payload with the key present but null
# falls through to the jq below and exits there — slower, still correct.
#
# Scoped to this action, because the other three arms fire once per dispatch and
# a false negative there costs a whole feature rather than a few milliseconds.
if [ "$ACTION" = "guard-memory" ]; then
  case "$INPUT" in
    *'"agent_id"'*|*'"agentId"'*) ;;
    *) exit 0 ;;
  esac
fi

# ONE jq for everything below, and that is measured rather than tidiness. The
# first version read four fields with four separate jq processes. Process spawns
# dominate on this platform, so the fix is to spawn once. @tsv escapes tabs and
# newlines inside values, which keeps every field on one line and is exactly
# what the substring screen further down needs.
IFS=$'\t' read -r CWD GUARD_AGENT_ID GUARD_TOOL GUARD_CMD <<EOF
$(printf '%s' "$INPUT" | jq -r '[.cwd // "", .agent_id // .agentId // "", .tool_name // .toolName // "", .tool_input.command // ""] | @tsv')
EOF

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
    # N-4 / AD-2 IS THE WHOLE DESIGN OF THIS ARM. It fires on every command the
    # agent runs, and spawning Node per tool call is the one thing the capture
    # architecture forbids outright. Two pure shell gates stand in front of
    # Node, cheapest first, both fed by the single jq above.
    #
    # 1. No agent_id means the PARENT, and the parent is exempt: it is the
    #    acceptance path a subagent's findings are supposed to travel through.
    #    Measured: a subagent's tool call carries agent_id; the parent's does
    #    not. This alone exits for every command the primary agent runs.
    [ -z "$GUARD_AGENT_ID" ] && exit 0

    # 2. Route on the tool name with an ALLOW-LIST, never an exact compare
    #    against one name. The first version tested `= "Bash"` and fell through
    #    to Node for everything else — so a catch-all matcher, which `doctor`
    #    blesses as "broader than canonical and therefore fine", spawned Node on
    #    every subagent tool call and removed the only gate standing between
    #    this arm and N-4. A tool this guard does not act on must exit here.
    #
    #    The shell list must match SHELL_TOOL_NAMES in src/query/memory-guard.ts
    #    and the subcommand list must match SHELL_MEMORY_COMMANDS; tests assert
    #    both, because the cheap check and the real one drifting apart means the
    #    guard silently stops being asked about a route.
    case "$GUARD_TOOL" in
      mcp__cortex__cortex_note|mcp__cortex__cortex_resolve)
        # Always a memory write, and rare. Straight through, no text screen.
        ;;
      Bash|PowerShell|shell_command)
        case "$GUARD_CMD" in
          *note-resolve*|*edit-memory*|*delete-memory*) ;;
          *) exit 0 ;;
        esac
        ;;
      *)
        exit 0
        ;;
    esac

    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" guard-memory
    ;;
  *)
    # An unrecognised action must not reach Node. `handleHookPayload` routes
    # anything it does not know to the reflex path, which resolves — and can
    # create — a PRIMARY session; a mis-wired argument would then rotate the
    # parent's session on every subagent dispatch.
    exit 0
    ;;
esac

exit 0
