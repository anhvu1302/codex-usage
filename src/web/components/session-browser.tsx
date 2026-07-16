import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import type {
  DashboardFilters,
  SessionAgentUsage,
  SessionFilters,
  SessionSummary,
} from "@/shared/types";
import { fetchSessionDetail, fetchSessionSummaries } from "@/web/lib/api";
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

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

export function SessionBrowser({
  filters,
  onFiltersChange,
  pageSize = 10,
  showExport = false,
}: {
  filters: DashboardFilters;
  onFiltersChange: (filters: DashboardFilters) => void;
  pageSize?: number;
  showExport?: boolean;
}) {
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSort, setSessionSort] =
    useState<NonNullable<SessionFilters["sort"]>>("lastActivity");
  const desktopSessions = useSyncExternalStore(
    subscribeDesktopLayout,
    desktopLayoutSnapshot,
    () => false,
  );
  const deferredSessionQuery = useDebouncedValue(sessionQuery.trim(), 250);
  const sessionFilters = useMemo<SessionFilters>(
    () => ({
      ...filters,
      order: "desc",
      page: sessionPage,
      pageSize,
      ...(deferredSessionQuery ? { query: deferredSessionQuery } : {}),
      sort: sessionSort,
    }),
    [deferredSessionQuery, filters, pageSize, sessionPage, sessionSort],
  );
  const sessions = useQuery({
    queryKey: ["sessions", "summary", sessionFilters],
    queryFn: ({ signal }) => fetchSessionSummaries(sessionFilters, signal),
    staleTime: 30_000,
  });

  return (
    <>
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
        <CardContent className="p-0" aria-busy={sessions.isLoading}>
          {sessions.isError ? (
            <div
              className="border-destructive/40 bg-destructive/5 border-b p-4 text-sm"
              role="alert"
            >
              Không tải được danh sách session: {sessions.error.message}
            </div>
          ) : null}
          {sessions.data && sessions.data.coverage.status !== "full" ? (
            <div className="bg-muted/50 text-muted-foreground border-b px-6 py-3 text-sm">
              {sessions.data.coverage.status === "partial"
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
                setSessionPage(1);
                onFiltersChange(next);
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
                      <AgentSummary
                        agentCount={session.agentCount}
                        names={session.subagentNames}
                        subagentCount={session.subagentCount}
                      />
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
            <SessionCards sessions={sessions.data?.sessions ?? []} onSelect={setSelectedSession} />
          )}
          {sessions.data && sessions.data.total > sessions.data.pageSize ? (
            <div className="flex flex-col items-center justify-between gap-3 border-t px-4 py-3 sm:flex-row">
              <p className="text-muted-foreground text-xs">
                Trang {sessions.data.page}/{Math.ceil(sessions.data.total / sessions.data.pageSize)}{" "}
                · {sessions.data.total} session
              </p>
              <div className="flex gap-2">
                <Button
                  aria-label="Trang session trước"
                  size="sm"
                  variant="outline"
                  disabled={sessions.data.page <= 1}
                  onClick={() => setSessionPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="size-4" /> Trước
                </Button>
                <Button
                  aria-label="Trang session tiếp theo"
                  size="sm"
                  variant="outline"
                  disabled={sessions.data.page * sessions.data.pageSize >= sessions.data.total}
                  onClick={() => setSessionPage((current) => current + 1)}
                >
                  Sau <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {showExport ? <ExportActions datasets={["sessions"]} filters={sessionFilters} /> : null}

      <SessionSheet
        key={selectedSession?.sessionId ?? "closed"}
        filters={filters}
        session={selectedSession}
        onOpenChange={(open) => !open && setSelectedSession(null)}
      />
    </>
  );
}

function SessionCards({
  onSelect,
  sessions,
}: {
  onSelect: (session: SessionSummary) => void;
  sessions: SessionSummary[];
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

function SessionSheet({
  filters,
  onOpenChange,
  session,
}: {
  filters: DashboardFilters;
  onOpenChange: (open: boolean) => void;
  session: SessionSummary | null;
}) {
  const sessionId = session?.sessionId ?? "";
  const detail = useQuery({
    enabled: Boolean(session),
    queryKey: ["session", sessionId, filters],
    queryFn: ({ signal }) => fetchSessionDetail(sessionId, filters, signal),
    placeholderData: () => undefined,
    staleTime: 30_000,
  });

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
            {detail.isLoading ? <AgentBreakdownSkeleton /> : null}
            {detail.isError ? (
              <div
                className="border-destructive/40 bg-destructive/5 space-y-3 rounded-lg border p-4"
                role="alert"
              >
                <p>Không tải được chi tiết agent: {detail.error.message}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void detail.refetch()}
                >
                  Thử lại
                </Button>
              </div>
            ) : null}
            {detail.data ? <AgentBreakdown agents={detail.data.agents} /> : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AgentSummary({
  agentCount,
  names,
  subagentCount,
}: {
  agentCount: number;
  names: string[];
  subagentCount: number;
}) {
  if (subagentCount === 0) {
    return <Badge variant="outline">{agentCount > 0 ? "Chỉ main agent" : "Chưa có agent"}</Badge>;
  }
  const remaining = subagentCount - names.length;
  return (
    <div className="flex min-w-48 flex-wrap items-center gap-1">
      <Badge variant="secondary">
        {subagentCount} subagent{subagentCount === 1 ? "" : "s"}
      </Badge>
      <span className="text-muted-foreground text-xs">
        {names.join(", ") || "Chưa đặt tên"}
        {remaining > 0 ? ` +${remaining}` : ""}
      </span>
    </div>
  );
}

function AgentBreakdownSkeleton() {
  return (
    <section className="space-y-3" aria-label="Đang tải chi tiết agent" aria-busy="true">
      <Skeleton className="h-10 w-56" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-28 w-full" />
    </section>
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function subscribeDesktopLayout(callback: () => void): () => void {
  const media = window.matchMedia("(min-width: 768px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function desktopLayoutSnapshot(): boolean {
  return window.matchMedia("(min-width: 768px)").matches;
}

function formatTokens(value: number): string {
  return INTEGER_FORMATTER.format(value);
}

function formatUsd(value: number): string {
  return USD_FORMATTER.format(value);
}

function formatDateTime(value: string): string {
  return DATE_TIME_FORMATTER.format(new Date(value));
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
