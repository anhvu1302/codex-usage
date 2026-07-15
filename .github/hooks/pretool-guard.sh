#!/usr/bin/env bash
set -euo pipefail

payload="$(cat || true)"

COPILOT_HOOK_PAYLOAD="$payload" node --input-type=module - <<'JS'
const payloadText = process.env.COPILOT_HOOK_PAYLOAD ?? "";

let payload = {};
let payloadIsValid = true;
try {
  payload = JSON.parse(payloadText || "{}");
} catch {
  payload = {};
  payloadIsValid = false;
}

let rawToolInput = payload.toolArgs ?? payload.tool_input ?? payload.toolInput ?? {};
if (typeof rawToolInput === "string") {
  try {
    rawToolInput = JSON.parse(rawToolInput);
  } catch {
    rawToolInput = {};
    payloadIsValid = false;
  }
}
const toolInput = rawToolInput && typeof rawToolInput === "object" ? rawToolInput : {};
const toolName = String(payload.tool_name ?? payload.toolName ?? "").toLowerCase();
const filePaths = [];
const commands = [];

function walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      [
        "file",
        "filepath",
        "file_path",
        "path",
        "targetfile",
        "target_file",
        "absolutepath",
        "absolute_path",
      ].includes(normalizedKey) &&
      typeof item === "string"
    ) {
      filePaths.push(item);
    } else if (["files", "paths"].includes(normalizedKey) && Array.isArray(item)) {
      filePaths.push(...item.filter((entry) => typeof entry === "string"));
    } else if (
      ["command", "cmd", "script", "commandline", "command_line"].includes(normalizedKey) &&
      typeof item === "string"
    ) {
      commands.push(item);
    }
    walk(item);
  }
}

walk(toolInput);

const commandText = commands.join("\n");
for (const line of commandText.split("\n")) {
  const match = line.trim().match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
  if (match) filePaths.push(match[1].trim());
}

const paths = [...new Set(filePaths.map((entry) => entry.replaceAll("\\", "/")))];
const pathsLower = paths.map((entry) => entry.toLowerCase());
const commandLower = commandText.toLowerCase().replaceAll("\\", "/");
const payloadLower = payloadText.toLowerCase().replaceAll("\\", "/");

function emit(decision, reason = "", message = "") {
  const output = { permissionDecision: decision };
  if (reason || message) output.permissionDecisionReason = message || reason;
  console.log(JSON.stringify(output));
  process.exit(0);
}

function isRealEnvPath(value) {
  const name = value.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return ![".env.example", ".env.template", ".env.sample"].includes(name);
}

