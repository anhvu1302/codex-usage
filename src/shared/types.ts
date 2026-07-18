export type TokenUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type DateRange = {
  from: string;
  to: string;
};

export type DashboardFilters = DateRange & {
  agentKind?: AgentKind;
  model?: string;
  models?: string[];
  projectId?: string;
};

type AgentKind = "all" | "main" | "subagent";

export type DashboardQuery = {
  agentKind?: AgentKind;
  from?: string;
  model?: string;
  models?: string;
  project?: string;
  to?: string;
};

export type DashboardKpis = TokenUsage & {
  estimatedCostUsd: number;
  requestCount: number;
  sessionCount: number;
  unpricedUsageCount: number;
};

export type DailyUsage = DashboardKpis & {
  date: string;
};

export type DailyModelUsage = {
  date: string;
  estimatedCostUsd: number;
  model: string;
  requestCount: number;
  totalTokens: number;
};

export type HourlyUsage = DashboardKpis & {
  hour: string;
};

export type HourlyModelUsage = {
  estimatedCostUsd: number;
  hour: string;
  model: string;
  requestCount: number;
  totalTokens: number;
};

export type ModelUsage = DashboardKpis & {
  model: string;
  tokenShare: number;
};

export type SessionUsage = DashboardKpis & {
  agents: SessionAgentUsage[];
  cwd: string | null;
  firstEventAt: string;
  lastEventAt: string;
  models: string[];
  projectId: string | null;
  sessionId: string;
  sourceDeleted: boolean;
  title: string | null;
};

export type SessionAgentUsage = Omit<DashboardKpis, "sessionCount"> & {
  agentId: string;
  depth: number;
  firstEventAt: string | null;
  isSubagent: boolean;
  lastEventAt: string | null;
  models: string[];
  name: string | null;
  parentAgentId: string | null;
  role: string | null;
  sourceDeleted: boolean;
  taskSummary: string | null;
};

export type ModelRate = {
  cachedInputRate: number;
  inputRate: number;
  model: string;
  outputRate: number;
  updatedAt: string;
};

export type SourceScanMode = "deep" | "inventory";
export type SourceScanTrigger = "manual" | "scheduled" | "startup";

export type SourceScanStatus = {
  current: {
    discoveredFiles: number;
    filesRead: number;
    filesSkipped: number;
    mode: SourceScanMode;
    phase: "discovering" | "reading" | "reconciling";
    startedAt: string;
    trigger: SourceScanTrigger;
  } | null;
  deepQueued: boolean;
  lastCompleted: {
    completedAt: string;
    discoveredFiles: number;
    durationMs: number;
    filesRead: number;
    filesSkipped: number;
    mode: SourceScanMode;
    sourceBytes: number;
    trigger: SourceScanTrigger;
  } | null;
  nextScheduledAt: string | null;
};

export type ImportStatus = {
  error: string | null;
  filesProcessed: number;
  isSyncing: boolean;
  lastSyncAt: string | null;
  recordsBackfilled: number;
  recordsInserted: number;
  recordsReclassified: number;
  sourceScan: SourceScanStatus;
  turnBackfill: TurnBackfillStatus;
};

export type AppRevisionReason = "budget" | "import" | "project" | "rate" | "retention";

export type AppRevisionScope =
  | "activity"
  | "agents"
  | "alerts"
  | "budgets"
  | "catalog"
  | "dashboard"
  | "data-health"
  | "projects"
  | "rates"
  | "sessions"
  | "storage"
  | "turns";

export type AppRevisionEvent = {
  reason: AppRevisionReason;
  revision: number;
  scopes?: AppRevisionScope[];
};

export type AppScanEvent = ImportStatus;

export type RetentionCoverage = {
  hourlyAvailable: boolean;
  hourlyFrom: string;
  rawFrom: string;
  sessionDetails: "full" | "none" | "partial";
};

export type SessionCoverage = {
  from: string | null;
  status: "full" | "none" | "partial";
  to: string | null;
};

export type SessionsResponse = {
  coverage: SessionCoverage;
  page: number;
  pageSize: number;
  sessions: SessionUsage[];
  total: number;
};

export type SessionSummary = Omit<SessionUsage, "agents"> & {
  agentCount: number;
  subagentCount: number;
  subagentNames: string[];
};

export type SessionSummariesResponse = Omit<SessionsResponse, "sessions"> & {
  sessions: SessionSummary[];
};

export type SessionFilters = DashboardFilters & {
  hasSubagents?: boolean;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  query?: string;
  sort?: "cost" | "lastActivity" | "tokens";
};

