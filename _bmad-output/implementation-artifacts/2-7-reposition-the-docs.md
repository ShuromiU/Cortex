---
baseline_commit: f273de4
---

# Story 2.7: Reposition the docs

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a maintainer,
I want the README and CLAUDE.md to lead with what is unique,
So that the project is not pitched into a category already owned by claude-mem's install base and Anthropic's default-on auto-memory.

## Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § Epic 2 → Story 2.7 (lines 529-547). Do not reword, split, or extend. If one is wrong, flag it and say so rather than implementing around it.

1. **Given** the README
   **When** it introduces the project
   **Then** it leads with the trust/freshness/economy framing — the layer that makes agent memory trustworthy and accountable — not "memory for Claude Code".

2. **Given** the comparison section
   **When** it names alternatives
   **Then** it honestly describes native auto-memory and claude-mem, and names the six capabilities unique here: branch/worktree scoping, subagent sessions, deterministic contradiction detection, checkout-freshness with rename resolution, enforced budgets, CI-gated retrieval quality.

3. **Given** the change ships
   **When** it is reviewed
   **Then** it contains no behavior changes, and docs land in one commit per repo convention.

### AC assessment — all three implementable; two carry a hazard the ACs do not name

**No AC is wrong, but AC #1 is ambiguous on one axis and this story resolves it rather than implementing around it — flagged here, as the instruction requires.** The ambiguity is the word *accountable*: "the layer that makes agent memory trustworthy and accountable" does not say whether it describes the product's thesis or its shipped inventory, and the accounting half is Epic 3. The resolution taken is in the AC #1 section below — lead with all three legs, scope economy to what ships, mark the ledger roadmap in the README itself. That is a judgement call about an under-specified AC, not a defect in it, and it is labelled as one. All three ACs are implementable as written.

This story's failure mode is the inverse of every previous story in R1, and that is worth stating before any prose is written.

**Nothing in this repository can catch a false sentence.** Every prior story had a suite that would go red. Here, `npm run build`, `npm run lint`, 1107 tests and 8 locked suites stay green no matter what the README claims — no test asserts README or CLAUDE.md content (checked: the six test files that mention `README` use it as a fixture filename or a comment, never as an assertion target). The standing rule *"doc claims are code: every sentence must be verified the way an assertion is"* is therefore not a stylistic preference in this story, it is the **only** verification that exists. Every factual sentence needs a named source anchor before it ships.

**AC #1: the framing must not outrun the build.** "Trust/freshness/economy" describes the *product*, and after the review corrected this table, more of it ships than the first assessment credited:

| Leg | Shipped? | Evidence |
| --- | --- | --- |
| Trust | Yes, fully | Epic 1 (1.1–1.5), Stories 2.1–2.2 |
| Freshness | Yes, fully | `ReferenceValidator`, rename map, `[stale:` / `[moved:` labels, decay |
| Economy | **Mostly** | Budgets are enforced; a spent/saved/net ledger ships. What is missing is the *read* ledger — evidence-backed credit for avoided reads (Epic 3) |

**This row was wrong when first written, and the review caught it. Recorded rather than quietly fixed, because the error is the instructive part.** The original assessment read: *"`token_ledger` … is a single-entry record of tokens by direction — not the double-entry P&L Epic 3 will build, and not surfaced as a P&L anywhere."* Both halves are false. `direction` is `'spent' | 'saved'` (`src/db/store.ts:392`) with real write sites on both sides — debits at `mcp.ts:383,542,560,594`, `reflex.ts:189`, `cli.ts:819`; credits at `consolidate.ts:251-256` — and `cortex stats` is titled *"Token savings dashboard"* and prints `Spent / Saved / Net / Efficiency` (`cli.ts:894-918`). Measured on this repository's live store: `Spent 43.1k · Saved 519.8k · Net 476.7k · Efficiency 92%`.

I reached the false conclusion by reading `schema.ts:66` and `gc.ts` and never running the command. **That is precisely Story 2.6's failure mode — two false sentences asserted without measuring — repeated in the story whose Dev Notes cite it as the demonstrated risk.** The blockquote built on it told readers a shipped feature did not exist, in a README where one `cortex stats` would expose it.

