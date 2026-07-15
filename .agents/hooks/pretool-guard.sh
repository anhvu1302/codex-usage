#!/usr/bin/env bash
set -euo pipefail

payload_text="$(cat || true)"
ANTIGRAVITY_HOOK_PAYLOAD="$payload_text" python3 - "$@" <<'PY'
import json
import os
import re
import shlex
from pathlib import Path
from urllib.parse import urlparse


payload_text = os.environ.get("ANTIGRAVITY_HOOK_PAYLOAD", "")
try:
    payload = json.loads(payload_text or "{}")
except Exception:
    payload = {}

tool_call = payload.get("toolCall") or {}
tool_name = str(tool_call.get("name") or "")
tool_name_l = tool_name.lower()
args = tool_call.get("args") or {}


def emit(decision: str, reason: str):
    print(json.dumps({"decision": decision, "reason": reason}, separators=(",", ":")))
    raise SystemExit(0)


def collect_values(value, keys, output):
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in keys and isinstance(item, str):
                output.append(item)
            collect_values(item, keys, output)
    elif isinstance(value, list):
        for item in value:
            collect_values(item, keys, output)


path_values = []
collect_values(
    args,
    {
        "absolutepath",
        "targetfile",
        "file",
        "filepath",
        "file_path",
        "path",
        "directorypath",
        "searchpath",
    },
    path_values,
)

content_values = []
collect_values(
    args,
    {"codecontent", "replacementcontent", "content", "newcontent"},
    content_values,
)

url_values = []
collect_values(args, {"url", "uri", "href", "domain", "targeturl"}, url_values)

command_text = str(
    args.get("CommandLine")
    or args.get("commandLine")
    or args.get("command")
    or ""
).strip()
command_cwd = str(args.get("Cwd") or args.get("cwd") or "").strip()

workspace_roots = []
for raw_root in payload.get("workspacePaths") or []:
    try:
        workspace_roots.append(Path(raw_root).expanduser().resolve(strict=False))
    except Exception:
        pass
if not workspace_roots:
    workspace_roots.append(Path.cwd().resolve(strict=False))

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


def resolve_path(raw_path: str, cwd: str = "") -> Path:
    path = Path(os.path.expandvars(raw_path)).expanduser()
    if not path.is_absolute():
        base = Path(cwd).expanduser() if cwd else workspace_roots[0]
        if not base.is_absolute():
            base = workspace_roots[0] / base
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


def protected_path_reason(path: Path, is_write: bool):
    parts = {part.lower() for part in path.parts}

    if is_env_file(path):
        return "Environment files may contain secrets; only .env.example, .env.template, and .env.sample are allowed."
    if is_live_codex_content(path):
        return "Direct access to live ~/.codex session or authentication data is blocked. Use sanitized repository fixtures."
    if is_write and ".git" in parts:
        return "Direct writes inside .git are blocked. Use normal Git commands instead."
    if is_write and is_within(path, global_config_roots):
        return "Global Codex, Claude, and Gemini configuration must not be modified for this project."
    return None


write_tools = {"write_to_file", "replace_file_content", "multi_replace_file_content"}
file_tools = write_tools | {"view_file"}

if tool_name_l in file_tools:
    is_write = tool_name_l in write_tools
    if not path_values:
        emit("ask", "The file target could not be determined from the tool payload.")

    resolved_paths = []
    for raw_path in path_values:
        path = resolve_path(raw_path, command_cwd)
        resolved_paths.append(path)
        reason = protected_path_reason(path, is_write)
        if reason:
            emit("deny", reason)
        if is_write and is_dependency_manifest(path):
            emit("force_ask", "Dependency manifest and lockfile changes require confirmation.")

    if all(is_within(path, workspace_roots) for path in resolved_paths):
        emit("allow", "Workspace file access is allowed by the Codex Usage project policy.")
    emit("ask", "File access outside the active Codex Usage workspace requires confirmation.")


def get_arg(mapping, *names):
    wanted = {name.lower() for name in names}
    if not isinstance(mapping, dict):
        return None
    for key, value in mapping.items():
        if str(key).lower() in wanted:
            return value
    return None


