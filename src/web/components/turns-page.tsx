import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  Bot,
  Check,
  CircleDollarSign,
  Clock3,
  Columns3,
  GitCompareArrows,
  ListChecks,
  Search,
  Timer,
  Workflow,
} from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { MetricCard } from "@/web/components/metric-card";
import { ProductFilterBar } from "@/web/components/product-filter-bar";
import { ExportActions } from "@/web/components/export-actions";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/components/ui/tabs";
import { fetchModels } from "@/web/lib/api";
import { fetchProjectOptions, formatPercent, formatTokens, formatUsd } from "@/web/lib/product-api";
import {
  fetchTurnComparison,
  fetchTurnDetail,
  fetchTurns,
  turnFiltersFromSearch,
  updateTurnSearch,
} from "@/web/lib/turns-api";
import { useLiveEventsFallbackActive } from "@/web/lib/live-events";
import { useMediaQuery } from "@/web/lib/use-media-query";
import { cn } from "@/web/lib/utils";
import type {
  AgentFilters,
  ActivityKind,
  TurnCostCoverage,
  TurnFilters,
  TurnSummary,
} from "@/shared/types";

type TrendMetric = "cost" | "tokens" | "turns";
type VisibleColumn = "cache" | "context" | "cost" | "duration" | "model" | "status";

const TurnTrendChart = lazy(async () => ({
  default: (await import("@/web/components/turn-charts")).TurnTrendChart,
}));
const ContextBucketsChart = lazy(async () => ({
  default: (await import("@/web/components/turn-charts")).ContextBucketsChart,
}));
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
});

const defaultColumns = new Set<VisibleColumn>([
  "cache",
  "context",
  "cost",
  "duration",
  "model",
  "status",
]);

