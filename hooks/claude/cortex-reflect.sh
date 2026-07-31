#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-reflect.sh — UserPromptSubmit / PreToolUse reflex bridge.
# Spawns Node only when Cortex is engaged for this project.

ACTION="${1:-reflect-prompt}"
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && exit 0

grep -q '^enabled=true' "$CWD/.cortex.state" 2>/dev/null || exit 0

case "$ACTION" in
  reflect-pre)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" reflect-pre
    ;;
  *)
    printf '%s' "$INPUT" | "__CORTEX_NODE__" "__CORTEX_HOOK_ENTRY__" reflect-prompt
    ;;
esac

exit 0
