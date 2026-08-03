#!/bin/bash
# cortex-hook-template: __CORTEX_TEMPLATE_ID__
# cortex-capture.sh — PostToolUse hook: spool tool events for Cortex, and
# refund a provably redundant Read (FR-6, AD-7, Story 4.5).
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
TAB=$'\t'
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

# ── Verified read substitution (AD-7, AD-16, B-4a) ────────────────────
#
# Runs only for Read, only when the flag file exists. Process budget, pinned by
# test: ONE spawn on a miss (the index grep), and two more only on an index hit
# (`wc -c` proving the recorded size still describes the disk, then the
# verification hash). Every other step is a bash builtin — no jq, no cut, no
# stat. The index publishes only records the flush certified refund-eligible,
# so a digest that describes bytes the recorded read never returned is not
# findable here at all.
#
# It never opens SQLite and never spawns Node (AD-2, N-4). Every fact it cannot
# derive for itself was published into `.cortex.state` by `inject-header`.

JSON_ESC=""
# Escapes into a global rather than returning a value, because `$(...)` would
# fork — and a fork per read is the one thing this path is shaped to avoid.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  JSON_ESC="$s"
}

SUBST_TEXT=""
try_substitute() {
  local file="$1" full="$2" aid="$3"

  # AC #6: off until explicitly enabled. `[ -f ]` is a builtin, so every tool
  # call that can never substitute pays nothing for this feature.
  [ -f "$CWD/.cortex.substitution" ] || return 1
  [ -n "$file" ] || return 1
  # A SUBAGENT requester is never substituted, whatever the record shows. The
  # record can prove the PRIMARY read the file; nothing here can prove the
  # requester holds the primary's context, and a subagent starts with a fresh
  # one — so "already in this session's context" would be false for exactly the
  # reader acting on it (review-reproduced: parent reads in turn 1, subagent is
  # substituted in turn 2). AD-16 attribution is necessary but not sufficient;
  # the requester gate is the sufficient half.
  [ -z "$aid" ] || return 1

  # Facts the cold path published at SessionStart. A builtin loop over a
  # six-line file: no process, and no way to see a session id that did not come
  # from the session which wrote it (AD-16).
  local sid="" iscope="" sroot="" fold="" l
  while IFS= read -r l || [ -n "$l" ]; do
    l="${l%$'\r'}"
    case "$l" in
      session_id=*)  sid="${l#session_id=}" ;;
      index_scope=*) iscope="${l#index_scope=}" ;;
      scope_root=*)  sroot="${l#scope_root=}" ;;
      path_fold=*)   fold="${l#path_fold=}" ;;
    esac
  done < "$CWD/.cortex.state"
  [ -n "$sid" ] && [ -n "$iscope" ] && [ -n "$sroot" ] || return 1
  # `normalizeFilePathKey` strips a trailing slash from the root; this side
  # must too, or a repository at a filesystem root (`c:/`, `/`) builds the
  # pattern `c://*`, never matches, and silently never substitutes. When the
  # strip leaves nothing (root = `/`), the TS side keeps keys ABSOLUTE for
  # that scope — skipping the strip below reproduces exactly that.
  sroot="${sroot%/}"

  # The stored key, derived exactly as `toScopeRelativeKey` does it, in
  # builtins: separators, case fold, scope-root strip. A path outside the
  # scope root keeps its absolute form, which is also what the cold path
  # stores for it. Percent-escaping happens LATER, on the lookup copy only —
  # the escaped form is the index's encoding, not the file's name, and it
  # leaked into the agent-facing payload and the ledger's evidence ref
  # (review-measured: a `%` in the path named a file that does not exist).
  local key="${file//\\//}"
  [ "$fold" = "lower" ] && key="${key,,}"
  if [ -n "$sroot" ]; then
    case "$key" in
      "$sroot"/*) key="${key#"$sroot"/}" ;;
    esac
  fi
  # A control character in the key can forge an index column, and past the
  # lookup it reaches a JSON string, where raw control bytes are illegal — the
  # host would receive unparseable output on the one channel it parses. jq's
  # `safe` filter already blanked these upstream; this is the belt half, and
  # the redundancy is deliberate (the `toScopeRelativeKey` double-guard
  # precedent), so a mutation of either alone is expected to survive.
  case "$key" in
    *[[:cntrl:]]*) return 1 ;;
  esac

  # AC #4: a second read of the same file within one turn passes through, which
  # is what makes substitution safe — it is the agent's way back to the real
  # bytes. Append FIRST, then require exactly one occurrence: check-then-append
  # let N concurrent hooks each see a clean marker and all substitute (review-
  # measured, 8 trials: 1-3 substitutions of one file in one turn), leaving the
  # agent N stubs and zero copies. Whoever's append lands first can count 1;
  # every later scanner counts at least 2 — so at most ONE substitution
  # survives any interleaving, and the race degrades to a miss. A failed
  # append also misses: if the read cannot be recorded, the escape hatch
  # cannot be guaranteed, and the marker is the only thing standing between
  # the agent and an unrecoverable stub (review-reproduced with the marker as
  # a directory: three substitutions, three credits, no way back).
  # `2>/dev/null` BEFORE `>>`: redirections apply left to right, so reversed,
  # a failing append (marker is a directory, disk full) complains on the
  # hook's stderr before the suppression exists — the same order bug as the
  # spool SIZE line below.
  local marker="$CWD/.cortex.turn-reads" count=0
  printf '%s\n' "$key" 2>/dev/null >> "$marker" || return 1
  while IFS= read -r l || [ -n "$l" ]; do
    l="${l%$'\r'}"
    [ "$l" = "$key" ] && count=$((count + 1))
  done 2>/dev/null < "$marker"
  [ "$count" = "1" ] || return 1

  # AC #2 / AD-6: a partial read holds part of the file while the digest
  # describes all of it. `Read` also truncates at 2000 lines with no `offset`
  # in `tool_input`, so the payload's own line counts are the only honest test.
  #
  # Checked AFTER the marker, not before. AC #4 says "the same file is read a
  # second time within one turn", not "substituted a second time" — so a
  # partial read must still record that the file was touched, or the full read
  # that follows it is treated as the turn's first and substitutes. Both steps
  # are builtins, so the ordering costs nothing.
  [ "$full" = "1" ] || return 1

  # One `grep -F -m1` (AD-3). Scale-independent at 50-59 ms from 1k to 50k
  # records because it is spawn-dominated; the pure-builtin alternative is
  # faster on a small index and 10x worse on a large one. NOT anchored — `-F`
  # cannot express `^` — so a scope key that is a proper suffix of another
  # scope key in the same index can win the `-m1` race; the session gate below
  # then misses, never mis-attributes. The redirect matters: a project that has
  # never flushed has no index, and an unredirected grep would write to the
  # hook's stderr on every single read. The lookup uses a percent-ESCAPED copy
  # of the key, because that is the index's field encoding; everything after
  # the lookup uses the real key.
  local needle="${iscope}${TAB}${key//%/%25}${TAB}"
  local hit
  hit=$(grep -F -m1 "$needle" "$CWD/.cortex.index" 2>/dev/null) || return 1
  # A CRLF-normalized index leaves a CR on the last field, where it reads as
  # `agent_id "-\r"` — which stops meaning absent, silently and permanently.
  # `parseIndexLine` strips exactly this on the Node side.
  hit="${hit%$'\r'}"
  [ -n "$hit" ] || return 1

  local c_scope c_path c_sha c_size c_sess c_agent
  IFS="$TAB" read -r c_scope c_path c_sha c_size c_sess c_agent <<< "$hit"

  # AC #2: an oversize record carries no digest and can never be verified.
  [ "$c_sha" != "-" ] || return 1
  # AD-16, in the narrowest provable form. The recorder must be THIS scope's
  # current primary, reading as itself: `self` for a primary requester,
  # `ancestor` for a subagent one. A sibling subagent's read carries a
  # different session id and misses; a subagent's own earlier read is recorded
  # under its child session, which does not yet exist while this hook runs, so
  # it misses too. Under-refunding is acceptable (SM-C3); telling an agent it
  # holds content it has never seen is not.
  [ "$c_sess" = "$sid" ] || return 1
  [ "$c_agent" = "-" ] || return 1
  case "$c_size" in
    ''|*[!0-9]*) return 1 ;;
  esac

  local minb="${CORTEX_SUBST_MIN_BYTES:-2048}"
  local maxb="${CORTEX_SUBST_MAX_BYTES:-1048576}"
  case "$minb" in
    ''|*[!0-9]*) minb=2048 ;;
  esac
  case "$maxb" in
    ''|*[!0-9]*) maxb=1048576 ;;
  esac
  # `2>/dev/null` on the numeric tests: a syntactically valid size bash cannot
  # compare (20 digits) otherwise prints an "integer expression expected" on
  # the hook's stderr for every affected read; `|| return 1` already makes the
  # verdict a safe miss.
  [ "$c_size" -ge "$minb" ] 2>/dev/null || return 1
  [ "$c_size" -le "$maxb" ] 2>/dev/null || return 1

  # The recorded size must describe the file ON DISK before anything is
  # hashed. The gates above run on the RECORDED size, and the hash runs on
  # whatever is there now — so a stale or corrupt record could pull a 300 MB
  # file through a 6 KB record and spend ~1.3 s hashing it on a path that can
  # only miss (review-measured), the exact cost-scales-with-bytes defect the
  # FR-7 brief already paid for. `wc -c` is one spawn (~55 ms) that runs only
  # on an index hit, and a size mismatch also proves the bytes cannot match
  # the digest, so nothing true is ever skipped. This also stops a corrupt
  # `byte_size` from inflating the quoted token figure and the booked credit:
  # past this line the recorded size is the verified on-disk size.
  #
  # The path is forward-slashed first, and that is not cosmetic for the hash
  # below. GNU coreutils escapes a filename containing a backslash by
  # prefixing the WHOLE OUTPUT LINE with `\` — measured:
  #   sha256sum "C:\...\package.json"  ->  \b039a62... *C:\\...\\package.json
  # so the digest field comes back as `\b039a62...` and can never equal a
  # stored hex digest. Every Windows path contains backslashes, so
  # substitution would have silently never fired on the reference platform.
  local diskfile="${file//\\//}"
  local disk_size
  disk_size=$(wc -c 2>/dev/null < "$diskfile") || return 1
  disk_size="${disk_size//[![:digit:]]/}"
  [ -n "$disk_size" ] || return 1
  [ "$disk_size" = "$c_size" ] || return 1

  # AC #1, the verification. The file on disk, NOT the returned text: Claude
  # Code normalises CRLF to LF in the payload, so hashing what it returned can
  # never match a digest taken over the file's bytes. Measured — this repo's
  # own CRLF files would silently never have substituted.
  local actual
  actual=$(sha256sum "$diskfile" 2>/dev/null) || return 1
  actual="${actual%% *}"
  # Shape-checked rather than trusted: coreutils' escaping fires for a
  # filename containing a newline too, and a malformed digest must miss
  # rather than compare.
  [[ $actual =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$actual" = "$c_sha" ] || return 1

  # The refund must be worth taking BEFORE the tool result is destroyed. The
  # payload itself costs ~50 tokens, so a substitution whose credit is not
  # positive replaces real content at a net loss — reviewed as reachable with
  # a lowered CORTEX_SUBST_MIN_BYTES. Computed before the printf, because
  # after it there is no way back.
  local tokens=$(( (c_size + 3) / 4 ))
  json_escape "$key"
  local jkey="$JSON_ESC"
  SUBST_TEXT="[cortex] substituted: ${jkey} is byte-identical to the copy already in this session's context (verified by sha256 just now). Full content ~${tokens} tokens. Read it again to get the real text."
  local ptok=$(( (${#SUBST_TEXT} + 3) / 4 ))
  local credit=$(( tokens - ptok ))
  [ "$credit" -gt 0 ] || return 1

  # The envelope MIRRORS the tool's own result object. The documented
  # {content:[{type,text}]} form is accepted and silently ignored — measured
  # with two probes against the installed hook. `filePath` carries the path
  # the tool was ASKED for, not the index key: the host maintains read-state
  # per path from this field, and handing it a name it never requested is
  # unspecified behaviour on the edit-guard path.
  json_escape "$file"
  local jfile="$JSON_ESC"
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"type":"text","file":{"filePath":"%s","content":"%s","numLines":1,"startLine":1,"totalLines":1}}}}\n' "$jfile" "$SUBST_TEXT"

  # AD-15: the hot path may not book its own credit, so the credit travels as a
  # spool record carrying its own evidence and is booked by the cold-path flush
  # under the same exactly-once claim as every other line. A lost record is no
  # credit, never a reconstructed one. `credit_ref` is the REAL scope-relative
  # key — the same string `content_digests.path` holds — never the escaped
  # lookup form, or the evidence names a file that does not exist. No agent
  # fields: the requester gate above means only a primary ever reaches here.
  printf '{"v":1,"ts":"%s","tool":"credit","credit_kind":"read","credit_ref":"%s","credit_size":"%s","credit_tokens":"%s"}\n' \
    "$TS" "$jkey" "$c_size" "$credit" >> "$SPOOL"
  return 0
}

case "$TOOL_NAME" in
  Read)
    # One jq for this branch. It emits six newline-free fields, one per line:
    # the spool line, the same line marked substituted, the file path, whether
    # the read was complete, and the agent identity. `@tsv` is deliberately NOT
    # used — it escapes backslashes, which would double every separator in a
    # Windows path and inside the JSON the line already carries. `safe` blanks
    # a field carrying ANY control character (not just the delimiters): past
    # the lookup the path reaches a JSON string, where raw control bytes are
    # illegal, and a blanked path is a miss (AD-6) while the spool line keeps
    # the real path via jq's own JSON encoding. `.tool_response.file?` — the
    # `?` matters: a scalar tool_response otherwise aborts the whole program
    # and LOSES the read from capture entirely (review-reproduced with six
    # payload shapes; the pre-4.5 branch never indexed tool_response at all).
    READ_OUT=$(echo "$INPUT" | jq -r --arg ts "$TS" '
      def safe: if (explode | any(. < 32 or . == 127)) then "" else . end;
      (.tool_input.file_path // .tool_input.path // "") as $f
      | ({v:1, ts:$ts, tool:"read", file:$f}'"$AGENT_FIELDS"') as $base
      | (.tool_response.file? // {}) as $rf
      | (if ($rf|type) == "object" and ($rf.startLine? == 1) and (($rf.numLines? // 0) > 0)
            and ($rf.numLines == $rf.totalLines)
         then "1" else "0" end) as $full
      | [ (if $f == "" then "" else ($base|tostring) end),
          (if $f == "" then "" else (($base + {subst:1})|tostring) end),
          ($f|safe),
          $full,
          ((((.agent_id // .agentId) // "")|tostring)|safe),
          ((((.agent_type // .agentType) // "")|tostring)|safe) ]
        | .[]')
    {
      IFS= read -r LINE
      IFS= read -r LINE_SUBST
      IFS= read -r READ_FILE
      IFS= read -r READ_FULL
      IFS= read -r READ_AID
      IFS= read -r READ_ATYPE
    } <<< "$READ_OUT"
    # `jq` emits CRLF on this platform (jq 1.8.1 under Git Bash, measured), and
    # command substitution strips only the FINAL trailing CR — so every line but
    # the last arrives with one attached. Single-value `jq` reads elsewhere in
    # this script are safe by that accident; multi-line output is not. Left
    # unstripped, the path carried a CR into the key and the substitution missed
    # on every read, silently and always.
    LINE="${LINE%$'\r'}"
    LINE_SUBST="${LINE_SUBST%$'\r'}"
    READ_FILE="${READ_FILE%$'\r'}"
    READ_FULL="${READ_FULL%$'\r'}"
    READ_AID="${READ_AID%$'\r'}"
    READ_ATYPE="${READ_ATYPE%$'\r'}"
    if try_substitute "$READ_FILE" "$READ_FULL" "$READ_AID"; then
      LINE="$LINE_SUBST"
    fi
    ;;
  Edit|Write)
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
# `2>/dev/null` BEFORE the input redirect: redirections apply left to right,
# so with the order reversed a missing spool file complains on stderr from the
# failed open before the suppression is in place.
SIZE=$(wc -c 2>/dev/null < "$SPOOL" | tr -d '[:space:]')
if [ "${SIZE:-0}" -ge 262144 ]; then
  (cd "$CWD" && "__CORTEX_NODE__" "__CORTEX_CLI__" flush-spool >/dev/null 2>&1 &)
fi

exit 0
