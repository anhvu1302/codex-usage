import type {
  TurnComparisonResponse,
  TurnDetailResponse,
  TurnFilters,
  TurnsResponse,
} from "@/shared/types";
import { filtersFromSearch, updateFilterSearch } from "@/web/lib/product-api";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { "content-type": "application/json" } });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = isErrorPayload(body) ? body.error : null;
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function fetchTurns(filters: TurnFilters) {
  return request<TurnsResponse>(`/api/turns?${turnQuery(filters)}`);
}

export function fetchTurnDetail(turnKey: string) {
  return request<TurnDetailResponse>(`/api/turns/${encodeURIComponent(turnKey)}`);
}

export function fetchTurnComparison(ids: string[]) {
  const values = new URLSearchParams({ ids: ids.join(",") });
  return request<TurnComparisonResponse>(`/api/turns/compare?${values.toString()}`);
}

export function turnFiltersFromSearch(search: URLSearchParams): TurnFilters {
  const base = filtersFromSearch(search);
  const filters: TurnFilters = {
    ...base,
    order: search.get("order") === "asc" ? "asc" : "desc",
    page: positiveInteger(search.get("page")) ?? 1,
    pageSize: positiveInteger(search.get("pageSize")) ?? 25,
    sort: turnSort(search.get("sort")),
  };
  const query = search.get("q")?.trim();
  const effort = search.get("effort")?.trim();
  const sessionId = search.get("session")?.trim();
  const agentId = search.get("agent")?.trim();
  const status = search.get("status");
  const pressure = search.get("pressure");
  if (query) filters.query = query;
  if (effort) filters.effort = effort;
  if (sessionId) filters.sessionId = sessionId;
  if (agentId) filters.agentId = agentId;
  if (status === "completed" || status === "aborted" || status === "unknown") {
    filters.status = status;
  }
  if (
    pressure === "70" ||
    pressure === "70-84" ||
    pressure === "85" ||
    pressure === "85-94" ||
    pressure === "95" ||
    pressure === "95+" ||
    pressure === "below-70" ||
    pressure === "unknown"
  ) {
    filters.pressure = pressure;
  }
  return filters;
}

export function updateTurnSearch(current: URLSearchParams, filters: TurnFilters): URLSearchParams {
  const next = updateFilterSearch(current, filters);
  next.delete("ids");
  setOptional(next, "q", filters.query);
  setOptional(next, "effort", filters.effort);
  setOptional(next, "session", filters.sessionId);
  setOptional(next, "agent", filters.agentId);
  setOptional(next, "status", filters.status);
  setOptional(next, "pressure", filters.pressure);
  next.set("sort", filters.sort ?? "lastActivity");
  next.set("order", filters.order ?? "desc");
  next.set("page", String(filters.page ?? 1));
  next.set("pageSize", String(filters.pageSize ?? 25));
  return next;
}

function turnQuery(filters: TurnFilters): string {
  return updateTurnSearch(new URLSearchParams(), filters).toString();
}

function setOptional(values: URLSearchParams, key: string, value: string | undefined) {
  if (value) values.set(key, value);
  else values.delete(key);
}

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function turnSort(value: string | null): NonNullable<TurnFilters["sort"]> {
  return value === "context" ||
    value === "cost" ||
    value === "duration" ||
    value === "tokens" ||
    value === "ttft"
    ? value
    : "lastActivity";
}

function isErrorPayload(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}
