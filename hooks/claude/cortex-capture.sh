#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-capture.sh — PostToolUse hook: spool tool events for Cortex.
# Appends one JSON line per event; no Node process is spawned per tool call.
# A detached flush runs only when the spool crosses the size threshold.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && exit 0

# Only capture when Cortex is engaged for this project.
grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0

SPOOL="$CWD/.cortex.spool.jsonl"
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
LINE=""

# Subagent identity, merged into whichever line shape the branch builds. Both
# operands of jq's `+` see the same input, so `.agent_id` here is the hook
# payload's field, not the object being built. Omitted when absent, so a
# primary-session line stays byte-identical to the pre-agent-identity format.
# Defined once and concatenated into each program: one jq call per event, no
# extra process on the hot path (N-4, B-4).
# Both spellings are accepted so host field-name drift degrades to primary
# attribution rather than silently voiding the feature — this script is the only
# live capture path, so the tolerance has to live here, not just in Node.
AGENT_FIELDS='
  + (if ((.agent_id // .agentId) // "") != "" then {agent_id: (.agent_id // .agentId)} else {} end)
  + (if ((.agent_type // .agentType) // "") != "" then {agent_type: (.agent_type // .agentType)} else {} end)'

case "$TOOL_NAME" in
  Read|Edit|Write)
    TOOL=$(printf '%s' "$TOOL_NAME" | tr '[:upper:]' '[:lower:]')
    LINE=$(echo "$INPUT" | jq -c --arg ts "$TS" --arg tool "$TOOL" '
      {v:1, ts:$ts, tool:$tool, file:(.tool_input.file_path // .tool_input.path // "")}'"$AGENT_FIELDS"'
      | select(.file != "")')
    ;;
  Bash)
    LINE=$(echo "$INPUT" | jq -c --arg ts "$TS" '
      {v:1, ts:$ts, tool:"cmd", cmd:(.tool_input.command // "")}
      + (if (.exit_code // .tool_response.exit_code // .tool_result.exit_code) != null
         then {exit: ((.exit_code // .tool_response.exit_code // .tool_result.exit_code) | tostring)} else {} end)
      + (if (.stdout // .tool_response.stdout // .tool_result.stdout // "") != ""
         then {stdout: (.stdout // .tool_response.stdout // .tool_result.stdout)} else {} end)
      + (if (.stderr // .tool_response.stderr // .tool_result.stderr // "") != ""
         then {stderr: (.stderr // .tool_response.stderr // .tool_result.stderr)} else {} end)'"$AGENT_FIELDS"'
      | select(.cmd != "")')
    ;;
  Agent)
    LINE=$(echo "$INPUT" | jq -c --arg ts "$TS" '
      {v:1, ts:$ts, tool:"agent", desc:(.tool_input.description // "")}'"$AGENT_FIELDS"'
      | select(.desc != "")')
    # Marker consumed by cortex-end-of-turn.sh for the conditional note nudge.
    : > "$CWD/.cortex.agent-used"
    ;;
  *)
    exit 0
    ;;
esac

[ -n "$LINE" ] && printf '%s\n' "$LINE" >> "$SPOOL"

# Threshold flush (256 KiB): detached so the hook returns immediately.
SIZE=$(wc -c < "$SPOOL" 2>/dev/null | tr -d '[:space:]')
if [ "${SIZE:-0}" -ge 262144 ]; then
  (cd "$CWD" && "__CORTEX_NODE__" "__CORTEX_CLI__" flush-spool >/dev/null 2>&1 &)
fi

exit 0
