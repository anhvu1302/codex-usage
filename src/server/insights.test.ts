import { describe, expect, it } from "vitest";

import {
  calculateEfficiencyMetrics,
  getInclusiveDayCount,
  getPreviousDateRange,
  getProjectName,
  isUsageAnomaly,
  median,
  medianAbsoluteDeviation,
  normalizeProjectPath,
  projectMonthlyCost,
} from "@/server/insights";
import type { DashboardKpis } from "@/shared/types";

describe("insight date calculations", () => {
  it("builds the previous inclusive range with the same number of calendar days", () => {
    expect(getPreviousDateRange({ from: "2026-07-10", to: "2026-07-15" })).toEqual({
      from: "2026-07-04",
      to: "2026-07-09",
    });
    expect(getPreviousDateRange({ from: "2026-01-01", to: "2026-01-03" })).toEqual({
      from: "2025-12-29",
      to: "2025-12-31",
    });
    expect(getPreviousDateRange({ from: "2024-03-01", to: "2024-03-01" })).toEqual({
      from: "2024-02-29",
      to: "2024-02-29",
    });
  });

  it("counts inclusive days across leap-day and rejects invalid ranges", () => {
    expect(getInclusiveDayCount({ from: "2024-02-27", to: "2024-03-01" })).toBe(4);
    expect(() => getPreviousDateRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow(
      RangeError,
    );
    expect(() => getInclusiveDayCount({ from: "2026-7-01", to: "2026-07-01" })).toThrow(RangeError);
    expect(() => getPreviousDateRange({ from: "2026-07-02", to: "2026-07-01" })).toThrow(
      "Date range start",
    );
  });

  it("projects cost only for the current Vietnam month-to-date", () => {
    const now = new Date("2026-07-15T08:00:00.000Z");
    expect(projectMonthlyCost(15, { from: "2026-07-01", to: "2026-07-15" }, now)).toBe(31);
    expect(projectMonthlyCost(0, { from: "2026-07-01", to: "2026-07-15" }, now)).toBe(0);
    expect(projectMonthlyCost(15, { from: "2026-07-02", to: "2026-07-15" }, now)).toBeNull();
    expect(projectMonthlyCost(15, { from: "2026-07-01", to: "2026-07-14" }, now)).toBeNull();
  });

  it("uses the Asia/Ho_Chi_Minh date at UTC month boundaries", () => {
    const vietnamAugustFirst = new Date("2026-07-31T17:30:00.000Z");
    expect(
      projectMonthlyCost(2, { from: "2026-08-01", to: "2026-08-01" }, vietnamAugustFirst),
    ).toBe(62);
    expect(
      projectMonthlyCost(2, { from: "2026-07-01", to: "2026-07-31" }, vietnamAugustFirst),
    ).toBeNull();
    expect(
      projectMonthlyCost(-1, { from: "2026-08-01", to: "2026-08-01" }, vietnamAugustFirst),
    ).toBeNull();
    expect(
      projectMonthlyCost(1, { from: "2026-08-01", to: "2026-08-01" }, new Date(Number.NaN)),
    ).toBeNull();
  });
});

describe("efficiency metrics", () => {
  it("calculates cache, reasoning, request, day and session metrics", () => {
    expect(calculateEfficiencyMetrics(kpis(), 6)).toEqual({
      averageCostPerDay: 2,
      averageTokensPerDay: 200,
      cacheRate: 0.4,
      costPerRequest: 3,
      reasoningShare: 0.25,
      tokensPerSession: 400,
    });
  });

  it("returns finite zeroes when a metric has no denominator or invalid input", () => {
    expect(
      calculateEfficiencyMetrics(
        kpis({
          cachedInputTokens: 10,
          estimatedCostUsd: Number.POSITIVE_INFINITY,
          inputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 10,
          requestCount: 0,
          sessionCount: 0,
          totalTokens: 0,
        }),
        0,
      ),
    ).toEqual({
      averageCostPerDay: 0,
      averageTokensPerDay: 0,
      cacheRate: 0,
      costPerRequest: 0,
      reasoningShare: 0,
      tokensPerSession: 0,
    });
  });
});

describe("median anomaly detection", () => {
  it("calculates medians and median absolute deviations without mutating input", () => {
    const values = [4, 1, 2, 2, 1];
    expect(median(values)).toBe(2);
    expect(median([1, 4, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(medianAbsoluteDeviation(values)).toBe(1);
    expect(values).toEqual([4, 1, 2, 2, 1]);
  });

  it("requires at least three finite non-negative baseline values", () => {
    expect(isUsageAnomaly(100, [10, 10])).toBe(false);
    expect(isUsageAnomaly(100, [10, 10, Number.NaN])).toBe(false);
    expect(isUsageAnomaly(21, [10, 10, 10, Number.NaN])).toBe(true);
    expect(isUsageAnomaly(Number.POSITIVE_INFINITY, [10, 10, 10])).toBe(false);
  });

  it("requires both the two-times-median and three-MAD thresholds", () => {
    expect(isUsageAnomaly(20, [10, 10, 10])).toBe(false);
    expect(isUsageAnomaly(15, [10, 10, 10])).toBe(false);
    expect(isUsageAnomaly(21, [0, 10, 20])).toBe(false);
    expect(isUsageAnomaly(40, [0, 10, 20])).toBe(false);
    expect(isUsageAnomaly(41, [0, 10, 20])).toBe(true);
  });
});

describe("project path helpers", () => {
  it("normalizes POSIX paths and derives macOS project names", () => {
    expect(
      normalizeProjectPath("/Users/VanAnh/WorkSpace//Personal/../codex-usage/", "darwin"),
    ).toBe("/Users/VanAnh/WorkSpace/codex-usage");
    expect(getProjectName("/Users/VanAnh/WorkSpace/My Project/", "darwin")).toBe("My Project");
    expect(getProjectName("/", "darwin")).toBe("/");
  });

  it("creates case-insensitive canonical Windows paths while preserving display names", () => {
    const path = "C:\\Users\\VanAnh\\WorkSpace\\..\\Codex-Usage\\";
    expect(normalizeProjectPath(path, "win32")).toBe("c:/users/vananh/codex-usage");
    expect(normalizeProjectPath("c:/users/VANANH/Codex-Usage", "win32")).toBe(
      "c:/users/vananh/codex-usage",
    );
    expect(getProjectName(path, "win32")).toBe("Codex-Usage");
    expect(getProjectName("C:\\", "win32")).toBe("C:");
  });

  it("normalizes Windows UNC paths", () => {
    const path = "\\\\Server\\Share\\Team\\Project\\";
    expect(normalizeProjectPath(path, "win32")).toBe("//server/share/team/project");
    expect(getProjectName(path, "win32")).toBe("Project");
  });
});

function kpis(overrides: Partial<DashboardKpis> = {}): DashboardKpis {
  return {
    cachedInputTokens: 400,
    estimatedCostUsd: 12,
    inputTokens: 1_000,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    requestCount: 4,
    sessionCount: 3,
    totalTokens: 1_200,
    unpricedUsageCount: 0,
    ...overrides,
  };
}
