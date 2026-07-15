import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellRing,
  Calculator,
  Check,
  Download,
  FileJson,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  WalletCards,
} from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import type {
  AgentFilters,
  AlertEvent,
  BudgetPeriod,
  BudgetSetting,
  DashboardFilters,
  ModelRate,
  PricingSimulationRequest,
  PricingSimulationResponse,
  SessionFilters,
} from "@/shared/types";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/web/components/ui/sheet";
import { Skeleton } from "@/web/components/ui/skeleton";

type ExportDataset = "agents" | "models" | "projects" | "sessions";
type ExportFormat = "csv" | "json";

type RateDraft = {
  cachedInputRate: string;
  inputRate: string;
  model: string;
  outputRate: string;
};

const exportLabels: Record<ExportDataset, string> = {
  agents: "Agent",
  models: "Model",
  projects: "Dự án",
  sessions: "Phiên",
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: fetchAlerts,
    refetchInterval: 60_000,
  });
  const update = useMutation({
    mutationFn: updateAlert,
    onError: (error) => toast.error(error.message),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      if (variables.action === "dismiss") toast.success("Đã ẩn thông báo.");
    },
  });
  const unseen = (alerts.data?.alerts ?? []).filter((alert) => alert.seenAt === null).length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unseen > 0 ? `${unseen} thông báo chưa đọc` : "Thông báo"}
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
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pr-8">
          <SheetTitle className="flex items-center gap-2">
            <BellRing className="text-primary size-5" aria-hidden="true" />
            Trung tâm thông báo
          </SheetTitle>
          <SheetDescription>
            Cảnh báo budget, usage bất thường và sức khoẻ dữ liệu chỉ hiển thị trong app.
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

