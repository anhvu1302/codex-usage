---
trigger: always_on
description: Codex Usage Antigravity coordinator routing and repository safety policy.
---

# Codex Usage Antigravity Runtime

Use `AGENTS.md` as the canonical repository policy. This rule adapts it to Antigravity.

## Coordinator

- The main agent owns planning, implementation, verification, and final synthesis.
- Use built-in `research` as the first mapping action only when code search, trace, symbol discovery, flow mapping, or multi-file pattern discovery is needed.
- Define and invoke `repo-impact` only when API/shared types, schema/migrations, importer/dedupe, retention, exports, storage invariants, or UI consumers may cross layers.
- Use at most one research and one impact invocation per task, shared workspace, read-only, no recursive subagents, and no implementation workers unless the user asks.
- Skip subagents for a known single-file edit, direct explanation, typo, or trivial config change.

## Research Contract

- Supply every known file, symbol, route, table, error, command, and workflow anchor in one prompt.
- Stay read-only. Do not edit, build, test, lint, format, install, migrate, start processes, or inspect real `.env`/live `~/.codex` data.
- Use at most one composite CodeGraph explore call, then at most three targeted reads or exact lookups. Do not retry low-signal mapping.
- Return only relevant paths/symbols, the local pattern, direct cross-layer dependencies, assumptions, and one next step.

## Impact Definition

Define `repo-impact` with write and subagent tools disabled. Enable MCP only if the prompt restricts it to one read-only CodeGraph lookup; normally reuse research findings and targeted reads.

The impact prompt must review API-to-web contracts, Drizzle migration/query/backfill risk, parser/importer/dedupe attribution, retention guarantees, source-session read-only behavior, external DB defaults, localhost binding, timezone behavior, UI state/accessibility, and bounded performance. Return findings by severity, exact paths, required commands, rollout/rollback notes, and assumptions.

## Completion

- The main agent inspects returned evidence before editing and runs the narrowest relevant verification from `AGENTS.md`.
- Preserve unrelated worktree changes. Never stage, commit, push, change branches, or mutate a non-disposable database unless explicitly requested.
- Hook enforcement lives in `.agents/hooks.json` and `.agents/hooks/pretool-guard.sh`. Do not bypass it.
