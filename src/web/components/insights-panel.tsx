import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Gauge,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/web/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Skeleton } from "@/web/components/ui/skeleton";
import { formatPercent, formatTokens, formatUsd } from "@/web/lib/product-api";
import type { InsightsResponse, MetricDelta } from "@/shared/types";

export function InsightsPanel({
  data,
  error,
  isLoading,
}: {
  data: InsightsResponse | undefined;
  error: Error | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton aria-label="Đang tải insights" className="h-52" />;
  }
  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="pt-6 text-sm">Không tải được insights: {error.message}</CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const value = data;
  return (
    <section aria-labelledby="insights-heading" className="grid gap-4 xl:grid-cols-5">
      <Card className="overflow-hidden xl:col-span-3">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle id="insights-heading" className="flex items-center gap-2">
              <Sparkles className="text-primary size-4" /> Phân tích
            </CardTitle>
            <CardDescription className="mt-1">
              So với {value.previousRange.from} — {value.previousRange.to}, cùng số ngày.
            </CardDescription>
          </div>
          <Badge variant="outline">USD ước tính</Badge>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <DeltaCard
            delta={value.deltas.tokens}
            label="Token"
            value={formatTokens(value.current.totalTokens)}
          />
          <DeltaCard
            delta={value.deltas.cost}
            label="Cost"
            value={formatUsd(value.current.estimatedCostUsd)}
          />
          <DeltaCard
            delta={value.deltas.requests}
            label="Yêu cầu"
            value={formatTokens(value.current.requestCount)}
          />
          <InsightMetric
            label="Trung bình/ngày"
            value={`${formatTokens(value.efficiency.averageTokensPerDay)} token · ${formatUsd(value.efficiency.averageCostPerDay)}`}
          />
          <InsightMetric
            label="Cache / reasoning"
            value={`${formatPercent(value.efficiency.cacheRate * 100)} / ${formatPercent(value.efficiency.reasoningShare * 100)}`}
          />
          <InsightMetric label="Cost/yêu cầu" value={formatUsd(value.efficiency.costPerRequest)} />
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="text-primary size-4" /> Dự báo & tín hiệu
          </CardTitle>
          <CardDescription>Chỉ cảnh báo trong app, không gửi ra ngoài.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SignalRow
            label="Dự phóng tháng"
            value={
              value.monthlyCostProjection === null
                ? "Chọn range trong tháng hiện tại"
                : formatUsd(value.monthlyCostProjection)
            }
          />
          <SignalRow
            label="Model tăng cost mạnh nhất"
            value={
              value.modelCostMover && value.modelCostMover.deltaUsd > 0
                ? `${value.modelCostMover.model} · +${formatUsd(value.modelCostMover.deltaUsd)}`
                : "Không có model tăng cost"
            }
          />
          <SignalRow
            label="Token/session"
            value={formatTokens(value.efficiency.tokensPerSession)}
          />
          <SignalRow
            label="Session bất thường"
            value={
              value.unusualSession
                ? `${value.unusualSession.title ?? value.unusualSession.sessionId} · ${formatTokens(value.unusualSession.totalTokens)} token · ${formatUsd(value.unusualSession.estimatedCostUsd)}`
                : "Không phát hiện"
            }
          />
          {value.anomalies.length > 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4 text-amber-600" /> {value.anomalies.length} tín
                hiệu bất thường
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {value.anomalies
                  .slice(0, 3)
                  .map((alert) => `${alert.date} (${alert.kind})`)
                  .join(", ")}
              </p>
            </div>
          ) : (
            <div className="bg-muted/60 rounded-lg p-3 text-sm">
              <Gauge className="mr-2 inline size-4 text-emerald-600" /> Không phát hiện bất thường
              đủ điều kiện.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DeltaCard({ delta, label, value }: { delta: MetricDelta; label: string; value: string }) {
  const up = delta.absolute > 0;
  const down = delta.absolute < 0;
  return (
    <div className="bg-muted/55 rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 truncate font-semibold tabular-nums">{value}</p>
      <p
        className={`mt-1 flex items-center gap-1 text-xs ${up ? "text-amber-600" : down ? "text-emerald-600" : "text-muted-foreground"}`}
      >
        {up ? (
          <ArrowUpRight className="size-3" />
        ) : down ? (
          <ArrowDownRight className="size-3" />
        ) : null}
        {delta.percent === null
          ? "Không có baseline"
          : `${delta.percent > 0 ? "+" : ""}${formatPercent(delta.percent * 100)}`}
      </p>
    </div>
  );
}

function InsightMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <strong className="max-w-[60%] text-right tabular-nums">{value}</strong>
    </div>
  );
}
