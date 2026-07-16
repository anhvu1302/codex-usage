import type { QueryKey } from "@tanstack/react-query";

import type { AppRevisionEvent, AppRevisionReason, AppRevisionScope } from "@/shared/types";

type TimerHandle = ReturnType<typeof setTimeout>;

type SchedulerClock = {
  clearTimeout: (handle: TimerHandle) => void;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
};

type SchedulerOptions = {
  analyticsMaxMs?: number;
  catalogMaxMs?: number;
  clock?: SchedulerClock;
  immediateMs?: number;
  onFlush: (scopes: ReadonlySet<AppRevisionScope>) => void;
  quietMs?: number;
  visible?: boolean;
};

type Lane = {
  maxTimer: TimerHandle | null;
  pending: Set<AppRevisionScope>;
  quietTimer: TimerHandle | null;
};

export type LiveRefreshScheduler = ReturnType<typeof createLiveRefreshScheduler>;

const DEFAULT_QUIET_MS = 2_000;
const DEFAULT_ANALYTICS_MAX_MS = 10_000;
const DEFAULT_CATALOG_MAX_MS = 60_000;
const DEFAULT_IMMEDIATE_MS = 250;

const ANALYTICS_SCOPES = new Set<AppRevisionScope>([
  "activity",
  "agents",
  "dashboard",
  "projects",
  "sessions",
  "turns",
]);
const SECONDARY_SCOPES = new Set<AppRevisionScope>(["catalog", "data-health"]);
const ALL_REVISION_SCOPES: readonly AppRevisionScope[] = [
  "activity",
  "agents",
  "alerts",
  "budgets",
  "catalog",
  "dashboard",
  "data-health",
  "projects",
  "rates",
  "sessions",
  "storage",
  "turns",
];
const REVISION_SCOPE_SET = new Set<AppRevisionScope>(ALL_REVISION_SCOPES);

const DEFAULT_CLOCK: SchedulerClock = {
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export function createLiveRefreshScheduler(options: SchedulerOptions) {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const analyticsMaxMs = options.analyticsMaxMs ?? DEFAULT_ANALYTICS_MAX_MS;
  const catalogMaxMs = options.catalogMaxMs ?? DEFAULT_CATALOG_MAX_MS;
  const immediateMs = options.immediateMs ?? DEFAULT_IMMEDIATE_MS;
  const analytics = createLane();
  const secondary = createLane();
  const immediate = createLane();
  const lanes = [analytics, secondary, immediate] as const;
  let disposed = false;
  let visible = options.visible ?? true;

  const clearLaneTimers = (lane: Lane) => {
    if (lane.quietTimer !== null) clock.clearTimeout(lane.quietTimer);
    if (lane.maxTimer !== null) clock.clearTimeout(lane.maxTimer);
    lane.quietTimer = null;
    lane.maxTimer = null;
  };

  const flushLane = (lane: Lane) => {
    clearLaneTimers(lane);
    if (disposed || !visible || lane.pending.size === 0) return;
    const scopes = new Set(lane.pending);
    lane.pending.clear();
    options.onFlush(scopes);
  };

  const scheduleLane = (lane: Lane, laneQuietMs: number, laneMaxMs: number) => {
    if (disposed || !visible || lane.pending.size === 0) return;
    if (lane.quietTimer !== null) clock.clearTimeout(lane.quietTimer);
    lane.quietTimer = clock.setTimeout(() => flushLane(lane), laneQuietMs);
    lane.maxTimer ??= clock.setTimeout(() => flushLane(lane), laneMaxMs);
  };

  const enqueue = (event: Pick<AppRevisionEvent, "reason" | "scopes">) => {
    if (disposed) return;
    const scopes = resolveRevisionScopes(event);
    if (scopes.size === 0) return;

    if (event.reason !== "import") {
      for (const scope of scopes) immediate.pending.add(scope);
      scheduleLane(immediate, immediateMs, immediateMs);
      return;
    }

    let analyticsAdded = false;
    let secondaryAdded = false;
    let immediateAdded = false;
    for (const scope of scopes) {
      if (ANALYTICS_SCOPES.has(scope)) {
        analytics.pending.add(scope);
        analyticsAdded = true;
      } else if (SECONDARY_SCOPES.has(scope)) {
        secondary.pending.add(scope);
        secondaryAdded = true;
      } else {
        immediate.pending.add(scope);
        immediateAdded = true;
      }
    }
    if (analyticsAdded) scheduleLane(analytics, quietMs, analyticsMaxMs);
    if (secondaryAdded) scheduleLane(secondary, quietMs, catalogMaxMs);
    if (immediateAdded) scheduleLane(immediate, immediateMs, immediateMs);
  };

  const flushAll = (additionalScopes: readonly AppRevisionScope[] = []) => {
    if (disposed) return;
    const scopes = new Set<AppRevisionScope>(additionalScopes);
    for (const lane of lanes) {
      for (const scope of lane.pending) scopes.add(scope);
      lane.pending.clear();
      clearLaneTimers(lane);
    }
    if (visible && scopes.size > 0) options.onFlush(scopes);
    else if (!visible) for (const scope of scopes) analytics.pending.add(scope);
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const lane of lanes) {
        clearLaneTimers(lane);
        lane.pending.clear();
      }
    },
    enqueue,
    enqueueAllNow() {
      flushAll(ALL_REVISION_SCOPES);
    },
    flushScopes(scopes: readonly AppRevisionScope[]) {
      flushAll(scopes);
    },
    setVisible(nextVisible: boolean) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        for (const lane of lanes) clearLaneTimers(lane);
        return;
      }
      flushAll();
    },
  };
}

