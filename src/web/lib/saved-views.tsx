import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type SavedView = {
  createdAt: string;
  id: string;
  name: string;
  pathname: SavedViewPath;
  search: string;
  updatedAt: string;
  version: 1;
};

export type SavedViewPath =
  "/" | "/activity" | "/agents" | "/explore" | "/projects" | "/sessions" | "/turns";

type MutationResult = { error: string; ok: false } | { ok: true };

type SavedViewsContextValue = {
  add: (name: string, pathname: string, search: string) => MutationResult;
  remove: (id: string) => void;
  rename: (id: string, name: string) => MutationResult;
  views: SavedView[];
};

type SavedViewsDocument = {
  version: 1;
  views: SavedView[];
};

const SAVED_VIEWS_KEY = "codex-usage-saved-views-v1";
const MAX_SAVED_VIEWS = 20;
const MAX_NAME_LENGTH = 60;
const commonKeys = ["agentKind", "from", "models", "project", "tags", "to"] as const;
const routeKeys: Record<SavedViewPath, readonly string[]> = {
  "/": commonKeys,
  "/activity": [...commonKeys, "kinds", "session", "tab"],
  "/agents": [...commonKeys, "agentSort", "depth", "role"],
  "/explore": commonKeys,
  "/projects": commonKeys,
  "/sessions": commonKeys,
  "/turns": [
    ...commonKeys,
    "agent",
    "effort",
    "order",
    "pageSize",
    "pressure",
    "q",
    "session",
    "sort",
    "status",
  ],
};

const SavedViewsContext = createContext<SavedViewsContextValue | null>(null);

export function SavedViewsProvider({ children }: { children: ReactNode }) {
  const [views, setViews] = useState<SavedView[]>(readSavedViews);

  useEffect(() => writeSavedViews(views), [views]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === SAVED_VIEWS_KEY) setViews(parseSavedViews(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const add = useCallback(
    (rawName: string, rawPathname: string, rawSearch: string): MutationResult => {
      const name = normalizeViewName(rawName);
      const nameError = validateViewName(name);
      if (nameError) return { error: nameError, ok: false };
      const pathname = savedViewPath(rawPathname);
      if (!pathname) return { error: "Trang này không hỗ trợ Saved Views.", ok: false };
      if (views.length >= MAX_SAVED_VIEWS) {
        return { error: `Chỉ có thể lưu tối đa ${MAX_SAVED_VIEWS} views.`, ok: false };
      }
      if (views.some((view) => sameViewName(view.name, name))) {
        return { error: "Tên view đã tồn tại.", ok: false };
      }
      const now = new Date().toISOString();
      const view: SavedView = {
        createdAt: now,
        id: createViewId(),
        name,
        pathname,
        search: canonicalSavedSearch(pathname, rawSearch),
        updatedAt: now,
        version: 1,
      };
      setViews((current) => [view, ...current]);
      return { ok: true };
    },
    [views],
  );

  const rename = useCallback(
    (id: string, rawName: string): MutationResult => {
      const name = normalizeViewName(rawName);
      const nameError = validateViewName(name);
      if (nameError) return { error: nameError, ok: false };
      if (views.some((view) => view.id !== id && sameViewName(view.name, name))) {
        return { error: "Tên view đã tồn tại.", ok: false };
      }
      if (!views.some((view) => view.id === id)) {
        return { error: "Saved View không còn tồn tại.", ok: false };
      }
      setViews((current) =>
        current.map((view) =>
          view.id === id ? { ...view, name, updatedAt: new Date().toISOString() } : view,
        ),
      );
      return { ok: true };
    },
    [views],
  );

  const remove = useCallback((id: string) => {
    setViews((current) => current.filter((view) => view.id !== id));
  }, []);

  const value = useMemo(() => ({ add, remove, rename, views }), [add, remove, rename, views]);
  return <SavedViewsContext.Provider value={value}>{children}</SavedViewsContext.Provider>;
}

export function useSavedViews(): SavedViewsContextValue {
  const value = useContext(SavedViewsContext);
  if (!value) throw new Error("useSavedViews must be used within SavedViewsProvider");
  return value;
}

export function canonicalSavedSearch(pathname: SavedViewPath, rawSearch: string): string {
  const source = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch);
  const next = new URLSearchParams();
  const keys = savedQueryKeys(pathname);
  const legacyModel = source.get("model")?.trim();
  for (const key of keys) {
    const value =
      key === "models"
        ? (source.get("models") ?? legacyModel)
        : key === "tags"
          ? canonicalCommaList(source.get(key), 50)
          : source.get(key);
    const normalized = value?.trim();
    if (normalized) next.set(key, normalized);
  }
  next.sort();
  return next.toString();
}

function canonicalCommaList(value: string | null, limit: number): string {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, limit)
    .join(",");
}

export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["views"])) return [];
    const names = new Set<string>();
    const ids = new Set<string>();
    const views: SavedView[] = [];
    for (const candidate of value["views"]) {
      const view = parseSavedView(candidate);
      if (!view) continue;
      const normalizedName = view.name.toLocaleLowerCase("en-US");
      if (names.has(normalizedName) || ids.has(view.id)) continue;
      names.add(normalizedName);
      ids.add(view.id);
      views.push(view);
      if (views.length === MAX_SAVED_VIEWS) break;
    }
    return views.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

export function savedViewPath(pathname: string): SavedViewPath | null {
  return Object.hasOwn(routeKeys, pathname) ? (pathname as SavedViewPath) : null;
}

function parseSavedView(value: unknown): SavedView | null {
  if (!isRecord(value) || value["version"] !== 1) return null;
  const pathname = typeof value["pathname"] === "string" ? savedViewPath(value["pathname"]) : null;
  const name = typeof value["name"] === "string" ? normalizeViewName(value["name"]) : "";
  if (
    !pathname ||
    validateViewName(name) ||
    typeof value["id"] !== "string" ||
    value["id"].length < 1 ||
    value["id"].length > 100 ||
    typeof value["search"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    !validIsoTimestamp(value["createdAt"]) ||
    !validIsoTimestamp(value["updatedAt"])
  ) {
    return null;
  }
  return {
    createdAt: value["createdAt"],
    id: value["id"],
    name,
    pathname,
    search: canonicalSavedSearch(pathname, value["search"]),
    updatedAt: value["updatedAt"],
    version: 1,
  };
}

function savedQueryKeys(pathname: SavedViewPath): readonly string[] {
  switch (pathname) {
    case "/":
      return routeKeys["/"];
    case "/activity":
      return routeKeys["/activity"];
    case "/agents":
      return routeKeys["/agents"];
    case "/explore":
      return routeKeys["/explore"];
    case "/projects":
      return routeKeys["/projects"];
    case "/sessions":
      return routeKeys["/sessions"];
    case "/turns":
      return routeKeys["/turns"];
  }
}

function normalizeViewName(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function validateViewName(name: string): string | null {
  if (!name) return "Nhập tên cho Saved View.";
  if (name.length > MAX_NAME_LENGTH) return `Tên view tối đa ${MAX_NAME_LENGTH} ký tự.`;
  return null;
}

function sameViewName(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function createViewId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `view-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readSavedViews(): SavedView[] {
  try {
    return parseSavedViews(window.localStorage.getItem(SAVED_VIEWS_KEY));
  } catch {
    return [];
  }
}

function writeSavedViews(views: SavedView[]): void {
  const value: SavedViewsDocument = { version: 1, views };
  try {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(value));
  } catch {
    // Saved Views remain optional when browser storage is blocked or unavailable.
  }
}

function validIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
