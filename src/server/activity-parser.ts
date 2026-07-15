import { createHash } from "node:crypto";

export const ACTIVITY_CATEGORIES = [
  "turn",
  "patch",
  "shell",
  "file",
  "mcp",
  "web",
  "other",
  "compaction",
  "abort",
  "task_start",
  "task_complete",
] as const;

export const ACTIVITY_TOOLS = ["shell", "patch", "file", "web", "mcp", "other"] as const;

type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export type ActivityTool = (typeof ACTIVITY_TOOLS)[number];

export type ParsedActivityEvent = {
  category: ActivityCategory;
  dedupeInput: string;
  eventHash: string;
  legacyEventHash: string;
  sessionId: string;
  timestamp: string;
  tool: ActivityTool;
};

export type ActivityParser = {
  readonly sessionId: string | null;
  parseLine(rawLine: string): ParsedActivityEvent | null;
};

type JsonRecord = Record<string, unknown>;

type ActivityClassification = {
  category: ActivityCategory;
  tool: ActivityTool;
};

const LEGACY_DEDUPE_VERSION = 1;
const FILE_TOOLS = new Set([
  "edit_file",
  "list_directory",
  "open_file",
  "read_file",
  "search_files",
  "view_image",
  "write_file",
]);
const PATCH_TOOLS = new Set(["apply_patch"]);
const SHELL_TOOLS = new Set([
  "bash",
  "exec_command",
  "run_terminal_cmd",
  "shell",
  "shell_command",
  "sh",
  "terminal.exec",
  "terminal_execute",
  "write_stdin",
]);
const WEB_TOOLS = new Set(["web.run", "web__run", "web_search"]);

export function normalizeActivityTool(toolName: unknown): ActivityTool {
  const normalizedName = asNonEmptyString(toolName)?.toLowerCase();
  if (!normalizedName) return "other";
  if (normalizedName.startsWith("mcp__") || normalizedName.startsWith("mcp.")) return "mcp";
  if (SHELL_TOOLS.has(normalizedName)) return "shell";
  if (PATCH_TOOLS.has(normalizedName)) return "patch";
  if (FILE_TOOLS.has(normalizedName)) return "file";
  if (WEB_TOOLS.has(normalizedName)) return "web";
  return "other";
}

export function hashActivityDedupeInput(dedupeInput: string): string {
  return createHash("sha256").update(dedupeInput).digest("hex");
}

export function parseActivityRecord(
  value: unknown,
  sessionId: string | null,
): ParsedActivityEvent | null {
  if (!isRecord(value)) return null;

  const payload = asRecord(value["payload"]);
  if (!payload) return null;

  const resolvedSessionId =
    asNonEmptyString(sessionId) ??
    asNonEmptyString(value["session_id"]) ??
    asNonEmptyString(payload["session_id"]);
  if (!resolvedSessionId) return null;

  const classification = classifyActivity(value, payload);
  if (!classification) return null;

  const timestamp = activityTimestamp(value, payload, classification.category);
  if (!timestamp) return null;

  const correlation = activityCorrelation(value, payload, classification.category, timestamp);
  const dedupeInput = JSON.stringify({
    correlation,
    identityKind: activityIdentityKind(value, payload),
    sessionId: resolvedSessionId,
  });
  const legacyDedupeInput = JSON.stringify({
    category: classification.category,
    correlation,
    sessionId: resolvedSessionId,
    tool: classification.tool,
    version: LEGACY_DEDUPE_VERSION,
  });

  return {
    category: classification.category,
    dedupeInput,
    eventHash: hashActivityDedupeInput(dedupeInput),
    legacyEventHash: hashActivityDedupeInput(legacyDedupeInput),
    sessionId: resolvedSessionId,
    timestamp,
    tool: classification.tool,
  };
}

function activityIdentityKind(record: JsonRecord, payload: JsonRecord): string {
  const recordType = asNonEmptyString(record["type"]) ?? "unknown";
  const payloadType = asNonEmptyString(payload["type"]) ?? "unknown";

  if (recordType === "turn_context") return "turn";
  if (recordType === "compacted" || payloadType === "context_compacted") return "compaction";
  if (payloadType === "task_started") return "task_started";
  if (payloadType === "task_complete") return "task_complete";
  if (payloadType === "turn_aborted") return "abort";
  if (payloadType === "web_search_call" || payloadType === "web_search_end") return "web_call";
  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "mcp_tool_call_end" ||
    payloadType === "patch_apply_end"
  ) {
    return "tool_call";
  }
  return `${recordType}:${payloadType}`;
}

