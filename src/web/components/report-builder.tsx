import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileJson,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  DashboardFilters,
  ReportCell,
  ReportColumnMetadata,
  ReportFormat,
  ReportPreset,
  ReportPreviewResponse,
  ReportRequest,
} from "@/shared/types";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/web/components/ui/card";
import { Label } from "@/web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Skeleton } from "@/web/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import { fetchReportExport, fetchReportPreview } from "@/web/lib/report-api";

const REPORT_PRESETS: { label: string; value: ReportPreset }[] = [
  { label: "Tổng quan chi phí", value: "cost-overview" },
  { label: "Tổng hợp project", value: "project-summary" },
  { label: "Tổng hợp agent", value: "agent-summary" },
  { label: "Tổng hợp session", value: "session-summary" },
  { label: "Tổng hợp turn", value: "turn-summary" },
];

export function ReportBuilder({ filters }: { filters: DashboardFilters }) {
  const [preset, setPreset] = useState<ReportPreset>("cost-overview");
  const [format, setFormat] = useState<ReportFormat>("csv");
  const [draftColumns, setDraftColumns] = useState<string[] | null>(null);
  const [submittedColumns, setSubmittedColumns] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const previewRequest = useMemo(
    () => createReportRequest(preset, "json", submittedColumns, filters, []),
    [filters, preset, submittedColumns],
  );
  const preview = useQuery({
    queryKey: ["reports", "preview", previewRequest],
    queryFn: ({ signal }) => fetchReportPreview(previewRequest, signal),
  });

  const resolvedIds = preview.data?.resolvedColumns.map((column) => column.id) ?? [];
  const selectedIds = draftColumns ?? resolvedIds;
  const previewIsCurrent =
    preview.data !== undefined &&
    !preview.isFetching &&
    sameOrderedValues(selectedIds, resolvedIds);
  const sensitiveIds =
    preview.data?.resolvedColumns.filter((column) => column.sensitive).map((column) => column.id) ??
    [];
  const canExport = previewIsCurrent && (sensitiveIds.length === 0 || acknowledged);

  function changePreset(value: ReportPreset) {
    setPreset(value);
    setDraftColumns(null);
    setSubmittedColumns([]);
    setAcknowledged(false);
  }

  function toggleColumn(id: string, checked: boolean) {
    const next = checked ? [...selectedIds, id] : selectedIds.filter((value) => value !== id);
    if (next.length === 0) return;
    setDraftColumns(next);
    setAcknowledged(false);
  }

  function moveColumn(id: string, direction: -1 | 1) {
    const index = selectedIds.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= selectedIds.length) return;
    const next = [...selectedIds];
    const [current] = next.splice(index, 1);
    if (current === undefined) return;
    next.splice(destination, 0, current);
    setDraftColumns(next);
    setAcknowledged(false);
  }

  function refreshPreview() {
    setAcknowledged(false);
    if (sameOrderedValues(submittedColumns, selectedIds)) {
      void preview.refetch();
      return;
    }
    setSubmittedColumns([...selectedIds]);
  }

  async function download() {
    if (!preview.data || !canExport) return;
    setIsExporting(true);
    try {
      const request = createReportRequest(preset, format, resolvedIds, filters, sensitiveIds);
      const file = await fetchReportExport(request);
      saveBlob(file.blob, file.filename);
      toast.success(`Đã xuất report ${format.toUpperCase()}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Không thể xuất report.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <Card data-testid="report-builder">
      <CardHeader>
        <h2 className="flex items-center gap-2 text-base leading-none font-semibold tracking-tight">
          <FileSpreadsheet className="text-primary size-4" aria-hidden="true" />
          Report Builder
        </h2>
        <CardDescription>
          Xem trước cùng projection sẽ được export; cột metadata local nhạy cảm phải được xác nhận.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6" aria-live="polite" aria-busy={preview.isFetching}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="report-preset">Preset</Label>
            <Select value={preset} onValueChange={changePreset}>
              <SelectTrigger id="report-preset" aria-label="Chọn preset report">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_PRESETS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="report-format">Định dạng report</Label>
            <Select value={format} onValueChange={(value: ReportFormat) => setFormat(value)}>
              <SelectTrigger id="report-format" aria-label="Chọn định dạng report">
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
        </div>

        {preview.isLoading ? <ReportSkeleton /> : null}
        {preview.isError ? (
          <div
            className="border-destructive/40 bg-destructive/5 rounded-lg border p-4"
            role="alert"
          >
            <p className="text-sm font-medium">Không thể tạo preview.</p>
            <p className="text-muted-foreground mt-1 text-xs">{preview.error.message}</p>
            <Button
              className="mt-3"
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void preview.refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" /> Thử lại
            </Button>
          </div>
        ) : null}

        {preview.data ? (
          <>
            <ColumnPicker
              available={preview.data.availableColumns}
              selectedIds={selectedIds}
              onMove={moveColumn}
              onToggle={toggleColumn}
            />

            {!previewIsCurrent ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                Danh sách hoặc thứ tự cột đã thay đổi. Tạo lại preview trước khi export.
              </p>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">
                  {preview.data.rowCount.kind === "exact" ? "Chính xác" : "Ước tính"}:{" "}
                  {preview.data.rowCount.value.toLocaleString("en-US")} dòng
                </Badge>
                <Badge variant="outline">Aggregate: {preview.data.coverage.aggregate}</Badge>
                <Badge variant="outline">Detail: {preview.data.coverage.detail.status}</Badge>
              </div>
              <Button
                className="w-full sm:w-auto"
                disabled={preview.isFetching || selectedIds.length === 0}
                type="button"
                variant="outline"
                onClick={refreshPreview}
              >
                {preview.isFetching ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                Tạo preview
              </Button>
            </div>

            {previewIsCurrent ? <ReportPreview report={preview.data} /> : null}

            {previewIsCurrent && preview.data.sensitiveWarning ? (
              <div
                className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4"
                data-testid="report-privacy-warning"
              >
                <div className="flex gap-3">
                  <ShieldAlert
                    className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300"
                    aria-hidden="true"
                  />
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-semibold">Cảnh báo dữ liệu nhạy cảm</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {preview.data.sensitiveWarning}
                      </p>
                    </div>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        className="border-input mt-0.5 size-4 rounded"
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                      />
                      <span>Tôi hiểu file sẽ chứa đúng các cột nhạy cảm được liệt kê ở trên.</span>
                    </label>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex justify-end border-t pt-4">
              <Button
                className="w-full sm:w-auto"
                disabled={!canExport || isExporting || preview.isFetching}
                type="button"
                onClick={() => void download()}
              >
                {isExporting ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                Xuất report
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ColumnPicker({
  available,
  onMove,
  onToggle,
  selectedIds,
}: {
  available: ReportColumnMetadata[];
  onMove: (id: string, direction: -1 | 1) => void;
  onToggle: (id: string, checked: boolean) => void;
  selectedIds: string[];
}) {
  const selected = selectedIds
    .map((id) => available.find((column) => column.id === id))
    .filter((column): column is ReportColumnMetadata => column !== undefined);
  const unselected = available.filter((column) => !selectedIds.includes(column.id));

  return (
    <section className="space-y-3" aria-labelledby="report-columns-title">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 id="report-columns-title" className="text-sm font-semibold">
            Cột và thứ tự
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Chọn tối đa 30 cột; dùng mũi tên để đổi thứ tự export.
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {selected.length}/{available.length}
        </span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {[...selected, ...unselected].map((column) => {
          const selectedIndex = selectedIds.indexOf(column.id);
          const isSelected = selectedIndex >= 0;
          return (
            <div
              className="bg-muted/25 flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2"
              key={column.id}
            >
              <input
                className="border-input size-4 shrink-0 rounded"
                id={`report-column-${column.id}`}
                type="checkbox"
                checked={isSelected}
                disabled={isSelected && selectedIds.length === 1}
                onChange={(event) => onToggle(column.id, event.currentTarget.checked)}
              />
              <label
                className="min-w-0 flex-1 cursor-pointer text-sm"
                htmlFor={`report-column-${column.id}`}
              >
                <span className="break-words">{column.label}</span>
                <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                  {column.sensitive ? <Badge variant="destructive">Nhạy cảm</Badge> : null}
                  {column.selectedByDefault ? <Badge variant="outline">Mặc định</Badge> : null}
                </span>
              </label>
              {isSelected ? (
                <div className="flex shrink-0 gap-1">
                  <Button
                    aria-label={`Đưa ${column.label} lên`}
                    className="size-8"
                    disabled={selectedIndex === 0}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => onMove(column.id, -1)}
                  >
                    <ArrowUp className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={`Đưa ${column.label} xuống`}
                    className="size-8"
                    disabled={selectedIndex === selectedIds.length - 1}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => onMove(column.id, 1)}
                  >
                    <ArrowDown className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReportPreview({ report }: { report: ReportPreviewResponse }) {
  if (report.rowCount.value === 0) {
    return (
      <div
        className="bg-muted/20 rounded-lg border border-dashed px-4 py-10 text-center"
        data-testid="report-empty-state"
      >
        <p className="text-sm font-medium">Không có dữ liệu phù hợp để tạo report.</p>
        <p className="text-muted-foreground mt-1 text-xs">Hãy đổi khoảng ngày hoặc bộ lọc.</p>
      </div>
    );
  }

  return (
    <section className="space-y-3" aria-labelledby="report-preview-title">
      <div>
        <h3 id="report-preview-title" className="text-sm font-semibold">
          Privacy preview
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Hiển thị tối đa 20 dòng mẫu với đúng cột và thứ tự sẽ được export.
        </p>
      </div>
      <div className="hidden md:block">
        <Table scrollLabel="Preview report có thể cuộn ngang">
          <TableHeader>
            <TableRow>
              {report.resolvedColumns.map((column) => (
                <TableHead className="whitespace-nowrap" key={column.id}>
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row, index) => (
              <TableRow key={`report-row-${index}`}>
                {Object.values(row).map((value, valueIndex) => (
                  <TableCell
                    className="max-w-80 break-words"
                    key={`report-cell-${index}-${valueIndex}`}
                  >
                    {formatReportCell(value)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-3 md:hidden" data-testid="report-preview-cards">
        {report.rows.map((row, index) => (
          <article className="space-y-2 rounded-lg border p-3" key={`report-card-${index}`}>
            {Object.entries(row).map(([id, value]) => (
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 text-xs" key={id}>
                <span className="text-muted-foreground break-words">
                  {columnLabel(report.resolvedColumns, id)}
                </span>
                <span className="text-right font-medium break-all">{formatReportCell(value)}</span>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-3" aria-label="Đang tải preview report">
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}

function createReportRequest(
  preset: ReportPreset,
  format: ReportFormat,
  columns: string[],
  filters: DashboardFilters,
  acknowledgeSensitive: string[],
): ReportRequest {
  const shared = { acknowledgeSensitive, columns, filters, format };
  switch (preset) {
    case "agent-summary":
      return { ...shared, preset };
    case "cost-overview":
      return { ...shared, preset };
    case "project-summary":
      return { ...shared, preset };
    case "session-summary":
      return { ...shared, preset };
    case "turn-summary":
      return { ...shared, preset };
  }
}

function sameOrderedValues(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function columnLabel(columns: ReportColumnMetadata[], id: string) {
  return columns.find((column) => column.id === id)?.label ?? id;
}

function formatReportCell(value: ReportCell) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "number") {
    return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  return value || "—";
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