export function TurnsPage() {
  const liveEventsFallbackActive = useLiveEventsFallbackActive();
  const desktopTurns = useMediaQuery("(min-width: 1024px)");
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { "*": turnPath } = useParams<{ "*": string }>();
  const isCompareRoute = turnPath === "compare";
  const turnKey = turnPath && !isCompareRoute ? turnPath : undefined;
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const overlayTrigger = useRef<HTMLElement | null>(null);
  const visible = useDocumentVisible();
  const filters = useMemo(() => turnFiltersFromSearch(search), [search]);
  const compareIds = useMemo(
    () => uniqueIds(search.get("ids")?.split(",") ?? []).slice(0, 4),
    [search],
  );
  const [selected, setSelected] = useState<string[]>(compareIds);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("tokens");
  const [columns, setColumns] = useState<Set<VisibleColumn>>(() => new Set(defaultColumns));
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => fetchModels(signal),
    staleTime: 5 * 60_000,
  });
  const projectFilters = useMemo(() => {
    const next = { from: filters.from, to: filters.to };
    return next;
  }, [filters.from, filters.to]);
  const projects = useQuery({
    queryKey: ["projects", "options", projectFilters],
    queryFn: ({ signal }) => fetchProjectOptions(projectFilters, signal),
    staleTime: 5 * 60_000,
  });
  const turns = useQuery({
    queryKey: ["turns", filters],
    queryFn: ({ signal }) => fetchTurns(filters, signal),
    staleTime: 30_000,
    refetchInterval: (query) =>
      liveEventsFallbackActive && visible && query.state.data?.liveRefreshSuggested === true
        ? 5_000
        : false,
  });
  const detail = useQuery({
    enabled: Boolean(turnKey),
    queryKey: ["turn", turnKey],
    queryFn: ({ signal }) => fetchTurnDetail(turnKey ?? "", signal),
    refetchInterval:
      liveEventsFallbackActive && visible && turns.data?.liveRefreshSuggested ? 5_000 : false,
  });
  const comparison = useQuery({
    enabled: isCompareRoute && compareIds.length >= 2,
    queryKey: ["turns", "compare", compareIds],
    queryFn: ({ signal }) => fetchTurnComparison(compareIds, signal),
  });

  function applyFilters(next: TurnFilters) {
    setSearch(updateTurnSearch(search, { ...next, page: 1 }));
  }

  function applyBaseFilters(next: AgentFilters) {
    const advanced = pickAdvancedFilters(filters);
    applyFilters({ ...next, ...advanced });
  }

  function openTurn(id: string) {
    overlayTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void navigate({ pathname: `/turns/${id}`, search: search.toString() });
  }

  function closeOverlay() {
    if (overlayTrigger.current) {
      void navigate(-1);
      return;
    }
    void navigate({ pathname: "/turns", search: withoutIds(search).toString() }, { replace: true });
  }

  function restoreOverlayFocus() {
    (overlayTrigger.current ?? pageHeading.current)?.focus();
    overlayTrigger.current = null;
  }

  function toggleTurn(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(0, 4),
    );
  }

  function openComparison() {
    overlayTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = new URLSearchParams(search);
    next.set("ids", selected.join(","));
    void navigate({ pathname: "/turns/compare", search: next.toString() });
  }

  const totalPages = Math.max(1, Math.ceil((turns.data?.total ?? 0) / (filters.pageSize ?? 25)));

  return (
    <div className="motion-stagger space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="bg-primary/10 text-primary rounded-lg p-2">
              <ListChecks className="size-5" aria-hidden="true" />
            </span>
            <Badge variant="secondary">Metadata-only</Badge>
          </div>
          <h1
            ref={pageHeading}
            className="text-3xl font-semibold tracking-tight focus:outline-none"
            tabIndex={-1}
          >
            Turns
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Phân tích từng lượt theo token, cost, cache, thời gian, context pressure và activity.
            Turn qua nửa đêm được tính vào ngày bắt đầu.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{turns.data?.total ?? 0} turn</Badge>
          <Button
            disabled={selected.length < 2}
            title={selected.length < 2 ? "Chọn từ 2 đến 4 turn để so sánh" : undefined}
            variant="outline"
            onClick={openComparison}
          >
            <GitCompareArrows className="size-4" /> So sánh {selected.length || ""}
          </Button>
        </div>
      </header>

      <ProductFilterBar
        filters={filters}
        models={models.data?.models ?? []}
        onChange={applyBaseFilters}
        projects={(projects.data?.projects ?? []).map((project) => ({
          id: project.id,
          name: project.displayName,
        }))}
        showProject
      />

      <AdvancedFilters filters={filters} onChange={applyFilters} />

      {turns.isError ? <ErrorCard message={turns.error.message} /> : null}
      {turns.data?.coverage.backfill.isRunning ? (
        <CoverageNotice
          message={`Đang attribution lại historical JSONL: ${turns.data.coverage.backfill.filesProcessed}/${turns.data.coverage.backfill.totalFiles} file. Totals dashboard không bị cộng lại.`}
        />
      ) : null}
      {turns.data?.coverage.timeline.status !== "full" ? (
        <CoverageNotice message="Aggregate của turn được giữ vĩnh viễn. Request và activity timeline chỉ đầy đủ trong raw retention 30 ngày." />
      ) : null}

      <TurnKpiGrid loading={turns.isLoading} response={turns.data} />

      <section className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Xu hướng theo ngày bắt đầu</CardTitle>
              <CardDescription className="mt-1">
                Token, cost hoặc số turn trong range.
              </CardDescription>
            </div>
            <MetricToggle value={trendMetric} onChange={setTrendMetric} />
          </CardHeader>
          <CardContent>
            {turns.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <Suspense fallback={<Skeleton className="h-72" />}>
                <TurnTrendChart
                  costCoverage={turns.data?.kpis.costCoverage ?? "unavailable"}
                  data={turns.data?.daily ?? []}
                  metric={trendMetric}
                />
              </Suspense>
            )}
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Context pressure</CardTitle>
            <CardDescription>Peak input / context window được khai báo.</CardDescription>
          </CardHeader>
          <CardContent>
            {turns.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <Suspense fallback={<Skeleton className="h-72" />}>
                <ContextBucketsChart data={turns.data?.contextBuckets ?? []} />
              </Suspense>
            )}
          </CardContent>
        </Card>
      </section>

      <TurnList
        columns={columns}
        desktop={desktopTurns}
        filters={filters}
        loading={turns.isLoading}
        onColumnsChange={setColumns}
        onOpen={openTurn}
        onPageChange={(page) => setSearch(updateTurnSearch(search, { ...filters, page }))}
        onToggle={toggleTurn}
        selected={selected}
        totalPages={totalPages}
        turns={turns.data?.turns ?? []}
      />

      <ExportActions datasets={["turns"]} filters={filters} />

      <TurnDetailSheet
        data={detail.data}
        error={detail.error?.message}
        loading={detail.isLoading}
        open={Boolean(turnKey)}
        restoreFocus={restoreOverlayFocus}
        onOpenChange={(open) => {
          if (!open) closeOverlay();
        }}
      />
      <TurnComparisonSheet
        data={comparison.data?.turns ?? []}
        missingIds={comparison.data?.missingIds ?? []}
        open={isCompareRoute}
        restoreFocus={restoreOverlayFocus}
        onOpenChange={(open) => {
          if (!open) closeOverlay();
        }}
      />
    </div>
  );
}

