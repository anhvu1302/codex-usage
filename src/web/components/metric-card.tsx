import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/web/components/ui/card";

type MetricCardProps = {
  detail?: string;
  icon: ReactNode;
  label: string;
  trend?: string | null;
  value: string;
};

export function MetricCard({ detail, icon, label, trend, value }: MetricCardProps) {
  return (
    <Card className="metric-card group">
      <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        <span className="metric-card-icon text-muted-foreground rounded-lg p-1.5">{icon}</span>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
        <p
          key={value}
          className="metric-value text-xl font-bold tracking-tight tabular-nums sm:text-2xl"
        >
          {value}
        </p>
        {detail || trend ? (
          <div className="text-muted-foreground mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>{detail}</span>
            {trend ? (
              <span
                className={
                  trend.startsWith("+")
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-emerald-600 dark:text-emerald-400"
                }
              >
                {trend} kỳ trước
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
