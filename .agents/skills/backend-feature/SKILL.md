---
name: backend-feature
description: Implement or review Codex Usage backend work in the Hono API, session importer, analytics, retention, SQLite or Drizzle layers, including schema changes, migrations, shared contracts, and focused tests.
---

# Backend Feature

Use existing patterns in `src/server` and nearby tests before introducing a new abstraction.

## Implementation Rules

- Keep HTTP parsing, Zod validation, status codes, and response mapping in `src/server/app.ts`.
- Put import, analytics, retention, project, and activity behavior in the owning server module.
- Keep browser-visible request and response types in `src/shared/types.ts`; update every producer and consumer together.
- Use parameterized Drizzle or `better-sqlite3` queries. Bound list queries, preserve useful indexes, and wrap multi-table writes in a transaction.
- Preserve importer invariants: source JSONL stays read-only, repeated scans remain idempotent, partial tails can resume, and deleted source files do not erase imported history.
- Preserve usage invariants across raw events and rollups: token totals, price snapshots, project and agent attribution, retention coverage, and `Asia/Ho_Chi_Minh` date grouping.
- For schema changes, update `src/server/db/schema.ts`, run `pnpm db:generate`, inspect generated SQL and snapshots, and verify migration of populated data. Never use a destructive schema shortcut on a real database.
- Keep configuration portable across macOS, Linux, and Windows. Do not embed a user home path.

## Verification

1. Add or update a focused `src/**/*.test.ts` regression test.
2. Run the narrow Vitest target, then `pnpm typecheck`.
3. Run `pnpm test:coverage` for broad server changes.
4. Run `pnpm test:e2e` when an API or stored-data workflow changes.
5. Run `pnpm build` before completion when runtime wiring or bundling changed.

If a command fails, fix the cause and rerun that command before reporting success. Use `$repo-impact` for changes that cross server, shared types, web code, migrations, or operational setup.
