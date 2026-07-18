import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bot,
  CalendarDays,
  Check,
  CircleDot,
  FileCode2,
  Filter,
  GitCommitHorizontal,
  Globe2,
  Layers3,
  Network,
  PanelTop,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useSearchParams } from "react-router";

import { DataHealthCenter } from "@/web/components/data-health-center";
import { DateRangePicker } from "@/web/components/date-range-picker";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/components/ui/tabs";
import {
  activityFiltersFromSearch,
  fetchActivitySummary,
  fetchActivityTimeline,
  updateActivitySearch,
} from "@/web/lib/activity-api";
import {
  defaultDateRange,
  fetchProjectOptions,
  formatTokens,
  formatUsd,
  localDate,
  shiftDate,
} from "@/web/lib/product-api";
import { cn } from "@/web/lib/utils";
import type {
  ActivityDailyUsage,
  ActivityFilters,
  ActivityKind,
  ActivitySummary,
  ActivityTimelineItem,
  DashboardFilters,
} from "@/shared/types";

type ProjectOption = { displayName: string; id: string };

type TrendGrouping = "agent" | "kind" | "project";
type ActivityTab = "health" | "overview" | "timeline";
type HeatmapMetric = "cost" | "events" | "tokens";
type HeatmapDay = ActivityDailyUsage & { eventCount: number };
type TrendPoint = Record<string, number | string> & { date: string };
type TrendSeries = { color: string; id: string; label: string };
type TimelineAgentNode = {
  agent: ActivityTimelineItem;
  children: TimelineAgentNode[];
  events: ActivityTimelineItem[];
};

const activityKindOptions: {
  icon: typeof Activity;
  kind: ActivityKind;
  label: string;
}[] = [
  { icon: Activity, kind: "turn", label: "Turn" },
  { icon: GitCommitHorizontal, kind: "patch", label: "Patch / edit" },
  { icon: Terminal, kind: "shell", label: "Shell" },
  { icon: FileCode2, kind: "file", label: "File" },
  { icon: Globe2, kind: "web", label: "Web search" },
  { icon: Network, kind: "mcp", label: "MCP" },
  { icon: Layers3, kind: "compaction", label: "Context compaction" },
  { icon: AlertOctagon, kind: "abort", label: "Abort" },
  { icon: PanelTop, kind: "task_started", label: "Task start" },
  { icon: Check, kind: "task_completed", label: "Task complete" },
  { icon: Wrench, kind: "other", label: "Other tool" },
];
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
});
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const highlightedKinds: ActivityKind[] = ["patch", "mcp", "web", "compaction", "abort"];
const heatmapMetrics: { id: HeatmapMetric; label: string }[] = [
  { id: "events", label: "Event" },
  { id: "tokens", label: "Token" },
  { id: "cost", label: "Cost" },
];
const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "oklch(0.66 0.15 220)",
];
const ActivityTrendChart = lazy(async () => ({
  default: (await import("@/web/components/activity-trend-chart")).ActivityTrendChart,
}));

