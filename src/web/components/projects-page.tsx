import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderKanban, Pencil, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
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
  fetchProjects,
  filtersFromSearch,
  formatPercent,
  formatTokens,
  formatUsd,
  renameProject,
  updateFilterSearch,
} from "@/web/lib/product-api";
import type { AgentFilters, DailyUsage, ProjectSummary } from "@/shared/types";

const chartConfig = {
  cost: { color: "var(--chart-2)", label: "Cost" },
  tokens: { color: "var(--chart-1)", label: "Token" },
} satisfies ChartConfig;

export function ProjectsPage() {
  const [search, setSearch] = useSearchParams();
  const filters = useMemo<AgentFilters>(() => filtersFromSearch(search), [search]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });
  const projects = useQuery({
    queryKey: ["projects", filters],
    queryFn: () => fetchProjects(filters),
  });
  const selected =
    projects.data?.projects.find((project) => project.id === selectedId) ??
    projects.data?.projects[0];
  const rename = useMutation({
    mutationFn: ({ displayName, id }: { displayName: string; id: string }) =>
      renameProject(id, displayName),
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      setRenaming(null);
      toast.success("Đã đổi alias project.");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  function applyFilters(next: AgentFilters) {
    setSearch(updateFilterSearch(search, next));
  }

  const totals = useMemo(
    () =>
      (projects.data?.projects ?? []).reduce(
        (value, project) => ({
          cost: value.cost + project.estimatedCostUsd,
          requests: value.requests + project.requestCount,
          sessions: value.sessions + project.sessionCount,
          tokens: value.tokens + project.totalTokens,
        }),
        { cost: 0, requests: 0, sessions: 0, tokens: 0 },
      ),
    [projects.data?.projects],
  );

  return (
    <div className="motion-stagger space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="bg-primary/10 text-primary rounded-lg p-2">
              <FolderKanban className="size-5" aria-hidden="true" />
            </span>
            <Badge variant="secondary">Theo workspace</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Dự án</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Token, estimated cost, model mix và tỷ trọng subagent theo CWD đã chuẩn hoá.
          </p>
        </div>
        <Badge variant="outline">{projects.data?.projects.length ?? 0} dự án có usage</Badge>
      </header>

      <ProductFilterBar
        filters={filters}
        models={models.data?.models ?? []}
        onChange={applyFilters}
      />

      {projects.isError ? <ErrorCard message={projects.error.message} /> : null}

      <h2 className="sr-only">Phân tích usage theo project</h2>

      <section
        aria-label="Tổng usage theo project"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <SummaryCard label="Dự án" value={formatTokens(projects.data?.projects.length ?? 0)} />
        <SummaryCard label="Token" value={compactTokens(totals.tokens)} />
        <SummaryCard label="Cost ước tính" value={formatUsd(totals.cost)} />
        <SummaryCard
          label="Yêu cầu / phiên"
          value={`${formatTokens(totals.requests)} / ${formatTokens(totals.sessions)}`}
        />
      </section>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Usage theo dự án</CardTitle>
          <CardDescription>
            Chọn project để xem trend và task tốn nhiều nhất; alias chỉ đổi tên hiển thị.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {projects.isLoading ? <ProjectTableSkeleton /> : null}
          <div className="grid gap-3 p-4 md:hidden">
            {projects.data?.projects.map((project) => (
              <ProjectCard
                key={project.id}
                active={selected?.id === project.id}
                project={project}
                onRename={() => setRenaming(project)}
                onSelect={() => setSelectedId(project.id)}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table className="min-w-[980px]">
              <TableHeader className="bg-card sticky top-0 z-10">
                <TableRow>
                  <TableHead>Dự án</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Yêu cầu</TableHead>
                  <TableHead>Phiên</TableHead>
                  <TableHead>Subagent share</TableHead>
                  <TableHead>Model mix</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.data?.projects.map((project) => (
                  <TableRow
                    key={project.id}
                    data-state={selected?.id === project.id ? "selected" : undefined}
                  >
                    <TableCell className="max-w-72">
                      <button
                        className="focus-visible:ring-ring w-full rounded-sm text-left outline-none focus-visible:ring-2"
                        type="button"
                        onClick={() => setSelectedId(project.id)}
                      >
                        <span className="block truncate font-medium">{project.displayName}</span>
                        <span
                          className="text-muted-foreground block truncate text-xs"
                          title={project.displayPath}
                        >
                          {project.displayPath}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {formatTokens(project.totalTokens)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatUsd(project.estimatedCostUsd)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTokens(project.requestCount)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTokens(project.sessionCount)}
                    </TableCell>
                    <TableCell>
                      <ShareBar value={safeRatio(project.subagentTokens, project.totalTokens)} />
                    </TableCell>
                    <TableCell>
                      <ModelMix values={project.modelMix} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        aria-label={`Đổi alias ${project.displayName}`}
                        size="icon"
                        variant="ghost"
                        onClick={() => setRenaming(project)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!projects.isLoading && projects.data?.projects.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-muted-foreground h-28 text-center" colSpan={8}>
                      Chưa có project trong khoảng đã chọn.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {selected ? (
        <section aria-labelledby="project-detail-heading" className="grid gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-3">
            <CardHeader>
              <CardTitle id="project-detail-heading">Xu hướng · {selected.displayName}</CardTitle>
              <CardDescription>Token và estimated cost theo ngày.</CardDescription>
            </CardHeader>
            <CardContent>
              <ProjectTrend data={selected.daily} />
            </CardContent>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Task tốn nhiều nhất</CardTitle>
              <CardDescription>Top session theo cost ước tính.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {selected.topSessions.map((session, index) => (
                <div
                  key={session.sessionId}
                  className="bg-muted/60 flex items-center gap-3 rounded-lg p-3"
                >
                  <span className="text-muted-foreground w-5 text-xs tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {session.title ?? "Chưa có tên task"}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {compactTokens(session.totalTokens)} token
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatUsd(session.estimatedCostUsd)}
                  </span>
                </div>
              ))}
              {selected.topSessions.length === 0 ? (
                <p className="text-muted-foreground py-10 text-center text-sm">
                  Không còn chi tiết session trong range này.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </section>
      ) : null}

      <ExportActions filters={filters} />

      {renaming ? (
        <RenameProjectDialog
          loading={rename.isPending}
          project={renaming}
          onClose={() => setRenaming(null)}
          onSave={(displayName) => rename.mutate({ displayName, id: renaming.id })}
        />
      ) : null}
    </div>
  );
}

function ProjectCard({
  active,
  onRename,
  onSelect,
  project,
}: {
  active: boolean;
  onRename: () => void;
  onSelect: () => void;
  project: ProjectSummary;
}) {
  return (
    <article
      className={`rounded-xl border p-4 ${active ? "border-primary bg-primary/5" : "bg-card"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button className="min-w-0 text-left" type="button" onClick={onSelect}>
          <span className="block truncate font-semibold">{project.displayName}</span>
          <span className="text-muted-foreground mt-1 block truncate text-xs">
            {project.displayPath}
          </span>
        </button>
        <Button
          aria-label={`Đổi alias ${project.displayName}`}
          size="icon"
          variant="ghost"
          onClick={onRename}
        >
          <Pencil className="size-4" />
        </Button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <Stat label="Token" value={compactTokens(project.totalTokens)} />
        <Stat label="Cost" value={formatUsd(project.estimatedCostUsd)} />
        <Stat label="Phiên" value={formatTokens(project.sessionCount)} />
        <Stat
          label="Subagent"
          value={formatPercent(safeRatio(project.subagentTokens, project.totalTokens) * 100)}
        />
      </div>
      <Button
        className="mt-3 w-full"
        size="sm"
        variant={active ? "secondary" : "outline"}
        onClick={onSelect}
      >
        Xem chi tiết <ArrowRight className="size-4" />
      </Button>
    </article>
  );
}

function ProjectTrend({ data }: { data: DailyUsage[] }) {
  if (data.length === 0) return <EmptyChart />;
  return (
    <>
      <ChartContainer
        config={chartConfig}
        role="img"
        aria-label={`Biểu đồ trend project theo ${data.length} ngày`}
      >
        <ComposedChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="tokens"
            tickFormatter={compactTokens}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickFormatter={(value: number) => `$${value.toFixed(0)}`}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            formatter={(value, name) =>
              name === "Token" ? formatTokens(Number(value)) : formatUsd(Number(value))
            }
          />
          <Bar
            dataKey="totalTokens"
            fill="var(--chart-1)"
            name="Token"
            radius={[4, 4, 0, 0]}
            yAxisId="tokens"
          />
          <Line
            dataKey="estimatedCostUsd"
            dot={false}
            name="Cost"
            stroke="var(--chart-2)"
            strokeWidth={2}
            type="monotone"
            yAxisId="cost"
          />
        </ComposedChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Dữ liệu trend project</caption>
        <thead>
          <tr>
            <th>Ngày</th>
            <th>Token</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.date}>
              <td>{item.date}</td>
              <td>{item.totalTokens}</td>
              <td>{item.estimatedCostUsd}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ModelMix({ values }: { values: ProjectSummary["modelMix"] }) {
  const visible = values.filter((value) => value.totalTokens > 0).slice(0, 2);
  return (
    <div className="flex max-w-64 flex-wrap gap-1">
      {visible.map((value) => (
        <Badge key={value.model} variant="outline">
          {value.model}
        </Badge>
      ))}
      {values.length > 2 ? <Badge variant="secondary">+{values.length - 2}</Badge> : null}
    </div>
  );
}

function ShareBar({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="flex min-w-32 items-center gap-2">
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-muted-foreground text-xs tabular-nums">{formatPercent(percent)}</span>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
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

function RenameProjectDialog({
  loading,
  onClose,
  onSave,
  project,
}: {
  loading: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  project: ProjectSummary;
}) {
  const [value, setValue] = useState(project.displayName);
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đổi alias project</DialogTitle>
          <DialogDescription>
            Chỉ đổi tên hiển thị; workspace path và dữ liệu usage không thay đổi.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const name = value.trim();
            if (name) onSave(name);
          }}
        >
          <Input
            aria-label="Alias project"
            maxLength={80}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button disabled={loading || !value.trim()} type="submit">
              {loading ? "Đang lưu…" : "Lưu alias"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectTableSkeleton() {
  return (
    <div className="hidden space-y-2 p-4 md:block">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-14" />
      ))}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-72 items-center justify-center rounded-lg border border-dashed text-sm">
      <Sparkles className="mr-2 size-4" /> Chưa có dữ liệu trend.
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

function safeRatio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}
