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
- **Adding a schema table requires four coordinated edits** in `src/db/schema.ts`: bump `SCHEMA_VERSION`, add a `V<n>_TABLES` DDL constant, add a `backfill*` function if existing rows need projection, and wire both into `ensureCortexSchema`. Migrations are additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`); never destructive.
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

Any change touching ranking, scoring, tokenization, reference validation, or output shaping must run the locked suites:

```bash
node dist/transports/cli.js evaluate --suite eval/suites/<name>.json --compare eval/baselines/<name>.json
```

**Reject the change on:** any negative `top1_hit` delta, any negative `recall_at_3` delta, or any positive `output_tokens` delta. Suites are `budget`, `kind-ordering`, `rename-moved`, `stale-label`, `stemming`. Baselines are locked artifacts — regenerating one is a deliberate act that must be justified in the commit body, never a way to make a red gate go green.

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
- **Documentation is part of the change, not follow-up.** When observable behavior changes, update `README.md`, `CLAUDE.md`, and `AGENTS.md` in the same commit. `AGENTS.md` holds the repository invariants; `CLAUDE.md` holds the expected-behavior contract.

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

Similarly, `token_ledger` is written but never reported on.

---

## Usage Guidelines

**For AI agents:** read this before implementing. Follow every rule exactly. When two rules could apply, take the more restrictive one. The four-command verification block is not optional and not deferrable to the user.

**For humans:** keep it lean — this file is loaded as persistent context by every BMad skill and pays a token cost on every run. Delete rules that become obvious. `AGENTS.md` holds invariants, `CLAUDE.md` holds the behavior contract, this file holds implementation rules; don't duplicate across them.

Last Updated: 2026-07-24
