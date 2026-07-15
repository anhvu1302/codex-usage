# Shared Agent And Antigravity Configuration

This directory is the shared repository customization root for Codex skills and Antigravity runtime policy.

## Contents

- `rules/codex-usage-runtime.md`: always-on Antigravity coordinator and read-only subagent routing.
- `skills/`: canonical repository workflow skills mirrored to Claude Code and GitHub Copilot.
- `mcp_config.json`: project CodeGraph MCP server.
- `hooks.json` and `hooks/pretool-guard.sh`: repository permission guard.
- `hooks/test-pretool-guard.sh`: deterministic policy test harness.

## Setup

1. Open `/Users/VanAnh/WorkSpace/Personal/codex-usage` as the workspace root.
2. Run `codegraph init /Users/VanAnh/WorkSpace/Personal/codex-usage` once.
3. Confirm `codex-usage-runtime`, the shared skills, CodeGraph, and `codex-usage-pretool-guard` are visible in Antigravity customizations.
4. Run `bash .agents/hooks/test-pretool-guard.sh` after changing the hook.

The hook protects real environment/global-agent files, blocks destructive commands, and asks before dependency, database, remote, deploy, or other high-impact operations. It permits bounded local reads, edits, tests, builds, and isolated E2E work.

Do not point application `CODEX_HOME` at this repository's `.codex/` directory. Do not inspect live session content; use sanitized `e2e/fixtures` for parser and importer work.
