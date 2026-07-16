import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import type { DashboardFilters } from "@/shared/types";
import { fetchModels, fetchStatus, syncSessions } from "@/web/lib/api";
import { ProductFilterBar } from "@/web/components/product-filter-bar";
import { SessionBrowser } from "@/web/components/session-browser";
import { Button } from "@/web/components/ui/button";
import {
  IMPORT_MUTATION_SCOPES,
  queueLiveMutationScopes,
  useLiveEventsFallbackActive,
} from "@/web/lib/live-events";
import { fetchProjectOptions, filtersFromSearch, updateFilterSearch } from "@/web/lib/product-api";

export function SessionsPage() {
  const liveEventsFallbackActive = useLiveEventsFallbackActive();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const queryClient = useQueryClient();
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => fetchModels(signal),
    staleTime: 5 * 60_000,
  });
  const projectOptionFilters = useMemo(() => {
    const value = { ...filters };
    delete value.projectId;
    return value;
  }, [filters]);
  const projects = useQuery({
    queryKey: ["projects", "options", projectOptionFilters],
    queryFn: ({ signal }) => fetchProjectOptions(projectOptionFilters, signal),
    staleTime: 5 * 60_000,
  });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => fetchStatus(signal),
    refetchInterval: (query) =>
      liveEventsFallbackActive ? (query.state.data?.isSyncing ? 2_000 : 30_000) : false,
    staleTime: 30_000,
  });
  const sync = useMutation({
    mutationFn: syncSessions,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      const repairs = [
        result.recordsReclassified > 0 ? `gán lại ${result.recordsReclassified} model` : null,
        result.recordsBackfilled > 0 ? `tính cost cho ${result.recordsBackfilled} usage` : null,
      ].filter(Boolean);
      toast.success(
        `Đã sync ${result.filesProcessed} file, thêm ${result.recordsInserted} usage event${repairs.length > 0 ? `; ${repairs.join(", ")}` : ""}.`,
      );
      queryClient.setQueryData(["status"], result);
      queueLiveMutationScopes(queryClient, IMPORT_MUTATION_SCOPES);
    },
  });

  function applyFilters(next: DashboardFilters) {
    setSearch(updateFilterSearch(search, next));
  }

  return (
    <div className="space-y-6">
      <section className="motion-reveal motion-delay-1 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Khám phá phiên</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Tìm kiếm, phân trang và xem breakdown agent theo từng session.
          </p>
        </div>
      </section>

      <ProductFilterBar
        filters={filters}
        models={models.data?.models ?? []}
        onChange={applyFilters}
        projects={(projects.data?.projects ?? []).map((project) => ({
          id: project.id,
          name: project.displayName,
        }))}
        showProject
      />
      <div className="flex justify-end">
        <Button
          aria-busy={sync.isPending}
          disabled={sync.isPending || Boolean(status.data?.isSyncing)}
          onClick={() => sync.mutate()}
        >
          <RefreshCw
            className={sync.isPending || status.data?.isSyncing ? "size-4 animate-spin" : "size-4"}
          />
          Sync ngay
        </Button>
      </div>

      <SessionBrowser
        key={JSON.stringify(filters)}
        filters={filters}
        onFiltersChange={applyFilters}
        pageSize={20}
        showExport
      />
    </div>
  );
}
