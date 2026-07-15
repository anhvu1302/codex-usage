#!/usr/bin/env bash
set -euo pipefail

payload_text="$(cat || true)"
CLAUDE_HOOK_PAYLOAD="$payload_text" python3 - "$@" <<'PY'
import json
import os
import re
import shlex
from pathlib import Path, PurePosixPath


payload_text = os.environ.get("CLAUDE_HOOK_PAYLOAD", "")
try:
    payload = json.loads(payload_text or "{}")
except Exception:
    payload = {}

tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
tool_name = str(payload.get("tool_name") or payload.get("toolName") or "")
tool_name_l = tool_name.lower()
paths: list[str] = []
commands: list[str] = []
patch_texts: list[str] = []


def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            key_l = str(key).lower()
            if key_l in {"file", "filepath", "file_path", "path"} and isinstance(item, str):
                paths.append(item)
            elif key_l in {"files", "paths"} and isinstance(item, list):
                paths.extend(str(entry) for entry in item if isinstance(entry, str))
            elif key_l in {"command", "cmd", "script"} and isinstance(item, str):
                commands.append(item)
            elif key_l in {"patch", "patch_text"} and isinstance(item, str):
                patch_texts.append(item)
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)


walk(tool_input)
command_text = "\n".join(commands).strip()
patch_text = "\n".join(patch_texts)
for line in f"{patch_text}\n{command_text if 'apply_patch' in tool_name_l else ''}".splitlines():
    match = re.match(r"\s*\*\*\* (?:Add|Update|Delete) File: (.+)$", line.strip())
    if match:
        paths.append(match.group(1).strip())

payload_l = payload_text.lower()


def emit(obj):
    print(json.dumps(obj, separators=(",", ":")))
    raise SystemExit(0)


def deny(reason: str, message: str):
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            },
            "systemMessage": message,
        }
    )


def warn(reason: str, message: str):
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": f"{reason}: {message}",
            },
            "systemMessage": message,
        }
    )


def confirmation_block(reason: str):
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": reason,
            },
            "systemMessage": reason,
        }
    )


def find_workspace_root(start: Path) -> Path:
    current = start.resolve(strict=False)
    for candidate in (current, *current.parents):
        if (candidate / "package.json").is_file() and (candidate / ".codex").is_dir():
            return candidate
    return current


cwd = Path(str(payload.get("cwd") or tool_input.get("cwd") or os.getcwd())).expanduser().resolve(strict=False)
workspace_root = find_workspace_root(cwd)
home_root = Path.home().resolve(strict=False)
global_config_roots = [home_root / ".codex", home_root / ".claude", home_root / ".gemini"]
live_codex_roots = [home_root / ".codex" / "sessions", home_root / ".codex" / "archived_sessions"]
live_codex_files = {
    home_root / ".codex" / "auth.json",
    home_root / ".codex" / "history.jsonl",
    home_root / ".codex" / "session_index.jsonl",
    home_root / ".codex" / "state_5.sqlite",
}
dependency_manifests = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"}


def resolve_path(raw_path: str, base: Path = cwd) -> Path:
    path = Path(os.path.expandvars(raw_path)).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve(strict=False)


def is_within(path: Path, roots) -> bool:
    return any(path == root or root in path.parents for root in roots)


def is_env_file(path: Path) -> bool:
    name = path.name.lower()
    return name == ".env" or (
        name.startswith(".env.")
        and name not in {".env.example", ".env.template", ".env.sample"}
    )


def is_live_codex_content(path: Path) -> bool:
    return path in live_codex_files or is_within(path, live_codex_roots)


def is_dependency_manifest(path: Path) -> bool:
    return path.name.lower() in dependency_manifests


def is_write_tool(name: str) -> bool:
    return any(marker in name for marker in {"apply_patch", "edit", "write", "notebook"})


resolved_paths = [resolve_path(path) for path in dict.fromkeys(paths)]
write_tool = is_write_tool(tool_name_l)
for path in resolved_paths:
    if is_env_file(path):
        deny("Sensitive environment file blocked", "Real .env files cannot be read or changed; use .env.example.")
    if is_live_codex_content(path):
        deny(
            "Live Codex data blocked",
            "Direct access to live ~/.codex sessions, indexes, history, state, or authentication data is blocked. Use sanitized repository fixtures.",
        )
    if write_tool and ".git" in {part.lower() for part in path.parts}:
        deny("Git metadata write blocked", "Direct writes inside .git are blocked.")
    if write_tool and is_within(path, global_config_roots):
        deny("Global agent config write blocked", "Global Codex, Claude, and Gemini configuration must not be changed by this project.")
    if write_tool and is_dependency_manifest(path):
        confirmation_block("Dependency manifest and lockfile changes require confirmation.")
    if write_tool and not is_within(path, [workspace_root]):
        confirmation_block("File writes outside the active repository require confirmation.")


