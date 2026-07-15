---
name: task-report
description: Create or update a concise Codex Usage task report for code-changing work when repository policy or the user requires a durable record of scope, verification, compatibility, migration, rollout, and remaining risk.
---

# Task Report

Keep the report factual and short. Do not paste large diffs.

## Location

- Write `docs/task-reports/<area>/<YYYY-MM-DD>-<short-title>.md`.
- Use an area such as `server`, `web`, `database`, `shared`, `e2e`, or `tooling`.
- Choose the primary area when several layers changed and list all affected paths in the report.
- Skip a report for AI configuration-only changes unless the user asks for one.

## Required Sections

- Title, date, author, and related issue or request.
- Summary and requirement changes.
- Changed files grouped by area.
- API and shared-type changes.
- Database migration, backfill, retained-data, and rollback notes.
- Vitest and Playwright coverage.
- Verification commands and outcomes.
- Compatibility, privacy, performance, rollout, residual risk, and follow-up.

## Verification Record

- Record each final command and result.
- If a command failed, record the cause, fix, rerun command, and final result.
- If a check remains blocked, record the exact blocker, risk, and command to rerun.
- Do not claim a check passed from an older run or incomplete output.

## Contract Examples

When an API request or response shape changes, include a small final JSON example and name the route, method, status code, callers, and compatibility behavior. Add a companion `.json` only when the user or repository policy requires a machine-readable artifact.
