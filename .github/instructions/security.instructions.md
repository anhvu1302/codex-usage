---
description: "Defensive security rules for local Hono routes, untrusted session data, SQLite queries, React rendering, configuration, dependencies, and logs."
name: "Security Rules"
applyTo: "src/**,drizzle/**,e2e/**,package.json,pnpm-lock.yaml,.env.example"
---

# Security Rules

- Treat JSONL records, query parameters, path parameters, and imported metadata as untrusted input.
- Validate inputs at Hono boundaries and use bound SQLite parameters. Reject unsafe paths and avoid command construction from user-controlled values.
- Keep configured session data read-only and derived state in SQLite. Repair or retention code must never mutate source JSONL.
- Never read, print, copy, edit, or delete a real `.env` file. Do not log tokens, credentials, full prompts, or sensitive session payloads.
- Render imported text as text, not raw HTML. Preserve output encoding and safe URL handling in React.
- Keep the application bound to `127.0.0.1`; do not add public interfaces, remote control endpoints, or permissive cross-origin access.
- Keep the runtime database outside the repository with least-necessary filesystem permissions. Do not commit database, WAL, or shared-memory files.
- Review new dependencies for maintenance, install scripts, native binaries, and production necessity. Keep lockfile changes intentional.
- Report findings by severity with concrete paths, exploit conditions, and minimal fixes. Do not claim a vulnerability without evidence.
- Verify security-sensitive changes with targeted Vitest/Playwright coverage, lint, typecheck, and `pnpm audit:prod` when dependency risk is in scope.