export function ActivityPage() {
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => activityFiltersFromSearch(search, defaultDateRange()), [search]);
  const activeTab = activityTabFromSearch(search);
  const tabNavigation = useRef(activeTab);
  const [trendGrouping, setTrendGrouping] = useState<TrendGrouping>("kind");
  const activity = useQuery({
    queryKey: ["activity", "summary", filters],
    queryFn: ({ signal }) => fetchActivitySummary(filters, signal),
    staleTime: 30_000,
  });
  const timeline = useInfiniteQuery({
    enabled: activeTab === "timeline",
    queryKey: ["activity", "timeline", filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchActivityTimeline(
        filters,
        { ...(pageParam ? { cursor: pageParam } : {}), limit: 200 },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const projectFilters = useMemo<DashboardFilters>(() => {
    const next: DashboardFilters = { from: filters.from, to: filters.to };
    if (filters.agentKind) next.agentKind = filters.agentKind;
    return next;
  }, [filters.agentKind, filters.from, filters.to]);
  const projects = useQuery({
    queryKey: ["projects", "options", projectFilters],
    queryFn: ({ signal }) => fetchProjectOptions(projectFilters, signal),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    tabNavigation.current = activeTab;
  }, [activeTab]);

  function applyFilters(next: ActivityFilters) {
    setSearch(updateActivitySearch(search, next));
  }

  function selectTab(value: string) {
    const tab = isActivityTab(value) ? value : "overview";
    if (tab === tabNavigation.current) return;
    tabNavigation.current = tab;
    const next = new URLSearchParams(search);
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    setSearch(next);
  }

  const daily = activity.data?.daily ?? [];
  const totalEvents = daily.reduce((total, row) => total + row.count, 0);
  const mainEvents = sumWhere(daily, (row) => row.agentKind === "main");
  const subagentEvents = sumWhere(daily, (row) => row.agentKind === "subagent");
  const counters = new Map(
    highlightedKinds.map((kind) => [kind, sumWhere(daily, (row) => row.kind === kind)]),
  );
  const timelineItems = useMemo(
    () => timeline.data?.pages.flatMap((page) => page.items) ?? [],
    [timeline.data?.pages],
  );

  return (
    <div className="motion-stagger space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="bg-primary/10 text-primary rounded-lg p-2">
              <Activity className="size-5" aria-hidden="true" />
            </span>
            <Badge variant="secondary">Metadata hoạt động</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Hoạt động</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Turn, tool, patch, MCP và context compaction theo ngày. Timeline chỉ chứa loại event,
            timestamp và quan hệ agent — không lưu prompt, command argument hoặc tool output.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Timezone Asia/Ho_Chi_Minh</Badge>
          {activity.data ? (
            <CoverageBadge coverage={activity.data.timelineCoverage.status} />
          ) : null}
        </div>
      </header>

      <ActivityFilterBar
        key={filters.sessionId ?? "all-sessions"}
        filters={filters}
        projects={projects.data?.projects ?? []}
        onChange={applyFilters}
      />

      {activity.isError ? (
        <Card className="border-destructive/40" role="alert">
          <CardHeader>
            <CardTitle>Không tải được activity</CardTitle>
            <CardDescription>{activity.error.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void activity.refetch()}>
              Thử lại
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <section
        aria-label="Tổng quan activity"
        className="grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-4"
      >
        <SummaryCard
          description="Mọi metadata event khớp filter"
          icon={Activity}
          label="Tổng event"
          loading={activity.isLoading}
          value={totalEvents}
        />
        <SummaryCard
          description="Event do thread chính ghi nhận"
          icon={CircleDot}
          label="Main agent"
          loading={activity.isLoading}
          value={mainEvents}
        />
        <SummaryCard
          description="Event từ mọi depth subagent"
          icon={Bot}
          label="Subagent"
          loading={activity.isLoading}
          value={subagentEvents}
        />
        <SummaryCard
          description="Session có metadata trong raw timeline"
          icon={Network}
          label="Event timeline"
          loading={activity.isLoading}
          value={activity.data?.timelineTotal ?? 0}
        />
      </section>

      <Tabs value={activeTab} onValueChange={selectTab}>
        <TabsList aria-label="Nội dung hoạt động" className="w-full sm:w-auto">
          <TabsTrigger className="flex-1 sm:flex-none" value="overview">
            Xu hướng
          </TabsTrigger>
          <TabsTrigger className="flex-1 sm:flex-none" value="timeline">
            Timeline
          </TabsTrigger>
          <TabsTrigger className="flex-1 sm:flex-none" value="health">
            Sức khỏe dữ liệu
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <ActivityCounters counters={counters} loading={activity.isLoading} />

          <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.6fr)_minmax(22rem,0.9fr)]">
            <Card>
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>Xu hướng event theo ngày</CardTitle>
                  <CardDescription>
                    Đổi chiều phân tích để so sánh loại event, project hoặc main/subagent.
                  </CardDescription>
                </div>
                <Select
                  value={trendGrouping}
                  onValueChange={(value) => setTrendGrouping(value as TrendGrouping)}
                >
                  <SelectTrigger aria-label="Nhóm biểu đồ activity" className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kind">Theo loại event</SelectItem>
                    <SelectItem value="project">Theo project</SelectItem>
                    <SelectItem value="agent">Main / subagent</SelectItem>
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent>
                {activity.isLoading ? (
                  <Skeleton className="h-72" />
                ) : (
                  <ActivityTrend
                    daily={daily}
                    grouping={trendGrouping}
                    projects={projects.data?.projects ?? []}
                  />
                )}
              </CardContent>
            </Card>

            <ActivityHeatmap
              key={activityFilterKey(filters)}
              daily={daily}
              dailyUsage={activity.data?.dailyUsage ?? []}
              filters={filters}
              loading={activity.isLoading}
            />
          </div>
        </TabsContent>

        <TabsContent value="timeline">
          <ActivityTimeline
            key={activityFilterKey(filters)}
            error={timeline.error}
            hasMore={timeline.hasNextPage}
            items={timelineItems}
            loading={timeline.isLoading}
            loadingMore={timeline.isFetchingNextPage}
            onLoadMore={() => void timeline.fetchNextPage()}
            total={activity.data?.timelineTotal ?? 0}
            coverage={activity.data?.timelineCoverage.status ?? "full"}
          />
        </TabsContent>

        <TabsContent value="health">
          <DataHealthCenter />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ActivityFilterBar({
  filters,
  onChange,
  projects,
}: {
  filters: ActivityFilters;
  onChange: (filters: ActivityFilters) => void;
  projects: ProjectOption[];
}) {
  const activePresetRef = useRef<HTMLElement | null>(null);
  const [sessionDraft, setSessionDraft] = useState(filters.sessionId ?? "");
  const presets = datePresets();
  const activePreset =
    presets.find((preset) => preset.range.from === filters.from && preset.range.to === filters.to)
      ?.id ?? "custom";
  const selectedKinds = filters.kinds ?? [];

  useEffect(() => {
    activePresetRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activePreset]);

  function toggleKind(kind: ActivityKind) {
    const kinds = selectedKinds.includes(kind)
      ? selectedKinds.filter((value) => value !== kind)
      : [...selectedKinds, kind];
    const next = withoutActivityFilter(filters, "kinds");
    if (kinds.length > 0) next.kinds = kinds;
    onChange(next);
  }

  return (
    <section
      aria-label="Bộ lọc hoạt động"
      className="bg-background/92 sticky top-16 z-30 -mx-2 space-y-2 rounded-xl border p-2 shadow-sm backdrop-blur-xl lg:top-0"
    >
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div
          className="flex snap-x snap-proximity scrollbar-none gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)] px-2"
          aria-label="Khoảng thời gian"
        >
          {presets.map((preset) => (
            <Button
              key={preset.id}
              ref={
                activePreset === preset.id
                  ? (node) => {
                      activePresetRef.current = node;
                    }
                  : undefined
              }
              aria-pressed={activePreset === preset.id}
              className="shrink-0 snap-start"
              size="sm"
              variant={activePreset === preset.id ? "secondary" : "ghost"}
              onClick={() => onChange({ ...filters, ...preset.range })}
            >
              {preset.label}
            </Button>
          ))}
          <span
            ref={
              activePreset === "custom"
                ? (node) => {
                    activePresetRef.current = node;
                  }
                : undefined
            }
            className={cn(
              "shrink-0 snap-start",
              activePreset === "custom" && "ring-ring rounded-md ring-2",
            )}
          >
            <DateRangePicker
              value={filters}
              onChange={(range) => onChange({ ...filters, ...range })}
            />
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Select
            value={filters.projectId ?? "all"}
            onValueChange={(value) => {
              const next = withoutActivityFilter(filters, "projectId");
              if (value !== "all") next.projectId = value;
              onChange(next);
            }}
          >
            <SelectTrigger aria-label="Lọc project" className="h-8 w-48">
              <SelectValue placeholder="Mọi project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Mọi project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.agentKind ?? "all"}
            onValueChange={(value) => {
              const next = withoutActivityFilter(filters, "agentKind");
              if (value === "main" || value === "subagent") next.agentKind = value;
              onChange(next);
            }}
          >
            <SelectTrigger aria-label="Lọc loại agent" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Mọi agent</SelectItem>
              <SelectItem value="main">Main agent</SelectItem>
              <SelectItem value="subagent">Subagent</SelectItem>
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                <Filter className="size-4" />
                {selectedKinds.length === 0 ? "Mọi event" : `${selectedKinds.length} loại event`}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              <p className="text-muted-foreground px-2 pb-2 text-xs font-medium">
                Có thể chọn nhiều loại event
              </p>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {activityKindOptions.map(({ icon: Icon, kind, label }) => {
                  const active = selectedKinds.includes(kind);
                  return (
                    <button
                      key={kind}
                      aria-pressed={active}
                      className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                      type="button"
                      onClick={() => toggleKind(kind)}
                    >
                      <Icon className="text-muted-foreground size-4" />
                      <span className="flex-1">{label}</span>
                      {active ? <Check className="text-primary size-4" /> : null}
                    </button>
                  );
                })}
              </div>
              {selectedKinds.length > 0 ? (
                <Button
                  className="mt-2 w-full"
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange(withoutActivityFilter(filters, "kinds"))}
                >
                  <X className="size-4" /> Bỏ lọc event
                </Button>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <form
        className="flex flex-col gap-2 border-t pt-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          const sessionId = sessionDraft.trim();
          const next = withoutActivityFilter(filters, "sessionId");
          if (sessionId) next.sessionId = sessionId;
          onChange(next);
        }}
      >
        <div className="relative w-full sm:max-w-sm">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            aria-label="Lọc timeline theo session ID"
            className="h-8 pl-8"
            maxLength={160}
            placeholder="Session ID (chỉ raw timeline)"
            value={sessionDraft}
            onChange={(event) => setSessionDraft(event.target.value)}
          />
        </div>
        <Button size="sm" type="submit" variant="secondary">
          Áp dụng session
        </Button>
        {filters.sessionId ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setSessionDraft("");
              onChange(withoutActivityFilter(filters, "sessionId"));
            }}
          >
            <X className="size-4" /> Bỏ session
          </Button>
        ) : null}
        <span className="text-muted-foreground ml-auto hidden text-xs lg:block">
          Hoạt động không có filter model vì tool metadata không phụ thuộc model.
        </span>
      </form>
    </section>
  );
}

function SummaryCard({
  description,
  icon: Icon,
  label,
  loading,
  value,
}: {
  description: string;
  icon: typeof Activity;
  label: string;
  loading: boolean;
  value: number;
}) {
  return (
    <Card className="metric-card">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-sm">{label}</p>
            {loading ? (
              <Skeleton className="mt-3 h-8 w-28" />
            ) : (
              <p className="mt-2 text-2xl font-semibold tabular-nums">{formatTokens(value)}</p>
            )}
          </div>
          <span className="bg-primary/10 text-primary rounded-lg p-2">
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <p className="text-muted-foreground mt-3 text-xs">{description}</p>
      </CardContent>
    </Card>
  );
}

function ActivityCounters({
  counters,
  loading,
}: {
  counters: Map<ActivityKind, number>;
  loading: boolean;
}) {
  return (
    <section aria-labelledby="activity-counter-title">
      <div className="mb-3 flex items-center gap-2">
        <h2 id="activity-counter-title" className="text-lg font-semibold">
          Sự kiện kỹ thuật
        </h2>
        <Badge variant="outline">Không chứa payload</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {highlightedKinds.map((kind) => {
          const option = kindOption(kind);
          const Icon = option.icon;
          return (
            <Card key={kind}>
              <CardContent className="flex items-center gap-3 p-4">
                <span className="bg-muted text-muted-foreground rounded-lg p-2">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{option.label}</p>
                  {loading ? (
                    <Skeleton className="mt-1 h-6 w-16" />
                  ) : (
                    <p className="text-lg font-semibold tabular-nums">
                      {formatTokens(counters.get(kind) ?? 0)}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function ActivityTrend({
  daily,
  grouping,
  projects,
}: {
  daily: ActivitySummary[];
  grouping: TrendGrouping;
  projects: ProjectOption[];
}) {
  const [showTable, setShowTable] = useState(false);
  const { points, series } = useMemo(
    () => buildTrend(daily, grouping, projects),
    [daily, grouping, projects],
  );
  if (points.length === 0 || series.length === 0)
    return <EmptyState label="Chưa có event trong range." />;

  return (
    <>
      <Suspense fallback={<Skeleton className="h-72" />}>
        <ActivityTrendChart
          ariaLabel={`Biểu đồ event activity theo ngày, nhóm theo ${groupingLabel(grouping)}`}
          points={points}
          series={series}
        />
      </Suspense>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2" aria-hidden="true">
        {series.map((item) => (
          <span key={item.id} className="flex items-center gap-1.5 text-xs">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <Button
        className="mt-3"
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? "Ẩn dữ liệu dạng bảng" : "Xem dữ liệu dạng bảng"}
      </Button>
      {showTable ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption>Hoạt động theo ngày, nhóm theo {groupingLabel(grouping)}</caption>
            <thead>
              <tr>
                <th>Ngày</th>
                {series.map((item) => (
                  <th key={item.id}>{item.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <th>{point.date}</th>
                  {series.map((item) => (
                    <td key={item.id}>{trendPointValue(point, item.id)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function ActivityHeatmap({
  daily,
  dailyUsage,
  filters,
  loading,
}: {
  daily: ActivitySummary[];
  dailyUsage: ActivityDailyUsage[];
  filters: ActivityFilters;
  loading: boolean;
}) {
  const [metric, setMetric] = useState<HeatmapMetric>("events");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const cellReferences = useRef(new Map<string, HTMLButtonElement>());
  const visibleFrom =
    filters.from < shiftIsoDate(filters.to, -364) ? shiftIsoDate(filters.to, -364) : filters.from;
  const dates = useMemo(
    () => calendarGridDates(visibleFrom, filters.to),
    [filters.to, visibleFrom],
  );
  const dateRows = useMemo(
    () =>
      Array.from({ length: 7 }, (_, rowIndex) =>
        dates.filter((_, dateIndex) => dateIndex % 7 === rowIndex),
      ),
    [dates],
  );
  const heatmapDays = useMemo(
    () => buildHeatmapDays(daily, dailyUsage, visibleFrom, filters.to),
    [daily, dailyUsage, filters.to, visibleFrom],
  );
  const daysByDate = useMemo(
    () => new Map(heatmapDays.map((day) => [day.date, day])),
    [heatmapDays],
  );
  const defaultDate = useMemo(
    () =>
      heatmapDays.findLast(
        (day) =>
          day.eventCount > 0 ||
          day.requestCount > 0 ||
          day.totalTokens > 0 ||
          day.estimatedCostUsd > 0,
      )?.date ??
      heatmapDays.at(-1)?.date ??
      null,
    [heatmapDays],
  );
  const activeDate = selectedDate && daysByDate.has(selectedDate) ? selectedDate : defaultDate;
  const selectedDay = activeDate ? daysByDate.get(activeDate) : undefined;
  const maximum = Math.max(0, ...heatmapDays.map((day) => heatmapMetricValue(day, metric)));
  const hasVisibleData = heatmapDays.some(
    (day) =>
      day.eventCount > 0 || day.requestCount > 0 || day.totalTokens > 0 || day.estimatedCostUsd > 0,
  );
  const clipped = visibleFrom !== filters.from;

  function moveFocus(date: string, days: number) {
    const nextDate = shiftIsoDate(date, days);
    if (!daysByDate.has(nextDate)) return;
    setSelectedDate(nextDate);
    const element = cellReferences.current.get(nextDate);
    element?.focus();
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function handleCellKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, date: string) {
    const movement =
      event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft"
            ? -7
            : event.key === "ArrowRight"
              ? 7
              : null;
    if (movement !== null) {
      event.preventDefault();
      moveFocus(date, movement);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSelectedDate(defaultDate);
    }
  }

  return (
    <Card className="min-w-0 self-start" data-testid="activity-heatmap-card">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Heatmap hoạt động</CardTitle>
          <CardDescription>
            Tối đa 365 ngày. Token và cost là usage toàn ngày, không phụ thuộc loại event.
          </CardDescription>
        </div>
        <div
          aria-label="Metric Heatmap"
          className="bg-muted inline-flex w-fit rounded-lg p-1"
          role="group"
        >
          {heatmapMetrics.map((option) => (
            <Button
              key={option.id}
              aria-pressed={metric === option.id}
              disabled={loading}
              size="sm"
              type="button"
              variant={metric === option.id ? "outline" : "ghost"}
              onClick={() => setMetric(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-64" />
        ) : !hasVisibleData || !selectedDay ? (
          <EmptyState label="Chưa có event hoặc usage trong cửa sổ Heatmap." />
        ) : (
          <>
            {clipped ? (
              <p className="text-muted-foreground mb-3 text-xs">
                Range dài hơn một năm; Heatmap hiển thị từ {formatLocalDate(visibleFrom)}.
              </p>
            ) : null}

            <div
              id="activity-heatmap-day-detail"
              className="bg-muted/35 mb-4 rounded-lg border p-3"
              aria-live="polite"
              data-testid="activity-heatmap-detail"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{formatLocalDate(selectedDay.date)}</p>
                {selectedDay.unpricedUsageCount > 0 ? (
                  <Badge variant="secondary">
                    {formatTokens(selectedDay.unpricedUsageCount)}/
                    {formatTokens(selectedDay.requestCount)} yêu cầu chưa định giá
                  </Badge>
                ) : (
                  <Badge variant="outline">Cost đã định giá</Badge>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2">
                <HeatmapDetailValue label="Event" value={formatTokens(selectedDay.eventCount)} />
                <HeatmapDetailValue label="Token" value={formatTokens(selectedDay.totalTokens)} />
                <HeatmapDetailValue
                  label="Cost ước tính"
                  value={formatUsd(selectedDay.estimatedCostUsd)}
                />
              </dl>
              {selectedDay.unpricedUsageCount > 0 ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  Cost hiện là subtotal của usage đã có giá; phần chưa định giá không bị tính thành
                  $0.
                </p>
              ) : null}
              {(filters.kinds?.length ?? 0) > 0 ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  Bộ lọc loại event chỉ áp dụng cho số event; token và cost vẫn là usage toàn ngày.
                </p>
              ) : null}
            </div>

            <div className="overflow-x-auto pb-2" data-testid="activity-heatmap-scroll">
              <div
                aria-colcount={Math.ceil(dates.length / 7)}
                aria-label={`Heatmap activity theo ngày, màu theo ${heatmapMetricLabel(metric)}`}
                aria-rowcount={7}
                className="flex w-max flex-col gap-0.5"
                role="grid"
              >
                {dateRows.map((row, rowIndex) => (
                  <div key={rowIndex} className="flex gap-0.5" role="row">
                    {row.map((date) => {
                      const day = daysByDate.get(date);
                      if (!day) {
                        return (
                          <span
                            key={date}
                            aria-disabled="true"
                            aria-label={`${formatLocalDate(date)}: ngoài khoảng thời gian`}
                            className="size-6 [@media(pointer:coarse)]:size-8"
                            role="gridcell"
                          />
                        );
                      }
                      const value = heatmapMetricValue(day, metric);
                      const level = heatmapLevel(value, maximum);
                      return (
                        <button
                          key={date}
                          ref={(element) => {
                            if (element) cellReferences.current.set(date, element);
                            else cellReferences.current.delete(date);
                          }}
                          aria-describedby="activity-heatmap-day-detail"
                          aria-label={heatmapDayLabel(day)}
                          aria-selected={date === activeDate}
                          className="focus-visible:ring-ring focus-visible:ring-offset-background flex size-6 items-center justify-center rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [@media(pointer:coarse)]:size-8"
                          data-heatmap-date={date}
                          data-heatmap-level={level}
                          data-heatmap-value={value}
                          role="gridcell"
                          tabIndex={date === activeDate ? 0 : -1}
                          type="button"
                          onClick={() => setSelectedDate(date)}
                          onFocus={() => setSelectedDate(date)}
                          onKeyDown={(event) => handleCellKeyDown(event, date)}
                          onPointerEnter={() => setSelectedDate(date)}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-5 rounded-[4px] border border-transparent [@media(pointer:coarse)]:size-7",
                              heatmapLevelClass(level),
                            )}
                          />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="text-muted-foreground mt-3 flex flex-wrap items-center justify-end gap-1 text-xs">
              <span className="mr-1">{heatmapMetricLabel(metric)}</span>
              Ít
              {[0, 1, 2, 3, 4].map((level) => (
                <span
                  key={level}
                  className={cn(
                    "size-3 rounded-[3px] border border-transparent",
                    heatmapLevelClass(level),
                  )}
                  aria-hidden="true"
                />
              ))}
              Nhiều
            </div>
            <Button
              className="mt-3"
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setShowTable((value) => !value)}
            >
              {showTable ? "Ẩn dữ liệu dạng bảng" : "Xem dữ liệu dạng bảng"}
            </Button>
            {showTable ? (
              <div
                aria-label="Bảng dữ liệu Heatmap, cuộn để xem thêm"
                className="mt-3 max-h-72 max-w-full overflow-auto"
                role="region"
              >
                <a
                  className="focus:bg-background focus:ring-ring sr-only focus:not-sr-only focus:sticky focus:top-0 focus:z-10 focus:inline-flex focus:rounded-md focus:px-3 focus:py-2 focus:ring-2"
                  href="#activity-heatmap-table"
                >
                  Chuyển đến bảng Heatmap
                </a>
                <table id="activity-heatmap-table" className="w-full min-w-[38rem] text-sm">
                  <caption>Heatmap hoạt động dạng bảng</caption>
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Event</th>
                      <th>Token</th>
                      <th>Cost ước tính</th>
                      <th>Độ phủ giá</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heatmapDays.map((day) => (
                      <tr key={day.date}>
                        <th>{formatLocalDate(day.date)}</th>
                        <td>{formatTokens(day.eventCount)}</td>
                        <td>{formatTokens(day.totalTokens)}</td>
                        <td>{formatUsd(day.estimatedCostUsd)}</td>
                        <td>
                          {day.unpricedUsageCount > 0
                            ? `${formatTokens(day.unpricedUsageCount)}/${formatTokens(day.requestCount)} chưa định giá`
                            : "Đầy đủ"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HeatmapDetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background/65 min-w-0 rounded-md border px-2.5 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 truncate font-semibold tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ActivityTimeline({
  coverage,
  error,
  hasMore,
  items,
  loading,
  loadingMore,
  onLoadMore,
  total,
}: {
  coverage: "full" | "none" | "partial";
  error: Error | null;
  hasMore: boolean;
  items: ActivityTimelineItem[];
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  total: number;
}) {
  const sessions = useMemo(() => buildTimelineSessions(items), [items]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>Session timeline: main → subagent</CardTitle>
            <CardDescription>
              Event gần nhất hiển thị trước; indentation lấy từ parentAgentId và depth của Codex.
            </CardDescription>
          </div>
          <Badge variant="outline">
            {formatTokens(items.length)} / {formatTokens(total)} event raw
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {coverage !== "full" ? (
          <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>
              {coverage === "none"
                ? "Range này chỉ còn daily counters; raw timeline và cây agent đã hết retention."
                : "Range hỗn hợp: timeline chỉ đầy đủ trong 30 ngày raw gần nhất; daily counters phía trên vẫn bao phủ toàn range."}
            </p>
          </div>
        ) : null}
        {error ? (
          <div
            className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm"
            role="alert"
          >
            Không tải được timeline: {error.message}
          </div>
        ) : null}
        {loading ? <TimelineSkeleton /> : null}
        {!loading && sessions.length === 0 ? (
          <EmptyState label="Không có raw timeline khớp filter. Thử chọn range trong 30 ngày gần nhất." />
        ) : null}
        <div className="space-y-4">
          {sessions.map((session) => (
            <section key={session.sessionId} className="overflow-hidden rounded-xl border">
              <header className="bg-muted/60 flex flex-col justify-between gap-2 border-b px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Session</p>
                  <p
                    className="text-muted-foreground truncate font-mono text-xs"
                    title={session.sessionId}
                  >
                    {session.sessionId}
                  </p>
                </div>
                <Badge variant="outline">{formatTokens(session.eventCount)} event</Badge>
              </header>
              <div className="space-y-3 p-3 sm:p-4">
                {session.roots.map((node) => (
                  <AgentTimelineNode key={node.agent.agentId} node={node} />
                ))}
              </div>
            </section>
          ))}
        </div>
        {hasMore ? (
          <div className="flex justify-center border-t pt-4">
            <Button variant="outline" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "Đang tải…" : "Hiển thị thêm 200 event"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AgentTimelineNode({ node }: { node: TimelineAgentNode }) {
  const agentLabel = node.agent.name ?? node.agent.role ?? shortId(node.agent.agentId);
  return (
    <div
      className={cn(node.agent.depth > 0 && "border-primary/20 ml-3 border-l pl-3 sm:ml-6 sm:pl-4")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-primary/10 text-primary rounded-md p-1.5">
          {node.agent.agentKind === "subagent" ? (
            <Bot className="size-3.5" />
          ) : (
            <CircleDot className="size-3.5" />
          )}
        </span>
        <p className="text-sm font-medium">{agentLabel}</p>
        <Badge variant={node.agent.agentKind === "subagent" ? "secondary" : "outline"}>
          {node.agent.agentKind === "subagent"
            ? `Subagent · depth ${node.agent.depth}`
            : "Main agent"}
        </Badge>
        {node.agent.role && node.agent.role !== node.agent.name ? (
          <span className="text-muted-foreground text-xs">{node.agent.role}</span>
        ) : null}
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">
          {shortId(node.agent.agentId)}
        </span>
      </div>
      <ol className="mt-2 space-y-1.5" aria-label={`Event của ${agentLabel}`}>
        {node.events.map((event) => {
          const option = kindOption(event.kind);
          const Icon = option.icon;
          return (
            <li
              key={event.id}
              className="bg-muted/45 flex items-center gap-2 rounded-md px-3 py-2 text-xs"
            >
              <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
              <span className="font-medium">{option.label}</span>
              {event.turnKey ? (
                <Link
                  aria-label={`Mở turn của event ${option.label}`}
                  className="text-primary hover:underline"
                  to={`/turns/${event.turnKey}`}
                >
                  Xem turn
                </Link>
              ) : null}
              <time
                className="text-muted-foreground ml-auto tabular-nums"
                dateTime={event.timestamp}
              >
                {formatTimestamp(event.timestamp)}
              </time>
            </li>
          );
        })}
      </ol>
      {node.children.length > 0 ? (
        <div className="mt-3 space-y-3">
          {node.children.map((child) => (
            <AgentTimelineNode key={child.agent.agentId} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3" aria-label="Đang tải timeline" aria-busy="true">
      <Skeleton className="h-14" />
      <Skeleton className="ml-8 h-24" />
      <Skeleton className="h-14" />
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm">
      <CalendarDays className="mb-3 size-7 opacity-50" />
      {label}
    </div>
  );
}

function CoverageBadge({ coverage }: { coverage: "full" | "none" | "partial" }) {
  return (
    <Badge variant={coverage === "full" ? "secondary" : "outline"}>{coverageLabel(coverage)}</Badge>
  );
}

function coverageLabel(coverage: "full" | "none" | "partial"): string {
  switch (coverage) {
    case "full":
      return "Timeline đầy đủ";
    case "none":
      return "Chỉ còn daily";
    case "partial":
      return "Timeline một phần";
  }
}

function buildTrend(
  daily: ActivitySummary[],
  grouping: TrendGrouping,
  projects: ProjectOption[],
): { points: TrendPoint[]; series: TrendSeries[] } {
  const labels = new Map(projects.map((project) => [project.id, project.displayName]));
  const totals = new Map<string, number>();
  for (const row of daily) {
    const id = trendKey(row, grouping);
    totals.set(id, (totals.get(id) ?? 0) + row.count);
  }
  const series = [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, grouping === "agent" ? 2 : 6)
    .map(([id], index) => ({
      color: chartColors[index % chartColors.length] ?? "var(--chart-1)",
      id,
      label: trendSeriesLabel(id, grouping, labels),
    }));
  const seriesIds = new Set(series.map((item) => item.id));
  const byDate = new Map<string, Map<string, number>>();
  for (const row of daily) {
    const id = trendKey(row, grouping);
    if (!seriesIds.has(id)) continue;
    const values = byDate.get(row.date) ?? new Map<string, number>();
    values.set(id, (values.get(id) ?? 0) + row.count);
    byDate.set(row.date, values);
  }
  const points = [...byDate.entries()]
    .map(([date, values]) => ({ date, ...Object.fromEntries(values) }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return { points, series };
}

function trendKey(row: ActivitySummary, grouping: TrendGrouping): string {
  switch (grouping) {
    case "agent":
      return row.agentKind;
    case "kind":
      return row.kind;
    case "project":
      return row.projectId;
  }
}

function trendSeriesLabel(
  id: string,
  grouping: TrendGrouping,
  projects: Map<string, string>,
): string {
  switch (grouping) {
    case "agent":
      return id === "subagent" ? "Subagent" : "Main agent";
    case "kind":
      return kindOption(id as ActivityKind).label;
    case "project":
      return projects.get(id) ?? (id === "legacy-unknown" ? "Legacy / unknown" : shortId(id));
  }
}

function groupingLabel(grouping: TrendGrouping): string {
  switch (grouping) {
    case "agent":
      return "main và subagent";
    case "kind":
      return "loại event";
    case "project":
      return "project";
  }
}

function buildTimelineSessions(items: ActivityTimelineItem[]) {
  const bySession = new Map<string, ActivityTimelineItem[]>();
  for (const item of items) {
    const events = bySession.get(item.sessionId) ?? [];
    events.push(item);
    bySession.set(item.sessionId, events);
  }
  return [...bySession.entries()].map(([sessionId, events]) => ({
    eventCount: events.length,
    roots: buildAgentTree(events),
    sessionId,
  }));
}

function buildAgentTree(events: ActivityTimelineItem[]): TimelineAgentNode[] {
  const nodes = new Map<string, TimelineAgentNode>();
  for (const event of events) {
    const node = nodes.get(event.agentId);
    if (node) node.events.push(event);
    else nodes.set(event.agentId, { agent: event, children: [], events: [event] });
  }
  const roots: TimelineAgentNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.agent.parentAgentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (values: TimelineAgentNode[]) => {
    values.sort(
      (left, right) =>
        left.agent.depth - right.agent.depth ||
        left.agent.agentId.localeCompare(right.agent.agentId),
    );
    for (const value of values) sortNodes(value.children);
  };
  sortNodes(roots);
  return roots;
}

function kindOption(kind: ActivityKind) {
  return activityKindOptions.find((option) => option.kind === kind) ?? activityKindOptions.at(-1)!;
}

function withoutActivityFilter(
  filters: ActivityFilters,
  key: "agentKind" | "kinds" | "projectId" | "sessionId",
): ActivityFilters {
  const next = { ...filters };
  switch (key) {
    case "agentKind":
      delete next.agentKind;
      break;
    case "kinds":
      delete next.kinds;
      break;
    case "projectId":
      delete next.projectId;
      break;
    case "sessionId":
      delete next.sessionId;
      break;
  }
  return next;
}

function activityFilterKey(filters: ActivityFilters): string {
  return [
    filters.from,
    filters.to,
    filters.projectId ?? "all-projects",
    filters.agentKind ?? "all-agents",
    filters.sessionId ?? "all-sessions",
    filters.kinds?.join(",") ?? "all-events",
  ].join("|");
}

function trendPointValue(point: TrendPoint, id: string): number {
  const value = Object.entries(point).find(([key]) => key === id)?.[1];
  return typeof value === "number" ? value : 0;
}

function datePresets(): { id: string; label: string; range: DashboardFilters }[] {
  const today = localDate(new Date());
  return [
    { id: "today", label: "Hôm nay", range: { from: today, to: today } },
    { id: "7-days", label: "7 ngày", range: { from: shiftDate(today, -6), to: today } },
    { id: "30-days", label: "30 ngày", range: { from: shiftDate(today, -29), to: today } },
    { id: "month", label: "Tháng này", range: { from: `${today.slice(0, 8)}01`, to: today } },
    { id: "all", label: "Toàn bộ", range: { from: "2020-01-01", to: today } },
  ];
}

function calendarGridDates(from: string, to: string): string[] {
  const first = parseIsoDate(from);
  const last = parseIsoDate(to);
  first.setUTCDate(first.getUTCDate() - first.getUTCDay());
  last.setUTCDate(last.getUTCDate() + (6 - last.getUTCDay()));
  const dates: string[] = [];
  for (const cursor = first; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function shiftIsoDate(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function buildHeatmapDays(
  daily: ActivitySummary[],
  dailyUsage: ActivityDailyUsage[],
  from: string,
  to: string,
): HeatmapDay[] {
  const eventTotals = new Map<string, number>();
  for (const row of daily) {
    eventTotals.set(row.date, (eventTotals.get(row.date) ?? 0) + row.count);
  }
  const usageByDate = new Map(dailyUsage.map((row) => [row.date, row]));
  return calendarGridDates(from, to)
    .filter((date) => date >= from && date <= to)
    .map((date) => {
      const usage = usageByDate.get(date);
      return {
        date,
        estimatedCostUsd: usage?.estimatedCostUsd ?? 0,
        eventCount: eventTotals.get(date) ?? 0,
        requestCount: usage?.requestCount ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        unpricedUsageCount: usage?.unpricedUsageCount ?? 0,
      };
    });
}

function heatmapMetricValue(day: HeatmapDay, metric: HeatmapMetric): number {
  switch (metric) {
    case "cost":
      return day.estimatedCostUsd;
    case "events":
      return day.eventCount;
    case "tokens":
      return day.totalTokens;
  }
}

function heatmapMetricLabel(metric: HeatmapMetric): string {
  switch (metric) {
    case "cost":
      return "Cost";
    case "events":
      return "Event";
    case "tokens":
      return "Token";
  }
}

function heatmapDayLabel(day: HeatmapDay): string {
  const priceCoverage =
    day.unpricedUsageCount > 0
      ? `${formatTokens(day.unpricedUsageCount)} trên ${formatTokens(day.requestCount)} yêu cầu chưa định giá`
      : "cost đã định giá";
  return `${formatLocalDate(day.date)}: ${formatTokens(day.eventCount)} event, ${formatTokens(day.totalTokens)} token, cost ước tính ${formatUsd(day.estimatedCostUsd)}, ${priceCoverage}`;
}

function heatmapLevel(value: number, maximum: number): number {
  if (value === 0 || maximum === 0) return 0;
  return Math.max(1, Math.ceil((value / maximum) * 4));
}

function heatmapLevelClass(level: number): string {
  switch (level) {
    case 0:
      return "bg-muted border-border";
    case 1:
      return "bg-primary/25";
    case 2:
      return "bg-primary/45";
    case 3:
      return "bg-primary/70";
    default:
      return "bg-primary";
  }
}

function sumWhere(daily: ActivitySummary[], predicate: (row: ActivitySummary) => boolean): number {
  return daily.reduce((total, row) => total + (predicate(row) ? row.count : 0), 0);
}

function activityTabFromSearch(search: URLSearchParams): ActivityTab {
  const tab = search.get("tab");
  return isActivityTab(tab) ? tab : "overview";
}

function isActivityTab(value: string | null): value is ActivityTab {
  return value === "health" || value === "overview" || value === "timeline";
}

function formatTimestamp(value: string): string {
  return TIMESTAMP_FORMATTER.format(new Date(value));
}

function formatLocalDate(value: string): string {
  return LOCAL_DATE_FORMATTER.format(new Date(`${value}T12:00:00.000Z`));
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}