if tool_name_l == "define_subagent":
    name = str(get_arg(args, "name") or "").strip().lower()
    flags = {
        "enable_write_tools": get_arg(args, "enable_write_tools"),
        "enable_mcp_tools": get_arg(args, "enable_mcp_tools"),
        "enable_subagent_tools": get_arg(args, "enable_subagent_tools"),
    }
    prompt_l = str(get_arg(args, "system_prompt", "prompt") or "").lower()
    mcp_is_safe_codegraph = (
        flags["enable_mcp_tools"] is False
        or (
            flags["enable_mcp_tools"] is True
            and "codegraph" in prompt_l
            and "read-only" in prompt_l
            and ("one" in prompt_l or "single" in prompt_l)
        )
    )
    if (
        name == "repo-impact"
        and flags["enable_write_tools"] is False
        and flags["enable_subagent_tools"] is False
        and mcp_is_safe_codegraph
    ):
        emit("allow", "The Codex Usage impact subagent is read-only; MCP is allowed only for a single CodeGraph read-only lookup when requested.")
    emit("force_ask", "Only the bounded repo-impact definition is auto-approved; write tools, nested subagents, and non-CodeGraph MCP require confirmation.")

if tool_name_l == "invoke_subagent":
    specs = get_arg(args, "subagents")
    if not isinstance(specs, list) or not 1 <= len(specs) <= 2:
        emit("force_ask", "Subagent invocation must contain one or two bounded read-only roles.")
    allowed_types = {"research", "repo-impact"}
    seen_types = set()
    for spec in specs:
        type_name = str(get_arg(spec, "typename", "type_name") or "").strip().lower()
        workspace = str(get_arg(spec, "workspace") or "share").strip().lower()
        prompt = str(get_arg(spec, "prompt") or "").strip()
        if type_name not in allowed_types or type_name in seen_types or workspace != "share" or not prompt:
            emit("force_ask", "Only one shared-workspace research and/or repo-impact invocation is auto-approved.")
        seen_types.add(type_name)
    emit("allow", "Bounded Codex Usage read-only subagent invocation is allowed.")

if tool_name_l in {"manage_subagents", "send_message"}:
    emit("allow", "Subagent lifecycle and agent-to-agent communication are allowed.")


def split_command(command: str):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>")
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = list(lexer)
    segments = []
    current = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in {"&&", "||", ";", "&", "|"}:
            if current:
                segments.append(current)
                current = []
        elif token in {">", ">>", "<", "<<"}:
            target = tokens[index + 1] if index + 1 < len(tokens) else ""
            if target != "/dev/null":
                return None
            index += 1
        else:
            current.append(token)
        index += 1
    if current:
        segments.append(current)
    return segments


def strip_prefixes(tokens):
    result = list(tokens)
    while result and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", result[0]):
        result.pop(0)
    return result


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


def safe_repo_path(raw_path: str, cwd: str) -> bool:
    if re.search(r"[*?\[\]]", raw_path):
        return False
    return is_within(resolve_path(raw_path, cwd), workspace_roots)


def command_path_decision(token: str, cwd: str):
    value = token.strip()
    if not value or value.startswith("-") or "://" in value:
        return None
    path = resolve_path(value, cwd)
    if is_env_file(path):
        return ("deny", "Terminal access to real environment files is blocked; use .env.example.")
    if is_live_codex_content(path):
        return ("deny", "Direct terminal access to live ~/.codex session or authentication data is blocked.")
    if not is_within(path, workspace_roots):
        return ("force_ask", "Terminal file access outside the active workspace requires confirmation.")
    return None


