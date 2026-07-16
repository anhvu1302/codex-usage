import type {
  AppRevisionEvent,
  AppRevisionReason,
  AppScanEvent,
  SourceScanStatus,
  TurnBackfillStatus,
} from "@/shared/types";
import { isRevisionScope } from "@/web/lib/live-refresh-scheduler";

export function parseRevision(value: string): AppRevisionEvent | null {
  const parsed = parseObject(value);
  if (
    !parsed ||
    !isRevisionReason(parsed["reason"]) ||
    !Number.isSafeInteger(parsed["revision"]) ||
    Number(parsed["revision"]) < 0
  ) {
    return null;
  }
  const scopesValue = parsed["scopes"];
  const scopes = Array.isArray(scopesValue)
    ? [...new Set(scopesValue.filter(isRevisionScope))]
    : undefined;
  return {
    reason: parsed["reason"],
    revision: parsed["revision"] as number,
    ...(scopes ? { scopes } : {}),
  };
}

export function parseScan(value: string): AppScanEvent | null {
  const parsed = parseObject(value);
  const sourceScan = parseSourceScan(parsed?.["sourceScan"]);
  const turnBackfill = parseTurnBackfill(parsed?.["turnBackfill"]);
  if (
    !parsed ||
    !isNullableString(parsed["error"]) ||
    !isNonNegativeInteger(parsed["filesProcessed"]) ||
    typeof parsed["isSyncing"] !== "boolean" ||
    !isNullableString(parsed["lastSyncAt"]) ||
    !isNonNegativeInteger(parsed["recordsBackfilled"]) ||
    !isNonNegativeInteger(parsed["recordsInserted"]) ||
    !isNonNegativeInteger(parsed["recordsReclassified"]) ||
    sourceScan === null ||
    turnBackfill === null
  ) {
    return null;
  }
  return {
    error: parsed["error"],
    filesProcessed: parsed["filesProcessed"],
    isSyncing: parsed["isSyncing"],
    lastSyncAt: parsed["lastSyncAt"],
    recordsBackfilled: parsed["recordsBackfilled"],
    recordsInserted: parsed["recordsInserted"],
    recordsReclassified: parsed["recordsReclassified"],
    sourceScan,
    turnBackfill,
  };
}

function parseSourceScan(value: unknown): SourceScanStatus | null {
  if (!isObject(value) || typeof value["deepQueued"] !== "boolean") return null;
  const current = parseCurrentScan(value["current"]);
  const lastCompleted = parseCompletedScan(value["lastCompleted"]);
  if (
    current === undefined ||
    lastCompleted === undefined ||
    !isNullableString(value["nextScheduledAt"])
  ) {
    return null;
  }
  return {
    current,
    deepQueued: value["deepQueued"],
    lastCompleted,
    nextScheduledAt: value["nextScheduledAt"],
  };
}

function parseCurrentScan(value: unknown): SourceScanStatus["current"] | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !isNonNegativeInteger(value["discoveredFiles"]) ||
    !isNonNegativeInteger(value["filesRead"]) ||
    !isNonNegativeInteger(value["filesSkipped"]) ||
    !isScanMode(value["mode"]) ||
    !isScanPhase(value["phase"]) ||
    typeof value["startedAt"] !== "string" ||
    !isScanTrigger(value["trigger"])
  ) {
    return undefined;
  }
  return {
    discoveredFiles: value["discoveredFiles"],
    filesRead: value["filesRead"],
    filesSkipped: value["filesSkipped"],
    mode: value["mode"],
    phase: value["phase"],
    startedAt: value["startedAt"],
    trigger: value["trigger"],
  };
}

function parseCompletedScan(value: unknown): SourceScanStatus["lastCompleted"] | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    typeof value["completedAt"] !== "string" ||
    !isNonNegativeInteger(value["discoveredFiles"]) ||
    !isNonNegativeInteger(value["durationMs"]) ||
    !isNonNegativeInteger(value["filesRead"]) ||
    !isNonNegativeInteger(value["filesSkipped"]) ||
    !isScanMode(value["mode"]) ||
    !isNonNegativeInteger(value["sourceBytes"]) ||
    !isScanTrigger(value["trigger"])
  ) {
    return undefined;
  }
  return {
    completedAt: value["completedAt"],
    discoveredFiles: value["discoveredFiles"],
    durationMs: value["durationMs"],
    filesRead: value["filesRead"],
    filesSkipped: value["filesSkipped"],
    mode: value["mode"],
    sourceBytes: value["sourceBytes"],
    trigger: value["trigger"],
  };
}

function parseTurnBackfill(value: unknown): TurnBackfillStatus | null {
  if (
    !isObject(value) ||
    !isNonNegativeInteger(value["attributionVersion"]) ||
    !isNonNegativeInteger(value["costAttributionMissingCount"]) ||
    !isNullableString(value["error"]) ||
    !isNonNegativeInteger(value["filesProcessed"]) ||
    typeof value["isRunning"] !== "boolean" ||
    !isNullableString(value["lastRunAt"]) ||
    !isNonNegativeInteger(value["sourceDeletedGaps"]) ||
    !isNonNegativeInteger(value["totalFiles"])
  ) {
    return null;
  }
  return {
    attributionVersion: value["attributionVersion"],
    costAttributionMissingCount: value["costAttributionMissingCount"],
    error: value["error"],
    filesProcessed: value["filesProcessed"],
    isRunning: value["isRunning"],
    lastRunAt: value["lastRunAt"],
    sourceDeletedGaps: value["sourceDeletedGaps"],
    totalFiles: value["totalFiles"],
  };
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isScanMode(value: unknown): value is NonNullable<SourceScanStatus["current"]>["mode"] {
  return value === "deep" || value === "inventory";
}

function isScanPhase(value: unknown): value is NonNullable<SourceScanStatus["current"]>["phase"] {
  return value === "discovering" || value === "reading" || value === "reconciling";
}

function isScanTrigger(
  value: unknown,
): value is NonNullable<SourceScanStatus["current"]>["trigger"] {
  return value === "manual" || value === "scheduled" || value === "startup";
}

function isRevisionReason(value: unknown): value is AppRevisionReason {
  return (
    value === "budget" ||
    value === "import" ||
    value === "project" ||
    value === "rate" ||
    value === "retention"
  );
}
