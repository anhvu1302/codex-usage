import { useQuery } from "@tanstack/react-query";
import { Bell, BellRing, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";

import type { AlertEvent } from "@/shared/types";
import { Button } from "@/web/components/ui/button";
import { useLiveEventsFallbackActive } from "@/web/lib/live-events";
import { fetchAlerts } from "@/web/lib/product-api";

let notificationPanelPromise: ReturnType<typeof importNotificationPanel> | undefined;

const NotificationPanel = lazy(loadNotificationPanel);

export function NotificationCenter() {
  const liveEventsFallbackActive = useLiveEventsFallbackActive();
  const [open, setOpen] = useState(false);
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: ({ signal }) => fetchAlerts(signal),
    refetchInterval: liveEventsFallbackActive ? 60_000 : false,
    staleTime: 30_000,
  });
  const unseen = alerts.data?.unseenCount ?? 0;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unseen > 0 ? `Thông báo: ${unseen} chưa đọc` : "Thông báo"}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        onFocus={() => void loadNotificationPanel()}
        onPointerEnter={() => void loadNotificationPanel()}
      >
        {unseen > 0 ? (
          <BellRing className="size-4" aria-hidden="true" />
        ) : (
          <Bell className="size-4" aria-hidden="true" />
        )}
        {unseen > 0 ? (
          <span className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold">
            {unseen > 99 ? "99+" : unseen}
          </span>
        ) : null}
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <NotificationPanel open onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}

export function AlertBanner() {
  const liveEventsFallbackActive = useLiveEventsFallbackActive();
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: ({ signal }) => fetchAlerts(signal),
    refetchInterval: liveEventsFallbackActive ? 60_000 : false,
    staleTime: 30_000,
  });
  const alert =
    alerts.data?.alerts.find((value) => value.type === "budget" && value.seenAt === null) ??
    alerts.data?.alerts.find((value) => value.severity === "critical" && value.seenAt === null);
  if (!alert) return null;

  return (
    <section
      aria-label="Cảnh báo usage"
      className={`flex flex-col justify-between gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${alertSurface(alert.severity)}`}
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">{alert.title}</p>
          <p className="text-muted-foreground mt-1 text-sm">{alert.message}</p>
        </div>
      </div>
      <Button asChild size="sm" variant="outline">
        <Link to="/settings">Xem budget</Link>
      </Button>
    </section>
  );
}

function loadNotificationPanel() {
  notificationPanelPromise ??= importNotificationPanel();
  return notificationPanelPromise;
}

async function importNotificationPanel() {
  return { default: (await import("@/web/components/notification-panel")).NotificationPanel };
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
