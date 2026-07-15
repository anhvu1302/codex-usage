import type {
  ActivityFilters,
  ActivityKind,
  ActivityResponse,
  DataHealthResponse,
  ImportStatus,
  StorageStatus,
} from "@/shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = isErrorPayload(body) ? body.error : null;
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function activityQuery(filters: ActivityFilters): string {
  const values = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.agentKind && filters.agentKind !== "all") {
    values.set("agentKind", filters.agentKind);
  }
  if (filters.kinds?.length) values.set("kinds", filters.kinds.join(","));
  if (filters.projectId) values.set("project", filters.projectId);
  if (filters.sessionId) values.set("session", filters.sessionId);
  return values.toString();
}

export function fetchActivity(filters: ActivityFilters) {
  return request<ActivityResponse>(`/api/activity?${activityQuery(filters)}`);
}

export function fetchDataHealth() {
  return request<DataHealthResponse>("/api/data-health");
}

export function syncActivitySources() {
  return request<ImportStatus>("/api/sync", { method: "POST" });
}

export function compactActivityStorage() {
  return request<StorageStatus>("/api/storage/compact", { method: "POST" });
}

export function activityFiltersFromSearch(
  search: URLSearchParams,
  fallback: { from: string; to: string },
): ActivityFilters {
  const from = validDate(search.get("from")) ?? fallback.from;
  const to = validDate(search.get("to")) ?? fallback.to;
  const filters: ActivityFilters = from <= to ? { from, to } : fallback;
  const agentKind = search.get("agentKind");
  const kinds = parseKinds(search.get("kinds"));
  const projectId = search.get("project")?.trim();
  const sessionId = search.get("session")?.trim();
  if (agentKind === "main" || agentKind === "subagent") filters.agentKind = agentKind;
  if (kinds.length > 0) filters.kinds = kinds;
  if (projectId) filters.projectId = projectId;
  if (sessionId) filters.sessionId = sessionId;
  return filters;
}

export function updateActivitySearch(
  current: URLSearchParams,
  filters: ActivityFilters,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set("from", filters.from);
  next.set("to", filters.to);
  setOptional(next, "agentKind", filters.agentKind === "all" ? undefined : filters.agentKind);
  setOptional(next, "kinds", filters.kinds?.join(","));
  setOptional(next, "project", filters.projectId);
  setOptional(next, "session", filters.sessionId);
  return next;
}

const activityKinds = new Set<ActivityKind>([
  "abort",
  "compaction",
  "file",
  "mcp",
  "other",
  "patch",
  "shell",
  "task_completed",
  "task_started",
  "turn",
  "web",
]);

function parseKinds(value: string | null): ActivityKind[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter((kind): kind is ActivityKind => activityKinds.has(kind as ActivityKind)),
    ),
  ];
}

function setOptional(values: URLSearchParams, name: string, value: string | undefined) {
  if (value) values.set(name, value);
  else values.delete(name);
}

function validDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isErrorPayload(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}
