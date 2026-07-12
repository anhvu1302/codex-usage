import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpToLine,
  CircleDollarSign,
  Database,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useDeferredValue, useState, useTransition } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import {
  fetchDashboard,
  fetchModels,
  fetchSessions,
  fetchStatus,
  syncSessions,
} from "@/web/lib/api";
import { DateRangePicker } from "@/web/components/date-range-picker";
import { MetricCard } from "@/web/components/metric-card";
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
  SessionUsage,
} from "@/shared/types";

const chartConfig = {
  cost: { color: "var(--foreground)", label: "Cost (USD)" },
} satisfies ChartConfig;

const modelColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const modelColumns: ColumnDef<ModelUsage>[] = [
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) => <span className="font-medium">{row.original.model}</span>,
  },
  {
    accessorKey: "requestCount",
    header: "Requests",
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
    accessorKey: "outputTokens",
    header: "Output",
    cell: ({ row }) => formatTokens(row.original.outputTokens),
  },
  {
    accessorKey: "totalTokens",
    header: "Total",
    cell: ({ row }) => formatTokens(row.original.totalTokens),
  },
  {
    accessorKey: "estimatedCostUsd",
    header: "Cost",
    cell: ({ row }) => formatUsd(row.original.estimatedCostUsd),
  },
  {
    accessorKey: "tokenShare",
    header: "Share",
    cell: ({ row }) => <ShareBar value={row.original.tokenShare} />,
  },
  {
    id: "unpriced",
    header: "Pricing",
    cell: ({ row }) =>
      row.original.unpricedUsageCount > 0 ? (
        <Badge variant="secondary">{row.original.unpricedUsageCount} chưa định giá</Badge>
      ) : (
        <Badge variant="outline">Đã định giá</Badge>
      ),
  },
];

