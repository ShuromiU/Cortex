---
project_name: 'cortex'
user_name: 'ShuromiU'
date: '2026-07-24'
sections_completed:
  ['technology_stack', 'language_rules', 'architecture_rules', 'testing_rules', 'quality_gate', 'style_rules', 'workflow_rules', 'dont_miss_rules']
status: 'complete'
existing_patterns_found: 20
rule_count: 41
optimized_for_llm: true
---

# Project Context for AI Agents

_Critical rules and patterns for implementing code in Cortex. Unobvious details only — things an agent will otherwise get wrong. Verified against the checkout at `ea56586`._

---

## Technology Stack & Versions

| Layer | Choice | Constraint |
|---|---|---|
| Language | TypeScript 6.0.2, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler` | `strict: true`, `isolatedModules: true`, `declaration: true` |
| Runtime | Node ≥ 18, `"type": "module"` (pure ESM) | No CommonJS. No transpile-time interop shims. |
| Storage | `better-sqlite3` ^12.8.0 | **Synchronous API.** The entire store layer is sync — no `async`/`await` in `src/db/`. |
| Protocol | `@modelcontextprotocol/sdk` ^1.29.0 | MCP stdio server in `src/transports/mcp.ts` |
| CLI | `commander` ^14.0.3 | `bin: cortex → dist/transports/cli.js` |
| Test | `vitest` ^4.1.3, `globals: true`, `testTimeout: 10_000` | Tests live in `tests/`, flat, `<module>.test.ts` |
| Search | SQLite FTS5 (porter tokenizer) over `memory_items` | Set up in `ensureMemoryItemsFts` |

**Zero runtime dependencies beyond the three above.** Do not add a dependency without an explicit decision — this is a local-first tool that must install cleanly on Windows.

---

## Critical Implementation Rules

### Language-Specific Rules

- **Import specifiers use `.js`, always** — even though sources are `.ts` and even in `tests/`. `import { CortexStore } from '../src/db/store.js'`. Writing `.ts` or extensionless breaks the ESM build.
- **`isolatedModules: true` means type-only exports must be marked.** Use `export { thing, type ThingRow }` or `import type`. A bare re-export of an interface fails the build.
- **Everything public must be re-exported from `src/index.ts`.** It is an exhaustive hand-maintained list, not a barrel glob. New exported symbols and their types must be added there or consumers cannot reach them.
- Error handling is **defensive-silent at the edges**: hook and capture paths swallow errors (`catch {}` with a comment explaining why) because a memory failure must never break the user's turn. Core query/store paths throw normally.
- Timestamps are **ISO-8601 UTC strings stored as SQLite `TEXT`**, never numbers, never `Date` objects. Rendered to users in the compact form `YYYY-MM-DD HH:mmZ`.

### Architecture Rules

- **Layer direction is strict and one-way:** `transports/` → `query/` → `memory/` + `scope/` → `db/`. `db/` imports from `memory/` for text shaping only. Never import a transport from a query, or a query from the store.
- **`memory_items` is the canonical retrieval layer.** New durable content must be projected into `memory_items` (with `scope_type`, `scope_key`, `kind`, `state`, `importance`) or it is invisible to recall, brief, state, and reflex.
- **Everything is scope-keyed.** Any new table holding per-project data carries `scope_key TEXT NOT NULL`. Scope is branch/worktree-aware — see `src/scope/keys.ts`.
- **Adding a schema table does NOT bump `SCHEMA_VERSION`.** AD-11 gives a release *one* increment, and R1 already spent it: Story 2.2 took 4 → 5 and created `V5_TABLES`. Every later table **appends to that constant and leaves the version alone** — safe because `applySchema` runs the DDL unconditionally with `CREATE TABLE IF NOT EXISTS`, so a store already marked v5 still receives tables appended later. The edits are: append the DDL to `V5_TABLES`, add a `backfill*` function *only if* existing rows need projection (a lookup table needs none — see AD-4), and wire any new index into `INDEXES`. Migrations are additive and idempotent; never destructive. Bumping the version because a story's AC text says so is the single worst available mistake here — it marks every shipped store as newer-than-binary, which now refuses to open.
- **Kind weighting has one source of truth:** `src/memory/kind-weights.ts`. Do not inline kind scores in retrieval or hotness.
- **Every user-facing output surface is token-budgeted** and drops lower-priority content from the bottom. New surfaces take a `budget` option and honor it.
- Hook scripts in `hooks/claude/*.sh` are **templates**: `__CORTEX_NODE__`, `__CORTEX_CLI__`, `__CORTEX_HOOK_ENTRY__` are substituted at `cortex install-hooks` time. Never hardcode paths there.

### Testing Rules

- **`npm run lint` does NOT typecheck tests.** `tsconfig.json` sets `include: ["src/**/*"]` and `exclude: [..., "tests"]`, so `tsc --noEmit` skips the whole `tests/` tree, and vitest transpiles without typechecking. Type errors in tests are invisible to both commands — read test code carefully; the compiler will not catch you.
- **Standard store fixture** — replicate exactly:
  ```ts
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');   // required; FKs are off by default
  applySchema(db);
  initializeMeta(db, root);
  const store = new CortexStore(db);
  ```
