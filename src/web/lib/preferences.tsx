import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "dark" | "light" | "system";
export type DensityPreference = "comfortable" | "compact";
export type ThemeRevealOrigin = { x: number; y: number };

type PreferencesContextValue = {
  density: DensityPreference;
  setDensity: (density: DensityPreference) => void;
  setTheme: (theme: ThemePreference, origin?: ThemeRevealOrigin) => void;
  theme: ThemePreference;
};

const THEME_KEY = "codex-usage-theme";
const DENSITY_KEY = "codex-usage-density";
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readTheme);
  const [density, setDensity] = useState<DensityPreference>(readDensity);
  const activeTransition = useRef<ViewTransition | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyPreferences(theme, density, media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [density, theme]);

  useEffect(() => writePreference(THEME_KEY, theme), [theme]);
  useEffect(() => writePreference(DENSITY_KEY, density), [density]);

  const setTheme = useCallback(
    (nextTheme: ThemePreference, origin?: ThemeRevealOrigin) => {
      const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const currentResolved = resolveIsDark(theme, systemIsDark);
      const nextResolved = resolveIsDark(nextTheme, systemIsDark);
      const commit = () => {
        applyPreferences(nextTheme, density, systemIsDark);
        setThemeState(nextTheme);
      };
      const shouldAnimate =
        origin !== undefined &&
        currentResolved !== nextResolved &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
        typeof document.startViewTransition === "function";

      if (!shouldAnimate) {
        commit();
        return;
      }

      activeTransition.current?.skipTransition();
      try {
        document.documentElement.style.setProperty("--theme-reveal-x", `${origin.x}px`);
        document.documentElement.style.setProperty("--theme-reveal-y", `${origin.y}px`);
        const transition = document.startViewTransition(commit);
        activeTransition.current = transition;
        const radius = Math.hypot(
          Math.max(origin.x, window.innerWidth - origin.x),
          Math.max(origin.y, window.innerHeight - origin.y),
        );
        void transition.ready
          .then(() =>
            document.documentElement.animate(
              {
                clipPath: [
                  "circle(0px at var(--theme-reveal-x) var(--theme-reveal-y))",
                  `circle(${radius}px at var(--theme-reveal-x) var(--theme-reveal-y))`,
                ],
              },
              {
                // A strongly front-loaded ease makes the radius cover most of the
                // viewport immediately, then appear to stall near the far edge.
                // Keep radial velocity constant so dense dashboard snapshots reveal
                // continuously instead of pausing halfway through the page.
                duration: 360,
                easing: "linear",
                pseudoElement: "::view-transition-new(root)",
              },
            ),
          )
          .catch(() => undefined);
        void transition.finished.finally(() => {
          if (activeTransition.current === transition) activeTransition.current = null;
        });
      } catch {
        commit();
      }
    },
    [density, theme],
  );

  const value = useMemo(
    () => ({ density, setDensity, setTheme, theme }),
    [density, setTheme, theme],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used within PreferencesProvider");
  return value;
}

export function initializePreferences(): void {
  applyPreferences(
    readTheme(),
    readDensity(),
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

function readTheme(): ThemePreference {
  const value = readPreference(THEME_KEY);
  return value === "dark" || value === "light" ? value : "system";
}

function readDensity(): DensityPreference {
  return readPreference(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences are optional when storage is unavailable or blocked.
  }
}

function applyPreferences(
  theme: ThemePreference,
  density: DensityPreference,
  systemIsDark: boolean,
): void {
  const root = document.documentElement;
  const isDark = resolveIsDark(theme, systemIsDark);
  root.classList.toggle("dark", isDark);
  root.dataset["density"] = density;
  root.style.colorScheme = isDark ? "dark" : "light";
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", isDark ? "#171b26" : "#f7f9fc");
}

function resolveIsDark(theme: ThemePreference, systemIsDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemIsDark);
}
