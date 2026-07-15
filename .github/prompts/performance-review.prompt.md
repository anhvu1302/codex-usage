---
name: "performance-review"
description: "Review or diagnose Codex Usage JSONL import, SQLite query, Hono response, React render, chart/table, or Vite bundle performance."
argument-hint: "[file, route, screen, query, command, log, profile, or slow flow]"
tools: ["search/codebase", "search/usages", "read_file", "run_in_terminal"]
---

Review the supplied performance scope from evidence, not intuition.

Check:

- Incremental JSONL scanning, parsing, deduplication, batching, and memory growth.
- SQLite query shape, indexes, row counts, transaction scope, repeated work, and retention compaction.
- Hono response size and avoidable repeated computation.
- Browser request waterfalls, TanStack Query behavior, React render churn, chart/table cost, and bundle imports.

Return the highest-confidence findings first with exact paths, evidence, a minimal fix, and a repeatable measurement. Keep configured session JSONL immutable, use safe test data for query analysis, and include targeted verification commands.
