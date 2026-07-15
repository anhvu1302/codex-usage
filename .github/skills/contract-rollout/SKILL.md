---
name: contract-rollout
description: Produce a rollout checklist for Codex Usage API routes, query parameters, request or response types, SQLite migrations, environment settings, or web call-site changes that must land compatibly in this repository.
---

# Contract Rollout

Create a compatibility-first checklist for a contract-sensitive change.

## Trace The Contract

- Start at the Hono route and parser in `src/server/app.ts`.
- Trace server logic and persisted fields in `src/server`, `src/server/db/schema.ts`, and `drizzle/`.
- Trace shared shapes in `src/shared/types.ts`.
- Trace fetch wrappers in `src/web/lib` and all consuming React components.
- Trace Vitest coverage and Playwright flows that assert the contract.
- Treat the repository as the contract source; there is no generated browser client or code-generation step.

## Check Compatibility

- Record route, method, query, body, response, error shape, and status-code changes.
- Distinguish additive optional fields from renamed, removed, or newly required fields.
- Check defaults, pagination, sorting, date ranges, timezone behavior, and URL encoding.
- For schema changes, check nullability, backfill, indexes, constraints, transaction safety, populated-database migration, and rollback.
- Check `.env.example`, README commands, PM2 startup, and fixture assumptions when runtime settings change.
- Check privacy, localhost binding, source-file immutability, response size, and query bounds.

## Output

- Compatibility risk and assumptions.
- Required changes grouped by server, shared types, web, database, tests, and operations.
- Ordered commands, using existing `pnpm` scripts.
- Safe rollout order and rollback or repair notes.
- Exact blockers and residual risk for any skipped check.