def probable_path_tokens(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return []
    command = tokens[0]
    rest = tokens[1:]

    if command in {"rg", "grep"}:
        option_values = {
            "-e",
            "--regexp",
            "-g",
            "--glob",
            "--iglob",
            "-t",
            "--type",
            "-T",
            "--type-not",
            "--type-add",
            "--encoding",
            "--engine",
            "--replace",
        }
        positionals = []
        explicit_pattern = False
        index = 0
        while index < len(rest):
            token = rest[index]
            if token in option_values and index + 1 < len(rest):
                if token in {"-e", "--regexp"}:
                    explicit_pattern = True
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
        paths = []
        for token in rest:
            if token.startswith("-") or token in {"(", ")", "!"}:
                break
            paths.append(token)
        return paths

    if command == "codegraph" and rest:
        subcommand = rest[0]
        if subcommand not in CODEGRAPH_READ_ONLY_COMMANDS:
            return rest
        paths = []
        index = 1
        while index < len(rest):
            token = rest[index]
            if token in {"-p", "--path"} and index + 1 < len(rest):
                paths.append(rest[index + 1])
                index += 2
                continue
            if subcommand in {"status", "affected"} and not token.startswith("-"):
                paths.append(token)
            index += 1
        return paths

    if command == "git":
        return tokens[2:]
    return rest


def command_direct_write_decision(tokens, cwd: str):
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
        try:
            path = resolve_path(token, cwd)
        except Exception:
            continue
        if ".git" in {part.lower() for part in path.parts}:
            return ("deny", "Direct terminal writes inside .git are blocked.")
        if is_within(path, global_config_roots):
            return ("deny", "Terminal writes to global Codex, Claude, or Gemini configuration are blocked.")
        if is_dependency_manifest(path):
            return ("force_ask", "Dependency manifest and lockfile changes require confirmation.")
    return None


def destructive_segment_reason(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return None
    command = tokens[0]
    args = tokens[1:]

    if command == "rm":
        combined_flags = "".join(token.lstrip("-") for token in args if token.startswith("-"))
        recursive = "r" in combined_flags or "recursive" in combined_flags
        forced = "f" in combined_flags or "force" in combined_flags
        if recursive and forced:
            return "Recursive forced deletion is blocked."
    if command == "git" and args:
        subcommand = args[0]
        if subcommand == "reset" and "--hard" in args[1:]:
            return "git reset --hard is blocked."
        if subcommand == "checkout" and "--" in args[1:]:
            return "git checkout -- is blocked because it can discard workspace changes."
        if subcommand == "clean" and any("f" in token.lstrip("-") for token in args[1:] if token.startswith("-")):
            return "Forced git clean is blocked."
        if subcommand == "restore":
            return "git restore is blocked because it can discard workspace changes."
        if subcommand == "branch" and any(token in {"-D", "--delete", "--force"} for token in args[1:]):
            return "Forced or destructive branch deletion is blocked."
        if subcommand == "tag" and any(token in {"-d", "--delete", "-f", "--force"} for token in args[1:]):
            return "Forced or destructive tag mutation is blocked."
        if subcommand == "stash" and any(token in {"drop", "clear"} for token in args[1:]):
            return "Destructive stash removal is blocked."
        if subcommand == "reflog" and "expire" in args[1:]:
            return "Destructive reflog expiration is blocked."
    if command == "sudo":
        return "Privilege escalation is blocked."
    if command in {"db-reset", "db-drop", "seed-resync", "prod-restore"}:
        return "Destructive database or production recovery commands are blocked."
    if command in {"psql", "mysql", "sqlcmd", "sqlite3"}:
        sql_text = " ".join(args).lower()
        if re.search(r"\b(drop\s+(?:database|table)|truncate\s+table|delete\s+from)\b", sql_text):
            return "Destructive SQL is blocked."
    return None


def high_impact_segment_reason(tokens):
    tokens = strip_prefixes(tokens)
    if not tokens:
        return None
    command = tokens[0]
    args = tokens[1:]

    if command == "git" and args:
        subcommand = args[0]
        if subcommand in {
            "push",
            "pull",
            "fetch",
            "clone",
            "rebase",
            "merge",
            "cherry-pick",
            "revert",
            "filter-branch",
            "filter-repo",
            "reset",
        }:
            return "Remote or history-changing Git operations require confirmation."
        if subcommand in {"add", "commit", "switch", "checkout"}:
            return "Staging, committing, or changing the checked-out branch requires explicit user authorization."
    if command == "pnpm" and args:
        action = args[0]
        if action in {"install", "add", "remove", "update", "up", "import", "patch", "link", "unlink", "dlx"}:
            return "Dependency changes or downloaded package execution require confirmation."
        if action in {"db:migrate", "repair"} or (action == "run" and len(args) >= 2 and args[1] in {"db:migrate", "repair"}):
            return "Database mutation requires confirmation."
        script = args[1] if action == "run" and len(args) >= 2 else action
        if script.startswith("pm2:"):
            return "PM2 process mutation, inspection, or log following requires confirmation."
        if script == "format":
            return "Format-write can touch unrelated user changes and requires confirmation."
    if command == "npm" and args and args[0] in {"install", "uninstall", "update"}:
        return "Dependency changes require confirmation."
    if command == "yarn" and args and args[0] in {"add", "remove", "install", "upgrade"}:
        return "Dependency changes require confirmation."
    if command == "pm2":
        return "PM2 process mutation, inspection, or log following requires confirmation."
    if command == "docker" and len(args) >= 2 and args[0] == "compose" and args[1] in {"up", "down", "restart", "rm"}:
        return "Container mutation requires confirmation."
    if command in {"kubectl", "az", "aws", "gcloud", "ssh", "scp", "rsync"}:
        return "Cloud, remote-host, or external copy operations require confirmation."
    if command in {"terraform", "pulumi", "helm"}:
        return "Infrastructure or deployment operations require confirmation."
    if command in {"bash", "sh", "zsh"} and any(token in {"-c", "-lc"} for token in args):
        return "Nested shell execution requires confirmation."
    if Path(command).name.lower() in {"deploy", "publish", "release", "upload"}:
        return "Deployment, publication, release, or upload operations require confirmation."
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


def safe_package_command(tokens) -> bool:
    if not tokens or tokens[0] != "pnpm" or len(tokens) < 2:
        return False
    safe_scripts = {
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
    if tokens[1] == "run":
        return len(tokens) >= 3 and tokens[2] in safe_scripts
    if tokens[1] == "exec":
        if len(tokens) < 3 or tokens[2] not in {"vitest", "eslint", "prettier", "tsc", "playwright"}:
            return False
        mutating_flags = {"--fix", "--write", "-w", "--update", "--update-snapshots", "-u"}
        return not any(token in mutating_flags for token in tokens[3:])
    return tokens[1] in safe_scripts


def safe_validation_script(tokens, cwd: str) -> bool:
    if not tokens:
        return False
    script = ""
    if tokens[0] in {"bash", "sh"} and len(tokens) >= 2 and tokens[1] != "-n":
        script = tokens[1]
    elif tokens[0].startswith("./"):
        script = tokens[0]
    if not script or not re.search(r"(?i)(test|check|verify|validate|lint)", Path(script).name):
        return False
    return safe_repo_path(script, cwd)


def safe_simple_command(tokens, cwd: str) -> bool:
    tokens = strip_prefixes(tokens)
    if not tokens:
        return False
    command = tokens[0]

    if command == "cd":
        return len(tokens) == 2 and safe_repo_path(tokens[1], cwd)
    if command in {"pwd", "ls", "tree", "rg", "grep", "head", "tail", "cat", "wc", "jq", "yq", "diff", "stat", "file", "which", "type"}:
        if command == "rg" and any(token in {"--pre", "--pre-glob"} for token in tokens[1:]):
            return False
        return True
    if command == "find":
        return not any(token in {"-delete", "-exec", "-execdir", "-ok", "-okdir"} for token in tokens[1:])
    if command == "codegraph":
        return len(tokens) >= 2 and tokens[1] in CODEGRAPH_READ_ONLY_COMMANDS
    if command == "sed":
        return "-n" in tokens[1:] and not any(token.startswith("-i") for token in tokens[1:])
    if command == "awk":
        program = " ".join(tokens[1:]).lower()
        return not any(marker in program for marker in {"system(", "| getline", ">"})
    if command == "git":
        return safe_git(tokens)
    if command == "pnpm":
        return safe_package_command(tokens)
    if command == "bash":
        if len(tokens) >= 3 and tokens[1] == "-n":
            return safe_repo_path(tokens[2], cwd)
        return safe_validation_script(tokens, cwd)
    if command == "shellcheck":
        return True
    if command == "rm":
        paths = [token for token in tokens[1:] if not token.startswith("-")]
        flags = [token for token in tokens[1:] if token.startswith("-")]
        return bool(paths) and all(flag in {"-f", "--"} for flag in flags) and all(
            safe_repo_path(path, cwd) for path in paths
        )
    return safe_validation_script(tokens, cwd)


if tool_name_l == "run_command":
    if not command_text:
        emit("force_ask", "The terminal command could not be determined from the tool payload.")
    if re.search(r"[`]|\$\(|\r|\n", command_text):
        emit("force_ask", "Commands using substitution or embedded newlines require confirmation.")

    cwd = command_cwd or str(workspace_roots[0])
    try:
        segments = split_command(command_text)
    except ValueError:
        segments = None
    if segments:
        for index, segment in enumerate(segments):
            reason = destructive_segment_reason(segment)
            if reason:
                emit("deny", reason)
            if index + 1 < len(segments):
                current = strip_prefixes(segment)
                following = strip_prefixes(segments[index + 1])
                if current and following and current[0] in {"curl", "wget"} and following[0] in {"sh", "bash", "zsh"}:
                    emit("deny", "Piping downloaded content directly into a shell is blocked.")
        confirmation_reasons = []
        confirmation_decision = "ask"
        for segment in segments:
            decision = command_direct_write_decision(segment, cwd)
            if decision:
                kind, reason = decision
                if kind == "deny":
                    emit(kind, reason)
                confirmation_reasons.append(reason)
                if kind == "force_ask":
                    confirmation_decision = kind
            for token in probable_path_tokens(segment):
                decision = command_path_decision(token, cwd)
                if decision:
                    kind, reason = decision
                    if kind == "deny":
                        emit(kind, reason)
                    confirmation_reasons.append(reason)
                    if kind == "force_ask":
                        confirmation_decision = kind
        for segment in segments:
            reason = high_impact_segment_reason(segment)
            if reason:
                confirmation_reasons.append(reason)
                confirmation_decision = "force_ask"
        if confirmation_reasons:
            emit(confirmation_decision, " ".join(dict.fromkeys(confirmation_reasons)))
    if segments and all(safe_simple_command(segment, cwd) for segment in segments):
        emit("allow", "The command is composed only of Codex Usage-approved local development operations.")
    emit("force_ask", "This terminal command is outside the Codex Usage safe command allowlist.")


SAFE_READ_DOMAINS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "github.com",
    "npmjs.com",
    "npmjs.org",
    "nodejs.org",
    "hono.dev",
    "react.dev",
    "vite.dev",
    "vitest.dev",
    "playwright.dev",
    "orm.drizzle.team",
    "tailwindcss.com",
    "pnpm.io",
    "antigravity.google",
    "developers.google.com",
}


def extract_host(raw_url: str):
    value = raw_url.strip()
    if not value:
        return ""
    parsed = urlparse(value if "://" in value else f"https://{value}")
    return (parsed.hostname or "").lower()


def domain_allowed(host: str, allowed_domains) -> bool:
    return any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)


if tool_name_l == "read_url_content":
    hosts = [extract_host(value) for value in url_values]
    if hosts and all(domain_allowed(host, SAFE_READ_DOMAINS) for host in hosts):
        emit("allow", "Read-only access to localhost or an approved official development domain is allowed.")
    emit("force_ask", "Reading an unapproved external domain requires confirmation.")

if tool_name_l.startswith("browser_"):
    hosts = [extract_host(value) for value in url_values]
    local_domains = {"localhost", "127.0.0.1", "::1"}
    if hosts and all(domain_allowed(host, local_domains) for host in hosts):
        emit("allow", "Interactive browser work is allowed for local development targets.")
    emit("force_ask", "Browser interaction outside a clearly identified localhost target requires confirmation.")

if tool_name_l.startswith("mcp_"):
    mutation_markers = ("write", "create", "update", "delete", "remove", "send", "publish", "deploy", "execute")
    codegraph_read_only_markers = (
        "codegraph_search",
        "codegraph_node",
        "codegraph_callers",
        "codegraph_callees",
        "codegraph_explore",
        "codegraph_query",
        "codegraph_impact",
        "codegraph_affected",
        "codegraph_files",
        "codegraph_status",
    )
    if "codegraph" in tool_name_l and any(marker in tool_name_l for marker in codegraph_read_only_markers):
        emit("allow", "A read-only CodeGraph MCP operation is allowed.")
    if any(marker in tool_name_l for marker in mutation_markers):
        emit("force_ask", "Mutation-capable MCP operations require confirmation.")
    emit("force_ask", "Only read-only CodeGraph MCP operations are auto-approved for this workspace.")

emit("ask", "This tool call is not covered by the Codex Usage Antigravity allowlist.")
PY
