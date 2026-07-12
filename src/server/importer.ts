import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { watch, type FSWatcher } from "chokidar";
import { and, eq, isNull } from "drizzle-orm";

import { backfillAllUnpricedUsage, reconcileUnknownModels } from "@/server/analytics";
import { TIME_ZONE } from "@/server/config";
import type { AppDatabase } from "@/server/db/client";
import {
  archivedUsageEventIds,
  importStates,
  modelRates,
  sessionAgents,
  sessions,
  usageEvents,
} from "@/server/db/schema";
import type { ImportStatus, TokenUsage } from "@/shared/types";

type JsonRecord = Record<string, unknown>;

type MutableImportState = {
  activeModel: string | null;
  agentId: string | null;
  sessionId: string | null;
};

type RateSnapshot = {
  cachedInputRate: number;
  inputRate: number;
  outputRate: number;
};

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: TIME_ZONE,
  year: "numeric",
});
const USAGE_DEDUPE_VERSION = 2;

export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;

  const inputTokens = toNonNegativeInteger(value["input_tokens"]);
  const cachedInputTokens = toNonNegativeInteger(value["cached_input_tokens"]);
  const outputTokens = toNonNegativeInteger(value["output_tokens"]);
  const reasoningOutputTokens = toNonNegativeInteger(value["reasoning_output_tokens"]);

  if (inputTokens === null || cachedInputTokens === null || outputTokens === null) return null;

  return {
    inputTokens,
    cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
    outputTokens,
    reasoningOutputTokens:
      reasoningOutputTokens === null ? 0 : Math.min(reasoningOutputTokens, outputTokens),
    totalTokens: inputTokens + outputTokens,
  };
}

export function toLocalDate(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const values = Object.fromEntries(
    DATE_PARTS.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const { day, month, year } = values;
  return day && month && year ? `${year}-${month}-${day}` : null;
}

export function calculateCost(usage: TokenUsage, rate: RateSnapshot): number {
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncachedInputTokens * rate.inputRate +
      usage.cachedInputTokens * rate.cachedInputRate +
      usage.outputTokens * rate.outputRate) /
    1_000_000
  );
}

export class SessionImporter {
  private readonly rateCache = new Map<string, RateSnapshot | null>();
  private readonly scheduledFiles = new Set<string>();
  private readonly sessionIndexPath: string;
  private sessionIndexRefreshScheduled = false;
  private queue: Promise<void> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  private status: ImportStatus = {
    error: null,
    filesProcessed: 0,
    isSyncing: false,
    lastSyncAt: null,
    recordsBackfilled: 0,
    recordsInserted: 0,
    recordsReclassified: 0,
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly sessionsDirectory: string,
  ) {
    this.sessionIndexPath = join(dirname(sessionsDirectory), "session_index.jsonl");
  }

  getStatus(): ImportStatus {
    return { ...this.status };
  }

  clearRateCache() {
    this.rateCache.clear();
  }

  start(): Promise<void> {
    if (this.watcher) return Promise.resolve();

    this.watcher = watch([this.sessionsDirectory, this.sessionIndexPath], {
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
      ignoreInitial: true,
    });
    this.watcher.on("add", (filePath) => {
      if (filePath === this.sessionIndexPath) {
        this.scheduleSessionIndexRefresh();
        return;
      }
      this.scheduleFile(filePath);
    });
    this.watcher.on("change", (filePath) => {
      if (filePath === this.sessionIndexPath) {
        this.scheduleSessionIndexRefresh();
        return;
      }
      this.scheduleFile(filePath);
    });

    void this.syncAll();
    return Promise.resolve();
  }

  async stop() {
    await this.watcher?.close();
    this.watcher = null;
  }

  syncAll(): Promise<ImportStatus> {
    return this.enqueue(async () => {
      this.beginSync();

      try {
        const files = await findSessionFiles(this.sessionsDirectory);
        this.prepareUsageHistoryForDeduplication();
        for (const filePath of files) {
          const inserted = await this.importFile(filePath);
          this.status.filesProcessed += 1;
          this.status.recordsInserted += inserted;
        }
        await this.refreshSessionTitles();
        this.reconcileUsage();
        this.refreshDeletedSources();
        this.status.lastSyncAt = new Date().toISOString();
      } catch (error) {
        this.status.error = errorMessage(error);
      } finally {
        this.status.isSyncing = false;
      }

      return this.getStatus();
    });
  }

