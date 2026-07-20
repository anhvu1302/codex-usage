import { getDashboard, getSessionSummaries } from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import { getAgentsPage, getProjectsPage } from "@/server/product-analytics";
import { getSessionCoverage } from "@/server/retention";
import { getTurnPage } from "@/server/turns";
import type {
  AgentLeaderboardItem,
  DailyUsage,
  ProjectListItem,
  ReportCell,
  ReportColumnId,
  ReportColumnMetadata,
  ReportCoverage,
  ReportPreviewResponse,
  ReportRequest,
  SessionSummary,
  TurnBackfillStatus,
  TurnSummary,
} from "@/shared/types";

const REPORT_MAX_DAYS = 366;
const REPORT_MAX_COLUMNS = 30;
const REPORT_MAX_ROWS = 100_000;
const REPORT_PREVIEW_ROWS = 20;
const REPORT_PAGE_SIZE = 100;

type ColumnDefinition<Row> = ReportColumnMetadata & { value: (row: Row) => ReportCell };
type ReportBuild = ReportPreviewResponse & { allRows: Record<string, ReportCell>[] };

export class ReportRequestError extends Error {
  readonly status: 400 | 422;

  constructor(message: string, status: 400 | 422) {
    super(message);
    this.name = "ReportRequestError";
    this.status = status;
  }
}

const costColumns: ColumnDefinition<DailyUsage>[] = [
  column("date", "Ngày", true, false, (row) => row.date),
  column("totalTokens", "Token", true, false, (row) => row.totalTokens),
  column("estimatedCostUsd", "Cost ước tính (USD)", true, false, (row) => row.estimatedCostUsd),
  column("requestCount", "Yêu cầu", true, false, (row) => row.requestCount),
  column("sessionCount", "Phiên", true, false, (row) => row.sessionCount),
  column("unpricedUsageCount", "Usage chưa có giá", false, false, (row) => row.unpricedUsageCount),
];

const projectColumns: ColumnDefinition<ProjectListItem>[] = [
  column("projectId", "Project ID", true, false, (row) => row.id),
  column("projectDisplayName", "Tên project", false, true, (row) => row.displayName),
  column("projectDisplayPath", "Đường dẫn project", false, true, (row) => row.displayPath),
  column("totalTokens", "Token", true, false, (row) => row.totalTokens),
  column("estimatedCostUsd", "Cost ước tính (USD)", true, false, (row) => row.estimatedCostUsd),
  column("requestCount", "Yêu cầu", true, false, (row) => row.requestCount),
  column("sessionCount", "Phiên", true, false, (row) => row.sessionCount),
  column("modelCount", "Số model", false, false, (row) => row.modelCount),
  column("subagentTokens", "Token subagent", false, false, (row) => row.subagentTokens),
  column("subagentShare", "Tỷ trọng subagent", false, false, (row) => row.subagentShare),
];

const agentColumns: ColumnDefinition<AgentLeaderboardItem>[] = [
  column("agentId", "Agent ID", false, true, (row) => row.agentId),
  column("agentName", "Tên agent", false, true, (row) => row.name),
  column("role", "Role", false, true, (row) => row.role),
  column("isSubagent", "Là subagent", true, false, (row) => row.isSubagent),
  column("depth", "Depth", true, false, (row) => row.depth),
  column("totalTokens", "Token", true, false, (row) => row.totalTokens),
  column("estimatedCostUsd", "Cost ước tính (USD)", true, false, (row) => row.estimatedCostUsd),
  column("requestCount", "Yêu cầu", true, false, (row) => row.requestCount),
  column("sessionCount", "Phiên", true, false, (row) => row.sessionCount),
  column("cacheRate", "Cache rate", false, false, (row) =>
    row.inputTokens > 0 ? (row.cachedInputTokens / row.inputTokens) * 100 : 0,
  ),
];

const sessionColumns: ColumnDefinition<SessionSummary>[] = [
  column("sessionId", "Session ID", false, true, (row) => row.sessionId),
  column("sessionTitle", "Tiêu đề session", false, true, (row) => row.title),
  column("projectId", "Project ID", true, false, (row) => row.projectId),
  column("lastEventAt", "Hoạt động cuối", true, false, (row) => row.lastEventAt),
  column("models", "Models", true, false, (row) => row.models.join(", ")),
  column("totalTokens", "Token", true, false, (row) => row.totalTokens),
  column("estimatedCostUsd", "Cost ước tính (USD)", true, false, (row) => row.estimatedCostUsd),
  column("requestCount", "Yêu cầu", true, false, (row) => row.requestCount),
  column("agentCount", "Số agent", false, false, (row) => row.agentCount),
  column("subagentCount", "Số subagent", false, false, (row) => row.subagentCount),
];