export type SessionQuery = DashboardQuery & {
  hasSubagents?: "false" | "true";
  order?: NonNullable<SessionFilters["order"]>;
  page?: string;
  pageSize?: string;
  q?: string;
  sort?: NonNullable<SessionFilters["sort"]>;
};

export type StorageStatus = {
  dailyRows: number;
  databaseBytes: number;
  error: string | null;
  hourlyRows: number;
  isCompacting: boolean;
  lastCompactionAt: string | null;
  lastHourlyRowsDeleted: number;
  lastRawEventsDeleted: number;
  lastRollupRowsWritten: number;
  oldestDailyDate: string | null;
  oldestHourlyDate: string | null;
  oldestRawDate: string | null;
  policy: {
    dailyRetention: "forever";
    hourlyDays: 90;
    rawDays: 30;
  };
  rawEvents: number;
  sourceBytes: number;
  sourceFileCount: number;
  sourceManaged: false;
  sourceScannedAt: string | null;
  walBytes: number;
};

export type DashboardResponse = {
  daily: DailyUsage[];
  dailyModels: DailyModelUsage[];
  hourly: HourlyUsage[];
  hourlyModels: HourlyModelUsage[];
  kpis: DashboardKpis;
  models: ModelUsage[];
  retention: RetentionCoverage;
};

export type EfficiencyMetrics = {
  averageCostPerDay: number;
  averageTokensPerDay: number;
  cacheRate: number;
  costPerRequest: number;
  reasoningShare: number;
  tokensPerSession: number;
};

export type MetricDelta = {
  absolute: number;
  percent: number | null;
};

export type InsightAlert = {
  date: string;
  kind: "cost" | "tokens";
  value: number;
};

export type InsightsResponse = {
  anomalies: InsightAlert[];
  current: DashboardKpis;
  deltas: {
    cost: MetricDelta;
    requests: MetricDelta;
    tokens: MetricDelta;
  };
  efficiency: EfficiencyMetrics;
  modelCostMover: {
    currentCostUsd: number;
    deltaUsd: number;
    model: string;
    previousCostUsd: number;
  } | null;
  monthlyCostProjection: number | null;
  previous: DashboardKpis;
  previousRange: DateRange;
  unusualSession: {
    estimatedCostUsd: number;
    reasons: ("cost" | "tokens")[];
    sessionId: string;
    title: string | null;
    totalTokens: number;
  } | null;
};

export type OverviewResponse = {
  dashboard: DashboardResponse;
  insights: InsightsResponse;
};

export type ProjectSummary = DashboardKpis & {
  daily: DailyUsage[];
  displayName: string;
  displayPath: string;
  id: string;
  modelMix: { model: string; totalTokens: number }[];
  subagentCostUsd: number;
  subagentShare: number;
  subagentTokens: number;
  topSessions: SessionUsage[];
};

export type ProjectsResponse = {
  projects: ProjectSummary[];
};

export type ProjectOptionsResponse = {
  projects: { displayName: string; id: string }[];
};

export type ProjectListItem = DashboardKpis & {
  displayName: string;
  displayPath: string;
  id: string;
  modelCount: number;
  subagentCostUsd: number;
  subagentShare: number;
  subagentTokens: number;
  topModels: { model: string; totalTokens: number }[];
};

export type ProjectPageFilters = DashboardFilters & {
  page?: number;
  pageSize?: number;
};

export type ProjectPageQuery = DashboardQuery & {
  page?: string;
  pageSize?: string;
};

export type ProjectsPageResponse = {
  page: number;
  pageSize: number;
  projects: ProjectListItem[];
  total: number;
};

export type ProjectsSummaryResponse = {
  kpis: DashboardKpis;
  projectCount: number;
};

export type ProjectAnalyticsResponse = {
  project: ProjectSummary;
};

export type AgentUsageSummary = Omit<SessionAgentUsage, "firstEventAt" | "lastEventAt"> & {
  firstEventAt: string | null;
  lastEventAt: string | null;
  projectIds: string[];
  sessionCount: number;
};

export type AgentsResponse = {
  agents: AgentUsageSummary[];
  coverage: SessionCoverage;
  daily: {
    date: string;
    main: DashboardKpis;
    subagent: DashboardKpis;
  }[];
  main: DashboardKpis;
  subagent: DashboardKpis;
};

export type AgentLeaderboardMetric = "cache" | "cost" | "output" | "requests" | "tokens";

