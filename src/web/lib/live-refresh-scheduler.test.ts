import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppRevisionScope } from "@/shared/types";
import {
  createLiveRefreshScheduler,
  matchesRevisionScopes,
  resolveRevisionScopes,
} from "@/web/lib/live-refresh-scheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("live refresh scheduler", () => {
  it("flushes at most twice during twenty seconds of continuous import revisions", () => {
    vi.useFakeTimers();
    const flushed: AppRevisionScope[][] = [];
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => flushed.push([...scopes].sort()),
    });

    for (let second = 0; second < 20; second += 1) {
      scheduler.enqueue({ reason: "import", scopes: ["dashboard", "sessions"] });
      vi.advanceTimersByTime(1_000);
    }

    expect(flushed).toEqual([
      ["dashboard", "sessions"],
      ["dashboard", "sessions"],
    ]);
  });

  it("performs a final analytics refresh within two seconds after the stream becomes quiet", () => {
    vi.useFakeTimers();
    const flushed: AppRevisionScope[][] = [];
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => flushed.push([...scopes].sort()),
    });

    for (let second = 0; second < 15; second += 1) {
      scheduler.enqueue({ reason: "import", scopes: ["dashboard"] });
      vi.advanceTimersByTime(1_000);
    }
    expect(flushed).toEqual([["dashboard"]]);
    vi.advanceTimersByTime(1_000);
    expect(flushed).toEqual([["dashboard"], ["dashboard"]]);
  });

  it("keeps catalog on the slow lane but flushes it when the stream becomes quiet", () => {
    vi.useFakeTimers();
    const flushed: AppRevisionScope[][] = [];
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => flushed.push([...scopes]),
    });

    for (let second = 0; second < 65; second += 1) {
      scheduler.enqueue({ reason: "import", scopes: ["catalog"] });
      vi.advanceTimersByTime(1_000);
    }
    expect(flushed).toEqual([["catalog"]]);

    vi.advanceTimersByTime(1_000);
    expect(flushed).toEqual([["catalog"], ["catalog"]]);
  });

  it("coalesces rare mutation scopes within 250ms", () => {
    vi.useFakeTimers();
    const flushed: AppRevisionScope[][] = [];
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => flushed.push([...scopes].sort()),
    });

    scheduler.enqueue({ reason: "budget", scopes: ["budgets"] });
    scheduler.enqueue({ reason: "budget", scopes: ["alerts"] });
    vi.advanceTimersByTime(249);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["alerts", "budgets"]]);
  });

  it("keeps scopes dirty while hidden and flushes one union when visible", () => {
    vi.useFakeTimers();
    const flushed: AppRevisionScope[][] = [];
    const scheduler = createLiveRefreshScheduler({
      onFlush: (scopes) => flushed.push([...scopes].sort()),
      visible: false,
    });

    scheduler.enqueue({ reason: "import", scopes: ["dashboard"] });
    scheduler.enqueue({ reason: "import", scopes: ["catalog", "data-health"] });
    vi.advanceTimersByTime(120_000);
    expect(flushed).toEqual([]);

    scheduler.setVisible(true);
    expect(flushed).toEqual([["catalog", "dashboard", "data-health"]]);
  });

  it("disposes timers without flushing pending scopes", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createLiveRefreshScheduler({ onFlush });
    scheduler.enqueue({ reason: "import", scopes: ["dashboard"] });
    scheduler.dispose();
    vi.runAllTimers();
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe("revision scope matching", () => {
  it("separates project options from project analytics", () => {
    expect(matchesRevisionScopes(["projects", "options", {}], new Set(["catalog"]))).toBe(true);
    expect(matchesRevisionScopes(["projects", "page", {}], new Set(["catalog"]))).toBe(false);
    expect(matchesRevisionScopes(["projects", "options", {}], new Set(["projects"]))).toBe(false);
    expect(matchesRevisionScopes(["projects", "page", {}], new Set(["projects"]))).toBe(true);
  });

  it("never matches status and maps grouped dashboard/session keys", () => {
    const scopes = new Set<AppRevisionScope>(["dashboard", "sessions"]);
    expect(matchesRevisionScopes(["status"], scopes)).toBe(false);
    expect(matchesRevisionScopes(["overview", {}], scopes)).toBe(true);
    expect(matchesRevisionScopes(["dashboard", {}], scopes)).toBe(true);
    expect(matchesRevisionScopes(["session", "id"], scopes)).toBe(true);
    expect(matchesRevisionScopes(["sessions", "summary", {}], scopes)).toBe(true);
  });

  it("uses legacy reason scopes only when scopes are absent", () => {
    expect(resolveRevisionScopes({ reason: "import" }).has("dashboard")).toBe(true);
    expect(resolveRevisionScopes({ reason: "import", scopes: [] })).toEqual(new Set());
    expect(resolveRevisionScopes({ reason: "import", scopes: ["activity", "activity"] })).toEqual(
      new Set(["activity"]),
    );
  });
});