function AdvancedFilters({
  filters,
  onChange,
}: {
  filters: TurnFilters;
  onChange: (filters: TurnFilters) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 p-3">
        <DebouncedTurnTextFilters
          key={`${filters.query ?? ""}\u0000${filters.effort ?? ""}`}
          initialEffort={filters.effort ?? ""}
          initialQuery={filters.query ?? ""}
          onCommit={(query, effort) => {
            const withQuery = setFilter(filters, "query", query);
            onChange(setFilter(withQuery, "effort", effort));
          }}
        />
        <Select
          value={filters.status ?? "all"}
          onValueChange={(value) => onChange(setFilter(filters, "status", value))}
        >
          <SelectTrigger aria-label="Trạng thái turn" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Mọi trạng thái</SelectItem>
            <SelectItem value="completed">Hoàn tất</SelectItem>
            <SelectItem value="aborted">Đã huỷ</SelectItem>
            <SelectItem value="unknown">Không rõ</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.pressure ?? "all"}
          onValueChange={(value) => onChange(setFilter(filters, "pressure", value))}
        >
          <SelectTrigger aria-label="Context pressure" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Mọi context</SelectItem>
            <SelectItem value="below-70">Bình thường · &lt;70%</SelectItem>
            <SelectItem value="70-84">Cao · 70–84%</SelectItem>
            <SelectItem value="85-94">Rất cao · 85–94%</SelectItem>
            <SelectItem value="95+">Sắp đầy · ≥95%</SelectItem>
            <SelectItem value="unknown">Thiếu metadata</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.sort ?? "lastActivity"}
          onValueChange={(value) =>
            onChange({
              ...filters,
              page: 1,
              sort: value as NonNullable<TurnFilters["sort"]>,
            })
          }
        >
          <SelectTrigger aria-label="Sắp xếp turn" className="w-44">
            <ArrowDownUp className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lastActivity">Hoạt động gần nhất</SelectItem>
            <SelectItem value="tokens">Token</SelectItem>
            <SelectItem value="cost">Cost</SelectItem>
            <SelectItem value="duration">Duration</SelectItem>
            <SelectItem value="ttft">TTFT</SelectItem>
            <SelectItem value="context">Context</SelectItem>
          </SelectContent>
        </Select>
        <Button
          aria-label="Đổi chiều sắp xếp"
          size="icon"
          variant="outline"
          onClick={() =>
            onChange({ ...filters, order: filters.order === "asc" ? "desc" : "asc", page: 1 })
          }
        >
          <ArrowDownUp className="size-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

function DebouncedTurnTextFilters({
  initialEffort,
  initialQuery,
  onCommit,
}: {
  initialEffort: string;
  initialQuery: string;
  onCommit: (query: string, effort: string) => void;
}) {
  const [queryDraft, setQueryDraft] = useState(initialQuery);
  const [effortDraft, setEffortDraft] = useState(initialEffort);
  const commit = useEffectEvent(onCommit);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = queryDraft.trim();
      const effort = effortDraft.trim();
      if (query !== initialQuery || effort !== initialEffort) commit(query, effort);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [effortDraft, initialEffort, initialQuery, queryDraft]);
  return (
    <>
      <div className="relative min-w-56 flex-1">
        <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
        <Input
          aria-label="Tìm turn"
          className="pl-9"
          maxLength={200}
          placeholder="Task, session, turn ID hoặc agent"
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
        />
      </div>
      <Input
        aria-label="Reasoning effort"
        className="w-40"
        maxLength={60}
        placeholder="Effort"
        value={effortDraft}
        onChange={(event) => setEffortDraft(event.target.value)}
      />
    </>
  );
}

