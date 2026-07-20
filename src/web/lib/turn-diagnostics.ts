import type { TurnDiagnosticMetric, TurnDiagnosticReason, TurnSummary } from "@/shared/types";

export type { TurnDiagnosticReason } from "@/shared/types";

type TurnMetricBaseline = {
  available: boolean;
  eligible: number;
  median: number | null;
  p95: number | null;
};

export type TurnPageDiagnostics = {
  baselines: Record<TurnDiagnosticMetric, TurnMetricBaseline>;
  outlierTurnCount: number;
  reasons: Map<string, TurnDiagnosticReason[]>;
  turnCount: number;
};

const MINIMUM_SAMPLE = 20;

export function diagnoseTurnPage(turns: TurnSummary[]): TurnPageDiagnostics {
  const baselines = {
    cost: baseline(
      turns.flatMap((turn) => (turn.costCoverage === "exact" ? [turn.estimatedCostUsd] : [])),
    ),
    duration: baseline(
      turns.flatMap((turn) => (turn.durationMs === null ? [] : [turn.durationMs])),
    ),
    ttft: baseline(
      turns.flatMap((turn) => (turn.timeToFirstTokenMs === null ? [] : [turn.timeToFirstTokenMs])),
    ),
  } satisfies Record<TurnDiagnosticMetric, TurnMetricBaseline>;
  const reasons = new Map<string, TurnDiagnosticReason[]>();
  let outlierTurnCount = 0;

  for (const turn of turns) {
    const values: TurnDiagnosticReason[] = [];
    if (isOutlier(turn.durationMs, baselines.duration)) values.push("duration-p95");
    if (isOutlier(turn.timeToFirstTokenMs, baselines.ttft)) values.push("ttft-p95");
    if (turn.costCoverage === "exact") {
      if (isOutlier(turn.estimatedCostUsd, baselines.cost)) values.push("cost-p95");
    } else values.push(turn.costCoverage === "partial" ? "cost-partial" : "cost-unavailable");
    const contextReason = contextDiagnostic(turn.contextUtilizationPercent);
    if (contextReason) values.push(contextReason);
    if (values.some(isOutlierReason)) outlierTurnCount += 1;
    reasons.set(turn.turnKey, values);
  }

  return { baselines, outlierTurnCount, reasons, turnCount: turns.length };
}

export function diagnosticReasonLabel(reason: TurnDiagnosticReason): string {
  switch (reason) {
    case "context-70":
      return "Context ≥70%";
    case "context-85":
      return "Context ≥85%";
    case "context-95":
      return "Context ≥95%";
    case "cost-partial":
      return "Cost một phần";
    case "cost-p95":
      return "Cost P95";
    case "cost-unavailable":
      return "Chưa có cost";
    case "duration-p95":
      return "Duration P95";
    case "ttft-p95":
      return "TTFT P95";
  }
}

export function isOutlierReason(reason: TurnDiagnosticReason): boolean {
  return reason !== "cost-partial" && reason !== "cost-unavailable";
}

function baseline(values: number[]): TurnMetricBaseline {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length < MINIMUM_SAMPLE) {
    return { available: false, eligible: sorted.length, median: null, p95: null };
  }
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted.at(middle - 1)! + sorted.at(middle)!) / 2
      : sorted.at(middle)!;
  const p95 = sorted.at(Math.ceil(sorted.length * 0.95) - 1)!;
  return { available: p95 > median, eligible: sorted.length, median, p95 };
}

function isOutlier(value: number | null, baseline: TurnMetricBaseline): boolean {
  return value !== null && baseline.available && baseline.p95 !== null && value >= baseline.p95;
}

function contextDiagnostic(value: number | null): TurnDiagnosticReason | null {
  if (value === null || value < 70) return null;
  if (value >= 95) return "context-95";
  if (value >= 85) return "context-85";
  return "context-70";
}
