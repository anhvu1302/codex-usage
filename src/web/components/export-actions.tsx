import { Download, FileJson, FileSpreadsheet, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { AgentFilters, SessionFilters, TurnFilters } from "@/shared/types";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Label } from "@/web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";

type ExportDataset = "agents" | "models" | "projects" | "sessions" | "turns";
type ExportFormat = "csv" | "json";
type ExportFilters = (AgentFilters & SessionFilters) | TurnFilters;

const exportLabels: Record<ExportDataset, string> = {
  agents: "Agent",
  models: "Model",
  projects: "Dự án",
  sessions: "Phiên",
  turns: "Turns",
};
const allExportDatasets = Object.keys(exportLabels) as ExportDataset[];

export function ExportActions({
  datasets = allExportDatasets,
  filters,
}: {
  datasets?: ExportDataset[];
  filters: ExportFilters;
}) {
  const [dataset, setDataset] = useState<ExportDataset>(datasets.at(0) ?? "models");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [isExporting, setIsExporting] = useState(false);

  async function download() {
    setIsExporting(true);
    try {
      await downloadExport(dataset, format, filters);
      toast.success(`Đã xuất ${exportDatasetLabel(dataset)} dạng ${format.toUpperCase()}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Không thể export dữ liệu.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="text-primary size-4" aria-hidden="true" />
          Export dữ liệu
        </CardTitle>
        <CardDescription>
          File dùng chính xác khoảng ngày, model, project, tag và loại agent đang được lọc.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="export-dataset">Dữ liệu</Label>
            <Select value={dataset} onValueChange={(value: ExportDataset) => setDataset(value)}>
              <SelectTrigger id="export-dataset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((value) => (
                  <SelectItem key={value} value={value}>
                    {exportDatasetLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="export-format">Định dạng</Label>
            <Select value={format} onValueChange={(value: ExportFormat) => setFormat(value)}>
              <SelectTrigger id="export-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">
                  <span className="flex items-center gap-2">
                    <FileSpreadsheet className="size-3.5" aria-hidden="true" /> CSV
                  </span>
                </SelectItem>
                <SelectItem value="json">
                  <span className="flex items-center gap-2">
                    <FileJson className="size-3.5" aria-hidden="true" /> JSON
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={() => void download()}
            disabled={isExporting}
            className="w-full sm:w-auto"
          >
            {isExporting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            Export
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function exportDatasetLabel(dataset: ExportDataset) {
  switch (dataset) {
    case "agents":
      return exportLabels.agents;
    case "models":
      return exportLabels.models;
    case "projects":
      return exportLabels.projects;
    case "sessions":
      return exportLabels.sessions;
    case "turns":
      return exportLabels.turns;
  }
}

function dashboardQuery(dataset: ExportDataset, filters: ExportFilters) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  if (models.length > 0) query.set("models", models.join(","));
  if (filters.projectId) query.set("project", filters.projectId);
  if (filters.tagIds?.length) query.set("tags", [...new Set(filters.tagIds)].join(","));
  if (filters.agentKind && filters.agentKind !== "all") query.set("agentKind", filters.agentKind);
  if ("depth" in filters && filters.depth !== undefined) query.set("depth", String(filters.depth));
  if ("role" in filters && filters.role) query.set("role", filters.role);
  if ("hasSubagents" in filters && filters.hasSubagents !== undefined) {
    query.set("hasSubagents", String(filters.hasSubagents));
  }
  if (filters.query) query.set("q", filters.query);
  if (filters.order) query.set("order", filters.order);
  if (dataset === "turns" && filters.sort) query.set("sort", filters.sort);
  if (
    dataset === "sessions" &&
    (filters.sort === "cost" || filters.sort === "lastActivity" || filters.sort === "tokens")
  ) {
    query.set("sort", filters.sort);
  }
  if ("agentId" in filters && filters.agentId) query.set("agent", filters.agentId);
  if ("effort" in filters && filters.effort) query.set("effort", filters.effort);
  if ("pressure" in filters && filters.pressure) query.set("pressure", filters.pressure);
  if ("sessionId" in filters && filters.sessionId) query.set("session", filters.sessionId);
  if ("status" in filters && filters.status) query.set("status", filters.status);
  return query;
}

async function downloadExport(
  dataset: ExportDataset,
  format: ExportFormat,
  filters: ExportFilters,
) {
  const query = dashboardQuery(dataset, filters);
  query.set("dataset", dataset);
  query.set("format", format);
  const response = await fetch(`/api/export?${query.toString()}`);
  if (!response.ok) throw new Error(await errorMessage(response));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `codex-usage-${dataset}.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function errorMessage(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return `Request failed (${response.status})`;
}
