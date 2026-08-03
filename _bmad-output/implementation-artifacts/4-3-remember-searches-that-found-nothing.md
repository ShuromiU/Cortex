---
baseline_commit: 4ae5ac84813fbe5ed03ad223523a171e3b961c3f
---

# Story 4.3: Remember searches that found nothing

**Epic:** 4 — Content Cache
**FR:** FR-12 (negative-result capture) + FR-13 (negative-result query)
**Status:** review

As an agent about to repeat a fruitless search,
I want to be told it already returned nothing,
So that I stop paying full price for zero results.

## Acceptance Criteria (verbatim from epics.md:826-852)

**Given** a search returns zero results
**When** it is captured
**Then** the record carries the query, the search root, the tool used, the `head_oid`, and the `scope_key`.

**Given** a recorded negative result whose search root is provably unchanged since capture, including uncommitted working-tree changes
**When** it is queried
**Then** it returns `no-matches-at <head>` in 25 tokens or fewer.

**Given** any file under the search root has changed since capture
**When** the negative result is queried
**Then** it is invalidated and returns a miss.

**Given** change status cannot be established
**When** the negative result is queried
**Then** it returns `unknown` — never a false negative (AD-6).

**Given** a negative result recorded in one scope
**When** queried from another scope
**Then** it is never asserted across the boundary.

## AC assessment — flags the dev agent must hold the whole time

### F1 — The capture channel does not exist yet, and widening it prices every Grep call

The installed PostToolUse hook has **no Grep branch** and the matcher excludes Grep
(`REQUIRED_WIRING` in `src/query/doctor.ts:169`: `Read|Edit|Write|Bash|Agent` — verified by read).
Capturing zero-result searches means (a) adding `Grep` to that matcher — one shared constant, since
`install` writes what `doctor` checks — and (b) adding a `Grep)` branch to
`hooks/claude/cortex-capture.sh` (case dispatch at lines 280/332/338/349, `esac` at 359). Two
consequences to hold:

- **Every Grep call now pays the hook's platform floor** (~spawn + jq, the B-4 cost class, ~300–500
  ms on this machine). Measured usage: 1133 Grep calls over 30 days here ≈ 38/day ≈ ~19 s/day of
  added wall clock. Judged acceptable at create-story (the three-jq→one-jq merge in deferred-work
  offsets it for every branch when it lands), but the dev round must **measure the Grep branch's
  marginal against the existing Edit|Write branch** and report it — the B-4 structural clause
  (pure-bash append, no Node, no SQLite) binds this branch exactly as it binds the others.
- **The matcher edit ripples**: `REQUIRED_WIRING` (doctor + install share it), the installed
  settings (install's *repair* path rewrites a matcher that lost a tool — verify it fires for a
  matcher that never had `Grep`), the hook-currency digest (template change → `cortex install`
  re-run at rollout), and `tests/capture-hook.test.ts`'s branch-list structural test
  (`['  Read)','  Edit|Write)','  Bash)','  Agent)']` — grows a `'  Grep)'` entry; the test splits
  on `/\r?\n/` because this template ships CRLF).

### F2 — The Grep PostToolUse payload shape is UNKNOWN until probed — first dev task, not an assumption

