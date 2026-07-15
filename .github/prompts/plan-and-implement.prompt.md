---
name: "plan-and-implement"
description: "Draft an evidence-based Codex Usage implementation plan, request approval, then implement and verify the approved scope."
argument-hint: "[feature, bug fix, refactor, or change request]"
tools: ["search/codebase", "search/usages", "read_file", "replace_string_in_file", "create_file", "run_in_terminal"]
---

Use this workflow only when the user wants a plan-first approval gate.

## 1. Establish Scope

Restate the goal, acceptance criteria, non-goals, constraints, and any decision that would materially change the implementation.

## 2. Gather Evidence

Start from exact paths, symbols, Hono routes, schema fields, failures, or visible flows. Inspect only the required paths under `src/server`, `src/shared`, `src/web`, `drizzle`, and tests. Mark assumptions.

## 3. Draft The Plan

Include:

- Affected files and dependency flow.
- Ordered implementation steps with an acceptance check for each.
- Shared-contract and server/web compatibility.
- SQLite schema, migration, backfill, rollback, and existing-data impact.
- Vitest and Playwright coverage.
- Targeted verification followed by the relevant final checks.
- Safety confirmation: session JSONL stays immutable, the database default stays outside the repository, binding stays at `127.0.0.1`, and real `.env` files remain untouched.

## 4. Approval

Present the plan and wait for explicit approval. Do not edit or run mutating commands before approval. Revise the plan if new evidence changes risk or scope.

## 5. Implement

Make only approved, minimal changes. Do not hand-edit Drizzle snapshots or the migration journal. Generate schema migrations with `pnpm db:generate`. Stop and ask if implementation requires dependency installation, persistent migration, PM2 mutation, publishing, or another material scope expansion.

## 6. Verify

Run targeted typecheck/tests first, then applicable formatting, lint, unit, browser, and build checks. Use `pnpm verify` for broad changes. Fix and rerun failures. Report files changed, checks run, skipped checks, blockers, migration/rollback notes, and residual risk.