  syncFile(filePath: string): Promise<number> {
    return this.enqueue(async () => {
      this.beginSync();
      try {
        const inserted = await this.importFile(filePath);
        this.status.filesProcessed += 1;
        this.status.recordsInserted += inserted;
        this.reconcileUsage();
        this.status.lastSyncAt = new Date().toISOString();
        return inserted;
      } catch (error) {
        this.status.error = errorMessage(error);
        return 0;
      } finally {
        this.status.isSyncing = false;
      }
    });
  }

  private beginSync() {
    this.status = {
      error: null,
      filesProcessed: 0,
      isSyncing: true,
      lastSyncAt: this.status.lastSyncAt,
      recordsBackfilled: 0,
      recordsInserted: 0,
      recordsReclassified: 0,
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const execution = this.queue.then(task, task);
    this.queue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private scheduleFile(filePath: string) {
    if (!filePath.endsWith(".jsonl") || this.scheduledFiles.has(filePath)) return;

    this.scheduledFiles.add(filePath);
    setTimeout(() => {
      this.scheduledFiles.delete(filePath);
      void this.syncFile(filePath);
    }, 350);
  }

  private scheduleSessionIndexRefresh() {
    if (this.sessionIndexRefreshScheduled) return;
    this.sessionIndexRefreshScheduled = true;
    setTimeout(() => {
      this.sessionIndexRefreshScheduled = false;
      void this.enqueue(async () => {
        this.beginSync();
        try {
          await this.refreshSessionTitles();
          this.status.lastSyncAt = new Date().toISOString();
        } catch (error) {
          this.status.error = errorMessage(error);
        } finally {
          this.status.isSyncing = false;
        }
      });
    }, 350);
  }

  private prepareUsageHistoryForDeduplication() {
    const states = this.database.select().from(importStates).all();
    if (
      states.length === 0 ||
      states.every((state) => state.dedupeVersion === USAGE_DEDUPE_VERSION)
    ) {
      return;
    }

    const hasDeletedSource = this.database
      .select()
      .from(sessions)
      .all()
      .some((session) => session.sourceDeleted);
    if (hasDeletedSource) {
      this.database
        .update(importStates)
        .set({ dedupeVersion: USAGE_DEDUPE_VERSION, updatedAt: Date.now() })
        .run();
      this.status.error =
        "Không thể rebuild usage legacy vì một số JSONL source đã bị xóa; history hiện có vẫn được giữ.";
      return;
    }

    this.database.delete(usageEvents).run();
    this.database.delete(importStates).run();
  }

  private reconcileUsage() {
    this.status.recordsReclassified += reconcileUnknownModels(this.database);
    this.status.recordsBackfilled += backfillAllUnpricedUsage(this.database);
  }

  private async importFile(filePath: string): Promise<number> {
    const fileInfo = await stat(filePath);
    const savedState = this.database
      .select()
      .from(importStates)
      .where(eq(importStates.sourcePath, filePath))
      .get();
    const needsAgentAttribution =
      savedState?.agentId === null || savedState?.dedupeVersion !== USAGE_DEDUPE_VERSION;
    const startOffset =
      savedState && savedState.lastOffset <= fileInfo.size && !needsAgentAttribution
        ? savedState.lastOffset
        : 0;
    const state: MutableImportState = {
      activeModel: startOffset === 0 ? null : (savedState?.activeModel ?? null),
      agentId: startOffset === 0 ? null : (savedState?.agentId ?? null),
      sessionId: startOffset === 0 ? null : (savedState?.sessionId ?? null),
    };
    let inserted = 0;

    const lastCompleteOffset = await readCompleteJsonLines(filePath, startOffset, (rawLine) => {
      inserted += this.handleLine(rawLine, filePath, state);
      return Promise.resolve();
    });

    this.database
      .insert(importStates)
      .values({
        activeModel: state.activeModel,
        agentId: state.agentId,
        dedupeVersion: USAGE_DEDUPE_VERSION,
        lastOffset: lastCompleteOffset,
        sessionId: state.sessionId,
        sourcePath: filePath,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: importStates.sourcePath,
        set: {
          activeModel: state.activeModel,
          agentId: state.agentId,
          dedupeVersion: USAGE_DEDUPE_VERSION,
          lastOffset: lastCompleteOffset,
          sessionId: state.sessionId,
          updatedAt: Date.now(),
        },
      })
      .run();

    return inserted;
  }

  private handleLine(rawLine: string, sourcePath: string, state: MutableImportState): number {
    if (
      !rawLine.includes('"session_meta"') &&
      !rawLine.includes('"turn_context"') &&
      !rawLine.includes('"user_message"') &&
      !rawLine.includes('"token_count"')
    ) {
      return 0;
    }

    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(rawLine);
      if (!isRecord(parsed)) return 0;
      record = parsed;
    } catch {
      return 0;
    }

    const payload = asRecord(record["payload"]);
    if (!payload) return 0;

    if (record["type"] === "session_meta") {
      const sessionId = asString(payload["session_id"]) ?? asString(payload["id"]);
      if (!sessionId) return 0;

      state.sessionId = sessionId;
      const agentId = asString(payload["id"]) ?? sessionId;
      state.agentId = agentId;
      const timestamp = asString(payload["timestamp"]) ?? asString(record["timestamp"]) ?? null;
      const parentThreadId = asString(payload["parent_thread_id"]);
      const threadSource =
        asString(payload["thread_source"]) ?? (parentThreadId ? "subagent" : "user");
      const source = asRecord(payload["source"]);
      const subagent = asRecord(source?.["subagent"]);
      const threadSpawn = asRecord(subagent?.["thread_spawn"]);
      const depth =
        toNonNegativeInteger(threadSpawn?.["depth"]) ?? (threadSource === "subagent" ? 1 : 0);
      const now = Date.now();
      this.database
        .insert(sessions)
        .values({
          cwd: asString(payload["cwd"]) ?? null,
          id: sessionId,
          lastSeenAt: now,
          sourceDeleted: false,
          sourcePath,
          startedAt: timestamp,
          title: null,
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            cwd: asString(payload["cwd"]) ?? null,
            lastSeenAt: now,
            sourceDeleted: false,
            ...(agentId === sessionId ? { sourcePath, startedAt: timestamp } : {}),
          },
        })
        .run();
      this.database
        .insert(sessionAgents)
        .values({
          depth,
          id: agentId,
          lastSeenAt: now,
          name: asString(payload["agent_nickname"]),
          parentThreadId,
          role: asString(payload["agent_role"]),
          sessionId,
          sourceDeleted: false,
          sourcePath,
          taskSummary: null,
          threadSource,
        })
        .onConflictDoUpdate({
          target: sessionAgents.id,
          set: {
            depth,
            lastSeenAt: now,
            name: asString(payload["agent_nickname"]),
            parentThreadId,
            role: asString(payload["agent_role"]),
            sessionId,
            sourceDeleted: false,
            sourcePath,
            threadSource,
          },
        })
        .run();
      return 0;
    }

    if (record["type"] === "turn_context") {
      state.activeModel = asString(payload["model"]) ?? state.activeModel;
      return 0;
    }

    if (record["type"] === "event_msg" && payload["type"] === "user_message") {
      this.captureTaskSummary(state, asString(payload["message"]));
      return 0;
    }

    if (record["type"] !== "event_msg" || payload["type"] !== "token_count" || !state.sessionId)
      return 0;

    const info = asRecord(payload["info"]);
    const usage = normalizeTokenUsage(info?.["last_token_usage"]);
    const timestamp = asString(record["timestamp"]);
    const localDate = timestamp ? toLocalDate(timestamp) : null;
    if (!usage || !timestamp || !localDate) return 0;

    const cumulativeUsage = normalizeTokenUsage(info?.["total_token_usage"]);
    const model = state.activeModel ?? "unknown";
    const agentId = state.agentId ?? state.sessionId;
    const sourceHash = createUsageFingerprint(rawLine, usage, cumulativeUsage);
    const eventId = createHash("sha256")
      .update(`${state.sessionId}\u0000${sourceHash}`)
      .digest("hex");
    const archived = this.database
      .select({ id: archivedUsageEventIds.id })
      .from(archivedUsageEventIds)
      .where(eq(archivedUsageEventIds.id, eventId))
      .get();
    if (archived) return 0;

    const rate = this.getRate(model);
    const usageEventValues = {
      agentId,
      cachedInputRate: rate?.cachedInputRate ?? null,
      cachedInputTokens: usage.cachedInputTokens,
      costUsd: rate ? calculateCost(usage, rate) : null,
      inputRate: rate?.inputRate ?? null,
      inputTokens: usage.inputTokens,
      localDate,
      model,
      outputRate: rate?.outputRate ?? null,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      timestamp,
      totalTokens: usage.totalTokens,
    };
    const result = this.database
      .insert(usageEvents)
      .values({
        createdAt: Date.now(),
        id: eventId,
        sessionId: state.sessionId,
        sourceHash,
        ...usageEventValues,
      })
      .onConflictDoNothing()
      .run();

    if (result.changes === 0) {
      const existing = this.database
        .select()
        .from(usageEvents)
        .where(
          and(eq(usageEvents.sessionId, state.sessionId), eq(usageEvents.sourceHash, sourceHash)),
        )
        .get();
      if (!existing || timestamp >= existing.timestamp) return 0;
      this.database
        .update(usageEvents)
        .set(usageEventValues)
        .where(eq(usageEvents.id, existing.id))
        .run();
    }

    return result.changes;
  }