Nothing in this repository has ever seen a Grep hook payload: the matcher excludes it, so no spool
line, no probe artifact, no test fixture exists. Story 4.5 proved the docs cannot be trusted for
payload shapes (the documented `updatedToolOutput` shape is accepted and silently ignored; the real
shape was found by probing the installed hook). **Task 1 is a live probe**: temporarily widen the
matcher in a scratch project (never this checkout's settings), run real Grep calls — zero-result and
with-results, all output modes, with `glob`/`type`/`-i`/`multiline`/`head_limit`/`offset` — and
record the exact `tool_input` and `tool_response` JSON in the scratchpad before designing the jq.
The load-bearing unknowns: how "zero results" manifests per output mode (empty content? a "No
matches found" string? a count field?), and whether `tool_response` can be a scalar (the 4.5 lesson:
`.tool_response.file?` — the `?` prevented a capture-loss regression; the Grep branch must not
abort the shared jq program on any shape). **If zero-ness cannot be proven from the payload for a
given shape, that shape is not captured** — AD-6 applies at capture, not just at query.

### F3 — "Provably unchanged, including uncommitted changes" is the story's central design problem, and D4 resolves it with a bounded census, not git

Three constraints triangulate: B-3 (query ≤ 20 ms p95 in-process on a 10,000-item store — read-ledger
precedent: the CLI can never meet it, the MCP path is what counts), AD-6 (re-hash, **never mtime**,
ambiguity → miss/unknown), and N-4/B-3 economics (a `git status` spawn at query time costs more than
the entire budget — this machine's spawn floor alone is ~40–84 ms). `git status` is also
mtime-based under the hood (the index stat cache), so it fails AD-6 twice. The resolution (D4): a
**census** — a deterministic fingerprint of the search root's working-tree bytes, recorded at flush,
re-derived at query, compared. Byte-identical tree ⇒ the search provably still returns zero;
dirty-vs-clean is irrelevant because the census reads the same working tree the search read. The
honest consequence, stated up front: **roots whose census exceeds the ceilings (repo root with
`node_modules`, any huge tree) are never captured and therefore never asserted** — the cache's value
concentrates on scoped searches (`src/`, a package dir), and that is the correct AD-6 trade, not a
defect to engineer around.

### F4 — head_oid is metadata for the verdict, NOT evidence for the assertion — and it cannot be read in the hook

`head_oid` appears in AC #1 (the record carries it) and AC #2 (the verdict renders it). It is
**recorded at flush** via the existing cold-path `detectGitScope` (`src/scope/git.ts:75`,
`runGit(['rev-parse','HEAD'])` — N-4 forbids the hook spawning git). It is **never compared at
query**: the census is the evidence, and a head that moved over a byte-identical root (rebase,
amend, tag churn) does not change what the search would return. Comparing head would add a spawn or
a `.git` file-parse for a check that can only produce false misses. The verdict renders the
*recorded* short oid — accurate as stated, because the census just proved the tree is byte-identical
to the one recorded at that head. Flush-time recording inherits Story 3.1's flush-window
imprecision, which is why certification (F5) exists.

### F5 — A search's record is valid only if nothing after it in the batch could have changed the root — the 4.5 eligibility pre-pass, generalized, and here it gates RECORDING, not a flag

The census is computed at **flush time**, a whole turn after the search ran. If an edit under the
root (or any command) landed between the search and the flush, the census describes a tree the
search never saw — and a later query over that unchanged post-edit tree would assert "no matches"
for content the search never examined: **SM-C3, the release-blocker false negative, reachable in
two ordinary tool calls.** Story 4.5's `computeReadEligibility` (`src/capture/spool.ts:252-282`) is
the machinery: certify a search only when, after it in its batch, there is **no `cmd` at all**
(commands rewrite files invisibly — classifying them is Story 4.4's problem), **no `edit`/`write`
under the search root** (scope-relative prefix compare via the same `normalizeFilePathKey`
discipline; an edit *outside* the root is irrelevant and must not disqualify, or search-then-edit
turns would kill every record), no same-second neighbour (hook stamps are whole-second; `>=`,
ambiguity is a miss), no missing timestamp, nothing in the live-spool peek, and never on
`inject-header`'s conservative leftover flushes. Unlike 4.5's `refund_eligible` flag, a
disqualified search is **not recorded at all** — there is no other consumer of an uncertifiable
negative, and a row that can never assert is dead weight.

### F6 — The pattern is author-supplied hostile input on a rendered surface, and it may contain secrets

The query text reaches storage and a rendered verdict. Two standing disciplines both apply, and
both have repo precedent for being skipped once and paid for: **redaction** (PRD §11.1: "negative-
result queries all pass through it" — `redactSensitiveText` from `src/capture/redact.ts` before
storage, because people grep for tokens and keys), and **stored-strings** (collapse whitespace,
strip control characters via escaped classes — never literal bytes, the guard test in
`tests/substitution.test.ts` walks `src/` and fails on any raw control byte — cap length, truncate
without splitting surrogate pairs; a newline in a pattern forges a verdict line, a CR overwrites
the previous line). The ≤ 25-token budget (AC #2) is per query line and must be asserted against
hostile 200-character patterns, not convenient fixtures — the 3.3 lesson, where every combination
hard-coded a 15-character name and the budget breached at 200.

### F7 — Path resolution is this repo's most-repeated trap class, and this story crosses it four times

`toScopeRelativeKey` and `normalizeFilePathKey` live in `src/scope/keys.ts:69/48` (grep, confirmed).
The rules, each paid for once already: **a stored relative key is never re-resolved** —
`path.resolve` anchors to `process.cwd()`, which is whatever directory the flush, CLI, or MCP
server happens to run in (Story 3.2 measured it silently relocating every key it touched); **a
scope whose root cannot be resolved is dropped, not defaulted** (the FR-7 lesson —
`resolveOnDiskPath`'s fallback anchored stored keys to cwd). Applied here: (1) the search root is
stored scope-relative via `toScopeRelativeKey` against the *entry's resolved scope*; a root that
cannot be relativized (outside the scope root, or the scope root is null) → **no capture**; (2) the
census walk needs the on-disk absolute root — recovered by joining the scope root, and a scope
whose root cannot be resolved at query time → **`unknown`**, never a cwd-anchored walk; (3) the
under-root containment compare in D5 runs on `normalizeFilePathKey`-normalized scope-relative
paths on both sides — comparing a raw `events.target` to a normalized key never matches and fails
silently (the 3.3 `sessionEditedPathAfter` lesson); (4) the CLI resolves a relative `--path`
against cwd *before* the core call, because that is what a person typing means — the core stays
deterministic.

### F8 — Scope boundary (AC #5) is one WHERE clause to write and one two-scope fixture to prove

Negatives are **scope facts, not context facts** — unlike 4.5's substitution there is no "already
in your context" claim, so there is no session gating, no AD-16 ancestry, no requester gate: any
session in the scope may be told the scope's tree provably still contains no matches. The record
carries no `session_id` at all (AC #1's field list is exhaustive; omitting it also side-steps the
`content_digests.session_id ON DELETE CASCADE` concern already parked with Story 4.6). The
cross-scope test must seed records under two real scope keys and query from each — a one-scope
fixture cannot see a missing WHERE clause (the session-blind GROUP BY lesson from 3.6).

## What is actually here — run before designing

Facts verified during story creation by reading the file or by measurement; symbol facts name the
tool that produced them.

- `SCHEMA_VERSION = 6` (`src/db/schema.ts:35`, read). **CLAUDE.md's FR-21/22 bullet still says 5 —
  stale; this story's docs pass corrects it in passing.** New tables append to `V5_TABLES`
  (`schema.ts:363`) and **do not touch the version** — the project-context rule calls a bump "the
  single worst available mistake here." `content_digests` (`schema.ts:424-437`) is the model DDL:
  heavily commented, `WITHOUT ROWID`, stated key as PRIMARY KEY, no inline `--` comments *inside*
  the CREATE TABLE parens that would break future ALTERs (the token_ledger lesson — comments sit
  above the statement).
- PostToolUse matcher: `'Read|Edit|Write|Bash|Agent'` (`src/query/doctor.ts:169`, read; shared with
  install via `REQUIRED_WIRING`). Doctor's matcher check is `warn`, not `fail`.
- Hook dispatch: `case` branches `Read)` at `hooks/claude/cortex-capture.sh:280`, `Edit|Write)` 332,
  `Bash)` 338, `Agent)` 349, `esac` 359 (grep -n). The template ships **CRLF**; every multi-line jq
  read strips `${v%$'\r'}` per field; `escapeIndexField` percent-escaping exists for
  tab/CR/newline; the jq `safe` filter uses `explode` codepoint arithmetic, never a u-escaped regex
  class (Oniguruma reads those as literal characters — measured in 4.5).
- Spool machinery (`get_symbols_overview` on `src/capture/spool.ts`): `appendSpoolEntry`,
  `computeReadEligibility`, `flushSpool` (with `SpoolFlushOptions{conservativeEligibility, deps}`),
  `peekLiveSpool` + `LiveSpoolDisqualifiers`, `processClaimFile`, `replayEntry`, `parseSpoolLines`,
  `isReplayable`. `computeReadEligibility` body read (`find_symbol`): MAX_TS sentinel `'￿'`,
  latest-cmd + per-path latest-edit maps, `>=` same-second disqualification, `conservative` short-
  circuit. The generalization for searches slots beside it rather than into it — reads are per-path,
  searches are tree-scoped.
- Cold-path head: `detectGitScope` (`src/scope/git.ts:75`, read) already runs
  `runGit(['rev-parse','HEAD'])` and returns `headOid`; sessions/snapshots/file_renames already
  store `head_oid` columns (grep). The flush resolves scope per entry (`resolveEntrySession`).
- Query template: `src/query/read-ledger.ts` (`get_symbols_overview`): `queryReadLedger`,
  `renderReadLedgerLine`, `collapse`, `fitPathLeft`, `sanitizeAgentLabel`, `READ_LEDGER_MAX_PATHS`,
  `READ_LEDGER_TOKENS_PER_FILE`, per-file token budget, path truncated from the left, verdict never
  cut. Its B-3 perf fixture asserts the expensive path actually RAN during measurement — replicate
  that.
- Redaction: `src/capture/redact.ts` — `redactSensitiveText` (AWS/GitLab/Slack/GitHub/sk- token
  patterns), `redactCommand`, `captureOutputTail`, `classifyCommand`, `extractTouchedFiles` (grep
  + read of the pattern block). Re-exported from `src/index.ts:11`.
- GC pattern: `pruneContentDigests` (`src/db/gc.ts:268`), `CORTEX_GC_DIGEST_DAYS` via `envDays`
  with the `normalizeDays` guard (`gc.ts:92-97`) — `Number`-parsed, `1e9` disables. Dry-run by
  default repo-wide.
- MCP registration pattern: `cortex_read_ledger` in `src/transports/mcp.ts` at lines 137 (route
  text), 367 (tool schema), 408 (list), 684 (dispatch case) — grep on the literal; tool names are
  dispatched by string literal, so any restructuring here needs `certify_refs` with a `symbols`
  anchor, not grep alone.
- Spine mapping: FR-12/13 → `cache/negative.ts` under AD-4 + AD-6 (ARCHITECTURE-SPINE.md:283). The
  shipped tree has no `cache/` layer and AD-1 says new modules join an existing layer; Epic 3
  settled the split as capture in `src/capture/`, query in `src/query/` — this story follows the
  settled pattern (D6), noting the spine divergence here rather than silently.
- AD-4 (spine:58-65): negative results **do not project** into `memory_items` — "queried by key,
  never ranked" — so no retrieval kind, no AD-5 fixture obligation, no backfill. AD-3 lists FR-12
  in its binds: that is for a *future* hot-path consumer; **this story's ACs have no hook-side
  lookup and the six-column index format is not extended.**
- B-3 (PRD §10): "Read-ledger, negative-result, and tool-output queries: ≤ 20 ms at p95" on a
  10,000-item database, in-process. SM-C3: a false `no matches` is a **release blocker**. N-9:
  certainty derived deterministically. FR-16 assigns eviction to `cortex gc` ("negative results
  older than a configurable horizon") — 4.6 owns bounds generally, but 3.1 shipped a table with no
  GC rule and earned an action item; this story ships its own horizon rule (D8).
- `tests/posix-tools.ts` resolves bash/jq absolutely (win32 `system32\bash.exe` is the WSL
  launcher); the capture-hook harness, `installHashShim`, probe methodology, and the mutation-
  campaign checklist (mutate `src/` never `dist/`, prove application, restore byte-identically,
  EOL-adaptive anchors) all exist from 4.5.

## Design

### D1 — `negative_results`: appended to `V5_TABLES`, no version bump, no projection

```sql
CREATE TABLE IF NOT EXISTS negative_results (
  scope_key   TEXT NOT NULL,
  query_key   TEXT NOT NULL,   -- sha256-16 of the canonical query (D2)
  tool        TEXT NOT NULL,   -- 'grep' (the capture channel; field future-proofs per AC #1)
  pattern     TEXT NOT NULL,   -- redacted + collapsed + capped (F6)
  root        TEXT NOT NULL,   -- scope-root-relative, forward-slashed; '' = scope root
  params_json TEXT,            -- canonical matching-relevant params (D2), for rendering/debug
  head_oid    TEXT,            -- recorded at flush (F4); metadata, never compared
  census_sha256 TEXT NOT NULL, -- D4; a record without a census is not stored
  census_files  INTEGER NOT NULL,
  census_bytes  INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, query_key)
) WITHOUT ROWID;
```

Upserted — a re-search that still finds nothing refreshes the census and `recorded_at`; last
certified wins. No `session_id` (F8). No `memory_items` projection (AD-4), no backfill, no new
retrieval kind. Four coordinated edits per AD-11: DDL appended to `V5_TABLES`, wired index if any
(none needed — the PK is the access path), store methods, `SCHEMA_VERSION` untouched.

### D2 — The canonical query key: every matching-relevant parameter, or no capture

`query_key = sha256-16(canonical)` where canonical is a stable serialization of: tool, pattern
(**raw**, pre-redaction — redaction is for *storage/rendering*; keying on redacted text would merge
distinct searches), root (scope-relative), and the matching-relevant params: `glob`, `type`, `-i`,
`multiline`. Parameters that only shape output (`output_mode`, `head_limit`, `-n`, `-A/-B/-C`,
counts) are **excluded** — zero results in any output mode is zero matches for the (pattern,
filters) pair. Two hard rules:

- **`offset > 0` (or any pagination that can hide matches) → not captured.** A page past the end
  shows zero while matches exist — recording it would be a false negative at capture time.
- **An unrecognized matching-relevant parameter → not captured.** A param this code does not
  understand may narrow or widen matching; AD-6 forbids the guess. The recognized set is a
  constant the probe (Task 1) validates against the real payload.

The stored `pattern` is redacted + stored-strings-disciplined (F6); `params_json` stores the
canonical params for rendering. The raw pattern **never** persists when redaction changed it — the
key hash is computed before redaction and is one-way, which keeps distinct secret-bearing searches
distinct without storing the secret.

### D3 — Capture: a `Grep)` branch that appends one spool line, shaped by the probe

The branch mirrors `Read)`'s discipline: one jq invocation, `safe`-filtered fields, CR-stripped
multi-line reads, `2>/dev/null` redirection order, no new spawns beyond the shared jq, and —
critically — **capture-preserving on every payload shape** (a scalar or missing `tool_response`
must not abort the program; six shapes reproduced in 4.5). The spool line:
`{v:1, ts, tool:"search", stool:"grep", pattern, root, params:{...}, zero:1}` plus the
`AGENT_FIELDS` the template already threads (agent identity attributes the *event* even though the
record stores no session — the event stream still files under the right child session). Only
provably-zero results emit `zero:1`; anything ambiguous emits a plain event line (or nothing — the
probe decides whether a non-zero search event is worth capturing at all this story; default **no**,
smallest change that satisfies the ACs). `isReplayable` gains `'search'`, `replayEntry` dispatches
it to a new `recordNegativeResult` in `src/capture/hooks.ts` — the `recordReadDigest` analog, same
layer, same defensive-silent edge discipline — which certifies (D5), resolves the root (F7),
computes the census (D4), redacts (F6), and upserts.

### D4 — The census: a bounded, deterministic working-tree fingerprint

**Capture side (flush, cold path):** walk the search root (lstat, no symlink-follow; symlinks
contribute `(relpath, 'link:'+target)`; directories recurse; other types disqualify the census),
excluding exactly `.git` and the Cortex runtime artifacts (`IGNORE_ENTRIES` basenames — Cortex must
not observe its own exhaust: the spool grows on every tool call and would invalidate every census
instantly; these files are gitignored in every swept repo, so the search never saw them either).
Sort entries by raw forward-slashed relpath (byte order, **no case folding** — the census compares
the tree to itself over time; folding would merge distinct files on Linux). Hash
sha256 over the concatenation of `(relpath, byte_size, file_sha256)` tuples with `'\u0000'`
separators (escape sequence in source — the control-byte guard test bans literal bytes, not runtime
strings). Ceilings: `CORTEX_NEGATIVE_MAX_FILES` and `CORTEX_NEGATIVE_MAX_BYTES` (both
`Number`-parsed with the `/^\d+$/` guard — `parseInt('2e6')` is 2, third repo lesson), defaults set
by measurement in the dev round (starting hypothesis: 2,000 files / 8 MiB — in-process sha256 runs
~1 GB/s so 8 MiB ≈ 8–10 ms, inside B-3 with room for the walk; **measure, don't assume**). Exceeded
→ **no record** (F5's dead-weight rule). Unreadable file mid-walk → no record.

**Query side:** re-derive the census with the same walk, same exclusions, same ceilings. Ladder:
- Census matches → **`no-matches-at <short-head>`** (assert; AC #2).
- Census differs, or the root is missing/not-a-directory, or the walk *proves* growth past the
  recorded `census_files`/`census_bytes` (growth is a change) → **miss** (AC #3).
- The walk cannot complete for any other reason — permission error, entry became unreadable, a
  file type the census cannot fingerprint → **`unknown`** (AC #4; never the convenient answer).

The two ceilings are checked against the *recorded* census figures first (`census_bytes` bounds the
hash work before any byte is read — the FR-7/4.5 "recorded size gates the work" lesson), then
enforced live during the walk.

**"Invalidated" is a verdict, never a row mutation.** The query answers miss and writes nothing —
the FR-21 read-only rule — and that is also more *correct*: a `git stash pop` that restores the
exact bytes makes the census match again, and the record honestly re-validates, which a
delete-on-miss would have destroyed for no gain.

### D5 — Certification: `computeSearchEligibility` beside, not inside, `computeReadEligibility`

Same batch-scan shape, different disqualifier set (F5): any later `cmd`; any later `edit`/`write`
whose `normalizeFilePathKey`-normalized path sits **under the search root** (prefix compare on the
scope-relative key; equal counts as under); `>=` same-second; missing `ts`; `conservative` mode;
plus the `LiveSpoolDisqualifiers` peek — which needs the edited-paths list it already carries, and
`anyCmd`. A disqualified search is skipped by `replayEntry`, not recorded-then-flagged. The
existing read eligibility is **not** touched — its per-path semantics are correct for reads and
pinned by 13 tests; a shared abstraction bought with a regression risk in 4.5's freshly-shipped
logic is a bad trade.

### D6 — Query surface: `src/query/search-ledger.ts`, MCP `cortex_search_ledger`, CLI `cortex search-ledger`

Module follows the read-ledger split (capture in `src/capture/`, query in `src/query/`; the spine's
`cache/negative.ts` predates the settled tree — noted, not followed). `querySearchLedger(store,
scope, queries, deps?)` takes the same query shape the capture keys on (pattern + root + params),
recomputes `query_key`, looks up by `(scope_key, query_key)` — the scope filter is the AC #5
boundary — and runs the D4 ladder. Rendering: one line per query, ≤ 25 tokens enforced per line
(`estimateTokens`, asserted at hostile widths), pattern collapsed/capped, root elided in the
middle, verdict never truncated. MCP tool `cortex_search_ledger` (schema, list entry, dispatch
case, route text — four literal-dispatch sites; restructuring them takes `certify_refs` with a
`symbols` anchor) and CLI `cortex search-ledger <pattern> [--path] [--glob] [--type] [-i]
[--multiline]`, resolving a relative `--path` against cwd before the core call and reporting the
path as asked (the 3.3 transport convention). Both surfaces read-only: no session, no touch, no
ledger row — the FR-21 rule. `cortex_route` gains the one-line capability entry.

### D7 — Offers and the P&L: negative queries book nothing this story

Story 3.5's `read_offer`/`unrealized` machinery is read-refund-specific (`offer:read`). A
`no-matches` assertion the agent reads and then re-runs anyway is a real adoption fact, but wiring
`offer:search` + evidence (`evidence_kind: 'search'`, result-count shape per FR-8) is accounting
surface this story's ACs do not name — **deliberately deferred to keep the change reviewable**, and
recorded in deferred-work at completion. What ships: the query surface only. (`assertCreditIsEvidenced`
already models the search evidence shape when 4.4/4.6-era work picks it up.)

### D8 — GC: `pruneNegativeResults`, `CORTEX_GC_NEGATIVE_DAYS`, default 30, dry-run

Keyed on `recorded_at` (refreshed by the upsert, so an actively re-confirmed negative survives);
follows `pruneContentDigests` structurally including the `1e9`-disables convention and the
dry-run-by-default rule. Shipped **in this story** (the 3.1 lesson: a table with no GC rule earns
an action item), reported in `cortex gc`'s output alongside digests. Story 4.6 inherits a rule, not
a gap.

### D9 — Doctor and install: the matcher is the only wiring change

`REQUIRED_WIRING`'s PostToolUse matcher becomes `Read|Edit|Write|Bash|Agent|Grep`. Install's repair
path must rewrite an installed matcher lacking `Grep` (test: a settings file with the old matcher
converges to the new one on a second run — and to `unchanged` on a third). Doctor's matcher check
stays `warn`. The hook template's currency digest changes; rollout re-runs `cortex install`. No new
hook script, no new event, no index format change.

### D10 — What is deliberately NOT in this story

No hot-path lookup of negatives (AD-3's FR-12 binding is future capacity; the ACs name none). No
Bash-mediated search capture (`rg` inside Bash is Story 4.4's command territory; parsing arbitrary
shell is AD-6-unfriendly). No Glob capture (cheap locally; add later if the probe shows it free).
No `memory_items` projection, no eval-suite obligation (AD-4/AD-5). No stats surface (FR-16's
cache-size line is 4.6). No session attribution on the record (F8). **No subsumption reasoning**:
a zero at `src` logically implies a zero at `src/utils`, but the lookup is exact-key only — subtree
implication multiplies the census-validity surface for a marginal hit-rate gain and is exactly the
kind of cleverness AD-6 exists to resist.

## Tasks

- [x] 1 — Probe the Grep hook payload *(completed by deviation — see Dev Agent Record: the headless CLI could not authenticate (401, expired token; re-auth is interactive), the installed bundle is a V8 snapshot with no linear source, so the de-risking moved into the design: positive-marker shape guard + the literal-pattern certification gate, with the live probe promoted to a rollout gate and the scratch scaffold left ready)*
- [x] 2 — Schema + store
- [x] 3 — Hook branch + wiring
- [x] 4 — Flush (certification + census + head)
- [x] 5 — Query + surfaces (MCP, CLI, route)
- [x] 6 — Redaction + hostile input
- [x] 7 — GC rule
- [x] 8 — Mutation campaign (13/13 killed)
- [x] 9 — Docs + verification

### Original task text (for the record)

1. **Probe the Grep hook payload** (scratch project, temporary matcher, never this checkout's
   settings): all output modes × zero/nonzero × each matching param × scalar-response edge shapes.
   Record raw JSON to scratchpad; derive the zero-detection rule and the recognized-param constant;
   confirm `AGENT_FIELDS` threading. *Blocks everything else.*
2. **Schema + store**: DDL appended to `V5_TABLES` (comment discipline per `content_digests`),
   `upsertNegativeResult` / `getNegativeResult` / `pruneNegativeResults` with `XRow`/`ParsedX`
   pairs; reopen-durability test (the FR-4 "test against the refresh" class — assert through a
   fresh `ensureCortexSchema`).
3. **Hook branch + wiring**: `Grep)` branch per D3; matcher in `REQUIRED_WIRING`; install repair +
   idempotency tests; capture-hook structural tests updated (branch list, spawn budget unchanged
   for this branch — zero new spawns); capture-preservation tests across the probe's shapes through
   the **installed** hook (`cortex install` first — the standing rule).
4. **Flush**: `'search'` replay in `replayEntry`/`isReplayable`; `computeSearchEligibility` per D5
   with the full disqualifier matrix tested (explicit timestamps, never sleeps — the same-ms
   coin-flip lesson); census capture per D4 with ceilings measured and pinned; `head_oid` from the
   entry's resolved scope.
5. **Query + surfaces**: `querySearchLedger` + ladder per D4; renderer with the 25-token budget
   asserted hostile; MCP tool + CLI command + route line; cross-scope fixture (two scopes, both
   directions); B-3 perf fixture on a 10k-row store asserting the census ran during measurement.
6. **Redaction + hostile input**: pattern through `redactSensitiveText` before storage; stored-
   strings discipline on every rendered field; control-byte guard stays green (escapes only).
7. **GC rule** per D8 with dry-run/apply tests.
8. **Mutation campaign** on every new assertion (prove applied, restore byte-identical, mutate
   `src/` never `dist/`); byte-scan every touched file.
9. **Docs + verification**: CLAUDE.md (new bullets + fix the stale `SCHEMA_VERSION is 5` line),
   README (agent-facing: when to consult `cortex_search_ledger`), `cortex_route` text, deferred-work
   (D7 deferral), sprint-status; then `npm run build && npm run lint && npx vitest run`,
   `npm run gate` (retrieval untouched — expect 9/9 unchanged; the gate still runs because the
   render layer is shared), built `cortex doctor` 17/17, and the installed-hook end-to-end proof:
   real Grep zero-result → flush → record → `cortex search-ledger` asserts → edit under root →
   miss.

## Previous-story intelligence (4.5, review-hardened; execution-order predecessor — 4-1/4-2 were withdrawn, so the mechanical highest-number-below-3 rule finds nothing)

- **Probe before designing jq.** The documented shape lied for 4.5; the probe methodology (two
  payloads, same plumbing, one behavioral difference) is in the 4.5 story's D7/completion notes.
- **jq emits CRLF here; command substitution strips only the final CR** — every field from
  multi-line jq output takes `${v%$'\r'}`.
- **Oniguruma reads u-escaped classes as literals** — control-character filtering in jq is
  `explode | any(. < 32 or . == 127)`.
- **`2>/dev/null` before the redirection target**, or stderr leaks into the spool.
- **Heredocs eat backslashes** — write scripts with the Write tool, never inline heredocs.
- **Control characters in source are escape sequences, never literal bytes** — the guard test
  enforces it; it caught its own comment's NUL on arrival.
- **`Number` with `/^\d+$/`, never `parseInt`** — `parseInt('2e6')` is 2; third occurrence earns a
  named rule.
- **Same-second/same-ms tests use explicit timestamps** — read-then-edit fixtures are coin flips
  observed failing intermittently.
- **POSIX tools resolve through `tests/posix-tools.ts`** — bare `bash` is the WSL launcher on
  win32 and self-skips seven suites silently.
- **Mutation campaigns prove application and restore byte-identically**; EOL-adaptive anchors
  (this template is CRLF); a survivor is either a missing test or a documented designed-equivalent.
- **Verify through the installed hook** (`cortex install` first), and measure per-path against the
  budget as ruled — B-4a is now structural-clause-primary with end-to-end 600/800 ms p95 quiescent
  (ruled 2026-08-03); this story's Grep branch reports its marginal under the same protocol.

## Git intelligence

Last five commits: `4ae5ac8` (B-4a ruling closed — budget now structural-primary; this story's
perf reporting follows it), `e7ae876` (Story 4.5 — the spool/flush/eligibility machinery this story
generalizes; 32 files, the test harnesses this story reuses), `135d21e` (standing rule: epics roll
out machine-wide and must be USED — this story's matcher/hook changes join the Epic 4 rollout),
`bc19e92` (the 2026-08-02 budget ruling pattern), `b50e2bf` (FR-9 stats — read-only query surface
conventions this story's query follows).

## Project context reference

`_bmad-output/project-context.md` binds: ESM `.js` imports everywhere; `src/index.ts` exhaustive
re-exports (new store methods, query module, constants); sync store layer; scope_key on every
per-project table; token budgets on every surface; hook templates never hardcode paths; tests
hermetic with `os.tmpdir()`; lint does not typecheck `tests/`; conventional commits; docs in the
same commit; the four-command verification block plus the gate when retrieval is touched.

## Story completion status

Status: **done** (created, developed, reviewed and committed 2026-08-03 against `4ae5ac8`; landed as
`3a46d12`). Three-layer review reconciled in full before the commit; the live payload probe and the
two end-to-end proofs are recorded below.

## Dev Agent Record

### THE PROBE RAN — F2's unknown is resolved by measurement (review round)

**Superseded the deviation below.** ShuromiU's instruction — the proving has to happen now, not at a
rollout gate — forced a re-look, and the blocker turned out to be a failure of imagination rather
than of access: **this session IS a live Claude Code session with the hook installed and the Grep
matcher active**, so real searches were producing real payloads the whole time. The evidence was
already sitting in the checkout's own spool (a reviewer subagent's zero-result search, captured).

To read the *raw* shapes, the installed hook was patched to dump only its Grep-branch stdin, four
real searches were driven through it, and the hook was restored **byte-identically** (sha verified
both directions). Measured against Claude Code 2.1.170 — `tool_response` is always an OBJECT:

| mode | zero-result payload |
|---|---|
| `files_with_matches` | `{mode, filenames: [], numFiles: 0, totalFiles: 0}` |
| `content` | `{mode, numFiles: 0, filenames: [], content: "", numLines: 0, totalLines: 0}` |
| `count` | `{mode, numFiles: 0, filenames: [], content: "", numMatches: 0}` |
| hit (any) | `{mode, filenames: […], numFiles: n, totalFiles: n}` |

**What the measurement overturned, and it is not flattering:** there is no `"No matches found"`
string anywhere in the payload — that is the **rendered** text, not the data — and the array is
`filenames`, not `files`. **Three of the six markers this story shipped could never have fired**,
and a fourth (`files: []`) was fiction. Capture worked because exactly one guess (`numFiles == 0`)
happened to be right. The Blind Hunter's H2 was therefore correct in principle *and* understated in
practice. The string and array fallbacks are now **removed**, not kept as belt-and-braces: honouring
a display string as data is precisely the guess this round exists to retire.

Also measured, and both fed fixes: real `tool_input.path` arrives **Windows-form with backslashes**
and may name a **single file**; and a pathless search sends no `path` at all, which is what proved
the Auditor's A1 — the hook now records the payload `cwd` rather than letting the flush read `''`
as the whole worktree.

Replayed after the fixes: all three real zero shapes capture, the real hit payload is silent, and
six adversarial variants (self-contradicting fields, truncated page, content-with-lines, paginated,
unknown shape, scalar) are all refused. The rollout gate is **discharged**, not deferred.

### The original deviation record (superseded above, kept for the reasoning)

The planned live probe was blocked twice: the nested headless CLI answers **401 (expired OAuth,
interactive re-auth only)** — with and without a placeholder key through the session proxy — and
the installed Claude Code is a **PE bundle around a V8 snapshot** (2.1.165/170/178 in
`~/.local/share/claude/versions/`), where "No matches found" exists only as an interned constant
with no linear source around it. A docs/changelog research pass (claude-code-guide agent) found:
the PostToolUse **envelope** is documented and matches 4.5's probes; the **Grep `tool_response` is
documented only in examples whose `tool_input` keys contradict the real tool schema** (`paths`,
`file_list`, `match_only`) — the exact low-trust class 4.5 burned on; and two load-bearing
changelog facts: **2.1.208 fixed Grep answering zero-shaped for paginated-past-the-end and for
invalid regexes** — both bugs LIVE on the reference platform's 2.1.170.

Consequence, engineered rather than hoped: the hook proves zero **positively** against six
recognized shapes and emits nothing otherwise (under-capture, never mis-capture); `offset > 0` is
refused outright (the live pagination bug); and certification requires the **literal-pattern
class** (`CERTIFIABLE_PATTERN`), which makes the invalid-regex zero-shape structurally
unrecordable on any host version. The live probe is now a **rollout gate**: the scratch scaffold
(`scratchpad/probe-grep/`, dump-hook settings + seeded tree) runs the moment the CLI is
re-authenticated, and the epic's standing rollout rule already demands a proven end-to-end use in
a non-cortex project before the feature counts as adopted.

### What shipped

- `negative_results` appended to `V5_TABLES` (no version bump; `SCHEMA_VERSION` stays 6);
  `upsertNegativeResult`/`getNegativeResult`; no session column (F8).
- `src/capture/census.ts` — the bounded working-tree fingerprint (D4): NUL-delimited entries,
  sorted rel paths, no case folding, symlinks recorded-never-followed, `.git`/`.cortex.*`
  excluded, `Number`+`/^\d+$/` env ceilings (2000 files / 8 MiB).
- `src/capture/search-query.ts` — canonical key (raw-pattern sha256-16, versioned NUL-joined),
  `normalizeSearchRoot` (shared verbatim by both sides; scope-root fold), certifiability gates.
  Placed at the capture layer because `capture/` must not import `query/`; `search-ledger`
  re-exports.
- `hooks/claude/cortex-capture.sh` — the `Grep)` branch: one jq, positive markers only,
  capture-preserving on every shape (smoke matrix: 14/14 exact).
- `src/capture/spool.ts` — `'search'` entries, `readJsonFlag`, `computeSearchEligibility` (beside,
  not inside, the read pre-pass: any later cmd `>=`; later edit/write **under the root** only;
  relative roots refused; live-peek; conservative), threaded through `processClaimFile`/
  `replayEntry`.
- `src/capture/hooks.ts` — `handleSearchEvent`: certification gate → certifiability → root
  resolution (outside-scope skip, no cwd anchoring) → census at env ceilings → flush-time
  `head_oid` (one git spawn, cold path, null-safe) → redacted upsert. No `events` row (deliberate
  — snapshot summaries stay untouched).
- `src/query/search-ledger.ts` — verdict ladder, record-census-bounded walk, ≤25-token renderer
  (verdict never cut, no surrogate split); MCP `cortex_search_ledger` (schema/list/dispatch/route
  + `SELF_BOOKING_TOOLS`), CLI `cortex search-ledger` (cwd-resolved `--path`, `--json`, ledger
  parity).
- Matcher `Read|Edit|Write|Bash|Agent|Grep` in `REQUIRED_WIRING` + `CAPTURE_TOOLS`; install
  upgrade-convergence test (4.5-era matcher rewritten in place, third run byte-identical); doctor
  warns on a matcher that lost Grep.
- `pruneNegativeResults` (`CORTEX_GC_NEGATIVE_DAYS`, default 30, dry-run, `1e9`-disables).
- Docs per the NEW structure (2026-08-03 restructure): rules → `docs/invariants.md`;
  CLAUDE.md front page gets pointers only; README section + tool/CLI tables.

### Measurements

- **Hook branch marginal (F1)**: through the installed hook, loaded machine, 35 runs after 5
  warmups — Edit baseline p50 605 / p95 915 ms; Grep zero-emitting p50 549 / p95 736; Grep
  silent p50 545 / p95 730. The Grep branch is **at-or-below the baseline** (same one-jq shape);
  its marginal is platform noise. B-4's structural clause pinned by the per-branch jq-count test.
- **B-3**: `search-ledger p95` on a 10,000-record store measured in-suite (census provably running
  inside the measurement) — passes ≤ 20 ms; the recorded census bounds the walk (60-file growth
  answers miss without hashing the growth).
- **End-to-end through the INSTALLED hooks with SYNTHETIC payloads** (isolated `CORTEX_HOME`, real
  git repo, Windows-form payload paths — the first attempt failed on msys-form paths, a test bug
  worth recording since production sends Windows paths): capture → spool line → end-of-turn flush
  → store row (`root: "sub"`, real head) → `zzz_nowhere: no-matches-at c2b53f5 (2026-08-03
  14:50Z)` → edit → `miss` → byte-restore → re-validates. **Stated precisely because the first
  version of this line said "live … proven" while the payloads were hand-built**: this exercises
  every link from the hook inwards, and the *payload shapes* those links receive are separately
  proven by the measured probe above. The two together are the end-to-end claim; neither alone is.

### Mutation campaign — review round

**13/13 killed, every restore byte-identical.** One mutation per guard added in this round, so no
fix rests on inspection alone: corroboration removed, root falling back to `''`, the
unknown-parameter veto removed, the exclusion-parity gate removed, backgrounded commands no longer
disqualifying, `mutate` lines no longer disqualifying, the edit-side same-second `>=` weakened to
`>`, the directory ceiling removed, the file-root exclusion bypass restored, leading-dash patterns
accepted, malformed query fields stripped instead of dropping the entry, the cap dropping silently
again, and an unknown search tool re-keyed as grep.

Two of these guards were themselves **caught by their own new tests before the campaign ran**: the
background-command flag was set but never checked (the disqualifier did nothing), and the
parity-gate test exposed that an identical spool body is deduped as an already-processed replay.
Both are fixed and pinned.

### Mutation campaign — dev round

13/13 killed, every restore byte-identical: census exclusion, overflow-as-ok, class growth,
sha-comparison drop, scope-boundary drop, same-second `>=`→`>`, edits-never-disqualify,
certification bypass, redaction drop, hook any-numFiles-as-zero, hook offset-gate drop,
gc-prunes-on-dry-run, CAPTURE_TOOLS-loses-Grep. Two of these (sha-drop, CAPTURE_TOOLS) were
pre-armed by tests added when campaign design showed they would survive — the same-size content
change and the doctor Grep warning.

### Verification (after the review round)

`npm run build` + `npm run lint` clean; **full suite 1,533 passed / 1 skipped**; `npm run gate` 9/9
untouched; `cortex install` wrote the extended matcher and converges; built `cortex doctor` **17/17**
on the live installation. **Live end-to-end proven twice with REAL searches from this session**:
`zzz_live_proof_epsilon` and `zzz_final_proof_zeta` each captured by the installed hook, certified by
the real flush, stored, and answered `no-matches-at 4ae5ac8` — then `miss` when a file was added
under the searched folder, then honestly re-validated when it was removed. A search never recorded
answers `miss`. Also observed and worth stating: in an ordinary working turn the certification gate
refuses nearly everything (a 102-entry batch recorded nothing, because shell commands followed the
search) — the feature only records in quiet turns, which is exactly when out-of-band writers are
least likely, but it also bounds the realistic hit rate.

### Verification (dev round, superseded)

`npm run build` + `npm run lint` clean; **full suite 1,516 passed / 1 skipped** (+53 this story);
`npm run gate` 9/9 untouched; `cortex install` wrote the hook + matcher and converges (second run
`SAME` everywhere); built `cortex doctor` **17/17** on the live installation. Control-byte scans
clean on every touched file (the Write-tool escape collapse struck twice — census delimiters and
a story-file escape — both caught by scan and normalized to escape text; the generic normalizer
now lives in the scratchpad).

### Residuals and deferrals (deferred-work at review)

- The **live payload probe** is a rollout gate (auth-blocked this round; scaffold ready).
- **`search_ledger` MCP accounting has no dedicated dispatch test** (read_ledger parity is by
  construction; noted for the review round).
- **Bash-mediated searches, Glob, subsumption, offers/unrealized for searches** — deliberately out
  (D7/D10).
- An error-shaped zero from a **permission flap between search and flush** (root unreadable at
  search, readable at census) could record a negative for an errored search — bounded by the
  certification window, requires an outside actor, and every narrowing gate must pass; assessed
  LOW, for the review round to attack.

## Review reconciliation (three layers, 2026-08-03)

34 findings across Blind Hunter (10), Edge Case Hunter (12) and Acceptance Auditor (12). All three
layers used the symbol tools and named them, after a mid-review correction from the orchestrator
tightening the rule from "callers/impact claims" to "any search whose string is a symbol name."

### The convergence, and what it meant

Three independent reviewers reached **the same forbidden outcome by three different routes** — a
stored record asserting about a tree state no search ever examined (SM-C3):

- **Auditor A1 — the wrong ROOT.** A pathless Grep recorded `''`, which the flush read as the scope
  root, while the tool actually searched its own cwd. Reproduced structurally; **fixed** by recording
  the payload `cwd`, and the measured probe later confirmed a pathless search sends no `path` at all.
- **Blind BH2 / Edge M1 — the wrong ZERO.** The or-chain believed the first zero-shaped field it
  recognized. **Reproduced live on this machine**: `{"numFiles":0,"files":["a.ts","b.ts"]}` recorded a
  certified false negative. **Fixed** by requiring no positive evidence anywhere, with
  `totalFiles`/`totalLines` in the positive set because they are what expose a truncated page.
- **Blind BH3 — the wrong FILE UNIVERSE.** The census skips `.cortex.*` on a parity claim the Blind
  Hunter disproved against the real Grep tool: those files ARE searched in any repo whose ignore file
  was never swept — every fresh project. **Fixed** by reporting the skipped files and refusing to
  record unless `git check-ignore` proves them unsearchable.
- **Edge H1 / Blind BH1 — the invisible WRITER.** Certification only sees spooled events. **Fixed**
  in two parts: backgrounded commands (whose PostToolUse fires at launch, so they order *before* a
  search and write *after* it) now disqualify every search in their batch whatever the order; and
  `NotebookEdit` plus the symbol-refactor tools — which this repository's own instructions mandate
  for wide edits — now emit a `mutate` line purely so certification can see them. Named individually
  rather than `mcp__.*`, because a wildcard would add a ~500 ms hook spawn to every MCP call
  including read-only ones. **The irreducible residual** (the user's editor, another terminal) is
  recorded in deferred-work with its two candidate closures, both larger than this story.

### The probe that unblocked everything

F2's "unknown until probed" was treated as a rollout gate. ShuromiU rejected that — the proving had to
happen now — and the block turned out to be a failure of imagination: **this session is itself a
live Claude Code session with the hook installed and the Grep matcher active.** The evidence was
already in the checkout's spool. Dumping the branch's own stdin for four real searches (hook
restored byte-identically) produced the measured shapes above, which **overturned four of the six
shipped markers** and proved capture had been working on a single lucky guess. See the probe section
for the table. Replayed after the fixes: three real zero shapes capture, the real hit is silent, six
adversarial variants refused.

### Fixed (beyond the four above)

Cap now names its drops (read-ledger precedent); census and `git rev-parse` memoized per batch so
neither runs N times inside the write transaction; directories count against the ceiling and the
query-side walk is wrapped (a deep tree threw an uncaught `RangeError` through a public surface);
`path: ""` treated as omitted on both transports; a type-mangled query field drops the whole entry
rather than silently keying a stricter search; leading-dash patterns refused; the D2
unrecognized-parameter veto shipped (possible only once the parameter set was measured); a symlinked
root resolves instead of reading as `missing`; a file root that is itself Cortex exhaust is refused;
an unparseable stored timestamp renders nothing rather than `(null)`; `MAX_FILES=0` means off;
an unknown search tool is skipped rather than re-keyed as grep.

### Corrected records (the Auditor's second HIGH)

`docs/invariants.md` said `SCHEMA_VERSION` is **5** while the code says **6** — on a line this story
had edited, with the fix ticked off as done. Also: "8 bullets" was 7; the D7 deferral was promised to
deferred-work and never written (now written, with three further honest residuals); and "live
end-to-end proven" described synthetic payloads — now stated precisely, with the measured probe
carrying the payload half of that claim.

### Not fixed, by decision

Three Auditor LOWs stand as recorded rather than repaired: the matcher lives in two declarations
(`REQUIRED_WIRING` + `CAPTURE_TOOLS`) rather than one — mitigated by the lost-Grep doctor test, and
the tests now derive the matcher from the declaration so they cannot drift; `head_oid` uses a new
`resolveFlushHeadOid` rather than reusing `detectGitScope` (cold path, functionally equivalent, one
spawn); and the census ceilings ship at the unmeasured starting hypothesis — deferred-work asks for a
certified-vs-refused counter before anyone tunes them, which is the measurement that would actually
inform a number. The 20 ms B-3 assertion stays as a hard bound (Blind L2 called it a flake risk); it
asserts the census ran inside the measurement, and softening a budget because a loaded machine might
miss it is how budgets stop meaning anything.

## File List

- `src/db/schema.ts` — `negative_results` DDL appended to `V5_TABLES`
- `src/db/store.ts` — row/parsed/opts types, `parseNegativeResultRow`, `upsertNegativeResult`, `getNegativeResult`
- `src/db/gc.ts` — `negativeDays` option/env/default, `pruneNegativeResults`, report field
- `src/capture/census.ts` — NEW
- `src/capture/search-query.ts` — NEW
- `src/capture/spool.ts` — search entry fields, `readJsonFlag`, `computeSearchEligibility`, replay threading
- `src/capture/hooks.ts` — `handleSearchEvent`, `SearchArgs`, `SearchCaptureDeps`, flush-time head
- `src/query/search-ledger.ts` — NEW
- `src/query/doctor.ts` — matcher + `CAPTURE_TOOLS` gain Grep
- `src/transports/mcp.ts` — `cortex_search_ledger` (schema/list/dispatch/route), `normalizeSearchQueries`, self-booking
- `src/transports/cli.ts` — `cortex search-ledger`
- `src/index.ts` — census/search-query/search-ledger exports
- `hooks/claude/cortex-capture.sh` — `Grep)` branch (CRLF-normalized)
- `tests/search-ledger.test.ts` — NEW (46 tests: store, census, key/certifiability, ladder, flush certification, render, B-3, GC)
- `tests/capture-hook.test.ts` — Grep branch matrix (zero/silent/params/agent), branch-list + jq-count updates
- `tests/doctor.test.ts` — matcher fixtures + lost-Grep warning
- `tests/install.test.ts` — matcher expectations + upgrade-convergence test
- `tests/mcp.test.ts` — tool count 13 + `cortex_search_ledger` description pins
- `docs/invariants.md` — negative-cache bullets appended (and the stale `SCHEMA_VERSION` 5 → 6 corrected)
- `_bmad-output/implementation-artifacts/deferred-work.md` — the D7 deferral plus three residuals
- `CLAUDE.md` — Core Files pointers + tool line (front page kept short per the 2026-08-03 restructure)
- `README.md` — "Remembering searches that found nothing" section, tool + CLI tables

## Change Log

- 2026-08-03: Story 4.3 implemented end-to-end (capture → certification → census → query →
  surfaces → GC), 13/13 mutation kills, live installed-hook proof, docs per the new
  invariants-log structure. Payload probe deviation recorded; live probe promoted to rollout
  gate. Status → review.
