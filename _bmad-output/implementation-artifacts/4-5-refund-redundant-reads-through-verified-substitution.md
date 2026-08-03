---
baseline_commit: 135d21eb22575cd7c278461f79e5055e6b39325a
---

# Story 4.5: Refund redundant reads through verified substitution

**Epic:** 4 — Content Cache
**FR:** FR-6 (the substitution half; the query half shipped as Story 3.3)
**Status:** done

As an agent that just re-read a file it already knows,
I want the result replaced by a short equivalent,
So that the redundant read costs twenty tokens instead of four thousand.

## Acceptance Criteria (verbatim from epics.md:886-912)

**Given** substitution is enabled and a Read completes
**When** the PostToolUse hook hashes the returned content and it matches the recorded digest for that path and session lineage
**Then** the hook returns `hookSpecificOutput.updatedToolOutput` with a short equivalent payload.

**Given** the hashed content does not match the recorded digest, or the file is oversize, or the digest belongs to a session that is not the requester or its ancestor
**When** the hook evaluates substitution
**Then** the original output passes through unchanged (AD-6, AD-16).

**Given** substitution occurs
**When** the payload renders
**Then** it names itself as a substitution, names the file, and states the token cost of the full content.

**Given** the same file is read a second time within one turn
**When** the hook evaluates substitution
**Then** the original output passes through unsubstituted.

