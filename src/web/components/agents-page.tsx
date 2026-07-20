import { useQuery } from "@tanstack/react-query";
import { Bot, Database, GitBranch } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

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
  fetchAgentsPage,
  fetchAgentsSummary,
  fetchProjectOptions,
  filtersFromSearch,
  formatPercent,
  formatTokens,
  formatUsd,
  updateFilterSearch,
} from "@/web/lib/product-api";
import { useMediaQuery } from "@/web/lib/use-media-query";
import type { AgentFilters, AgentLeaderboardItem, AgentLeaderboardMetric } from "@/shared/types";

type LeaderboardMetric = AgentLeaderboardMetric;
type TrendMetric = "cost" | "tokens";
const AGENT_PAGE_SIZE = 50;

const AgentDonut = lazy(async () => ({
  default: (await import("@/web/components/agent-charts")).AgentDonut,
}));
const AgentTrend = lazy(async () => ({
  default: (await import("@/web/components/agent-charts")).AgentTrend,
}));

export function AgentsPage() {
  const desktopLeaderboard = useMediaQuery("(min-width: 768px)");
  const [search, setSearch] = useSearchParams();
  const filters = useMemo<AgentFilters>(() => {
    const base: AgentFilters = filtersFromSearch(search);
    const role = search.get("role")?.trim();
    const depthText = search.get("depth");
    if (role) base.role = role;
    if (depthText && /^\d+$/.test(depthText)) base.depth = Number(depthText);
    return base;
  }, [search]);
  const metric = parseLeaderboardMetric(search.get("agentSort"));
  const page = positiveInteger(search.get("agentPage")) ?? 1;
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("tokens");
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => fetchModels(signal),
    staleTime: 5 * 60_000,
  });
  const projectFilter = useMemo(() => {
    const value: AgentFilters = { from: filters.from, to: filters.to };
    if (filters.agentKind) value.agentKind = filters.agentKind;
    if (filters.model) value.model = filters.model;
    if (filters.models) value.models = filters.models;
    if (filters.tagIds) value.tagIds = filters.tagIds;
    return value;
  }, [filters.agentKind, filters.from, filters.model, filters.models, filters.tagIds, filters.to]);
  const projects = useQuery({
    queryKey: ["projects", "options", projectFilter],
    queryFn: ({ signal }) => fetchProjectOptions(projectFilter, signal),
    staleTime: 5 * 60_000,
  });
  const agentSummary = useQuery({
    queryKey: ["agents", "summary", filters],
    queryFn: ({ signal }) => fetchAgentsSummary(filters, signal),
    staleTime: 30_000,
  });
  const agentPageFilters = useMemo(
    () => ({ ...filters, order: "desc" as const, page, pageSize: AGENT_PAGE_SIZE, sort: metric }),
    [filters, metric, page],
  );
  const agents = useQuery({
    queryKey: ["agents", "page", agentPageFilters],
    queryFn: ({ signal }) => fetchAgentsPage(agentPageFilters, signal),
    staleTime: 30_000,
  });
  const pageCount = Math.max(1, Math.ceil((agents.data?.total ?? 0) / AGENT_PAGE_SIZE));

  function applyFilters(next: AgentFilters) {
    const updated = updateFilterSearch(search, next);
    if (next.role) updated.set("role", next.role);
    else updated.delete("role");
    if (next.depth !== undefined) updated.set("depth", String(next.depth));
    else updated.delete("depth");
    updated.delete("agentPage");
    setSearch(updated);
  }

  function selectMetric(next: LeaderboardMetric) {
    const updated = new URLSearchParams(search);
    updated.set("agentSort", next);
    updated.delete("agentPage");
    setSearch(updated);
  }

  function selectPage(next: number) {
    const updated = new URLSearchParams(search);
    if (next <= 1) updated.delete("agentPage");
    else updated.set("agentPage", String(next));
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
        <Badge variant="outline">{agentSummary.data?.totalAgents ?? 0} agent</Badge>
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

      {agentSummary.isError ? <ErrorCard message={agentSummary.error.message} /> : null}
      {agents.isError ? <ErrorCard message={agents.error.message} /> : null}
      {agentSummary.data && agentSummary.data.coverage.status !== "full" ? (
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
            {agentSummary.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <Suspense fallback={<Skeleton className="h-72" />}>
                <AgentDonut main={agentSummary.data?.main} subagent={agentSummary.data?.subagent} />
              </Suspense>
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
            {agentSummary.isLoading ? (
              <Skeleton className="h-72" />
            ) : (
              <Suspense fallback={<Skeleton className="h-72" />}>
                <AgentTrend data={agentSummary.data?.daily ?? []} metric={trendMetric} />
              </Suspense>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="deferred-section overflow-hidden">
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
                onClick={() => selectMetric(item.id)}
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
          {desktopLeaderboard ? (
            <div className="overflow-x-auto" data-testid="agent-table">
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
                  {(agents.data?.agents ?? []).map((agent, index) => (
                    <TableRow key={agent.agentId}>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {(page - 1) * AGENT_PAGE_SIZE + index + 1}
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
                          {agent.topModels.map((model) => (
                            <Badge key={model} variant="outline">
                              {model}
                            </Badge>
                          ))}
                          {agent.modelCount > agent.topModels.length ? (
                            <Badge variant="secondary">
                              +{agent.modelCount - agent.topModels.length}
                            </Badge>
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
                  {!agents.isLoading && agents.data?.agents.length === 0 ? (
                    <TableRow>
                      <TableCell className="text-muted-foreground h-28 text-center" colSpan={10}>
                        Không có agent khớp filter.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid gap-3 p-4" data-testid="agent-cards">
              {(agents.data?.agents ?? []).map((agent, index) => (
                <AgentCard
                  key={agent.agentId}
                  agent={agent}
                  rank={(page - 1) * AGENT_PAGE_SIZE + index + 1}
                  turnTarget={turnTarget(agent.agentId)}
                />
              ))}
            </div>
          )}
          {agents.data && agents.data.total > AGENT_PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-3 border-t p-4">
              <p className="text-muted-foreground text-sm">
                Trang {page} / {pageCount} · {formatTokens(agents.data.total)} agent
              </p>
              <div className="flex gap-2">
                <Button
                  aria-label="Trang agent trước"
                  disabled={page <= 1 || agents.isFetching}
                  size="sm"
                  variant="outline"
                  onClick={() => selectPage(page - 1)}
                >
                  Trước
                </Button>
                <Button
                  aria-label="Trang agent tiếp theo"
                  disabled={page >= pageCount || agents.isFetching}
                  size="sm"
                  variant="outline"
                  onClick={() => selectPage(page + 1)}
                >
                  Sau
                </Button>
              </div>
            </div>
          ) : null}
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

function AgentCard({
  agent,
  rank,
  turnTarget,
}: {
  agent: AgentLeaderboardItem;
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
function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive">
      <CardContent className="pt-6 text-sm">Không tải được dữ liệu: {message}</CardContent>
    </Card>
  );
}
function agentLabel(agent: AgentLeaderboardItem) {
  return agent.name ?? agent.role ?? (agent.isSubagent ? "Subagent chưa đặt tên" : "Main agent");
}
function shortId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
function safeRatio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}
function parseLeaderboardMetric(value: string | null): LeaderboardMetric {
  return value === "cache" ||
    value === "cost" ||
    value === "output" ||
    value === "requests" ||
    value === "tokens"
    ? value
    : "tokens";
}
function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
