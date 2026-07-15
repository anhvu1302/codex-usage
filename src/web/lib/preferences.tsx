import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "dark" | "light" | "system";
export type DensityPreference = "comfortable" | "compact";

type PreferencesContextValue = {
  density: DensityPreference;
  setDensity: (density: DensityPreference) => void;
  setTheme: (theme: ThemePreference) => void;
  theme: ThemePreference;
};

const THEME_KEY = "codex-usage-theme";
const DENSITY_KEY = "codex-usage-density";
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const [density, setDensity] = useState<DensityPreference>(readDensity);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyPreferences(theme, density, media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [density, theme]);

  useEffect(() => writePreference(THEME_KEY, theme), [theme]);
  useEffect(() => writePreference(DENSITY_KEY, density), [density]);

  const value = useMemo(() => ({ density, setDensity, setTheme, theme }), [density, theme]);

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
  const isDark = theme === "dark" || (theme === "system" && systemIsDark);
  root.classList.toggle("dark", isDark);
  root.dataset["density"] = density;
  root.style.colorScheme = isDark ? "dark" : "light";
}
