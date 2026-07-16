import { Sparkles } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";

import type { DailyUsage } from "@/shared/types";
import { ChartContainer, type ChartConfig } from "@/web/components/ui/chart";
import { compactTokens, formatTokens, formatUsd } from "@/web/lib/product-api";

const chartConfig = {
  cost: { color: "var(--chart-2)", label: "Cost" },
  tokens: { color: "var(--chart-1)", label: "Token" },
} satisfies ChartConfig;

export function ProjectTrendChart({ data }: { data: DailyUsage[] }) {
  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-72 items-center justify-center rounded-lg border border-dashed text-sm">
        <Sparkles className="mr-2 size-4" /> Chưa có dữ liệu trend.
      </div>
    );
  }
  return (
    <>
      <ChartContainer
        config={chartConfig}
        role="img"
        aria-label={`Biểu đồ trend project theo ${data.length} ngày`}
      >
        <ComposedChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="tokens"
            tickFormatter={compactTokens}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickFormatter={(value: number) => `$${value.toFixed(0)}`}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            formatter={(value, name) =>
              name === "Token" ? formatTokens(Number(value)) : formatUsd(Number(value))
            }
          />
          <Bar
            dataKey="totalTokens"
            fill="var(--chart-1)"
            name="Token"
            radius={[4, 4, 0, 0]}
            yAxisId="tokens"
          />
          <Line
            dataKey="estimatedCostUsd"
            dot={false}
            name="Cost"
            stroke="var(--chart-2)"
            strokeWidth={2}
            type="monotone"
            yAxisId="cost"
          />
        </ComposedChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Dữ liệu trend project</caption>
        <thead>
          <tr>
            <th>Ngày</th>
            <th>Token</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.date}>
              <td>{item.date}</td>
              <td>{item.totalTokens}</td>
              <td>{item.estimatedCostUsd}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
