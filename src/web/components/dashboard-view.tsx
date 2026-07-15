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
  ChevronLeft,
  ChevronRight,
  Columns3,
  Database,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Link, useSearchParams } from "react-router";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { toast } from "sonner";

import {
  fetchDashboard,
  fetchModels,
  fetchSessions,
  fetchStatus,
  syncSessions,
} from "@/web/lib/api";
import { InsightsPanel } from "@/web/components/insights-panel";
import { MetricCard } from "@/web/components/metric-card";
import { ProductFilterBar } from "@/web/components/product-filter-bar";
import { AlertBanner, ExportActions } from "@/web/components/product-tools";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/web/components/ui/chart";
import { Input } from "@/web/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/web/components/ui/sheet";
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
  HourlyModelUsage,
  HourlyUsage,
  ModelUsage,
  SessionAgentUsage,
  SessionFilters,
  SessionUsage,
} from "@/shared/types";
import {
  fetchProjects,
  filtersFromSearch as parseUrlFilters,
  updateFilterSearch,
} from "@/web/lib/product-api";
import { assignModelColors } from "@/web/lib/model-colors";

const chartConfig = {
  cost: { color: "var(--foreground)", label: "Cost (USD)" },
} satisfies ChartConfig;

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

type DashboardMode = "explore" | "overview" | "sessions";
type ChartMetric = "cost" | "requests" | "tokens";

