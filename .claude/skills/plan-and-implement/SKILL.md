---
name: plan-and-implement
description: Use when the user explicitly requests a plan-first Codex Usage change with an approval gate before editing, or asks to execute an already approved plan and verify the result.
---

# Plan And Implement

Use this workflow only when the user asks to approve a plan before implementation.

## 1. Establish The Contract

- Confirm the desired outcome, allowed scope, non-goals, and proof of success.
- Record concrete anchors: file, symbol, Hono route, shared type, table, migration, failing command, or browser flow.
- Treat a user-supplied plan as draft input unless the user explicitly approves execution.

## 2. Gather Bounded Evidence

- Read the smallest owning path first: `src/server`, `src/shared`, `src/web`, `drizzle`, `e2e`, or root tooling.
- Inspect nearby implementation and tests before proposing a new pattern.
- Trace beyond the owning path only when a contract, stored-data shape, runtime setting, or user flow crosses a boundary.
- Use `$repo-impact` before finalizing broad API, migration, importer, retention, privacy, or operational changes.

## 3. Present The Plan

Include:

- Goal, scope, non-goals, and current evidence.
- Expected files or file groups.
- Ordered implementation steps with an acceptance check for each step.
- Test changes and a verification ladder using existing `pnpm` scripts.
- Compatibility, migration, data safety, security, performance, and UI risks when relevant.
- Rollback or repair notes for persisted-data and runtime changes.
- Only questions that block a safe implementation.

## 4. Wait For Approval

- Ask for concise approval after presenting the full plan.
- Do not edit until the user approves the current version.
- Re-present the full plan after scope-changing feedback; that revision requires approval.

## 5. Implement With Change Control

- Follow the approved steps and keep unrelated dirty-worktree changes untouched.
- Pause and present a plan delta if evidence changes scope, compatibility, migration needs, risk, or verification cost.
- Do not stage, commit, push, create a branch, or modify user data unless explicitly requested.

## 6. Verify And Report

- Run narrow checks first, then broader checks proportional to impact.
- Fix and rerun a failed command before claiming completion.
- Report changed files, commands and outcomes, skipped checks with exact blockers, residual risk, and required follow-up.
