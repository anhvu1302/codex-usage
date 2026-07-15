---
description: "Server and data rules for Hono, shared contracts, SQLite/better-sqlite3, Drizzle schema and migrations, importing, analytics, retention, and startup."
name: "Server And Data Rules"
applyTo: "src/server/**,src/shared/**,drizzle/**,drizzle.config.ts"
---

# Server And Data Rules

## Hono And Contracts

- Keep route registration and middleware composition in the existing Hono application structure.
- Validate path, query, and body input at the HTTP boundary. Return deliberate status codes and stable JSON shapes.
- Put request/response types used by both sides in `src/shared`; update Hono handlers, browser clients, and tests together when a contract changes.
- Keep route handlers thin. Put parsing, importing, analytics, project attribution, retention, and repair behavior in focused modules.
- Preserve cancellation, shutdown, and resource cleanup behavior in process startup.

## Session Input

- Configured Codex session JSONL and title-index data are immutable source input. Never edit, delete, move, rename, truncate, chmod, or compact them.
- The application may watch, read, parse, deduplicate, and derive SQLite state from those files. Recovery and repair operations must change derived state only.
- Handle append-in-progress lines, malformed records, duplicate events, missing metadata, and repeated scans without corrupting derived totals.
- JSONL under `e2e/fixtures/sessions/` is test data and the only writable exception.

## SQLite And Drizzle

- Keep the runtime database default under the user's home directory, outside this repository. Tests must use isolated temporary or in-memory databases.
- Use Drizzle or prepared `better-sqlite3` statements with bound parameters. Never concatenate untrusted values into SQL.
- Use explicit transactions for multi-table or multi-step state changes. Preserve deduplication and retention invariants on failure.
- Consider nullability, defaults, backfill, indexes, uniqueness, foreign keys, existing rows, database size, and rollback for every schema change.
- Change `src/server/db/schema.ts`, then run `pnpm db:generate`. Review generated SQL and metadata together; do not hand-edit Drizzle snapshots or `drizzle/meta/_journal.json`.
- Do not run `pnpm db:migrate` against a persistent database unless the user explicitly authorizes it.

## Configuration And Startup

- Never read or edit a real `.env` file; inspect only an allowed template.
- Keep HTTP and development middleware bound to `127.0.0.1`. Never widen the host to `0.0.0.0` or another public interface.
- Keep platform-specific paths behind `node:path`, `node:os`, and configuration helpers. Support macOS, Linux, and Windows path semantics.
- Do not hard-code a repository-local runtime database path or a user's absolute home path.

## Verification

- Run `pnpm typecheck` for server/shared TypeScript changes.
- Run targeted Vitest files for changed parsing, import, query, analytics, retention, repair, or configuration behavior.
- For schema changes, run `pnpm db:generate`, inspect the migration, and exercise it against an isolated database.
- Run `pnpm build` when startup, bundling, Hono routes, or shared contracts change.
- Fix and rerun any failed check before reporting completion.