const turnColumns: ColumnDefinition<TurnSummary>[] = [
  column("turnKey", "Turn key", false, true, (row) => row.turnKey),
  column("turnId", "Turn ID", false, true, (row) => row.turnId),
  column("sessionId", "Session ID", false, true, (row) => row.sessionId),
  column("sessionTitle", "Tiêu đề session", false, true, (row) => row.sessionTitle),
  column("agentName", "Tên agent", false, true, (row) => row.agentName),
  column("role", "Role", false, true, (row) => row.role),
  column("projectId", "Project ID", true, false, (row) => row.projectId),
  column("status", "Trạng thái", true, false, (row) => row.status),
  column("models", "Models", true, false, (row) => row.models.join(", ")),
  column("totalTokens", "Token", true, false, (row) => row.totalTokens),
  column("estimatedCostUsd", "Cost ước tính (USD)", true, false, (row) => row.estimatedCostUsd),
  column("costCoverage", "Coverage cost", true, false, (row) => row.costCoverage),
  column("durationMs", "Duration (ms)", true, false, (row) => row.durationMs),
  column("timeToFirstTokenMs", "TTFT (ms)", false, false, (row) => row.timeToFirstTokenMs),
  column(
    "contextUtilizationPercent",
    "Context (%)",
    false,
    false,
    (row) => row.contextUtilizationPercent,
  ),
];

export function previewReport(
  database: AppDatabase,
  request: ReportRequest,
  backfill: TurnBackfillStatus,
): ReportPreviewResponse {
  const { allRows: _allRows, ...preview } = buildReport(database, request, backfill, false);
  void _allRows;
  return preview;
}

export function exportReport(
  database: AppDatabase,
  request: ReportRequest,
  backfill: TurnBackfillStatus,
): { body: string; contentType: string; filename: string } {
  const report = buildReport(database, request, backfill, true);
  const body =
    request.format === "json"
      ? JSON.stringify(report.allRows, null, 2)
      : reportToCsv(report.allRows, report.resolvedColumns);
  return {
    body,
    contentType: request.format === "json" ? "application/json" : "text/csv; charset=utf-8",
    filename: `codex-usage-${request.preset}.${request.format}`,
  };
}

function buildReport(
  database: AppDatabase,
  request: ReportRequest,
  backfill: TurnBackfillStatus,
  exporting: boolean,
): ReportBuild {
  if (inclusiveDayCount(request.filters.from, request.filters.to) > REPORT_MAX_DAYS) {
    throw new ReportRequestError("Reports support at most 366 days; narrow the date range", 422);
  }

  switch (request.preset) {
    case "cost-overview": {
      const dashboard = getDashboard(database, request.filters);
      return finalizeReport(
        request,
        costColumns,
        {
          coverage: fullCoverage(request.filters.from, request.filters.to),
          rows: dashboard.daily,
        },
        exporting,
      );
    }
    case "project-summary": {
      const first = getProjectsPage(database, {
        ...request.filters,
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
      });
      assertRowLimit(first.total);
      const rows = [...first.projects];
      for (let page = 2; rows.length < first.total; page += 1) {
        rows.push(
          ...getProjectsPage(database, {
            ...request.filters,
            page,
            pageSize: REPORT_PAGE_SIZE,
          }).projects,
        );
      }
      return finalizeReport(
        request,
        projectColumns,
        { coverage: fullCoverage(request.filters.from, request.filters.to), rows },
        exporting,
      );
    }
    case "agent-summary": {
      const first = getAgentsPage(database, {
        ...request.filters,
        order: "desc",
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
        sort: "tokens",
      });
      assertRowLimit(first.total);
      const rows = [...first.agents];
      for (let page = 2; rows.length < first.total; page += 1) {
        rows.push(
          ...getAgentsPage(database, {
            ...request.filters,
            order: "desc",
            page,
            pageSize: REPORT_PAGE_SIZE,
            sort: "tokens",
          }).agents,
        );
      }
      return finalizeReport(
        request,
        agentColumns,
        {
          coverage: { aggregate: "full", detail: getSessionCoverage(request.filters) },
          rows,
        },
        exporting,
      );
    }
    case "session-summary": {
      const first = getSessionSummaries(database, {
        ...request.filters,
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
      });
      assertRowLimit(first.total);
      const rows = [...first.sessions];
      for (let page = 2; rows.length < first.total; page += 1) {
        rows.push(
          ...getSessionSummaries(database, {
            ...request.filters,
            page,
            pageSize: REPORT_PAGE_SIZE,
          }).sessions,
        );
      }
      return finalizeReport(
        request,
        sessionColumns,
        { coverage: { aggregate: "full", detail: first.coverage }, rows },
        exporting,
      );
    }
    case "turn-summary": {
      const first = getTurnPage(database, {
        ...request.filters,
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
      });
      assertRowLimit(first.total);
      const rows = [...first.turns];
      for (let page = 2; rows.length < first.total; page += 1) {
        rows.push(
          ...getTurnPage(database, {
            ...request.filters,
            page,
            pageSize: REPORT_PAGE_SIZE,
          }).turns,
        );
      }
      return finalizeReport(
        request,
        turnColumns,
        {
          coverage: {
            aggregate:
              backfill.isRunning || backfill.error !== null || backfill.sourceDeletedGaps > 0
                ? "partial"
                : "full",
            detail: getSessionCoverage(request.filters),
          },
          rows,
        },
        exporting,
      );
    }
  }
}