- **Temp directories use `os.tmpdir()`, never a literal `/tmp/`.** On Windows, Node's temp path and Git Bash's `/tmp` are different filesystems; a hardcoded `/tmp` passes on CI and silently fails locally.
- Tests are **hermetic**: `:memory:` databases and `fs.mkdtempSync` roots. No shared state, no fixtures on disk, no network. Tests that touch engagement state must use an isolated temp cwd (see commit `22530d8` — MCP tests polluted global state).
- One test file per module, named after it: `src/query/recall.ts` → `tests/recall.test.ts`.
- Behavior changes need a test that **pins the observable behavior**, not the implementation. Existing suites assert rendered output strings — match that style.

### Retrieval-Quality Gate

Any change touching ranking, scoring, tokenization, reference validation, or output shaping must run the gate. One command, all suites, non-zero exit on regression:

```bash
npm run gate
```

**It fails on:** any negative `top1_hit` delta, any negative `recall_at_3` delta, any positive `output_tokens` delta, any fixture whose own assertions fail, a suite with no baseline, a baseline with no suite, a baseline missing a metric, a suite that asserts nothing, and any registered `memory_items` kind no suite exercises (AD-5). `noise_count` and `stale_count` are reported, not gated. The nine suites are `alternatives`, `brief-surface`, `budget`, `contested`, `kind-ordering`, `rename-moved`, `stale-label`, `stemming`, `superseded-history`; CI runs the gate on every push.

**Surface coverage (Story 3.4, FR-7).** The former gap — retrieval metrics only, so a brief or header regression could not go red — is closed for rendered content: a suite may carry a `surfaces` block asserting `expect_contains` / `expect_excludes` / `max_tokens` over `brief`, `header` or `full_state`, and those fail on their own terms rather than by a baseline delta. `brief-surface` exists because `superseded-history` **cannot** exercise the brief's superseded exclusion: it seeds the retired decision `cold`, and `BRIEF_STATES` is pinned/hot/warm, so the state filter removes it before the guard runs.

`brief-surface` also asserts on `header` and `full_state`, so all three named surfaces have real coverage rather than only the mechanism existing.

**What is still NOT gated, stated so a green gate is not over-read:** the brief's **read-ledger line**. The harness builds the brief with `includeReadLedger: false`, because the line names files that must exist on disk with matching hashes and a seeded store cannot stage that; leaving it on would make suites pass or fail by whatever is checked out. That line is covered by unit tests only.

**Write surface needles that can actually fire.** Three of the first eight shipped could not: `expect_excludes: ["(superseded)"]` and `["[conflict]"]` name labels the brief's own renderer never emits, and `["rabbitmq"]` was excluded by the state filter rather than by the guard under test. A `max_tokens` above the seeded size is decoration — supply a `budget` that binds instead.

`evaluate --suite … --compare …` still exists as the single-suite human view. **It always exits 0 and is not a gate** — do not use it as one.

Baselines and `eval/kind-coverage.json` are locked artifacts. Change one only via `cortex eval-gate --regenerate-baseline <suite>` with a `Baseline-Regenerated: <reason>` line in the body of the commit that makes the change; CI rejects it otherwise. Regenerating is never a way to make a red gate go green.

### Code Quality & Style Rules

