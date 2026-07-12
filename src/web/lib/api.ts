import type {
  DashboardFilters,
  DashboardResponse,
  ImportStatus,
  ModelRate,
  SessionUsage,
} from "@/shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = isErrorPayload(body) ? body.error : `Request failed (${response.status})`;
    throw new Error(typeof message === "string" ? message : "Request failed");
  }
  return response.json() as Promise<T>;
}

function query(filters: DashboardFilters) {
  const values = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.model) values.set("model", filters.model);
  return values.toString();
}

export function fetchDashboard(filters: DashboardFilters) {
  return request<DashboardResponse>(`/api/dashboard?${query(filters)}`);
}

export function fetchSessions(filters: DashboardFilters) {
  return request<SessionUsage[]>(`/api/sessions?${query(filters)}`);
}

export function fetchModels() {
  return request<{ models: string[] }>("/api/models");
}

export function fetchRates() {
  return request<{ rates: ModelRate[] }>("/api/rates");
}

export function fetchStatus() {
  return request<ImportStatus>("/api/status");
}

export function syncSessions() {
  return request<ImportStatus>("/api/sync", { method: "POST" });
}

export function saveRate(rate: Omit<ModelRate, "updatedAt">) {
  return request<{ backfilled: number; rate: ModelRate }>(
    `/api/rates/${encodeURIComponent(rate.model)}`,
    {
      body: JSON.stringify(rate),
      method: "PUT",
    },
  );
}

export function backfillRate(model: string) {
  return request<{ updated: number }>(`/api/rates/${encodeURIComponent(model)}/backfill`, {
    method: "POST",
  });
}

function isErrorPayload(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}
