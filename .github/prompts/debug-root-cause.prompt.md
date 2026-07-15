---
name: "debug-root-cause"
description: "Diagnose a Codex Usage bug, failing check, import error, SQLite issue, Hono route failure, React problem, or Playwright failure before fixing it."
argument-hint: "[error output, command, file, route, screen, log, or reproduction]"
tools: ["search/codebase", "search/usages", "read_file", "run_in_terminal"]
---

Diagnose before proposing a fix.

1. Capture the exact symptom, expected behavior, and smallest reproducible command or flow.
2. Trace from the failure to the first incorrect state across configuration, parser/importer, SQLite, shared contracts, Hono, browser client, or React UI.
3. Separate root cause from downstream symptoms and unrelated pre-existing failures.
4. Form the smallest evidence-backed hypothesis and test it with a targeted Vitest file, Playwright spec, typecheck, or safe diagnostic query.
5. Recommend a minimal fix plus regression coverage and the exact rerun command.

Never inspect a real `.env`, mutate session JSONL, move the database default into the repository, or widen the loopback host while debugging.
