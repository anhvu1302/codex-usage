import { useQuery } from "@tanstack/react-query";
import { Bot, Database, GitBranch, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ProductFilterBar } from "@/web/components/product-filter-bar";
import { ExportActions } from "@/web/components/product-tools";
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
import { Skeleton } from "@/web/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import { fetchModels } from "@/web/lib/api";
import {
  compactTokens,
  fetchAgents,
  fetchProjects,
  filtersFromSearch,
  formatPercent,
  formatTokens,
  formatUsd,
  updateFilterSearch,
} from "@/web/lib/product-api";
import type {
  AgentFilters,
  AgentUsageSummary,
  AgentsResponse,
  DashboardKpis,
} from "@/shared/types";

type LeaderboardMetric = "cache" | "cost" | "output" | "requests" | "tokens";
type TrendMetric = "cost" | "tokens";

const trendConfig = {
  main: { color: "var(--chart-1)", label: "Main agent" },
  subagent: { color: "var(--chart-4)", label: "Subagent" },
} satisfies ChartConfig;

export function AgentsPage() {
  const [search, setSearch] = useSearchParams();
  const filters = useMemo<AgentFilters>(() => {
    const base: AgentFilters = filtersFromSearch(search);
    const role = search.get("role")?.trim();
    const depthText = search.get("depth");
    if (role) base.role = role;
    if (depthText && /^\d+$/.test(depthText)) base.depth = Number(depthText);
    return base;
  }, [search]);
  const [metric, setMetric] = useState<LeaderboardMetric>("tokens");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("tokens");
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });
  const projectFilter = useMemo(() => {
    const value = { ...filters };
    delete value.projectId;
    return value;
  }, [filters]);
  const projects = useQuery({
    queryKey: ["projects", "agent-options", projectFilter],
    queryFn: () => fetchProjects(projectFilter),
  });
  const agents = useQuery({
    queryKey: ["agents", filters],
    queryFn: () => fetchAgents(filters),
  });
  const sortedAgents = useMemo(
    () =>
      [...(agents.data?.agents ?? [])].sort(
        (left, right) => metricValue(right, metric) - metricValue(left, metric),
      ),
    [agents.data?.agents, metric],
  );

  function applyFilters(next: AgentFilters) {
    const updated = updateFilterSearch(search, next);
    if (next.role) updated.set("role", next.role);
    else updated.delete("role");
    if (next.depth !== undefined) updated.set("depth", String(next.depth));
    else updated.delete("depth");
    setSearch(updated);
  }

  function turnTarget(agentId: string) {
    const next = updateFilterSearch(new URLSearchParams(), filters);
    next.set("agent", agentId);
    return { pathname: "/turns", search: next.toString() };
  }

  return (
    <div className="motion-stagger space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="bg-primary/10 text-primary rounded-lg p-2">
              <Bot className="size-5" aria-hidden="true" />
            </span>
            <Badge variant="secondary">Main + subagent</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Agent</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Metric kiểm chứng được theo agent, role, depth, project và model; không dùng điểm hiệu
            quả chủ quan.
          </p>
        </div>
        <Badge variant="outline">{agents.data?.agents.length ?? 0} agent</Badge>
      </header>

      <ProductFilterBar
        filters={filters}
        models={models.data?.models ?? []}
        onChange={applyFilters}
        projects={(projects.data?.projects ?? []).map((project) => ({
          id: project.id,
          name: project.displayName,
        }))}
        showAgentDetails
        showProject
      />

      {agents.isError ? <ErrorCard message={agents.error.message} /> : null}
      {agents.data?.coverage.status !== "full" ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex gap-3 pt-6 text-sm">
            <Database className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>
              Agent rollup vẫn giữ totals; metadata tên, role và cây agent có thể không đầy đủ ngoài
              raw retention 30 ngày.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <h2 className="sr-only">Phân tích usage theo agent</h2>

      <section className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Main vs subagent</CardTitle>
            <CardDescription>Tỷ trọng token và cost của range hiện tại.</CardDescription>
          </CardHeader>
          <CardContent>
            {agents.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <AgentDonut main={agents.data?.main} subagent={agents.data?.subagent} />
            )}
          </CardContent>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Xu hướng agent</CardTitle>
              <CardDescription className="mt-1">
                So sánh main agent và subagent theo ngày.
              </CardDescription>
            </div>
            <div className="bg-muted flex rounded-lg p-1" aria-label="Metric trend agent">
              {(["tokens", "cost"] as const).map((value) => (
                <Button
                  key={value}
                  aria-pressed={trendMetric === value}
                  size="sm"
                  variant={trendMetric === value ? "outline" : "ghost"}
                  onClick={() => setTrendMetric(value)}
                >
                  {value === "tokens" ? "Token" : "Cost"}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {agents.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <AgentTrend data={agents.data?.daily ?? []} metric={trendMetric} />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Agent leaderboard</CardTitle>
            <CardDescription className="mt-1">
              Xếp theo metric đã chọn; click metric để đổi thứ tự.
            </CardDescription>
          </div>
          <div
            className="flex max-w-full scrollbar-none gap-1 overflow-x-auto rounded-lg border p-1"
            aria-label="Sắp xếp agent"
          >
            {leaderboardMetrics.map((item) => (
              <Button
                key={item.id}
                aria-pressed={metric === item.id}
                size="sm"
                variant={metric === item.id ? "secondary" : "ghost"}
                onClick={() => setMetric(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {agents.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-14" />
              ))}
            </div>
          ) : null}
          <div className="grid gap-3 p-4 md:hidden">
            {sortedAgents.map((agent, index) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                rank={index + 1}
                turnTarget={turnTarget(agent.agentId)}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table className="min-w-[1100px]">
              <TableHeader className="bg-card sticky top-0 z-10">
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Yêu cầu</TableHead>
                  <TableHead>Cache rate</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Phiên</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAgents.map((agent, index) => (
                  <TableRow key={agent.agentId}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {index + 1}
                    </TableCell>
                    <TableCell className="max-w-72">
                      <Link
                        aria-label={`Xem turns của ${agentLabel(agent)}`}
                        className="focus-visible:ring-ring block rounded-sm outline-none focus-visible:ring-2"
                        to={turnTarget(agent.agentId)}
                      >
                        <span className="block truncate font-medium">{agentLabel(agent)}</span>
                        <span className="text-muted-foreground block truncate font-mono text-xs">
                          {shortId(agent.agentId)} · depth {agent.depth}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={agent.isSubagent ? "secondary" : "outline"}>
                        {agent.isSubagent ? "Subagent" : "Main"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-52 flex-wrap gap-1">
                        {agent.models.slice(0, 2).map((model) => (
                          <Badge key={model} variant="outline">
                            {model}
                          </Badge>
                        ))}
                        {agent.models.length > 2 ? (
                          <Badge variant="secondary">+{agent.models.length - 2}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="font-semibold tabular-nums">
                      {formatTokens(agent.totalTokens)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatUsd(agent.estimatedCostUsd)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTokens(agent.requestCount)}
                    </TableCell>
                    <TableCell>
                      {formatPercent(safeRatio(agent.cachedInputTokens, agent.inputTokens) * 100)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTokens(agent.outputTokens)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTokens(agent.sessionCount)}
                    </TableCell>
                  </TableRow>
                ))}
                {!agents.isLoading && sortedAgents.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-muted-foreground h-28 text-center" colSpan={10}>
                      Không có agent khớp filter.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ExportActions filters={filters} />
    </div>
  );
}

const leaderboardMetrics: { id: LeaderboardMetric; label: string }[] = [
  { id: "tokens", label: "Token" },
  { id: "cost", label: "Cost" },
  { id: "requests", label: "Yêu cầu" },
  { id: "cache", label: "Cache rate" },
  { id: "output", label: "Output" },
];

function AgentDonut({
  main,
  subagent,
}: {
  main: DashboardKpis | undefined;
  subagent: DashboardKpis | undefined;
}) {
  const data = [
    { name: "Main agent", value: main?.totalTokens ?? 0, cost: main?.estimatedCostUsd ?? 0 },
    { name: "Subagent", value: subagent?.totalTokens ?? 0, cost: subagent?.estimatedCostUsd ?? 0 },
  ];
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <EmptyChart />;
  return (
    <div className="grid items-center gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      <ChartContainer
        className="mx-auto h-56 w-full"
        config={trendConfig}
        role="img"
        aria-label="Biểu đồ tỷ trọng token main agent và subagent"
      >
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius={58}
            nameKey="name"
            outerRadius={88}
            paddingAngle={2}
          >
            {data.map((item, index) => (
              <Cell key={item.name} fill={index === 0 ? "var(--chart-1)" : "var(--chart-4)"} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatTokens(Number(value))} />
        </PieChart>
      </ChartContainer>
      <div className="space-y-3">
        {data.map((item, index) => (
          <div key={item.name} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: index === 0 ? "var(--chart-1)" : "var(--chart-4)" }}
              />
              {item.name}
            </span>
            <span className="text-right">
              <strong className="block">{formatPercent(safeRatio(item.value, total) * 100)}</strong>
              <span className="text-muted-foreground text-xs">
                {compactTokens(item.value)} · {formatUsd(item.cost)}
              </span>
            </span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Phân bổ token theo loại agent</caption>
        <tbody>
          {data.map((item) => (
            <tr key={item.name}>
              <th>{item.name}</th>
              <td>{item.value}</td>
              <td>{item.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentTrend({
  data: source,
  metric,
}: {
  data: AgentsResponse["daily"];
  metric: TrendMetric;
}) {
  const data = source.map((item) => ({
    date: item.date,
    main: metric === "tokens" ? item.main.totalTokens : item.main.estimatedCostUsd,
    subagent: metric === "tokens" ? item.subagent.totalTokens : item.subagent.estimatedCostUsd,
  }));
  if (data.length === 0) return <EmptyChart />;
  return (
    <>
      <ChartContainer
        config={trendConfig}
        role="img"
        aria-label={`Xu hướng ${metric === "tokens" ? "token" : "cost"} main agent và subagent`}
      >
        <LineChart data={data} margin={{ left: 5, right: 5, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={
              metric === "tokens" ? compactTokens : (value: number) => `$${value.toFixed(0)}`
            }
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            formatter={(value) =>
              metric === "tokens" ? formatTokens(Number(value)) : formatUsd(Number(value))
            }
          />
          <Line
            dataKey="main"
            dot={false}
            name="Main agent"
            stroke="var(--chart-1)"
            strokeWidth={2}
            type="monotone"
          />
          <Line
            dataKey="subagent"
            dot={false}
            name="Subagent"
            stroke="var(--chart-4)"
            strokeWidth={2}
            type="monotone"
          />
        </LineChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Xu hướng agent theo ngày</caption>
        <thead>
          <tr>
            <th>Ngày</th>
            <th>Main</th>
            <th>Subagent</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.date}>
              <td>{item.date}</td>
              <td>{item.main}</td>
              <td>{item.subagent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AgentCard({
  agent,
  rank,
  turnTarget,
}: {
  agent: AgentUsageSummary;
  rank: number;
  turnTarget: { pathname: string; search: string };
}) {
  return (
    <article className="bg-card rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          {rank}
        </span>
        <Link
          aria-label={`Xem turns của ${agentLabel(agent)}`}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2"
          to={turnTarget}
        >
          <span className="block truncate font-semibold">{agentLabel(agent)}</span>
          <span className="text-muted-foreground mt-1 block text-xs">
            {agent.isSubagent ? "Subagent" : "Main agent"} · depth {agent.depth}
          </span>
        </Link>
        <GitBranch className="text-muted-foreground size-4" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Stat label="Token" value={compactTokens(agent.totalTokens)} />
        <Stat label="Cost" value={formatUsd(agent.estimatedCostUsd)} />
        <Stat label="Yêu cầu" value={formatTokens(agent.requestCount)} />
        <Stat
          label="Cache rate"
          value={formatPercent(safeRatio(agent.cachedInputTokens, agent.inputTokens) * 100)}
        />
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums">{value}</p>
    </div>
  );
}
function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-64 items-center justify-center rounded-lg border border-dashed text-sm">
      <Sparkles className="mr-2 size-4" /> Chưa có dữ liệu.
    </div>
  );
}
function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive">
      <CardContent className="pt-6 text-sm">Không tải được dữ liệu: {message}</CardContent>
    </Card>
  );
}
function agentLabel(agent: AgentUsageSummary) {
  return agent.name ?? agent.role ?? (agent.isSubagent ? "Subagent chưa đặt tên" : "Main agent");
}
function shortId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
function safeRatio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}
function metricValue(agent: AgentUsageSummary, metric: LeaderboardMetric) {
  switch (metric) {
    case "cache":
      return safeRatio(agent.cachedInputTokens, agent.inputTokens);
    case "cost":
      return agent.estimatedCostUsd;
    case "output":
      return agent.outputTokens;
    case "requests":
      return agent.requestCount;
    case "tokens":
      return agent.totalTokens;
  }
}
