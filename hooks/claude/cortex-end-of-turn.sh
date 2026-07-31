#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-end-of-turn.sh — Stop hook: flush the capture spool and, only when a
# subagent ran this turn AND high-confidence note suggestions exist, emit a
# decision:block nudge with the concrete suggestions embedded.

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && exit 0

grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0

AGENT_USED=false
if [ -f "$CWD/.cortex.agent-used" ]; then
  AGENT_USED=true
  rm -f "$CWD/.cortex.agent-used"
fi

printf '%s' "$INPUT" \
  | jq -c --argjson au "$AGENT_USED" '. + {agent_used: $au}' \
  | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" end-of-turn

exit 0