function commandMentionsRealEnv(value) {
  const withoutTemplates = value.replaceAll(
    /\.env\.(?:example|template|sample)\b/g,
    "<allowed-env-template>",
  );
  return /(^|[\s"'=:/])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s"';/|&])/.test(withoutTemplates);
}

function isFixtureJsonl(value) {
  const normalized = value.toLowerCase().replace(/^\.\//, "");
  return (
    normalized.startsWith("e2e/fixtures/sessions/") ||
    normalized.includes("/e2e/fixtures/sessions/")
  );
}

const isTerminalTool = /(terminal|bash|run)/.test(toolName);
const isMutatingTool = /(apply|edit|write|create|insert|replace|delete|terminal|bash|run)/.test(
  toolName,
);

if (!payloadIsValid || !toolName) {
  emit(
    "ask",
    "Unknown hook payload",
    "The tool target could not be classified safely. Confirm the operation before continuing.",
  );
}

if (pathsLower.some(isRealEnvPath)) {
  emit(
    "deny",
    "Real environment file blocked",
    "Real .env files are off limits. Use an allowed template without reading or changing local secrets.",
  );
}

if (isTerminalTool && commandMentionsRealEnv(commandLower)) {
  emit(
    "deny",
    "Real environment file command blocked",
    "Do not read, print, copy, edit, or delete a real .env file. Use an allowed template.",
  );
}

if (
  isMutatingTool &&
  pathsLower.some((entry) => entry.endsWith(".jsonl") && !isFixtureJsonl(entry))
) {
  emit(
    "deny",
    "Session JSONL mutation blocked",
    "Configured session JSONL is immutable input. Only fixtures under e2e/fixtures/sessions may be written.",
  );
}

if (
  isMutatingTool &&
  pathsLower.some((entry) => /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(entry))
) {
  emit(
    "deny",
    "Direct database artifact mutation blocked",
    "Do not edit or delete SQLite artifacts directly. Use application or migration paths against an isolated database.",
  );
}

const sessionMutation =
  /\b(?:rm|mv|cp|truncate|chmod|chown|unlink|sed\s+-i|perl\s+-pi)\b[^\n]*(?:\.jsonl|session_index|\.codex\/sessions|codex_sessions_dir)/;
if (isTerminalTool && sessionMutation.test(commandLower) && !isFixtureJsonl(commandLower)) {
  emit(
    "deny",
    "Session source mutation blocked",
    "Do not mutate configured session or title-index input. Change derived SQLite state instead.",
  );
}

const databaseArtifactMutation =
  /\b(?:rm|mv|truncate|chmod|chown|unlink)\b[^\n]*\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?\b/;
if (isTerminalTool && databaseArtifactMutation.test(commandLower)) {
  emit(
    "deny",
    "Direct database artifact mutation blocked",
    "Do not mutate SQLite artifacts directly. Use application or migration paths against an isolated database.",
  );
}

const destructiveCommand =
  /rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|git\s+clean\s+-[a-z]*f|drop\s+(?:database|table)|truncate\s+table|delete\s+from|drizzle-kit\s+drop|db:reset/;
if (isTerminalTool && destructiveCommand.test(commandLower)) {
  emit(
    "deny",
    "Destructive command blocked",
    "This command can destroy files, Git state, or database data. Stop and request explicit direction.",
  );
}

const bindingFiles = pathsLower.some((entry) =>
  /(?:^|\/)(?:src\/server\/index\.ts|vite\.config\.ts|playwright\.config\.ts|ecosystem\.config\.cjs)$/.test(
    entry,
  ),
);
const publicBinding =
  /\b0\.0\.0\.0\b|--host(?:=|\s+)(?:\[?::\]?|0\.0\.0\.0)|hostname\s*[:=]\s*["'](?:\[?::\]?|0\.0\.0\.0)/;
if (
  (isTerminalTool && publicBinding.test(commandLower)) ||
  (isMutatingTool && bindingFiles && publicBinding.test(payloadLower))
) {
  emit(
    "ask",
    "Loopback binding change",
    "Codex Usage must remain bound to 127.0.0.1. Confirm that this change does not expose it to the LAN or public interfaces.",
  );
}

const dependencyPath = pathsLower.some((entry) =>
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(entry),
);
if (isMutatingTool && dependencyPath) {
  emit(
    "ask",
    "Dependency change",
    "Confirm the dependency change is necessary, trusted, compatible with Node.js 24 and pnpm 11, and covered by install/build verification.",
  );
}

const sensitiveDataPath = pathsLower.some(
  (entry) =>
    /(?:^|\/)src\/server\/config\.ts$/.test(entry) ||
    /(?:^|\/)src\/server\/db\/schema\.ts$/.test(entry) ||
    /(?:^|\/)drizzle\.config\.ts$/.test(entry) ||
    /(?:^|\/)drizzle\//.test(entry),
);
if (isMutatingTool && sensitiveDataPath) {
  emit(
    "ask",
    "Storage or migration change",
    "Preserve the external runtime database default, use an isolated database for verification, and generate/review Drizzle migration metadata together.",
  );
}

const contractPath = pathsLower.some(
  (entry) =>
    /(?:^|\/)src\/shared\//.test(entry) ||
    /(?:^|\/)src\/server\/app\.ts$/.test(entry) ||
    /(?:^|\/)src\/web\/lib\/(?:api|activity-api|product-api)\.ts$/.test(entry),
);
if (isMutatingTool && contractPath) {
  emit(
    "ask",
    "Shared contract change",
    "Check Hono handlers, shared types, browser clients, React consumers, Vitest coverage, and Playwright flows together.",
  );
}

const highImpactCommand =
  /\b(?:pnpm\s+(?:run\s+)?(?:db:migrate|repair|pm2:(?:start|restart|stop|delete))|drizzle-kit\s+push|pnpm\s+(?:install|add|remove|update|publish)|npm\s+(?:install|publish)|git\s+(?:push|add|commit|switch|checkout)|pm2\s+(?:start|restart|stop|delete|save))\b/;
if (isTerminalTool && highImpactCommand.test(commandLower)) {
  emit(
    "ask",
    "High-impact command",
    "This changes dependencies, Git state, persistent SQLite data, or a managed process. Run it only with explicit user authorization.",
  );
}

const hasShellControl = /(?:&&|\|\||[;|><`]|\$\()/.test(commandText);
const safeLookup =
  /^\s*(?:rg|grep|find|ls|pwd|which|type|file|stat|du|wc|head|tail|cat|sed\s+-n|jq|git\s+(?:status|diff|show|log|rev-parse))\b/i;
const safeProjectCheck =
  /^\s*(?:pnpm\s+(?:run\s+)?(?:format:check|lint|typecheck|test|test:coverage|test:e2e|deadcode|audit:prod|build|build:web|build:server|verify|db:generate)|pnpm\s+exec\s+(?:vitest\s+run|playwright\s+test|tsc\s+--noEmit))\b/i;

if (
  isTerminalTool &&
  commandText.trim() &&
  !hasShellControl &&
  (safeLookup.test(commandText) || safeProjectCheck.test(commandText)) &&
  !/(?:--fix\b|--write\b|(?:^|\s)-w(?:\s|$)|--update(?:-snapshots?)?\b|(?:^|\s)-u(?:\s|$))/i.test(
    commandText,
  )
) {
  emit("allow");
}

const sourcePath = pathsLower.some((entry) => /\.(?:ts|tsx|js|jsx|css)$/.test(entry));
const testEvidence = /(?:\.test\.|\.spec\.|vitest|playwright|typecheck|verification|verify)/.test(
  payloadLower,
);
if (isMutatingTool && sourcePath && !testEvidence) {
  emit(
    "ask",
    "Source change without verification",
    "Add or run the narrowest relevant Vitest, Playwright, typecheck, lint, or build check, or document why it is not applicable.",
  );
}

if (isTerminalTool && commandText.trim()) {
  emit(
    "ask",
    "Unclassified terminal command",
    "This command is outside the conservative lookup and verification allowlist. Confirm its effects before running it.",
  );
}

emit("allow");
JS
