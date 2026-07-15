---
name: "task-report"
description: "Create a concise Codex Usage task report from completed changes and actual verification evidence."
argument-hint: "[changed files, summary, verification output, issue, or pull request]"
---

Create or update `docs/task-reports/<area>/<yyyy-mm-dd>-<short-title>.md`, using the primary area such as `server`, `web`, `database`, `shared`, `e2e`, or `tooling`.

Include:

- Goal and outcome.
- Changed files grouped by server, shared contracts, web, database/migrations, and tests.
- Behavior and compatibility notes.
- Migration/backfill/rollback notes when applicable.
- Exact verification commands and results.
- Skipped checks with reasons and residual risk.
- Confirmation that session JSONL remained immutable, the database default remained outside the repository, loopback-only binding remained intact, and no real `.env` was accessed.
- Follow-up actions and changed requirements, if any.

Use only evidence from the completed work. Do not include secrets, raw session content, or invented verification.
