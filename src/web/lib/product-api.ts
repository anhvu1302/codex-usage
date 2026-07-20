import type {
  AgentFilters,
  AgentPageFilters,
  AgentPageQuery,
  AgentQuery,
  BudgetSetting,
  DashboardFilters,
  DismissAlertsResponse,
  PricingSimulationRequest,
  ProjectPageFilters,
  ProjectPageQuery,
  ProjectTagsResponse,
} from "@/shared/types";
import { apiClient, rpcJson, rpcOptions, toDashboardQuery } from "@/web/lib/rpc-client";

const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
});
const INTEGER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});
const PERCENT_FORMATTER = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

export function fetchOverview(filters: DashboardFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.overview.$get({ query: toDashboardQuery(filters) }, rpcOptions(signal)),
  );
}

export function fetchProjectsSummary(filters: DashboardFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.projects.summary.$get({ query: toDashboardQuery(filters) }, rpcOptions(signal)),
  );
}

export function fetchProjectsPage(filters: ProjectPageFilters, signal?: AbortSignal) {
  const query: ProjectPageQuery = {
    ...toDashboardQuery(filters),
    ...(filters.page === undefined ? {} : { page: String(filters.page) }),
    ...(filters.pageSize === undefined ? {} : { pageSize: String(filters.pageSize) }),
  };
  return rpcJson(apiClient.api.projects.page.$get({ query }, rpcOptions(signal)));
}

export function fetchProjectAnalytics(id: string, filters: DashboardFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.projects[":id"].analytics.$get(
      { param: { id: encodeURIComponent(id) }, query: toDashboardQuery(filters) },
      rpcOptions(signal),
    ),
  );
}

export function fetchProjectOptions(filters: DashboardFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.projects.options.$get({ query: toDashboardQuery(filters) }, rpcOptions(signal)),
  );
}

export function renameProject(id: string, displayName: string) {
  return rpcJson(
    apiClient.api.projects[":id"].$put({
      json: { displayName },
      param: { id: encodeURIComponent(id) },
    }),
  );
}

export function fetchTags(signal?: AbortSignal) {
  return rpcJson(apiClient.api.tags.$get(undefined, rpcOptions(signal)));
}

export function createTag(name: string) {
  return rpcJson(apiClient.api.tags.$post({ json: { name } }));
}

export function renameTag(id: string, name: string) {
  return rpcJson(
    apiClient.api.tags[":id"].$put({
      json: { name },
      param: { id: encodeURIComponent(id) },
    }),
  );
}

export function deleteTag(id: string) {
  return rpcJson(apiClient.api.tags[":id"].$delete({ param: { id: encodeURIComponent(id) } }));
}

export function replaceProjectTags(
  projectId: string,
  tagIds: string[],
): Promise<ProjectTagsResponse> {
  return rpcJson(
    apiClient.api.projects[":id"].tags.$put({
      json: { tagIds },
      param: { id: encodeURIComponent(projectId) },
    }),
  );
}

export function fetchAgentsSummary(filters: AgentFilters, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.agents.summary.$get({ query: toAgentQuery(filters) }, rpcOptions(signal)),
  );
}

export function fetchAgentsPage(filters: AgentPageFilters, signal?: AbortSignal) {
  const query: AgentPageQuery = {
    ...toAgentQuery(filters),
    ...(filters.order ? { order: filters.order } : {}),
    ...(filters.page === undefined ? {} : { page: String(filters.page) }),
    ...(filters.pageSize === undefined ? {} : { pageSize: String(filters.pageSize) }),
    ...(filters.sort ? { sort: filters.sort } : {}),
  };
  return rpcJson(apiClient.api.agents.page.$get({ query }, rpcOptions(signal)));
}

export function fetchBudgets(projectId?: string, signal?: AbortSignal) {
  return rpcJson(
    apiClient.api.budgets.$get(
      { query: projectId ? { project: projectId } : {} },
      rpcOptions(signal),
    ),
  );
}

export function saveBudget(budget: Omit<BudgetSetting, "updatedAt">) {
  return rpcJson(apiClient.api.budgets.$put({ json: budget }));
}

export function fetchAlerts(signal?: AbortSignal) {
  return rpcJson(apiClient.api.alerts.$get(undefined, rpcOptions(signal)));
}

export async function dismissAllAlerts(alertIds: string[]): Promise<DismissAlertsResponse> {
  const response = await apiClient.api.alerts.$delete();
  if (Number(response.status) !== 404) return rpcJson(response);

  let dismissedCount = 0;
  for (let index = 0; index < alertIds.length; index += 8) {
    const batch = alertIds.slice(index, index + 8);
    await Promise.all(batch.map((id) => updateAlert({ action: "dismiss", id })));
    dismissedCount += batch.length;
  }
  return { dismissedCount };
}

export function updateAlert({ action, id }: { action: "dismiss" | "seen"; id: string }) {
  return rpcJson(
    apiClient.api.alerts[":id"].$patch({
      json: { action },
      param: { id: encodeURIComponent(id) },
    }),
  );
}

export async function fetchPricingModels(signal?: AbortSignal) {
  const [models, rates] = await Promise.all([
    rpcJson(apiClient.api.models.$get(undefined, rpcOptions(signal))),
    rpcJson(apiClient.api.rates.$get(undefined, rpcOptions(signal))),
  ]);
  return { models: models.models, rates: rates.rates };
}

export function runPricingSimulation(payload: PricingSimulationRequest) {
  return rpcJson(apiClient.api.pricing.simulate.$post({ json: payload }));
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
  const tagIds = parseTagIds(search.get("tags"));
  const agentKind = search.get("agentKind")?.trim();
  if (models.length > 0) filters.models = [...new Set(models)];
  if (projectId) filters.projectId = projectId;
  if (tagIds.length > 0) filters.tagIds = tagIds;
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
  if (filters.tagIds?.length) next.set("tags", [...new Set(filters.tagIds)].join(","));
  else next.delete("tags");
  if (filters.agentKind && filters.agentKind !== "all") {
    next.set("agentKind", filters.agentKind);
  } else next.delete("agentKind");
  return next;
}

function parseTagIds(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((tagId) => tagId.trim())
        .filter((tagId) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tagId),
        ),
    ),
  ].slice(0, 50);
}

function toAgentQuery(filters: AgentFilters): AgentQuery {
  return {
    ...toDashboardQuery(filters),
    ...(filters.depth === undefined ? {} : { depth: String(filters.depth) }),
    ...(filters.role ? { role: filters.role } : {}),
  };
}

export function defaultDateRange(): DashboardFilters {
  const to = localDate(new Date());
  const from = shiftDate(to, -29);
  return { from, to };
}

export function localDate(value: Date): string {
  const values = Object.fromEntries(
    LOCAL_DATE_FORMATTER.formatToParts(value)
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
  return INTEGER_FORMATTER.format(value);
}

export function compactTokens(value: number): string {
  return COMPACT_FORMATTER.format(value);
}

export function formatUsd(value: number): string {
  return USD_FORMATTER.format(value);
}

export function formatPercent(value: number): string {
  return `${PERCENT_FORMATTER.format(value)}%`;
}

function validDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
