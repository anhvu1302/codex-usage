---
name: "contract-rollout"
description: "Produce a compatibility and rollout checklist for Codex Usage shared contracts, Hono routes, Drizzle migrations, browser consumers, and local runtime."
argument-hint: "[route, shared type, schema change, migration, changed files, or feature intent]"
agent: "repo-impact"
tools: ["search/codebase", "search/usages"]
---

Create a strict checklist for the supplied contract- or schema-sensitive change.

Check:

- Shared request/response types, Hono route behavior, browser API clients, React consumers, and visible error states.
- Drizzle schema and generated migration SQL, existing-row backfill, indexes, constraints, transaction safety, and rollback.
- Import, analytics, retention, repair, and deduplication effects.
- Required Vitest and Playwright coverage plus typecheck, lint, build, and migration verification.
- Runtime startup/restart implications without changing PM2 state unless authorized.
- Safety invariants: source JSONL remains immutable, runtime SQLite defaults outside the repository, the host remains `127.0.0.1`, and real `.env` files are untouched.

Return compatibility risk, required changes by area, exact commands in safest order, migration and rollback notes, restart notes, and open assumptions.