export function AlertBanner() {
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: fetchAlerts,
    refetchInterval: 60_000,
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

export function BudgetSettings() {
  const budgets = useQuery({ queryKey: ["budgets"], queryFn: fetchBudgets });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WalletCards className="text-primary size-4" aria-hidden="true" />
          Budget và ngưỡng cảnh báo
        </CardTitle>
        <CardDescription>
          Budget mặc định tắt. Khi bật, app chỉ cảnh báo nội bộ và không tự giới hạn usage.
        </CardDescription>
      </CardHeader>
      <CardContent aria-live="polite" aria-busy={budgets.isLoading}>
        {budgets.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-56 rounded-xl" />
          </div>
        ) : null}
        {budgets.isError ? (
          <InlineError message={budgets.error.message} onRetry={() => void budgets.refetch()} />
        ) : null}
        {budgets.data ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {budgets.data.budgets.map((budget) => (
              <BudgetEditor key={budget.period} budget={budget} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BudgetEditor({ budget }: { budget: BudgetSetting }) {
  const enabledId = useId();
  const limitId = useId();
  const thresholdsId = useId();
  const [enabled, setEnabled] = useState(budget.enabled);
  const [limit, setLimit] = useState(String(budget.limitUsd));
  const [thresholds, setThresholds] = useState(budget.warningThresholds.join(", "));
  const [validationError, setValidationError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: saveBudget,
    onError: (error) => toast.error(error.message),
    onSuccess: (payload) => {
      setValidationError(null);
      toast.success(
        `Đã lưu budget ${periodLabel(payload.budget.period).toLocaleLowerCase("vi-VN")}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });

  function submit() {
    const parsedLimit = Number(limit);
    const parsedThresholds = parseThresholds(thresholds);
    if (limit.trim() === "" || !Number.isFinite(parsedLimit) || parsedLimit < 0) {
      setValidationError("Giới hạn phải là số USD lớn hơn hoặc bằng 0.");
      return;
    }
    if (enabled && parsedLimit <= 0) {
      setValidationError("Nhập giới hạn lớn hơn 0 trước khi bật budget.");
      return;
    }
    if (!parsedThresholds) {
      setValidationError("Ngưỡng phải gồm 1–10 số dương, cách nhau bằng dấu phẩy.");
      return;
    }
    save.mutate({
      enabled,
      limitUsd: parsedLimit,
      period: budget.period,
      warningThresholds: parsedThresholds,
    });
  }

  return (
    <section className="bg-muted/25 space-y-5 rounded-xl border p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold">{periodLabel(budget.period)}</h3>
          <p className="text-muted-foreground mt-1 text-xs">Ước tính USD theo rate snapshot.</p>
        </div>
        <label htmlFor={enabledId} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            id={enabledId}
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-primary size-4"
          />
          {enabled ? "Đang bật" : "Đang tắt"}
        </label>
      </div>

      <div className="space-y-2">
        <Label htmlFor={limitId}>Giới hạn USD</Label>
        <Input
          id={limitId}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          aria-describedby={`${limitId}-hint`}
        />
        <p id={`${limitId}-hint`} className="text-muted-foreground text-xs">
          Budget chỉ tạo banner và thông báo; không dừng Codex.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={thresholdsId}>Ngưỡng cảnh báo (%)</Label>
        <Input
          id={thresholdsId}
          value={thresholds}
          placeholder="50, 80, 100"
          onChange={(event) => setThresholds(event.target.value)}
          aria-describedby={`${thresholdsId}-hint`}
        />
        <p id={`${thresholdsId}-hint`} className="text-muted-foreground text-xs">
          Ví dụ: 50, 80, 100. Mỗi ngưỡng chỉ tạo một cảnh báo trong kỳ.
        </p>
      </div>

      {validationError ? (
        <p className="text-destructive text-sm" role="alert">
          {validationError}
        </p>
      ) : null}

      <Button type="button" onClick={submit} disabled={save.isPending} className="w-full sm:w-auto">
        {save.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Lưu budget
      </Button>
    </section>
  );
}

export function PricingSimulator({ filters }: { filters: DashboardFilters }) {
  const pricing = useQuery({ queryKey: ["pricing-models"], queryFn: fetchPricingModels });
  const [draftOverrides, setDraftOverrides] = useState<RateDraft[] | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const simulate = useMutation({
    mutationFn: runPricingSimulation,
    onError: (error) => toast.error(error.message),
  });

  const drafts =
    draftOverrides ??
    (pricing.data ? buildRateDrafts(pricing.data.models, pricing.data.rates) : []);

  function resetRates() {
    if (!pricing.data) return;
    setDraftOverrides(null);
    setValidationError(null);
    simulate.reset();
  }

  function submit() {
    const rates = drafts.map(toSimulationRate);
    if (rates.some((rate) => rate === null)) {
      setValidationError("Mọi rate phải là số lớn hơn hoặc bằng 0.");
      return;
    }
    if (rates.length === 0) {
      setValidationError("Chưa có model để mô phỏng.");
      return;
    }
    setValidationError(null);
    const request: PricingSimulationRequest = {
      ...filters,
      rates: rates.filter((rate): rate is Omit<ModelRate, "updatedAt"> => rate !== null),
    };
    simulate.mutate(request);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Calculator className="text-primary size-4" aria-hidden="true" />
            Pricing Simulator
          </CardTitle>
          <CardDescription className="mt-1">
            Thử rate khác trên usage đang lọc mà không sửa rate card hay cost lịch sử.
          </CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={resetRates}>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Đặt lại
        </Button>
      </CardHeader>
      <CardContent className="space-y-5" aria-live="polite" aria-busy={pricing.isLoading}>
        {pricing.isLoading ? <Skeleton className="h-52 rounded-xl" /> : null}
        {pricing.isError ? (
          <InlineError message={pricing.error.message} onRetry={() => void pricing.refetch()} />
        ) : null}
        {drafts.length > 0 ? (
          <div className="space-y-3">
            {drafts.map((draft, index) => (
              <RateDraftEditor
                key={draft.model}
                draft={draft}
                onChange={(field, value) => {
                  simulate.reset();
                  setDraftOverrides((current) =>
                    (current ?? drafts).map((item, itemIndex) =>
                      itemIndex === index ? updateRateDraft(item, field, value) : item,
                    ),
                  );
                }}
              />
            ))}
          </div>
        ) : null}

        {validationError ? (
          <p className="text-destructive text-sm" role="alert">
            {validationError}
          </p>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            Đơn vị: USD / 1 triệu token. Kết quả là estimated cost.
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={simulate.isPending || drafts.length === 0}
          >
            {simulate.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Tính thử
          </Button>
        </div>

        {simulate.data ? <SimulationResult result={simulate.data} /> : null}
      </CardContent>
    </Card>
  );
}

function RateDraftEditor({
  draft,
  onChange,
}: {
  draft: RateDraft;
  onChange: (field: Exclude<keyof RateDraft, "model">, value: string) => void;
}) {
  const inputId = useId();
  const cachedId = useId();
  const outputId = useId();

  return (
    <fieldset className="bg-muted/20 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">{draft.model}</legend>
      <div className="mt-1 grid gap-3 sm:grid-cols-3">
        <RateInput
          id={inputId}
          label="Input"
          value={draft.inputRate}
          onChange={(value) => onChange("inputRate", value)}
        />
        <RateInput
          id={cachedId}
          label="Cached input"
          value={draft.cachedInputRate}
          onChange={(value) => onChange("cachedInputRate", value)}
        />
        <RateInput
          id={outputId}
          label="Output"
          value={draft.outputRate}
          onChange={(value) => onChange("outputRate", value)}
        />
      </div>
    </fieldset>
  );
}

function RateInput({
  id,
  label,
  onChange,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SimulationResult({ result }: { result: PricingSimulationResponse }) {
  const deltaPositive = result.deltaUsd > 0;
  return (
    <section className="bg-primary/5 rounded-xl border p-4" aria-label="Kết quả mô phỏng giá">
      <div className="grid gap-4 sm:grid-cols-3">
        <ResultMetric label="Cost hiện tại" value={formatUsd(result.currentCostUsd)} />
        <ResultMetric label="Cost mô phỏng" value={formatUsd(result.simulatedCostUsd)} />
        <ResultMetric
          label="Chênh lệch"
          value={`${result.deltaUsd > 0 ? "+" : ""}${formatUsd(result.deltaUsd)}`}
          tone={deltaPositive ? "danger" : result.deltaUsd < 0 ? "success" : "neutral"}
        />
      </div>
    </section>
  );
}

function ResultMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "danger" | "neutral" | "success";
  value: string;
}) {
  const toneClass =
    tone === "danger" ? "text-destructive" : tone === "success" ? "text-emerald-600" : "";
  return (
    <div>
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

type ExportFilters = AgentFilters & SessionFilters;

export function ExportActions({ filters }: { filters: ExportFilters }) {
  const [dataset, setDataset] = useState<ExportDataset>("models");
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
          File dùng chính xác khoảng ngày, model, project và loại agent đang được lọc.
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
                {(Object.entries(exportLabels) as [ExportDataset, string][]).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
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

function periodLabel(period: BudgetPeriod) {
  return period === "daily" ? "Hàng ngày" : "Hàng tháng";
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
  }
}

function parseThresholds(value: string): number[] | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = [...new Set(parts.map(Number))].sort((left, right) => left - right);
  if (
    values.length === 0 ||
    values.length > 10 ||
    values.some((threshold) => !Number.isFinite(threshold) || threshold <= 0 || threshold > 1_000)
  ) {
    return null;
  }
  return values;
}

function buildRateDrafts(models: string[], rates: ModelRate[]): RateDraft[] {
  const byModel = new Map(rates.map((rate) => [rate.model, rate]));
  return [...new Set([...models, ...byModel.keys()])].sort().map((model) => {
    const rate = byModel.get(model);
    return {
      cachedInputRate: String(rate?.cachedInputRate ?? 0),
      inputRate: String(rate?.inputRate ?? 0),
      model,
      outputRate: String(rate?.outputRate ?? 0),
    };
  });
}

function updateRateDraft(
  draft: RateDraft,
  field: Exclude<keyof RateDraft, "model">,
  value: string,
): RateDraft {
  switch (field) {
    case "cachedInputRate":
      return { ...draft, cachedInputRate: value };
    case "inputRate":
      return { ...draft, inputRate: value };
    case "outputRate":
      return { ...draft, outputRate: value };
  }
}

function toSimulationRate(draft: RateDraft): Omit<ModelRate, "updatedAt"> | null {
  if (
    draft.cachedInputRate.trim() === "" ||
    draft.inputRate.trim() === "" ||
    draft.outputRate.trim() === ""
  ) {
    return null;
  }
  const cachedInputRate = Number(draft.cachedInputRate);
  const inputRate = Number(draft.inputRate);
  const outputRate = Number(draft.outputRate);
  if (
    !Number.isFinite(cachedInputRate) ||
    !Number.isFinite(inputRate) ||
    !Number.isFinite(outputRate) ||
    cachedInputRate < 0 ||
    inputRate < 0 ||
    outputRate < 0
  ) {
    return null;
  }
  return { cachedInputRate, inputRate, model: draft.model, outputRate };
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function dashboardQuery(filters: ExportFilters) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  if (models.length > 0) query.set("models", models.join(","));
  if (filters.projectId) query.set("project", filters.projectId);
  if (filters.agentKind && filters.agentKind !== "all") {
    query.set("agentKind", filters.agentKind);
  }
  if (filters.depth !== undefined) query.set("depth", String(filters.depth));
  if (filters.role) query.set("role", filters.role);
  if (filters.hasSubagents !== undefined) {
    query.set("hasSubagents", String(filters.hasSubagents));
  }
  if (filters.query) query.set("q", filters.query);
  if (filters.order) query.set("order", filters.order);
  if (filters.sort) query.set("sort", filters.sort);
  return query;
}

async function fetchAlerts() {
  return request<{ alerts: AlertEvent[] }>("/api/alerts");
}

async function updateAlert({ action, id }: { action: "dismiss" | "seen"; id: string }) {
  return request<{ alert: AlertEvent }>(`/api/alerts/${encodeURIComponent(id)}`, {
    body: JSON.stringify({ action }),
    method: "PATCH",
  });
}

async function fetchBudgets() {
  return request<{ budgets: BudgetSetting[] }>("/api/budgets");
}

async function saveBudget(budget: Omit<BudgetSetting, "updatedAt">) {
  return request<{ budget: BudgetSetting }>("/api/budgets", {
    body: JSON.stringify(budget),
    method: "PUT",
  });
}

async function fetchPricingModels() {
  const [models, rates] = await Promise.all([
    request<{ models: string[] }>("/api/models"),
    request<{ rates: ModelRate[] }>("/api/rates"),
  ]);
  return { models: models.models, rates: rates.rates };
}

async function runPricingSimulation(payload: PricingSimulationRequest) {
  return request<PricingSimulationResponse>("/api/pricing/simulate", {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

async function downloadExport(
  dataset: ExportDataset,
  format: ExportFormat,
  filters: ExportFilters,
) {
  const query = dashboardQuery(filters);
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
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
