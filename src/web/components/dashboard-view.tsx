import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as TanStackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  CircleDollarSign,
  Columns3,
  Database,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useSearchParams } from "react-router";
import type { TooltipContentProps } from "recharts";
import { toast } from "sonner";

import {
  fetchDailyMinuteReport,
  fetchDashboard,
  fetchModels,
  fetchStatus,
  syncSessions,
} from "@/web/lib/api";
import { InsightsPanel } from "@/web/components/insights-panel";
import { MetricCard } from "@/web/components/metric-card";
import { ProductFilterBar } from "@/web/components/product-filter-bar";
import { AlertBanner } from "@/web/components/alerts";
import { SessionBrowser } from "@/web/components/session-browser";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import type { ChartConfig } from "@/web/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Skeleton } from "@/web/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import type {
  DailyModelUsage,
  DailyUsage,
  DashboardFilters,
  DashboardKpis,
  HourlyModelUsage,
  HourlyUsage,
  MinuteModelCall,
  MinuteUsageBucket,
  ModelUsage,
} from "@/shared/types";
import {
  fetchOverview,
  fetchProjectOptions,
  filtersFromSearch as parseUrlFilters,
  localDate,
  shiftDate,
  updateFilterSearch,
} from "@/web/lib/product-api";
import {
  IMPORT_MUTATION_SCOPES,
  queueLiveMutationScopes,
  useLiveEventsFallbackActive,
} from "@/web/lib/live-events";
import { assignModelColors } from "@/web/lib/model-colors";

const chartConfig = {
  cost: { color: "var(--foreground)", label: "Cost (USD)" },
} satisfies ChartConfig;
const DELTA_FORMATTER = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const INTEGER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});
const MINUTE_REPORT_TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
});
const loadDashboardCharts = () => import("@/web/components/dashboard-chart-primitives");
const Bar = lazy(async () => ({ default: (await loadDashboardCharts()).Bar }));
const CartesianGrid = lazy(async () => ({
  default: (await loadDashboardCharts()).CartesianGrid,
}));
const ComposedChart = lazy(async () => ({
  default: (await loadDashboardCharts()).ComposedChart,
}));
const Line = lazy(async () => ({ default: (await loadDashboardCharts()).Line }));
const Tooltip = lazy(async () => ({ default: (await loadDashboardCharts()).Tooltip }));
const XAxis = lazy(async () => ({ default: (await loadDashboardCharts()).XAxis }));
const YAxis = lazy(async () => ({ default: (await loadDashboardCharts()).YAxis }));
const ChartContainer = lazy(async () => ({
  default: (await loadDashboardCharts()).ChartContainer,
}));

const modelColumns: ColumnDef<ModelUsage>[] = [
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) => <span className="font-medium">{row.original.model}</span>,
  },
  {
    accessorKey: "requestCount",
    header: "Yêu cầu",
    cell: ({ row }) => formatTokens(row.original.requestCount),
  },
  {
    id: "uncachedInput",
    header: "Input",
    cell: ({ row }) => formatTokens(row.original.inputTokens - row.original.cachedInputTokens),
  },
  {
    accessorKey: "cachedInputTokens",
    header: "Cache",
    cell: ({ row }) => formatTokens(row.original.cachedInputTokens),
  },
  {
    id: "cacheRate",
    header: "Tỷ lệ cache",
    cell: ({ row }) =>
      formatPercent(safeRatio(row.original.cachedInputTokens, row.original.inputTokens) * 100),
  },
  {
    accessorKey: "outputTokens",
    header: "Output",
    cell: ({ row }) => formatTokens(row.original.outputTokens),
  },
  {
    accessorKey: "totalTokens",
    header: "Tổng",
    cell: ({ row }) => formatTokens(row.original.totalTokens),
  },
  {
    accessorKey: "estimatedCostUsd",
    header: "Cost",
    cell: ({ row }) => formatUsd(row.original.estimatedCostUsd),
  },
  {
    id: "costPerRequest",
    header: "Cost / yêu cầu",
    cell: ({ row }) =>
      formatUsd(safeRatio(row.original.estimatedCostUsd, row.original.requestCount)),
  },
  {
    accessorKey: "tokenShare",
    header: "Tỷ trọng",
    cell: ({ row }) => <ShareBar value={row.original.tokenShare} />,
  },
  {
    id: "unpriced",
    header: "Định giá",
    cell: ({ row }) =>
      row.original.unpricedUsageCount > 0 ? (
        <Badge variant="secondary">{row.original.unpricedUsageCount} chưa định giá</Badge>
      ) : (
        <Badge variant="outline">Đã định giá</Badge>
      ),
  },
];

type DashboardMode = "explore" | "overview";
type ChartMetric = "cost" | "requests" | "tokens";

