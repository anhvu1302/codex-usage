import type { QueryClient } from "@tanstack/react-query";

import type { AgentFilters, SessionFilters } from "@/shared/types";
import { fetchActivitySummary } from "@/web/lib/activity-api";
import { fetchDashboard, fetchModels, fetchSessionSummaries } from "@/web/lib/api";
import {
  fetchAgentsPage,
  fetchAgentsSummary,
  fetchOverview,
  fetchProjectsPage,
  fetchProjectsSummary,
  filtersFromSearch,
} from "@/web/lib/product-api";
import { fetchTurns, turnFiltersFromSearch } from "@/web/lib/turns-api";

export const loadDashboardView = () => import("@/web/components/dashboard-view");
export const loadSessionsPage = () => import("@/web/components/sessions-page");
export const loadSettingsPage = () => import("@/web/components/settings-page");
export const loadProjectsPage = () => import("@/web/components/projects-page");
export const loadAgentsPage = () => import("@/web/components/agents-page");
export const loadActivityPage = () => import("@/web/components/activity-page");
export const loadTurnsPage = () => import("@/web/components/turns-page");

export function preloadRoute(pathname: string): void {
  switch (pathname) {
    case "/":
    case "/explore":
      void loadDashboardView();
      break;
    case "/sessions":
      void loadSessionsPage();
      break;
    case "/activity":
      void loadActivityPage();
      break;
    case "/agents":
      void loadAgentsPage();
      break;
    case "/projects":
      void loadProjectsPage();
      break;
    case "/settings":
      void loadSettingsPage();
      break;
    case "/turns":
      void loadTurnsPage();
      break;
  }
}

export async function prefetchPrimaryQuery(
  queryClient: QueryClient,
  pathname: string,
  search: URLSearchParams,
): Promise<void> {
  const filters = filtersFromSearch(search);
  const common = [
    queryClient.prefetchQuery({
      queryKey: ["models"],
      queryFn: ({ signal }) => fetchModels(signal),
      staleTime: 5 * 60_000,
    }),
  ];

  switch (pathname) {
    case "/":
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["overview", filters],
          queryFn: ({ signal }) => fetchOverview(filters, signal),
          staleTime: 30_000,
        }),
      );
      break;
    case "/explore":
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["dashboard", filters],
          queryFn: ({ signal }) => fetchDashboard(filters, signal),
          staleTime: 30_000,
        }),
      );
      break;
    case "/sessions": {
      const sessionFilters: SessionFilters = {
        ...filters,
        order: "desc",
        page: 1,
        pageSize: 20,
        sort: "lastActivity",
      };
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["sessions", "summary", sessionFilters],
          queryFn: ({ signal }) => fetchSessionSummaries(sessionFilters, signal),
          staleTime: 30_000,
        }),
      );
      break;
    }
    case "/activity": {
      const activityFilters = { ...filters };
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["activity", "summary", activityFilters],
          queryFn: ({ signal }) => fetchActivitySummary(activityFilters, signal),
          staleTime: 30_000,
        }),
      );
      break;
    }
    case "/agents": {
      const agentFilters: AgentFilters = { ...filters };
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["agents", "summary", agentFilters],
          queryFn: ({ signal }) => fetchAgentsSummary(agentFilters, signal),
          staleTime: 30_000,
        }),
        queryClient.prefetchQuery({
          queryKey: [
            "agents",
            "page",
            { ...agentFilters, order: "desc", page: 1, pageSize: 50, sort: "tokens" },
          ],
          queryFn: ({ signal }) =>
            fetchAgentsPage(
              { ...agentFilters, order: "desc", page: 1, pageSize: 50, sort: "tokens" },
              signal,
            ),
          staleTime: 30_000,
        }),
      );
      break;
    }
    case "/projects":
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["projects", "summary", filters],
          queryFn: ({ signal }) => fetchProjectsSummary(filters, signal),
          staleTime: 30_000,
        }),
        queryClient.prefetchQuery({
          queryKey: ["projects", "page", { ...filters, page: 1, pageSize: 50 }],
          queryFn: ({ signal }) => fetchProjectsPage({ ...filters, page: 1, pageSize: 50 }, signal),
          staleTime: 30_000,
        }),
      );
      break;
    case "/turns": {
      const turnFilters = turnFiltersFromSearch(search);
      common.push(
        queryClient.prefetchQuery({
          queryKey: ["turns", turnFilters],
          queryFn: ({ signal }) => fetchTurns(turnFilters, signal),
          staleTime: 30_000,
        }),
      );
      break;
    }
  }

  await Promise.all(common);
}
