import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Check, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import type { AlertEvent, AlertsResponse } from "@/shared/types";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/web/components/ui/sheet";
import { Skeleton } from "@/web/components/ui/skeleton";
import { queueLiveMutationScopes } from "@/web/lib/live-events";
import { fetchAlerts, updateAlert } from "@/web/lib/product-api";

const dateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

export function NotificationPanel({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: ({ signal }) => fetchAlerts(signal),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: updateAlert,
    onError: (error) => toast.error(error.message),
    onSuccess: (payload, variables) => {
      queryClient.setQueryData<AlertsResponse>(["alerts"], (current) => {
        if (!current) return current;
        const previous = current.alerts.find((alert) => alert.id === payload.alert.id);
        const becameSeen =
          previous?.seenAt === null &&
          (payload.alert.seenAt !== null || payload.alert.dismissedAt !== null);
        return {
          alerts:
            variables.action === "dismiss"
              ? current.alerts.filter((alert) => alert.id !== payload.alert.id)
              : current.alerts.map((alert) =>
                  alert.id === payload.alert.id ? payload.alert : alert,
                ),
          unseenCount: Math.max(0, current.unseenCount - (becameSeen ? 1 : 0)),
        };
      });
      queueLiveMutationScopes(queryClient, ["alerts"]);
      if (variables.action === "dismiss") toast.success("Đã ẩn thông báo.");
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pr-8">
          <SheetTitle className="flex items-center gap-2">
            <BellRing className="text-primary size-5" aria-hidden="true" />
            Trung tâm thông báo
          </SheetTitle>
          <SheetDescription>
            Cảnh báo budget, usage bất thường, context pressure và sức khoẻ dữ liệu chỉ hiển thị
            trong app.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3" aria-live="polite" aria-busy={alerts.isLoading}>
          {alerts.isLoading ? <AlertSkeletons /> : null}
          {alerts.isError ? (
            <InlineError message={alerts.error.message} onRetry={() => void alerts.refetch()} />
          ) : null}
          {alerts.data?.alerts.map((alert) => (
            <article
              key={alert.id}
              className={`rounded-xl border p-4 ${alertSurface(alert.severity)}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>
                      {severityLabel(alert.severity)}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(alert.createdAt)}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold">{alert.title}</h3>
                  <p className="text-muted-foreground text-sm leading-5">{alert.message}</p>
                </div>
                {alert.seenAt === null ? (
                  <span
                    className="bg-primary mt-1 size-2 shrink-0 rounded-full"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {alert.turnKey ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/turns/${alert.turnKey}`} onClick={() => onOpenChange(false)}>
                      Xem turn
                    </Link>
                  </Button>
                ) : null}
                {alert.seenAt === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ action: "seen", id: alert.id })}
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    Đã đọc
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ action: "dismiss", id: alert.id })}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Ẩn
                </Button>
              </div>
            </article>
          ))}
          {alerts.data?.alerts.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center">
              <ShieldCheck className="text-primary mb-3 size-8" aria-hidden="true" />
              <p className="font-medium">Chưa có cảnh báo</p>
              <p className="text-muted-foreground mt-1 text-sm">
                App sẽ báo khi budget vượt ngưỡng hoặc phát hiện usage bất thường.
              </p>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AlertSkeletons() {
  return Array.from({ length: 3 }, (_, index) => (
    <div key={index} className="space-y-3 rounded-xl border p-4">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-full" />
    </div>
  ));
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 rounded-xl border p-4" role="alert">
      <div className="flex items-start gap-3">
        <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Không tải được dữ liệu</p>
          <p className="text-muted-foreground mt-1 text-sm break-words">{message}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    </div>
  );
}

function alertSurface(severity: AlertEvent["severity"]) {
  switch (severity) {
    case "critical":
      return "border-destructive/35 bg-destructive/5";
    case "warning":
      return "border-amber-500/35 bg-amber-500/5";
    case "info":
      return "border-primary/25 bg-primary/5";
  }
}

function severityLabel(severity: AlertEvent["severity"]) {
  switch (severity) {
    case "critical":
      return "Khẩn cấp";
    case "warning":
      return "Cảnh báo";
    case "info":
      return "Thông tin";
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : dateTimeFormatter.format(date);
}