export function DashboardView({ mode = "overview" }: { mode?: DashboardMode }) {
  const liveEventsFallbackActive = useLiveEventsFallbackActive();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const urlFilters = useMemo(() => parseUrlFilters(searchParameters), [searchParameters]);
  const [filters, setFilters] = useState<DashboardFilters>(urlFilters);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [isFiltering, startFiltering] = useTransition();
  const deferredFilters = filters;
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    enabled: mode === "explore",
    queryKey: ["dashboard", deferredFilters],
    queryFn: ({ signal }) => fetchDashboard(deferredFilters, signal),
    staleTime: 30_000,
  });
  const overview = useQuery({
    enabled: mode === "overview",
    queryKey: ["overview", deferredFilters],
    queryFn: ({ signal }) => fetchOverview(deferredFilters, signal),
    staleTime: 30_000,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => fetchModels(signal),
    staleTime: 5 * 60_000,
  });
  const projectOptionFilters = useMemo(() => {
    const value = { ...deferredFilters };
    delete value.projectId;
    return value;
  }, [deferredFilters]);
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
  const showHourly = deferredFilters.from === deferredFilters.to;
  const dashboardData = mode === "overview" ? overview.data?.dashboard : dashboard.data;
  const dashboardError = mode === "overview" ? overview.error : dashboard.error;
  const dashboardIsLoading = mode === "overview" ? overview.isLoading : dashboard.isLoading;
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

  const table = useReactTable({
    columns: modelColumns,
    data: dashboardData?.models ?? [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: { columnVisibility, sorting },
  });

  useEffect(() => {
    if (!sameFilters(filters, urlFilters)) setFilters(urlFilters);
  }, [filters, urlFilters]);

  function applyFilters(next: DashboardFilters) {
    startFiltering(() => {
      setFilters(next);
      setSearchParameters(updateFilterSearch(searchParameters, next));
    });
  }

  const pageCopy = dashboardPageCopy(mode);
  const showMetrics = mode === "overview";
  const showCharts = true;

  return (
    <div className="space-y-6">
      <section className="motion-reveal motion-delay-1 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{pageCopy.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{pageCopy.description}</p>
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
          aria-busy={isFiltering}
          onClick={() => sync.mutate()}
          disabled={sync.isPending || Boolean(status.data?.isSyncing)}
        >
          <RefreshCw
            className={sync.isPending || status.data?.isSyncing ? "size-4 animate-spin" : "size-4"}
          />
          Sync ngay
        </Button>
      </div>

      <h2 className="sr-only">Dữ liệu usage đã lọc</h2>

      {mode === "overview" ? <AlertBanner /> : null}

      {dashboardError ? (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm">
            Không tải được dữ liệu: {dashboardError.message}
          </CardContent>
        </Card>
      ) : null}

      {showMetrics ? (
        <section className="motion-stagger grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {dashboardIsLoading ? (
            <MetricSkeletons />
          ) : (
            <Metrics
              data={dashboardData}
              days={inclusiveDays(deferredFilters.from, deferredFilters.to)}
              previous={overview.data?.insights.previous}
            />
          )}
        </section>
      ) : null}

      {mode === "overview" ? (
        <InsightsPanel
          data={overview.data?.insights}
          error={overview.error}
          isLoading={overview.isLoading}
        />
      ) : null}

      {showCharts ? (
        <section className="motion-stagger grid gap-4 xl:grid-cols-5">
          <DeferredChartSection>
            <Card className="xl:col-span-5">
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
                <div>
                  <CardTitle>Usage theo ngày</CardTitle>
                  <CardDescription className="mt-1">
                    Chọn một ngày để xem chi tiết theo giờ. Cost là số USD ước tính.
                  </CardDescription>
                </div>
                <MetricToggle value={chartMetric} onChange={setChartMetric} />
              </CardHeader>
              <CardContent>
                <UsageChart
                  data={dashboardData?.daily ?? []}
                  modelData={dashboardData?.dailyModels ?? []}
                  activeModels={selectedModels(filters)}
                  metric={chartMetric}
                  onBucketSelect={(date) => applyFilters({ ...filters, from: date, to: date })}
                  onModelSelect={(model) => applyFilters(toggleModelFilter(filters, model))}
                />
              </CardContent>
            </Card>
            {showHourly ? (
              <Card className="xl:col-span-5">
                <CardHeader>
                  <CardTitle>Usage theo giờ</CardTitle>
                  <CardDescription>
                    {deferredFilters.from} theo timezone Asia/Ho_Chi_Minh; token và cost theo từng
                    giờ.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {dashboardData && !dashboardData.retention.hourlyAvailable ? (
                    <div className="text-muted-foreground flex h-40 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm">
                      Dữ liệu này đã quá 90 ngày nên chỉ còn tổng theo ngày; breakdown theo giờ đã
                      được compact.
                    </div>
                  ) : (
                    <HourlyUsageChart
                      data={dashboardData?.hourly ?? []}
                      modelData={dashboardData?.hourlyModels ?? []}
                      metric={chartMetric}
                    />
                  )}
                </CardContent>
              </Card>
            ) : null}
            {mode === "overview" && showHourly ? (
              <DailyMinuteReportCard filters={deferredFilters} metric={chartMetric} />
            ) : null}
          </DeferredChartSection>
          <Card className="deferred-section overflow-hidden xl:col-span-5">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle>Chi tiết theo model</CardTitle>
                <CardDescription className="mt-1">
                  Yêu cầu canonical, input thường, cached input, output, token, cost và tỷ trọng.
                </CardDescription>
              </div>
              <ColumnPicker table={table} />
            </CardHeader>
            <CardContent className="p-0">
              <Table
                className="motion-table min-w-[1280px]"
                scrollLabel="Bảng breakdown usage theo model"
              >
                <TableHeader className="bg-card sticky top-0 z-10">
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id}>
                      {group.headers.map((header) => (
                        <TableHead key={header.id}>
                          {header.isPlaceholder ? null : header.column.getCanSort() ? (
                            <button
                              className="focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2"
                              onClick={header.column.getToggleSortingHandler()}
                              type="button"
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {header.column.getIsSorted() === "asc" ? (
                                <ArrowUp className="size-3" />
                              ) : header.column.getIsSorted() === "desc" ? (
                                <ArrowDown className="size-3" />
                              ) : null}
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  {!dashboardIsLoading && table.getRowModel().rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="text-muted-foreground h-24 text-center">
                        Chưa có usage trong khoảng này.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {mode === "overview" ? (
        <SessionBrowser
          key={JSON.stringify(deferredFilters)}
          filters={deferredFilters}
          onFiltersChange={applyFilters}
        />
      ) : null}
    </div>
  );
}

function MetricToggle({
  onChange,
  value,
}: {
  onChange: (metric: ChartMetric) => void;
  value: ChartMetric;
}) {
  const metrics: { id: ChartMetric; label: string }[] = [
    { id: "tokens", label: "Token" },
    { id: "cost", label: "Cost" },
    { id: "requests", label: "Yêu cầu" },
  ];
  return (
    <div className="bg-muted inline-flex rounded-lg p-1" aria-label="Metric biểu đồ">
      {metrics.map((metric) => (
        <Button
          key={metric.id}
          aria-pressed={value === metric.id}
          size="sm"
          variant={value === metric.id ? "outline" : "ghost"}
          onClick={() => onChange(metric.id)}
        >
          {metric.label}
        </Button>
      ))}
    </div>
  );
}

function DeferredChartSection({ children }: { children: React.ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible) return;
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div
      ref={container}
      className={`grid gap-4 xl:col-span-5${visible ? "" : "deferred-section"}`}
      style={visible ? undefined : { containIntrinsicSize: "900px" }}
    >
      {visible ? (
        <Suspense fallback={<ChartSectionSkeleton />}>{children}</Suspense>
      ) : (
        <ChartSectionSkeleton />
      )}
    </div>
  );
}

function ChartSectionSkeleton() {
  return (
    <Card aria-label="Đang tải biểu đồ" role="status">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-72 w-full" />
      </CardContent>
    </Card>
  );
}

function ColumnPicker({ table }: { table: TanStackTable<ModelUsage> }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Columns3 className="size-4" /> Cột
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-1 p-2">
        <p className="text-muted-foreground px-2 py-1 text-xs font-medium">Cột đang hiển thị</p>
        {table.getAllLeafColumns().map((column) => (
          <label
            key={column.id}
            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
          >
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={column.getIsVisible()}
              onChange={column.getToggleVisibilityHandler()}
            />
            {modelColumnLabel(column.id)}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Metrics({
  data,
  days,
  previous,
}: {
  data: Awaited<ReturnType<typeof fetchDashboard>> | undefined;
  days: number;
  previous: DashboardKpis | undefined;
}) {
  const kpis = data?.kpis;
  const previousKpis = previous;
  const cacheRate = safeRatio(kpis?.cachedInputTokens ?? 0, kpis?.inputTokens ?? 0);
  return (
    <>
      <MetricCard
        icon={<Activity className="size-4" />}
        label="Tổng token"
        value={formatTokens(kpis?.totalTokens ?? 0)}
        detail={`${formatTokens((kpis?.totalTokens ?? 0) / Math.max(days, 1))}/ngày`}
        trend={formatDelta(kpis?.totalTokens, previousKpis?.totalTokens)}
      />
      <MetricCard
        icon={<CircleDollarSign className="size-4" />}
        label="Cost ước tính"
        value={formatUsd(kpis?.estimatedCostUsd ?? 0)}
        detail={`${formatUsd(safeRatio(kpis?.estimatedCostUsd ?? 0, kpis?.requestCount ?? 0))}/request`}
        trend={formatDelta(kpis?.estimatedCostUsd, previousKpis?.estimatedCostUsd)}
      />
      <MetricCard
        icon={<Activity className="size-4" />}
        label="Yêu cầu"
        value={formatTokens(kpis?.requestCount ?? 0)}
        detail={`${formatTokens(safeRatio(kpis?.totalTokens ?? 0, kpis?.requestCount ?? 0))} token/request`}
        trend={formatDelta(kpis?.requestCount, previousKpis?.requestCount)}
      />
      <MetricCard
        icon={<ArrowDownToLine className="size-4" />}
        label="Input (non-cache)"
        value={formatTokens((kpis?.inputTokens ?? 0) - (kpis?.cachedInputTokens ?? 0))}
        detail={`Cache rate ${formatPercent(cacheRate * 100)}`}
      />
      <MetricCard
        icon={<Database className="size-4" />}
        label="Cached input"
        value={formatTokens(kpis?.cachedInputTokens ?? 0)}
        detail={`${formatPercent(cacheRate * 100)} tổng input`}
      />
      <MetricCard
        icon={<ArrowUpToLine className="size-4" />}
        label="Output"
        value={formatTokens(kpis?.outputTokens ?? 0)}
        detail={`${formatPercent(safeRatio(kpis?.reasoningOutputTokens ?? 0, kpis?.outputTokens ?? 0) * 100)} reasoning`}
      />
      <MetricCard
        icon={<Database className="size-4" />}
        label="Phiên"
        value={String(kpis?.sessionCount ?? 0)}
        detail={`${formatTokens(safeRatio(kpis?.totalTokens ?? 0, kpis?.sessionCount ?? 0))} token/session`}
      />
      <MetricCard
        icon={<Sparkles className="size-4" />}
        label="Reasoning output"
        value={formatTokens(kpis?.reasoningOutputTokens ?? 0)}
        detail={`${formatPercent(safeRatio(kpis?.reasoningOutputTokens ?? 0, kpis?.outputTokens ?? 0) * 100)} output`}
      />
    </>
  );
}

function MetricSkeletons() {
  return (
    <>
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-28" />
      ))}
    </>
  );
}

function UsageChart({
  activeModels,
  data,
  metric,
  modelData,
  onBucketSelect,
  onModelSelect,
}: {
  activeModels: string[];
  data: DailyUsage[];
  metric: ChartMetric;
  modelData: DailyModelUsage[];
  onBucketSelect: (bucket: string) => void;
  onModelSelect: (model: string) => void;
}) {
  const [showTable, setShowTable] = useState(false);
  const chart = useMemo(
    () =>
      buildModelChart(
        data.map((usage) => ({
          bucket: usage.date,
          cost: usage.estimatedCostUsd,
          requestCount: usage.requestCount,
          totalTokens: usage.totalTokens,
        })),
        modelData.map((usage) => ({
          bucket: usage.date,
          cost: usage.estimatedCostUsd,
          model: usage.model,
          requestCount: usage.requestCount,
          totalTokens: usage.totalTokens,
        })),
        metric,
      ),
    [data, metric, modelData],
  );

  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-72 items-center justify-center rounded-lg border border-dashed text-sm">
        Chưa có usage trong khoảng thời gian này.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ModelLegend activeModels={activeModels} series={chart.series} onSelect={onModelSelect} />
      <ChartContainer
        config={chartConfig}
        role="img"
        aria-label={chartAriaLabel(metric, data.length, "ngày")}
      >
        <ComposedChart data={chart.points} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(value: string) => value.slice(5)}
            tickLine={false}
            axisLine={false}
          />
          {metric !== "cost" ? (
            <YAxis
              yAxisId="tokens"
              tickFormatter={(value: number) => compactNumber(value)}
              tickLine={false}
              axisLine={false}
              width={48}
            />
          ) : null}
          {metric !== "requests" ? (
            <YAxis
              yAxisId="cost"
              orientation="right"
              tickFormatter={(value: number) => `$${value.toFixed(1)}`}
              tickLine={false}
              axisLine={false}
              width={48}
            />
          ) : null}
          <Tooltip content={(props) => <ModelChartTooltip {...props} metric={metric} />} />
          {chart.series.map((series) => (
            <Bar
              key={series.dataKey}
              yAxisId={metric === "cost" ? "cost" : "tokens"}
              dataKey={series.dataKey}
              name={series.model}
              stackId={metric}
              fill={series.color}
              onClick={(_data, index) => {
                const point = chart.points.at(index);
                if (point) onBucketSelect(point.bucket);
              }}
            />
          ))}
          {metric === "tokens" ? (
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="cost"
              name="Cost"
              stroke="var(--foreground)"
              strokeWidth={2}
              dot={false}
            />
          ) : null}
        </ComposedChart>
      </ChartContainer>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={showTable}
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? "Ẩn dữ liệu dạng bảng" : "Xem dữ liệu dạng bảng"}
      </Button>
      {showTable ? (
        <ChartDataTable
          data={data}
          metric={metric}
          modelData={modelData}
          onSelect={onBucketSelect}
        />
      ) : null}
    </div>
  );
}

function DailyMinuteReportCard({
  filters,
  metric,
}: {
  filters: DashboardFilters;
  metric: ChartMetric;
}) {
  const today = useCurrentLocalDate();
  const isToday = filters.from === filters.to && filters.from === today;
  const report = useQuery({
    enabled: isToday,
    queryKey: ["dashboard", "minutes", filters],
    queryFn: ({ signal }) => fetchDailyMinuteReport(filters, signal),
    staleTime: 30_000,
  });

  if (!isToday) {
    return (
      <Card className="xl:col-span-5" data-testid="daily-minute-report">
        <CardHeader>
          <CardTitle>Chi tiết 5 phút</CardTitle>
          <CardDescription>
            Chi tiết 5 phút chỉ có cho hôm nay; ngày {filters.from} vẫn còn breakdown theo giờ.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="xl:col-span-5" data-testid="daily-minute-report">
      <CardHeader>
        <CardTitle>Chi tiết 5 phút hôm nay</CardTitle>
        <CardDescription>
          {filters.from} theo timezone Asia/Ho_Chi_Minh
          {report.data?.generatedAt
            ? `; cập nhật lúc ${MINUTE_REPORT_TIME_FORMATTER.format(new Date(report.data.generatedAt))}.`
            : "; token, cost và yêu cầu theo từng bucket 5 phút."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report.isLoading ? (
          <div className="space-y-3" aria-label="Đang tải báo cáo 5 phút" role="status">
            <Skeleton className="h-64" />
            <Skeleton className="h-24" />
          </div>
        ) : report.error ? (
          <div className="border-destructive/50 bg-destructive/5 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border px-6 text-center text-sm">
            <p>Không tải được chi tiết 5 phút: {report.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void report.refetch()}>
              Thử lại
            </Button>
          </div>
        ) : report.data && !report.data.available ? (
          <div className="text-muted-foreground flex min-h-40 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm">
            Chi tiết 5 phút chỉ có cho ngày {report.data.availableDate}; dữ liệu theo giờ vẫn được
            giữ theo retention hiện tại.
          </div>
        ) : (
          <MinuteUsageChart
            data={report.data?.buckets ?? []}
            metric={metric}
            modelCalls={report.data?.modelCalls ?? []}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MinuteUsageChart({
  data,
  metric,
  modelCalls,
}: {
  data: MinuteUsageBucket[];
  metric: ChartMetric;
  modelCalls: MinuteModelCall[];
}) {
  const latestUsageMinute = useMemo(
    () => data.findLast(hasMinuteUsage)?.minute ?? data.at(-1)?.minute ?? null,
    [data],
  );
  const [selectedMinute, setSelectedMinute] = useState<string | null>(() => latestUsageMinute);
  const [showTable, setShowTable] = useState(false);
  const dataByMinute = useMemo(
    () => new Map(data.map((bucket) => [bucket.minute, bucket])),
    [data],
  );
  const modelCallsByMinute = useMemo(() => groupMinuteModelCalls(modelCalls), [modelCalls]);
  const points = useMemo(
    () =>
      data.map((bucket) => ({
        ...bucket,
        value: chartMetricValue(metric, bucket),
      })),
    [data, metric],
  );
  const effectiveSelectedMinute =
    selectedMinute && dataByMinute.has(selectedMinute) ? selectedMinute : latestUsageMinute;
  const selected = effectiveSelectedMinute ? dataByMinute.get(effectiveSelectedMinute) : undefined;
  const currentMinute = data.at(-1)?.minute;
  const hasUsage = data.some(hasMinuteUsage);
  const moveSelection = (direction: -1 | 1) => {
    if (data.length === 0) return;
    const currentIndex = effectiveSelectedMinute
      ? data.findIndex((bucket) => bucket.minute === effectiveSelectedMinute)
      : data.length - 1;
    const nextIndex = Math.min(data.length - 1, Math.max(0, currentIndex + direction));
    setSelectedMinute(data.at(nextIndex)?.minute ?? null);
  };

  if (!hasUsage) {
    return (
      <div className="text-muted-foreground flex h-56 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm">
        Chưa có usage trong ngày hôm nay.
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <ChartContainer
        aria-describedby="minute-report-detail"
        aria-label={`${metricLabel(metric)} theo bucket 5 phút; dùng phím mũi tên trái hoặc phải để đổi bucket`}
        className="focus-visible:ring-ring h-64 rounded-md outline-none focus-visible:ring-2"
        config={chartConfig}
        data-testid="minute-report-chart"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            moveSelection(event.key === "ArrowLeft" ? -1 : 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            setSelectedMinute(data[0]?.minute ?? null);
          } else if (event.key === "End") {
            event.preventDefault();
            setSelectedMinute(data.at(-1)?.minute ?? null);
          }
        }}
        role="group"
        tabIndex={0}
      >
        <ComposedChart
          data={points}
          margin={{ left: 8, right: 8, top: 8 }}
          onClick={(state) => {
            if (typeof state?.activeLabel === "string") setSelectedMinute(state.activeLabel);
          }}
          onMouseMove={(state) => {
            if (typeof state?.activeLabel === "string") setSelectedMinute(state.activeLabel);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="minute" interval={11} tickLine={false} axisLine={false} />
          <YAxis
            yAxisId="metric"
            tickFormatter={(value: number) =>
              metric === "cost" ? `$${value.toFixed(1)}` : compactNumber(value)
            }
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            content={(props) => (
              <MinuteChartTooltip
                {...props}
                dataByMinute={dataByMinute}
                metric={metric}
                modelCallsByMinute={modelCallsByMinute}
              />
            )}
          />
          <Line
            yAxisId="metric"
            activeDot={{ r: 4 }}
            dataKey="value"
            dot={false}
            isAnimationActive={false}
            name={metricLabel(metric)}
            stroke="var(--chart-1)"
            strokeWidth={2}
            type="stepAfter"
          />
        </ComposedChart>
      </ChartContainer>

      {selected ? (
        <MinuteBucketDetail
          bucket={selected}
          current={selected.minute === currentMinute}
          modelCalls={modelCallsByMinute.get(selected.minute) ?? []}
        />
      ) : null}

      <Button
        aria-controls="minute-report-table"
        aria-expanded={showTable}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? "Ẩn dữ liệu dạng bảng" : "Xem dữ liệu dạng bảng"}
      </Button>
      {showTable ? <MinuteUsageTable data={data} modelCallsByMinute={modelCallsByMinute} /> : null}
    </div>
  );
}

function MinuteChartTooltip({
  active,
  dataByMinute,
  label,
  metric,
  modelCallsByMinute,
}: TooltipContentProps & {
  dataByMinute: Map<string, MinuteUsageBucket>;
  metric: ChartMetric;
  modelCallsByMinute: Map<string, MinuteModelCall[]>;
}) {
  if (!active || typeof label !== "string") return null;
  const bucket = dataByMinute.get(label);
  if (!bucket) return null;
  const modelCalls = modelCallsByMinute.get(bucket.minute) ?? [];
  return (
    <div className="bg-background min-w-52 space-y-1 rounded-md border p-3 text-sm shadow-md">
      <p className="font-medium">{bucket.minute}</p>
      <p>
        {metricLabel(metric)}: <strong>{formatChartMetric(metric, bucket)}</strong>
      </p>
      <p>Cost ước tính: {formatUsd(bucket.estimatedCostUsd)}</p>
      <p>Yêu cầu: {formatTokens(bucket.requestCount)}</p>
      {modelCalls.slice(0, 3).map((item) => (
        <p className="text-muted-foreground" key={item.model}>
          {item.model}: {formatTokens(item.requestCount)} lượt
        </p>
      ))}
      {modelCalls.length > 3 ? (
        <p className="text-muted-foreground">+{formatTokens(modelCalls.length - 3)} model khác</p>
      ) : null}
    </div>
  );
}

function MinuteBucketDetail({
  bucket,
  current,
  modelCalls,
}: {
  bucket: MinuteUsageBucket;
  current: boolean;
  modelCalls: MinuteModelCall[];
}) {
  const uncachedInput = Math.max(0, bucket.inputTokens - bucket.cachedInputTokens);
  const cacheRate = safeRatio(bucket.cachedInputTokens, bucket.inputTokens) * 100;
  return (
    <div
      className="bg-muted/40 space-y-3 rounded-lg border p-4"
      data-testid="minute-report-detail"
      id="minute-report-detail"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Bucket {bucket.minute}</p>
        {current ? <Badge variant="secondary">Đang cập nhật</Badge> : null}
      </div>
      <dl className="grid gap-3 text-sm min-[420px]:grid-cols-2 lg:grid-cols-4">
        <MinuteDetailValue label="Yêu cầu" value={formatTokens(bucket.requestCount)} />
        <MinuteDetailValue label="Input thường" value={formatTokens(uncachedInput)} />
        <MinuteDetailValue
          label="Cache"
          value={`${formatTokens(bucket.cachedInputTokens)} · ${formatPercent(cacheRate)}`}
        />
        <MinuteDetailValue label="Output" value={formatTokens(bucket.outputTokens)} />
        <MinuteDetailValue label="Reasoning" value={formatTokens(bucket.reasoningOutputTokens)} />
        <MinuteDetailValue label="Tổng token" value={formatTokens(bucket.totalTokens)} />
        <MinuteDetailValue label="Cost ước tính" value={formatUsd(bucket.estimatedCostUsd)} />
        <MinuteDetailValue label="Phiên" value={formatTokens(bucket.sessionCount)} />
      </dl>
      {bucket.unpricedUsageCount > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {formatTokens(bucket.unpricedUsageCount)}/{formatTokens(bucket.requestCount)} yêu cầu chưa
          định giá; cost hiện tại chỉ là subtotal.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">Cost đã được định giá đầy đủ.</p>
      )}
      <section aria-label={`Số lượt gọi model trong bucket ${bucket.minute}`} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Call theo model</p>
          <Badge variant="outline">{formatTokens(bucket.requestCount)} lượt</Badge>
        </div>
        {modelCalls.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {modelCalls.slice(0, 12).map((item) => (
              <li
                className="bg-background flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                key={item.model}
              >
                <span className="truncate" title={item.model}>
                  {item.model}
                </span>
                <strong className="shrink-0 tabular-nums">
                  {formatTokens(item.requestCount)} lượt
                </strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Bucket này chưa có model phát sinh call.</p>
        )}
        {modelCalls.length > 12 ? (
          <p className="text-muted-foreground text-sm">
            Còn {formatTokens(modelCalls.length - 12)} model khác trong bucket.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function MinuteDetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function MinuteUsageTable({
  data,
  modelCallsByMinute,
}: {
  data: MinuteUsageBucket[];
  modelCallsByMinute: Map<string, MinuteModelCall[]>;
}) {
  return (
    <div
      aria-label="Bảng chi tiết usage theo bucket 5 phút"
      className="overflow-x-auto rounded-lg border"
      id="minute-report-table"
      role="region"
      // A focusable scroll container keeps every table column keyboard-reachable.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <table className="w-full min-w-[70rem] text-sm">
        <caption className="sr-only">
          Usage hôm nay theo từng bucket 5 phút, timezone Asia/Ho_Chi_Minh
        </caption>
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left">Thời gian</th>
            <th className="px-3 py-2 text-right">Yêu cầu</th>
            <th className="px-3 py-2 text-right">Input thường</th>
            <th className="px-3 py-2 text-right">Cache</th>
            <th className="px-3 py-2 text-right">Output</th>
            <th className="px-3 py-2 text-right">Reasoning</th>
            <th className="px-3 py-2 text-right">Tổng token</th>
            <th className="px-3 py-2 text-right">Cost</th>
            <th className="px-3 py-2 text-right">Phiên</th>
            <th className="px-3 py-2 text-left">Call theo model</th>
            <th className="px-3 py-2 text-left">Độ phủ giá</th>
          </tr>
        </thead>
        <tbody>
          {data.map((bucket) => (
            <tr className="border-t" key={bucket.minute}>
              <th className="px-3 py-2 text-left font-medium" scope="row">
                {bucket.minute}
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.requestCount)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(Math.max(0, bucket.inputTokens - bucket.cachedInputTokens))}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.cachedInputTokens)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.outputTokens)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.reasoningOutputTokens)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.totalTokens)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatUsd(bucket.estimatedCostUsd)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatTokens(bucket.sessionCount)}
              </td>
              <td className="px-3 py-2">
                {formatMinuteModelCalls(modelCallsByMinute.get(bucket.minute) ?? [])}
              </td>
              <td className="px-3 py-2">
                {bucket.unpricedUsageCount > 0
                  ? `${formatTokens(bucket.unpricedUsageCount)}/${formatTokens(bucket.requestCount)} chưa định giá`
                  : "Đầy đủ"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HourlyUsageChart({
  data,
  metric,
  modelData,
}: {
  data: HourlyUsage[];
  metric: ChartMetric;
  modelData: HourlyModelUsage[];
}) {
  const [showTable, setShowTable] = useState(false);
  const chart = useMemo(
    () =>
      buildModelChart(
        data.map((usage) => ({
          bucket: usage.hour,
          cost: usage.estimatedCostUsd,
          requestCount: usage.requestCount,
          totalTokens: usage.totalTokens,
        })),
        modelData.map((usage) => ({
          bucket: usage.hour,
          cost: usage.estimatedCostUsd,
          model: usage.model,
          requestCount: usage.requestCount,
          totalTokens: usage.totalTokens,
        })),
        metric,
      ),
    [data, metric, modelData],
  );

  return (
    <div className="space-y-3">
      <ChartContainer
        config={chartConfig}
        role="img"
        aria-label={chartAriaLabel(metric, data.length, "giờ")}
      >
        <ComposedChart data={chart.points} margin={{ left: 8, right: 8, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="bucket" interval={2} tickLine={false} axisLine={false} />
          {metric !== "cost" ? (
            <YAxis
              yAxisId="tokens"
              tickFormatter={(value: number) => compactNumber(value)}
              tickLine={false}
              axisLine={false}
              width={48}
            />
          ) : null}
          {metric !== "requests" ? (
            <YAxis
              yAxisId="cost"
              orientation="right"
              tickFormatter={(value: number) => `$${value.toFixed(1)}`}
              tickLine={false}
              axisLine={false}
              width={48}
            />
          ) : null}
          <Tooltip content={(props) => <ModelChartTooltip {...props} metric={metric} />} />
          {chart.series.map((series) => (
            <Bar
              key={series.dataKey}
              yAxisId={metric === "cost" ? "cost" : "tokens"}
              dataKey={series.dataKey}
              name={series.model}
              stackId={metric}
              fill={series.color}
            />
          ))}
          {metric === "tokens" ? (
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="cost"
              name="Cost"
              stroke="var(--foreground)"
              strokeWidth={2}
              dot={false}
            />
          ) : null}
        </ComposedChart>
      </ChartContainer>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={showTable}
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? "Ẩn dữ liệu dạng bảng" : "Xem dữ liệu dạng bảng"}
      </Button>
      {showTable ? (
        <HourlyChartDataTable data={data} metric={metric} modelData={modelData} />
      ) : null}
    </div>
  );
}

type ModelChartPoint = {
  [key: string]: number | string;
  bucket: string;
  cost: number;
  requestCount: number;
  totalTokens: number;
};

function buildModelChart(
  totals: { bucket: string; cost: number; requestCount: number; totalTokens: number }[],
  modelUsage: {
    bucket: string;
    cost: number;
    model: string;
    requestCount: number;
    totalTokens: number;
  }[],
  metric: ChartMetric,
) {
  const metricValue = (usage: (typeof modelUsage)[number]) =>
    metric === "tokens" ? usage.totalTokens : metric === "cost" ? usage.cost : usage.requestCount;
  const modelNames = [
    ...new Set(modelUsage.filter((usage) => metricValue(usage) > 0).map((usage) => usage.model)),
  ].sort((left, right) => left.localeCompare(right));
  const colors = assignModelColors(modelNames);
  const series = modelNames.map((model, index) => ({
    color: colors.get(model) ?? "var(--chart-1)",
    dataKey: `model-${metric}-${index}`,
    model,
  }));
  const dataKeyByModel = new Map(series.map((item) => [item.model, item.dataKey]));
  const points = totals.map<ModelChartPoint>((total) => ({
    bucket: total.bucket,
    cost: total.cost,
    requestCount: total.requestCount,
    totalTokens: total.totalTokens,
  }));
  const pointByBucket = new Map(points.map((point) => [point.bucket, point]));

  for (const usage of modelUsage) {
    const point = pointByBucket.get(usage.bucket);
    const dataKey = dataKeyByModel.get(usage.model);
    const value = metricValue(usage);
    if (point && dataKey) Reflect.set(point, dataKey, value);
  }

  return { points, series };
}

function ModelChartTooltip({
  active,
  label,
  metric,
  payload,
}: TooltipContentProps & { metric: ChartMetric }) {
  if (!active || !payload?.length) return null;
  const cost = payload.find((entry) => entry.name === "Cost");
  const models = payload.filter((entry) => entry.name !== "Cost" && Number(entry.value) > 0);
  const total = models.reduce((value, entry) => value + Number(entry.value), 0);
  const totalLabel =
    metric === "tokens" ? "Tổng token" : metric === "cost" ? "Tổng cost" : "Tổng yêu cầu";

  return (
    <div className="bg-background min-w-56 space-y-2 rounded-md border p-3 text-sm shadow-md">
      <p className="font-medium">{String(label)}</p>
      {cost ? <p>Cost: {formatUsd(Number(cost.value))}</p> : null}
      <p className="font-semibold">
        {totalLabel}: {metric === "cost" ? formatUsd(total) : formatTokens(total)}
      </p>
      <div className="space-y-1">
        {models.map((entry) => (
          <p key={String(entry.dataKey)} style={{ color: entry.color }}>
            {entry.name}:{" "}
            {metric === "cost" ? formatUsd(Number(entry.value)) : formatTokens(Number(entry.value))}
          </p>
        ))}
      </div>
    </div>
  );
}

function ModelLegend({
  activeModels,
  onSelect,
  series,
}: {
  activeModels: string[];
  onSelect: (model: string) => void;
  series: { color: string; dataKey: string; model: string }[];
}) {
  return (
    <div className="flex flex-wrap justify-center gap-1" aria-label="Lọc theo model">
      {series.map((item) => (
        <button
          key={item.model}
          type="button"
          aria-pressed={activeModels.includes(item.model)}
          className="hover:bg-muted focus-visible:ring-ring aria-pressed:bg-muted inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-2"
          onClick={() => onSelect(item.model)}
        >
          <span
            className="size-2.5 rounded-sm"
            aria-hidden="true"
            style={{ backgroundColor: item.color }}
          />
          {item.model}
        </button>
      ))}
    </div>
  );
}

function ChartDataTable({
  data,
  metric,
  modelData,
  onSelect,
}: {
  data: DailyUsage[];
  metric: ChartMetric;
  modelData: DailyModelUsage[];
  onSelect: (date: string) => void;
}) {
  const modelsByDate = groupModelUsage(modelData, (usage) => usage.date);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">
          {metricTableCaption(metric, "ngày")}; chọn ngày ở dòng tổng để xem theo giờ
        </caption>
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left">Ngày</th>
            <th className="px-3 py-2 text-left">Model</th>
            <th className="px-3 py-2 text-right">{metricLabel(metric)}</th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((usage) => [
            <tr key={`${usage.date}-total`} className="border-t font-medium">
              <th scope="row" className="px-3 py-2 text-left">
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => onSelect(usage.date)}
                >
                  {usage.date}
                </button>
              </th>
              <th scope="row" className="px-3 py-2 text-left">
                Tất cả model
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatChartMetric(metric, usage)}
              </td>
            </tr>,
            ...(modelsByDate.get(usage.date) ?? []).map((model) => (
              <tr key={`${usage.date}-${model.model}`} className="border-t">
                <td className="px-3 py-2">{usage.date}</td>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {model.model}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatChartMetric(metric, model)}
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function HourlyChartDataTable({
  data,
  metric,
  modelData,
}: {
  data: HourlyUsage[];
  metric: ChartMetric;
  modelData: HourlyModelUsage[];
}) {
  const modelsByHour = groupModelUsage(modelData, (usage) => usage.hour);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">{metricTableCaption(metric, "giờ")}</caption>
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left">Giờ</th>
            <th className="px-3 py-2 text-left">Model</th>
            <th className="px-3 py-2 text-right">{metricLabel(metric)}</th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((usage) => [
            <tr key={`${usage.hour}-total`} className="border-t font-medium">
              <th scope="row" className="px-3 py-2 text-left">
                {usage.hour}
              </th>
              <th scope="row" className="px-3 py-2 text-left">
                Tất cả model
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatChartMetric(metric, usage)}
              </td>
            </tr>,
            ...(modelsByHour.get(usage.hour) ?? []).map((model) => (
              <tr key={`${usage.hour}-${model.model}`} className="border-t">
                <td className="px-3 py-2">{usage.hour}</td>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {model.model}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatChartMetric(metric, model)}
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function chartAriaLabel(metric: ChartMetric, buckets: number, granularity: string): string {
  const label =
    metric === "tokens"
      ? "token theo model"
      : metric === "cost"
        ? "cost theo model"
        : "yêu cầu theo model";
  return `Biểu đồ ${label}, ${buckets} mốc theo ${granularity}`;
}

function metricTableCaption(metric: ChartMetric, granularity: string): string {
  return `${metricLabel(metric)} theo ${granularity} và từng model`;
}

function metricLabel(metric: ChartMetric): string {
  switch (metric) {
    case "cost":
      return "Cost";
    case "requests":
      return "Yêu cầu";
    case "tokens":
      return "Token";
  }
}

function formatChartMetric(
  metric: ChartMetric,
  usage: { estimatedCostUsd: number; requestCount: number; totalTokens: number },
): string {
  switch (metric) {
    case "cost":
      return formatUsd(usage.estimatedCostUsd);
    case "requests":
      return formatTokens(usage.requestCount);
    case "tokens":
      return formatTokens(usage.totalTokens);
  }
}

function chartMetricValue(
  metric: ChartMetric,
  usage: { estimatedCostUsd: number; requestCount: number; totalTokens: number },
): number {
  switch (metric) {
    case "cost":
      return usage.estimatedCostUsd;
    case "requests":
      return usage.requestCount;
    case "tokens":
      return usage.totalTokens;
  }
}

function hasMinuteUsage(bucket: MinuteUsageBucket): boolean {
  return bucket.requestCount > 0 || bucket.totalTokens > 0 || bucket.estimatedCostUsd > 0;
}

function groupMinuteModelCalls(rows: MinuteModelCall[]): Map<string, MinuteModelCall[]> {
  const groups = new Map<string, MinuteModelCall[]>();
  for (const row of rows) {
    const values = groups.get(row.minute) ?? [];
    values.push(row);
    groups.set(row.minute, values);
  }
  for (const values of groups.values()) {
    values.sort(
      (left, right) =>
        right.requestCount - left.requestCount || left.model.localeCompare(right.model),
    );
  }
  return groups;
}

function formatMinuteModelCalls(rows: MinuteModelCall[]): string {
  if (rows.length === 0) return "—";
  return rows.map((row) => `${row.model}: ${formatTokens(row.requestCount)}`).join(" · ");
}

function groupModelUsage<T extends { model: string }>(
  rows: T[],
  bucket: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = bucket(row);
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  for (const values of groups.values()) {
    values.sort((left, right) => left.model.localeCompare(right.model));
  }
  return groups;
}

function ShareBar({ value }: { value: number }) {
  const percent = Math.min(100, Math.max(0, value * 100));
  const visiblePercent = percent > 0 ? Math.max(percent, 2) : 0;
  return (
    <div className="flex min-w-32 items-center gap-2">
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${visiblePercent}%` }} />
      </div>
      <span className="text-muted-foreground tabular-nums">{formatPercent(percent)}</span>
    </div>
  );
}

function sameFilters(left: DashboardFilters, right: DashboardFilters): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    selectedModels(left).join("\0") === selectedModels(right).join("\0") &&
    [...(left.tagIds ?? [])].sort().join("\0") === [...(right.tagIds ?? [])].sort().join("\0") &&
    left.projectId === right.projectId &&
    (left.agentKind ?? "all") === (right.agentKind ?? "all")
  );
}

function selectedModels(filters: DashboardFilters): string[] {
  if (filters.models?.length) return [...new Set(filters.models)];
  return filters.model ? [filters.model] : [];
}

function toggleModelFilter(filters: DashboardFilters, model: string): DashboardFilters {
  const selected = selectedModels(filters);
  const models = selected.includes(model)
    ? selected.filter((value) => value !== model)
    : [...selected, model];
  const next = { ...filters };
  delete next.model;
  if (models.length > 0) next.models = models;
  else delete next.models;
  return next;
}

function dashboardPageCopy(mode: DashboardMode): { description: string; title: string } {
  if (mode === "explore") {
    return {
      description: "Xem chi tiết token, cost và yêu cầu theo ngày, giờ và model.",
      title: "Khám phá mức sử dụng",
    };
  }
  return {
    description: "Ước tính theo rate card USD, timezone Asia/Ho_Chi_Minh.",
    title: "Tổng quan mức sử dụng",
  };
}

function modelColumnLabel(id: string): string {
  switch (id) {
    case "cachedInputTokens":
      return "Cached input";
    case "estimatedCostUsd":
      return "Cost";
    case "model":
      return "Model";
    case "outputTokens":
      return "Output";
    case "requestCount":
      return "Yêu cầu";
    case "tokenShare":
      return "Tỷ trọng";
    case "totalTokens":
      return "Tổng token";
    case "uncachedInput":
      return "Input";
    case "unpriced":
      return "Định giá";
    default:
      return id;
  }
}

function inclusiveDays(from: string | undefined, to: string | undefined): number {
  if (!from || !to) return 0;
  return Math.max(
    1,
    Math.round(
      (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000,
    ) + 1,
  );
}

function useCurrentLocalDate(): string {
  const [today, setToday] = useState(() => localDate(new Date()));

  useEffect(() => {
    let timer: number | undefined;
    const scheduleNextMidnight = () => {
      const current = localDate(new Date());
      setToday(current);
      const nextDate = shiftDate(current, 1);
      const nextMidnight = Date.parse(`${nextDate}T00:00:01+07:00`);
      timer = window.setTimeout(scheduleNextMidnight, Math.max(1_000, nextMidnight - Date.now()));
    };
    scheduleNextMidnight();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return today;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatDelta(current: number | undefined, previous: number | undefined): string | null {
  if (current === undefined || previous === undefined || previous === 0) return null;
  const delta = ((current - previous) / previous) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${DELTA_FORMATTER.format(delta)}%`;
}

function formatTokens(value: number): string {
  return INTEGER_FORMATTER.format(value);
}
function compactNumber(value: number): string {
  return COMPACT_FORMATTER.format(value);
}
function formatPercent(value: number): string {
  return PERCENT_FORMATTER.format(value) + "%";
}
function formatUsd(value: number): string {
  return USD_FORMATTER.format(value);
}
