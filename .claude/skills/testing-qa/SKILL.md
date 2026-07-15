---
name: testing-qa
description: Add, review, debug, or plan Codex Usage tests with Vitest for Node and SQLite behavior, Playwright for browser workflows and accessibility, deterministic fixtures, coverage gates, and proportional verification.
---

# Testing QA

Choose tests from the behavior and risk, not from the file count.

## Test Placement

- Put Node tests in `src/**/*.test.ts`; Vitest runs them in a Node environment with the `@` alias.
- Keep pure parser, date, aggregation, and validation tests small and table-driven where useful.
- Test database, importer, retention, and Hono behavior with temporary directories and SQLite files.
- Put browser workflows in `e2e/*.spec.ts`; reuse `e2e/fixtures`, the isolated `.local/e2e-usage.db`, and the configured Chromium project.
- Preserve the Playwright reset command and single-worker isolation unless evidence proves a safe change.

## Coverage

- Cover the happy path and the highest-risk boundary or failure path.
- For bug fixes, prefer a test that fails for the original defect before the patch.
- For import changes, cover repeated scans, partial tails, truncation, deletion or archive, nested agents, dedupe, and malformed records as applicable.
- For analytics or retention, assert exact token, cost, count, coverage, timezone, and rollup totals.
- For API changes, assert validation, status and error shapes, filtering, sorting, pagination, and mutation persistence.
- For UI changes, assert user-visible loading, empty, success, error, keyboard, responsive, theme, and accessibility behavior as applicable.
- Avoid sleeps, real home-directory data, assertion-free tests, conditional assertions, oversized snapshots, and mocks that only verify implementation calls.

## Verification Ladder

1. Run the narrow target, for example `pnpm vitest run src/server/<file>.test.ts` or `pnpm playwright test e2e/<file>.spec.ts`.
2. Run `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` for code-changing work.
3. Run `pnpm test:coverage` for broad server behavior.
4. Run `pnpm test:e2e` for affected browser workflows.
5. Run `pnpm deadcode` when exports, dependencies, or entry points change; run `pnpm audit:prod` when dependencies change.
6. Run `pnpm build` when production wiring changed. Use `pnpm verify` for repository-wide or release-ready changes.

Inspect, fix, and rerun any failure before claiming success. Report commands, outcomes, blockers, and untested risk.
