# Codex Usage Agent Instructions

## Scope And Runtime Boundaries

- This is one Git repository for the Codex Usage Dashboard, not a multi-repo workspace.
- Shared durable policy lives in `AGENTS.md`. Runtime adapters live beside it: Codex uses `.codex/` plus `.agents/skills/`; Claude Code uses `CLAUDE.md`, `.claude/`, and `.mcp.json`; GitHub Copilot uses `.github/`; Antigravity uses `AGENTS.md` plus `.agents/`.
- Open every runtime from `/Users/VanAnh/WorkSpace/Personal/codex-usage` so project-scoped config, hooks, skills, and MCP settings are discovered together.
- Keep project config in this repository. Do not edit `~/.codex`, `~/.claude`, `~/.gemini`, or other global agent configuration unless the user explicitly asks.
- Keep mirrored workflows under `.agents/skills/`, `.claude/skills/`, and `.github/skills/` synchronized while respecting each runtime's own load format.

## Product Invariants

- Source Codex session JSONL is read-only input. The app may scan and parse it, but must never delete, move, truncate, compress, rewrite, or rename source session files.
- Do not point `CODEX_HOME` at this repository's `.codex/` directory. Project `.codex/` contains agent configuration; runtime session data normally lives under the user's global Codex home.
- The default application database lives outside the repository. `.local/` databases are disposable development, migration, or E2E artifacts only.
- The server binds to `127.0.0.1`. Do not broaden the bind address or expose usage data to the network without an explicit product decision and security review.
- Preserve retention semantics: raw detail for 30 days, hourly rollups through day 90, daily aggregates forever, and no mutation of source JSONL.
- Date bucketing and scheduled retention behavior use `Asia/Ho_Chi_Minh`. Treat timezone changes as data-contract changes.
- Never read, print, overwrite, or commit real `.env` files. Use `.env.example` and documented variable names.

## Repository Map

- `src/server/`: Hono API, session importer/parser, analytics, retention, database access, and production entrypoint.
- `src/server/db/`: better-sqlite3 client and Drizzle schema.
- `src/shared/`: types and contracts shared across server and web.
- `src/web/`: React 19/Vite application, route shell, components, API helpers, preferences, and styles.
- `e2e/`: Playwright browser workflows and sanitized session fixtures.
- `drizzle/`: generated SQLite migrations, snapshots, and migration journal.
- `scripts/`: repository maintenance and isolated E2E helpers.

## Source Of Truth

- Trust `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, ESLint/Prettier config, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`, and executable code over stale prose.
- Runtime baseline: Node.js 24, pnpm 11, ESM, strict TypeScript, Hono, React/Vite, Drizzle/SQLite, Vitest, and Playwright.
- Use the `@/*` alias for `src/*` when it keeps imports clear. Keep type-only imports explicit.

## Agent Operating Rules

- Start from the smallest concrete anchor: user-named file, symbol, API route, schema table, failing command, stack trace, or visible workflow.
- Inspect the owning layer first and expand only through direct dependencies. Avoid broad repository sweeps when targeted reads can answer the question.
- The main agent owns planning, routing, all edits, final synthesis, integration, and task-level verification. Subagents are read-only evidence providers.
- Before code search, flow tracing, symbol discovery, pattern mapping, downstream lookup, or multi-file analysis, form a private Anchor Card with the concrete path/symbol/route/error, owning layer, task type, boundary risk, and allowed roots. Then automatically choose exactly one read-only search role in Codex.
- Use `explorer` for routine, well-anchored lookup with a known owner. Use `explorer_deep` when ownership is unclear, a trace spans several files, privacy/security/performance reasoning is material, or an incorrect conclusion would be costly. Give the selected role every anchor in one self-contained prompt, set `fork_turns="none"`, and reuse its compact Evidence Packet instead of remapping the same flow.
- Use the read-only impact role (`repo_impact` in Codex; `repo-impact` in Claude Code, Copilot, and Antigravity) when a change can cross API, shared-type, SQLite/Drizzle schema, importer, retention, export, privacy, or UI boundaries. It reviews supplied anchors and direct consumers rather than rediscovering the repository.
- Use at most one selected search role and one impact review per task, at depth 1. They may run in parallel only when both are useful and their responsibilities do not overlap.
- Do not spawn or auto-use write, worker, or implementation subagents. Keep implementation and verification in the main thread.
- Do not delegate a known single-file edit, direct explanation, typo, or trivial config change.
- Ask only when a missing choice would materially change the result. Infer low-risk details from repository evidence and state important assumptions.
- Preserve unrelated user changes in the dirty worktree. Never reset, discard, overwrite, stage, commit, push, or create a branch unless explicitly requested.
- Do not create standalone plans, reports, or design documents unless the user asks for a durable artifact.

## TypeScript And Architecture Rules