export function parseActivityLine(
  rawLine: string,
  sessionId: string | null,
): ParsedActivityEvent | null {
  const record = parseJsonRecord(rawLine);
  return record ? parseActivityRecord(record, sessionId) : null;
}

export function createActivityParser(initialSessionId: string | null = null): ActivityParser {
  return new StatefulActivityParser(initialSessionId);
}

class StatefulActivityParser implements ActivityParser {
  private currentSessionId: string | null;

  constructor(initialSessionId: string | null) {
    this.currentSessionId = asNonEmptyString(initialSessionId);
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  parseLine(rawLine: string): ParsedActivityEvent | null {
    const record = parseJsonRecord(rawLine);
    if (!record) return null;

    this.currentSessionId ??= sessionIdFromMetadata(record);

    return parseActivityRecord(record, this.currentSessionId);
  }
}

function classifyActivity(record: JsonRecord, payload: JsonRecord): ActivityClassification | null {
  const recordType = asNonEmptyString(record["type"]);
  const payloadType = asNonEmptyString(payload["type"]);

  if (recordType === "turn_context") return { category: "turn", tool: "other" };
  if (recordType === "compacted") return { category: "compaction", tool: "other" };

  if (recordType === "event_msg") {
    switch (payloadType) {
      case "context_compacted":
        return { category: "compaction", tool: "other" };
      case "mcp_tool_call_end":
        return { category: "mcp", tool: "mcp" };
      case "patch_apply_end":
        return { category: "patch", tool: "patch" };
      case "task_complete":
        return { category: "task_complete", tool: "other" };
      case "task_started":
        return { category: "task_start", tool: "other" };
      case "turn_aborted":
        return { category: "abort", tool: "other" };
      case "web_search_end":
        return { category: "web", tool: "web" };
      default:
        return null;
    }
  }

  if (recordType !== "response_item") return null;
  if (payloadType === "web_search_call") return { category: "web", tool: "web" };
  if (payloadType !== "function_call" && payloadType !== "custom_tool_call") return null;

  const tool = normalizeActivityTool(payload["name"]);
  switch (tool) {
    case "mcp":
      return { category: "mcp", tool };
    case "patch":
      return { category: "patch", tool };
    case "shell":
      return { category: "shell", tool };
    case "web":
      return { category: "web", tool };
    case "file":
      return { category: "file", tool };
    case "other":
      return { category: "other", tool };
  }
}

function activityTimestamp(
  record: JsonRecord,
  payload: JsonRecord,
  category: ActivityCategory,
): string | null {
  const eventTimestamp = asValidTimestamp(record["timestamp"]);
  if (eventTimestamp) return eventTimestamp;

  if (category === "task_start") return asValidTimestamp(payload["started_at"]);
  if (category === "task_complete" || category === "abort") {
    return asValidTimestamp(payload["completed_at"]);
  }
  return null;
}

function activityCorrelation(
  record: JsonRecord,
  payload: JsonRecord,
  category: ActivityCategory,
  timestamp: string,
): string {
  if (category === "compaction") {
    const timestampSecond = new Date(timestamp).toISOString().slice(0, 19);
    return `timestamp-second:${timestampSecond}Z`;
  }

  const correlationId =
    asNonEmptyString(payload["call_id"]) ??
    asNonEmptyString(payload["id"]) ??
    asNonEmptyString(payload["turn_id"]) ??
    asNonEmptyString(payload["event_id"]) ??
    asNonEmptyString(record["id"]);
  return correlationId ? `id:${correlationId}` : `timestamp:${timestamp}`;
}

function sessionIdFromMetadata(record: JsonRecord): string | null {
  if (record["type"] !== "session_meta") return null;
  const payload = asRecord(record["payload"]);
  if (!payload) return null;
  return asNonEmptyString(payload["session_id"]) ?? asNonEmptyString(payload["id"]);
}

function parseJsonRecord(rawLine: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(rawLine);
    return asRecord(value);
  } catch {
    return null;
  }
}

function asValidTimestamp(value: unknown): string | null {
  const timestamp = asNonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
