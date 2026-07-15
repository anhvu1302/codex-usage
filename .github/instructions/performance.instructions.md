---
description: "Performance rules for JSONL import, SQLite queries and retention, Hono responses, React rendering, charts, tables, and Vite bundles."
name: "Performance Rules"
applyTo: "src/server/**,src/shared/**,src/web/**"
---

# Performance Rules

- Start from evidence: a slow import, query, route, render, bundle, log, profile, or repeatable user flow.
- Keep JSONL ingestion incremental and idempotent. Avoid loading complete session history into memory when streaming or bounded batches are sufficient.
- For SQLite hot paths, inspect query shape, indexes, row counts, transaction scope, repeated statements, and unnecessary materialization. Use `EXPLAIN QUERY PLAN` against safe test data when useful.
- Preserve retention compaction correctness while bounding transaction time and memory use.
- Keep Hono responses paginated or bounded where result sets can grow.
- In React, check request waterfalls, unstable query keys, duplicate fetching, broad context updates, unnecessary renders, heavy chart/table work, and avoidable bundle imports.
- Optimize the highest-confidence bottleneck first and avoid speculative rewrites.
- Verify with the same measurement or user flow that exposed the problem, plus relevant typecheck and tests.
