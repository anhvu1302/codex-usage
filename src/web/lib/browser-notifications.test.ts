import { describe, expect, it } from "vitest";

import type { AlertEvent } from "@/shared/types";
import {
  eligibleBrowserAlerts,
  isQuietHour,
  parseNotificationPreferences,
  type BrowserNotificationPreferences,
} from "@/web/lib/browser-notifications";

const preferences: BrowserNotificationPreferences = {
  enabled: true,
  enabledAt: "2026-07-20T00:00:00.000Z",
  quietHours: { enabled: false, end: "07:00", start: "22:00" },
  types: ["budget", "context-pressure"],
  version: 1,
};

describe("browser notification preferences", () => {
  it("falls back safely and preserves an explicit empty type selection", () => {
    expect(parseNotificationPreferences("invalid").enabled).toBe(false);
    expect(
      parseNotificationPreferences(JSON.stringify({ ...preferences, types: [], version: 1 })).types,
    ).toEqual([]);
  });

  it("evaluates crossing-midnight quiet hours in Asia/Ho_Chi_Minh", () => {
    const quiet = { ...preferences, quietHours: { enabled: true, end: "07:00", start: "22:00" } };
    expect(isQuietHour(quiet, new Date("2026-07-20T16:00:00.000Z"))).toBe(true);
    expect(isQuietHour(quiet, new Date("2026-07-20T14:00:00.000Z"))).toBe(false);
    expect(isQuietHour(quiet, new Date("2026-07-20T00:00:00.000Z"))).toBe(false);
  });

  it("selects only new unseen warning or critical alerts of enabled types", () => {
    const alerts = [
      alert("eligible", { createdAt: "2026-07-20T00:01:00.000Z" }),
      alert("old", { createdAt: "2026-07-19T23:59:00.000Z" }),
      alert("seen", { createdAt: "2026-07-20T00:02:00.000Z", seenAt: "2026-07-20T00:03:00.000Z" }),
      alert("info", { createdAt: "2026-07-20T00:04:00.000Z", severity: "info" }),
      alert("wrong-type", { createdAt: "2026-07-20T00:05:00.000Z", type: "anomaly" }),
      alert("deduped", { createdAt: "2026-07-20T00:06:00.000Z" }),
    ];
    expect(
      eligibleBrowserAlerts(
        alerts,
        preferences,
        new Set(["deduped"]),
        new Date("2026-07-20T01:00:00.000Z"),
      ).map((value) => value.id),
    ).toEqual(["eligible"]);
  });
});

function alert(id: string, overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    createdAt: "2026-07-20T00:01:00.000Z",
    dismissedAt: null,
    id,
    message: "Alert test",
    periodStart: "2026-07-20",
    seenAt: null,
    severity: "warning",
    title: "Alert",
    turnKey: null,
    type: "budget",
    ...overrides,
  };
}
