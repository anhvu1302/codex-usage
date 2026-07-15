---
name: "impact-check"
description: "Run a strict single-repository impact check for Codex Usage changed files, contracts, routes, schema, data flow, or configuration."
argument-hint: "[changed files, branch summary, route, schema change, or feature intent]"
agent: "repo-impact"
tools: ["search/codebase", "search/usages"]
---

Trace the supplied change through the repository.

Check:

- `src/shared` request/response contracts, Hono handlers, browser clients, and React consumers.
- Drizzle schema/migrations, existing rows, import, analytics, retention, repair, and tests.
- Session parser/importer idempotency and the immutability of configured JSONL input.
- Runtime database placement outside the repository and isolated test databases.
- Loopback-only startup, development middleware, production startup, and E2E setup.
- Vitest, Playwright, typecheck, lint, and build impact.

Return a concise summary, findings by severity with exact paths, required changes, safest validation order, migration/rollback notes, and open assumptions. Do not guess.
