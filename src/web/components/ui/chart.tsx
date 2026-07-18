import type { ComponentProps } from "react";
import { ResponsiveContainer } from "recharts";

import { cn } from "@/web/lib/utils";

export type ChartConfig = Record<string, { color?: string; label?: string }>;

function ChartContainer({
  children,
  className,
  config,
  ...props
}: ComponentProps<"div"> & { config: ChartConfig }) {
  const variables = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      value.color ? [[`--color-${key}`, value.color]] : [],
    ),
  );
  return (
    <div
      data-slot="chart"
      className={cn(
        "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground h-72 w-full text-xs",
        className,
      )}
      style={variables}
      {...props}
    >
      <ResponsiveContainer minHeight={288} minWidth={0}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

export { ChartContainer };
