import { describe, expect, it } from "vitest";

import type { TurnSummary } from "@/shared/types";
import { diagnoseTurnPage } from "@/web/lib/turn-diagnostics";

describe("turn page diagnostics", () => {
  it("uses nearest-rank P95 with a minimum of 20 eligible values", () => {
    const turns = Array.from({ length: 20 }, (_, index) =>
      turn(index + 1, {
        durationMs: index + 1,
        estimatedCostUsd: index + 1,
        timeToFirstTokenMs: (index + 1) * 2,
      }),
    );
    const diagnostics = diagnoseTurnPage(turns);
    expect(diagnostics.baselines.duration).toEqual({
      available: true,
      eligible: 20,
      median: 10.5,
      p95: 19,
    });
    expect(diagnostics.reasons.get("turn-19")).toEqual(["duration-p95", "ttft-p95", "cost-p95"]);
    expect(diagnostics.reasons.get("turn-20")).toEqual(["duration-p95", "ttft-p95", "cost-p95"]);
    expect(diagnostics.outlierTurnCount).toBe(2);
  });

  it("does not classify equal values or samples below the minimum", () => {
    const equal = diagnoseTurnPage(Array.from({ length: 20 }, (_, index) => turn(index, {})));
    expect(equal.baselines.duration.available).toBe(false);
    expect(equal.outlierTurnCount).toBe(0);

    const small = diagnoseTurnPage(
      Array.from({ length: 19 }, (_, index) => turn(index, { durationMs: index })),
    );
    expect(small.baselines.duration).toMatchObject({ available: false, eligible: 19 });
  });

  it("excludes non-exact costs and applies fixed context thresholds", () => {
    const values = Array.from({ length: 20 }, (_, index) =>
      turn(index, { estimatedCostUsd: index }),
    );
    values[0] = turn(0, {
      contextUtilizationPercent: 70,
      costCoverage: "partial",
      estimatedCostUsd: 10_000,
    });
    values[1] = turn(1, { contextUtilizationPercent: 85, costCoverage: "unavailable" });
    values[2] = turn(2, { contextUtilizationPercent: 95 });
    const diagnostics = diagnoseTurnPage(values);
    expect(diagnostics.baselines.cost.eligible).toBe(18);
    expect(diagnostics.reasons.get("turn-0")).toEqual(["cost-partial", "context-70"]);
    expect(diagnostics.reasons.get("turn-1")).toEqual(["cost-unavailable", "context-85"]);
    expect(diagnostics.reasons.get("turn-2")).toContain("context-95");
  });
});

function turn(index: number, overrides: Partial<TurnSummary>): TurnSummary {
  return {
    agentId: "agent",
    agentKind: "main",
    agentName: null,
    cacheRate: 0.5,
    cachedInputTokens: 10,
    collaborationMode: null,
    completedAt: null,
    contextUtilizationPercent: null,
    contextWindowTokens: null,
    costAttributionMissingCount: 0,
    costCoverage: "exact",
    depth: 0,
    durationMs: 10,
    effort: null,
    estimatedCostUsd: 10,
    inputTokens: 10,
    lastEventAt: "2026-07-20T00:00:00.000Z",
    models: ["gpt-test"],
    ordinal: index,
    outputTokens: 10,
    parentAgentId: null,
    peakInputTokens: null,
    projectId: null,
    reasoningOutputTokens: 0,
    requestCount: 1,
    role: null,
    sessionId: "session",
    sessionTitle: "Session",
    startedAt: null,
    status: "completed",
    timeToFirstTokenMs: 10,
    totalTokens: 20,
    turnId: String(index),
    turnKey: `turn-${index}`,
    unpricedUsageCount: 0,
    ...overrides,
  };
}
