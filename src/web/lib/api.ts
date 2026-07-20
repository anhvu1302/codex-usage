import type {
  DailyMinuteReportQuery,
  DashboardFilters,
  ModelRate,
  SessionFilters,
} from "@/shared/types";
import { apiClient, rpcJson, rpcOptions, toDashboardQuery } from "@/web/lib/rpc-client";

export function fetchDashboard(filters: DashboardFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.dashboard.$get({ query: toDashboardQuery(filters) }, rpcOptions(signal)),
  );
}

export function fetchDailyMinuteReport(filters: DashboardFilters, signal?: AbortSignal) {
  const dashboardQuery = toDashboardQuery(filters);
  const query: DailyMinuteReportQuery = {
    date: filters.from,
    ...(dashboardQuery.agentKind ? { agentKind: dashboardQuery.agentKind } : {}),
    ...(dashboardQuery.model ? { model: dashboardQuery.model } : {}),
    ...(dashboardQuery.models ? { models: dashboardQuery.models } : {}),
    ...(dashboardQuery.project ? { project: dashboardQuery.project } : {}),
    ...(dashboardQuery.tags ? { tags: dashboardQuery.tags } : {}),
  };
  return rpcJson(apiClient.api.dashboard.minutes.$get({ query }, rpcOptions(signal)));
}

export function fetchSessionSummaries(filters: SessionFilters, signal?: AbortSignal) {
  const query = {
    ...toDashboardQuery(filters),
    ...(filters.query ? { q: filters.query } : {}),
    ...(filters.hasSubagents === undefined
      ? {}
      : { hasSubagents: filters.hasSubagents ? ("true" as const) : ("false" as const) }),
    ...(filters.order ? { order: filters.order } : {}),
    ...(filters.page ? { page: String(filters.page) } : {}),
    ...(filters.pageSize ? { pageSize: String(filters.pageSize) } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
  };
  return rpcJson(apiClient.api.sessions.summary.$get({ query }, rpcOptions(signal)));
}

export function fetchSessionDetail(
  sessionId: string,
  filters: DashboardFilters,
  signal?: AbortSignal,
) {
  return rpcJson(
    apiClient.api.sessions[":sessionId"].$get(
      {
        param: { sessionId: encodeURIComponent(sessionId) },
        query: toDashboardQuery(filters),
      },
      rpcOptions(signal),
    ),
  );
}

export function fetchStorageStatus(signal?: AbortSignal) {
  return rpcJson(apiClient.api.storage.status.$get(undefined, rpcOptions(signal)));
}

export function compactStorage() {
  return rpcJson(apiClient.api.storage.compact.$post());
}

export function fetchModels(signal?: AbortSignal) {
  return rpcJson(apiClient.api.models.$get(undefined, rpcOptions(signal)));
}

export function fetchRates(signal?: AbortSignal) {
  return rpcJson(apiClient.api.rates.$get(undefined, rpcOptions(signal)));
}

export function fetchStatus(signal?: AbortSignal) {
  return rpcJson(apiClient.api.status.$get(undefined, rpcOptions(signal)));
}

export function syncSessions() {
  return rpcJson(apiClient.api.sync.$post());
}

export function saveRate(rate: Omit<ModelRate, "updatedAt">) {
  const { model, ...json } = rate;
  return rpcJson(
    apiClient.api.rates[":model"].$put({
      json,
      param: { model: encodeURIComponent(model) },
    }),
  );
}

export function backfillRate(model: string) {
  return rpcJson(
    apiClient.api.rates[":model"].backfill.$post({
      param: { model: encodeURIComponent(model) },
    }),
  );
}
