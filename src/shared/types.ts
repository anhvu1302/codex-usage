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
  model?: string;
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
  model: string;
  totalTokens: number;
};

export type HourlyUsage = DashboardKpis & {
  hour: string;
};

export type HourlyModelUsage = {
  hour: string;
  model: string;
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
  sessionId: string;
  sourceDeleted: boolean;
  title: string | null;
};

export type SessionAgentUsage = Omit<DashboardKpis, "sessionCount"> & {
  agentId: string;
  depth: number;
  firstEventAt: string;
  isSubagent: boolean;
  lastEventAt: string;
  models: string[];
  name: string | null;
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

export type ImportStatus = {
  error: string | null;
  filesProcessed: number;
  isSyncing: boolean;
  lastSyncAt: string | null;
  recordsBackfilled: number;
  recordsInserted: number;
  recordsReclassified: number;
};

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
  sessions: SessionUsage[];
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
  sourceManaged: false;
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
