import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import { ChartContainer, type ChartConfig } from "@/web/components/ui/chart";

type TrendPoint = Record<string, number | string> & { date: string };
type TrendSeries = { color: string; id: string; label: string };

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

export function ActivityTrendChart({
  ariaLabel,
  points,
  series,
}: {
  ariaLabel: string;
  points: TrendPoint[];
  series: TrendSeries[];
}) {
  const config = Object.fromEntries(
    series.map((item) => [item.id, { color: item.color, label: item.label }]),
  ) satisfies ChartConfig;
  return (
    <ChartContainer aria-label={ariaLabel} className="h-72" config={config} role="img">
      <LineChart data={points} margin={{ left: 2, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="date"
          tickFormatter={(value: string) => value.slice(5)}
          tickLine={false}
        />
        <YAxis
          axisLine={false}
          tickFormatter={(value: number) => COMPACT_FORMATTER.format(value)}
          tickLine={false}
          width={42}
        />
        <Tooltip formatter={(value) => INTEGER_FORMATTER.format(Number(value))} />
        {series.map((item) => (
          <Line
            key={item.id}
            dataKey={item.id}
            dot={false}
            name={item.label}
            stroke={item.color}
            strokeWidth={2}
            type="monotone"
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
