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
} from "lucide-react";
import { useRef, useState, type ComponentType, type SVGProps } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Button } from "@/web/components/ui/button";
import { NotificationCenter } from "@/web/components/product-tools";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/web/components/ui/sheet";
import {
  usePreferences,
  type DensityPreference,
  type ThemePreference,
  type ThemeRevealOrigin,
} from "@/web/lib/preferences";
import { cn } from "@/web/lib/utils";

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
          <NotificationCenter />
        </div>
        <Navigation className="flex-1 overflow-y-auto px-3" />
        <Preferences className="border-t p-4" />
      </aside>

      <header className="bg-background/88 fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b px-4 backdrop-blur-xl lg:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          <NotificationCenter />
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

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[min(21rem,88vw)] p-0 sm:max-w-sm">
          <SheetHeader className="border-b p-5 text-left">
            <SheetTitle>Codex Usage</SheetTitle>
            <SheetDescription>Điều hướng dashboard</SheetDescription>
          </SheetHeader>
          <Navigation
            className="flex-1 overflow-y-auto p-3"
            onNavigate={() => setMobileOpen(false)}
          />
          <Preferences className="border-t p-4" />
        </SheetContent>
      </Sheet>

      <main id="main-content" className="relative z-10 pt-20 lg:ml-64 lg:pt-0">
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-10 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
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

  return (
    <nav aria-label="Điều hướng chính" className={cn("space-y-1", className)}>
      {navigation.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            end={item.to === "/"}
            to={{ pathname: item.to, search: location.search }}
            onClick={onNavigate}
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
  const [themeOpen, setThemeOpen] = useState(false);
  const pendingTheme = useRef<ThemePreference | null>(null);
  const themeOrigin = useRef<ThemeRevealOrigin | undefined>(undefined);
  const themeTrigger = useRef<HTMLButtonElement>(null);

  function handleThemeOpenChange(open: boolean) {
    setThemeOpen(open);
    if (open) {
      themeOrigin.current = centerOf(themeTrigger.current);
      return;
    }
    if (pendingTheme.current === null) return;
    const nextTheme = pendingTheme.current;
    pendingTheme.current = null;
    const origin = themeOrigin.current ?? centerOf(themeTrigger.current);
    themeOrigin.current = undefined;
    window.requestAnimationFrame(() => setTheme(nextTheme, origin));
  }

  return (
    <div className={cn("grid gap-3", className)}>
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">Giao diện</p>
        <Select
          open={themeOpen}
          value={theme}
          onOpenChange={handleThemeOpenChange}
          onValueChange={(value) => {
            pendingTheme.current = value as ThemePreference;
          }}
        >
          <SelectTrigger ref={themeTrigger} aria-label="Giao diện" className="w-full">
            <SunMedium className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">Theo hệ thống</SelectItem>
            <SelectItem value="light">Sáng</SelectItem>
            <SelectItem value="dark">Tối</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">Mật độ</p>
        <Select value={density} onValueChange={(value) => setDensity(value as DensityPreference)}>
          <SelectTrigger aria-label="Mật độ" className="w-full">
            <MoonStar className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">Thoải mái</SelectItem>
            <SelectItem value="compact">Gọn</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function centerOf(element: HTMLElement | null): ThemeRevealOrigin | undefined {
  const bounds = element?.getBoundingClientRect();
  return bounds
    ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    : undefined;
}
