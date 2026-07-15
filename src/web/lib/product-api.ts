import type {
  AgentFilters,
  AgentsResponse,
  DashboardFilters,
  InsightsResponse,
  ProjectsResponse,
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

function dashboardQuery(filters: DashboardFilters): string {
  const values = new URLSearchParams({ from: filters.from, to: filters.to });
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  if (models.length > 0) values.set("models", models.join(","));
  if (filters.projectId) values.set("project", filters.projectId);
  if (filters.agentKind && filters.agentKind !== "all") values.set("agentKind", filters.agentKind);
  return values.toString();
}

export function fetchInsights(filters: DashboardFilters) {
  return request<InsightsResponse>(`/api/insights?${dashboardQuery(filters)}`);
}

export function fetchProjects(filters: DashboardFilters) {
  return request<ProjectsResponse>(`/api/projects?${dashboardQuery(filters)}`);
}

export function renameProject(id: string, displayName: string) {
  return request<{ project: { displayName: string; id: string } }>(
    `/api/projects/${encodeURIComponent(id)}`,
    { body: JSON.stringify({ displayName }), method: "PUT" },
  );
}

export function fetchAgents(filters: AgentFilters) {
  const values = new URLSearchParams(dashboardQuery(filters));
  if (filters.depth !== undefined) values.set("depth", String(filters.depth));
  if (filters.role) values.set("role", filters.role);
  return request<AgentsResponse>(`/api/agents?${values.toString()}`);
}

export function filtersFromSearch(search: URLSearchParams): DashboardFilters {
  const fallback = defaultDateRange();
  const from = validDate(search.get("from")) ?? fallback.from;
  const to = validDate(search.get("to")) ?? fallback.to;
  if (from > to) return fallback;

  const filters: DashboardFilters = { from, to };
  const models = (search.get("models") ?? search.get("model") ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const projectId = search.get("project")?.trim();
  const agentKind = search.get("agentKind")?.trim();
  if (models.length > 0) filters.models = [...new Set(models)];
  if (projectId) filters.projectId = projectId;
  if (agentKind === "main" || agentKind === "subagent") filters.agentKind = agentKind;
  return filters;
}

export function updateFilterSearch(
  current: URLSearchParams,
  filters: DashboardFilters,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set("from", filters.from);
  next.set("to", filters.to);
  next.delete("model");
  if (filters.models?.length) next.set("models", filters.models.join(","));
  else if (filters.model) next.set("models", filters.model);
  else next.delete("models");
  if (filters.projectId) next.set("project", filters.projectId);
  else next.delete("project");
  if (filters.agentKind && filters.agentKind !== "all") {
    next.set("agentKind", filters.agentKind);
  } else next.delete("agentKind");
  return next;
}

export function defaultDateRange(): DashboardFilters {
  const to = localDate(new Date());
  const from = shiftDate(to, -29);
  return { from, to };
}

export function localDate(value: Date): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

export function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function compactTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(value)}%`;
}

function validDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isErrorPayload(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}
