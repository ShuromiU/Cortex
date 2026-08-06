#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-subagent.sh — SubagentStart bridge (FR-17, Story 5.1).
# Spawns Node only when Cortex is engaged for this project, and only once per
# subagent dispatch — never per tool call, so N-4 is untouched.
#
# Emits nothing (N-1). SubagentStart cannot block a subagent, so the only harm
# this hook could do is noise; it prints nothing and always exits 0.

# No default. `install` and `doctor` share REQUIRED_WIRING so that what one
# writes is what the other checks, and this entry sets `action: 'subagent-start'`
# with no `actionOptionalUnless` — so an arg-less wiring is one `doctor` refuses.
# Defaulting the action here would make that refused form WORK, which is the one
# disagreement an installer/diagnostic pair must not have: `doctor` reporting a
# functioning install as unwired, and `install` then appending a second entry so
# every dispatch spawns Node twice.
ACTION="$1"
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && exit 0

grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0

case "$ACTION" in
  subagent-start)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" subagent-start
    ;;
  *)
    # An unrecognised action must not reach Node. `handleHookPayload` routes
    # anything it does not know to the reflex path, which resolves — and can
    # create — a PRIMARY session; a mis-wired argument would then rotate the
    # parent's session on every subagent dispatch. Story 5.3 appends its own
    # arm here rather than widening this one.
    exit 0
    ;;
esac

exit 0
