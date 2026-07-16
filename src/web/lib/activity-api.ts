import type { ActivityFilters, ActivityKind, ActivityQuery } from "@/shared/types";
import { apiClient, rpcJson, rpcOptions, toDashboardQuery } from "@/web/lib/rpc-client";

function activityQuery(filters: ActivityFilters): ActivityQuery {
  return {
    ...toDashboardQuery(filters),
    ...(filters.kinds?.length ? { kinds: filters.kinds.join(",") } : {}),
    ...(filters.sessionId ? { session: filters.sessionId } : {}),
  };
}

export function fetchActivitySummary(filters: ActivityFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.activity.summary.$get({ query: activityQuery(filters) }, rpcOptions(signal)),
  );
}

export function fetchActivityTimeline(
  filters: ActivityFilters,
  options: { cursor?: string | undefined; limit?: number | undefined } = {},
  signal?: AbortSignal,
) {
  return rpcJson(
    apiClient.api.activity.timeline.$get(
      {
        query: {
          ...activityQuery(filters),
          ...(options.cursor ? { cursor: options.cursor } : {}),
          limit: String(options.limit ?? 200),
        },
      },
      rpcOptions(signal),
    ),
  );
}

export function fetchDataHealth(signal?: AbortSignal) {
  return rpcJson(apiClient.api["data-health"].$get(undefined, rpcOptions(signal)));
}

export function syncActivitySources() {
  return rpcJson(apiClient.api.sync.$post());
}

export function queueDeepVerification() {
  return rpcJson(apiClient.api.sync.deep.$post());
}

export function compactActivityStorage() {
  return rpcJson(apiClient.api.storage.compact.$post());
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