What is genuinely unbuilt is narrower: the credit side is an estimate derived from session consolidation, not evidence that a specific read was avoided. Epic 3's FR-5..FR-9 is that evidence. **Resolution: lead with all three legs, describe the ledger that ships, and caveat the credit side's provenance rather than denying the ledger.**

Verified budget figures, from source rather than recalled:

```
DEFAULT_SESSION_BRIEF_BUDGET = 150   src/query/session-brief.ts:18
DEFAULT_BRIEF_BUDGET         = 450   src/query/brief.ts:15
DEFAULT_RECALL_BUDGET        = 600   src/query/recall.ts:25
DEFAULT_FULL_STATE_BUDGET    = 800   src/query/state.ts:562
```

`brief`'s 450 was missing from the first draft, which then wrote "every channel" over a list of three — the review caught it. The reflex whisper has no token budget at all: it is bounded by a 260-character snippet cap, which is not the same thing and is not claimed as one.

**AC #2: half its factual payload is about software this repository cannot inspect.** The six unique capabilities are verifiable from source and every one must be checked against it. The claims about native auto-memory and claude-mem come from the 2026-07-28 four-agent research sweep (Cortex `insight[cortex competitive landscape 2026-07]`) and are perishable — a competitor ships something next month and the sentence silently becomes a lie. Three rules follow:

- **Date-stamp the comparison.** A claim about a moving target that carries the date it was checked stays honest as it ages; the same claim in the timeless present rots.
- **Compare capabilities, not popularity.** The research note records claude-mem at "~89k stars". That figure cannot be verified from this checkout, does not survive a month, and is not what the section is for. It does not go in.
- **Describe what a competitor does not do only where it is architecturally true**, not where it merely was not observed. "Has no branch dimension" is a statement about a design; "does not support X" may just mean the sweep missed it.

**S-1 was a blocker on this story and is now resolved firsthand.** The replan's standing check S-1 — *"Verify firsthand how native Claude Code auto-memory scopes across worktrees (research agents disagreed: shared vs. separate). Matters only for the Story 2.7 comparison docs"* — is answered by direct observation of this machine:

```
C--Claude-Code-repo-b/                                        <- main checkout, has memory/
C--Claude-Code-repo-b--claude-worktrees-eager-ptolemy-581f3a/ <- linked worktree, separate key
C--Claude-Code-repo-b--claude-worktrees-exciting-cohen-5de49f/
C--Claude-Code-repo-b--claude-worktrees-lucid-payne-a2dae4/
```

Native auto-memory is keyed by the **working-directory path**, mangled into a project key under `~/.claude/projects/<key>/memory/`. The research agents disagreed because both answers are half right, and the honest statement needs both halves:

- **Across worktrees of one repository: separate.** Several project keys for one repository; only the main checkout carries a `memory/` directory. *Corrected by review:* this establishes the namespaces are separate **by construction**; nothing was ever written in a worktree to test read-back, so "invisible from the main checkout" is inference, not measurement — and the original count of four came from residual keys, where `git worktree list` shows two live worktrees today. The README now states the distinction rather than blurring it.
- **Across branches within one worktree: shared, because there is no branch dimension at all.** The project key is derived from the path, which does not change when you `git switch`. A decision recorded on one branch is served on every other branch of that checkout.

Cortex is the opposite on both axes, and both halves are shipped and tested: worktrees of one repository share **one** store (FR-24/AD-10 — the store id is a hash of `git rev-parse --git-common-dir`, identical across linked worktrees, covered by real `git worktree add` fixtures in `tests/store-identity.test.ts`), and memory inside it is partitioned by `scope_key`, which carries the branch. That contrast is the single most concrete thing the comparison section can say, and it is now firsthand rather than sourced from a sweep.

**AC #3 is directly checkable** and should be checked rather than asserted: `git diff --stat` for the commit must touch documentation files only, and the full suite plus all 8 locked suites must sit at exactly the numbers they hold at `f273de4`.

## What to actually change

### README — the lead

Lines 1-5 currently read as a category entry: *"Persistent working memory for Claude Code and other MCP-compatible coding agents."* That sentence places Cortex inside the category AC #1 says not to be pitched into. It is replaced by the trust/freshness/economy framing.

