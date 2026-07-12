import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BarChart3, Settings2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { DashboardView } from "@/web/components/dashboard-view";
import { Toaster } from "@/web/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/components/ui/tabs";

const RateSettings = lazy(async () => ({
  default: (await import("@/web/components/rate-settings")).RateSettings,
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
      <Toaster />
    </QueryClientProvider>
  );
}

function AppContent() {
  const [tab, setTab] = useState("dashboard");

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_right,_oklch(0.93_0.04_258),_transparent_34rem)]">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="bg-primary text-primary-foreground rounded-xl p-2">
                <BarChart3 className="size-5" />
              </div>
              <div>
                <p className="font-semibold">Codex Usage</p>
                <p className="text-muted-foreground text-sm">Local token analytics</p>
              </div>
            </div>
            <TabsList>
              <TabsTrigger value="dashboard">
                <BarChart3 className="mr-1.5 size-3.5" />
                Dashboard
              </TabsTrigger>
              <TabsTrigger value="rates">
                <Settings2 className="mr-1.5 size-3.5" />
                Rate cards
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="dashboard">
            <DashboardView />
          </TabsContent>
          <TabsContent value="rates">
            <Suspense fallback={<RateSettingsSkeleton />}>
              <RateSettings />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function RateSettingsSkeleton() {
  return <div className="bg-muted h-72 animate-pulse rounded-xl" />;
}