- Section dividers in long files use box-drawing rules: `// ── Row types (raw DB rows) ─────────────`.
- Comments explain **why**, especially for defensive `catch {}` blocks and non-obvious scoring constants. Do not narrate what the code does.
- Naming: files `kebab-case.ts`; DB rows `snake_case` matching SQL exactly; TS symbols `camelCase`/`PascalCase`. Row interfaces are `XRow` (raw) and `ParsedX` (hydrated) — keep both when adding a table.
- Prefer pure functions with an explicit `store` parameter over stateful classes. `ReferenceValidator` is a class only because it memoizes and batches.

### Development Workflow Rules

- **Conventional Commits**, lowercase subject: `feat:`, `fix:`, `docs:`, `test:`, `chore:`. Scope optional (`docs(claude-md):`).
- Verification before any claim of completion — all four, in order:
  ```bash
  npm run build && npm run lint && npx vitest run
  ```
  plus the eval gate above when retrieval is touched.
- **Documentation is part of the change, not follow-up.** When observable behavior changes, update `README.md` and `CLAUDE.md` in the same commit. `CLAUDE.md` holds the expected-behavior contract and the repository invariants; `README.md` is the user-facing surface.

### Critical Don't-Miss Rules

- **Never spawn Node per tool call.** PostToolUse appends one JSON line to `.cortex.spool.jsonl` via bash. Flush happens at turn end, at 256 KiB, or at next session start — exactly once per batch via atomic claim + processed marker. Any design that shells out per tool call is rejected on principle.
- **Cortex runtime artifacts must never enter the app graph or memory:** `.cortex.db`, `.cortex.db-wal`, `.cortex.db-shm`, `.cortex.spool.jsonl`, `.cortex.state`, `.cortex.agent-used`. A prior commit (`29026f2`) exists solely because they leaked in.
- **Repo truth beats memory.** Missing file references demote and label (`[stale: missing …]`) — they must never be silently dropped or hard-deleted. Renames resolve through the rename map to `[moved: a → b]`. Historical queries must still reach stale evidence.
- **SessionStart stays small and silent.** The brief is ≤150 tokens and emits *nothing* on a cold start. Do not add startup rituals, banners, or unconditional injections.
- **Injected context should be stable within a session.** Churn in injected content invalidates the model's prompt cache — a hidden token tax that does not show up in any local measurement.
- **No network in production paths.** The semantic layer is deliberately gated (`CORTEX_SEMANTIC_MODE=off|shadow|rank`, default `off`) with no provider wired. `shadow` must not change returned results. Keep providers injectable and test with deterministic fakes.
- **Windows is a first-class target**, not a port. Paths go through `normalizeScopePath`. Hooks run under Git Bash and depend on `jq`. Assume backslashes, spaces in paths, and case-insensitive filesystems.
- Resolved notes stay cold: they must not resurface in briefs, default state, or reflex `additionalContext`, even when retrieved.
- `cortex gc` is **dry-run by default**. Any new destructive operation follows that convention.

---

## Dormant Surface (do not assume unused means unneeded)

Two schema columns are written but never read. They are deliberate capacity, not dead code, and are targeted by the current release:

- `notes.conflict INTEGER` — contradiction detection between a new note and prior decisions on the same subject.
- `notes.alternatives TEXT` (JSON) — populated by `cortex_note`, surfaced almost nowhere. Intended to show *already-rejected* options in recall.

`token_ledger` is a different case and the note that used to sit here was **false**: it is written *and* reported. `cortex stats` prints `Spent / Saved / Net / Efficiency` today (`src/transports/cli.ts`, the `stats` command). What is actually missing is the **read ledger** — evidence-backed credit for reads that were avoided — which is Epic 3's subject. Run `cortex stats` before writing anything about this; reading the schema alone is what produced the wrong claim.

---

## Usage Guidelines

**For AI agents:** read this before implementing. Follow every rule exactly. When two rules could apply, take the more restrictive one. The four-command verification block is not optional and not deferrable to the user.

**For humans:** keep it lean — this file is loaded as persistent context by every BMad skill and pays a token cost on every run. Delete rules that become obvious. `CLAUDE.md` holds invariants and the behavior contract, this file holds implementation rules; don't duplicate across them.

Last Updated: 2026-07-24
