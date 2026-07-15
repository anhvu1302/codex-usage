---
name: "security-review"
description: "Run a defensive review of Codex Usage Hono input, session parsing, SQLite access, React rendering, local binding, configuration, dependencies, and logs."
argument-hint: "[files, route, import flow, screen, dependency change, or security concern]"
tools: ["search/codebase", "search/usages", "read_file"]
---

Review the supplied scope defensively.

Focus on untrusted JSONL and HTTP input, path traversal, SQL injection, unsafe HTML/URLs, sensitive logging, real `.env` access, source-session mutation, repository-local database files, network exposure, and dependency risk.

Return:

- Findings by Critical, High, Medium, and Low severity.
- Evidence and exploit conditions with exact paths.
- The smallest safe fix for each confirmed issue.
- Required Vitest, Playwright, lint, typecheck, build, or production-audit commands.
- Explicit assumptions where evidence is incomplete.

Do not report speculative issues as vulnerabilities.
