---
name: impact-check
description: Compatibility alias used only when the user explicitly requests impact-check; otherwise use repo-impact for read-only Codex Usage change-impact analysis across this repository.
---

# Impact Check

Run the same read-only review as `$repo-impact`, but keep the result compact.

Report:

- A 3-6 bullet impact summary.
- Findings ranked Critical, High, Medium, and Low.
- Concrete affected paths across server, shared types, web, database, tests, and operations.
- Required existing `pnpm` commands in validation order.
- Data safety, compatibility, privacy, performance, and rollback notes.
- Assumptions and exact blockers.

Do not edit files. Do not guess about an unseen caller or schema; label uncertainty clearly.
