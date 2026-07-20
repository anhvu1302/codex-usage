import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { ExportActions } from "@/web/components/export-actions";
import { NotificationSettings } from "@/web/components/notification-settings";
import { BudgetSettings, PricingSimulator } from "@/web/components/product-tools";
import { RateSettings } from "@/web/components/rate-settings";
import { ReportBuilder } from "@/web/components/report-builder";
import { TagSettings } from "@/web/components/tag-settings";
import { filtersFromSearch } from "@/web/lib/product-api";

export function SettingsPage() {
  const [search] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(search), [search]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Cài đặt</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Quản lý rate card, lưu trữ và tuỳ chọn hiển thị.
        </p>
      </header>
      <RateSettings />
      <NotificationSettings />
      <TagSettings />
      <BudgetSettings filters={filters} />
      <PricingSimulator filters={filters} />
      <ReportBuilder filters={filters} />
      <ExportActions filters={filters} />
    </div>
  );
}
