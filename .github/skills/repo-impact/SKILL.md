---
name: repo-impact
description: Perform read-only change-impact analysis across the single Codex Usage repository when API contracts, shared types, SQLite schema, migrations, importer behavior, retention, web flows, runtime configuration, or operational commands may be affected.
---

# Repo Impact

Map the blast radius without editing files.

## Boundary Map

Trace only relevant links in this chain:

`Codex JSONL and session index -> parser/importer/activity -> SQLite schema and migrations -> analytics/retention -> Hono routes -> shared types -> web API wrappers and TanStack Query -> React UI -> Vitest/Playwright -> build and PM2 setup`

## Checks

1. Identify the changed file, symbol, route, type, table, setting, or behavior.
2. Find direct producers, consumers, persisted representations, and tests with concrete paths.
3. For API changes, check query and body parsing, status and error shapes, shared types, web wrappers, query keys, and UI states.
4. For database changes, check generated SQL, existing rows, backfill, indexes, constraints, rollups, transactions, rollback, and E2E reset fixtures.
5. For importer or retention changes, check idempotency, partial files, archive/deletion behavior, agent attribution, dedupe, price snapshots, source-file immutability, and exact aggregate totals.
6. For runtime changes, check Node 24, pnpm 11, `.env.example`, cross-platform paths, localhost binding, PM2, build output, and README commands.
7. Check security and performance: private session data, log exposure, validation, query bounds, response size, watcher load, and browser request or render churn.
8. List the smallest commands that prove each affected boundary.

## Output

- Summary in 3-6 bullets.
- Findings ranked Critical, High, Medium, and Low.
- Affected paths and why each is affected.
- Validation order using existing `pnpm` scripts.
- Compatibility, migration, data safety, privacy, performance, rollout, and rollback notes.
- Assumptions and exact blockers.

Do not guess from filenames alone. Mark unverified links as assumptions.