export type AgentLeaderboardItem = {
  agentId: string;
  cachedInputTokens: number;
  depth: number;
  estimatedCostUsd: number;
  inputTokens: number;
  isSubagent: boolean;
  modelCount: number;
  name: string | null;
  outputTokens: number;
  requestCount: number;
  role: string | null;
  sessionCount: number;
  topModels: string[];
  totalTokens: number;
};

export type AgentPageFilters = AgentFilters & {
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  sort?: AgentLeaderboardMetric;
};

export type AgentPageQuery = AgentQuery & {
  order?: NonNullable<AgentPageFilters["order"]>;
  page?: string;
  pageSize?: string;
  sort?: NonNullable<AgentPageFilters["sort"]>;
};

export type AgentsPageResponse = {
  agents: AgentLeaderboardItem[];
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  sort: AgentLeaderboardMetric;
  total: number;
};

export type AgentsSummaryResponse = Omit<AgentsResponse, "agents"> & {
  totalAgents: number;
};

export type AgentFilters = DashboardFilters & {
  depth?: number;
  role?: string;
};

export type AgentQuery = DashboardQuery & {
  depth?: string;
  role?: string;
};

export type BudgetPeriod = "daily" | "monthly";

export type BudgetSetting = {
  enabled: boolean;
  limitUsd: number;
  period: BudgetPeriod;
  updatedAt: string;
  warningThresholds: number[];
};

export type AlertEvent = {
  createdAt: string;
  dismissedAt: string | null;
  id: string;
  message: string;
  periodStart: string;
  seenAt: string | null;
  severity: "critical" | "info" | "warning";
  title: string;
  turnKey: string | null;
  type: "anomaly" | "budget" | "context-pressure" | "data-health";
};

export type AlertsResponse = {
  alerts: AlertEvent[];
  unseenCount: number;
};

export type DismissAlertsResponse = {
  dismissedCount: number;
};

export type PricingSimulationRequest = DashboardFilters & {
  rates: Omit<ModelRate, "updatedAt">[];
};

export type PricingSimulationResponse = {
  currentCostUsd: number;
  deltaUsd: number;
  simulatedCostUsd: number;
};

export type ActivityKind =
  | "abort"
  | "compaction"
  | "file"
  | "mcp"
  | "other"
  | "patch"
  | "shell"
  | "task_completed"
  | "task_started"
  | "turn"
  | "web";

export type ActivityDailyUsage = {
  date: string;
  estimatedCostUsd: number;
  requestCount: number;
  totalTokens: number;
  unpricedUsageCount: number;
};

export type ActivitySummary = {
  agentKind: Exclude<AgentKind, "all">;
  count: number;
  date: string;
  kind: ActivityKind;
  projectId: string;
};

export type ActivityFilters = DashboardFilters & {
  kinds?: ActivityKind[];
  sessionId?: string;
};

export type ActivityQuery = DashboardQuery & {
  kinds?: string;
  session?: string;
};

export type ActivityTimelineQuery = ActivityQuery & {
  cursor?: string;
  limit?: string;
};

export type ActivityTimelineItem = {
  agentId: string;
  agentKind: Exclude<AgentKind, "all">;
  depth: number;
  id: string;
  kind: ActivityKind;
  name: string | null;
  parentAgentId: string | null;
  projectId: string;
  role: string | null;
  sessionId: string;
  timestamp: string;
  turnKey: string | null;
};

export type ActivityResponse = {
  daily: ActivitySummary[];
  timeline: ActivityTimelineItem[];
  timelineCoverage: SessionCoverage;
  timelineTruncated: boolean;
};

export type ActivitySummaryResponse = {
  daily: ActivitySummary[];
  dailyUsage: ActivityDailyUsage[];
  timelineCoverage: SessionCoverage;
  timelineTotal: number;
};

export type ActivityTimelineResponse = {
  hasMore: boolean;
  items: ActivityTimelineItem[];
  nextCursor: string | null;
};

export type DataHealthResponse = {
  activityDailyRows: number;
  activityRawEvents: number;
  hourlyCoverageFrom: string;
  incompleteFiles: number;
  importerError: string | null;
  lastCompactionAt: string | null;
  lastSyncAt: string | null;
  malformedLines: number;
  rawCoverageFrom: string;
  retentionError: string | null;
  sourceDeletedAgents: number;
  sourceDeletedSessions: number;
  sourceScan: SourceScanStatus;
  turnBackfill: TurnBackfillStatus;
  turnCostAttributionGaps: number;
  turnUnassignedActivity: number;
  turnUnassignedUsage: number;
  unknownUsage: number;
  unpricedUsage: number;
};

