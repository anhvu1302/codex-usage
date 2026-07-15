# Codex Usage VS Code Copilot Instructions

This file adapts the shared policy in `AGENTS.md` for VS Code Copilot. The repository is one Node.js application; do not treat its directories as independent repositories or deployment units.

## Repository

- Open VS Code from `/Users/VanAnh/WorkSpace/Personal/codex-usage` so `AGENTS.md` and `.github/` are discovered together.
- Use Node.js 24 and pnpm 11. Treat `package.json`, the lockfile, TypeScript configs, and executable tests as the source of truth for commands and behavior.
- Keep changes within this repository unless the user explicitly names another location. Do not modify global AI configuration.
- Exclude `.git`, `node_modules`, `dist`, `build-server`, `coverage`, `playwright-report`, and `test-results` from ordinary searches.

## Architecture

- `src/server`: Hono routes, SQLite access, importing, analytics, retention, repair, and process startup.
- `src/web`: React/Vite UI, query clients, reusable components, styles, and browser behavior.
- `src/shared`: TypeScript contracts shared across the Hono and React boundaries.
- `src/server/db/schema.ts` and `drizzle/`: Drizzle schema, SQL migrations, and migration metadata.
- `src/**/*.test.ts`: Node-environment Vitest coverage. `e2e/*.spec.ts`: Playwright browser and user-flow coverage.

Follow dependency direction deliberately. Shared contracts may affect both server and web code; schema changes may affect import, analytics, retention, repair, tests, and migrations.

## Non-Negotiable Safety

- Real `.env` files are off limits: never read, print, copy, edit, or delete them. Only templates such as `.env.example`, `.env.template`, and `.env.sample` may be inspected or changed.
- Treat configured Codex session JSONL and title-index data as immutable input. Never edit, delete, move, rename, truncate, chmod, or compact those source files. Purpose-built JSONL fixtures under `e2e/fixtures/sessions/` are the only writable exception.
- Keep the runtime SQLite default under the current user's home directory, outside this repository. Tests should use isolated temporary or in-memory databases. Never commit database, WAL, or shared-memory files.
- Bind HTTP and Vite development traffic only to `127.0.0.1`. Do not introduce `0.0.0.0`, public interfaces, or LAN exposure.

## Agent Routing

- Use `codex-usage-coordinator` for normal implementation, review, and verification.
- Use `explorer` once for bounded read-only mapping when ownership, call flow, or local precedent is unclear.
- Use `repo-impact` once for read-only impact review when a shared contract, route, Drizzle schema or migration, importer, retention behavior, configuration default, or server/web boundary may affect multiple areas.
- Keep both subagents read-only and depth one. The coordinator owns edits, commands, verification, and synthesis.
- Skip delegation for a known single-file edit, direct explanation, or trivial correction.

## Implementation

- Start from the smallest concrete anchor: file, symbol, route, schema field, failing command, or visible flow.
- Prefer strict TypeScript and existing aliases. Keep Hono route parsing and response shapes aligned with `src/shared`.
- Keep SQLite operations synchronous and bounded where required by `better-sqlite3`; use transactions for multi-step state changes and review indexes/query plans for hot paths.
- Do not hand-edit generated Drizzle snapshots or the migration journal. Use `pnpm db:generate` for schema migrations, then review the SQL and metadata together.
- Preserve the current React component and `src/web/components/ui` conventions. Cover loading, empty, error, disabled, and responsive states for UI changes.
- Make the smallest coherent change. Do not stage, commit, push, publish, or mutate PM2 state unless the user explicitly asks.

## Verification

- During implementation, run the narrowest applicable check: `pnpm typecheck`, a targeted Vitest file, or a targeted Playwright spec.
- Before completion, run the relevant subset of `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `pnpm build`. Use `pnpm verify` when the change is broad enough to justify the full suite.
- For schema changes, run `pnpm db:generate`, inspect the generated migration, and test migration behavior against an isolated database.
- If a check fails, diagnose it, fix the cause, and rerun the same command before reporting completion. Report skipped checks with the exact reason and residual risk.

## Prompts And Instructions

- Use the scoped files under `.github/instructions/` automatically by path.
- Use prompts under `.github/prompts/` for planning, debugging, impact checks, contract/schema rollout, test-gap analysis, security, performance, UI/UX, and task summaries.
- Keep `.github/` aligned with `AGENTS.md` while preserving VS Code frontmatter and tool names.
