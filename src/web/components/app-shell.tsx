import {
  Activity,
  BarChart3,
  Bot,
  Compass,
  FolderKanban,
  Gauge,
  ListRestart,
  ListTree,
  Menu,
  MoonStar,
  Settings2,
  SunMedium,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type SVGProps,
} from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { NotificationCenter } from "@/web/components/alerts";
import { Button } from "@/web/components/ui/button";
import {
  usePreferences,
  type DensityPreference,
  type ThemePreference,
  type ThemeRevealOrigin,
} from "@/web/lib/preferences";
import { cn } from "@/web/lib/utils";
import { prefetchPrimaryQuery, preloadRoute } from "@/web/lib/route-prefetch";

type NavigationItem = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  to: string;
};

const navigation: NavigationItem[] = [
  { icon: Gauge, label: "Tổng quan", to: "/" },
  { icon: Compass, label: "Khám phá", to: "/explore" },
  { icon: ListTree, label: "Phiên", to: "/sessions" },
  { icon: ListRestart, label: "Turns", to: "/turns" },
  { icon: FolderKanban, label: "Dự án", to: "/projects" },
  { icon: Bot, label: "Agent", to: "/agents" },
  { icon: Activity, label: "Hoạt động", to: "/activity" },
  { icon: Settings2, label: "Cài đặt", to: "/settings" },
];

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktop = useSyncExternalStore(subscribeDesktopShell, desktopShellSnapshot, () => false);

  return (
    <div className="app-shell min-h-screen">
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground fixed -top-20 left-3 z-[70] rounded-md px-3 py-2 text-sm font-medium transition-[top] focus:top-3"
      >
        Bỏ qua điều hướng
      </a>

      <aside className="bg-card/88 fixed inset-y-0 left-0 z-40 hidden w-64 border-r backdrop-blur-xl lg:flex lg:flex-col">
        <div className="flex items-center justify-between px-5 py-6">
          <Brand />
          {desktop ? <NotificationCenter /> : null}
        </div>
        <Navigation className="flex-1 overflow-y-auto px-3" />
        <Preferences className="border-t p-4" />
      </aside>

      <header className="bg-background/88 fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b px-4 backdrop-blur-xl lg:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          {!desktop ? <NotificationCenter /> : null}
          <Button
            aria-label="Mở menu điều hướng"
            size="icon"
            variant="outline"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
        </div>
      </header>

      {mobileOpen ? <MobileNavigationDialog onClose={() => setMobileOpen(false)} /> : null}

      <main id="main-content" className="relative z-10 pt-20 lg:ml-64 lg:pt-0">
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function MobileNavigationDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="mobile-navigation-title"
      className="bg-background fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(21rem,88vw)] max-w-none border-0 border-r p-0 shadow-xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b p-5 text-left">
          <div>
            <h2 id="mobile-navigation-title" className="font-semibold">
              Codex Usage
            </h2>
            <p className="text-muted-foreground text-sm">Điều hướng dashboard</p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Đóng menu"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>
        <Navigation className="flex-1 overflow-y-auto p-3" onNavigate={onClose} />
        <Preferences className="border-t p-4" />
      </div>
    </dialog>
  );
}

function Brand({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="brand-mark bg-primary text-primary-foreground rounded-xl p-2">
        <BarChart3 className="size-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold">Codex Usage</p>
        <p className="text-muted-foreground truncate text-xs">Phân tích token cục bộ</p>
      </div>
    </div>
  );
}

function Navigation({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const location = useLocation();
  const queryClient = useQueryClient();

  return (
    <nav aria-label="Điều hướng chính" className={cn("space-y-1", className)}>
      {navigation.map((item) => {
        const Icon = item.icon;
        const prefetch = () => {
          preloadRoute(item.to);
          void prefetchPrimaryQuery(queryClient, item.to, new URLSearchParams(location.search));
        };
        return (
          <NavLink
            key={item.to}
            end={item.to === "/"}
            to={{ pathname: item.to, search: location.search }}
            onClick={onNavigate}
            onFocus={prefetch}
            onPointerEnter={prefetch}
            className={({ isActive }) =>
              cn(
                "focus-visible:ring-ring group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-[background-color,color,transform] outline-none focus-visible:ring-2",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground hover:translate-x-0.5",
              )
            }
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Preferences({ className }: { className?: string }) {
  const { density, setDensity, setTheme, theme } = usePreferences();
  const themeSelect = useRef<HTMLSelectElement>(null);

  return (
    <div className={cn("grid gap-3", className)}>
      <div className="space-y-1.5">
        <label htmlFor="shell-theme" className="text-muted-foreground text-xs font-medium">
          Giao diện
        </label>
        <div className="relative">
          <SunMedium
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <select
            id="shell-theme"
            ref={themeSelect}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full appearance-none rounded-md border py-1 pr-8 pl-9 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
            value={theme}
            onChange={(event) => {
              const nextTheme = event.target.value as ThemePreference;
              setTheme(nextTheme, centerOf(themeSelect.current));
            }}
          >
            <option value="system">Theo hệ thống</option>
            <option value="light">Sáng</option>
            <option value="dark">Tối</option>
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="shell-density" className="text-muted-foreground text-xs font-medium">
          Mật độ
        </label>
        <div className="relative">
          <MoonStar
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <select
            id="shell-density"
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full appearance-none rounded-md border py-1 pr-8 pl-9 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
            value={density}
            onChange={(event) => setDensity(event.target.value as DensityPreference)}
          >
            <option value="comfortable">Thoải mái</option>
            <option value="compact">Gọn</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function subscribeDesktopShell(callback: () => void): () => void {
  const media = window.matchMedia("(min-width: 1024px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function desktopShellSnapshot(): boolean {
  return window.matchMedia("(min-width: 1024px)").matches;
}

function centerOf(element: HTMLElement | null): ThemeRevealOrigin | undefined {
  const bounds = element?.getBoundingClientRect();
  return bounds
    ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    : undefined;
}
