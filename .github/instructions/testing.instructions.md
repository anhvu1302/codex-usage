---
description: "Vitest and Playwright rules for deterministic unit, integration, accessibility, migration, and browser-flow coverage."
name: "Testing Rules"
applyTo: "src/**/*.test.ts,e2e/**/*.spec.ts,e2e/fixtures/**,vitest.config.ts,playwright.config.ts"
---

# Testing Rules

## Test Design

- Test behavior and boundaries rather than private implementation details.
- Use clear arrange/act/assert structure and names that describe the scenario and expected result.
- Add regression coverage for bug fixes. Include malformed, empty, duplicate, partial, timezone, and boundary data where relevant.
- Keep tests deterministic: control clocks, paths, database state, filesystem fixtures, and process environment.
- Assert meaningful outcomes, including persisted state, returned contracts, visible UI, and important side effects.

## Vitest

- Keep focused Node-environment tests near the module as `*.test.ts`.
- Use isolated temporary or in-memory SQLite databases and close every handle.
- Test import idempotency, parser tolerance, deduplication, retention boundaries, analytics totals, query filters, and configuration fallbacks when those areas change.
- Do not access a user's real session directory or real database.

## Playwright

- Keep user flows under `e2e/*.spec.ts` and reusable source data under `e2e/fixtures/sessions/`.
- Fixture JSONL is the only writable JSONL. Never point a test at configured user session data.
- Prefer role/label/test-id locators over brittle CSS structure. Wait for observable UI state rather than fixed timeouts.
- Cover the changed flow's loading, empty, populated, error, responsive, and accessibility behavior when applicable.
- Preserve loopback-only setup and isolated test storage.

## Commands

- Target one unit file: `pnpm exec vitest run <test-file>`.
- Run all unit tests: `pnpm test`.
- Target one browser spec: `pnpm exec playwright test <spec-file>`.
- Run all browser tests: `pnpm test:e2e`.
- Use `pnpm test:coverage` when coverage impact matters.

If a check fails, diagnose the cause, fix it, and rerun the same command before reporting. State exact reasons for skipped checks.