function finalizeReport<Row>(
  request: ReportRequest,
  definitions: ColumnDefinition<Row>[],
  data: { coverage: ReportCoverage; rows: Row[] },
  exporting: boolean,
): ReportBuild {
  const resolvedDefinitions = resolveColumns(definitions, request.columns);
  const sensitiveColumns = resolvedDefinitions.filter((definition) => definition.sensitive);
  const acknowledgementMatches = sameStringSet(
    request.acknowledgeSensitive,
    sensitiveColumns.map((column) => column.id),
  );
  if (exporting && !acknowledgementMatches) {
    throw new ReportRequestError(
      "Sensitive columns require acknowledgement matching the resolved columns",
      422,
    );
  }

  assertRowLimit(data.rows.length);
  const allRows = data.rows.map((row) => projectRow(row, resolvedDefinitions));
  const availableColumns = definitions.map(toColumnMetadata);
  const resolvedColumns = resolvedDefinitions.map(toColumnMetadata);
  const sensitiveWarning =
    sensitiveColumns.length === 0
      ? null
      : `Các cột nhạy cảm có thể lộ metadata local: ${sensitiveColumns.map((column) => column.label).join(", ")}.`;
  return {
    acknowledgementMatches,
    allRows,
    availableColumns,
    coverage: data.coverage,
    resolvedColumns,
    rowCount: { kind: "exact", value: allRows.length },
    rows: allRows.slice(0, REPORT_PREVIEW_ROWS),
    sensitiveWarning,
  };
}

function resolveColumns<Row>(
  definitions: ColumnDefinition<Row>[],
  requested: readonly string[],
): ColumnDefinition<Row>[] {
  if (requested.length > REPORT_MAX_COLUMNS) {
    throw new ReportRequestError("Reports support at most 30 columns", 422);
  }
  if (new Set(requested).size !== requested.length) {
    throw new ReportRequestError("Report columns must be unique", 400);
  }
  if (requested.length === 0)
    return definitions.filter((definition) => definition.selectedByDefault);
  const byId = new Map<string, ColumnDefinition<Row>>(
    definitions.map((definition) => [definition.id, definition]),
  );
  return requested.map((id) => {
    const definition = byId.get(id);
    if (!definition)
      throw new ReportRequestError(`Column is not allowed for this preset: ${id}`, 400);
    return definition;
  });
}

function projectRow<Row>(
  row: Row,
  definitions: ColumnDefinition<Row>[],
): Record<string, ReportCell> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.id, definition.value(row)]),
  );
}

function toColumnMetadata<Row>({ value: _value, ...metadata }: ColumnDefinition<Row>) {
  void _value;
  return metadata;
}

function column<Row>(
  id: ReportColumnId,
  label: string,
  selectedByDefault: boolean,
  sensitive: boolean,
  value: (row: Row) => ReportCell,
): ColumnDefinition<Row> {
  return { id, label, selectedByDefault, sensitive, value };
}

function fullCoverage(from: string, to: string): ReportCoverage {
  return { aggregate: "full", detail: { from, status: "full", to } };
}

function assertRowLimit(value: number) {
  if (value > REPORT_MAX_ROWS) {
    throw new ReportRequestError("Report exceeds 100,000 rows; narrow the filters", 422);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function inclusiveDayCount(from: string, to: string): number {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1
  );
}

function reportToCsv(rows: Record<string, ReportCell>[], columns: ReportColumnMetadata[]): string {
  const headers = columns.map((column) => column.id);
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => Object.values(row).map(csvCell).join(",")),
  ].join("\n");
}

function csvCell(value: ReportCell | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r\n ]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
