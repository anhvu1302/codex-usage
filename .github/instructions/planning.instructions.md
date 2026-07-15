---
description: "Planning rules for broad, ambiguous, risky, or explicitly plan-first Codex Usage changes."
name: "Planning Rules"
applyTo: "**"
---

# Planning Rules

- Skip heavy planning for direct explanations, known-file edits, and small corrections.
- For broad or risky work, define the goal, scope, non-goals, current evidence, assumptions, affected files, ordered steps, acceptance checks, test impact, verification, and rollback.
- Organize impact by `src/server`, `src/shared`, `src/web`, `drizzle`, Vitest, and Playwright rather than inventing independent repository units.
- Call out shared-contract compatibility, schema/migration/backfill risk, session-input immutability, database placement, and loopback-only binding whenever relevant.
- When multiple approaches are viable, compare two or three options by local fit, effort, risk, migration cost, and verification cost; recommend one.
- Include a repair loop: run the narrowest relevant check, fix failures, and rerun before completion.
- Ask only questions whose answers materially change the implementation. State safe assumptions for minor ambiguity.
- Do not create planning documents, stage, commit, push, install dependencies, run persistent migrations, or change PM2 state unless the user explicitly requests it.
