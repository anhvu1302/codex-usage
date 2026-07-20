import {
  QueryClient,
  QueryClientProvider,
  useIsFetching,
  useIsMutating,
} from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AppShell } from "@/web/components/app-shell";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Toaster } from "@/web/components/ui/sonner";
import { BrowserNotificationsProvider } from "@/web/lib/browser-notifications";
import { LiveEvents } from "@/web/lib/live-events";
import { PreferencesProvider } from "@/web/lib/preferences";
import { SavedViewsProvider } from "@/web/lib/saved-views";
import {
  loadActivityPage,
  loadAgentsPage,
  loadDashboardView,
  loadProjectsPage,
  loadSessionsPage,
  loadSettingsPage,
  loadTurnsPage,
} from "@/web/lib/route-prefetch";

const DashboardView = lazy(async () => ({
  default: (await loadDashboardView()).DashboardView,
}));
const SessionsPage = lazy(async () => ({
  default: (await loadSessionsPage()).SessionsPage,
}));
const SettingsPage = lazy(async () => ({
  default: (await loadSettingsPage()).SettingsPage,
}));
const ProjectsPage = lazy(async () => ({
  default: (await loadProjectsPage()).ProjectsPage,
}));
const AgentsPage = lazy(async () => ({
  default: (await loadAgentsPage()).AgentsPage,
}));
const ActivityPage = lazy(async () => ({
  default: (await loadActivityPage()).ActivityPage,
}));
const TurnsPage = lazy(async () => ({
  default: (await loadTurnsPage()).TurnsPage,
}));
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      placeholderData: (previousData: unknown) => previousData,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

export function App() {
  return (
    <PreferencesProvider>
      <BrowserNotificationsProvider>
        <SavedViewsProvider>
          <QueryClientProvider client={queryClient}>
            <LiveEvents />
            <BrowserRouter>
              <QueryProgress />
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<DashboardRoute mode="overview" />} />
                  <Route path="explore" element={<DashboardRoute mode="explore" />} />
                  <Route
                    path="sessions"
                    element={
                      <LazyPage>
                        <SessionsPage />
                      </LazyPage>
                    }
                  />
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
                  <Route
                    path="settings"
                    element={
                      <LazyPage>
                        <SettingsPage />
                      </LazyPage>
                    }
                  />
                  <Route path="rates" element={<Navigate replace to="/settings" />} />
                  <Route path="*" element={<Navigate replace to="/" />} />
                </Route>
              </Routes>
              <Toaster />
            </BrowserRouter>
          </QueryClientProvider>
        </SavedViewsProvider>
      </BrowserNotificationsProvider>
    </PreferencesProvider>
  );
}

function DashboardRoute({ mode }: { mode: "explore" | "overview" }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <DashboardView mode={mode} />
    </Suspense>
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
      <div className="grid gap-3 min-[360px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[420px]" />
    </div>
  );
}