CODEGRAPH_READ_ONLY_COMMANDS = {
    "status",
    "files",
    "query",
    "explore",
    "node",
    "callers",
    "callees",
    "impact",
    "affected",
}
SAFE_SCRIPTS = {
    "dev",
    "start",
    "build",
    "build:web",
    "build:server",
    "format:check",
    "lint",
    "typecheck",
    "test",
    "test:coverage",
    "test:e2e",
    "deadcode",
    "audit:prod",
    "verify",
    "db:generate",
}
SAFE_EXEC_TOOLS = {"vitest", "eslint", "prettier", "tsc", "playwright"}


def split_command(command: str):
    if re.search(r"[`]|\$\(|\r|\n", command):
        return None
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>")
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = list(lexer)
    segments = []
    current = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in {"&&", "||", ";", "|"}:
            if not current:
                return None
            segments.append(current)
            current = []
        elif token == "&":
            return None
        elif token in {">", ">>", "<", "<<"}:
            if current and current[-1].isdigit():
                current.pop()
            target = tokens[index + 1] if index + 1 < len(tokens) else ""
            if target != "/dev/null":
                return None
            index += 1
        else:
            current.append(token)
        index += 1
    if current:
        segments.append(current)
    return segments or None


def strip_prefixes(tokens):
    result = list(tokens)
    while result and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", result[0]):
        result.pop(0)
    return result


