import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { AlertEvent } from "@/shared/types";

export type AlertTypePreference = AlertEvent["type"];

export type BrowserNotificationPreferences = {
  enabled: boolean;
  enabledAt: string | null;
  quietHours: {
    enabled: boolean;
    end: string;
    start: string;
  };
  types: AlertTypePreference[];
  version: 1;
};

type BrowserNotificationsContextValue = {
  permission: NotificationPermission | "unsupported";
  preferences: BrowserNotificationPreferences;
  requestEnable: () => Promise<NotificationPermission | "unsupported">;
  setPreferences: (value: BrowserNotificationPreferences) => void;
};

const PREFERENCES_KEY = "codex-usage-browser-notifications-v1";
const NOTIFIED_KEY = "codex-usage-notified-alerts-v1";
const MAX_NOTIFIED_IDS = 200;
const allAlertTypes: AlertTypePreference[] = [
  "anomaly",
  "budget",
  "context-pressure",
  "data-health",
];
const defaultPreferences: BrowserNotificationPreferences = {
  enabled: false,
  enabledAt: null,
  quietHours: { enabled: false, end: "07:00", start: "22:00" },
  types: allAlertTypes,
  version: 1,
};
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
});

const BrowserNotificationsContext = createContext<BrowserNotificationsContextValue | null>(null);

export function BrowserNotificationsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferencesState] = useState(readNotificationPreferences);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    notificationPermission,
  );

  useEffect(() => writeNotificationPreferences(preferences), [preferences]);

  const setPreferences = useCallback((value: BrowserNotificationPreferences) => {
    setPreferencesState(normalizeNotificationPreferences(value));
  }, []);

  const requestEnable = useCallback(async () => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return "unsupported" as const;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    setPreferencesState((current) => ({
      ...current,
      enabled: result === "granted",
      enabledAt: result === "granted" ? new Date().toISOString() : null,
    }));
    return result;
  }, []);

  const value = useMemo(
    () => ({ permission, preferences, requestEnable, setPreferences }),
    [permission, preferences, requestEnable, setPreferences],
  );
  return (
    <BrowserNotificationsContext.Provider value={value}>
      {children}
    </BrowserNotificationsContext.Provider>
  );
}

export function useBrowserNotificationPreferences(): BrowserNotificationsContextValue {
  const value = useContext(BrowserNotificationsContext);
  if (!value) {
    throw new Error(
      "useBrowserNotificationPreferences must be used within BrowserNotificationsProvider",
    );
  }
  return value;
}

export function eligibleBrowserAlerts(
  alerts: AlertEvent[],
  preferences: BrowserNotificationPreferences,
  notifiedIds: ReadonlySet<string>,
  now = new Date(),
): AlertEvent[] {
  if (!preferences.enabled || !preferences.enabledAt || isQuietHour(preferences, now)) return [];
  const enabledAt = Date.parse(preferences.enabledAt);
  return alerts.filter(
    (alert) =>
      alert.seenAt === null &&
      (alert.severity === "critical" || alert.severity === "warning") &&
      preferences.types.includes(alert.type) &&
      Date.parse(alert.createdAt) > enabledAt &&
      !notifiedIds.has(alert.id),
  );
}

export function isQuietHour(
  preferences: BrowserNotificationPreferences,
  now = new Date(),
): boolean {
  if (!preferences.quietHours.enabled) return false;
  const current = minutesFromTime(timeFormatter.format(now));
  const start = minutesFromTime(preferences.quietHours.start);
  const end = minutesFromTime(preferences.quietHours.end);
  if (current === null || start === null || end === null || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function readNotifiedAlertIds(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(
          -MAX_NOTIFIED_IDS,
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberNotifiedAlertIds(ids: string[]): void {
  try {
    const current = readNotifiedAlertIds();
    const next = [...new Set([...current, ...ids])].slice(-MAX_NOTIFIED_IDS);
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(next));
  } catch {
    // Notification dedupe is best effort when browser storage is unavailable.
  }
}

export function parseNotificationPreferences(raw: string | null): BrowserNotificationPreferences {
  if (!raw) return defaultPreferences;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value["version"] !== 1) return defaultPreferences;
    return normalizeNotificationPreferences({
      enabled: value["enabled"] === true,
      enabledAt: typeof value["enabledAt"] === "string" ? value["enabledAt"] : null,
      quietHours: isRecord(value["quietHours"])
        ? {
            enabled: value["quietHours"]["enabled"] === true,
            end:
              typeof value["quietHours"]["end"] === "string" ? value["quietHours"]["end"] : "07:00",
            start:
              typeof value["quietHours"]["start"] === "string"
                ? value["quietHours"]["start"]
                : "22:00",
          }
        : defaultPreferences.quietHours,
      types: Array.isArray(value["types"])
        ? value["types"].filter(isAlertTypePreference)
        : allAlertTypes,
      version: 1,
    });
  } catch {
    return defaultPreferences;
  }
}

function readNotificationPreferences(): BrowserNotificationPreferences {
  try {
    return parseNotificationPreferences(window.localStorage.getItem(PREFERENCES_KEY));
  } catch {
    return defaultPreferences;
  }
}

function writeNotificationPreferences(value: BrowserNotificationPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // Browser notifications remain optional when storage is unavailable.
  }
}

function normalizeNotificationPreferences(
  value: BrowserNotificationPreferences,
): BrowserNotificationPreferences {
  const types = [...new Set(value.types.filter(isAlertTypePreference))];
  const enabledAt =
    value.enabledAt && Number.isFinite(Date.parse(value.enabledAt))
      ? new Date(Date.parse(value.enabledAt)).toISOString()
      : null;
  return {
    enabled: value.enabled && enabledAt !== null,
    enabledAt,
    quietHours: {
      enabled: value.quietHours.enabled,
      end: validTime(value.quietHours.end) ? value.quietHours.end : "07:00",
      start: validTime(value.quietHours.start) ? value.quietHours.start : "22:00",
    },
    types,
    version: 1,
  };
}

function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "unsupported";
}

function isAlertTypePreference(value: unknown): value is AlertTypePreference {
  return typeof value === "string" && allAlertTypes.includes(value as AlertTypePreference);
}

function validTime(value: string): boolean {
  return minutesFromTime(value) !== null;
}

function minutesFromTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
