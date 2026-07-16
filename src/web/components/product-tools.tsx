import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, LoaderCircle, RotateCcw, TriangleAlert, WalletCards } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import type {
  BudgetPeriod,
  BudgetSetting,
  DashboardFilters,
  ModelRate,
  PricingSimulationRequest,
  PricingSimulationResponse,
} from "@/shared/types";
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
import { Skeleton } from "@/web/components/ui/skeleton";
import { queueLiveMutationScopes } from "@/web/lib/live-events";
import {
  fetchBudgets,
  fetchPricingModels,
  runPricingSimulation,
  saveBudget,
} from "@/web/lib/product-api";

type RateDraft = {
  cachedInputRate: string;
  inputRate: string;
  model: string;
  outputRate: string;
};

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

export function BudgetSettings() {
  const budgets = useQuery({
    queryKey: ["budgets"],
    queryFn: ({ signal }) => fetchBudgets(signal),
    staleTime: 5 * 60_000,
  });

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
      queryClient.setQueryData<{ budgets: BudgetSetting[] }>(["budgets"], (current) => ({
        budgets: [
          ...(current?.budgets.filter((item) => item.period !== payload.budget.period) ?? []),
          payload.budget,
        ],
      }));
      queueLiveMutationScopes(queryClient, ["alerts", "budgets"]);
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
  const pricing = useQuery({
    queryKey: ["pricing-models"],
    queryFn: ({ signal }) => fetchPricingModels(signal),
    staleTime: 5 * 60_000,
  });
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

function periodLabel(period: BudgetPeriod) {
  return period === "daily" ? "Hàng ngày" : "Hàng tháng";
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

function formatUsd(value: number) {
  return USD_FORMATTER.format(value);
}