**Given** the hook runs the substitution path
**When** it completes
**Then** it spawns no Node process (N-4), reads only the flat digest index (AD-3), and stays within B-4a as re-based 2026-08-03: the structural clause is primary — exactly one added spawn on a miss, two more on a verified hit, the hash strictly after the size and eligibility gates — with end-to-end ≤600 ms on a miss, ≤800 ms on a verified hit, at p95 through the installed hook on the quiescent reference platform.
*(AC #5 quoted as re-amended by the 2026-08-03 ruling — see F5. The story was created and reviewed against the 2026-08-02 text: ≤100 ms miss / ≤300 ms hit end-to-end.)*

**Given** substitution has never been explicitly enabled
**When** a Read completes
**Then** no substitution occurs.

**Given** `PreToolUse` fires for a Read
**When** the hook evaluates it
**Then** it never returns `permissionDecision: "deny"` for economic reasons (AD-7).

## AC assessment — read these before implementing the AC text

Epic 3's standing rule applies (`cortex_recall`: *epic-3 stale acceptance criteria*): where an AC is
falsified by measurement, **flag it here and build on the corrected reading — never implement the
stale text.** Four flags and one clarification, all backed by measurements taken during story
creation or implementation, recorded in "What is actually here".

### F1 — AC #1's "hashes the returned content" is not implementable as written, and the failure is silent

Measured on this machine from a real transcript (`~/.claude/projects/C--Claude-Code-cortex/*.jsonl`,
five full-read samples): for **LF** files `sha256(payload content, UTF-8)` equals the file's own
sha256 exactly (4/4 — `sprint-status.yaml` 14327 B, `3-6-report-the-pl.md` 28230 B,
`project-context.md` 13905 B, `template.md` 948 B). For a **CRLF** file it does **not**:
`hooks/claude/cortex-capture.sh` is 3264 bytes on disk with CRLF, and the payload delivers 3194
bytes with CRLF normalised to LF — a different digest. Re-inserting CRLF reproduces the disk hash,
confirming line-ending normalisation as the sole cause.

`content_digests.sha256` is `sha256(raw Buffer)` (`src/capture/digest.ts:132-145`, never decoded, so
binary files reproduce). So a literal "hash the returned content" implementation **never substitutes
any CRLF file** — and this repository's own checkout has CRLF files, on the reference platform, with
no `.gitattributes`. It would not error; it would quietly return zero refunds for an arbitrary and
invisible subset of files.

**Corrected reading, and it is stronger not weaker:** the hook hashes **the file on disk at
PostToolUse time** (`sha256sum "$FILE"`) and compares to the recorded digest. That is
apples-to-apples — the recorded digest is itself a disk hash — and it is the same evidence
`queryReadLedger` re-derives for `unchanged-since` (`src/query/read-ledger.ts`). AD-7's requirement
is *verification rather than a guess* ("the claim is made while holding the bytes it describes"), and
a hash taken microseconds after the read, of the file the read named, satisfies it. What AD-7
forbids — mtime, a proxy, a guess — is not what this does.

The one window the disk hash opens and the content hash would not: a file changed by a third party
*between* the Read returning and the hook firing. Then disk ≠ recorded → **miss**. The only unsafe
shape would be the file reverting to the recorded bytes in that window, which is contrived, and even
then the substituted payload describes bytes that are on disk right now. Story 3.1 already documents
the larger version of the same imprecision (digests describe flush time, not read time) and this
inherits its bound.

### F2 — "and session lineage": what is provable in bash is narrower than AD-16 permits

AD-16 allows a refund when the recorder is the requester **or a direct ancestor**. The hot path
cannot resolve ancestry: the index's session column holds Cortex's own session UUID, a subagent's
Cortex child session is created lazily *at flush time* and so does not exist while the hook runs, and
AD-2 forbids opening SQLite to ask.

**Implemented rule (deliberately a subset, narrowed further by the review round):** eligible ⟺ the
index record's `session_id` equals the current primary session id published in `.cortex.state`,
**and** its `agent_id` column is the absent sentinel `-`, **and the requesting payload carries no
`agent_id`**. The first two prove the primary read it; the third proves the primary is asking. The
review reproduced why the third is not optional: without it, AD-16's letter ("or a direct
ancestor") served the *primary's* record to a *subagent* — legal by attribution and false in fact,
because a subagent starts with a fresh context and has never held those bytes, while the payload
told it the content was "already in this session's context". AD-16 attribution is necessary;
requester-is-primary is sufficient. So refunds are primary-only in both directions, and everything
else misses — including a subagent's own earlier read of the same file.

Under-refunding is explicitly acceptable (SM-C3, AD-15: "under-reporting is acceptable… inventing the
row later is not"); over-refunding is the failure AD-16 exists to prevent. The measured mix on this
store is ~18:1 primary:subagent sessions (Story 3.3's finding), so the subset captures the
overwhelming majority. **The future fix, recorded here rather than left to be rediscovered:** have
`collectIndexRecords` emit the *tree-root primary* session id in column 5 instead of the recording
session's id (a join, no schema change, no `content_digests` byte-budget impact), after which
`rec_agent == payload.agent_id` becomes provable and a subagent's own reads become refundable. Out of
scope here because it changes an index column's documented meaning and every Story 3.2 consumer of
`parseIndexLine(...).sessionId` — enumerate those with `find_referencing_symbols` before attempting
it.

### F3 — AC #5's "reads only the flat digest index" is about the digest lookup, not about all I/O

The hook also stats `.cortex.substitution`, greps `.cortex.state` (it already does, for
`enabled=true`), and — on the hit path only — greps `.cortex.turn-reads`. None of these is a digest
lookup and none is SQLite. AD-3's rule is that *the digest record* is found with `grep` alone against
the flat index, and AD-2's rule is that the hot path never opens the store. Both hold. Flagged so a
reviewer reading AC #5 literally does not score correct work as a violation, and so that nobody
"fixes" it by moving the state bridge into the index.

Likewise "spawns no Node process": the **substitution path** spawns none. `cortex-capture.sh`'s
pre-existing 256 KiB threshold branch still backgrounds `flush-spool`, unchanged, detached, and off
the substitution path. Do not remove it and do not count it against AC #5.

### F4 — clarification, not a defect: AC #4 is the escape hatch, not a nicety

Substitution *replaces* the tool result, so the agent cannot see the file it asked for. AC #4 is what
makes that safe: reading the same file again in the same turn returns the real content. The
substituted payload must therefore **say so** (AC #3 requires it to name itself; this story requires
it to name the recovery too). Treat AC #4 as load-bearing safety, not as an optimisation, and test it
as such.

### F5 — B-4a as written is NOT met, is structurally unreachable here, and needs a PRD ruling

**This flag was corrected by the review round; its first version was the review's top finding.** The
original F5 argued "B-4a bounds what substitution adds; B-4 bounds the whole hook" and reported the
marginal against 100/300 ms. The Acceptance Auditor caught the mis-scoping: **PRD §10 defines B-4 as
the *non-substituting* path (`Edit`, `Write`, `Bash`, `Agent`) — it never covered `Read`** — so the
split deleted the only budget governing this path and graded the story against one that does not
exist. That was self-grading, and it is withdrawn.

The honest statement:

- **B-4a as written** — miss ≤ 100 ms, hit ≤ 300 ms, *"wall clock at p95 measured end-to-end through
  the installed hook"* — measures **731.2 / 853.9 / 980.4 ms** (miss / hit-64 KiB / hit-1 MiB).
  **Not met.**
- The cause pre-exists substitution: the pre-4.5 script measures **768.0 / 911.0 / 975.0 ms** in the
  same runs, and the hook's three `jq` invocations alone cost median 278.7 / p95 439.5 ms against a
  bash spawn floor of median 36.9 / p95 83.9 ms. **What substitution adds is below the noise floor**
  (marginal p95 −36.8 / −57.1 / +5.4 ms) — which is evidence about the cause, not a pass.
- **The 100 ms miss bound is unreachable on the reference platform by any implementation**: one bash
  spawn (p95 83.9 ms) plus one `jq` (~100 ms) exceeds it before any Cortex logic runs. Even the
  deferred three-jq→one-jq merge (~180 ms/read) lands the totals near ~550/700 ms.

Disposition: **escalated to the PRD owner** (open sprint action item, ShuromiU), the same class of
decision as the 2026-08-02 ruling that produced the current numbers. Candidate shapes, for the
ruling rather than pre-empted here: re-base B-4a end-to-end to what the platform's process floor
supports (with the structural clause primary, as B-4's re-base did); or define B-4a explicitly as
marginal-over-B-4 (which requires widening B-4 to cover `Read`'s base cost); or accept the jq-merge
work as a prerequisite and re-measure. Until ruled, AC #5's latency half is reported as **not
met**; its structural halves (no Node, index-only lookup, one/three-spawn budget) are met and
pinned by test.

**Ruled 2026-08-03 (ShuromiU): re-based end-to-end with the structural clause primary** — the first
candidate shape, the B-4 precedent. Recorded as PRD §10's third dated B-4a amendment: the
structural clause (no Node, index-only lookup, exactly one added spawn on a miss and two more on a
verified hit with the hash strictly after the size and eligibility gates) is the normative,
CI-pinned half; the end-to-end ceiling is **miss ≤ 600 ms / hit ≤ 800 ms p95** through the
installed hook on a quiescent reference platform at default size bounds, re-measured per hook
change rather than CI-gated. The quiescent measurement (510.9 / 612.0 / 671.7 ms — see the
completion-notes table) sits inside the ceiling with 15–19% headroom, so **AC #5's latency half is
now met as re-based**; the epics.md AC text and the quoted AC above carry the amendment, the sprint
action item is closed, and this story moves `review → done`. The three-jq→one-jq merge stays
deferred on its own merits, deliberately not a condition of the ruling.

## What is actually here — run before designing

Every claim below was verified during story creation by reading the file or by measurement, not
recalled. Symbol facts are labelled with the tool that produced them.

### The platform contract (measured, and it disagrees with the published docs)

`https://code.claude.com/docs/en/hooks` documents the PostToolUse payload as
`tool_response: {content: [{type: "text", text: "…"}]}`. The **real** result object recorded in this
machine's transcripts for `Read` is:

```
toolUseResult = { type: "text",
                  file: { filePath, content, numLines, startLine, totalLines } }
```

`content` is the **raw file text** (not `cat -n`-numbered), `startLine`/`numLines`/`totalLines`
identify a partial read exactly (a sample with `startLine: 745, numLines: 200, totalLines: 1038` was
observed alongside full reads with `startLine: 1, numLines == totalLines`).

The transcript records the *tool result object*; the hook receives it as `tool_response`. Those are
expected to be the same object but that expectation is **not evidence**. So:

- **Task 1 is an empirical payload capture** before any extraction expression is finalised.
- The jq extraction must be **tolerant of both shapes**, exactly as `AGENT_FIELDS` already tolerates
  `agent_id` / `agentId` — the script comment there states the reason: "this script is the only live
  capture path, so the tolerance has to live here".
- Nothing in the substitution decision may *depend* on the content field, because of F1. It is used
  only to corroborate a full read; `tool_input.offset` / `tool_input.limit` is the primary signal and
  is present in a shape the hook already parses.

**Both questions were settled by experiment during story creation** — the installed hook was
instrumented, driven by a real `Read`, and restored byte-identically (digest
`56744b83…` before and after, verified both times).

**Input, as the installed hook actually receives it** (Claude Code, this machine, 2026-08-02):

```
top level : cwd, duration_ms, effort, hook_event_name, permission_mode, prompt_id,
            session_id, tool_input, tool_name, tool_response, tool_use_id, transcript_path
tool_input: {"file_path": "C:\\Claude Code\\cortex\\hooks\\claude\\cortex-end-of-turn.sh"}
tool_resp : {"type":"text","file":{"filePath":…,"content":…,"numLines":24,
                                   "startLine":1,"totalLines":24}}
```

So the **transcript shape is the real one and the documented `{content:[{type,text}]}` is not what
arrives.** `agent_id`/`agent_type` were absent, as expected for a primary call. The same read
confirmed F1 from the other direction: `sha256(content, UTF-8)` = `25a0e112…` = the file's own digest
(695 characters, 697 bytes — the file carries an em dash, so a character count would have been the
wrong measurement).

**Output — the documented shape is silently ignored.** Two probes, same plumbing, same match
condition, one after the other:

| probe | `updatedToolOutput` shape | result |
|---|---|---|
| A | `{content: [{type, text}]}` (as documented) | **no substitution** — the real file arrived |
| B | `{type, file: {filePath, content, numLines, startLine, totalLines}}` | **substituted** |

Probe B's marker file proves the branch fired, so A's failure was the *shape* and not the plumbing.
`updatedToolOutput` must **mirror the tool's own result object**. The host then re-renders
`file.content` with line numbers, so the substitution text arrives `cat -n`-formatted — harmless, but
do not try to pre-format it.

This is the exact failure mode this measurement existed to catch: shape A costs nothing, throws
nothing, exits 0, and is indistinguishable from a miss. **Any future tool this mechanism is extended
to must be probed the same way rather than inferred from the docs.**

Also confirmed from the docs and consistent with Epic 0: subagent payloads carry `agent_id` and
`agent_type`, and `session_id` is Claude Code's session id — **not** Cortex's, which is why the state
bridge in D2 exists.

### The hot path as it stands

`hooks/claude/cortex-capture.sh` (71 lines, template with `__CORTEX_NODE__` / `__CORTEX_CLI__` /
`__CORTEX_TEMPLATE_ID__` substitution):

- two `jq -r` calls before the `case` (`tool_name`, `cwd`), then **one** `jq -c` per event branch;
- `tests/capture-hook.test.ts` pins **"uses at most one jq invocation per event branch"** and
  **"spawns Node only inside the size-threshold branch"**. Both constrain this story directly: the
  Read branch gets no second jq, and the substitution path gets no process that is not accounted for;
- it emits nothing on stdout today. Substitution is the first stdout it will ever produce;
- `grep -q '^enabled=true' "$CWD/.cortex.state"` is the existing gate — precedent for reading flat
  state from the project root;
- `cortex-end-of-turn.sh` already owns a per-turn marker lifecycle (`.cortex.agent-used`, created by
  the Agent branch, `rm -f`'d at Stop). `.cortex.turn-reads` follows that established pattern exactly.

Installed wiring on this machine (read from `~/.claude/settings.json`): PostToolUse matcher
`Read|Edit|Write|Bash|Agent` → `bash "C:/Users/dev/.claude/hooks/cortex-capture.sh"`. Stop →
`cortex-end-of-turn.sh`. SessionStart → `… cli.js inject-header --quiet`. `REQUIRED_WIRING`
(`src/query/doctor.ts:163-189`) is shared by `install` and `doctor`; **this story changes hook script
content, not the wiring shape**, so `REQUIRED_WIRING` should not need editing — if you find yourself
editing it, stop and re-read D1.

Bash on the reference platform is **5.2.37** (measured via `Git/bin/bash.exe`), so `${v,,}`,
`${v//x/y}` and `${v#prefix}` are available as **builtins** — the entire path/key normalisation runs
with zero process spawns. `tests/posix-tools.ts` resolves `bash`/`jq`/`grep`/`cut` absolutely and
**must** be used by every test that spawns them (its docstring records the WSL-launcher measurement:
seven tests failing with `status === null` and seven self-skipping, purely by which shell launched
vitest).

### The index the hot path greps

`src/capture/digest-index.ts`, six tab-separated percent-escaped columns, LF-terminated, written
temp-file-plus-rename by the cold-path flush only:

```
scope_key <TAB> path <TAB> sha256|- <TAB> byte_size <TAB> session_id <TAB> agent_id|-
```

Live sample from this checkout (72 records, 16 774 bytes):

```
branch:c:/claude code/cortex/.git:c:/claude code/cortex:r1-context-economy	.tmp-rl/gone.md	fae379b2…	5	38a01dc3-…	-
```

- `indexLookupNeedle(filePath, scopeRoot)` is the **exported** statement of what to search for, and
  its docstring is the specification for the bash side: the key is **case-folded** on win32/darwin,
  **scope-root-relative**, and **percent-escaped**, and the surrounding tabs are required or
  `store.ts` also matches `store.tsx`. **`grep -F` is required, not advisory.**
- An oversize record carries `sha256 = '-'`; it can never match and must miss (AC #2's "or the file
  is oversize" is satisfied structurally, but assert it anyway).
- The index carries **every scope checked out at this root**, so a bare `\tpath\t` needle can match
  two branches' records. Anchoring the needle with the scope key (D2) makes the lookup a single
  `grep -F -m1` returning one line.

### The credit path that exists with no producer — this story is the producer

`src/capture/spool.ts:40-56` defines `tool: 'credit'` with `credit_kind` / `credit_ref` /
`credit_size` / `credit_tokens`; `isReplayable` (129-139) drops any line missing a field;
`replayEntry` (242-286) books it as `direction: 'saved'`, `type: 'substitution:<kind>'`, with a
content-derived deterministic id (`creditRowId`) so a re-flushed orphan claim collides instead of
double-booking. `parseCreditNumber` (161-174) accepts only `/^\d+$/`.

`assertCreditIsEvidenced` (`src/db/store.ts:572-596`) **caps `tokens` at `ceil(evidence.size / 4)`**
for non-`search` kinds and throws otherwise; `replayEntry` catches the throw and drops the line
(with a comment recording that an uncaught throw once destroyed a whole batch permanently). So the
credit arithmetic is not free-form: `estimateTokens` is `ceil(len/4)`
(`src/query/retrieval.ts:80-82`), the full content is `ceil(byte_size/4)` tokens, and the credit must
be `full − payload`, which is under the ceiling by construction. Do not "improve" the estimator here.

### The unrealized interaction, which is easy to get backwards

`handleReadEvent` (`src/capture/hooks.ts:227-252`) calls `bookUnrealizedIfOffered` **before**
`recordReadDigest`, with a comment explaining the ordering. An `unrealized` row means *Cortex offered
a refund and the agent read the file anyway* (FR-8 AC #6). A **substituted** read is the opposite of a
decline. Replaying a substituted read without telling the flush would book an `unrealized` decline
against the very turn Cortex refunded — inverting the one metric that exists to measure adoption.
The read spool line therefore has to carry the substitution fact, and the flush has to **consume** the
open offer without booking the decline (an offer left open would be booked by a later read).

### The obligation this story inherits

`src/query/stats.ts:294-304` carries a `BINDS STORY 4.5` comment and a matching open sprint action
item: the `Saved: 0` explanation asserts a **global** fact ("the mechanism … is not shipped") from
**scope-local** data (`report.scope.totals.saved === 0`). The day substitution books a saving in any
scope, every other scope prints a false statement. Revising it is in scope for this story, not
optional.

### The budget, and why it is split

PRD §10 (amended 2026-08-02, ruling: ShuromiU): **B-4a — miss ≤ 100 ms, hit ≤ 300 ms, wall clock at p95
measured end-to-end through the installed hook, no Node spawn.** The amendment also states, as a
requirement rather than a suggestion: *"A size ceiling above which substitution is skipped entirely is
required."* Reference-platform costs already measured by Epic 3 and recorded in CLAUDE.md: process
spawn floor ~39–42 ms, `jq` alone ~81 ms, `grep -F` over the index 41.0 ms @1k / 45.5 @10k / 58.6
@50k / 100.5 @200k (spawn-inclusive), a plausible full substitution sequence 214.8 ms.

Read those numbers as a design constraint, not as trivia: **the miss path can afford roughly one more
process than it spends today**, and every builtin-instead-of-spawn choice in D3 exists because of
them.

**Re-measured during implementation, and the received wisdom was wrong.** Median of 25 warm runs,
Git Bash 5.2.37 (each figure carries ~55 ms of harness `date` spawns; the *differences* are the
signal):

| operation | median | marginal over spawn floor |
|---|---|---|
| spawn floor (`/usr/bin/true`) | 55 ms | — |
| `sha256sum /dev/null` | 55 ms | ~0 ms |
| `sha256sum` 512 KiB | 57 ms | ~2 ms |
| `sha256sum` 2 MiB | 62 ms | ~7 ms |
| `grep -F` over the live index | 57 ms | ~2 ms |
| `jq` (one call) | ~157 ms in a `sh -c` wrapper | ~100 ms |

**Hashing is not the expense — processes are.** B-4a's 2026-07-24 amendment reasons from *"`sha256sum`
on a 57 KB payload costs ~54 ms"*; that 54 ms is the **spawn**, since hashing nothing costs the same
55 ms and hashing 512 KiB costs 2 ms more. The conclusion the amendment drew (keep the lookup
Node-free) is right; the premise it drew it from is not, and a size ceiling chosen to protect
*latency* would be protecting against something that does not exist.

**The lookup mechanism was chosen by measurement, and the intuitive answer is a trap.** Bash can read
the whole index and match it with builtins — no spawn at all. Measured against synthetic indexes:

| index | zero-spawn `IDX=$(<f)` + `[[ ]]` | `grep -F -m1` |
|---|---|---|
| 1 000 records (214 KB) | **4 ms** | 50 ms |
| 10 000 records (2.1 MB) | 49 ms | 53 ms |
| 50 000 records (10.7 MB) | **599 ms** | 59 ms |

The builtin is 12× faster at the size this checkout is at today (72 records) and **10× worse at
50k**, where it blows both budgets outright. That is precisely the failure this repo hunts: fast on
the developer's machine, a 600 ms tax on every `Read` for a user with a large repository, invisible
until then. `grep -F -m1` is **scale-independent** (50→59 ms across a 50× size range, because it is
spawn-dominated) and fits the marginal miss budget everywhere. **Use `grep`. Do not "optimise" it
into the builtin form** — this table is why, and a reviewer asking "why not just read it in bash"
deserves the numbers rather than an argument.

## Design decisions

### D1 — Substitution lives inside `cortex-capture.sh`, not in a second hook

A second PostToolUse hook would double the per-`Read` process cost — the miss path is the
unconditional tax on every read, and the spawn floor alone is ~39–42 ms. `cortex-capture.sh` is
already wired for `Read`, already parses the payload, already reads `.cortex.state`, and already
appends the spool line the credit must sit beside. Consequences:

- the Read branch keeps **one** jq invocation (pinned by an existing test); it emits the spool line
  **and** the shell fields the decision needs, as one `@tsv` record read back with
  `IFS=$'\t' read -r`;
- `REQUIRED_WIRING` and the installed settings are unchanged — only script *content* changes, which
  means the hook-currency digest changes and **`cortex install` must be re-run** (the standing
  rollout rule's step 2);
- capture is never sacrificed to substitution: the spool append happens regardless of the decision,
  and any failure in the substitution path degrades to printing nothing (AD-12).

### D2 — The state bridge: `.cortex.state` publishes what the hot path cannot compute

Three facts the hook needs and cannot derive without SQLite or git:

| key | value | why |
|---|---|---|
| `session_id` | Cortex's current **primary** session UUID | AD-16 eligibility (F2). The payload's `session_id` is Claude Code's, not Cortex's. |
| `index_scope` | the current scope key, **percent-escaped** as the index stores it | anchors the needle to one scope so the lookup is one `grep -F -m1` |
| `scope_root` | the scope root, normalised the way `normalizeFilePathKey` normalises it | lets bash derive the scope-relative key with builtins alone |
| `path_fold` | `lower` on win32/darwin, `none` elsewhere | keeps the shell's case folding agreeing with `normalizeFilePathKey` on every platform |

`inject-header` holds all three at SessionStart (it calls `ensureScopedSession`, and
`CortexStore.scopeRootFor(scopeKey)` resolves the root), and it already rewrites `.cortex.state`
wholesale at `src/transports/cli.ts:829`. Per-session facts in a file rewritten every session is the
right coupling; `writeEngagement` (`src/transports/mcp.ts:98-125`) is key-preserving, so MCP writes
do not erase them.

**Correctness follows from the session id, not from the scope key.** Sessions are scope-keyed, so a
record whose `session_id` matches the current primary is necessarily in the current primary's scope;
`index_scope` is an optimisation that turns a possibly-multi-line grep into a single line. If either
key is absent — cold start, un-engaged project, an older `inject-header` — the hook misses. Silent,
safe, and the only degradation.

**Staleness is bounded and safe.** A branch switched mid-session leaves both keys describing the
session's original scope; the session row's `scope_key` is fixed at creation, so state and store stay
*consistent with each other* and the refund remains attributed to a session that really did read the
file.

### D3 — The enable flag is a marker file, checked with a builtin

`.cortex.substitution` — existence is "on", `cortex substitution off` removes it. AC #6 demands an
explicit opt-in, and the check runs on **every** tool call, so it must cost nothing:
`[ -f "$CWD/.cortex.substitution" ]` is a bash builtin. Putting the flag in `.cortex.state` was
rejected: the existing `enabled=true` test is a `grep`, so a second key means a **second process on
every tool call including `Edit`, `Write`, `Bash` and `Agent`** — a tax on paths that can never
substitute. It also cannot live in the store (AD-2) or under `$CORTEX_HOME` (the hook cannot hash a
path — the architectural floor recorded in `digest-index.ts`).

New surface: `cortex substitution [on|off|status]`, printing what it did, plus a `doctor` row so the
state is discoverable where users already look. `install` does **not** enable it — AC #6.

### D4 — Gate order is cheapest-to-fail, and the two budgets buy different things

Every step before the hash is a builtin except one `grep`. The marker grep is deliberately placed
*after* the index hit so the miss path never pays for it.

1. `[ -f .cortex.substitution ]` — builtin. (AC #6)
2. full read? **`startLine == 1 && numLines == totalLines && numLines > 0`** — derived inside the
   branch's single jq, from `tool_response.file` (`.file?`, so a scalar `tool_response` degrades to
   not-full instead of aborting capture). Checked AFTER the turn marker in the shipped code — a
   partial read still marks the file, or the full read following it in the same turn would
   substitute as the turn's first (the ordering the review pinned). A partial read never
   substitutes: `content_digests` records a
   **whole-file** digest regardless of what the read returned, so a slice-read would otherwise be
   told it holds the whole file. (AD-6)

   These payload fields are the **primary** test, not corroboration for `tool_input.offset`/`limit`,
   and the difference is load-bearing. `Read` truncates at 2000 lines, so a file of 5000 lines
   requested with **no** `offset` or `limit` returns 2000 lines: `tool_input` says "full read" while
   the agent holds two fifths of the file. Gating on `tool_input` alone would substitute there and
   tell the agent it holds content it has never seen — AD-6's cardinal failure, reachable on any
   large file. `tool_input.offset`/`limit` may still be checked as a cheap early-out; it may never be
   the only check.
3. `session_id` / `index_scope` / `scope_root` present in `.cortex.state` — parsed from the read the
   hook already performs.
4. derive the key: backslashes → `/`, strip the `scope_root` prefix, `${v,,}` on win32, `%` → `%25`.
   **All builtins.** A path containing a tab, CR or LF misses rather than being escaped — it cannot
   survive a single-line shell variable honestly, and AD-6 says ambiguity is a miss.
5. `grep -F -m1 "<index_scope><TAB><key><TAB>" "$CWD/.cortex.index" 2>/dev/null` — **the one spawn on
   the miss path.** No hit → print nothing, exit 0. The redirect is not decoration: on a project that
   has never flushed, the index does not exist, and an unredirected `grep` writes to the hook's
   stderr on every single read.
6. split the six columns with `IFS=$'\t' read -r` — builtin.
7. eligibility and economics, all builtins: `sha256 != '-'` (oversize, AC #2); `session_id ==` the
   state's; `agent_id == '-'` (F2); `byte_size` is `/^[0-9]+$/`; `byte_size` between
   `CORTEX_SUBST_MIN_BYTES` and `CORTEX_SUBST_MAX_BYTES`.
8. *(superseded by the review round — the marker moved to step 4.5 as append-then-count, and a
   `wc -c` size gate now precedes the hash; see "Review reconciliation".)*
9. `sha256sum "$FILE"`, compare — **the last spawn, hit path only.** (AC #1, corrected per F1)
10. compute the credit; refuse a non-positive one; `printf` the `updatedToolOutput` JSON; append
    the `credit` spool line. All builtins.

The ceilings are **not guesses**, and the honest statement of what they buy differs from what the
amendment assumed. Measured above: hashing 2 MiB costs ~7 ms over the spawn, so `CORTEX_SUBST_MAX_BYTES`
is **not** what keeps step 9 inside 300 ms — the spawn count is. It ships anyway, because the
amendment requires a ceiling and because it is real protection on a platform whose `sha256sum` is
slower than this one's. Default **1 MiB**: measured marginal cost ~5 ms, and deliberately *below*
`CORTEX_DIGEST_MAX_BYTES` (2 MiB) so it is a live gate rather than a no-op alias for the digest
ceiling. In practice the full-read check subsumes most of it — `Read` truncates at 2000 lines, so a
large file usually fails step 2 first — and the story says so rather than letting the ceiling take
credit it does not earn.

`CORTEX_SUBST_MIN_BYTES` (default **2048**) exists because substituting a file smaller than the
payload *costs* tokens: below ~512 tokens of content the refund is not worth a `sha256sum`, let alone
the risk. Both parse with `Number` on the Node side — `parseInt` reads `2e6` as 2, which this
repository has now had to say four times.

### D5 — The payload names itself, the file, the cost, and the way back

AC #3 requires three facts; the escape hatch (F4) is the fourth and is this story's addition. One
line, target ≤ 40 tokens — the user story's economics are "twenty tokens instead of four thousand",
so a verbose banner defeats the feature. Shape:

```
[cortex] substituted: <scope-relative path> is byte-identical to what you read earlier in this
session (verified by sha256 just now). Full content ≈<N> tokens. Read it again to get the real text.
```

It is carried in the **result-mirroring** envelope proven above — `updatedToolOutput` is
`{"type":"text","file":{"filePath":…,"content":<the line>,"numLines":1,"startLine":1,
"totalLines":1}}` — because the documented `{content:[…]}` form is accepted and ignored.

Rendering rules, inherited from every other surface in this repo and **not** re-derived here: the
path is JSON-escaped for `"` and `\` with builtins, and a path carrying a control character misses at
step 4 rather than being emitted. `N` is `(byte_size + 3) / 4` in shell integer arithmetic — the same
`ceil(len/4)` `estimateTokens` uses, so the number the agent is shown and the number the ledger books
come from one formula.

### D6 — The credit is emitted as a spool record, and the read line records that it was refunded

AD-15 exactly: `{tool: "credit", credit_kind: "read", credit_ref: <key>, credit_size: <byte_size>,
credit_tokens: <full − payload>}`. The cold-path flush books it as `saved` with evidence. A lost
record is no credit; a partial record is dropped by `isReplayable`.

Separately, the **read** line carries a substitution marker so `handleReadEvent` can consume any open
`read_offer` **without** booking the `unrealized` decline (see "What is actually here"). Two facts,
two lines, one turn.

Emit both from the branch's single jq (a two-element `@tsv` of the plain and the marked line, one of
which the shell selects) rather than by string-surgering `}` off the end of compact JSON. Same spawn
count, and the JSON never stops being produced by a JSON tool.

### D7 — B-4a is measured per path through the installed hook, and a false green here is the cardinal sin

Per F5 this is **four** numbers, not two: the marginal cost of the substitution path against B-4a
(miss ≤100 ms, hit ≤300 ms) **and** the total installed-hook cost against B-4 (≤500 ms), for each
outcome. The marginal figure is the difference between the current script and the unmodified one
measured in the same harness, in the same run, so platform noise cancels rather than accumulating.

Two scenarios, each measured both ways, reported separately and labelled with the platform:

- **miss** — enabled, a path with no index record: p95 over ≥ 50 iterations, driving
  `~/.claude/hooks/cortex-capture.sh` (the **installed, rendered** script, after `cortex install`)
  with a synthetic payload through `tests/posix-tools.ts`-resolved bash. Target ≤ 100 ms.
- **hit** — enabled, a record present, digest matching, at the chosen `CORTEX_SUBST_MAX_BYTES`
  (measure at the ceiling, not at a convenient small file). Target ≤ 300 ms.

Record the bare-spawn floor beside them, as Stories 3.2/3.3/3.6 did. **If a number misses its budget,
report it as missed** and bring the ceiling or the design back to the story — the PRD amendment was
written precisely because the previous budget was unreachable, and its credibility depends on the
next measurement being honest. State explicitly which index size the miss number was taken at; 41 ms
@1k and 100.5 ms @200k are the same code with different data.

### D8 — `PreToolUse` is proven silent, not assumed silent (AC #7)

AC #7 is a negative, and negatives rot quietly. Pin it with a test that asserts no hook script and no
`hook-entry` output path can emit `permissionDecision` at all — a search over the shipped templates
plus an assertion on `reflect-pre`'s real output shape. `cortex-reflect.sh` emits `additionalContext`
only today; the test is what keeps that true after this story adds the repo's first
decision-influencing hook output.

### D9 — The `Saved: 0` explanation is re-keyed to what is actually observable

Discharging the `BINDS STORY 4.5` obligation. The revised branch must not assert a global fact from
scope-local data. Report what this scope can see:

- scope saved `= 0` **and** substitution not enabled here → say the mechanism exists and is off, and
  name `cortex substitution on`;
- scope saved `= 0` **and** substitution enabled → say no verified savings have been recorded in this
  scope yet;
- scope saved `> 0` → no explanation line, as today.

Remove the `BINDS STORY 4.5` comment in the same change, and close the sprint action item. Whether
`stats` reads the marker file is an implementation choice — but `stats` **only reads** (Story 3.6's
D8, pinned by a run-twice byte-identical test), so it may stat the marker and must not create it.

### D10 — Boundaries: what this story must not do

- **No schema change, and no `SCHEMA_VERSION` bump.** Nothing here needs a table: the flag and the
  turn marker are files, the credit rides the existing spool contract, and `content_digests` already
  carries every column the lookup reads. `project-context.md` calls bumping the version because a
  story's text seems to ask for it "the single worst available mistake here" — and this story's ACs
  do not even ask.
- **No new wiring.** `REQUIRED_WIRING` and the installed `settings.json` are untouched (D1). Hook
  *content* changes, which is what `cortex install` is for. Editing hook wiring in settings is also
  the one class of edit that gets classifier-denied on this machine; if you ever believe you need it,
  produce the exact diff for the user instead of attempting the write.
- **Substitution inherits engagement.** `cortex-capture.sh` exits at `grep -q '^enabled=true'` before
  the `case`, so `cortex_disengage` turns substitution off with everything else. That is correct, and
  it means the enable flag is a *second* gate, never a bypass.
- **`$CWD` may be a subdirectory.** `.cortex.index`, `.cortex.state` and both new files resolve from
  the payload's `cwd`, exactly as the spool always has. An agent working below the flush directory
  finds none of them and misses. Pre-existing, safe, and not this story's to fix — but do not be
  surprised by it while measuring.
- **The bash key derivation must be pinned against `indexLookupNeedle`, not merely written to match
  it.** The TS function is exported precisely so consumers cannot drift, and its docstring lists
  three transformations that each fail *silently as a false "unread"*. A test must compute the needle
  in TypeScript, seed a record with it, and assert the **shell** finds that record — for a
  mixed-case path, a path containing `%`, and a path below a nested directory. Re-implementing the
  rules in bash and testing bash against bash proves only that the reimplementation is
  self-consistent.
- **Stdout discipline.** The hook prints nothing today. After this story it prints on exactly one
  path: an accepted substitution. Nothing on `Edit`, `Write`, `Bash`, `Agent`; nothing on a Read that
  misses; nothing on stderr. A hook that chatters is a hook that eventually corrupts a turn.

## Tasks

1. [x] **Measure the real payload first.** Capture one genuine `PostToolUse` `Read` payload as the
   hook receives it (temporary instrumented copy of the installed script, restored byte-identically —
   or any method that does not require the user to edit protected settings). Record the exact
   `tool_response` shape in the completion notes. Every extraction expression is written against
   this, with tolerant fallbacks for the documented alternative shape. Do not skip this because the
   transcript already showed a shape — the transcript is a different artifact.
   **Done — results folded into "The platform contract" above.** Input shape confirmed
   (`tool_response.file.*`, docs wrong); output shape settled by two probes (documented
   `{content:[…]}` ignored, result-mirroring `{type,file:{…}}` substitutes); installed hook restored
   byte-identically, digest `56744b83…` verified before and after each probe.
2. [x] **State bridge** (`src/transports/cli.ts` `inject-header`, plus whatever helper it needs):
   write `session_id`, `index_scope` (percent-escaped via `escapeIndexField`) and `scope_root` into
   `.cortex.state`. Reuse `escapeIndexField`/`normalizeFilePathKey` — do not hand-roll either.
3. [x] **Enable surface**: `cortex substitution [on|off|status]` writing/removing
   `.cortex.substitution`; add it and `.cortex.turn-reads` to `IGNORE_ENTRIES`
   (`src/query/install.ts:74-91`); add a `doctor` row reporting the current state.
4. [x] **Hot path** (`hooks/claude/cortex-capture.sh`): the D4 gate inside the `Read` branch, one jq,
   the D5 payload on stdout, the D6 credit and marked read lines. `cortex-end-of-turn.sh`: `rm -f`
   the per-turn marker beside the existing `.cortex.agent-used` removal.
5. [x] **Cold path**: teach the flush that a marked read line consumes an open `read_offer` **without**
   booking `unrealized`. Before touching `handleReadEvent` or `SpoolEntry`, run
   `find_referencing_symbols` on both and act on that list; then `certify_refs` `handleReadEvent`
   with a `symbols` anchor and read `lspOnly`/`textOnly`.
6. [x] **Stats** (`src/query/stats.ts`): D9. Remove the `BINDS STORY 4.5` comment; mark the sprint
   action item done with what was actually changed.
   - [x] **`src/index.ts`**: re-export every new public symbol and its types. It is an exhaustive
     hand-maintained list, not a barrel glob, and `isolatedModules` requires `type` markers on
     type-only re-exports.
7. [x] **Tests**: `tests/substitution.test.ts` (new) for the shell gate driven through
   `tests/posix-tools.ts`-resolved bash against the **rendered** template, plus unit coverage in the
   existing suites for the state bridge, the enable surface, the flush's offer handling, and the
   stats branch. The full edge inventory below. `npm run lint` does not typecheck `tests/`.
8. [x] **Measurement** (D7): miss p95 and hit p95 through the installed hook, plus the spawn floor and
   the index size each was taken at. Derive `CORTEX_SUBST_MAX_BYTES`'s default from the `sha256sum`
   throughput measurement rather than choosing a round number.
9. [x] **Docs**: `README.md` (the refund is the product's headline claim — say what it does, that it
   is off by default, and how to turn it on), `CLAUDE.md` (invariant bullets + Core Files),
   `_bmad-output/project-context.md` (the Dormant Surface paragraph's "Verified substitution (Story
   4.5) is what will produce real credit; until then `Saved` is honestly 0" is now false — fix it).
10. [x] **Mutation campaign**: every new assertion, each mutation proven applied and restored
    byte-identically, mutating `src/` and `hooks/` — **never `dist/`**. Survivors are findings, not
    noise.
11. [x] **Byte-scan every touched file before commit** for literal control characters. `\uXXXX`
    escapes only. This repo has two files invisible to `grep` because of exactly this.

## Edge inventory (each becomes a test)

**Enablement and passthrough**
- No `.cortex.substitution` → no stdout, ever, for any payload (AC #6). Assert on **empty** stdout,
  not on "no substitution marker".
- Enabled + no index record → no stdout; the spool read line is still appended (capture survives).
- Enabled but `.cortex.state` lacks `session_id` / `index_scope` / `scope_root` → miss.
- `enabled=true` absent → the script exits before anything, as today.

**Verification (AC #1, AC #2)**
- Digest matches → substitution. **Include a CRLF file in the fixture set** — this is F1's regression,
  and a suite of LF-only fixtures cannot see it.
- File changed on disk since the record → miss, and the miss is by *hash*, not by size: seed a change
  that preserves `byte_size`.
- Record has `sha256 = '-'` (oversize) → miss (AC #2).
- `byte_size` non-numeric / negative / empty column → miss, no arithmetic error.
- Record `session_id` ≠ state's → miss (AD-16).
- Record `agent_id` ≠ `-` → miss, **including when it equals the requesting subagent's own id** —
  F2's deliberate subset, pinned so a later "improvement" is a conscious change.
- Two branches' records for one path present in the index → the scope-anchored needle picks this
  scope's, and a mutation removing the anchor is killed by a fixture where the other branch's record
  *would* match.
- Path containing `%` → still found (percent-escaping); path containing a tab or newline → miss.
- Mixed-case path on win32 → found (case folding).
- Path outside the scope root (absolute key) → behaves per `toScopeRelativeKey`, no crash.

**Partial reads**
- `tool_input.offset`/`limit` present → miss even when the digest matches.
- Payload reporting `startLine > 1` or `numLines != totalLines` → miss.

**AC #4 — second read in a turn**
- read → substituted → read again in the same turn → real output, and the marker is what caused it.
- Stop clears the marker; the next turn substitutes again.
- A first *partial* read followed by a full read in the same turn → passes through (the literal AC).

**AC #3 — payload**
- Names itself, names the file, states the token count; token count equals `ceil(byte_size/4)`;
  ≤ the token target; the recovery sentence is present.
- Valid JSON, `hookSpecificOutput.hookEventName == "PostToolUse"`, `updatedToolOutput` present and
  **result-mirroring** (`.updatedToolOutput.file.content` is a string; `.updatedToolOutput.content`
  is absent) — parse it with jq in the test rather than substring-matching. Probe A proves a
  wrong-shaped payload is accepted silently, so the test must assert the shape, not merely that JSON
  was printed.
- A path containing `"` or `\` produces valid JSON.

**Accounting**
- A substitution emits exactly one `credit` line; flushing books exactly one `saved` row with
  evidence; `credit_tokens ≤ ceil(credit_size/4)` so `assertCreditIsEvidenced` never throws.
- Flushing the same batch twice books one row (`creditRowId` collision).
- A substituted read with an open `read_offer` → the offer is consumed and **no** `unrealized` row
  is booked. Build the offer through the real writer, not by hand.
- A non-substituted read with an open offer → `unrealized` booked exactly as today (no regression).

**Key derivation (D10)**
- Needle agreement: a record seeded at `indexLookupNeedle(path, scopeRoot)` is found by the **shell**,
  for a mixed-case path, a path containing `%`, and a path in a nested directory. This is the test
  that catches a bash-side drift; bash-versus-bash proves nothing.
- Missing `.cortex.index` → miss, and **nothing on stderr**.

**Structural (AC #5, AC #7, N-4)**
- The Read branch contains exactly one `jq` invocation; the script spawns Node only in the
  256 KiB branch (extend the existing assertions rather than writing parallel ones).
- **Empty stdout and empty stderr** for `Edit`, `Write`, `Bash`, `Agent`, and for a `Read` that
  misses — asserted as exact emptiness, not as "no substitution marker".
- A disengaged project (`enabled=true` absent) substitutes nothing even with the flag present.
- No `permissionDecision` in any shipped hook template or hook-entry output (D8).
- Nothing under `hooks/` writes `.cortex.index` (the existing AD-2 assertion still holds).
- `SCHEMA_VERSION` is unchanged by this story (assert the constant, so an accidental bump is a red
  test rather than a silent P-5 refusal on every shipped store).

**Rollout**
- `cortex install` on a tree with the previous script reports it as `unmodified` and overwrites; the
  hook-currency digest changes; a second run is byte-identical. This story *will* trip
  `doctor`'s hook-currency check until `install` is re-run — that is correct behaviour and should be
  asserted, not worked around.

## Review reconciliation (three layers, 2026-08-03)

All three layers ran in parallel against the full diff with execution rights; every HIGH finding
below was **reproduced by the reviewer before being reported**, and every fix was re-verified by
test. Reconciled: **5 HIGH, 9 MED, 12 LOW → 22 fixed, 3 documented-as-residual, 1 escalated to the
PRD owner.** Findings marked with the layer(s) that found them; two were found independently by two
layers, which is the point of running three.

### HIGH — fixed with a design change: flush-window eligibility

- [x] **The cardinal failure, reproduced end-to-end (Blind).** The digest is recorded at FLUSH time
  (Story 3.1, structural under N-4), so read A → command rewrites to B → flush records B → the next
  read is substituted with "byte-identical to the copy already in this session's context" while the
  context holds A. The hook was also contradicting `queryReadLedger`, which answers
  `edited-by-you-since` for the same state — two surfaces, opposite answers, and the wrong one
  destroys the tool result. **Fix — eligibility is decided where the events are visible:** the flush
  pre-pass certifies a read's digest as `refund_eligible` only when nothing that could have rewritten
  the file follows it in its batch — a later `edit`/`write` of the same path, or **any** later `cmd`
  (commands rewrite files invisibly; classifying them is Story 4.4's problem, and AD-6 forbids the
  guess). Same-second neighbours disqualify (`>=` — hook timestamps are whole-second, ambiguity is a
  miss); a missing timestamp disqualifies; the backgrounded 256 KiB flush additionally peeks the LIVE
  spool, because a command that landed after the claim has already changed the disk this flush is
  about to hash; `inject-header`'s leftover flushes certify nothing (a session boundary sits between
  the read and the hash). The column is additive (AD-11, `ensureColumn`, DEFAULT 0 so every
  pre-existing row is ineligible until refreshed by a clean read), `collectIndexRecords` publishes
  **only eligible records** — the index's sole reader is the substitution hook, so the writer
  enforces what the reader cannot see — and `queryReadLedger` requires it before `refundEligible`,
  so an ineligible record also grounds no offer and can book no false `unrealized`. The eligible
  window narrows honestly: a read followed in its own turn by a build is simply not refundable, and
  a later clean re-read re-earns it. Residual, unchanged from Story 3.1's documented bound: a writer
  **outside** Cortex entirely, now shrunk from a full turn to milliseconds around the flush. 13 new
  tests, including a cold+hot end-to-end that runs the real flush, the real index writer and the
  real hook — the divergence the fixture family structurally could not represent (Blind's finding
  about the tests, answered where it had to be).
- [x] **A subagent was served the primary's substitution (Edge, reproduced).** The gates proved the
  *primary* read the file; nothing proved the *requester* was the primary, and a subagent starts
  with a fresh context. Fix: a payload carrying `agent_id` never substitutes — AD-16 attribution is
  necessary, the requester gate is sufficient. F2 is rewritten accordingly: refunds are now
  primary-only in both directions, strictly narrower than AD-16 permits, and the credit line drops
  its agent fields because only a primary can reach it.
- [x] **A failed turn-marker append disabled AC #4's escape hatch (Edge, reproduced).** With the
  marker unwritable, `seen` stayed 0 and three consecutive reads all substituted — no way back to
  the real bytes. Fix: append-then-count — the append IS the claim (`|| return 1` when it fails),
  and only a count of exactly 1 proceeds. The same mechanism closes the concurrency race (Blind,
  measured 1–3 substitutions across 8 four-way trials): both racers' lines are in the file after
  both appends and each scans after its own append, so at most one can ever count 1 — proven, and
  pinned by a 6-way concurrent test asserting ≤ 1.
- [x] **Credit was booked whether or not the host honoured the substitution (Blind).** No
  acknowledgement channel exists in the hooks API, so this is closed as far as a client can close
  it: the credit is emitted only after every verification gate has passed on evidence in hand, and
  the residual — a host build that silently stops honouring `updatedToolOutput` — is **documented in
  README and CLAUDE.md as the known limit of the evidence**, with the `doctor` hook-currency check
  covering the script half. Recorded in deferred-work as unfixable client-side rather than reported
  as covered.

### The escalation — AC #5's latency budget (Auditor, HIGH)

The Auditor caught my F5 flag mis-scoping B-4: **PRD §10 scopes B-4 to the non-substituting path
(`Edit`, `Write`, `Bash`, `Agent`) — it never covered `Read`** — so "B-4a is the marginal, B-4 is
the total" deleted the only budget governing this path and graded the story against a budget that
does not exist. F5 is rewritten: **B-4a as written (end-to-end 100/300 ms p95 through the installed
hook) is NOT met** — measured 731/854/980 ms — and is **structurally unreachable on the reference
platform by any implementation**: the hook's pre-existing three `jq` invocations alone measure
median 278.7 / p95 439.5 ms against a bash spawn floor of median 36.9 / p95 83.9 ms, so the miss
budget is exceeded before any substitution logic runs. What substitution *adds* is below the noise
floor (marginals −36.8 / −57.1 / +5.4 ms). This is a PRD-owner decision of exactly the 2026-08-02
ruling's class, recorded as an open sprint action item (owner: ShuromiU) with the options laid out
there. Until ruled, AC #5's latency half is reported as **not met**, and the structural halves
(N-4, AD-3, spawn budget) as met and pinned. *Ruled 2026-08-03: re-based end-to-end with the
structural clause primary — see F5's closing paragraph for the full record; the latency half is now
met as re-based.*

### MED / LOW — fixed

- [x] Control characters beyond TAB/CR/LF reached the JSON payload (Edge + Auditor,
  independently). jq `safe` now blanks on any C0 or DEL via `explode` — chosen after the regex
  class form **failed in measurement**: Oniguruma read the u-escaped class as literal
  characters, blanking every Windows path, caught by the smoke test in minutes — and the bash key
  guard is `*[[:cntrl:]]*`, belt-and-braces by the `toScopeRelativeKey` double-guard precedent.
- [x] The `%`-escaped lookup key leaked into the payload text, `filePath`, and `credit_ref` (Edge +
  Blind). Escaping now happens on the lookup copy only; the payload names the real path, and
  `credit_ref` joins back to `content_digests.path`.
- [x] `filePath` now mirrors the **requested absolute path**, not the index key (Blind) — the host
  keys per-path read-state from that field.
- [x] The size gates ran on the recorded size while the hash ran on the disk (Blind, measured
  1294 ms hashing 300 MB against a 6 KB record). One `wc -c` (~55 ms, hit path only, review-priced)
  now requires recorded == on-disk before hashing — which also kills Edge's corrupt-`byte_size`
  credit inflation, since past that gate the recorded size is the verified size.
- [x] A scalar `tool_response` aborted the branch jq and **lost the read from capture** (Edge, six
  shapes reproduced). `.tool_response.file? // {}` — verified against all six; capture pinned.
- [x] Zero-or-negative credit substitutions refused **before** the payload prints (Edge).
- [x] `numLines 0 == totalLines 0` no longer reads as a full read (Edge).
- [x] Marker append/spool-probe stderr silenced — redirection order, twice (Edge; the same
  left-to-right bug in two places).
- [x] Huge-integer sizes miss silently instead of erroring on stderr (Edge).
- [x] `scope_root` trailing slash stripped, with the root-scope (`/` → absolute keys) case matched
  to `toScopeRelativeKey`'s behaviour (Edge).
- [x] CR stripped from the grep hit, matching `parseIndexLine` (Edge).
- [x] `cortex substitution` arms the **git toplevel**, not the shell's cwd (Blind, reproduced:
  armed `src/`, reported on, hook never looked there); `status` reports the **effective** env-derived
  size gate and warns when armed with no hot-path facts (Blind + Edge).
- [x] The missing `doctor` row (Auditor, HIGH as a process failure): `substitution` check shipped —
  off is a pass with the enable pointer, on-with-facts is a pass, **on-but-inert is a warn** naming
  the cause; pinned by four tests and added to the check inventory.
- [x] The missing D8 test (Auditor, HIGH as a process failure): `permissionDecision` now pinned
  absent across all three templates and the hook bridge, with the bridge's envelope key asserted.
- [x] `stats` `unknown` state no longer takes the `on` wording; three-way branch, three-way tested
  (Blind).
- [x] `StatsReportOptions` exported; the size-bound test imports `DEFAULT_DIGEST_MAX_BYTES` instead
  of hard-coding 2 MiB; the control-byte guard now scans DEL and says so (Auditor/Blind LOWs).
- [x] `inject-header` clears a stale turn marker at SessionStart — a crashed session no longer
  suppresses the next session's first turn (Blind); gives `deriveTurnReadsPath` its production
  caller.
- [x] `grep -F` anchoring comment corrected — `-F` cannot anchor; a scope-suffix collision resolves
  to a miss through the session gate, stated instead of claimed away (Blind).

### Documented as residual, not fixed

- **Two concurrent Claude Code windows in one project root** share `.cortex.state`, so window B's
  primary can satisfy the session gate for window A's reads (Auditor). Inherited from the session
  model (Story 3.3 has the same shape in attribution); substitution's blast radius is bounded by
  AC #4's escape hatch and by the eligibility rule (any command in the batch disqualifies). Fixing
  it means per-window session identity, a scope-layer change; recorded in deferred-work.
- **Astral-plane paths never substitute** (`${key,,}` corrupts 4-byte UTF-8; `grep -F` misses even
  uncorrupted needles) (Edge). Direction is a silent under-refund; noted in the hook.
- **`<<<` left the per-branch jq counter's alternation** when the counter narrowed (Auditor). The
  two here-strings are builtins — no process — and the story now says the guard was *relaxed* for
  them rather than claiming pure narrowing; `xargs` stays banned globally.

## Previous-story intelligence (3.6, `b50e2bf`)

- **Measure before claiming — especially what a command prints and what a platform does.** 3.6
  measured B-6 in-process (2.2 ms median) *and* recorded the CLI end-to-end cost (435–454 ms against
  a 54–91 ms bare-`node` floor) rather than reporting the flattering number alone. This story's D7 is
  the same discipline against a budget that has already been re-based once.
- **A fixture that cannot observe the mutation is not coverage.** 3.6's campaign found four
  survivors that were all weak fixtures: a top-10 filter hidden by `LIMIT`, a cross-key comparison
  unobservable with one scope key, and — the sharpest — a session-blind `GROUP BY` that survived
  because *every rollup fixture in the repo seeds one session*. Directly applicable here: a
  single-scope index fixture cannot see the scope anchor, a single-session fixture cannot see the
  AD-16 check, and an LF-only fixture cannot see F1.
- **Reconcile all three review layers before recommending anything.** 3.5's first completion report
  claimed a two-part fix with one part done; 3.6's run produced 19 patches from three layers, several
  found independently by all three.
- **Stored strings are content.** Any author-supplied string reaching a renderer is collapsed,
  escaped and truncated — here that is the file path in the JSON payload and in the credit evidence.
- **`IN ()` is accepted by SQLite 3.51.3** (measured, contradicting the folk rule) — relevant only as
  a reminder that this repo's rule is to check rather than to repeat what everyone knows.
- Windows facts already paid for: no literal control bytes in source, ever; `os.tmpdir()` never
  `/tmp`; POSIX tools via `tests/posix-tools.ts`; `Number` never `parseInt`; `npm run lint` does not
  typecheck `tests/`.
- `src/transports/hook-entry.ts` and `src/query/reference-validation.ts` carry raw NUL bytes, so
  plain `grep` skips them **silently**. Use `grep -a` or Serena. This story touches the hook layer,
  which is exactly where that bites.

## Verification

- `npm run build` && `npm run lint` && `npx vitest run`
- `npm run gate` — **must pass untouched.** No retrieval surface changes are expected; a baseline
  regeneration in this story would be a red flag, not a fix. (`content_digests` does not project into
  `memory_items` per AD-4, so no AD-5 fixture obligation arises.)
- `cortex install` (hook content changed — required), then `cortex doctor` on the live installation:
  hook currency must go green *after* the install and be red before it.
- **End-to-end proof on the live installation**, not just in tests: enable substitution, read a file,
  end the turn, read it again, confirm the substituted payload arrives and that `cortex stats` books
  a non-zero `Saved` with evidence. This is the first credit this product has ever booked — record
  the before/after `cortex stats` output in the completion notes.
- D7's two measurements, honestly labelled, with the spawn floor and index size beside them.
- Mutation campaign per Task 10; byte-scan per Task 11.

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Opus 5)

### Completion Notes

**AC #1 — verified substitution, proven through the real host, not a harness.** Enabled substitution
in this checkout, read `src/capture/digest.ts` (7543 bytes, ~1886 tokens) after its digest was
recorded under the current primary, and Claude Code returned **one 189-character line in place of the
file**. That is the only proof that counts: a unit test asserts what the hook *printed*, not what the
host *honoured*. Evidence: the substituted read is in this session's transcript, and `cortex stats`
then reported `Saved: 1.8k` / `Ratio: 22.37×` for the session — **the first evidence-backed credit
this product has ever booked.**

**The platform contract was measured, and the published docs are wrong on both sides.** Task 1
instrumented the installed hook, drove a real `Read`, and restored it byte-identically (digest
`56744b83…` verified before and after every probe).
- *Input*: `tool_response` is `{type:"text", file:{filePath, content, numLines, startLine,
  totalLines}}`, **not** the documented `{content:[{type,text}]}`.
- *Output*: two probes, same plumbing, same match condition — the documented shape **did not
  substitute**; the result-mirroring shape did. A wrong-shaped payload costs nothing, throws nothing,
  exits 0, and is indistinguishable from a miss.

**Three defects were found by measurement that no amount of reading would have caught**, each of
which would have made substitution silently never fire on the reference platform:
1. **CRLF normalisation** (F1). The payload's `content` has CRLF collapsed to LF, so hashing the
   returned text can never match a digest over the file's bytes. Implemented as a disk hash instead.
2. **`jq` emits CRLF on Git Bash**, and command substitution strips only the *final* CR — so the
   Read branch's six-field output carried a CR into the lookup key and every substitution missed. The
   existing single-value `jq` reads in this hook are safe only by that accident.
3. **GNU `sha256sum` escapes filenames containing a backslash** by prefixing the whole output line
   with `\`, so `sha256sum "C:\…"` returns `\b039a62…`. Every Windows path has backslashes; the
   comparison could never have matched. Fixed by forward-slashing the path, plus a `^[0-9a-f]{64}$`
   shape check so the same escaping for a newline-bearing filename also misses rather than compares.

**AC #4 was found under-implemented by its own test** and fixed: the turn marker was written after
the full-read gate, so a partial read did not mark the file and the full read that followed it
substituted as though it were the turn's first. The marker now records every *evaluated* read; both
steps are builtins, so the reordering costs nothing.

**AC #5 — latency half NOT met as originally written; escalated, then ruled 2026-08-03 (met as
re-based).** The first version of these notes reported "B-4a met with large headroom" against a
marginal reading the Acceptance Auditor showed to be self-grading (see F5 — PRD §10's B-4 never
covered `Read`, so B-4a's end-to-end wording is the only budget on this path). Re-measured through
the **installed** hook after all review fixes, 60 runs each after 5 discarded warmups, 1000-record
index, current and pre-4.5 scripts in the same run:

| scenario | total p95 | pre-4.5 p95 | marginal p95 | budget as written | substituted |
|---|---|---|---|---|---|
| miss | 510.9 ms | 508.9 ms | **+1.9 ms** | ≤ 100 ms — **not met** | 0/60 |
| hit, 64 KiB | 612.0 ms | 548.9 ms | **+63.1 ms** | ≤ 300 ms — **not met** | 60/60 |
| hit, 1 MiB (ceiling) | 671.7 ms | 604.3 ms | **+67.5 ms** | ≤ 300 ms — **not met** | 60/60 |

(The earlier 731/854/980 ms totals were taken under concurrent load; these are from a quiet
machine, and the conclusion is unchanged at either set.) What substitution adds is +1.9 ms on the
unconditional miss path and ~+65 ms on a hit (the `wc` size gate priced in); the totals are the
hook's pre-existing three `jq` invocations (median 278.7 / p95 439.5 ms isolated, spawn floor
median 36.9 / p95 83.9 ms). **The 100 ms miss bound is structurally unreachable on this platform by
any implementation.** Escalated to the PRD owner as an open sprint action item with candidate
shapes; the structural halves — no Node, index-only lookup, exactly `grep` + `wc` + `sha256sum`
with the hash strictly after both gates, 0 hashes on any miss — are met and pinned by test.

**Ruled 2026-08-03 (ShuromiU): B-4a re-based end-to-end with the structural clause primary** (PRD §10,
third dated amendment). New ceiling: miss ≤ 600 ms / hit ≤ 800 ms p95 through the installed hook on
a quiescent reference platform — every row of the table above passes with 15–19% headroom (510.9 vs
600; 612.0 and 671.7 vs 800). The structural clause is the normative, CI-pinned half; the
wall-clock figure is re-measured per hook change rather than CI-gated. **AC #5 is now met in full**,
and the story closes.

**A design decision reversed by measurement.** The obvious optimisation — let bash read the index and
match it with builtins, spawning nothing at all — is a trap: **4 ms at 1k records but 599 ms at
50k**, against `grep -F`'s scale-independent 50–59 ms. Fast on this machine today (72 records), a
600 ms tax on every `Read` for a user with a large repository. `grep` it is; the builtin scan is used
only for the turn marker, which is bounded by reads-per-turn.

**Also corrected: B-4a's own premise.** The amendment reasons from "`sha256sum` on a 57 KB payload
costs ~54 ms". Re-measured: `sha256sum` of *nothing* costs 55 ms, of 512 KiB 57 ms, of 2 MiB 62 ms.
That 54 ms is the **spawn**; hashing is 2–7 ms. `CORTEX_SUBST_MAX_BYTES` therefore ships because the
amendment requires a ceiling and a slower platform is possible — not because it buys the budget, and
the story says so rather than letting the ceiling take credit it has not earned.

**AC #6 / AC #7.** Substitution is off until `cortex substitution on`; `inject-header` does not enable
it (pinned by test). The enable flag is a marker file because `.cortex.state` is read with `grep`, so
a second key would cost a process on every `Edit`, `Write`, `Bash` and `Agent` call. `PreToolUse`
emits no `permissionDecision` anywhere in the shipped templates.

**The inherited obligation is discharged.** `src/query/stats.ts`'s `BINDS STORY 4.5` comment is gone
and the `Saved: 0` explanation now states only what the reported scope can observe — available but
not enabled here, or enabled with nothing recorded yet — never the global "is not shipped" claim that
became false the moment any scope booked a saving. A test asserts no branch can say it again.

**Three existing structural tests were narrowed rather than relaxed or deleted**, because each
encodes a real invariant that this story genuinely changed:
- *"the hook computes no digest itself"* — still true of the **capture** path. Now pinned as: exactly
  one hashing invocation, and it sits strictly **after** the index lookup, so a miss never pays for it.
- *"no shipped hook writes the index"* — the hot path must now **read** it (AD-3). Narrowed to
  exactly one reference, matching the lookup form, with both redirect shapes still banned.
- *"one jq per event branch"* — updated for the new `Read` branch, `xargs` banned outright rather
  than lost when the counter narrowed, and joined by a new assertion that the substitution path forks
  at most twice (`grep`, `sha256sum`) and contains no `jq`/`cut`/`wc`/`stat`/`awk`/`sed`/`tr`.

**Mutation campaign: 23 mutations, 22 killed, 1 measured-equivalent.** Every mutation was proven to
have landed before its suite ran, and every file restored byte-identically (sha256 compared). Source
and hooks only, never `dist/`. Two rounds of results were *findings about the tests*, which is the
point of running it:

- **M11 survived** — the prefix test was written backwards. Reading `mod.tsx` with a `mod.ts` record
  present passes with or without the needle's trailing delimiter, because `…\tsrc/mod.tsx` is not a
  prefix of `…\tsrc/mod.ts\t`. The discriminating case is the reverse: read `mod.ts` with a `mod.tsx`
  record earlier in the file, where a needle missing its delimiter matches the wrong line and `-m1`
  stops there. Fixture corrected; the mutant now dies.
- **M13 survived** — and taught the sharper lesson. Removing the oversize guard still produces a
  *miss*, because the digest comparison rejects `-` anyway; the guard's real value is **not spawning
  `sha256sum`** on a record that can never verify. A verdict-only assertion is structurally blind to
  that. Fixed with a `sha256sum` shim earlier on `PATH` that counts invocations — which also turns
  B-4a's miss-path claim into a behavioural assertion (0 hashes on a miss, 0 on an oversize record,
  exactly 1 on a verified hit) instead of a source inspection. Note the shim has to prepend `PATH`
  *inside* the shell: `Git/bin/bash.exe` rebuilds a POSIX `PATH` before handing over, so an inherited
  entry lands after `/usr/bin` and the real binary wins — measured, the first version read 0 hashes
  on a hit.
- **M6 and M17 reported "anchor not found"** — campaign bugs, not survivors, and reported as such
  rather than counted as kills. Both anchors spanned lines using `\n` while both files are **CRLF**.
  Re-run with correct anchors: M17 killed.
- **M6 is a genuine equivalent mutant.** Swapping the turn-marker's check and append changes nothing:
  `$seen` is computed by the loop *above* both lines, so the only difference is whether a duplicate
  line is written. Replaced by two mutations that actually exercise AC #4 — restoring the shipped
  ordering bug (full-read gate before the marker) and deleting the append — **both killed**.

**A third source file carried a raw NUL, and the repo's recorded enumeration said there were two.**
Found by this story's mandatory byte-scan: `src/capture/spool.ts`, in `creditRowId`'s join separator
— on the capture path this epic works in. All four occurrences across the three files
(`spool.ts`, `reference-validation.ts`, `hook-entry.ts`) were the same shape, a composite-key
separator, and are now the six-character escape — **identical at runtime**, so credit ids and cache
keys are unchanged. This closes a follow-up Story 2.7 recorded and left owner-less, and it removes
the cause of the `findDbPath` miss that CLAUDE.md cites as the reason symbol tools are mandatory
here. A test now walks `src/`, `hooks/` and `tests/` and fails on any control byte but tab, LF and
CR, so the enumeration stops being hand-maintained — **and it earned its place immediately by
catching a literal NUL that a tool edit had collapsed into the comment explaining the rule.** Scope
added deliberately and flagged as added: the story's own trap list mandates escapes for every touched
file, `spool.ts` is touched, and the marginal cost of the other two was four characters.

**Verification.** `npm run build` ✓, `npm run lint` ✓, `npx vitest run` **1426 passed / 1 skipped**
(43 files, +58 tests), `npm run gate` **9 suites ok, untouched** (no baseline regenerated).
`cortex install` re-run — required, the hook content changed — with `cortex doctor` **red on hook
currency before** (naming both changed scripts) and **16/16 after** (1 pre-existing legacy-store
warning). `.gitignore` gained `.cortex.substitution` and `.cortex.turn-reads` via `install`.

**Left off deliberately.** Substitution is switched **off** in this checkout after the live proof: a
review subagent that receives a substituted payload and does not re-read would review content it does
not have. It is enabled deliberately during the Epic 4 rollout, not left on mid-review.

**Review-round addendum (2026-08-03).** The three-layer review found 5 HIGH findings — every one
reproduced by its reviewer — and the reconciliation above records all 26 with their dispositions.
The headline changes it forced: **flush-window refund eligibility** (a `refund_eligible` column
certified by the flush's batch pre-pass, projected into the index as a filter, required by the
ledger's offers — closing the reproduced case where a file changed between read and flush was
substituted as "byte-identical to your context"); **primary-only in both directions** (a subagent
requester is never substituted); **append-then-count turn claims** (at most one substitution per
file per turn under any interleaving, and an unwritable marker means no substitution at all);
a **`wc -c` size gate** before the hash; the **real path** in the payload and the credit;
**doctor's `substitution` row** and the **D8 `permissionDecision` pin** (both of which the first
round had claimed and not shipped); and the **F5 retraction** with AC #5's latency half escalated
to the PRD owner. Fix-round verification: full suite green (**1463 tests**, +37 from the fix
round), gate 9/9 untouched, `cortex install` re-run, doctor **17/17** including the new row, and
B-4a re-measured per the corrected scoping.

**Fix-round mutation campaign: 17 mutations — 16 killed, 1 designed-equivalent.** Each proven
applied and restored byte-identically (sha256-compared), across the hook, the eligibility pre-pass,
the index filter, the ledger gate, the CLI and stats. Two first-pass survivors, both resolved
rather than waved through:
- **R2** (append guard → `|| true`) survived because the count gate subsumes it in every case the
  suite staged — the marker-as-directory case misses either way. The probe that separated them: a
  **read-only marker already listing the file**, where the append fails but a count-only gate reads
  the pre-existing line as its own and substitutes the turn's *second* read. That test now exists
  (chmod-staged, cross-platform), and **R2 re-run: killed**.
- **R9** (jq control-guard deleted) is the **designed** survivor: the bash `*[[:cntrl:]]*` belt
  catches everything the jq half would have, which is precisely what the in-code comment predicts
  ("the redundancy is deliberate … a mutation of either alone is expected to survive" — the
  `toScopeRelativeKey` double-guard precedent). Accepted as equivalent by design, not by fatigue.

### File List

- `src/capture/substitution.ts` — **new**: the cold-path/hot-path contract — flag + turn-marker
  filenames and paths, `HOT_PATH_STATE_KEYS`, size bounds and their env resolvers,
  `isSubstitutionEnabled` / `setSubstitutionEnabled` / `renderHotPathStateLines`
- `hooks/claude/cortex-capture.sh` — modified: `Read` split into its own branch (one jq, six
  CR-stripped fields, scalar-tolerant `.file?`, `explode`-based control guard), `json_escape` +
  `try_substitute` (requester gate, state bridge, builtin key derivation, append-then-count turn
  claim, scope-anchored `grep -F -m1`, `wc -c` size gate, `sha256sum` verify, net-positive credit
  gate, result-mirroring payload with the requested absolute path, AD-15 credit line)
- `hooks/claude/cortex-end-of-turn.sh` — modified: clears `.cortex.turn-reads` at Stop
- `src/db/schema.ts` — modified (review round): `refund_eligible` column in the DDL +
  `ensureContentDigestColumns` (additive, AD-11)
- `src/db/store.ts` — modified (review round): eligibility through `ContentDigestRow` /
  `ParsedContentDigest` / `UpsertContentDigestOpts` and the upsert SQL
- `src/capture/spool.ts` — modified: `SpoolEntry.subst` + `isSubstitutedRead`; review round —
  `computeReadEligibility` (batch pre-pass), `peekLiveSpool`, `SpoolFlushOptions.conservativeEligibility`,
  eligibility wired through `processClaimFile`/`replayEntry`; raw NUL separator → escape
- `src/capture/hooks.ts` — modified: `ReadArgs.substituted` + `ReadArgs.refundEligible`;
  `bookUnrealizedIfOffered` consumes without booking when substituted
- `src/capture/digest-index.ts` — modified (review round): `collectIndexRecords` publishes only
  `refund_eligible = 1` rows, with the writer-enforces-what-the-reader-cannot-see rationale
- `src/query/read-ledger.ts` — modified (review round): `refundEligible` requires the record's own
  eligibility; raw NUL regex → escape (pre-existing, dev round)
- `src/query/doctor.ts` — modified (review round): the `substitution` check (off = pass with
  pointer, on-with-facts = pass, on-but-inert = warn)
- `src/query/stats.ts` — modified: `StatsReport.substitution` + `StatsReportOptions`, the re-keyed
  no-savings explanation; review round — three-way branch with `unknown` distinct
- `src/query/install.ts` — modified: two `IGNORE_ENTRIES`
- `src/transports/cli.ts` — modified: `inject-header` publishes the hot-path state, clears a stale
  turn marker, conservative leftover flushes; `substitution` command (git-toplevel arming,
  effective-env status, inert-state warning); `stats` passes `projectRoot`
- `src/transports/hook-entry.ts` — modified: raw NUL separator → escape (dev round)
- `src/query/reference-validation.ts` — modified: two raw NUL separators → escapes (dev round)
- `src/index.ts` — modified: re-exports for the new module, `StatsReportOptions`, env resolvers
- `tests/substitution.test.ts` — **new**: 27 tests — module contract, CLI (incl. git-toplevel
  arming + effective-env status + inert warning), the AC #7 `permissionDecision` pin, and the
  repo-wide control-byte guard (now covering DEL)
- `tests/substitution-hook.test.ts` — **new**: 45 tests through the real hook — the original
  verification/passthrough/AC #4/needle-agreement suites, the `sha256sum` PATH shim (hash-count
  assertions), the review-round guard suite (subagent requester, marker failure, 6-way concurrency
  race, size mismatch, `%` fidelity, absolute `filePath`, scalar `tool_response` capture, zero
  credit, huge sizes), and the cold+hot eligibility end-to-end
- `tests/token-ledger.test.ts` — modified: 4 substituted-read accounting tests + 13 flush-window
  eligibility tests (edit/cmd/path-scope/order/same-second/live-peek/conservative/no-ts/reopen)
- `tests/capture-hook.test.ts` — modified: branch structure, `xargs` ban, process-budget test
  (now grep + wc + sha256sum, ordered)
- `tests/cli.test.ts` — modified: state-bridge tests + the stale-turn-marker clear
- `tests/install.test.ts` — modified: ignore-list literals + a drift test
- `tests/stats.test.ts` — modified: 5 tests for the re-keyed explanation incl. the `unknown` state
- `tests/doctor.test.ts` — modified (review round): 4 substitution-row tests + check inventory
- `README.md` — modified: `## Refunding a redundant read`, corrected by the review round
  (eligibility narrowing, primary-only, the host-acknowledgement limit)
- `CLAUDE.md` — modified: the FR-6 invariant bullets (rewritten by the review round), Core Files
  entries, intro paragraph, FR-8/FR-9 bullets, the corrected B-4a table, the NUL-hazard corrections
- `_bmad-output/project-context.md` — modified: the Dormant Surface paragraph
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified: epic-4 in-progress, 4-5
  lifecycle, stats action item closed, the B-4a ruling action item (open)
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified: dev-round items (one later
  superseded in place), review-round items, the 2.7 NUL item closed
- `.gitignore` — modified **by `cortex install`**, not by hand (two runtime artifacts)
