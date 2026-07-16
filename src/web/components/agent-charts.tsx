import { Sparkles } from "lucide-react";
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AgentsSummaryResponse, DashboardKpis } from "@/shared/types";
import { ChartContainer, type ChartConfig } from "@/web/components/ui/chart";
import { compactTokens, formatPercent, formatTokens, formatUsd } from "@/web/lib/product-api";

const trendConfig = {
  main: { color: "var(--chart-1)", label: "Main agent" },
  subagent: { color: "var(--chart-4)", label: "Subagent" },
} satisfies ChartConfig;

export function AgentDonut({
  main,
  subagent,
}: {
  main: DashboardKpis | undefined;
  subagent: DashboardKpis | undefined;
}) {
  const data = [
    { name: "Main agent", value: main?.totalTokens ?? 0, cost: main?.estimatedCostUsd ?? 0 },
    { name: "Subagent", value: subagent?.totalTokens ?? 0, cost: subagent?.estimatedCostUsd ?? 0 },
  ];
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <EmptyChart />;
  return (
    <div className="grid items-center gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      <ChartContainer
        className="mx-auto h-56 w-full"
        config={trendConfig}
        role="img"
        aria-label="Biểu đồ tỷ trọng token main agent và subagent"
      >
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius={58}
            nameKey="name"
            outerRadius={88}
            paddingAngle={2}
          >
            {data.map((item, index) => (
              <Cell key={item.name} fill={index === 0 ? "var(--chart-1)" : "var(--chart-4)"} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatTokens(Number(value))} />
        </PieChart>
      </ChartContainer>
      <div className="space-y-3">
        {data.map((item, index) => (
          <div key={item.name} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: index === 0 ? "var(--chart-1)" : "var(--chart-4)" }}
              />
              {item.name}
            </span>
            <span className="text-right">
              <strong className="block">{formatPercent(safeRatio(item.value, total) * 100)}</strong>
              <span className="text-muted-foreground text-xs">
                {compactTokens(item.value)} · {formatUsd(item.cost)}
              </span>
            </span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Phân bổ token theo loại agent</caption>
        <tbody>
          {data.map((item) => (
            <tr key={item.name}>
              <th>{item.name}</th>
              <td>{item.value}</td>
              <td>{item.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentTrend({
  data: source,
  metric,
}: {
  data: AgentsSummaryResponse["daily"];
  metric: "cost" | "tokens";
}) {
  const data = source.map((item) => ({
    date: item.date,
    main: metric === "tokens" ? item.main.totalTokens : item.main.estimatedCostUsd,
    subagent: metric === "tokens" ? item.subagent.totalTokens : item.subagent.estimatedCostUsd,
  }));
  if (data.length === 0) return <EmptyChart />;
  return (
    <>
      <ChartContainer
        config={trendConfig}
        role="img"
        aria-label={`Xu hướng ${metric === "tokens" ? "token" : "cost"} main agent và subagent`}
      >
        <LineChart data={data} margin={{ left: 5, right: 5, top: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={
              metric === "tokens" ? compactTokens : (value: number) => `$${value.toFixed(0)}`
            }
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            formatter={(value) =>
              metric === "tokens" ? formatTokens(Number(value)) : formatUsd(Number(value))
            }
          />
          <Line
            dataKey="main"
            dot={false}
            name="Main agent"
            stroke="var(--chart-1)"
            strokeWidth={2}
            type="monotone"
          />
          <Line
            dataKey="subagent"
            dot={false}
            name="Subagent"
            stroke="var(--chart-4)"
            strokeWidth={2}
            type="monotone"
          />
        </LineChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>Xu hướng agent theo ngày</caption>
        <thead>
          <tr>
            <th>Ngày</th>
            <th>Main</th>
            <th>Subagent</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.date}>
              <td>{item.date}</td>
              <td>{item.main}</td>
              <td>{item.subagent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-64 items-center justify-center rounded-lg border border-dashed text-sm">
      <Sparkles className="mr-2 size-4" /> Chưa có dữ liệu.
    </div>
  );
}

function safeRatio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}
