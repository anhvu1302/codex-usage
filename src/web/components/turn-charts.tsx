import { Activity, AlertTriangle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import type { TurnContextBucket, TurnCostCoverage, TurnDailyUsage } from "@/shared/types";
import { ChartContainer, type ChartConfig } from "@/web/components/ui/chart";
import { compactTokens, formatTokens, formatUsd } from "@/web/lib/product-api";

type TrendMetric = "cost" | "tokens" | "turns";
const trendConfig = { value: { color: "var(--chart-1)", label: "Giá trị" } } satisfies ChartConfig;
const contextConfig = { count: { color: "var(--chart-4)", label: "Turns" } } satisfies ChartConfig;

export function TurnTrendChart({
  costCoverage,
  data,
  metric,
}: {
  costCoverage: TurnCostCoverage;
  data: TurnDailyUsage[];
  metric: TrendMetric;
}) {
  const values = data.map((item) => ({
    date: item.date.slice(5),
    value:
      metric === "tokens"
        ? item.totalTokens
        : metric === "cost"
          ? item.estimatedCostUsd
          : item.turnCount,
  }));
  if (values.length === 0) return <EmptyState message="Chưa có turn trong khoảng đã chọn." />;
  return (
    <div className="space-y-3">
      {metric === "cost" && costCoverage !== "exact" ? (
        <CoverageNotice
          message={
            costCoverage === "partial"
              ? "Cost trend chỉ gồm phần có price snapshot; đây không phải tổng cost đầy đủ."
              : "Cost của range này chưa có price snapshot nên không được xem là $0 chính xác."
          }
        />
      ) : null}
      <ChartContainer
        aria-label={`Biểu đồ ${metric} theo ngày bắt đầu`}
        config={trendConfig}
        role="img"
      >
        <LineChart accessibilityLayer data={values}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tickLine={false} />
          <YAxis
            tickFormatter={(value: number) =>
              metric === "cost" ? `$${value}` : compactTokens(value)
            }
            tickLine={false}
            width={64}
          />
          <Tooltip
            formatter={(value) =>
              metric === "cost" ? formatUsd(Number(value)) : formatTokens(Number(value))
            }
          />
          <Line
            dataKey="value"
            dot={values.length < 16}
            stroke="var(--color-value)"
            strokeWidth={2.5}
            type="monotone"
          />
        </LineChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Dữ liệu {metric} theo ngày bắt đầu của turn</caption>
        <thead>
          <tr>
            <th>Ngày</th>
            <th>Giá trị</th>
            <th>Cost coverage</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.date}>
              <td>{item.date}</td>
              <td>
                {metric === "tokens"
                  ? item.totalTokens
                  : metric === "cost"
                    ? item.estimatedCostUsd
                    : item.turnCount}
              </td>
              <td>{coverageLabel(item.costCoverage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ContextBucketsChart({ data }: { data: TurnContextBucket[] }) {
  if (data.every((item) => item.count === 0))
    return <EmptyState message="Chưa có metadata context." />;
  return (
    <>
      <ChartContainer
        aria-label="Phân bố context pressure của turn"
        config={contextConfig}
        role="img"
      >
        <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 18 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis allowDecimals={false} type="number" />
          <YAxis dataKey="label" tickLine={false} type="category" width={112} />
          <Tooltip formatter={(value) => [`${formatTokens(Number(value))} turn`, "Số lượng"]} />
          <Bar dataKey="count" fill="var(--color-count)" radius={[0, 5, 5, 0]} />
        </BarChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Dữ liệu phân bố context pressure của turn</caption>
        <thead>
          <tr>
            <th>Nhóm context</th>
            <th>Số turn</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.id}>
              <td>{item.label}</td>
              <td>{item.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function CoverageNotice({ message }: { message: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <p>{message}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <Activity className="size-6 opacity-50" />
      <p>{message}</p>
    </div>
  );
}

function coverageLabel(coverage: TurnCostCoverage): string {
  return coverage === "exact" ? "Đầy đủ" : coverage === "partial" ? "Một phần" : "Không có";
}