  private getRate(model: string): RateSnapshot | null {
    if (this.rateCache.has(model)) return this.rateCache.get(model) ?? null;

    const rate = this.database.select().from(modelRates).where(eq(modelRates.model, model)).get();
    const snapshot = rate
      ? {
          cachedInputRate: rate.cachedInputRate,
          inputRate: rate.inputRate,
          outputRate: rate.outputRate,
        }
      : null;
    this.rateCache.set(model, snapshot);
    return snapshot;
  }

  private captureTaskSummary(state: MutableImportState, message: string | null) {
    if (!state.agentId || !state.sessionId || !message) return;
    const summary = summarizeTask(message);
    if (!summary) return;

    this.database
      .update(sessionAgents)
      .set({ taskSummary: summary })
      .where(and(eq(sessionAgents.id, state.agentId), isNull(sessionAgents.taskSummary)))
      .run();

    if (state.agentId !== state.sessionId) return;
    this.database
      .update(sessions)
      .set({ title: summary })
      .where(and(eq(sessions.id, state.sessionId), isNull(sessions.title)))
      .run();
  }

  private refreshDeletedSources() {
    for (const session of this.database.select().from(sessions).all()) {
      const sourceDeleted = !existsSync(session.sourcePath);
      if (sourceDeleted === session.sourceDeleted) continue;
      this.database
        .update(sessions)
        .set({ sourceDeleted })
        .where(eq(sessions.id, session.id))
        .run();
    }

    for (const agent of this.database.select().from(sessionAgents).all()) {
      const sourceDeleted = !existsSync(agent.sourcePath);
      if (sourceDeleted === agent.sourceDeleted) continue;
      this.database
        .update(sessionAgents)
        .set({ sourceDeleted })
        .where(eq(sessionAgents.id, agent.id))
        .run();
    }
  }

