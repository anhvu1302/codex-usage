import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { AppEventBus } from "@/server/app-events";
import { createDatabase, migrateDatabase } from "@/server/db/client";
import { SessionImporter } from "@/server/importer";
import { RetentionService } from "@/server/retention";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("application live events", () => {
  it("delivers every in-process revision in order and supports unsubscribe", () => {
    const events = new AppEventBus(0);
    const received: string[] = [];
    const unsubscribe = events.subscribe((event) =>
      received.push(`${event.revision}:${event.reason}`),
    );
    events.publish("project");
    events.publish("rate");
    unsubscribe();
    events.publish("budget");
    expect(received).toEqual(["1:project", "2:rate"]);
    expect(events.getRevision()).toEqual({ reason: "budget", revision: 3, scopes: ["budgets"] });
  });

  it("streams a reconnect snapshot and privacy-safe scan state", async () => {
    const harness = await createHarness();
    const events = new AppEventBus(0);
    events.publish("project");
    const privateSourcePath = join(harness.sessionsDirectory, "private-source.jsonl");
    await harness.importer.syncFile(privateSourcePath);
    const app = createApp(harness.database, harness.importer, harness.retention, events);
    const response = await app.request("/api/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response did not expose a body");
    const payload = await readUntil(reader, "event: scan");
    await reader.cancel();
    expect(payload).toContain("event: revision");
    expect(payload).toContain(
      'data: {"reason":"project","revision":1,"scopes":["activity","agents","catalog","projects","sessions","turns"]}',
    );
    expect(payload).toContain("retry: 5000");
    expect(payload).toContain('"isSyncing":false');
    expect(payload).toContain('"recordsInserted":0');
    expect(payload).toContain('"error":"Import failed; check server logs for details"');
    expect(payload).not.toContain(privateSourcePath);
    expect(payload).not.toMatch(/sourcePath|title|payload|jsonl/iu);
    harness.database.$client.close();
  });

  it("publishes only successful mutable API changes", async () => {
    const harness = await createHarness();
    const events = new AppEventBus(0);
    const reasons: string[] = [];
    events.subscribe((event) => reasons.push(event.reason));
    const app = createApp(harness.database, harness.importer, harness.retention, events);
    expect(
      (
        await app.request("/api/budgets", {
          body: JSON.stringify({
            enabled: true,
            limitUsd: 10,
            period: "daily",
            warningThresholds: [50, 80, 100],
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/budgets", {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "PUT",
        })
      ).status,
    ).toBe(400);
    expect(reasons).toEqual(["budget"]);
    harness.database.$client.close();
  });

  it("narrows rate revisions when no usage cost changes", async () => {
    const harness = await createHarness();
    const events = new AppEventBus(0);
    const revisions: ReturnType<AppEventBus["getRevision"]>[] = [];
    events.subscribe((event) => revisions.push(event));
    const app = createApp(harness.database, harness.importer, harness.retention, events);

    const saved = await app.request("/api/rates/gpt-rate-only", {
      body: JSON.stringify({ cachedInputRate: 1, inputRate: 2, outputRate: 3 }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const backfill = await app.request("/api/rates/gpt-rate-only/backfill", { method: "POST" });

    expect(saved.status).toBe(200);
    expect(backfill.status).toBe(200);
    expect(revisions).toEqual([{ reason: "rate", revision: 1, scopes: ["catalog", "rates"] }]);
    harness.database.$client.close();
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-events-test-"));
  temporaryDirectories.push(directory);
  const sessionsDirectory = join(directory, "sessions");
  await mkdir(sessionsDirectory, { recursive: true });
  const databasePath = join(directory, "usage.db");
  const database = createDatabase(databasePath);
  migrateDatabase(database);
  return {
    database,
    importer: new SessionImporter(database, sessionsDirectory),
    retention: new RetentionService(database, databasePath, sessionsDirectory),
    sessionsDirectory,
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  const deadline = Date.now() + 3_000;
  while (!value.includes(needle) && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out reading SSE response")), 3_000),
      ),
    ]);
    if (result.done) break;
    value += decoder.decode(result.value, { stream: true });
  }
  return value;
}
