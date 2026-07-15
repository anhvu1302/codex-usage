---
name: "planning-workflow"
description: "Brainstorm, compare, write, review, or execute a Codex Usage plan without imposing a heavy process on small tasks."
argument-hint: "[idea, requested behavior, plan, changed scope, or implementation request]"
tools: ["search/codebase", "search/usages", "read_file", "run_in_terminal"]
---

Choose the lightest useful mode: brainstorm, option comparison, implementation plan, plan review, or execution.

1. Anchor the work to files, symbols, Hono routes, shared contracts, schema fields, errors, or user flows.
2. Separate verified facts from assumptions and ask only blocking questions.
3. For alternatives, compare two or three options by local fit, effort, compatibility, migration risk, and verification cost.
4. For a plan, include goal, scope/non-goals, affected paths, ordered steps with acceptance checks, Vitest/Playwright impact, verification, rollback, and open questions.
5. For plan review or execution, check stale paths, missing coverage, unsafe commands, contract drift, migration/backfill gaps, and skipped verification.
6. Always preserve immutable session JSONL, an external runtime database default, `127.0.0.1` binding, and the ban on reading or writing real `.env` files.

Do not create a planning document, require approval for a trivial edit, or mutate Git/PM2/persistent data unless explicitly requested.