  private async refreshSessionTitles() {
    const titles = await readIndexedSessionTitles(this.sessionIndexPath);
    for (const [id, title] of titles) {
      this.database.update(sessions).set({ title }).where(eq(sessions.id, id)).run();
    }
  }
}

async function findSessionFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) return findSessionFiles(entryPath);
        return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
      }),
    );
    return nested.flat().sort();
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
}

async function readIndexedSessionTitles(filePath: string): Promise<Map<string, string>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return new Map();
    throw error;
  }

  const titles = new Map<string, { title: string; updatedAt: number }>();
  for (const rawLine of content.split("\n")) {
    try {
      const record: unknown = JSON.parse(rawLine);
      if (!isRecord(record)) continue;
      const id = asString(record["id"]);
      const title = asString(record["thread_name"])?.trim();
      if (!id || !title) continue;
      const updatedAt = Date.parse(asString(record["updated_at"]) ?? "") || 0;
      const previous = titles.get(id);
      if (!previous || updatedAt >= previous.updatedAt) titles.set(id, { title, updatedAt });
    } catch {
      // Session index records are append-only; an incomplete tail is retried on the next sync.
    }
  }

  return new Map([...titles].map(([id, value]) => [id, value.title]));
}

async function readCompleteJsonLines(
  filePath: string,
  offset: number,
  onLine: (line: string) => Promise<void>,
): Promise<number> {
  const stream = createReadStream(filePath, { start: offset });
  let pending = Buffer.alloc(0);
  let lastCompleteOffset = offset;

  for await (const chunk of stream) {
    const bytes = Buffer.concat([pending, chunk]);
    let cursor = 0;
    let newlineIndex = bytes.indexOf(0x0a, cursor);

    while (newlineIndex !== -1) {
      const line = bytes.subarray(cursor, newlineIndex).toString("utf8").replace(/\r$/, "");
      await onLine(line);
      lastCompleteOffset += newlineIndex + 1 - cursor;
      cursor = newlineIndex + 1;
      newlineIndex = bytes.indexOf(0x0a, cursor);
    }

    pending = bytes.subarray(cursor);
  }

  return lastCompleteOffset;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeTask(message: string): string | null {
  const request = message.split(/##\s*My request for Codex:\s*/i)[1] ?? message;
  const compact = request.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > 220 ? `${compact.slice(0, 217).trimEnd()}...` : compact;
}

function createUsageFingerprint(
  rawLine: string,
  lastUsage: TokenUsage,
  cumulativeUsage: TokenUsage | null,
): string {
  const value = cumulativeUsage ? JSON.stringify({ cumulativeUsage, lastUsage }) : rawLine;
  return createHash("sha256").update(value).digest("hex");
}

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown import error";
}