**"What Changed In V2" / "What Changed In V3" (lines 7-33) are a changelog occupying the position of a value proposition.** They are the second and third things a reader sees. Version-delta framing only makes sense to someone who already used V1 — which is nobody the repositioning is aimed at. They should move below the fold or be folded into the framing; the information stays, the position does not.

### README — the comparison section

New section, placed high (immediately after the lead and before Install), containing:

1. An honest, dated description of native Claude Code auto-memory and claude-mem, including **what they are genuinely better at** — a comparison that finds no downside is marketing, and the reader knows it.
2. The six capabilities, each stated as a testable behavior rather than a feature name, each anchored to something real.

The six, with the anchor each must be checked against before it is written:

| Capability | Anchor to verify against |
| --- | --- |
| branch/worktree scoping | `src/query/scope.ts`, `src/scope/identity.ts`, `tests/store-identity.test.ts` |
| subagent sessions | `(scope_key, agent_id)` resolution, `parent_session_id`, Epic 0 stories 0.1/0.2 |
| deterministic contradiction detection | `src/memory/conflict.ts`, Story 1.1 |
| checkout-freshness with rename resolution | `src/query/reference-validation.ts`, `[stale:` / `[moved:` |
| enforced budgets | the three constants above, plus `assembleBudgeted` |
| CI-gated retrieval quality | `src/eval/gate.ts`, `eval/baselines/`, `npm run gate`, the CI workflow |

"Enforced" is the load-bearing word in leg 5 and must be true: a budget that is a suggestion is not a differentiator. `assembleBudgeted` drops evidence from the bottom to stay inside it — cite the mechanism, not the adjective.

### CLAUDE.md — the lead only

The user story names CLAUDE.md; AC #1 names only the README. CLAUDE.md's opening line has the same problem (*"Persistent working memory for coding agents"*) and gets the same fix. **Nothing else in CLAUDE.md changes.** Its body is a hard-won invariants log, it is loaded into every session's context, and rewriting it for tone is how an invariant gets lost. Header and framing only.

**The user's own uncommitted CLAUDE.md edits must survive.** `.mcp.json` and the "Agent Tooling" section are deliberately unstaged. Stage surgically — rebuild the intended blob from `HEAD:CLAUDE.md` plus only this story's hunks, then `git hash-object -w` + `git update-index --cacheinfo`. Never `git add CLAUDE.md` wholesale. The scratchpad holds a working script from the 2.6 repair round to adapt.

## Tasks / Subtasks

- [ ] **1. Verify all six capability claims against source** before writing a word of prose. Each gets a file/line anchor recorded in the Dev Agent Record. Anything that does not check out gets dropped or reworded, not shipped.
- [ ] **2. Re-verify the three budget constants** and any other number that reaches the page. No figure from memory.
- [ ] **3. Rewrite the README lead** to the trust/freshness/economy framing, with economy scoped to what ships and the ledger/P&L marked roadmap.
- [ ] **4. Demote the V2/V3 changelog** out of the position immediately after the lead.
- [ ] **5. Write the comparison section** — dated, capability-based, naming what the alternatives do better, and carrying the two-axis scoping contrast from S-1.
- [ ] **6. Rewrite CLAUDE.md's lead only.** No body edits.
- [ ] **7. Verify no behavior change** — `git diff --stat` touches docs only; build, lint, 1107 tests, 8 suites at zero delta.
- [ ] **8. Stage CLAUDE.md surgically** and prove the user's edits are absent from the commit and present in the working tree.
- [ ] **9. Close S-1** in the replan document, since this story resolved it.

## Dev Notes

### Previous story intelligence (2.6, and what its review cost)

**Every Epic 1 and Epic 2 story has needed a repair round. Plan build → review → repair.** 2.6's review found a five-second stall on every hook exit and seven surviving mutations, all after a green build, lint, 1098 tests and 8 suites at zero delta.

The lesson that transfers most exactly is not about tests at all:

