# Claude Code Project Configuration

Claude Code uses `CLAUDE.md` as its adapter and `AGENTS.md` as the canonical repository policy.

## Contents

- `settings.json` selects `codex-usage-coordinator`, defines permission guardrails, and installs the pre-tool hook.
- `agents/codex-usage-coordinator.md` owns normal implementation and verification.
- `agents/explorer.md` and `agents/repo-impact.md` are bounded read-only helpers.
- `skills/` mirrors the repository workflows from `.agents/skills/`.
- Root `.mcp.json` provides the project-local CodeGraph server.

## Setup

1. Start Claude Code from `/Users/VanAnh/WorkSpace/Personal/codex-usage`.
2. Keep `.claude/settings.local.json` local and untracked when enabling the project MCP server.
3. Initialize CodeGraph once with `codegraph init /Users/VanAnh/WorkSpace/Personal/codex-usage`.
4. Use `claude --agent codex-usage-coordinator` to select the coordinator explicitly if needed.

The coordinator implements and verifies. `explorer` maps unfamiliar code; `repo-impact` checks direct cross-layer consequences. Neither helper may edit or run verification commands.

Never inspect live `~/.codex` session content through Claude Code; use sanitized `e2e/fixtures`. Never point the application `CODEX_HOME` at the repository's `.codex/` directory.
