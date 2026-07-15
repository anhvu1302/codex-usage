---
name: planning-workflow
description: Use for Codex Usage brainstorming, design comparison, implementation planning, plan review, or execution when work is broad, risky, spans repository layers, or has materially ambiguous scope; skip trivial known-file edits.
---

# Planning Workflow

Turn broad or uncertain work into a concrete, testable path without forcing small changes through an approval loop.

## Triage

- Use `$root-cause-debugging` first for a bug, failing command, flaky test, or unexplained regression.
- Use `$contract-rollout` or `$repo-impact` for a read-only compatibility or rollout checklist.
- Use `$plan-and-implement` when the user explicitly requires approval before edits.
- For a clear known-file change, keep the plan lightweight and implement directly.

## Planning Loop

1. Record anchors: desired outcome, file, symbol, route, shared type, table, migration, error, browser flow, allowed roots, and success signal.
2. Read the owning implementation and nearby tests; separate observed facts from assumptions.
3. Select the output: brainstorm, decision comparison, implementation plan, plan review, or plan execution.
4. Trace cross-layer impact only as far as evidence requires: server, shared types, web, database, tests, and operations.
5. Use `$repo-impact` for API, schema, importer, retention, privacy, environment, or rollout risk.
6. Draft small ordered steps. Name the file group, intended change, and acceptance check for every step.
7. Stress-check the plan for stale paths, missing tests, unsafe data operations, migration gaps, user-data exposure, and skipped verification.
8. During execution, track progress and revise the plan when new evidence changes scope or risk.

## Quality Bar

- State the user outcome, scope, non-goals, evidence, assumptions, and success criteria.
- Compare 2-3 viable approaches only when a real design choice exists; recommend one with trade-offs.
- Include Vitest and Playwright impact where behavior can be observed.
- Define a verification ladder from a narrow test through `pnpm typecheck`, broader tests, and `pnpm build` as justified.
- Include rollback or repair notes for schema, retained history, configuration, or contract changes.
- Ask only blocking questions that the repository cannot answer.
- Do not create a planning document, branch, commit, or push unless requested.

## Output Shapes

- Brainstorm: recommendation, options, trade-offs, assumptions, and action.
- Plan: goal, scope, evidence, files, ordered steps, tests, verification, risks, rollback, and blockers.
- Plan review: accepted pieces, required revisions, missing evidence or tests, and safest action.
- Execution: progress, plan delta, changed files, verification evidence, skipped checks, and residual risk.
