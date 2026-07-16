import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import type { AppRevisionScope, AppScanEvent, DataHealthResponse } from "@/shared/types";
import { parseRevision, parseScan } from "@/web/lib/live-event-parser";
import {
  createLiveRefreshScheduler,
  matchesRevisionScopes,
  resolveRevisionScopes,
  type LiveRefreshScheduler,
} from "@/web/lib/live-refresh-scheduler";
import { reconcileRevisionSnapshot } from "@/web/lib/revision-tracker";

export type LiveEventsConnectionState = "connected" | "connecting" | "degraded";

const CONNECTION_GRACE_MS = 10_000;
const FALLBACK_ANALYTICS_MS = 60_000;
const FALLBACK_ANALYTICS_SCOPES: readonly AppRevisionScope[] = [
  "activity",
  "agents",
  "dashboard",
  "projects",
  "sessions",
  "turns",
];
export const IMPORT_MUTATION_SCOPES: readonly AppRevisionScope[] = [
  "activity",
  "agents",
  "alerts",
  "catalog",
  "dashboard",
  "data-health",
  "projects",
  "sessions",
  "storage",
  "turns",
];

let connectionState: LiveEventsConnectionState = "connecting";
const connectionListeners = new Set<() => void>();
const pendingMutationScopes = new Set<AppRevisionScope>();

export function LiveEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => invalidateActiveQueries(queryClient, scopes),
      visible: document.visibilityState === "visible",
    });
    const source = new EventSource("/api/events");
    let awaitingRevisionSnapshot = true;
    let fallbackTimer: number | null = null;
    let graceTimer: number | null = null;
    let lastRevision: number | null = null;

    const clearGrace = () => {
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      graceTimer = null;
    };
    const clearFallback = () => {
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    };
    const scheduleFallback = () => {
      clearFallback();
      if (connectionState !== "degraded" || document.visibilityState !== "visible") return;
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        scheduler.flushScopes(FALLBACK_ANALYTICS_SCOPES);
        scheduleFallback();
      }, FALLBACK_ANALYTICS_MS);
    };
    const enterDegraded = () => {
      graceTimer = null;
      setConnectionState("degraded");
      flushPendingMutationScopes(scheduler);
      scheduleFallback();
    };
    const startGrace = () => {
      if (graceTimer !== null || connectionState === "degraded") return;
      setConnectionState("connecting");
      graceTimer = window.setTimeout(enterDegraded, CONNECTION_GRACE_MS);
    };

    const onRevision = (event: MessageEvent<string>) => {
      const revision = parseRevision(event.data);
      if (!revision) return;
      if (awaitingRevisionSnapshot) {
        awaitingRevisionSnapshot = false;
        const previousRevision = lastRevision;
        const action = reconcileRevisionSnapshot(previousRevision, revision.revision);
        lastRevision = revision.revision;
        const mutationScopes = takePendingMutationScopes();
        if (action === "invalidate") scheduler.enqueueAllNow();
        else if (action === "scoped") {
          const scopes = resolveRevisionScopes(revision);
          for (const scope of mutationScopes) scopes.add(scope);
          scheduler.enqueue({ ...revision, scopes: [...scopes] });
        } else if (mutationScopes.length > 0) scheduler.flushScopes(mutationScopes);
        clearGrace();
        clearFallback();
        setConnectionState("connected");
        return;
      }
      if (revision.revision === lastRevision) return;
      if (
        lastRevision !== null &&
        (revision.revision < lastRevision || revision.revision > lastRevision + 1)
      ) {
        lastRevision = revision.revision;
        scheduler.enqueueAllNow();
        return;
      }
      lastRevision = revision.revision;
      scheduler.enqueue(revision);
    };
    const onScan = (event: MessageEvent<string>) => {
      const scan = parseScan(event.data);
      if (!scan) return;
      queryClient.setQueryData<AppScanEvent>(["status"], scan);
      queryClient.setQueryData<DataHealthResponse>(["data-health"], (current) =>
        current
          ? {
              ...current,
              importerError: scan.error,
              lastSyncAt: scan.lastSyncAt,
              sourceScan: scan.sourceScan,
              turnBackfill: scan.turnBackfill,
            }
          : current,
      );
    };
    const onVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      if (!visible) {
        scheduler.setVisible(false);
        clearFallback();
        return;
      }
      if (connectionState === "degraded") {
        scheduler.flushScopes(FALLBACK_ANALYTICS_SCOPES);
      }
      scheduler.setVisible(true);
      scheduleFallback();
    };

    source.addEventListener("revision", onRevision as EventListener);
    source.addEventListener("scan", onScan as EventListener);
    source.onopen = () => {
      awaitingRevisionSnapshot = true;
      clearGrace();
      clearFallback();
      setConnectionState("connecting");
      startGrace();
    };
    source.onerror = () => startGrace();
    document.addEventListener("visibilitychange", onVisibilityChange);
    startGrace();

    return () => {
      clearGrace();
      clearFallback();
      scheduler.dispose();
      source.removeEventListener("revision", onRevision as EventListener);
      source.removeEventListener("scan", onScan as EventListener);
      source.close();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setConnectionState("connecting");
    };
  }, [queryClient]);

  return null;
}

export function useLiveEventsConnectionState(): LiveEventsConnectionState {
  return useSyncExternalStore(subscribeConnection, getConnectionState, () => "connecting");
}

export function useLiveEventsFallbackActive(): boolean {
  return useLiveEventsConnectionState() === "degraded";
}

export function queueLiveMutationScopes(
  queryClient: QueryClient,
  scopes: readonly AppRevisionScope[],
) {
  if (connectionState === "connected") return;
  if (connectionState === "degraded") {
    invalidateQueriesForScopes(queryClient, new Set(scopes));
    return;
  }
  for (const scope of scopes) pendingMutationScopes.add(scope);
}

function subscribeConnection(listener: () => void) {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

function getConnectionState() {
  return connectionState;
}

function setConnectionState(next: LiveEventsConnectionState) {
  if (connectionState === next) return;
  connectionState = next;
  for (const listener of connectionListeners) listener();
}

function takePendingMutationScopes(): AppRevisionScope[] {
  const scopes = [...pendingMutationScopes];
  pendingMutationScopes.clear();
  return scopes;
}

function flushPendingMutationScopes(scheduler: LiveRefreshScheduler) {
  const scopes = takePendingMutationScopes();
  if (scopes.length > 0) scheduler.flushScopes(scopes);
}

function invalidateActiveQueries(queryClient: QueryClient, scopes: ReadonlySet<AppRevisionScope>) {
  invalidateQueriesForScopes(queryClient, scopes);
}

function invalidateQueriesForScopes(
  queryClient: QueryClient,
  scopes: ReadonlySet<AppRevisionScope>,
) {
  if (scopes.size === 0) return;
  void queryClient.invalidateQueries({
    predicate: (query) => query.isActive() && matchesRevisionScopes(query.queryKey, scopes),
    refetchType: "active",
  });
}
