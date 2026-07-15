import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sql } from "drizzle-orm";

import { createDatabase, migrateDatabase, type AppDatabase } from "@/server/db/client";
import { importStates, sessions, usageEvents } from "@/server/db/schema";
import { SessionImporter } from "@/server/importer";
import { RetentionService } from "@/server/retention";
import { SourceInventory } from "@/server/source-inventory";
import type { ImportStatus } from "@/shared/types";

type PhaseResult = {
  contentBytesRead: number;
  contentFilesRead: number;
  directoryScans: number;
  durationMs: number;
  filesSkipped: number;
  heapAfterBytes: number;
  heapBeforeBytes: number;
  heapDeltaBytes: number;
  heapPeakBytes: number;
  rssAfterBytes: number;
  rssBeforeBytes: number;
  rssDeltaBytes: number;
  rssPeakBytes: number;
};

const options = parseOptions(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "codex-usage-benchmark-"));
const sessionsDirectory = join(root, "sessions");
const databasePath = join(root, "usage.db");
const sourceDirectory = join(sessionsDirectory, "2026", "07", "15");
let database: AppDatabase | null = null;
let importer: SessionImporter | null = null;

try {
  await mkdir(sourceDirectory, { recursive: true });
  const sources = await createFixtures(sourceDirectory, options.files);
  const coldLogicalBytes = sources.reduce((total, source) => total + source.bytes, 0);

  database = createDatabase(databasePath);
  migrateDatabase(database);
  const inventory = new SourceInventory(sessionsDirectory);
  importer = new SessionImporter(database, sessionsDirectory, {
    inventory,
    scanIntervalMs: 24 * 60 * 60 * 1_000,
  });
  const retention = new RetentionService(
    database,
    databasePath,
    sessionsDirectory,
    () => new Date(),
    inventory,
  );

  const cold = await measureSync(importer, inventory, coldLogicalBytes);
  const warm = await measureSync(importer, inventory, 0);

  const changedCount = Math.min(
    options.files,
    Math.max(0, Math.round((options.files * options.changedPercent) / 100)),
  );
  let appendBytes = 0;
  for (const [index, source] of sources.slice(0, changedCount).entries()) {
    const appended = `${tokenCount(index, 2)}\n`;
    appendBytes += Buffer.byteLength(appended);
    await appendFile(source.path, appended);
  }
  const append = await measureSync(importer, inventory, appendBytes);
  const countsAfterAppend = readExactCounts(database);
  if (cold.contentFilesRead !== options.files) {
    throw new Error(`Cold import read ${cold.contentFilesRead}/${options.files} JSONL files`);
  }
  if (warm.contentFilesRead !== 0) {
    throw new Error(`Warm inventory unexpectedly read ${warm.contentFilesRead} JSONL files`);
  }
  if (append.contentFilesRead !== changedCount) {
    throw new Error(
      `Append inventory read ${append.contentFilesRead}/${changedCount} changed files`,
    );
  }

  const scansBeforeStatus = inventory.getScanCount();
  const statusStartedAt = performance.now();
  const statusMemory = startMemorySampler();
  for (let index = 0; index < 10; index += 1) await retention.getStatus();
  const statusMemoryResult = statusMemory.stop();
  const statusRequests: PhaseResult = {
    contentBytesRead: 0,
    contentFilesRead: 0,
    directoryScans: inventory.getScanCount() - scansBeforeStatus,
    durationMs: round(performance.now() - statusStartedAt),
    filesSkipped: 0,
    ...statusMemoryResult,
  };
  if (statusRequests.directoryScans !== 0) {
    throw new Error("Storage status requests unexpectedly started a source inventory");
  }

  const deepStartedAt = performance.now();
  const deepMemory = startMemorySampler();
  const scansBeforeDeep = inventory.getScanCount();
  if (!importer.queueDeepSync()) throw new Error("Could not queue benchmark deep verification");
  await waitForDeepVerification(importer);
  const deepMemoryResult = deepMemory.stop();
  const deepStatus = importer.getStatus().sourceScan.lastCompleted;
  const deep: PhaseResult = {
    contentBytesRead: coldLogicalBytes + appendBytes,
    contentFilesRead: deepStatus?.filesRead ?? 0,
    directoryScans: inventory.getScanCount() - scansBeforeDeep,
    durationMs: round(performance.now() - deepStartedAt),
    filesSkipped: deepStatus?.filesSkipped ?? 0,
    ...deepMemoryResult,
  };
  const countsAfterDeep = readExactCounts(database);
  if (JSON.stringify(countsAfterDeep) !== JSON.stringify(countsAfterAppend)) {
    throw new Error("Deep verification totals differ from the incremental import totals");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        append,
        cold,
        configuration: {
          changedFiles: changedCount,
          changedPercent: options.changedPercent,
          files: options.files,
        },
        deep,
        exactCounts: countsAfterDeep,
        measurementNote:
          "contentBytesRead is logical JSONL data from import offsets; RSS/heap include the tsx benchmark harness and should be compared on the same machine.",
        statusRequests,
        warm,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await importer?.stop();
  database?.$client.close();
  await rm(root, { force: true, recursive: true });
}

async function measureSync(
  importer: SessionImporter,
  inventory: SourceInventory,
  contentBytesRead: number,
): Promise<PhaseResult> {
  const scansBefore = inventory.getScanCount();
  const memory = startMemorySampler();
  const startedAt = performance.now();
  const status = await importer.syncAll();
  const memoryResult = memory.stop();
  const scan = requireLastScan(status);
  return {
    contentBytesRead,
    contentFilesRead: scan.filesRead,
    directoryScans: inventory.getScanCount() - scansBefore,
    durationMs: round(performance.now() - startedAt),
    filesSkipped: scan.filesSkipped,
    ...memoryResult,
  };
}

async function createFixtures(
  directory: string,
  count: number,
): Promise<{ bytes: number; path: string }[]> {
  const fixtures: { bytes: number; path: string }[] = [];
  for (let start = 0; start < count; start += 64) {
    const batch = Array.from({ length: Math.min(64, count - start) }, async (_, offset) => {
      const index = start + offset;
      const path = join(directory, `rollout-${String(index).padStart(6, "0")}.jsonl`);
      const content = `${sessionMeta(index)}\n${turnContext(index)}\n${tokenCount(index, 1)}\n`;
      await writeFile(path, content);
      return { bytes: Buffer.byteLength(content), path };
    });
    fixtures.push(...(await Promise.all(batch)));
  }
  return fixtures;
}

function sessionMeta(index: number): string {
  return JSON.stringify({
    payload: {
      cwd: `/benchmark/project-${index % 10}`,
      id: `benchmark-session-${index}`,
      timestamp: "2026-07-15T00:00:00.000Z",
    },
    type: "session_meta",
  });
}

function turnContext(index: number): string {
  return JSON.stringify({
    payload: { model: `benchmark-model-${index % 3}` },
    timestamp: "2026-07-15T00:00:01.000Z",
    type: "turn_context",
  });
}

function tokenCount(index: number, sequence: number): string {
  return JSON.stringify({
    payload: {
      info: {
        last_token_usage: {
          cached_input_tokens: 50,
          input_tokens: 100 * sequence,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
        total_token_usage: {
          cached_input_tokens: 50 * sequence,
          input_tokens: 100 * sequence,
          output_tokens: 20 * sequence,
          reasoning_output_tokens: 5 * sequence,
        },
      },
      type: "token_count",
    },
    timestamp: `2026-07-15T00:${String(sequence).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    type: "event_msg",
  });
}

function readExactCounts(database: AppDatabase) {
  return {
    importStates: countRows(database, importStates),
    sessions: countRows(database, sessions),
    usageEvents: countRows(database, usageEvents),
  };
}

function countRows(
  database: AppDatabase,
  table: typeof importStates | typeof sessions | typeof usageEvents,
) {
  const row = database
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .get();
  return Number(row?.count ?? 0);
}

function requireLastScan(status: ImportStatus) {
  if (status.error) throw new Error(status.error);
  if (!status.sourceScan.lastCompleted) throw new Error("Importer did not publish scan telemetry");
  return status.sourceScan.lastCompleted;
}

async function waitForDeepVerification(importer: SessionImporter) {
  while (true) {
    const status = importer.getStatus();
    if (!status.sourceScan.deepQueued && status.sourceScan.current?.mode !== "deep") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function parseOptions(args: string[]) {
  let files = 5_000;
  let changedPercent = 1;
  const remaining = [...args];
  while (remaining.length > 0) {
    const name = remaining.shift();
    if (name === "--") {
      continue;
    }
    const value = remaining.shift();
    if (name === "--files" && value) {
      files = parseInteger(value, "--files", 1, 100_000);
    } else if (name === "--changed-percent" && value) {
      changedPercent = parseInteger(value, "--changed-percent", 0, 100);
    } else {
      throw new Error(`Unknown or incomplete benchmark argument: ${name ?? ""}`);
    }
  }
  return { changedPercent, files };
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function startMemorySampler() {
  const before = process.memoryUsage();
  let heapPeakBytes = before.heapUsed;
  let rssPeakBytes = before.rss;
  const sample = () => {
    const current = process.memoryUsage();
    heapPeakBytes = Math.max(heapPeakBytes, current.heapUsed);
    rssPeakBytes = Math.max(rssPeakBytes, current.rss);
    return current;
  };
  const timer = setInterval(sample, 10);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      const after = sample();
      return {
        heapAfterBytes: after.heapUsed,
        heapBeforeBytes: before.heapUsed,
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        heapPeakBytes,
        rssAfterBytes: after.rss,
        rssBeforeBytes: before.rss,
        rssDeltaBytes: after.rss - before.rss,
        rssPeakBytes,
      };
    },
  };
}
