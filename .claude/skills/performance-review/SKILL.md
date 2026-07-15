---
name: performance-review
description: Review or fix measured Codex Usage slowness in JSONL importing, SQLite queries and retention, Hono endpoints, React rendering, TanStack Query flows, charts, tables, bundles, or Playwright user flows.
---

# Performance Review

Start from the exact slow command, endpoint, query, page, trace, or user flow. Treat an unmeasured idea as a candidate, not a confirmed regression.

## Server And Database

- Check incremental JSONL reads, duplicate parsing, watcher bursts, repeated session-index scans, and work performed inside transactions.
- Check query plans, missing or unused indexes, unbounded results, per-row queries, repeated aggregates, unnecessary materialization, and large response payloads.
- Preserve importer idempotency, price snapshots, rollup totals, and transactional rollback while optimizing.
- Keep compaction and backfill bounded and single-instance. Do not trade retained-history correctness for speed.
- Measure with representative fixtures or a copied local database, never by mutating the user's Codex session files.

## Web

- Remove request waterfalls and duplicate polling before micro-optimizing renders.
- Check TanStack Query keys, stale settings, invalidation breadth, derived data, unstable props, broad subscriptions, and repeated formatting.
- Bound large tables and session lists. Avoid feeding unnecessary points to Recharts.
- Check bundle growth and lazy-load genuinely secondary screens when evidence supports it.
- Preserve loading, empty, error, focus, responsive, and reduced-motion behavior.

## Process

1. Capture a baseline and define the metric that matters.
2. Trace only the owning path and direct dependencies.
3. Rank findings by expected impact and confidence.
4. Fix the highest-evidence cause first.
5. Repeat the same measurement and run correctness tests.

Report before and after evidence, commands, trade-offs, and remaining candidates. Use `pnpm test:coverage`, `pnpm test:e2e`, and `pnpm build` when their affected surfaces changed.
