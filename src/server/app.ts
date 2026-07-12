import { Hono } from "hono";
import { z } from "zod";

import {
  backfillUnpricedUsage,
  getDashboard,
  getKnownModels,
  getModelRates,
  getSessions,
  upsertModelRate,
} from "@/server/analytics";
import type { AppDatabase } from "@/server/db/client";
import type { SessionImporter } from "@/server/importer";
import type { DashboardFilters } from "@/shared/types";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const rateSchema = z.object({
  cachedInputRate: z.coerce.number().finite().nonnegative(),
  inputRate: z.coerce.number().finite().nonnegative(),
  outputRate: z.coerce.number().finite().nonnegative(),
});

export function createApp(database: AppDatabase, importer: SessionImporter) {
  const app = new Hono();

  app.get("/api/health", (context) => context.json({ ok: true }));
  app.get("/api/status", (context) => context.json(importer.getStatus()));
  app.post("/api/sync", async (context) => context.json(await importer.syncAll()));

  app.get("/api/dashboard", (context) => {
    const filters = parseFilters(context.req.query());
    return filters.success
      ? context.json(getDashboard(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/sessions", (context) => {
    const filters = parseFilters(context.req.query());
    return filters.success
      ? context.json(getSessions(database, filters.data))
      : context.json({ error: filters.error }, 400);
  });
  app.get("/api/models", (context) => context.json({ models: getKnownModels(database) }));
  app.get("/api/rates", (context) => context.json({ rates: getModelRates(database) }));

  app.put("/api/rates/:model", async (context) => {
    const model = context.req.param("model").trim();
    const payload = rateSchema.safeParse(await context.req.json<unknown>());
    if (!model) return context.json({ error: "Model is required" }, 400);
    if (!payload.success) return context.json({ error: payload.error.flatten() }, 400);

    const rate = upsertModelRate(database, { model, ...payload.data });
    importer.clearRateCache();
    return context.json({ backfilled: backfillUnpricedUsage(database, model), rate });
  });

  app.post("/api/rates/:model/backfill", (context) => {
    const model = context.req.param("model").trim();
    if (!model) return context.json({ error: "Model is required" }, 400);
    return context.json({ updated: backfillUnpricedUsage(database, model) });
  });

  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });

  return app;
}

function parseFilters(
  query: Record<string, string | undefined>,
): { data: DashboardFilters; success: true } | { error: string; success: false } {
  const to = query["to"] ?? currentDate();
  const from = query["from"] ?? dateDaysBefore(to, 29);
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) {
    return { error: "from and to must be ISO dates with from <= to", success: false };
  }
  const model = query["model"]?.trim();
  return { data: { from, ...(model ? { model } : {}), to }, success: true };
}

function currentDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not format the current date");
  return `${year}-${month}-${day}`;
}

function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
