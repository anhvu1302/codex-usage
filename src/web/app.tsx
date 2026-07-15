import {
  QueryClient,
  QueryClientProvider,
  useIsFetching,
  useIsMutating,
} from "@tanstack/react-query";
import { lazy, Suspense, useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router";

import { AppShell } from "@/web/components/app-shell";
import { BudgetSettings, ExportActions, PricingSimulator } from "@/web/components/product-tools";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Toaster } from "@/web/components/ui/sonner";
import { filtersFromSearch } from "@/web/lib/product-api";
import { PreferencesProvider } from "@/web/lib/preferences";

const DashboardView = lazy(async () => ({
  default: (await import("@/web/components/dashboard-view")).DashboardView,
}));
const RateSettings = lazy(async () => ({
  default: (await import("@/web/components/rate-settings")).RateSettings,
}));
const ProjectsPage = lazy(async () => ({
  default: (await import("@/web/components/projects-page")).ProjectsPage,
}));
const AgentsPage = lazy(async () => ({
  default: (await import("@/web/components/agents-page")).AgentsPage,
}));
const ActivityPage = lazy(async () => ({
  default: (await import("@/web/components/activity-page")).ActivityPage,
}));
const TurnsPage = lazy(async () => ({
  default: (await import("@/web/components/turns-page")).TurnsPage,
}));
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      placeholderData: (previousData: unknown) => previousData,
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

export function App() {
  return (
    <PreferencesProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <QueryProgress />
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardRoute mode="overview" />} />
              <Route path="explore" element={<DashboardRoute mode="explore" />} />
              <Route path="sessions" element={<DashboardRoute mode="sessions" />} />
              <Route
                path="turns/*"
                element={
                  <LazyPage>
                    <TurnsPage />
                  </LazyPage>
                }
              />
              <Route
                path="projects"
                element={
                  <LazyPage>
                    <ProjectsPage />
                  </LazyPage>
                }
              />
              <Route
                path="agents"
                element={
                  <LazyPage>
                    <AgentsPage />
                  </LazyPage>
                }
              />
              <Route
                path="activity"
                element={
                  <LazyPage>
                    <ActivityPage />
                  </LazyPage>
                }
              />
              <Route path="settings" element={<SettingsRoute />} />
              <Route path="rates" element={<Navigate replace to="/settings" />} />
              <Route path="*" element={<Navigate replace to="/" />} />
            </Route>
          </Routes>
          <Toaster />
        </BrowserRouter>
      </QueryClientProvider>
    </PreferencesProvider>
  );
}

function DashboardRoute({ mode }: { mode: "explore" | "overview" | "sessions" }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <DashboardView mode={mode} />
    </Suspense>
  );
}

function SettingsRoute() {
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
      <Suspense fallback={<PageSkeleton />}>
        <RateSettings />
        <BudgetSettings />
        <PricingSimulator filters={filters} />
        <ExportActions filters={filters} />
      </Suspense>
    </div>
  );
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

function QueryProgress() {
  const pending = useIsFetching() + useIsMutating();
  return (
    <div
      aria-hidden="true"
      className={`query-progress fixed inset-x-0 top-0 z-[80] h-0.5 transition-opacity ${pending > 0 ? "opacity-100" : "opacity-0"}`}
    >
      <div className="bg-primary h-full w-1/3 rounded-r-full" />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-5" aria-label="Đang tải trang">
      <Skeleton className="h-16 w-full max-w-xl" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[420px]" />
    </div>
  );
}
