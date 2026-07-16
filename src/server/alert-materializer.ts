import type { AppDatabase } from "@/server/db/client";
import { getAlertFeed, refreshAlerts } from "@/server/product-analytics";
import type { AlertsResponse, AppRevisionReason } from "@/shared/types";

type AlertMaterializerOptions = {
  maxWaitMs?: number;
  now?: () => Date;
  onChanged?: (reason: AppRevisionReason) => void;
  quietMs?: number;
  refresh?: (database: AppDatabase, now: Date) => unknown;
  retryMs?: number;
};

const DEFAULT_QUIET_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_RETRY_MS = 10_000;
const REASON_PRIORITY: readonly AppRevisionReason[] = [
  "budget",
  "rate",
  "retention",
  "import",
  "project",
];

export class AlertMaterializer {
  private dirty = true;
  private maxTimer: NodeJS.Timeout | null = null;
  private readonly maxWaitMs: number;
  private readonly now: () => Date;
  private readonly onChanged: (reason: AppRevisionReason) => void;
  private readonly pendingReasons = new Set<AppRevisionReason>(["import"]);
  private readonly quietMs: number;
  private quietTimer: NodeJS.Timeout | null = null;
  private readonly refresh: (database: AppDatabase, now: Date) => unknown;
  private readonly retryMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  constructor(
    private readonly database: AppDatabase,
    options: AlertMaterializerOptions = {},
  ) {
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = options.now ?? (() => new Date());
    this.onChanged = options.onChanged ?? (() => undefined);
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.refresh = options.refresh ?? refreshAlerts;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }

  stop() {
    this.started = false;
    this.clearTimers();
  }

  invalidate(reason: AppRevisionReason = "import") {
    this.dirty = true;
    this.pendingReasons.add(reason);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.schedule();
  }

  getFeed(): AlertsResponse {
    return this.refreshIfNeeded() ?? getAlertFeed(this.database, this.now());
  }

  private schedule() {
    if (!this.started || !this.dirty || this.running) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.refreshIfNeeded();
    }, this.quietMs);
    this.quietTimer.unref();
    if (this.maxTimer) return;
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null;
      this.refreshIfNeeded();
    }, this.maxWaitMs);
    this.maxTimer.unref();
  }

  private refreshIfNeeded(): AlertsResponse | null {
    if (!this.dirty || this.running) return null;
    this.clearWorkTimers();
    this.running = true;
    const reason = this.pendingReason();
    const before = getAlertFeed(this.database, this.now());
    let after: AlertsResponse;
    try {
      this.database.$client.transaction(() => this.refresh(this.database, this.now()))();
      after = getAlertFeed(this.database, this.now());
    } catch (error) {
      this.dirty = true;
      console.warn("Could not refresh materialized alerts", error);
      this.scheduleRetry();
      return null;
    } finally {
      this.running = false;
    }
    this.dirty = false;
    this.pendingReasons.clear();
    if (alertFingerprint(before) !== alertFingerprint(after)) {
      try {
        this.onChanged(reason);
      } catch (error) {
        console.warn("Could not publish materialized alert revision", error);
      }
    }
    return after;
  }

  private scheduleRetry() {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refreshIfNeeded();
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private pendingReason(): AppRevisionReason {
    return REASON_PRIORITY.find((reason) => this.pendingReasons.has(reason)) ?? "import";
  }

  private clearWorkTimers() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.quietTimer = null;
    this.maxTimer = null;
  }

  private clearTimers() {
    this.clearWorkTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function alertFingerprint(response: AlertsResponse): string {
  return JSON.stringify(response);
}