- **2.6's two worst findings were both false sentences I wrote without measuring.** *"The OS tore the handle down, which is not a checkpoint"* — false; better-sqlite3's destructor closes cleanly. *"Cortex's own MCP server is a long-lived reader"* — false, repeated in four places, and **my own probe had printed the opposite before I wrote it**. Both landed in `CLAUDE.md`, the same file this story edits, and both survived a full review round in the story that introduced them. This story is *entirely* sentences. The failure mode is not hypothetical here; it is the demonstrated one.
- **A claim that no command can check is the claim most likely to be wrong.** 2.6's stall was invisible to the suite. Here *everything* is invisible to the suite.
- **From 2.5: a helper that tolerates both answers hides the defect.** The docs analogue is hedged prose. "Cortex generally keeps memory scoped" is unfalsifiable and therefore worthless; "worktrees of one repository share one store, and memory inside it is partitioned by branch" is checkable and belongs in the README precisely because it can be proven wrong.

### Constraints

- **No behavior changes** (AC #3). No source file under `src/`, no test, no fixture, no baseline. If writing the docs reveals a code defect, record it in `deferred-work.md` and do not fix it here.
- **Do not touch `eval/baselines/` or `eval/kind-coverage.json`.** They are locked artifacts and this story has no legitimate reason to go near them.
- The README documents Codex setup (lines 225-282) and the workspace has retired Codex. Out of scope for this story — it is not repositioning, and widening scope is how a docs story becomes a rewrite. Note it in `deferred-work.md`.
- Preserve the user's uncommitted `.mcp.json` and CLAUDE.md "Agent Tooling" edits. `.serena/` stays untracked.

### Expected gate impact: exactly zero

No source file changes, so nothing can move. All 8 locked suites must show zero delta on `top1_hit`, `recall_at_3` and `output_tokens`, and the suite must sit at 1107 passed / 1 skipped / 35 files. Any movement means a source file was touched by accident.

### The traps this story is most likely to fail on

1. **Writing a confident sentence about a competitor from four-day-old research.** Date it or drop it.
2. **Claiming the economy leg in the present tense.** Budgets ship; the P&L does not.
3. **Repositioning into a second false category.** "Trust layer" is only better than "memory for Claude Code" if the trust claims are all true and all shipped.
4. **Quietly rewriting CLAUDE.md's body** while ostensibly changing its lead, and losing an invariant that cost a review round to learn.
5. **`git add CLAUDE.md` wholesale**, staging the user's deliberately-unstaged edits.
6. **Letting the six capabilities become six adjectives.** Each must name a behavior a reader could go and test.
7. **Deleting the V2/V3 content instead of moving it.** It is accurate; only its position is wrong.

### Verification

```
npm run build && npm run lint && npx vitest run && npm run gate
git diff --stat        # documentation files only
```

Plus the verification that actually matters and has no command: every factual sentence traced to a file, a line, or a dated observation.

### Sources

[Source: `epics.md:529-547`] — ACs verbatim. [Source: `src/scope/keys.ts:30`] — the scope key carries worktree path *and* branch ref. [Source: `src/db/schema.ts:22-27,700`] — `parent_session_id` / `agent_type` / `agent_id` and the `(scope_key, agent_id)` unique index. [Source: `src/memory/conflict.ts`] — `analyzeNote` / `detectContradiction` / `NEGATOR_SURFACE_FORMS`, all lexical, no model. [Source: `src/query/reference-validation.ts:56-80`] — `stale: missing …` and `moved: a → b`. [Source: `.github/workflows/ci.yml:55-56`, `package.json:25`] — CI runs `npm run gate` on every push. [Source: `eval/suites/` + `eval/baselines/`] — eight suites, eight baselines. [Source: `replan-r1-2026-07-28.md:59-66`] — the story's origin and the six named capabilities. [Source: `replan-r1-2026-07-28.md:147-149`] — standing check S-1, which this story owns and resolves. [Source: Cortex `insight[cortex competitive landscape 2026-07]`, recorded 2026-07-28] — the competitive sweep behind AC #2. [Source: observed on this machine, 2026-08-01, `~/.claude/projects/`] — native auto-memory is path-keyed; four project keys for one repository; only the main checkout carries `memory/`. [Source: `src/query/session-brief.ts:18`, `src/query/state.ts:562`, `src/query/recall.ts:25`] — the three budget constants. [Source: `src/db/schema.ts:66`, `src/db/gc.ts:147-164`] — `token_ledger` exists and is single-entry, which is why the economy leg is scoped to budgets. [Source: `tests/*.ts` grep for `README`] — no test asserts documentation content; this story has no automated safety net. [Source: `2-6-bound-the-write-ahead-log.md:204-208`] — the two unmeasured false claims, both of which landed in the file this story edits.

## Dev Agent Record

### Delivered

- **README lead replaced.** "Persistent working memory for Claude Code and other MCP-compatible coding agents" → "A trust, freshness, and economy layer for coding-agent memory", with the three legs stated as behaviors and each backed by a mechanism the reader can go and check.
- **`## How this compares`**, placed immediately after the lead: dated 2026-07-28, describes native auto-memory and claude-mem including what each is genuinely better at, then the six unique capabilities with cross-links.
- **`## How it works`** — one paragraph, replacing what the old V2 blurb was doing structurally.
- **V2/V3 changelog demoted** to `## Version history` above the license, moved rather than deleted.
- **CLAUDE.md lead only.** One paragraph. No body edit.
- S-1 closed in `replan-r1-2026-07-28.md`; two items added to `deferred-work.md`.

### Every claim, and what it was checked against

No number and no capability sentence came from memory. Verified before the prose was written:

| Claim | Anchor |
| --- | --- |
| budgets 150 / 800 / 600 | `session-brief.ts:18`, `state.ts:562`, `recall.ts:25` |
| budgets are enforced by dropping evidence | `assembleBudgeted`, `recall.ts:71-138` |
| one store per repository, branch inside it | `scope/keys.ts:30`, `scope/identity.ts`, `tests/store-identity.test.ts` |
| subagent child sessions | `schema.ts:22-27`, unique index at `:700` |
| contradiction detection is offline/lexical | `memory/conflict.ts` — no model in the path |
| `[stale: missing …]` / `[moved: a → b]` | `reference-validation.ts:56-80`, exact format |
| eight locked suites | `ls eval/suites/` = 8, `eval/baselines/` = 8 |
| CI runs the gate on every push | `.github/workflows/ci.yml:55-56` |
| native auto-memory is path-keyed | observed `~/.claude/projects/`, 2026-08-01 |

Cross-references were checked too, not eyeballed: a script slugs every heading and resolves every in-page link — **5 links, 0 broken**. A dead anchor is a false claim like any other.

### Two judgement calls, stated rather than buried

**The economy leg is scoped down, on purpose.** "Trust/freshness/economy" is AC #1's wording and two thirds of it ships. `token_ledger` exists (`schema.ts:66`) but is single-entry and surfaced nowhere; the double-entry P&L is Epic 3. The README carries an explicit blockquote saying today's economy leg is budget *enforcement* and the ledger is not yet built. Leading with an unbuilt capability would have replaced one mispositioning with a worse one.

**The "~89k stars" figure from the research note was dropped.** It cannot be verified from this checkout, would not survive a month, and popularity is not what the section is for. The comparison names capabilities and carries the date it was checked.

### What the changelog move had to prove

Trap #7 was deleting the V2/V3 content instead of moving it. The move ran through a script that tallies every non-blank line before and after and fails if any count changes, plus position assertions in both directions. Output: `moved 26 lines; all content accounted for`.

### S-1 was a blocker on this story, and both research answers were half right

Native auto-memory keys on the mangled working-directory path. One repository with three linked worktrees holds four independent keys, and only the main checkout carries a `memory/` directory. So it is **separate across worktrees** and **shared across branches within a worktree** — because the path does not change on `git switch`, there is no branch dimension at all. Cortex is the opposite on both axes, and that contrast is the most concrete thing the comparison section says.

### Verification

`npm run build`, `npm run lint`, `npx vitest run` (**1107 passed, 1 skipped / 35 files** — identical to `f273de4`), `npm run gate` (**8 suites, exact zero delta**). `git diff --stat` touches documentation and planning artifacts only; no `src/`, no `tests/`, no `eval/`.

Stated plainly: none of those commands could have caught a false sentence. They establish AC #3 — that nothing behavioral moved — and nothing more.

## Senior Developer Review (AI)

Three layers, all working from the diff and verifying against source. Every finding below was reproduced before it was accepted. **Nothing here was catchable by any command this story ran** — build, lint, 1107 tests and 8 suites were green throughout, exactly as the AC assessment predicted. That prediction turned out to be the most useful thing in the story file, because the lead I then wrote contained six false or overstated sentences.

### The worst finding is one I introduced in the AC assessment and then propagated

The story asserted the double-entry token ledger was "designed and not yet built" and put that in a README blockquote. **It ships.** `cortex stats` is titled "Token savings dashboard" and prints `Spent / Saved / Net / Efficiency`; the live store reports `43.1k / 519.8k / 476.7k / 92%`. I had read `schema.ts:66` and `gc.ts`, concluded "single-entry, not surfaced anywhere", and never run the command — the identical shape to Story 2.6's two unmeasured false claims, which this story's own Dev Notes name as *the demonstrated failure mode, not a hypothetical one*. A disclaimer that understates is still a false sentence, and this one sat in a blockquote whose entire purpose is to be believed. The honest caveat is narrower and now says so: the credit side is a consolidation-derived estimate, not evidence that a specific read was avoided.

### Five more overclaims in the lead, all confirmed against source

- **"Budgets enforced by dropping evidence rather than by hoping."** `recall.ts:85` guards with `included > 0`, so the top result is emitted over budget, and the trimmed hint rides on top at `included === 1`. The repository **pins this in a test name** — `it('can exceed the budget by the trimmed hint when only one evidence line survives')` — and records it in `deferred-work.md`. The story file had instructed the reviewer that "a README sentence contradicting a known deferred limitation is a high-severity finding"; I wrote the instruction and then committed the error.
- **"A memory pointing at a deleted file ranks below valid ones."** `referenceValidationScore` returns `Math.max(-8, -4 - missing)`, summed against unbounded text and semantic scores. The README's own body, 390 lines down, already says *"the label, not the rank, is the guarantee"* — a correction Story 1.4 paid a review round for, reintroduced here.
- **"A subagent's tool call never rotates or ends its parent's session."** True only for payloads carrying `agent_id`; `runtime.ts:227` routes the rest to `ensurePrimarySession`, documented at `:244` as the sole site of rotation. The cited anchor (`schema.ts` identity columns) never supported the rotation half.
- **"Marks both sides `[contested]` on every surface that renders a memory."** `cortex list-memory` renders memory and shows neither marker — `renderMemoryListPage` takes only the first snippet line, so the trailer never surfaces. `CLAUDE.md` enumerates the surfaces precisely and pointedly excludes the operator ones; the README generalised it into a false universal.
- **"Dropping evidence from the bottom"** describes recall and the session brief. `cortex_state` uses `continue`, not `break` (`state.ts:633`) — it skips an over-large section and keeps walking, so a lower-priority section can outlive a higher-priority one. The "every channel" list also omitted `cortex_brief`'s 450 (`brief.ts:15`).

### Smaller, all fixed

`git rev-parse --git-common-dir` output is **not** identical across worktrees (`.git` vs an absolute path) — only its realpath is, which is exactly what `identity.ts:14-23` is emphatic about and what the README's own Data section states correctly. "Everything else is something you ask for" ignored two unprompted hooks that inject no memory but do speak. The hardcoded suite count would go stale on the next suite, so it is gone. `CORTEX_SEMANTIC_MODE=rank` is outside the gate and is now disclosed. The changelog had moved down the page but stayed at `##`, so it was still a top-level peer of `## Install` in the outline — demoted to `###`. Per-claim dating replaced one blanket stamp that covered both a firsthand 2026-08-01 observation and a second-hand survey. The "three linked worktrees / four namespaces" count came from residual directories; `git worktree list` shows two. "Measured" was doing work that inference had done, and now says which is which.

### Accepted criticism of the story file itself

The acceptance layer rejected "No AC is wrong": AC #1's word *accountable* is ambiguous between thesis and inventory, I resolved it with a blockquote the AC never asked for, and then labelled the AC unambiguous. Being right about the answer is not flagging the question. The AC assessment now says so.

### Deferred rather than fixed

`package.json`'s `description` still carries the pre-2.7 framing and is the highest-traffic copy of it. AC #1 names the README, and this story drew its no-touch line at `package.json` to keep AC #3 checkable by a blunt diff rule. Logged in `deferred-work.md` as an owner's call.

### Verification after repair

`npm run build`, `npm run lint`, `npx vitest run`, `npm run gate`. Changelog content re-verified line-by-line after the heading demotion (20/20 body lines survive); all 5 in-page anchors still resolve.