export function DashboardView({ mode = "overview" }: { mode?: DashboardMode }) {
  const [searchParameters, setSearchParameters] = useSearchParams();
  const urlFilters = useMemo(() => parseUrlFilters(searchParameters), [searchParameters]);
  const [filters, setFilters] = useState<DashboardFilters>(urlFilters);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [selectedSession, setSelectedSession] = useState<SessionUsage | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSort, setSessionSort] =
    useState<NonNullable<SessionFilters["sort"]>>("lastActivity");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [isFiltering, startFiltering] = useTransition();
  const desktopSessions = useSyncExternalStore(
    subscribeDesktopLayout,
    desktopLayoutSnapshot,
    () => false,
  );
  const deferredFilters = useDeferredValue(filters);
  const deferredSessionQuery = useDeferredValue(sessionQuery.trim());
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard", deferredFilters],
    queryFn: () => fetchDashboard(deferredFilters),
  });
  const sessionFilters = useMemo<SessionFilters>(
    () => ({
      ...deferredFilters,
      order: "desc",
      page: sessionPage,
      pageSize: mode === "sessions" ? 20 : 10,
      ...(deferredSessionQuery ? { query: deferredSessionQuery } : {}),
      sort: sessionSort,
    }),
    [deferredFilters, deferredSessionQuery, mode, sessionPage, sessionSort],
  );
  const sessions = useQuery({
    queryKey: ["sessions", sessionFilters],
    queryFn: () => fetchSessions(sessionFilters),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });
  const projectOptionFilters = useMemo(() => {
    const value = { ...deferredFilters };
    delete value.projectId;
    return value;
  }, [deferredFilters]);
  const projects = useQuery({
    queryKey: ["projects", "dashboard-options", projectOptionFilters],
    queryFn: () => fetchProjects(projectOptionFilters),
  });
  const status = useQuery({ queryKey: ["status"], queryFn: fetchStatus, refetchInterval: 10_000 });
  const showHourly = deferredFilters.from === deferredFilters.to;
  const previousFilters = useMemo(() => previousDateRange(deferredFilters), [deferredFilters]);
  const previousDashboard = useQuery({
    enabled: mode === "overview",
    queryKey: ["dashboard", "previous", previousFilters],
    queryFn: () => fetchDashboard(previousFilters),
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
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const table = useReactTable({
    columns: modelColumns,
    data: dashboard.data?.models ?? [],
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
      setSessionPage(1);
      setFilters(next);
      setSearchParameters(updateFilterSearch(searchParameters, next));
    });
  }

  const pageCopy = dashboardPageCopy(mode);
  const showMetrics = mode === "overview";
  const showCharts = mode !== "sessions";
  const showSessions = mode !== "explore";

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

      {dashboard.isError ? (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm">
            Không tải được dữ liệu: {dashboard.error.message}
          </CardContent>
        </Card>
      ) : null}

      {showMetrics ? (
        <section className="motion-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {dashboard.isLoading ? (
            <MetricSkeletons />
          ) : (
            <Metrics
              data={dashboard.data}
              days={inclusiveDays(deferredFilters.from, deferredFilters.to)}
              previous={previousDashboard.data}
            />
          )}
        </section>
      ) : null}

      {mode === "overview" ? <InsightsPanel /> : null}

      {showCharts ? (
        <section className="motion-stagger grid gap-4 xl:grid-cols-5">
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
                data={dashboard.data?.daily ?? []}
                modelData={dashboard.data?.dailyModels ?? []}
                models={models.data?.models ?? []}
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
                {dashboard.data && !dashboard.data.retention.hourlyAvailable ? (
                  <div className="text-muted-foreground flex h-40 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm">
                    Dữ liệu này đã quá 90 ngày nên chỉ còn tổng theo ngày; breakdown theo giờ đã
                    được compact.
                  </div>
                ) : (
                  <HourlyUsageChart
                    data={dashboard.data?.hourly ?? []}
                    modelData={dashboard.data?.hourlyModels ?? []}
                    models={models.data?.models ?? []}
                    metric={chartMetric}
                  />
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card className="overflow-hidden xl:col-span-5">
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
                  {!dashboard.isLoading && table.getRowModel().rows.length === 0 ? (
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

      {showSessions ? (
        <Card className="motion-reveal motion-delay-3 overflow-hidden">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Phiên
              {sessions.data ? <Badge variant="secondary">{sessions.data.total}</Badge> : null}
            </CardTitle>
            <CardDescription>
              Tìm task, session ID, workspace hoặc agent; chọn một dòng để xem chi tiết.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {sessions.data && sessions.data.coverage.status !== "full" ? (
              <div className="bg-muted/50 text-muted-foreground border-b px-6 py-3 text-sm">
                {sessions.data?.coverage.status === "partial"
                  ? `Chi tiết session chỉ còn từ ${sessions.data.coverage.from}; KPI và biểu đồ vẫn bao gồm rollup cũ.`
                  : "Khoảng này đã được compact nên không còn drill-down session; KPI và biểu đồ theo model/ngày vẫn được giữ."}
              </div>
            ) : null}
            <div className="grid gap-2 border-b p-4 sm:grid-cols-[minmax(16rem,1fr)_12rem_12rem]">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                />
                <Input
                  aria-label="Tìm session"
                  className="pl-9"
                  placeholder="Tìm task, ID, workspace, agent…"
                  value={sessionQuery}
                  onChange={(event) => {
                    setSessionQuery(event.target.value);
                    setSessionPage(1);
                  }}
                />
              </div>
              <Select
                value={filters.agentKind ?? "all"}
                onValueChange={(value) => {
                  const next = { ...filters };
                  if (value === "all") delete next.agentKind;
                  else next.agentKind = value as "main" | "subagent";
                  applyFilters(next);
                }}
              >
                <SelectTrigger aria-label="Lọc loại agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả agent</SelectItem>
                  <SelectItem value="main">Main agent</SelectItem>
                  <SelectItem value="subagent">Subagent</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sessionSort}
                onValueChange={(value) => {
                  setSessionSort(value as NonNullable<SessionFilters["sort"]>);
                  setSessionPage(1);
                }}
              >
                <SelectTrigger aria-label="Sắp xếp session">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lastActivity">Mới hoạt động</SelectItem>
                  <SelectItem value="tokens">Nhiều token</SelectItem>
                  <SelectItem value="cost">Cost cao</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {desktopSessions ? (
              <Table className="motion-table" scrollLabel="Bảng danh sách session">
                <TableHeader>
                  <TableRow>
                    <TableHead>Task / session</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Hoạt động cuối</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.data?.sessions.map((session) => (
                    <TableRow
                      key={session.sessionId}
                      className="cursor-pointer"
                      onClick={() => setSelectedSession(session)}
                    >
                      <TableCell className="max-w-96">
                        <button
                          type="button"
                          className="focus-visible:ring-ring block w-full rounded-sm text-left outline-none focus-visible:ring-2"
                          onClick={() => setSelectedSession(session)}
                        >
                          <span
                            className="block truncate font-medium"
                            title={session.title ?? undefined}
                          >
                            {session.title ?? "Chưa có tên task"}
                          </span>
                          <span className="text-muted-foreground mt-1 block font-mono text-xs">
                            {shortId(session.sessionId)}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <AgentSummary agents={session.agents} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {session.models.map((model) => (
                            <Badge key={model} variant="outline">
                              {model}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>{formatDateTime(session.lastEventAt)}</TableCell>
                      <TableCell>{formatTokens(session.totalTokens)}</TableCell>
                      <TableCell>{formatUsd(session.estimatedCostUsd)}</TableCell>
                    </TableRow>
                  ))}
                  {!sessions.isLoading && sessions.data?.sessions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                        Chưa có session.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            ) : (
              <SessionCards
                sessions={sessions.data?.sessions ?? []}
                onSelect={setSelectedSession}
              />
            )}
            {sessions.data && sessions.data.total > sessions.data.pageSize ? (
              <div className="flex flex-col items-center justify-between gap-3 border-t px-4 py-3 sm:flex-row">
                <p className="text-muted-foreground text-xs">
                  Trang {sessions.data.page}/
                  {Math.ceil(sessions.data.total / sessions.data.pageSize)} · {sessions.data.total}{" "}
                  session
                </p>
                <div className="flex gap-2">
                  <Button
                    aria-label="Trang session trước"
                    size="sm"
                    variant="outline"
                    disabled={sessions.data.page <= 1}
                    onClick={() => setSessionPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft className="size-4" /> Trước
                  </Button>
                  <Button
                    aria-label="Trang session tiếp theo"
                    size="sm"
                    variant="outline"
                    disabled={sessions.data.page * sessions.data.pageSize >= sessions.data.total}
                    onClick={() => setSessionPage((page) => page + 1)}
                  >
                    Sau <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {mode === "sessions" ? <ExportActions filters={sessionFilters} /> : null}

      <SessionSheet
        session={selectedSession}
        onOpenChange={(open) => !open && setSelectedSession(null)}
      />
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

function SessionCards({
  onSelect,
  sessions,
}: {
  onSelect: (session: SessionUsage) => void;
  sessions: SessionUsage[];
}) {
  return (
    <div className="grid gap-3 p-4 md:hidden">
      {sessions.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          className="bg-card hover:border-primary/30 focus-visible:ring-ring rounded-lg border p-4 text-left shadow-sm transition-[border-color,transform] hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => onSelect(session)}
        >
          <span className="block truncate font-medium">{session.title ?? "Chưa có tên task"}</span>
          <span className="text-muted-foreground mt-1 block font-mono text-xs">
            {shortId(session.sessionId)}
          </span>
          <span className="mt-3 flex flex-wrap gap-1">
            {session.models.map((model) => (
              <Badge key={model} variant="outline">
                {model}
              </Badge>
            ))}
          </span>
          <span className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <span>
              <span className="text-muted-foreground block">Token</span>
              <span className="font-semibold">{formatTokens(session.totalTokens)}</span>
            </span>
            <span>
              <span className="text-muted-foreground block">Cost</span>
              <span className="font-semibold">{formatUsd(session.estimatedCostUsd)}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Metrics({
  data,
  days,
  previous,
}: {
  data: Awaited<ReturnType<typeof fetchDashboard>> | undefined;
  days: number;
  previous: Awaited<ReturnType<typeof fetchDashboard>> | undefined;
}) {
  const kpis = data?.kpis;
  const previousKpis = previous?.kpis;
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
  models,
  onBucketSelect,
  onModelSelect,
}: {
  activeModels: string[];
  data: DailyUsage[];
  metric: ChartMetric;
  modelData: DailyModelUsage[];
  models: string[];
  onBucketSelect: (bucket: string) => void;
  onModelSelect: (model: string) => void;
}) {
  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-72 items-center justify-center rounded-lg border border-dashed text-sm">
        Chưa có usage trong khoảng thời gian này.
      </div>
    );
  }

  const chart = buildModelChart(
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
    models,
    metric,
  );

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
      <ChartDataTable data={data} metric={metric} modelData={modelData} onSelect={onBucketSelect} />
    </div>
  );
}

function HourlyUsageChart({
  data,
  metric,
  modelData,
  models,
}: {
  data: HourlyUsage[];
  metric: ChartMetric;
  modelData: HourlyModelUsage[];
  models: string[];
}) {
  const chart = buildModelChart(
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
    models,
    metric,
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
      <HourlyChartDataTable data={data} metric={metric} modelData={modelData} />
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
  models: string[],
  metric: ChartMetric,
) {
  const modelNames = [...new Set([...models, ...modelUsage.map((usage) => usage.model)])].sort(
    (left, right) => left.localeCompare(right),
  );
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
    const value =
      metric === "tokens" ? usage.totalTokens : metric === "cost" ? usage.cost : usage.requestCount;
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
    <table className="sr-only">
      <caption>{metricTableCaption(metric, "ngày")}; chọn ngày ở dòng tổng để xem theo giờ</caption>
      <thead>
        <tr>
          <th>Ngày</th>
          <th>Model</th>
          <th>{metricLabel(metric)}</th>
        </tr>
      </thead>
      <tbody>
        {data.flatMap((usage) => [
          <tr key={`${usage.date}-total`}>
            <th scope="row">
              <button type="button" onClick={() => onSelect(usage.date)}>
                {usage.date}
              </button>
            </th>
            <th scope="row">Tất cả model</th>
            <td>{formatChartMetric(metric, usage)}</td>
          </tr>,
          ...(modelsByDate.get(usage.date) ?? []).map((model) => (
            <tr key={`${usage.date}-${model.model}`}>
              <td>{usage.date}</td>
              <th scope="row">{model.model}</th>
              <td>{formatChartMetric(metric, model)}</td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
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
    <table className="sr-only">
      <caption>{metricTableCaption(metric, "giờ")}</caption>
      <thead>
        <tr>
          <th>Giờ</th>
          <th>Model</th>
          <th>{metricLabel(metric)}</th>
        </tr>
      </thead>
      <tbody>
        {data.flatMap((usage) => [
          <tr key={`${usage.hour}-total`}>
            <th scope="row">{usage.hour}</th>
            <th scope="row">Tất cả model</th>
            <td>{formatChartMetric(metric, usage)}</td>
          </tr>,
          ...(modelsByHour.get(usage.hour) ?? []).map((model) => (
            <tr key={`${usage.hour}-${model.model}`}>
              <td>{usage.hour}</td>
              <th scope="row">{model.model}</th>
              <td>{formatChartMetric(metric, model)}</td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
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

function SessionSheet({
  onOpenChange,
  session,
}: {
  onOpenChange: (open: boolean) => void;
  session: SessionUsage | null;
}) {
  return (
    <Sheet open={Boolean(session)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{session?.title ?? "Chưa có tên task"}</SheetTitle>
          <SheetDescription>
            {session ? `Session ${shortId(session.sessionId)}` : ""}
          </SheetDescription>
        </SheetHeader>
        {session ? (
          <div className="motion-stagger grid gap-4 text-sm">
            <Detail label="Workspace" value={session.cwd ?? "Không có CWD"} />
            <Detail label="Model" value={session.models.join(", ")} />
            <Detail
              label="Tổng token (main + subagents)"
              value={formatTokens(session.totalTokens)}
            />
            <Detail
              label="Input / cached / output"
              value={`${formatTokens(session.inputTokens)} / ${formatTokens(session.cachedInputTokens)} / ${formatTokens(session.outputTokens)}`}
            />
            <Detail label="Cost ước tính" value={formatUsd(session.estimatedCostUsd)} />
            <Detail label="Hoạt động đầu" value={formatDateTime(session.firstEventAt)} />
            <Detail label="Hoạt động cuối" value={formatDateTime(session.lastEventAt)} />
            <Detail
              label="Nguồn dữ liệu"
              value={session.sourceDeleted ? "Đã bị xoá (lịch sử vẫn lưu)" : "Còn trên ổ đĩa"}
            />
            <Button asChild className="justify-self-start" variant="outline">
              <Link to={`/turns?session=${encodeURIComponent(session.sessionId)}`}>
                Xem turns của session
              </Link>
            </Button>
            <AgentBreakdown agents={session.agents} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AgentSummary({ agents }: { agents: SessionAgentUsage[] }) {
  const subagents = agents.filter((agent) => agent.isSubagent);
  if (subagents.length === 0) return <Badge variant="outline">Chỉ main agent</Badge>;

  const names = subagents
    .map((agent) => agent.name ?? "Chưa đặt tên")
    .slice(0, 2)
    .join(", ");
  const remaining = subagents.length - 2;
  return (
    <div className="flex min-w-48 flex-wrap items-center gap-1">
      <Badge variant="secondary">
        {subagents.length} subagent{subagents.length === 1 ? "" : "s"}
      </Badge>
      <span className="text-muted-foreground text-xs">
        {names}
        {remaining > 0 ? ` +${remaining}` : ""}
      </span>
    </div>
  );
}

function AgentBreakdown({ agents }: { agents: SessionAgentUsage[] }) {
  const mainAgent = agents.find((agent) => !agent.isSubagent);
  const subagents = buildAgentTree(agents, mainAgent?.agentId);

  return (
    <section className="grid gap-3">
      <div>
        <h3 className="font-semibold">Chi tiết agent</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Token và cost đã được gán theo từng JSONL source của Codex.
        </p>
      </div>
      {mainAgent ? <AgentCard agent={mainAgent} /> : null}
      {subagents.length > 0 ? (
        <div className="motion-agent-list grid gap-2">
          <p className="text-muted-foreground text-xs font-medium uppercase">
            Subagent ({subagents.length})
          </p>
          {subagents.map(({ agent, visualDepth }) => (
            <div
              key={agent.agentId}
              className="border-primary/20 border-l-2 pl-2"
              style={{ marginLeft: `${Math.min(Math.max(visualDepth - 1, 0), 4) * 12}px` }}
            >
              <AgentCard agent={agent} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
          Session này không có subagent nào dùng token trong khoảng ngày đang lọc.
        </p>
      )}
    </section>
  );
}

function buildAgentTree(
  agents: SessionAgentUsage[],
  mainAgentId: string | undefined,
): { agent: SessionAgentUsage; visualDepth: number }[] {
  const subagents = agents.filter((agent) => agent.isSubagent);
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  const children = new Map<string, SessionAgentUsage[]>();
  const root = mainAgentId ?? "__session_root__";

  for (const agent of subagents) {
    const parent =
      agent.parentAgentId && agentIds.has(agent.parentAgentId) ? agent.parentAgentId : root;
    const values = children.get(parent) ?? [];
    values.push(agent);
    children.set(parent, values);
  }
  for (const values of children.values()) {
    values.sort(
      (left, right) =>
        left.depth - right.depth ||
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.agentId.localeCompare(right.agentId),
    );
  }

  const ordered: { agent: SessionAgentUsage; visualDepth: number }[] = [];
  const visited = new Set<string>();
  function visit(parentId: string, depth: number) {
    for (const agent of children.get(parentId) ?? []) {
      if (visited.has(agent.agentId)) continue;
      visited.add(agent.agentId);
      ordered.push({ agent, visualDepth: depth });
      visit(agent.agentId, depth + 1);
    }
  }

  visit(root, 1);
  for (const agent of subagents) {
    if (visited.has(agent.agentId)) continue;
    visited.add(agent.agentId);
    ordered.push({ agent, visualDepth: Math.max(1, agent.depth) });
    visit(agent.agentId, Math.max(2, agent.depth + 1));
  }
  return ordered;
}

function AgentCard({ agent }: { agent: SessionAgentUsage }) {
  const name = agent.isSubagent ? (agent.name ?? "Subagent chưa đặt tên") : "Main agent";
  return (
    <article className="hover:border-primary/25 grid gap-3 rounded-lg border p-3 transition-[border-color,box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant={agent.isSubagent ? "secondary" : "outline"}>
              {agent.isSubagent ? "Subagent" : "Main agent"}
            </Badge>
            {agent.role ? <Badge variant="outline">{agent.role}</Badge> : null}
            {agent.depth > 0 ? <Badge variant="outline">Depth {agent.depth}</Badge> : null}
            {agent.parentAgentId ? (
              <Badge variant="outline">Agent cha {shortId(agent.parentAgentId)}</Badge>
            ) : null}
            {agent.lastEventAt === null ? (
              <Badge variant="outline">Không có usage trong bộ lọc</Badge>
            ) : null}
            {agent.sourceDeleted ? <Badge variant="outline">Nguồn đã xoá</Badge> : null}
          </div>
        </div>
        <span className="text-muted-foreground font-mono text-xs">{shortId(agent.agentId)}</span>
      </div>
      {agent.taskSummary ? (
        <p className="text-muted-foreground text-xs">{agent.taskSummary}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <AgentMetric label="Token" value={formatTokens(agent.totalTokens)} />
        <AgentMetric label="Cost" value={formatUsd(agent.estimatedCostUsd)} />
        <AgentMetric label="Model" value={agent.models.join(", ") || "Không xác định"} />
        <AgentMetric
          label="Hoạt động cuối"
          value={agent.lastEventAt ? formatDateTime(agent.lastEventAt) : "—"}
        />
      </div>
    </article>
  );
}

function AgentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-md p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium break-words">{value}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-medium break-words">{value}</p>
    </div>
  );
}

function localDate(value: Date): string {
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

function sameFilters(left: DashboardFilters, right: DashboardFilters): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    selectedModels(left).join("\0") === selectedModels(right).join("\0") &&
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

function previousDateRange(filters: DashboardFilters): DashboardFilters {
  const from = new Date(`${filters.from}T12:00:00`);
  const to = new Date(`${filters.to}T12:00:00`);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
  const previousTo = new Date(from);
  previousTo.setDate(previousTo.getDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - days + 1);
  return {
    ...filters,
    from: localDate(previousFrom),
    to: localDate(previousTo),
  };
}

function dashboardPageCopy(mode: DashboardMode): { description: string; title: string } {
  if (mode === "explore") {
    return {
      description: "Xem chi tiết token, cost và yêu cầu theo ngày, giờ và model.",
      title: "Khám phá mức sử dụng",
    };
  }
  if (mode === "sessions") {
    return {
      description: "Xem task, model, main agent và subagent trong từng phiên.",
      title: "Khám phá phiên",
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

function subscribeDesktopLayout(callback: () => void): () => void {
  const media = window.matchMedia("(min-width: 768px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function desktopLayoutSnapshot(): boolean {
  return window.matchMedia("(min-width: 768px)").matches;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatDelta(current: number | undefined, previous: number | undefined): string | null {
  if (current === undefined || previous === undefined || previous === 0) return null;
  const delta = ((current - previous) / previous) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(delta)}%`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value) + "%";
}
function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}
function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
