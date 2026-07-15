import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileQuestion,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
  Settings2,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
import { useState } from "react";
import { toast } from "sonner";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/components/ui/tabs";
import {
  compactActivityStorage,
  fetchDataHealth,
  queueDeepVerification,
  syncActivitySources,
} from "@/web/lib/activity-api";
import { formatTokens } from "@/web/lib/product-api";
import { cn } from "@/web/lib/utils";
import type { DataHealthResponse } from "@/shared/types";

export function DataHealthCenter({ className }: { className?: string }) {
  const [deepDialogOpen, setDeepDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ["data-health"],
    queryFn: fetchDataHealth,
    refetchInterval: (query) => {
      const scan = query.state.data?.sourceScan;
      return scan?.deepQueued || scan?.current?.mode === "deep" ? 2_000 : 30_000;
    },
  });
  const deepVerify = useMutation({
    mutationFn: queueDeepVerification,
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      setDeepDialogOpen(false);
      toast.success("Đã xếp hàng kiểm chứng sâu. Tiến độ sẽ tự động cập nhật.");
      void invalidateHealth(queryClient);
    },
  });
  const sync = useMutation({
    mutationFn: syncActivitySources,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      toast.success(
        `Đã sync ${formatTokens(result.filesProcessed)} file, thêm ${formatTokens(result.recordsInserted)} usage event.`,
      );
      void invalidateHealth(queryClient);
    },
  });
  const compact = useMutation({
    mutationFn: compactActivityStorage,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      toast.success(
        `Đã compact ${formatTokens(result.lastRawEventsDeleted)} raw event và ghi ${formatTokens(result.lastRollupRowsWritten)} rollup.`,
      );
      void invalidateHealth(queryClient);
    },
  });

  if (health.isLoading) return <HealthSkeleton className={className} />;
  if (health.isError) {
    return (
      <Card className={cn("border-destructive/40", className)} role="alert">
        <CardHeader>
          <CardTitle>Không tải được sức khỏe dữ liệu</CardTitle>
          <CardDescription>{health.error.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void health.refetch()}>
            <RefreshCw className="size-4" /> Thử lại
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = health.data;
  if (!data) return <HealthSkeleton className={className} />;
  const issueCount = countIssues(data);
  const deepBusy =
    deepVerify.isPending || data.sourceScan.deepQueued || data.sourceScan.current?.mode === "deep";

  return (
    <section className={cn("space-y-4", className)} aria-labelledby="data-health-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="data-health-title" className="text-xl font-semibold">
              Trung tâm sức khoẻ dữ liệu
            </h2>
            <Badge variant={issueCount === 0 ? "secondary" : "destructive"}>
              {issueCount === 0 ? "Ổn định" : `${formatTokens(issueCount)} vấn đề`}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Chẩn đoán được cập nhật tự động mỗi {deepBusy ? "2" : "30"} giây.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Button disabled={sync.isPending} variant="outline" onClick={() => sync.mutate()}>
            <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} />
            Sync ngay
          </Button>
          <Button disabled={deepBusy} variant="outline" onClick={() => setDeepDialogOpen(true)}>
            <ScanSearch className={cn("size-4", deepBusy && "animate-pulse")} />
            {data.sourceScan.deepQueued ? "Đang chờ kiểm chứng" : "Kiểm chứng sâu"}
          </Button>
          <Button disabled={compact.isPending} variant="outline" onClick={() => compact.mutate()}>
            <Database className={cn("size-4", compact.isPending && "animate-pulse")} />
            Compact ngay
          </Button>
        </div>
      </div>

      <SourceScanSummary scan={data.sourceScan} />

      {(data.importerError ?? data.retentionError) && (
        <Card className="border-destructive/50 bg-destructive/5" role="alert">
          <CardContent className="flex gap-3 p-4">
            <AlertTriangle className="text-destructive mt-0.5 size-5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Tác vụ nền gần nhất có lỗi</p>
              {data.importerError ? (
                <p className="text-muted-foreground mt-1 text-sm break-words">
                  Importer: {data.importerError}
                </p>
              ) : null}
              {data.retentionError ? (
                <p className="text-muted-foreground mt-1 text-sm break-words">
                  Retention: {data.retentionError}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="diagnostics">
        <TabsList aria-label="Nhóm thông tin sức khỏe dữ liệu" className="w-full sm:w-auto">
          <TabsTrigger className="flex-1 sm:flex-none" value="diagnostics">
            Chẩn đoán
          </TabsTrigger>
          <TabsTrigger className="flex-1 sm:flex-none" value="retention">
            Retention
          </TabsTrigger>
        </TabsList>

        <TabsContent value="diagnostics">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <HealthMetric
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link to="/settings#rate-cards">
                    <Settings2 className="size-3.5" /> Rate card
                  </Link>
                </Button>
              }
              description="Usage event chưa nhận diện được model."
              icon={FileQuestion}
              label="Model chưa xác định"
              severity={data.unknownUsage > 0 ? "warning" : "ok"}
              value={data.unknownUsage}
            />
            <HealthMetric
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link to="/settings#rate-cards">
                    <CircleDollarSign className="size-3.5" /> Định giá
                  </Link>
                </Button>
              }
              description="Usage event chưa có cost snapshot."
              icon={CircleDollarSign}
              label="Chưa định giá"
              severity={data.unpricedUsage > 0 ? "warning" : "ok"}
              value={data.unpricedUsage}
            />
            <HealthMetric
              description="JSONL line không parse được; importer đã bỏ qua an toàn."
              icon={AlertTriangle}
              label="Dòng JSONL lỗi"
              severity={data.malformedLines > 0 ? "warning" : "ok"}
              value={data.malformedLines}
            />
            <HealthMetric
              description="File có JSON line cuối chưa hoàn chỉnh và sẽ được đọc lại khi append."
              icon={LoaderCircle}
              label="File chưa hoàn chỉnh"
              severity={data.incompleteFiles > 0 ? "warning" : "ok"}
              value={data.incompleteFiles}
            />
            <HealthMetric
              description="Session source đã xoá; lịch sử aggregate vẫn được giữ."
              icon={Trash2}
              label="Session source đã xoá"
              severity={data.sourceDeletedSessions > 0 ? "info" : "ok"}
              value={data.sourceDeletedSessions}
            />
            <HealthMetric
              description="Subagent source đã xoá; daily counters vẫn không mất."
              icon={Trash2}
              label="Agent source đã xoá"
              severity={data.sourceDeletedAgents > 0 ? "info" : "ok"}
              value={data.sourceDeletedAgents}
            />
            <HealthMetric
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link to="/turns">
                    <RefreshCw className="size-3.5" /> Turns
                  </Link>
                </Button>
              }
              description="Usage hoặc activity raw không có explicit/active turn trong đúng JSONL. Không tự suy đoán theo timestamp."
              icon={FileQuestion}
              label="Event chưa attribution turn"
              severity={data.turnUnassignedUsage + data.turnUnassignedActivity > 0 ? "info" : "ok"}
              value={data.turnUnassignedUsage + data.turnUnassignedActivity}
            />
            <HealthMetric
              description="Usage legacy đã compact không còn price snapshot để gán cost chính xác cho turn."
              icon={CircleDollarSign}
              label="Khoảng trống cost của turn"
              severity={data.turnCostAttributionGaps > 0 ? "info" : "ok"}
              value={data.turnCostAttributionGaps}
            />
            <HealthMetric
              description="JSONL source không còn trên disk nên historical turn backfill chỉ có coverage một phần."
              icon={Trash2}
              label="Source gap của turn"
              severity={data.turnBackfill.sourceDeletedGaps > 0 ? "info" : "ok"}
              value={data.turnBackfill.sourceDeletedGaps}
            />
          </div>
        </TabsContent>

        <TabsContent value="retention">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="text-primary size-4" /> Phạm vi dữ liệu
                </CardTitle>
                <CardDescription>
                  Raw activity giữ 30 ngày; daily counters được giữ vĩnh viễn.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <RetentionStat label="Raw drill-down từ" value={formatDate(data.rawCoverageFrom)} />
                <RetentionStat
                  label="Hourly usage từ"
                  value={formatDate(data.hourlyCoverageFrom)}
                />
                <RetentionStat
                  label="Raw activity event"
                  value={formatTokens(data.activityRawEvents)}
                />
                <RetentionStat
                  label="Daily activity rollup"
                  value={formatTokens(data.activityDailyRows)}
                />
                <RetentionStat
                  label="Turn backfill"
                  status={
                    data.turnBackfill.error
                      ? "Có lỗi"
                      : data.turnBackfill.isRunning
                        ? "Đang chạy"
                        : "Sẵn sàng"
                  }
                  value={`${formatTokens(data.turnBackfill.filesProcessed)} / ${formatTokens(data.turnBackfill.totalFiles)} file · v${data.turnBackfill.attributionVersion}`}
                />
                <RetentionStat
                  label="Turn backfill gần nhất"
                  value={formatDateTime(data.turnBackfill.lastRunAt)}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="text-primary size-4" /> Tác vụ gần nhất
                </CardTitle>
                <CardDescription>
                  Thời điểm chạy pipeline, không phải thời gian làm việc của người dùng.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <RetentionStat label="Sync gần nhất" value={formatDateTime(data.lastSyncAt)} />
                <RetentionStat
                  label="Compact gần nhất"
                  value={formatDateTime(data.lastCompactionAt)}
                />
                <RetentionStat
                  label="Importer"
                  status={data.importerError ? "Có lỗi" : "Sẵn sàng"}
                  value={data.importerError ? "Cần kiểm tra" : "Không có lỗi"}
                />
                <RetentionStat
                  label="Retention"
                  status={data.retentionError ? "Có lỗi" : "Sẵn sàng"}
                  value={data.retentionError ? "Cần kiểm tra" : "Không có lỗi"}
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={deepDialogOpen} onOpenChange={setDeepDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kiểm chứng sâu toàn bộ session?</DialogTitle>
            <DialogDescription>
              Tác vụ này sẽ inventory lại thư mục rồi đọc toàn bộ JSONL từ đầu. Có thể dùng thêm
              CPU, RAM và I/O trong lúc chạy, nhưng tuyệt đối không sửa, di chuyển hay xoá source
              JSONL.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted/60 rounded-lg border p-3 text-sm">
            Lịch sử đã import vẫn được giữ; quá trình chỉ bổ sung và dedupe dữ liệu để kiểm chứng
            aggregate hiện tại.
          </div>
          <DialogFooter>
            <Button
              disabled={deepVerify.isPending}
              variant="outline"
              onClick={() => setDeepDialogOpen(false)}
            >
              Huỷ
            </Button>
            <Button disabled={deepVerify.isPending} onClick={() => deepVerify.mutate()}>
              <ScanSearch className={cn("size-4", deepVerify.isPending && "animate-pulse")} />
              Bắt đầu kiểm chứng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SourceScanSummary({ scan }: { scan: DataHealthResponse["sourceScan"] }) {
  const current = scan.current;
  const last = scan.lastCompleted;
  const state = scan.deepQueued
    ? "Đang chờ kiểm chứng sâu"
    : current
      ? `${current.mode === "deep" ? "Kiểm chứng sâu" : "Inventory"} · ${formatScanPhase(current.phase)}`
      : "Sẵn sàng";

  return (
    <Card aria-live="polite">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScanSearch className="text-primary size-4" /> Quét source session
            </CardTitle>
            <CardDescription>
              Inventory vẫn duyệt toàn bộ thư mục, nhưng chỉ đọc nội dung JSONL mới hoặc thay đổi.
            </CardDescription>
          </div>
          <Badge variant={current || scan.deepQueued ? "secondary" : "outline"}>{state}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <RetentionStat
          label="Tiến độ hiện tại"
          value={
            current
              ? `${formatTokens(current.filesRead)} đọc · ${formatTokens(current.filesSkipped)} bỏ qua / ${formatTokens(current.discoveredFiles)} file`
              : scan.deepQueued
                ? "Đang chờ tác vụ trước hoàn tất"
                : "Không có scan đang chạy"
          }
        />
        <RetentionStat
          label="Scan hoàn tất gần nhất"
          value={
            last
              ? `${last.mode === "deep" ? "Deep" : "Inventory"} · ${formatDuration(last.durationMs)}`
              : "Chưa chạy"
          }
        />
        <RetentionStat
          label="Kết quả đọc / bỏ qua"
          value={
            last
              ? `${formatTokens(last.filesRead)} / ${formatTokens(last.filesSkipped)} file · ${formatBytes(last.sourceBytes)}`
              : "Chưa có snapshot"
          }
        />
        <RetentionStat
          label="Snapshot / scan kế tiếp"
          value={`Cập nhật ${formatDateTime(last?.completedAt ?? null)} · Kế tiếp ${formatDateTime(scan.nextScheduledAt)}`}
        />
      </CardContent>
    </Card>
  );
}

type HealthSeverity = "info" | "ok" | "warning";

function HealthMetric({
  action,
  description,
  icon: Icon,
  label,
  severity,
  value,
}: {
  action?: React.ReactNode;
  description: string;
  icon: typeof AlertTriangle;
  label: string;
  severity: HealthSeverity;
  value: number;
}) {
  return (
    <Card
      className={cn(
        "overflow-hidden",
        severity === "warning" && "border-destructive/35",
        severity === "ok" && "border-emerald-500/25",
      )}
    >
      <CardContent className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <span
            className={cn(
              "rounded-lg p-2",
              severity === "ok" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              severity === "warning" && "bg-destructive/10 text-destructive",
              severity === "info" && "bg-primary/10 text-primary",
            )}
          >
            {severity === "ok" ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}
          </span>
          <Badge variant={severity === "warning" ? "destructive" : "outline"}>
            {severity === "ok" ? "OK" : severity === "warning" ? "Cần xử lý" : "Thông tin"}
          </Badge>
        </div>
        <p className="mt-4 text-2xl font-semibold tabular-nums">{formatTokens(value)}</p>
        <p className="mt-1 text-sm font-medium">{label}</p>
        <p className="text-muted-foreground mt-1 flex-1 text-xs leading-relaxed">{description}</p>
        {action ? <div className="mt-3 border-t pt-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

function RetentionStat({
  label,
  status,
  value,
}: {
  label: string;
  status?: string;
  value: string;
}) {
  return (
    <div className="bg-muted/60 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{label}</p>
        {status ? (
          <Badge variant={status === "Có lỗi" ? "destructive" : "outline"}>{status}</Badge>
        ) : null}
      </div>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function HealthSkeleton({ className }: { className: string | undefined }) {
  return (
    <div
      className={cn("space-y-4", className)}
      aria-label="Đang tải sức khỏe dữ liệu"
      aria-busy="true"
    >
      <div className="flex justify-between">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-9 w-52" />
      </div>
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-48" />
        ))}
      </div>
    </div>
  );
}

function countIssues(data: DataHealthResponse): number {
  return (
    data.unknownUsage +
    data.unpricedUsage +
    data.malformedLines +
    data.incompleteFiles +
    data.turnCostAttributionGaps +
    Number(Boolean(data.turnBackfill.error)) +
    Number(Boolean(data.importerError)) +
    Number(Boolean(data.retentionError))
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value: string | null): string {
  if (!value) return "Chưa chạy";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}

function formatScanPhase(phase: NonNullable<DataHealthResponse["sourceScan"]["current"]>["phase"]) {
  if (phase === "discovering") return "đang duyệt thư mục";
  if (phase === "reading") return "đang đọc JSONL";
  return "đang đối soát";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} giây`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} phút ${seconds} giây`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${formatTokens(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (const candidate of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = candidate;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

async function invalidateHealth(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["activity"] }),
    queryClient.invalidateQueries({ queryKey: ["data-health"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["status"] }),
    queryClient.invalidateQueries({ queryKey: ["storage"] }),
  ]);
}
