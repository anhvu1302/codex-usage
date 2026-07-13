import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/web/components/ui/card";

type MetricCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
};

export function MetricCard({ icon, label, value }: MetricCardProps) {
  return (
    <Card className="metric-card group">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        <span className="metric-card-icon text-muted-foreground rounded-lg p-1.5">{icon}</span>
      </CardHeader>
      <CardContent>
        <p key={value} className="metric-value text-2xl font-bold tracking-tight">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
