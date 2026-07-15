@AGENTS.md

# Claude Code Adapter

- `AGENTS.md` is the canonical repository policy. This file only describes Claude Code-specific loading and routing.
- Start Claude Code from `/Users/VanAnh/WorkSpace/Personal/codex-usage` so `CLAUDE.md`, `.claude/`, `.mcp.json`, and repository skills load together.
- Project customization belongs in this repository. Do not copy it into global `~/.claude` configuration.
- Shared settings select `codex-usage-coordinator` as the default Claude Code agent. It retains ownership of edits and verification and may use only the bounded read-only `explorer` and `repo-impact` agents when the triggers in `AGENTS.md` match.
- CodeGraph MCP is for unfamiliar code mapping. Give `explorer` one composite mapping request and reuse the result; known files, exact identifiers, and stack traces should use targeted reads.
- Repository skills are mirrored under `.claude/skills/` and can be invoked with the corresponding slash command.
- Never read or write a real `.env`, never edit global agent configuration for this project, and never point application `CODEX_HOME` at this repository's `.codex/` directory.
