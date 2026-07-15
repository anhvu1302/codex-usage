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
  Settings2,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/components/ui/tabs";
import {
  compactActivityStorage,
  fetchDataHealth,
  syncActivitySources,
} from "@/web/lib/activity-api";
import { formatTokens } from "@/web/lib/product-api";
import { cn } from "@/web/lib/utils";
import type { DataHealthResponse } from "@/shared/types";

export function DataHealthCenter({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ["data-health"],
    queryFn: fetchDataHealth,
    refetchInterval: 30_000,
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
            Chẩn đoán được cập nhật tự động mỗi 30 giây.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Button disabled={sync.isPending} variant="outline" onClick={() => sync.mutate()}>
            <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} />
            Sync ngay
          </Button>
          <Button disabled={compact.isPending} variant="outline" onClick={() => compact.mutate()}>
            <Database className={cn("size-4", compact.isPending && "animate-pulse")} />
            Compact ngay
          </Button>
        </div>
      </div>

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
    </section>
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

async function invalidateHealth(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["activity"] }),
    queryClient.invalidateQueries({ queryKey: ["data-health"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["status"] }),
    queryClient.invalidateQueries({ queryKey: ["storage"] }),
  ]);
}