- Keep strict TypeScript clean; do not weaken compiler or lint settings to make a change pass.
- Avoid `any` and unsafe casts. Validate external input at the boundary, then use precise internal types.
- Keep dependencies directional: shared contracts must not import server or web code; web code talks through API helpers; HTTP handlers delegate data work to server modules.
- Prefer small pure parsing/aggregation functions around I/O-heavy code. Make time, filesystem, and database boundaries injectable where tests need determinism.
- Preserve error causes internally but return stable, non-sensitive API errors. Do not log session payloads, tokens, credentials, or raw sensitive paths unnecessarily.

## Server, Importer, And API Rules

- Validate query, route, and JSON input with existing parsers or Zod before using it.
- Keep Hono handlers thin. Put analytics, importer, project, retention, and product behavior in their owning modules.
- Treat `src/server/app.ts` routes and `src/shared/types.ts` response shapes as public contracts for the web app.
- Keep import idempotency and deduplication stable. Parser changes require fixtures for malformed, partial, compacted, main-agent, and subagent events where applicable.
- File watching and synchronization must tolerate append-only writes, partial trailing JSONL, restarts, duplicate scans, and source files disappearing without mutating the source.
- Bind SQL values; do not concatenate untrusted input into SQL. Bound page sizes, date ranges, export sizes, and aggregation work.

## Database And Retention Rules

- For schema changes, edit `src/server/db/schema.ts`, run `pnpm db:generate`, and review generated SQL plus `drizzle/meta` changes together.
- Do not hand-edit generated snapshots or the migration journal. If a generated migration needs correction, adjust the schema or use the repository's established migration workflow and regenerate.
- Review nullability, defaults, backfill cost, indexes, constraints, idempotency, and rollback/data-recovery implications.
- Do not run `pnpm db:migrate` against a non-disposable database unless applying the migration is explicitly in scope. Playwright owns its isolated `.local/e2e-usage.db` lifecycle.
- Retention compaction must stay transactional and preserve aggregate totals, dedupe guarantees, source-management flags, and permanent history promised by the product.

## Web And UX Rules

- Reuse existing React, React Router, TanStack Query/Table, Radix, Tailwind, Recharts, form, toast, skeleton, and preference patterns.
- Keep network calls in `src/web/lib/` helpers and TanStack Query flows; do not scatter raw API URLs or duplicate cache/query keys in components.
- Cover loading, empty, success, error, disabled, long-text, keyboard/focus, reduced-width, and large-data states when relevant.
- Preserve the app's compact dashboard character and existing Vietnamese user-facing language unless the requested surface establishes another convention.
- Avoid request waterfalls, unstable render props, broad subscriptions, unnecessary eager imports, and expensive chart/table recomputation.
- Accessibility is part of done: semantic labels, visible focus, keyboard reachability, contrast, sensible target sizes, and non-color-only status cues.

## Testing And Verification

- Add or update adjacent Vitest coverage for server/parser/analytics behavior. Use Playwright for user-visible workflows and API/UI integration that unit tests cannot prove.
- Bug fixes should include a regression test when the behavior can be isolated. Schema, importer, retention, and contract changes normally require both narrow tests and impact review.
- Use the narrowest useful ladder, repairing and rerunning the same failing check before claiming success:
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` or a targeted Vitest command
  - `pnpm test:e2e` for affected browser workflows
  - `pnpm build`
  - `pnpm deadcode` and `pnpm audit:prod` when dependency/export surface changes justify them
- `pnpm verify` is the full completion gate when the worktree and environment allow it. Do not run format-write across unrelated user changes.
- Report commands run, results, skipped checks with exact reasons, and any residual risk.

## Security And Performance

- Keep review bounded to the requested flow unless the user asks for an audit.
- Check path traversal/symlink escape, oversized or malformed JSONL, CSV formula injection, XSS, unsafe HTML, SQL injection, secret/path leakage, dependency risk, and denial-of-service from unbounded scans or queries.
- For performance work, begin with evidence. Check incremental file reads, database indexes/query plans, aggregation bounds, event-loop blocking, API payload size, request waterfalls, render churn, chart/table scale, and retention transaction cost.
- Treat changes to session parsing, filesystem access, export, database location, bind address, or retention as high-impact even when the diff is small.

## Repository Skills

- Use `$backend-feature` for Hono, importer, analytics, retention, or database work.
- Use `$frontend-api` for React features that consume or change API data.
- Use `$testing-qa` for test design and test-gap review.
- Use `$root-cause-debugging` for bugs, failed checks, flaky tests, and performance regressions before proposing a fix.
- Use `$planning-workflow` for broad design or implementation planning; use `$plan-and-implement` only when the user requests an approval gate.
- Use `$repo-impact` for cross-layer change analysis; `$impact-check` is a compatibility alias.
- Use `$contract-rollout` for API/shared-type/schema rollout checklists.
- Use `$security-review`, `$performance-review`, and `$ui-ux-review` for their bounded specialist workflows.
- Use `$task-report` only when the user asks for a durable completion report.