function TurnKpiGrid({
  loading,
  response,
}: {
  loading: boolean;
  response: Awaited<ReturnType<typeof fetchTurns>> | undefined;
}) {
  if (loading && !response) {
    return (
      <div className="grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
    );
  }
  const kpis = response?.kpis;
  return (
    <section
      aria-label="KPI turns"
      className="grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-6"
    >
      <h2 className="sr-only">Chỉ số turns</h2>
      <MetricCard
        icon={<ListChecks className="size-4" />}
        label="Turns"
        value={formatTokens(kpis?.turnCount ?? 0)}
      />
      <MetricCard
        detail={coverageLabel(kpis?.costCoverage ?? "unavailable")}
        icon={<CircleDollarSign className="size-4" />}
        label="Cost / turn"
        value={
          kpis?.averageCostPerTurn === null || kpis?.averageCostPerTurn === undefined
            ? "—"
            : formatUsd(kpis.averageCostPerTurn)
        }
      />
      <MetricCard
        icon={<Workflow className="size-4" />}
        label="Cache rate"
        value={formatPercent(kpis?.cacheRate ?? 0)}
      />
      <MetricCard
        icon={<Timer className="size-4" />}
        label="P50 / P95 duration"
        value={`${formatDuration(kpis?.p50DurationMs)} / ${formatDuration(kpis?.p95DurationMs)}`}
      />
      <MetricCard
        icon={<Clock3 className="size-4" />}
        label="P50 TTFT"
        value={formatDuration(kpis?.p50TimeToFirstTokenMs)}
      />
      <MetricCard
        icon={<AlertTriangle className="size-4" />}
        label="Context ≥70%"
        value={formatTokens(kpis?.contextPressureTurnCount ?? 0)}
      />
    </section>
  );
}

function MetricToggle({
  value,
  onChange,
}: {
  value: TrendMetric;
  onChange: (value: TrendMetric) => void;
}) {
  return (
    <div aria-label="Metric xu hướng" className="bg-muted flex rounded-lg p-1">
      {(["tokens", "cost", "turns"] as const).map((item) => (
        <Button
          key={item}
          aria-pressed={value === item}
          size="sm"
          variant={value === item ? "outline" : "ghost"}
          onClick={() => onChange(item)}
        >
          {item === "tokens" ? "Token" : item === "cost" ? "Cost" : "Turns"}
        </Button>
      ))}
    </div>
  );
}