export function resolveRevisionScopes(
  event: Pick<AppRevisionEvent, "reason" | "scopes">,
): Set<AppRevisionScope> {
  if (event.scopes) return new Set(event.scopes.filter(isRevisionScope));
  return new Set(fallbackScopesByReason[event.reason]);
}

export function matchesRevisionScopes(
  queryKey: QueryKey,
  scopes: ReadonlySet<AppRevisionScope>,
): boolean {
  const prefix = queryKey[0];
  const detail = queryKey[1];
  if (scopes.has("activity") && prefix === "activity") return true;
  if (scopes.has("agents") && prefix === "agents") return true;
  if (scopes.has("alerts") && prefix === "alerts") return true;
  if (scopes.has("budgets") && prefix === "budgets") return true;
  if (
    scopes.has("catalog") &&
    (prefix === "models" ||
      prefix === "pricing-models" ||
      (prefix === "projects" && detail === "options"))
  ) {
    return true;
  }
  if (scopes.has("dashboard") && (prefix === "dashboard" || prefix === "overview")) return true;
  if (scopes.has("data-health") && prefix === "data-health") return true;
  if (scopes.has("projects") && prefix === "projects" && detail !== "options") return true;
  if (scopes.has("rates") && (prefix === "rates" || prefix === "pricing-models")) return true;
  if (scopes.has("sessions") && (prefix === "session" || prefix === "sessions")) return true;
  if (scopes.has("storage") && prefix === "storage") return true;
  return scopes.has("turns") && (prefix === "turn" || prefix === "turns");
}

export function isRevisionScope(value: unknown): value is AppRevisionScope {
  return typeof value === "string" && REVISION_SCOPE_SET.has(value as AppRevisionScope);
}

function createLane(): Lane {
  return { maxTimer: null, pending: new Set<AppRevisionScope>(), quietTimer: null };
}

const fallbackScopesByReason: Record<AppRevisionReason, readonly AppRevisionScope[]> = {
  budget: ["alerts", "budgets"],
  import: [
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
  ],
  project: ["activity", "agents", "catalog", "dashboard", "projects", "sessions", "turns"],
  rate: [
    "agents",
    "alerts",
    "catalog",
    "dashboard",
    "data-health",
    "projects",
    "rates",
    "sessions",
    "turns",
  ],
  retention: [
    "activity",
    "agents",
    "alerts",
    "dashboard",
    "data-health",
    "projects",
    "sessions",
    "storage",
    "turns",
  ],
};
