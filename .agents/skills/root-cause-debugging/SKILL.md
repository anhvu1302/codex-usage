---
name: root-cause-debugging
description: Diagnose Codex Usage bugs, failing builds or tests, flaky Playwright runs, import or migration failures, wrong analytics, UI regressions, and performance regressions before implementing a fix.
---

# Root Cause Debugging

Find and prove the first wrong boundary before patching symptoms.

## Workflow

1. Capture the exact command, error, stack trace, endpoint, page, data discrepancy, or user flow.
2. Reproduce it with the smallest safe fixture or database. If blocked, state the blocker and collect the closest evidence.
3. Trace the real path: source JSONL or watcher, parser/importer, SQLite or migration, analytics or retention, Hono route, shared type, web wrapper or query state, React UI, then Playwright.
4. Read the full error and identify the first incorrect value or state transition, not merely the final exception.
5. Compare with a nearby working path and form one falsifiable hypothesis.
6. Test that hypothesis with one narrow inspection or command. If it fails, discard it before trying another.
7. Add a regression test that fails for the original defect when practical.
8. Apply the smallest root-cause fix and rerun the original reproduction plus affected checks.

## Guardrails

- Never debug against the user's real Codex files or persistent database when a copied or temporary fixture can reproduce the issue.
- Preserve source-file immutability, import idempotency, aggregate totals, price snapshots, and transaction rollback.
- Account for `Asia/Ho_Chi_Minh` when failures involve dates or retention boundaries.
- Do not stack speculative changes or silence errors without explaining the invalid state.
- Use `$repo-impact` when the fix crosses an API contract, shared type, migration, retained-data rule, runtime setting, or browser workflow.
- Do not claim fixed without fresh output from the command or flow that exposed the defect.

Report the root cause, evidence, regression coverage, fix, commands and results, skipped checks, and remaining risk.