def probable_path_tokens(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return []
    command = tokens[0]
    rest = tokens[1:]
    if command in {"rg", "grep"}:
        option_values = {"-e", "--regexp", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add", "--encoding", "--engine", "--replace"}
        positionals = []
        explicit_pattern = False
        index = 0
        while index < len(rest):
            token = rest[index]
            if token in option_values and index + 1 < len(rest):
                explicit_pattern = explicit_pattern or token in {"-e", "--regexp"}
                index += 2
                continue
            if token in {"-f", "--file"} and index + 1 < len(rest):
                positionals.append(rest[index + 1])
                explicit_pattern = True
                index += 2
                continue
            if token.startswith("-"):
                index += 1
                continue
            positionals.append(token)
            index += 1
        return positionals if explicit_pattern else positionals[1:]
    if command in {"sed", "awk", "jq", "yq"}:
        positionals = [token for token in rest if not token.startswith("-")]
        return positionals[1:]
    if command == "find":
        result = []
        for token in rest:
            if token.startswith("-") or token in {"(", ")", "!"}:
                break
            result.append(token)
        return result
    if command == "codegraph":
        result = []
        for index, token in enumerate(rest):
            if token in {"-p", "--path"} and index + 1 < len(rest):
                result.append(rest[index + 1])
            elif rest and rest[0] in {"status", "affected"} and index > 0 and not token.startswith("-"):
                result.append(token)
        return result
    if command == "git":
        return tokens[2:]
    return rest


def path_decision(token: str):
    value = token.strip()
    if not value or value.startswith("-") or "://" in value:
        return None
    path = resolve_path(value)
    if is_env_file(path):
        return ("deny", "Terminal access to real .env files is blocked.")
    if is_live_codex_content(path):
        return ("deny", "Direct terminal access to live ~/.codex data is blocked.")
    if not is_within(path, [workspace_root]):
        return ("confirm", "Terminal file access outside the active repository requires confirmation.")
    return None


def direct_write_decision(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return None
    command = tokens[0]
    mutating = command in {"rm", "mv", "cp", "tee", "touch", "mkdir", "chmod", "chown"}
    mutating = mutating or (command == "sed" and any(token.startswith("-i") for token in tokens[1:]))
    if not mutating:
        return None
    for token in tokens[1:]:
        if token.startswith("-") or re.search(r"[*?\[\]]", token):
            continue
        path = resolve_path(token)
        if ".git" in {part.lower() for part in path.parts}:
            return ("deny", "Direct terminal writes inside .git are blocked.")
        if is_within(path, global_config_roots):
            return ("deny", "Terminal writes to global agent configuration are blocked.")
        if is_dependency_manifest(path):
            return ("confirm", "Dependency manifest and lockfile changes require confirmation.")
    return None


def destructive_reason(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return None
    command, args = tokens[0], tokens[1:]
    if command == "rm":
        flags = "".join(token.lstrip("-") for token in args if token.startswith("-"))
        if ("r" in flags or "recursive" in flags) and ("f" in flags or "force" in flags):
            return "Recursive forced deletion is blocked."
    if command == "git" and args:
        subcommand = args[0]
        if subcommand == "reset" and "--hard" in args[1:]:
            return "git reset --hard is blocked."
        if subcommand == "checkout" and "--" in args[1:]:
            return "git checkout -- is blocked because it can discard changes."
        if subcommand == "restore":
            return "git restore is blocked because it can discard changes."
        if subcommand == "clean" and any("f" in token.lstrip("-") for token in args[1:] if token.startswith("-")):
            return "Forced git clean is blocked."
        if subcommand == "branch" and any(token in {"-D", "--delete", "--force"} for token in args[1:]):
            return "Destructive branch deletion is blocked."
        if subcommand == "tag" and any(token in {"-d", "--delete", "-f", "--force"} for token in args[1:]):
            return "Destructive tag mutation is blocked."
        if subcommand == "stash" and any(token in {"drop", "clear"} for token in args[1:]):
            return "Destructive stash removal is blocked."
        if subcommand == "reflog" and "expire" in args[1:]:
            return "Destructive reflog expiration is blocked."
    if command == "sudo":
        return "Privilege escalation is blocked."
    if command in {"psql", "mysql", "sqlcmd", "sqlite3"}:
        sql = " ".join(args).lower()
        if re.search(r"\b(drop\s+(?:database|table)|truncate\s+table|delete\s+from)\b", sql):
            return "Destructive SQL is blocked."
    return None


def confirmation_reason(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return "Empty command segment requires confirmation."
    command, args = tokens[0], tokens[1:]
    if command == "git" and args:
        if args[0] in {"push", "pull", "fetch", "clone", "rebase", "merge", "cherry-pick", "revert", "filter-branch", "filter-repo", "reset"}:
            return "Remote or history-changing Git operations require confirmation."
        if args[0] in {"add", "commit", "switch", "checkout"}:
            return "Staging, committing, or changing the checked-out branch requires explicit user authorization."
    if command == "pnpm" and args:
        action = args[0]
        if action in {"install", "add", "remove", "update", "up", "import", "patch", "link", "unlink", "dlx"}:
            return "Dependency changes or downloaded package execution require confirmation."
        script = args[1] if action == "run" and len(args) >= 2 else action
        if script in {"db:migrate", "repair"}:
            return "Database mutation requires confirmation."
        if script.startswith("pm2:"):
            return "PM2 process operations and log following require confirmation."
        if script == "format":
            return "Format-write can touch unrelated user changes and requires confirmation."
    if command in {"npm", "yarn"} and args and args[0] in {"install", "add", "remove", "uninstall", "update", "upgrade"}:
        return "Dependency changes require confirmation."
    if command == "pm2":
        return "PM2 process operations and log following require confirmation."
    if command in {"kubectl", "az", "aws", "gcloud", "ssh", "scp", "rsync", "terraform", "pulumi", "helm"}:
        return "Remote, cloud, or infrastructure operations require confirmation."
    if command in {"bash", "sh", "zsh"} and (not args or any(token in {"-c", "-lc"} for token in args)):
        return "Nested shell execution requires confirmation."
    if Path(command).name.lower() in {"deploy", "publish", "release", "upload"}:
        return "Deployment or publication requires confirmation."
    return None


def safe_git(tokens) -> bool:
    if len(tokens) < 2:
        return False
    subcommand = tokens[1]
    if subcommand in {"status", "diff", "show", "log", "rev-parse", "ls-files", "grep", "blame"}:
        return True
    if subcommand == "remote":
        return len(tokens) == 2 or tokens[2] in {"-v", "--verbose", "get-url"}
    if subcommand == "branch":
        return not any(token and not token.startswith("-") for token in tokens[2:])
    if subcommand == "tag":
        return len(tokens) == 2
    return False


def safe_package(tokens) -> bool:
    if len(tokens) < 2 or tokens[0] != "pnpm":
        return False
    if tokens[1] == "run":
        return len(tokens) >= 3 and tokens[2] in SAFE_SCRIPTS
    if tokens[1] == "exec":
        if len(tokens) < 3 or tokens[2] not in SAFE_EXEC_TOOLS:
            return False
        mutating_flags = {"--fix", "--write", "-w", "--update", "--update-snapshots", "-u"}
        return not any(token in mutating_flags for token in tokens[3:])
    return tokens[1] in SAFE_SCRIPTS


def safe_command(tokens) -> bool:
    tokens = strip_prefixes(tokens)
    if not tokens:
        return False
    command = tokens[0]
    if command == "cd":
        return len(tokens) == 2 and is_within(resolve_path(tokens[1]), [workspace_root])
    if command in {"pwd", "ls", "tree", "rg", "grep", "head", "tail", "cat", "wc", "jq", "yq", "diff", "stat", "file", "which", "type"}:
        return not (command == "rg" and any(token in {"--pre", "--pre-glob"} for token in tokens[1:]))
    if command == "find":
        return not any(token in {"-delete", "-exec", "-execdir", "-ok", "-okdir"} for token in tokens[1:])
    if command == "sed":
        return "-n" in tokens[1:] and not any(token.startswith("-i") for token in tokens[1:])
    if command == "awk":
        program = " ".join(tokens[1:]).lower()
        return not any(marker in program for marker in {"system(", "| getline", ">"})
    if command == "git":
        return safe_git(tokens)
    if command == "pnpm":
        return safe_package(tokens)
    if command == "codegraph":
        return len(tokens) >= 2 and tokens[1] in CODEGRAPH_READ_ONLY_COMMANDS
    if command == "bash" and len(tokens) >= 3 and tokens[1] == "-n":
        return is_within(resolve_path(tokens[2]), [workspace_root])
    if command == "shellcheck":
        return True
    if command == "rm":
        paths_to_remove = [token for token in tokens[1:] if not token.startswith("-")]
        flags = [token for token in tokens[1:] if token.startswith("-")]
        return bool(paths_to_remove) and all(flag in {"-f", "--"} for flag in flags) and all(is_within(resolve_path(path), [workspace_root]) for path in paths_to_remove)
    return False


is_shell_tool = any(marker in tool_name_l for marker in {"bash", "terminal", "run", "shell"})
if is_shell_tool:
    if not command_text:
        confirmation_block("The terminal command could not be determined from the hook payload.")
    try:
        segments = split_command(command_text)
    except ValueError:
        segments = None
    if not segments:
        confirmation_block("Opaque shell syntax, substitution, redirection, backgrounding, or embedded newlines require confirmation.")

    for index, segment in enumerate(segments):
        reason = destructive_reason(segment)
        if reason:
            deny("Destructive command blocked", reason)
        if index + 1 < len(segments):
            current = strip_prefixes(segment)
            following = strip_prefixes(segments[index + 1])
            if current and following and current[0] in {"curl", "wget"} and following[0] in {"sh", "bash", "zsh"}:
                deny("Remote script pipe blocked", "Piping downloaded content directly into a shell is blocked.")

    confirmation_reasons = []
    for segment in segments:
        decision = direct_write_decision(segment)
        if decision:
            kind, reason = decision
            if kind == "deny":
                deny("Protected write blocked", reason)
            confirmation_reasons.append(reason)
        for token in probable_path_tokens(segment):
            decision = path_decision(token)
            if decision:
                kind, reason = decision
                if kind == "deny":
                    deny("Protected path blocked", reason)
                confirmation_reasons.append(reason)

    for segment in segments:
        reason = confirmation_reason(segment)
        if reason:
            confirmation_reasons.append(reason)

    if not all(safe_command(segment) for segment in segments):
        confirmation_reasons.append("This terminal command is outside the Codex Usage safe allowlist.")
    if confirmation_reasons:
        confirmation_block(" ".join(dict.fromkeys(confirmation_reasons)))
    raise SystemExit(0)


path_strings = [PurePosixPath(path).as_posix() for path in paths]
contract_edit = any(
    re.search(r"(^|/)(src/server/app\.ts|src/shared/types\.ts|src/server/db/schema\.ts|drizzle/)", path, re.IGNORECASE)
    for path in path_strings
)
source_edit = write_tool and any(re.search(r"\.(?:ts|tsx|js|jsx|mjs|cjs)$", path, re.IGNORECASE) for path in path_strings)
test_edit = any(re.search(r"(?:test|spec|e2e|fixture)", path, re.IGNORECASE) for path in path_strings)
if contract_edit:
    warn(
        "Cross-layer contract or schema edit",
        "Review Hono routes, shared types, web API helpers, Drizzle SQL/meta, migration safety, and affected Vitest/Playwright coverage.",
    )
if source_edit and not test_edit and not re.search(r"test|vitest|playwright|typecheck|verification|verify", payload_l, re.IGNORECASE):
    warn(
        "Source edit without verification note",
        "Run the narrowest relevant typecheck, Vitest, Playwright, lint, or build check and repair/rerun failures before completion.",
    )

raise SystemExit(0)
PY
