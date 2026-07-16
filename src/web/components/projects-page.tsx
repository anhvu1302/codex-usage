import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderKanban, Pencil } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

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
  fetchProjectAnalytics,
  fetchProjectsPage,
  fetchProjectsSummary,
  filtersFromSearch,
  formatPercent,
  formatTokens,
  formatUsd,
  renameProject,
  updateFilterSearch,
} from "@/web/lib/product-api";
import { useMediaQuery } from "@/web/lib/use-media-query";
import { queueLiveMutationScopes } from "@/web/lib/live-events";
import type {
  AgentFilters,
  DailyUsage,
  ProjectAnalyticsResponse,
  ProjectListItem,
  ProjectOptionsResponse,
  ProjectsPageResponse,
} from "@/shared/types";

const ProjectTrendChart = lazy(async () => ({
  default: (await import("@/web/components/project-trend-chart")).ProjectTrendChart,
}));
const PROJECT_PAGE_SIZE = 50;

export function ProjectsPage() {
  const desktopProjects = useMediaQuery("(min-width: 768px)");
  const [search, setSearch] = useSearchParams();
  const filters = useMemo<AgentFilters>(() => filtersFromSearch(search), [search]);
  const page = positiveInteger(search.get("projectPage")) ?? 1;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ProjectListItem | null>(null);
  const queryClient = useQueryClient();
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => fetchModels(signal),
    staleTime: 5 * 60_000,
  });
  const projectSummary = useQuery({
    queryKey: ["projects", "summary", filters],
    queryFn: ({ signal }) => fetchProjectsSummary(filters, signal),
    staleTime: 30_000,
  });
  const projectPageFilters = useMemo(
    () => ({ ...filters, page, pageSize: PROJECT_PAGE_SIZE }),
    [filters, page],
  );
  const projects = useQuery({
    queryKey: ["projects", "page", projectPageFilters],
    queryFn: ({ signal }) => fetchProjectsPage(projectPageFilters, signal),
    staleTime: 30_000,
  });
  const selectedSummary =
    projects.data?.projects.find((project) => project.id === selectedId) ??
    projects.data?.projects[0];
  const settledSelectedSummary = projects.isPlaceholderData ? undefined : selectedSummary;
  const projectDetail = useQuery({
    enabled: Boolean(settledSelectedSummary),
    queryKey: ["projects", "detail", settledSelectedSummary?.id, filters],
    queryFn: ({ signal }) => fetchProjectAnalytics(settledSelectedSummary!.id, filters, signal),
    placeholderData: () => undefined,
    staleTime: 30_000,
  });
  const selected = projectDetail.data?.project;
  const pageCount = Math.max(1, Math.ceil((projects.data?.total ?? 0) / PROJECT_PAGE_SIZE));

  const rename = useMutation({
    mutationFn: ({ displayName, id }: { displayName: string; id: string }) =>
      renameProject(id, displayName),
    onError: (error) => toast.error(error.message),
    onSuccess: ({ project }) => {
      setRenaming(null);
      toast.success("Đã đổi alias project.");
      queryClient.setQueriesData<ProjectsPageResponse>(
        { queryKey: ["projects", "page"] },
        (current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((item) =>
                  item.id === project.id ? { ...item, displayName: project.displayName } : item,
                ),
              }
            : current,
      );
      queryClient.setQueriesData<ProjectAnalyticsResponse>(
        { queryKey: ["projects", "detail"] },
        (current) =>
          current?.project.id === project.id
            ? { project: { ...current.project, displayName: project.displayName } }
            : current,
      );
      queryClient.setQueriesData<ProjectOptionsResponse>(
        { queryKey: ["projects", "options"] },
        (current) =>
          current
            ? {
                projects: current.projects.map((item) =>
                  item.id === project.id ? { ...item, displayName: project.displayName } : item,
                ),
              }
            : current,
      );
      queueLiveMutationScopes(queryClient, ["catalog", "projects"]);
    },
  });

  function applyFilters(next: AgentFilters) {
    const updated = updateFilterSearch(search, next);
    updated.delete("projectPage");
    setSearch(updated);
  }

  function selectPage(next: number) {
    const updated = new URLSearchParams(search);
    if (next <= 1) updated.delete("projectPage");
    else updated.set("projectPage", String(next));
    setSearch(updated);
  }

  function turnTarget(sessionId: string, projectId: string) {
    const next = updateFilterSearch(new URLSearchParams(), filters);
    next.set("project", projectId);
    next.set("session", sessionId);
    return { pathname: "/turns", search: next.toString() };
  }

  const totals = projectSummary.data?.kpis;

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
        <Badge variant="outline">{projectSummary.data?.projectCount ?? 0} dự án có usage</Badge>
      </header>

      <ProductFilterBar
        filters={filters}
        models={models.data?.models ?? []}
        onChange={applyFilters}
      />

      {projectSummary.isError ? <ErrorCard message={projectSummary.error.message} /> : null}
      {projects.isError ? <ErrorCard message={projects.error.message} /> : null}

      <h2 className="sr-only">Phân tích usage theo project</h2>

      <section
        aria-label="Tổng usage theo project"
        className="grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-4"
      >
        <SummaryCard label="Dự án" value={formatTokens(projectSummary.data?.projectCount ?? 0)} />
        <SummaryCard label="Token" value={compactTokens(totals?.totalTokens ?? 0)} />
        <SummaryCard label="Cost ước tính" value={formatUsd(totals?.estimatedCostUsd ?? 0)} />
        <SummaryCard
          label="Yêu cầu / phiên"
          value={`${formatTokens(totals?.requestCount ?? 0)} / ${formatTokens(totals?.sessionCount ?? 0)}`}
        />
      </section>

      <Card className="deferred-section overflow-hidden">
        <CardHeader>
          <CardTitle>Usage theo dự án</CardTitle>
          <CardDescription>
            Chọn project để xem trend và task tốn nhiều nhất; alias chỉ đổi tên hiển thị.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {projects.isLoading ? <ProjectTableSkeleton /> : null}
          {desktopProjects ? (
            <div className="overflow-x-auto" data-testid="project-table">
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
                      data-state={selectedSummary?.id === project.id ? "selected" : undefined}
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
                        <ModelMix count={project.modelCount} values={project.topModels} />
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
          ) : (
            <div className="grid gap-3 p-4" data-testid="project-cards">
              {projects.data?.projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  active={selectedSummary?.id === project.id}
                  project={project}
                  onRename={() => setRenaming(project)}
                  onSelect={() => setSelectedId(project.id)}
                />
              ))}
            </div>
          )}
          {projects.data && projects.data.total > PROJECT_PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-3 border-t p-4">
              <p className="text-muted-foreground text-sm">
                Trang {page} / {pageCount} · {formatTokens(projects.data.total)} dự án
              </p>
              <div className="flex gap-2">
                <Button
                  aria-label="Trang dự án trước"
                  disabled={page <= 1 || projects.isFetching}
                  size="sm"
                  variant="outline"
                  onClick={() => selectPage(page - 1)}
                >
                  Trước
                </Button>
                <Button
                  aria-label="Trang dự án tiếp theo"
                  disabled={page >= pageCount || projects.isFetching}
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

      {selectedSummary && projectDetail.isLoading ? (
        <section aria-label="Đang tải chi tiết dự án" className="grid gap-4 xl:grid-cols-5">
          <Skeleton className="h-96 xl:col-span-3" />
          <Skeleton className="h-96 xl:col-span-2" />
        </section>
      ) : null}
      {projectDetail.isError ? <ErrorCard message={projectDetail.error.message} /> : null}
      {selected ? (
        <section aria-labelledby="project-detail-heading" className="grid gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-3">
            <CardHeader>
              <CardTitle id="project-detail-heading">Xu hướng · {selected.displayName}</CardTitle>
              <CardDescription>Token và estimated cost theo ngày.</CardDescription>
            </CardHeader>
            <CardContent>
              <DeferredProjectTrend data={selected.daily} />
            </CardContent>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Task tốn nhiều nhất</CardTitle>
              <CardDescription>Top session theo cost ước tính.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {selected.topSessions.map((session, index) => (
                <Link
                  key={session.sessionId}
                  aria-label={`Xem turns của ${session.title ?? session.sessionId}`}
                  className="bg-muted/60 hover:bg-muted focus-visible:ring-ring flex items-center gap-3 rounded-lg p-3 transition-colors outline-none focus-visible:ring-2"
                  to={turnTarget(session.sessionId, selected.id)}
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
                  <ArrowRight className="text-muted-foreground size-4 shrink-0" />
                </Link>
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
  project: ProjectListItem;
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

function DeferredProjectTrend({ data }: { data: DailyUsage[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !container.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "500px" },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div ref={container} className="min-h-72">
      {visible ? (
        <Suspense fallback={<Skeleton className="h-72" />}>
          <ProjectTrendChart data={data} />
        </Suspense>
      ) : (
        <Skeleton className="h-72" />
      )}
    </div>
  );
}

function ModelMix({ count, values }: { count: number; values: ProjectListItem["topModels"] }) {
  const visible = values.filter((value) => value.totalTokens > 0);
  return (
    <div className="flex max-w-64 flex-wrap gap-1">
      {visible.map((value) => (
        <Badge key={value.model} variant="outline">
          {value.model}
        </Badge>
      ))}
      {count > visible.length ? <Badge variant="secondary">+{count - visible.length}</Badge> : null}
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
  project: Pick<ProjectListItem, "displayName" | "id">;
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

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