export function DashboardView() {
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters());
  const [selectedSession, setSelectedSession] = useState<SessionUsage | null>(null);
  const [isFiltering, startFiltering] = useTransition();
  const deferredFilters = useDeferredValue(filters);
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard", deferredFilters],
    queryFn: () => fetchDashboard(deferredFilters),
  });
  const sessions = useQuery({
    queryKey: ["sessions", deferredFilters],
    queryFn: () => fetchSessions(deferredFilters),
  });
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });
  const status = useQuery({ queryKey: ["status"], queryFn: fetchStatus, refetchInterval: 10_000 });
  const showHourly = deferredFilters.from === deferredFilters.to;
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
  });

  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Token usage</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Ước tính theo rate card USD, timezone Asia/Ho_Chi_Minh.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <DateRangePicker
            value={filters}
            onChange={(range) => {
              startFiltering(() => {
                setFilters((current) => ({ ...current, ...range }));
              });
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              const today = localDate(new Date());
              startFiltering(() => {
                setFilters((current) => ({ ...current, from: today, to: today }));
              });
            }}
          >
            Hôm nay
          </Button>
          <Select
            value={filters.model ?? "all"}
            onValueChange={(model) => {
              startFiltering(() => {
                setFilters((current) =>
                  model === "all" ? { from: current.from, to: current.to } : { ...current, model },
                );
              });
            }}
          >
            <SelectTrigger aria-busy={isFiltering} className="sm:w-52">
              <SelectValue placeholder="Tất cả model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả model</SelectItem>
              {models.data?.models.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => sync.mutate()} disabled={sync.isPending || status.data?.isSyncing}>
            <RefreshCw
              className={
                sync.isPending || status.data?.isSyncing ? "size-4 animate-spin" : "size-4"
              }
            />
            Sync now
          </Button>
        </div>
      </section>

      {dashboard.isError ? (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm">
            Không tải được dữ liệu: {dashboard.error.message}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {dashboard.isLoading ? <MetricSkeletons /> : <Metrics data={dashboard.data} />}
      </section>

      <section className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-5">
          <CardHeader>
            <CardTitle>Usage theo ngày</CardTitle>
            <CardDescription>Token và estimated cost của khoảng thời gian đã chọn.</CardDescription>
          </CardHeader>
          <CardContent>
            <UsageChart
              data={dashboard.data?.daily ?? []}
              modelData={dashboard.data?.dailyModels ?? []}
              models={dashboard.data?.models.map((model) => model.model) ?? []}
            />
          </CardContent>
        </Card>
        {showHourly ? (
          <Card className="xl:col-span-5">
            <CardHeader>
              <CardTitle>Usage theo giờ</CardTitle>
              <CardDescription>
                {deferredFilters.from} theo timezone Asia/Ho_Chi_Minh; token và cost theo từng giờ.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HourlyUsageChart
                data={dashboard.data?.hourly ?? []}
                modelData={dashboard.data?.hourlyModels ?? []}
                models={dashboard.data?.models.map((model) => model.model) ?? []}
              />
            </CardContent>
          </Card>
        ) : null}
        <Card className="xl:col-span-5">
          <CardHeader>
            <CardTitle>Breakdown theo model</CardTitle>
            <CardDescription>
              Requests canonical, input thường, cached input, output, token, cost và tỷ trọng.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="min-w-[1100px]">
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
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
                    <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
                      Chưa có usage trong khoảng này.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Chọn một session để xem token, model và trạng thái source file.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task / session</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data?.map((session) => (
                <TableRow
                  key={session.sessionId}
                  className="cursor-pointer"
                  onClick={() => setSelectedSession(session)}
                >
                  <TableCell className="max-w-96">
                    <p className="truncate font-medium" title={session.title ?? undefined}>
                      {session.title ?? "Chưa có tên task"}
                    </p>
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      {shortId(session.sessionId)}
                    </p>
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
              {!sessions.isLoading && sessions.data?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                    Chưa có session.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SessionSheet
        session={selectedSession}
        onOpenChange={(open) => !open && setSelectedSession(null)}
      />
    </div>
  );
}

function Metrics({ data }: { data: Awaited<ReturnType<typeof fetchDashboard>> | undefined }) {
  const kpis = data?.kpis;
  return (
    <>
      <MetricCard
        icon={<Activity className="size-4" />}
        label="Total tokens"
        value={formatTokens(kpis?.totalTokens ?? 0)}
      />
      <MetricCard
        icon={<CircleDollarSign className="size-4" />}
        label="Estimated cost"
        value={formatUsd(kpis?.estimatedCostUsd ?? 0)}
      />
      <MetricCard
        icon={<Activity className="size-4" />}
        label="Requests"
        value={formatTokens(kpis?.requestCount ?? 0)}
      />
      <MetricCard
        icon={<ArrowDownToLine className="size-4" />}
        label="Input (non-cache)"
        value={formatTokens((kpis?.inputTokens ?? 0) - (kpis?.cachedInputTokens ?? 0))}
      />
      <MetricCard
        icon={<Database className="size-4" />}
        label="Cached input"
        value={formatTokens(kpis?.cachedInputTokens ?? 0)}
      />
      <MetricCard
        icon={<ArrowUpToLine className="size-4" />}
        label="Output"
        value={formatTokens(kpis?.outputTokens ?? 0)}
      />
      <MetricCard
        icon={<Database className="size-4" />}
        label="Sessions"
        value={String(kpis?.sessionCount ?? 0)}
      />
      <MetricCard
        icon={<Sparkles className="size-4" />}
        label="Reasoning output"
        value={formatTokens(kpis?.reasoningOutputTokens ?? 0)}
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
  data,
  modelData,
  models,
}: {
  data: DailyUsage[];
  modelData: DailyModelUsage[];
  models: string[];
}) {
  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-72 items-center justify-center rounded-lg border border-dashed text-sm">
        Chưa có usage trong khoảng thời gian này.
      </div>
    );
  }

  const chart = buildModelChart(
    data.map((usage) => ({ bucket: usage.date, cost: usage.estimatedCostUsd })),
    modelData.map((usage) => ({
      bucket: usage.date,
      model: usage.model,
      totalTokens: usage.totalTokens,
    })),
    models,
  );

  return (
    <ChartContainer config={chartConfig}>
      <ComposedChart data={chart.points} margin={{ left: 8, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(value: string) => value.slice(5)}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          yAxisId="tokens"
          tickFormatter={(value: number) => compactNumber(value)}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <YAxis
          yAxisId="cost"
          orientation="right"
          tickFormatter={(value: number) => `$${value.toFixed(1)}`}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip formatter={modelTooltipFormatter} />
        <Legend verticalAlign="top" />
        {chart.series.map((series) => (
          <Bar
            key={series.dataKey}
            yAxisId="tokens"
            dataKey={series.dataKey}
            name={series.model}
            stackId="tokens"
            fill={series.color}
          />
        ))}
        <Line
          yAxisId="cost"
          type="monotone"
          dataKey="cost"
          name="Cost"
          stroke="var(--foreground)"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

function HourlyUsageChart({
  data,
  modelData,
  models,
}: {
  data: HourlyUsage[];
  modelData: HourlyModelUsage[];
  models: string[];
}) {
  const chart = buildModelChart(
    data.map((usage) => ({ bucket: usage.hour, cost: usage.estimatedCostUsd })),
    modelData.map((usage) => ({
      bucket: usage.hour,
      model: usage.model,
      totalTokens: usage.totalTokens,
    })),
    models,
  );

  return (
    <ChartContainer config={chartConfig}>
      <ComposedChart data={chart.points} margin={{ left: 8, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucket" interval={2} tickLine={false} axisLine={false} />
        <YAxis
          yAxisId="tokens"
          tickFormatter={(value: number) => compactNumber(value)}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <YAxis
          yAxisId="cost"
          orientation="right"
          tickFormatter={(value: number) => `$${value.toFixed(1)}`}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip formatter={modelTooltipFormatter} />
        <Legend verticalAlign="top" />
        {chart.series.map((series) => (
          <Bar
            key={series.dataKey}
            yAxisId="tokens"
            dataKey={series.dataKey}
            name={series.model}
            stackId="tokens"
            fill={series.color}
          />
        ))}
        <Line
          yAxisId="cost"
          type="monotone"
          dataKey="cost"
          name="Cost"
          stroke="var(--foreground)"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

type ModelChartPoint = {
  [key: string]: number | string;
  bucket: string;
  cost: number;
};

function buildModelChart(
  totals: { bucket: string; cost: number }[],
  modelUsage: { bucket: string; model: string; totalTokens: number }[],
  models: string[],
) {
  const series = models.map((model, index) => ({
    color: modelColors[index % modelColors.length],
    dataKey: `model-${index}`,
    model,
  }));
  const dataKeyByModel = new Map(series.map((item) => [item.model, item.dataKey]));
  const points = totals.map<ModelChartPoint>((total) => ({
    bucket: total.bucket,
    cost: total.cost,
  }));
  const pointByBucket = new Map(points.map((point) => [point.bucket, point]));

  for (const usage of modelUsage) {
    const point = pointByBucket.get(usage.bucket);
    const dataKey = dataKeyByModel.get(usage.model);
    if (point && dataKey) Reflect.set(point, dataKey, usage.totalTokens);
  }

  return { points, series };
}

function modelTooltipFormatter(value: unknown, name: unknown) {
  const label = String(name);
  return [
    label === "Cost" ? formatUsd(Number(value)) : formatTokens(Number(value)),
    label,
  ] as const;
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
          <div className="grid gap-4 text-sm">
            <Detail label="Workspace" value={session.cwd ?? "Không có CWD"} />
            <Detail label="Models" value={session.models.join(", ")} />
            <Detail
              label="Tổng token (main + subagents)"
              value={formatTokens(session.totalTokens)}
            />
            <Detail
              label="Input / cached / output"
              value={`${formatTokens(session.inputTokens)} / ${formatTokens(session.cachedInputTokens)} / ${formatTokens(session.outputTokens)}`}
            />
            <Detail label="Estimated cost" value={formatUsd(session.estimatedCostUsd)} />
            <Detail label="First activity" value={formatDateTime(session.firstEventAt)} />
            <Detail label="Last activity" value={formatDateTime(session.lastEventAt)} />
            <Detail
              label="Source"
              value={session.sourceDeleted ? "Đã bị xóa (history vẫn lưu)" : "Còn trên disk"}
            />
            <AgentBreakdown agents={session.agents} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AgentSummary({ agents }: { agents: SessionAgentUsage[] }) {
  const subagents = agents.filter((agent) => agent.isSubagent);
  if (subagents.length === 0) return <Badge variant="outline">Main only</Badge>;

  const names = subagents
    .map((agent) => agent.name ?? "Unnamed")
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
  const subagents = agents.filter((agent) => agent.isSubagent);

  return (
    <section className="grid gap-3">
      <div>
        <h3 className="font-semibold">Agent breakdown</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Token và cost đã được gán theo từng JSONL source của Codex.
        </p>
      </div>
      {mainAgent ? <AgentCard agent={mainAgent} /> : null}
      {subagents.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs font-medium uppercase">
            Subagents ({subagents.length})
          </p>
          {subagents.map((agent) => (
            <AgentCard key={agent.agentId} agent={agent} />
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

function AgentCard({ agent }: { agent: SessionAgentUsage }) {
  const name = agent.isSubagent ? (agent.name ?? "Unnamed subagent") : "Main agent";
  return (
    <article className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant={agent.isSubagent ? "secondary" : "outline"}>
              {agent.isSubagent ? "Subagent" : "Main agent"}
            </Badge>
            {agent.role ? <Badge variant="outline">{agent.role}</Badge> : null}
            {agent.depth > 0 ? <Badge variant="outline">Depth {agent.depth}</Badge> : null}
            {agent.sourceDeleted ? <Badge variant="outline">Source deleted</Badge> : null}
          </div>
        </div>
        <span className="text-muted-foreground font-mono text-xs">{shortId(agent.agentId)}</span>
      </div>
      {agent.taskSummary ? (
        <p className="text-muted-foreground text-xs">{agent.taskSummary}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <AgentMetric label="Tokens" value={formatTokens(agent.totalTokens)} />
        <AgentMetric label="Cost" value={formatUsd(agent.estimatedCostUsd)} />
        <AgentMetric label="Models" value={agent.models.join(", ") || "Unknown"} />
        <AgentMetric label="Last activity" value={formatDateTime(agent.lastEventAt)} />
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

function defaultFilters(): DashboardFilters {
  const to = localDate(new Date());
  const fromDate = new Date(`${to}T12:00:00`);
  fromDate.setDate(fromDate.getDate() - 29);
  return { from: localDate(fromDate), to };
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