export type TurnStatus = "aborted" | "completed" | "unknown";
export type TurnCostCoverage = "exact" | "partial" | "unavailable";
export type TurnPressureFilter =
  "70" | "70-84" | "85" | "85-94" | "95" | "95+" | "below-70" | "unknown";

export type TurnBackfillStatus = {
  attributionVersion: number;
  costAttributionMissingCount: number;
  error: string | null;
  filesProcessed: number;
  isRunning: boolean;
  lastRunAt: string | null;
  sourceDeletedGaps: number;
  totalFiles: number;
};

export type TurnFilters = DashboardFilters & {
  agentId?: string;
  effort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  pressure?: TurnPressureFilter;
  query?: string;
  sessionId?: string;
  sort?: "context" | "cost" | "duration" | "lastActivity" | "tokens" | "ttft";
  status?: TurnStatus;
};

export type TurnQuery = DashboardQuery & {
  agent?: string;
  effort?: string;
  order?: NonNullable<TurnFilters["order"]>;
  page?: string;
  pageSize?: string;
  pressure?: TurnPressureFilter;
  q?: string;
  session?: string;
  sort?: NonNullable<TurnFilters["sort"]>;
  status?: TurnStatus;
};

export type TurnComparisonQuery = {
  ids: string;
};

export type TurnUsageMetrics = TokenUsage & {
  costAttributionMissingCount: number;
  costCoverage: TurnCostCoverage;
  estimatedCostUsd: number;
  requestCount: number;
  unpricedUsageCount: number;
};

export type TurnSummary = TurnUsageMetrics & {
  agentId: string;
  agentKind: "main" | "subagent";
  agentName: string | null;
  cacheRate: number;
  collaborationMode: string | null;
  completedAt: string | null;
  contextUtilizationPercent: number | null;
  contextWindowTokens: number | null;
  depth: number;
  durationMs: number | null;
  effort: string | null;
  lastEventAt: string;
  models: string[];
  ordinal: number;
  parentAgentId: string | null;
  peakInputTokens: number | null;
  projectId: string | null;
  role: string | null;
  sessionId: string;
  sessionTitle: string | null;
  startedAt: string | null;
  status: TurnStatus;
  timeToFirstTokenMs: number | null;
  turnId: string;
  turnKey: string;
};

export type TurnKpis = {
  averageCostPerTurn: number | null;
  cacheRate: number;
  contextPressureTurnCount: number;
  costCoverage: TurnCostCoverage;
  estimatedCostUsd: number;
  p50DurationMs: number | null;
  p50TimeToFirstTokenMs: number | null;
  p95DurationMs: number | null;
  totalTokens: number;
  turnCount: number;
};

export type TurnDailyUsage = {
  costCoverage: TurnCostCoverage;
  date: string;
  estimatedCostUsd: number;
  totalTokens: number;
  turnCount: number;
};

export type TurnContextBucket = {
  count: number;
  id: "70-84" | "85-94" | "95+" | "below-70" | "unknown";
  label: string;
};

export type TurnCoverage = {
  aggregate: "full" | "partial";
  backfill: TurnBackfillStatus;
  timeline: SessionCoverage;
};

export type TurnsResponse = {
  contextBuckets: TurnContextBucket[];
  coverage: TurnCoverage;
  daily: TurnDailyUsage[];
  kpis: TurnKpis;
  liveRefreshSuggested: boolean;
  page: number;
  pageSize: number;
  total: number;
  turns: TurnSummary[];
};

export type TurnModelUsage = TurnUsageMetrics & {
  model: string;
};

export type TurnActivityCount = {
  count: number;
  kind: ActivityKind;
};

export type TurnRequestUsage = TokenUsage & {
  contextUtilizationPercent: number | null;
  costCoverage: "exact" | "unavailable";
  estimatedCostUsd: number | null;
  id: string;
  model: string;
  timestamp: string;
};

export type TurnDetailResponse = {
  activity: TurnActivityCount[];
  activityTimeline: ActivityTimelineItem[];
  models: TurnModelUsage[];
  requests: TurnRequestUsage[];
  threadAgents: SessionAgentUsage[];
  timelineCoverage: SessionCoverage;
  timelineTruncated: boolean;
  turn: TurnSummary;
};

export type TurnComparisonResponse = {
  missingIds: string[];
  turns: TurnSummary[];
};
