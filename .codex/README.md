# Codex Project Configuration

This directory contains trusted, repository-scoped Codex configuration for the Codex Usage Dashboard.

## Contents

- `config.toml`: project defaults, bounded multi-agent limits, hook enablement, and a disabled main-thread CodeGraph server.
- `agents/explorer.toml`: fast read-only unfamiliar-code mapper with one CodeGraph explore call.
- `agents/repo-impact.toml`: read-only cross-layer impact reviewer.
- `hooks.json` and `hooks/pretool-guard.sh`: block invariant violations and surface authorization, contract, schema, and verification reminders.
- Repository skills are loaded from `../.agents/skills/`.

## Behavior

- Codex loads this project layer only after the repository is trusted.
- The main model is intentionally not pinned; the selected task model stays in control. Read-only custom agents use `gpt-5.6-terra` with medium reasoning.
- The main thread owns edits and verification. Use `explorer` for bounded mapping and `repo_impact` for cross-layer impact; do not use them as implementation workers.
- `approval_policy = "on-request"`, `approvals_reviewer = "user"`, and `sandbox_mode = "workspace-write"` use Codex's recommended interactive repository baseline. The hook blocks invariant violations and warns when the current request must contain explicit authorization; normal Codex approval and sandbox flows remain available.

## Setup

1. Start Codex from `/Users/VanAnh/WorkSpace/Personal/codex-usage`.
2. Trust the repository so project config and hooks load.
3. Run `codegraph init /Users/VanAnh/WorkSpace/Personal/codex-usage` once, then `codegraph sync` after large refactors if the index becomes stale.
4. Review and trust the project hook with `/hooks` after installation or whenever the hook changes.

Do not set application `CODEX_HOME` to this repository's `.codex/` directory. This directory is agent config; live session JSONL belongs in the user's global Codex home.
