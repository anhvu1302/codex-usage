import { posix, win32 } from "node:path";

import type { DashboardKpis, DateRange, EfficiencyMetrics } from "@/shared/types";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const TIME_ZONE = "Asia/Ho_Chi_Minh";
const VIETNAM_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: TIME_ZONE,
  year: "numeric",
});

type CalendarDate = {
  day: number;
  dayNumber: number;
  month: number;
  year: number;
};

export function getInclusiveDayCount(range: DateRange): number {
  const parsed = parseDateRange(range);
  return parsed.to.dayNumber - parsed.from.dayNumber + 1;
}

export function getPreviousDateRange(range: DateRange): DateRange {
  const parsed = parseDateRange(range);
  const length = parsed.to.dayNumber - parsed.from.dayNumber + 1;
  const previousTo = parsed.from.dayNumber - 1;

  return {
    from: formatDayNumber(previousTo - length + 1),
    to: formatDayNumber(previousTo),
  };
}

export function projectMonthlyCost(
  costUsd: number,
  range: DateRange,
  now = new Date(),
): number | null {
  if (!Number.isFinite(costUsd) || costUsd < 0 || Number.isNaN(now.getTime())) return null;

  const todayIso = toVietnamIsoDate(now);
  const today = todayIso ? parseIsoDate(todayIso) : null;
  const from = parseIsoDate(range.from);
  const to = parseIsoDate(range.to);
  if (!today || !from || !to || from.dayNumber > to.dayNumber) return null;

  const expectedFrom = `${String(today.year).padStart(4, "0")}-${String(today.month).padStart(
    2,
    "0",
  )}-01`;
  if (range.from !== expectedFrom || range.to !== todayIso) return null;

  const elapsedDays = today.day;
  if (elapsedDays <= 0) return null;

  const projection = (costUsd / elapsedDays) * daysInMonth(today.year, today.month);
  return Number.isFinite(projection) ? projection : null;
}

export function calculateEfficiencyMetrics(
  kpis: DashboardKpis,
  dayCount: number,
): EfficiencyMetrics {
  return {
    averageCostPerDay: safeDivide(kpis.estimatedCostUsd, dayCount),
    averageTokensPerDay: safeDivide(kpis.totalTokens, dayCount),
    cacheRate: safeDivide(kpis.cachedInputTokens, kpis.inputTokens),
    costPerRequest: safeDivide(kpis.estimatedCostUsd, kpis.requestCount),
    reasoningShare: safeDivide(kpis.reasoningOutputTokens, kpis.outputTokens),
    tokensPerSession: safeDivide(kpis.totalTokens, kpis.sessionCount),
  };
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle);
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;

  const lower = sorted.at(middle - 1);
  return lower === undefined ? null : (lower + upper) / 2;
}

export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

export function isUsageAnomaly(currentValue: number, baselineValues: readonly number[]): boolean {
  if (!Number.isFinite(currentValue) || currentValue < 0) return false;

  const baseline = baselineValues.filter((value) => Number.isFinite(value) && value >= 0);
  if (baseline.length < 3) return false;

  const center = median(baseline);
  const deviation = medianAbsoluteDeviation(baseline);
  if (center === null || deviation === null) return false;

  return currentValue > center * 2 && currentValue > center + deviation * 3;
}

export function normalizeProjectPath(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeForPlatform(projectPath, platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getProjectName(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeForPlatform(projectPath, platform);
  if (normalized === "/") return normalized;

  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function parseDateRange(range: DateRange): { from: CalendarDate; to: CalendarDate } {
  const from = parseIsoDate(range.from);
  const to = parseIsoDate(range.to);
  if (!from || !to) {
    throw new RangeError("Date range must use valid YYYY-MM-DD calendar dates");
  }
  if (from.dayNumber > to.dayNumber) {
    throw new RangeError("Date range start must not be after its end");
  }
  return { from, to };
}

function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { day, dayNumber: date.getTime() / MILLISECONDS_PER_DAY, month, year };
}

function formatDayNumber(dayNumber: number): string {
  const date = new Date(dayNumber * MILLISECONDS_PER_DAY);
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9_999) {
    throw new RangeError("Calculated date is outside the supported YYYY-MM-DD range");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function toVietnamIsoDate(date: Date): string | null {
  let day: string | undefined;
  let month: string | undefined;
  let year: string | undefined;
  for (const part of VIETNAM_DATE_PARTS.formatToParts(date)) {
    if (part.type === "day") day = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "year") year = part.value;
  }
  return day && month && year ? `${year}-${month}-${day}` : null;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function safeDivide(numerator: number, denominator: number): number {
  if (
    !Number.isFinite(numerator) ||
    numerator < 0 ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : 0;
}

function normalizeForPlatform(projectPath: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? win32.normalize(projectPath) : posix.normalize(projectPath);
  const portable = platform === "win32" ? normalized.replaceAll("\\", "/") : normalized;
  if (portable === "/" || /^[A-Za-z]:\/$/u.test(portable)) return portable;
  return portable.replace(/\/+$/u, "");
}