function TurnList({
  columns,
  desktop,
  filters,
  loading,
  onColumnsChange,
  onOpen,
  onPageChange,
  onToggle,
  selected,
  totalPages,
  turns,
}: {
  columns: Set<VisibleColumn>;
  desktop: boolean;
  filters: TurnFilters;
  loading: boolean;
  onColumnsChange: (columns: Set<VisibleColumn>) => void;
  onOpen: (id: string) => void;
  onPageChange: (page: number) => void;
  onToggle: (id: string) => void;
  selected: string[];
  totalPages: number;
  turns: TurnSummary[];
}) {
  return (
    <Card className="deferred-section overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Danh sách turns</CardTitle>
          <CardDescription className="mt-1">Chọn tối đa 4 turn để so sánh.</CardDescription>
        </div>
        <Select
          value="columns"
          onValueChange={(value) => {
            if (value === "columns") return;
            const key = value as VisibleColumn;
            const next = new Set(columns);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            onColumnsChange(next);
          }}
        >
          <SelectTrigger aria-label="Chọn cột hiển thị" className="w-36">
            <Columns3 className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem disabled value="columns">
              Chọn cột
            </SelectItem>
            {columnOptions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {columns.has(item.id) ? "✓ " : ""}
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        {loading && turns.length === 0 ? <Skeleton className="m-6 h-80" /> : null}
        {!loading && turns.length === 0 ? (
          <EmptyState message="Không có turn phù hợp với bộ lọc." />
        ) : null}
        {turns.length > 0 ? (
          <>
            {desktop ? (
              <div data-testid="turn-table">
                <Table scrollLabel="Danh sách turns">
                  <TableHeader className="bg-card sticky top-0 z-10">
                    <TableRow>
                      <TableHead className="w-12">
                        <span className="sr-only">Chọn</span>
                      </TableHead>
                      <TableHead>Turn</TableHead>
                      {columns.has("model") ? <TableHead>Model</TableHead> : null}
                      <TableHead className="text-right">Token</TableHead>
                      {columns.has("cache") ? (
                        <TableHead className="text-right">Cache</TableHead>
                      ) : null}
                      {columns.has("context") ? (
                        <TableHead className="text-right">Context</TableHead>
                      ) : null}
                      {columns.has("duration") ? (
                        <TableHead className="text-right">Duration</TableHead>
                      ) : null}
                      {columns.has("cost") ? (
                        <TableHead className="text-right">Cost</TableHead>
                      ) : null}
                      {columns.has("status") ? <TableHead>Trạng thái</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {turns.map((turn) => (
                      <TableRow key={turn.turnKey}>
                        <TableCell>
                          <CompareButton
                            disabled={!selected.includes(turn.turnKey) && selected.length >= 4}
                            selected={selected.includes(turn.turnKey)}
                            turn={turn}
                            onToggle={onToggle}
                          />
                        </TableCell>
                        <TableCell className="max-w-80">
                          <button
                            className="focus-visible:ring-ring w-full rounded text-left outline-none focus-visible:ring-2"
                            type="button"
                            onClick={() => onOpen(turn.turnKey)}
                          >
                            <span className="block truncate font-medium">{turnLabel(turn)}</span>
                            <span className="text-muted-foreground block truncate font-mono text-xs">
                              {shortId(turn.turnKey)} ·{" "}
                              {formatDateTime(turn.startedAt ?? turn.lastEventAt)}
                            </span>
                          </button>
                        </TableCell>
                        {columns.has("model") ? (
                          <TableCell>
                            <ModelBadges models={turn.models} />
                          </TableCell>
                        ) : null}
                        <TableCell className="text-right tabular-nums">
                          {formatTokens(turn.totalTokens)}
                        </TableCell>
                        {columns.has("cache") ? (
                          <TableCell className="text-right tabular-nums">
                            {formatPercent(turn.cacheRate)}
                          </TableCell>
                        ) : null}
                        {columns.has("context") ? (
                          <TableCell className="text-right">
                            <ContextBadge value={turn.contextUtilizationPercent} />
                          </TableCell>
                        ) : null}
                        {columns.has("duration") ? (
                          <TableCell className="text-right tabular-nums">
                            {formatDuration(turn.durationMs)}
                          </TableCell>
                        ) : null}
                        {columns.has("cost") ? (
                          <TableCell className="text-right">
                            <CostValue coverage={turn.costCoverage} value={turn.estimatedCostUsd} />
                          </TableCell>
                        ) : null}
                        {columns.has("status") ? (
                          <TableCell>
                            <StatusBadge status={turn.status} />
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="grid gap-3 p-4" data-testid="turn-cards">
                {turns.map((turn) => (
                  <article key={turn.turnKey} className="rounded-xl border p-4">
                    <div className="flex items-start gap-3">
                      <CompareButton
                        disabled={!selected.includes(turn.turnKey) && selected.length >= 4}
                        selected={selected.includes(turn.turnKey)}
                        turn={turn}
                        onToggle={onToggle}
                      />
                      <button
                        className="min-w-0 flex-1 text-left"
                        type="button"
                        onClick={() => onOpen(turn.turnKey)}
                      >
                        <span className="block font-medium">{turnLabel(turn)}</span>
                        <span className="text-muted-foreground mt-1 block text-xs">
                          {formatDateTime(turn.startedAt ?? turn.lastEventAt)}
                        </span>
                      </button>
                      <StatusBadge status={turn.status} />
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <Metric label="Token" value={formatTokens(turn.totalTokens)} />
                      <Metric
                        label="Cost"
                        value={
                          <CostValue coverage={turn.costCoverage} value={turn.estimatedCostUsd} />
                        }
                      />
                      <Metric label="Cache" value={formatPercent(turn.cacheRate)} />
                      <Metric
                        label="Context"
                        value={<ContextBadge value={turn.contextUtilizationPercent} />}
                      />
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : null}
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            Trang {filters.page ?? 1} / {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={(filters.page ?? 1) <= 1}
              size="sm"
              variant="outline"
              onClick={() => onPageChange((filters.page ?? 1) - 1)}
            >
              Trước
            </Button>
            <Button
              disabled={(filters.page ?? 1) >= totalPages}
              size="sm"
              variant="outline"
              onClick={() => onPageChange((filters.page ?? 1) + 1)}
            >
              Sau
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TurnDetailSheet({
  data,
  error,
  loading,
  onOpenChange,
  open,
  restoreFocus,
}: {
  data: Awaited<ReturnType<typeof fetchTurnDetail>> | undefined;
  error: string | undefined;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocus: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="pr-8 text-left">
          <SheetTitle>{data ? turnLabel(data.turn) : "Chi tiết turn"}</SheetTitle>
          <SheetDescription>
            {data
              ? `${shortId(data.turn.turnKey)} · ${formatDateTime(data.turn.startedAt ?? data.turn.lastEventAt)}`
              : "Token, context và metadata activity"}
          </SheetDescription>
        </SheetHeader>
        {loading ? <Skeleton className="h-[620px]" /> : null}
        {error ? <ErrorCard message={error} /> : null}
        {data ? (
          <Tabs defaultValue="overview">
            <TabsList aria-label="Nội dung turn" className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">Tổng quan</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="agents">Cây agent</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <TurnOverview data={data} />
            </TabsContent>
            <TabsContent value="timeline">
              <TurnTimeline data={data} />
            </TabsContent>
            <TabsContent value="agents">
              <ThreadTree data={data} />
            </TabsContent>
          </Tabs>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function TurnOverview({ data }: { data: Awaited<ReturnType<typeof fetchTurnDetail>> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <InfoCard label="Trạng thái" value={<StatusBadge status={data.turn.status} />} />
        <InfoCard label="Token" value={formatTokens(data.turn.totalTokens)} />
        <InfoCard
          label="Cost"
          value={<CostValue coverage={data.turn.costCoverage} value={data.turn.estimatedCostUsd} />}
        />
        <InfoCard label="Cache rate" value={formatPercent(data.turn.cacheRate)} />
        <InfoCard label="Duration" value={formatDuration(data.turn.durationMs)} />
        <InfoCard label="TTFT" value={formatDuration(data.turn.timeToFirstTokenMs)} />
        <InfoCard
          label="Context"
          value={<ContextBadge value={data.turn.contextUtilizationPercent} />}
        />
        <InfoCard
          label="Peak input"
          value={data.turn.peakInputTokens === null ? "—" : formatTokens(data.turn.peakInputTokens)}
        />
        <InfoCard label="Effort" value={data.turn.effort ?? "—"} />
      </div>
      {data.turn.costCoverage !== "exact" ? (
        <CoverageNotice message="Cost của turn này không đầy đủ vì một phần usage legacy không còn price snapshot. App không áp rate hiện tại để tạo số giả." />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Model breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.models.map((model) => (
            <div
              key={model.model}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border p-3 text-sm"
            >
              <span className="truncate font-medium">{model.model}</span>
              <span className="tabular-nums">{formatTokens(model.totalTokens)}</span>
              <CostValue coverage={model.costCoverage} value={model.estimatedCostUsd} />
            </div>
          ))}
          {data.models.length === 0 ? (
            <EmptyState message="Turn chưa có usage được attribution." />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Activity counters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.activity.map((item) => (
            <Badge key={item.kind} variant="outline">
              {activityLabel(item.kind)} · {formatTokens(item.count)}
            </Badge>
          ))}
          {data.activity.length === 0 ? (
            <span className="text-muted-foreground text-sm">Chưa có activity metadata.</span>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function TurnTimeline({ data }: { data: Awaited<ReturnType<typeof fetchTurnDetail>> }) {
  const events = [
    ...data.requests.map((item) => ({
      id: item.id,
      kind: "usage" as const,
      label: `${item.model} · ${formatTokens(item.totalTokens)} token`,
      timestamp: item.timestamp,
    })),
    ...data.activityTimeline.map((item) => ({
      id: item.id,
      kind: item.kind,
      label: activityLabel(item.kind),
      timestamp: item.timestamp,
    })),
  ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return (
    <div className="space-y-4">
      {data.timelineCoverage.status !== "full" ? (
        <CoverageNotice message="Raw timeline đã bị retention dọn một phần hoặc toàn bộ; aggregate của turn vẫn được giữ." />
      ) : null}
      {data.timelineTruncated ? (
        <CoverageNotice message="Timeline quá lớn nên API chỉ trả 2.000 record đầu tiên." />
      ) : null}
      <ol className="relative space-y-1 border-l pl-5">
        {events.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="hover:bg-muted/50 relative rounded-lg p-3">
            <span className="bg-primary ring-background absolute top-5 -left-[1.45rem] size-2.5 rounded-full ring-4" />
            <p className="text-sm font-medium">{item.label}</p>
            <time className="text-muted-foreground text-xs">{formatDateTime(item.timestamp)}</time>
          </li>
        ))}
      </ol>
      {events.length === 0 ? <EmptyState message="Không còn raw timeline cho turn này." /> : null}
    </div>
  );
}

function ThreadTree({ data }: { data: Awaited<ReturnType<typeof fetchTurnDetail>> }) {
  return (
    <div className="space-y-4">
      <CoverageNotice message="Đây là cây thread của session theo parentThreadId. App không suy đoán subagent thuộc parent turn nào." />
      <div className="space-y-2">
        {data.threadAgents.map((agent) => (
          <div
            key={agent.agentId}
            className="rounded-lg border p-3"
            style={{ marginLeft: `${Math.min(agent.depth, 5) * 12}px` }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Bot className="size-4" />
              <span className="font-medium">
                {agent.name ?? agent.role ?? shortId(agent.agentId)}
              </span>
              <Badge variant={agent.isSubagent ? "secondary" : "outline"}>
                {agent.isSubagent ? `Subagent · depth ${agent.depth}` : "Main agent"}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-xs">
              parent: {agent.parentAgentId ? shortId(agent.parentAgentId) : "—"}
            </p>
          </div>
        ))}
        {data.threadAgents.length === 0 ? (
          <EmptyState message="Không còn metadata cây thread." />
        ) : null}
      </div>
    </div>
  );
}

function TurnComparisonSheet({
  data,
  missingIds,
  onOpenChange,
  open,
  restoreFocus,
}: {
  data: TurnSummary[];
  missingIds: string[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocus: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-5xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="pr-8 text-left">
          <SheetTitle>So sánh turns</SheetTitle>
          <SheetDescription>So sánh 2–4 turn theo đúng thứ tự đã chọn.</SheetDescription>
        </SheetHeader>
        {missingIds.length > 0 ? (
          <CoverageNotice message={`Không tìm thấy: ${missingIds.map(shortId).join(", ")}`} />
        ) : null}
        {data.length >= 2 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {data.map((turn) => (
              <Card key={turn.turnKey}>
                <CardHeader>
                  <CardTitle className="leading-snug">{turnLabel(turn)}</CardTitle>
                  <CardDescription>{shortId(turn.turnKey)}</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-3">
                    <Metric label="Token" value={formatTokens(turn.totalTokens)} />
                    <Metric
                      label="Cost"
                      value={
                        <CostValue coverage={turn.costCoverage} value={turn.estimatedCostUsd} />
                      }
                    />
                    <Metric label="Cache" value={formatPercent(turn.cacheRate)} />
                    <Metric label="Duration" value={formatDuration(turn.durationMs)} />
                    <Metric label="TTFT" value={formatDuration(turn.timeToFirstTokenMs)} />
                    <Metric
                      label="Context"
                      value={<ContextBadge value={turn.contextUtilizationPercent} />}
                    />
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState message="Cần 2–4 turn hợp lệ để so sánh." />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CompareButton({
  disabled,
  onToggle,
  selected,
  turn,
}: {
  disabled: boolean;
  onToggle: (id: string) => void;
  selected: boolean;
  turn: TurnSummary;
}) {
  return (
    <Button
      aria-label={`${selected ? "Bỏ chọn" : "Chọn"} ${turnLabel(turn)} để so sánh`}
      aria-pressed={selected}
      disabled={disabled}
      size="icon"
      title={disabled ? "Đã chọn tối đa 4 turn" : undefined}
      variant={selected ? "secondary" : "ghost"}
      onClick={() => onToggle(turn.turnKey)}
    >
      {selected ? <Check className="size-4" /> : <GitCompareArrows className="size-4" />}
    </Button>
  );
}

function ContextBadge({ value }: { value: number | null }) {
  if (value === null) return <Badge variant="outline">Thiếu metadata</Badge>;
  return (
    <Badge
      className={cn(
        value >= 95
          ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
          : value >= 85
            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : value >= 70
              ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
              : undefined,
      )}
      variant="outline"
    >
      {formatPercent(value)}
    </Badge>
  );
}

function CostValue({ coverage, value }: { coverage: TurnCostCoverage; value: number }) {
  if (coverage === "unavailable")
    return (
      <span className="text-muted-foreground" title="Không đủ price snapshot">
        —
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {formatUsd(value)}
      {coverage === "partial" ? <Badge variant="outline">Một phần</Badge> : null}
    </span>
  );
}

function StatusBadge({ status }: { status: TurnSummary["status"] }) {
  return (
    <Badge
      variant={
        status === "completed" ? "outline" : status === "aborted" ? "destructive" : "secondary"
      }
    >
      {status === "completed" ? "Hoàn tất" : status === "aborted" ? "Đã huỷ" : "Không rõ"}
    </Badge>
  );
}

function ModelBadges({ models }: { models: string[] }) {
  return (
    <div className="flex max-w-52 flex-wrap gap-1">
      {models.slice(0, 2).map((model) => (
        <Badge key={model} variant="outline">
          {model}
        </Badge>
      ))}
      {models.length > 2 ? <Badge variant="secondary">+{models.length - 2}</Badge> : null}
      {models.length === 0 ? <span className="text-muted-foreground">—</span> : null}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-muted/55 rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function CoverageNotice({ message }: { message: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <p>{message}</p>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="text-destructive flex gap-3 pt-6 text-sm">
        <AlertTriangle className="size-4 shrink-0" />
        <p>{message}</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <Activity className="size-6 opacity-50" />
      <p>{message}</p>
    </div>
  );
}

function turnLabel(turn: TurnSummary): string {
  const title = turn.sessionTitle?.trim();
  const base = title && title.length > 0 ? title : shortId(turn.sessionId);
  if (turn.agentKind === "subagent")
    return `${base} · ${turn.agentName ?? turn.role ?? "Subagent"} · Turn ${turn.ordinal}`;
  return `${base} · Turn ${turn.ordinal}`;
}

function coverageLabel(coverage: TurnCostCoverage): string {
  return coverage === "exact"
    ? "Cost exact"
    : coverage === "partial"
      ? "Cost một phần"
      : "Chưa có cost";
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  if (value < 3_600_000)
    return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
  return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME_FORMATTER.format(date);
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function activityLabel(kind: ActivityKind | "usage"): string {
  switch (kind) {
    case "abort":
      return "Abort";
    case "compaction":
      return "Context compaction";
    case "file":
      return "File";
    case "mcp":
      return "MCP";
    case "other":
      return "Khác";
    case "patch":
      return "Patch";
    case "shell":
      return "Shell";
    case "task_completed":
      return "Task complete";
    case "task_started":
      return "Task start";
    case "turn":
      return "Turn";
    case "usage":
      return "Token usage";
    case "web":
      return "Web";
  }
}

function setFilter(
  filters: TurnFilters,
  key: "effort" | "pressure" | "query" | "status",
  value: string,
): TurnFilters {
  const next = { ...filters, page: 1 };
  if (!value.trim() || value === "all") {
    switch (key) {
      case "effort":
        delete next.effort;
        break;
      case "pressure":
        delete next.pressure;
        break;
      case "query":
        delete next.query;
        break;
      case "status":
        delete next.status;
        break;
    }
    return next;
  }
  if (
    key === "pressure" &&
    (value === "70" ||
      value === "70-84" ||
      value === "85" ||
      value === "85-94" ||
      value === "95" ||
      value === "95+" ||
      value === "below-70" ||
      value === "unknown")
  )
    next.pressure = value;
  else if (
    key === "status" &&
    (value === "completed" || value === "aborted" || value === "unknown")
  )
    next.status = value;
  else if (key === "effort") next.effort = value.trim();
  else if (key === "query") next.query = value;
  return next;
}

function pickAdvancedFilters(filters: TurnFilters): Omit<TurnFilters, keyof AgentFilters> {
  const next: Omit<TurnFilters, keyof AgentFilters> = {};
  if (filters.agentId) next.agentId = filters.agentId;
  if (filters.effort) next.effort = filters.effort;
  if (filters.order) next.order = filters.order;
  if (filters.pageSize) next.pageSize = filters.pageSize;
  if (filters.pressure) next.pressure = filters.pressure;
  if (filters.query) next.query = filters.query;
  if (filters.sessionId) next.sessionId = filters.sessionId;
  if (filters.sort) next.sort = filters.sort;
  if (filters.status) next.status = filters.status;
  return next;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function withoutIds(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete("ids");
  return next;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

const columnOptions: { id: VisibleColumn; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "cache", label: "Cache" },
  { id: "context", label: "Context" },
  { id: "duration", label: "Duration" },
  { id: "cost", label: "Cost" },
  { id: "status", label: "Trạng thái" },
];
