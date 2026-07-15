import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";

import { watch, type FSWatcher } from "chokidar";
import { and, eq, isNull, sql } from "drizzle-orm";

import { parseActivityRecord, type ParsedActivityEvent } from "@/server/activity-parser";
import { backfillAllUnpricedUsage, reconcileUnknownModels } from "@/server/analytics";
import { TIME_ZONE } from "@/server/config";
import type { AppDatabase } from "@/server/db/client";
import {
  activityEvents,
  archivedActivityEventIds,
  archivedUsageEventIds,
  importDiagnostics,
  importStates,
  modelRates,
  sessionAgents,
  sessions,
  turnActivityRollups,
  turnBackfillState,
  turnModelUsage,
  turns,
  usageEvents,
} from "@/server/db/schema";
import { ensureProject } from "@/server/projects";
import {
  readSourceFileMetadata,
  sameSourceMetadata,
  SourceInventory,
  type SourceFileMetadata,
} from "@/server/source-inventory";
import { TURN_ATTRIBUTION_VERSION, TURN_BACKFILL_STATE_ID } from "@/server/turn-constants";
import type {
  ActivityKind,
  ImportStatus,
  SourceScanMode,
  SourceScanStatus,
  SourceScanTrigger,
  TokenUsage,
  TurnBackfillStatus,
  TurnStatus,
} from "@/shared/types";

type JsonRecord = Record<string, unknown>;

type MutableImportState = {
  activeModel: string | null;
  activeTurnKey: string | null;
  agentId: string | null;
  projectId: string | null;
  sessionContextWindow: number | null;
  sessionId: string | null;
};

type TurnLifecycle = {
  terminal: boolean;
  turnKey: string | null;
};

type TurnUsageInput = TokenUsage & {
  costUsd: number | null;
  model: string;
  timestamp: string;
};

type RateSnapshot = {
  cachedInputRate: number;
  inputRate: number;
  outputRate: number;
};

type CanonicalBoundary = {
  resolved: boolean;
  startLine: number;
};

type ParsedJsonLine = {
  malformed: boolean;
  rawLine: string;
  record: JsonRecord | null;
};

type LargeLineProjection = { kind: "ignored" } | { kind: "record"; record: JsonRecord };

type JsonStructureState = {
  complete: boolean;
  containerKinds: Uint8Array;
  depth: number;
  escaped: boolean;
  expectations: Uint8Array;
  invalid: boolean;
  literalIndex: number;
  numberState: number;
  tokenKind: number;
  unicodeDigits: number;
};

type ImportFileResult = {
  bytesRead: number;
  inserted: number;
};

type IndexedTitle = {
  title: string;
  updatedAt: number;
};

export type SessionImporterOptions = {
  inventory?: SourceInventory;
  now?: () => Date;
  scanIntervalMs?: number;
};

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: TIME_ZONE,
  year: "numeric",
});
const USAGE_DEDUPE_VERSION = 5;
const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1_000;

const EMPTY_TURN_BACKFILL: TurnBackfillStatus = {
  attributionVersion: TURN_ATTRIBUTION_VERSION,
  costAttributionMissingCount: 0,
  error: null,
  filesProcessed: 0,
  isRunning: false,
  lastRunAt: null,
  sourceDeletedGaps: 0,
  totalFiles: 0,
};

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
  private readonly activityResetAgents = new Set<string>();
  private readonly legacyArchivedUsageClaims = new Set<string>();
  private readonly rateCache = new Map<string, RateSnapshot | null>();
  private readonly fileTimers = new Map<string, NodeJS.Timeout>();
  private readonly inventory: SourceInventory;
  private readonly now: () => Date;
  private readonly scanIntervalMs: number;
  private readonly sessionIndexPath: string;
  private deepSyncPromise: Promise<ImportStatus> | null = null;
  private inventorySyncPromise: Promise<ImportStatus> | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private sessionIndexMetadata: SourceFileMetadata | null = null;
  private sessionIndexOffset = 0;
  private sessionIndexTimer: NodeJS.Timeout | null = null;
  private sessionIndexTitles = new Map<string, IndexedTitle>();
  private stopping = false;
  private watcher: FSWatcher | null = null;
  private status: ImportStatus = {
    error: null,
    filesProcessed: 0,
    isSyncing: false,
    lastSyncAt: null,
    recordsBackfilled: 0,
    recordsInserted: 0,
    recordsReclassified: 0,
    sourceScan: emptySourceScanStatus(),
    turnBackfill: EMPTY_TURN_BACKFILL,
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly sessionsDirectory: string,
    options: SessionImporterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.inventory = options.inventory ?? new SourceInventory(sessionsDirectory, this.now);
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.sessionIndexPath = join(dirname(sessionsDirectory), "session_index.jsonl");
    this.status.turnBackfill = this.readTurnBackfillStatus();
  }

  getStatus(): ImportStatus {
    return {
      ...this.status,
      sourceScan: cloneSourceScanStatus(this.status.sourceScan),
      turnBackfill: { ...this.status.turnBackfill },
    };
  }

  clearRateCache() {
    this.rateCache.clear();
  }

  start(): Promise<void> {
    if (this.watcher) return Promise.resolve();
    this.stopping = false;

    this.watcher = watch([this.sessionsDirectory, this.sessionIndexPath], {
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
      ignoreInitial: true,
    });
    const ready = new Promise<void>((resolve) => this.watcher?.once("ready", () => resolve()));
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
    this.watcher.on("unlink", (filePath) => {
      if (this.stopping) return;
      if (filePath === this.sessionIndexPath) {
        this.clearSessionIndexTimer();
        this.sessionIndexMetadata = null;
        this.sessionIndexOffset = 0;
        return;
      }
      this.clearFileTimer(filePath);
      void this.enqueue(() => Promise.resolve(this.markSourceDeleted(filePath)));
    });

    void this.requestInventory("startup");
    return ready;
  }

  async stop() {
    this.stopping = true;
    this.clearPeriodicTimer();
    this.clearSessionIndexTimer();
    for (const timer of this.fileTimers.values()) clearTimeout(timer);
    this.fileTimers.clear();
    await this.watcher?.close();
    this.watcher = null;
    await this.queue;
  }

  syncAll(): Promise<ImportStatus> {
    return this.requestInventory("manual");
  }

  queueDeepSync(): boolean {
    if (
      this.stopping ||
      this.deepSyncPromise ||
      this.status.sourceScan.deepQueued ||
      this.status.sourceScan.current?.mode === "deep"
    ) {
      return false;
    }

    this.clearPeriodicTimer();
    this.status.sourceScan.deepQueued = true;
    const execution = this.enqueue(async () => {
      this.status.sourceScan.deepQueued = false;
      return this.runFullSync("manual", "deep");
    });
    this.deepSyncPromise = execution;
    void execution.then(
      () => this.completeDeepRequest(execution),
      () => this.completeDeepRequest(execution),
    );
    return true;
  }

  syncFile(filePath: string): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    const savedState = this.database
      .select({ turnAttributionVersion: importStates.turnAttributionVersion })
      .from(importStates)
      .where(eq(importStates.sourcePath, filePath))
      .get();
    if (savedState && savedState.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION) {
      return this.requestInventory("scheduled").then((status) => status.recordsInserted);
    }

    return this.enqueue(async () => {
      this.beginSync();
      try {
        const metadata = await readSourceFileMetadata(filePath);
        if (!metadata) {
          this.markSourceDeleted(filePath);
          throw new Error(`ENOENT: no such source file, stat '${filePath}'`);
        }
        const { bytesRead, inserted } = await this.importFile(metadata);
        this.status.filesProcessed += 1;
        this.status.recordsInserted += inserted;
        if (bytesRead > 0) this.reconcileUsage();
        this.status.lastSyncAt = this.now().toISOString();
        return inserted;
      } catch (error) {
        this.status.error = errorMessage(error);
        return 0;
      } finally {
        this.status.isSyncing = false;
      }
    });
  }

  private requestInventory(trigger: SourceScanTrigger): Promise<ImportStatus> {
    if (this.stopping) return Promise.resolve(this.getStatus());
    if (trigger !== "scheduled") this.clearPeriodicTimer();
    if (this.deepSyncPromise) return this.deepSyncPromise;
    if (this.inventorySyncPromise) return this.inventorySyncPromise;

    const execution = this.enqueue(() => this.runFullSync(trigger, "inventory"));
    this.inventorySyncPromise = execution;
    void execution.then(
      () => this.completeInventoryRequest(execution),
      () => this.completeInventoryRequest(execution),
    );
    return execution;
  }

  private completeInventoryRequest(execution: Promise<ImportStatus>) {
    if (this.inventorySyncPromise === execution) this.inventorySyncPromise = null;
    if (!this.deepSyncPromise) this.scheduleNextInventory();
  }

  private completeDeepRequest(execution: Promise<ImportStatus>) {
    if (this.deepSyncPromise === execution) this.deepSyncPromise = null;
    this.status.sourceScan.deepQueued = false;
    this.scheduleNextInventory();
  }

  private async runFullSync(
    trigger: SourceScanTrigger,
    mode: SourceScanMode,
  ): Promise<ImportStatus> {
    this.beginSync();
    const startedAt = this.now();
    this.status.sourceScan.current = {
      discoveredFiles: 0,
      filesRead: 0,
      filesSkipped: 0,
      mode,
      phase: "discovering",
      startedAt: startedAt.toISOString(),
      trigger,
    };

    try {
      const snapshot = await this.inventory.refresh();
      const files = snapshot.files.map((file) => file.path);
      const availablePaths = new Set(files);
      const currentScan = this.status.sourceScan.current;
      if (!currentScan) throw new Error("Source scan state was cleared unexpectedly");
      currentScan.discoveredFiles = files.length;
      currentScan.phase = "reading";
      this.status.filesProcessed = files.length;

      const usageRepairRequired = this.prepareUsageHistoryForDeduplication(files);
      const turnBackfill = this.prepareTurnAttribution(files);
      const repairRequired = usageRepairRequired || turnBackfill.required;
      if (
        turnBackfill.required ||
        this.status.turnBackfill.isRunning ||
        this.status.turnBackfill.error !== null ||
        this.status.turnBackfill.sourceDeletedGaps > 0 ||
        this.status.turnBackfill.attributionVersion !== TURN_ATTRIBUTION_VERSION
      ) {
        this.beginTurnBackfill(files.length, turnBackfill.sourceDeletedGaps);
      }

      for (const metadata of snapshot.files) {
        if (mode === "inventory" && !repairRequired && this.canSkipFile(metadata)) {
          currentScan.filesSkipped += 1;
          continue;
        }
        const result = await this.importFile(metadata, mode === "deep");
        currentScan.filesRead += 1;
        this.status.recordsInserted += result.inserted;
        if (this.status.turnBackfill.isRunning) this.advanceTurnBackfill();
      }

      currentScan.phase = "reconciling";
      await this.refreshSessionTitles(mode === "deep");
      if (currentScan.filesRead > 0 || repairRequired) this.reconcileUsage();
      this.refreshDeletedSources(availablePaths);
      if (this.status.turnBackfill.isRunning) this.finishTurnBackfill(null);
      const completedAt = this.now();
      this.status.lastSyncAt = completedAt.toISOString();
      this.status.sourceScan.lastCompleted = {
        completedAt: completedAt.toISOString(),
        discoveredFiles: currentScan.discoveredFiles,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        filesRead: currentScan.filesRead,
        filesSkipped: currentScan.filesSkipped,
        mode,
        sourceBytes: snapshot.sourceBytes,
        trigger,
      };
    } catch (error) {
      this.status.error = errorMessage(error);
      if (this.status.turnBackfill.isRunning) this.finishTurnBackfill(this.status.error);
    } finally {
      this.status.sourceScan.current = null;
      this.status.isSyncing = false;
    }

    return this.getStatus();
  }

  private beginSync() {
    this.activityResetAgents.clear();
    this.legacyArchivedUsageClaims.clear();
    this.status = {
      error: null,
      filesProcessed: 0,
      isSyncing: true,
      lastSyncAt: this.status.lastSyncAt,
      recordsBackfilled: 0,
      recordsInserted: 0,
      recordsReclassified: 0,
      sourceScan: cloneSourceScanStatus(this.status.sourceScan),
      turnBackfill: this.readTurnBackfillStatus(),
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
    if (this.stopping || !filePath.endsWith(".jsonl") || this.fileTimers.has(filePath)) return;

    const timer = setTimeout(() => {
      this.fileTimers.delete(filePath);
      if (this.stopping) return;
      void this.syncFile(filePath);
    }, 350);
    this.fileTimers.set(filePath, timer);
  }

  private scheduleSessionIndexRefresh() {
    if (this.stopping || this.sessionIndexTimer) return;
    this.sessionIndexTimer = setTimeout(() => {
      this.sessionIndexTimer = null;
      if (this.stopping) return;
      void this.enqueue(async () => {
        this.beginSync();
        try {
          await this.refreshSessionTitles(false);
          this.status.lastSyncAt = this.now().toISOString();
        } catch (error) {
          this.status.error = errorMessage(error);
        } finally {
          this.status.isSyncing = false;
        }
      });
    }, 350);
  }

  private clearFileTimer(filePath: string) {
    const timer = this.fileTimers.get(filePath);
    if (timer) clearTimeout(timer);
    this.fileTimers.delete(filePath);
  }

  private clearSessionIndexTimer() {
    if (this.sessionIndexTimer) clearTimeout(this.sessionIndexTimer);
    this.sessionIndexTimer = null;
  }

  private clearPeriodicTimer() {
    if (this.periodicTimer) clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
    this.status.sourceScan.nextScheduledAt = null;
  }

  private scheduleNextInventory() {
    if (this.stopping) return;
    this.clearPeriodicTimer();
    const nextAt = new Date(this.now().getTime() + this.scanIntervalMs);
    this.status.sourceScan.nextScheduledAt = nextAt.toISOString();
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = null;
      this.status.sourceScan.nextScheduledAt = null;
      if (!this.stopping) void this.requestInventory("scheduled");
    }, this.scanIntervalMs);
    this.periodicTimer.unref();
  }

  private prepareUsageHistoryForDeduplication(files: string[]): boolean {
    const states = this.database.select().from(importStates).all();
    if (
      states.length === 0 ||
      states.every((state) => state.dedupeVersion === USAGE_DEDUPE_VERSION)
    ) {
      return false;
    }

    const availablePaths = new Set(files);
    const availableStates = states.filter((state) => availablePaths.has(state.sourcePath));
    const unavailableStates = states.filter((state) => !availablePaths.has(state.sourcePath));
    const now = Date.now();

    for (const state of availableStates) {
      this.database
        .update(importStates)
        .set({
          activeModel: null,
          agentId: null,
          dedupeVersion: USAGE_DEDUPE_VERSION - 1,
          lastOffset: 0,
          sessionId: null,
          updatedAt: now,
        })
        .where(eq(importStates.sourcePath, state.sourcePath))
        .run();
    }

    for (const state of unavailableStates) {
      this.database
        .update(importStates)
        .set({ dedupeVersion: USAGE_DEDUPE_VERSION, updatedAt: now })
        .where(eq(importStates.sourcePath, state.sourcePath))
        .run();
    }

    if (unavailableStates.length > 0) {
      console.warn(
        `Bỏ qua attribution repair cho ${unavailableStates.length} JSONL source đã bị xóa; history hiện có vẫn được giữ.`,
      );
    }
    return true;
  }

  private prepareTurnAttribution(files: string[]) {
    const states = this.database.select().from(importStates).all();
    const outdated = states.filter(
      (state) => state.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION,
    );
    if (outdated.length === 0) return { required: false, sourceDeletedGaps: 0 };

    const availablePaths = new Set(files);
    const available = outdated.filter((state) => availablePaths.has(state.sourcePath));
    const unavailable = outdated.filter((state) => !availablePaths.has(state.sourcePath));
    const now = Date.now();

    for (const state of available) {
      this.database
        .update(importStates)
        .set({
          activeModel: null,
          activeTurnKey: null,
          agentId: null,
          lastOffset: 0,
          sessionContextWindow: null,
          sessionId: null,
          turnAttributionVersion: TURN_ATTRIBUTION_VERSION - 1,
          updatedAt: now,
        })
        .where(eq(importStates.sourcePath, state.sourcePath))
        .run();
    }

    for (const state of unavailable) {
      const agentIds = this.database
        .select({ id: sessionAgents.id })
        .from(sessionAgents)
        .where(eq(sessionAgents.sourcePath, state.sourcePath))
        .all();
      for (const agent of agentIds) {
        this.database
          .update(usageEvents)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION })
          .where(eq(usageEvents.agentId, agent.id))
          .run();
        this.database
          .update(activityEvents)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION })
          .where(eq(activityEvents.agentId, agent.id))
          .run();
      }
      this.database
        .update(importStates)
        .set({ activeTurnKey: null, updatedAt: now })
        .where(eq(importStates.sourcePath, state.sourcePath))
        .run();
    }

    return {
      required: available.length > 0 || unavailable.length > 0,
      sourceDeletedGaps: unavailable.length,
    };
  }

  private readTurnBackfillStatus(): TurnBackfillStatus {
    const value = this.database
      .select()
      .from(turnBackfillState)
      .where(eq(turnBackfillState.id, TURN_BACKFILL_STATE_ID))
      .get();
    if (!value) return { ...EMPTY_TURN_BACKFILL };
    return {
      attributionVersion: value.attributionVersion,
      costAttributionMissingCount: value.costAttributionMissingCount,
      error: value.error,
      filesProcessed: value.filesProcessed,
      isRunning: value.isRunning,
      lastRunAt: value.lastRunAt ? new Date(value.lastRunAt).toISOString() : null,
      sourceDeletedGaps: value.sourceDeletedGaps,
      totalFiles: value.totalFiles,
    };
  }

  private beginTurnBackfill(totalFiles: number, sourceDeletedGaps: number) {
    const now = Date.now();
    this.database
      .insert(turnBackfillState)
      .values({
        attributionVersion: TURN_ATTRIBUTION_VERSION,
        costAttributionMissingCount: 0,
        error: null,
        filesProcessed: 0,
        id: TURN_BACKFILL_STATE_ID,
        isRunning: true,
        lastRunAt: now,
        sourceDeletedGaps,
        totalFiles,
      })
      .onConflictDoUpdate({
        target: turnBackfillState.id,
        set: {
          attributionVersion: TURN_ATTRIBUTION_VERSION,
          costAttributionMissingCount: 0,
          error: null,
          filesProcessed: 0,
          isRunning: true,
          lastRunAt: now,
          sourceDeletedGaps,
          totalFiles,
        },
      })
      .run();
    this.status.turnBackfill = this.readTurnBackfillStatus();
  }

  private advanceTurnBackfill() {
    this.database
      .update(turnBackfillState)
      .set({ filesProcessed: this.status.turnBackfill.filesProcessed + 1 })
      .where(eq(turnBackfillState.id, TURN_BACKFILL_STATE_ID))
      .run();
    this.status.turnBackfill = this.readTurnBackfillStatus();
  }

  private finishTurnBackfill(error: string | null) {
    const missing = this.database
      .select({
        count: sql<number>`coalesce(sum(${turnModelUsage.costAttributionMissingCount}), 0)`,
      })
      .from(turnModelUsage)
      .get();
    this.database
      .update(turnBackfillState)
      .set({
        attributionVersion: TURN_ATTRIBUTION_VERSION,
        costAttributionMissingCount: Number(missing?.count ?? 0),
        error,
        isRunning: false,
        lastRunAt: Date.now(),
      })
      .where(eq(turnBackfillState.id, TURN_BACKFILL_STATE_ID))
      .run();
    this.status.turnBackfill = this.readTurnBackfillStatus();
  }

  private reconcileUsage() {
    this.status.recordsReclassified += reconcileUnknownModels(this.database);
    this.status.recordsBackfilled += backfillAllUnpricedUsage(this.database);
  }

  private canSkipFile(metadata: SourceFileMetadata): boolean {
    if (this.status.turnBackfill.isRunning) return false;
    const savedState = this.database
      .select()
      .from(importStates)
      .where(eq(importStates.sourcePath, metadata.path))
      .get();
    if (!savedState) return false;
    if (
      savedState.agentId === null ||
      savedState.dedupeVersion !== USAGE_DEDUPE_VERSION ||
      savedState.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION ||
      savedState.lastOffset !== metadata.size ||
      !sameSourceMetadata(metadata, savedState)
    ) {
      return false;
    }
    const diagnostic = this.database
      .select()
      .from(importDiagnostics)
      .where(eq(importDiagnostics.sourcePath, metadata.path))
      .get();
    return diagnostic?.lastError === null && !diagnostic.incompleteLine;
  }

  private async importFile(
    metadata: SourceFileMetadata,
    forceFromStart = false,
  ): Promise<ImportFileResult> {
    const filePath = metadata.path;
    const savedState = this.database
      .select()
      .from(importStates)
      .where(eq(importStates.sourcePath, filePath))
      .get();
    const needsAgentAttribution =
      savedState?.agentId === null ||
      savedState?.dedupeVersion !== USAGE_DEDUPE_VERSION ||
      savedState?.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION;
    const hasSavedMetadata =
      savedState?.sourceSize !== null &&
      savedState?.sourceSize !== undefined &&
      savedState.sourceMtimeNs !== null &&
      savedState.sourceCtimeNs !== null;
    const sameIdentity = savedState?.sourceFileId === metadata.fileId;
    const exactMetadata = savedState ? sameSourceMetadata(metadata, savedState) : false;
    const grewInPlace =
      hasSavedMetadata &&
      sameIdentity &&
      savedState !== undefined &&
      metadata.size > savedState.sourceSize!;
    const safeLegacyResume =
      !hasSavedMetadata && savedState !== undefined && savedState.lastOffset <= metadata.size;
    const startOffset =
      !forceFromStart &&
      !needsAgentAttribution &&
      savedState &&
      savedState.lastOffset <= metadata.size &&
      (exactMetadata || grewInPlace || safeLegacyResume)
        ? savedState.lastOffset
        : 0;
    const canonicalBoundary =
      startOffset === 0 ? await findCanonicalBoundary(filePath) : { resolved: true, startLine: 0 };
    const savedSession =
      startOffset > 0 && savedState?.sessionId
        ? this.database
            .select({ projectId: sessions.projectId })
            .from(sessions)
            .where(eq(sessions.id, savedState.sessionId))
            .get()
        : null;
    const state: MutableImportState = {
      activeModel: startOffset === 0 ? null : (savedState?.activeModel ?? null),
      activeTurnKey: startOffset === 0 ? null : (savedState?.activeTurnKey ?? null),
      agentId: startOffset === 0 ? null : (savedState?.agentId ?? null),
      projectId: startOffset === 0 ? null : (savedSession?.projectId ?? null),
      sessionContextWindow: startOffset === 0 ? null : (savedState?.sessionContextWindow ?? null),
      sessionId: startOffset === 0 ? null : (savedState?.sessionId ?? null),
    };
    let inserted = 0;
    let lineIndex = 0;
    let activityResetPending =
      savedState !== undefined && savedState.dedupeVersion !== USAGE_DEDUPE_VERSION;
    const previousDiagnostic = this.database
      .select()
      .from(importDiagnostics)
      .where(eq(importDiagnostics.sourcePath, filePath))
      .get();
    let malformedLines = startOffset === 0 ? 0 : (previousDiagnostic?.malformedLines ?? 0);
    let readResult: CompleteJsonLinesResult;

    try {
      readResult = await readCompleteJsonLines(filePath, startOffset, (line) => {
        if (line.malformed) malformedLines += 1;
        inserted += this.handleLine(
          line,
          filePath,
          state,
          lineIndex >= canonicalBoundary.startLine,
          activityResetPending,
        );
        if (state.agentId && activityResetPending) activityResetPending = false;
        lineIndex += 1;
        return Promise.resolve();
      });
    } catch (error) {
      this.saveImportDiagnostic(filePath, malformedLines, false, errorMessage(error));
      throw error;
    }

    this.saveImportDiagnostic(filePath, malformedLines, readResult.incompleteLine, null);

    const currentMetadata = await readSourceFileMetadata(filePath);
    const metadataToSave =
      currentMetadata && sourceMetadataEquals(currentMetadata, metadata)
        ? currentMetadata
        : metadata;
    const nextState = {
      activeModel: state.activeModel,
      activeTurnKey: state.activeTurnKey,
      agentId: state.agentId,
      dedupeVersion: USAGE_DEDUPE_VERSION,
      lastOffset: canonicalBoundary.resolved ? readResult.lastCompleteOffset : 0,
      sessionContextWindow: state.sessionContextWindow,
      sessionId: state.sessionId,
      sourceCtimeNs: metadataToSave.ctimeNs,
      sourceFileId: metadataToSave.fileId,
      sourceMtimeNs: metadataToSave.mtimeNs,
      sourceSize: metadataToSave.size,
      turnAttributionVersion: TURN_ATTRIBUTION_VERSION,
      updatedAt: Date.now(),
    };

    this.database
      .insert(importStates)
      .values({
        ...nextState,
        sourcePath: filePath,
      })
      .onConflictDoUpdate({
        target: importStates.sourcePath,
        set: nextState,
      })
      .run();

    return { bytesRead: Math.max(0, metadata.size - startOffset), inserted };
  }

  private handleLine(
    line: ParsedJsonLine,
    sourcePath: string,
    state: MutableImportState,
    isCanonicalLine: boolean,
    resetActivityForAgent: boolean,
  ): number {
    const { rawLine, record } = line;
    if (!record) return 0;

    const payload = asRecord(record["payload"]);
    if (!payload) return 0;

    if (record["type"] === "session_meta") {
      // A legacy subagent JSONL can embed the parent session metadata immediately after its
      // own metadata. The first session_meta identifies the physical file owner; inherited
      // metadata is context and must never move subsequent usage back to the main agent.
      if (state.sessionId !== null) return 0;

      const sessionId = asString(payload["session_id"]) ?? asString(payload["id"]);
      if (!sessionId) return 0;

      state.sessionId = sessionId;
      state.sessionContextWindow = toNonNegativeInteger(payload["context_window"]);
      const agentId = asString(payload["id"]) ?? sessionId;
      state.agentId = agentId;
      if (resetActivityForAgent && !this.activityResetAgents.has(agentId)) {
        this.database.delete(activityEvents).where(eq(activityEvents.agentId, agentId)).run();
        this.activityResetAgents.add(agentId);
      }
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
      const cwd = asString(payload["cwd"]);
      const existingSession = this.database
        .select({ cwd: sessions.cwd, projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      const projectId =
        agentId !== sessionId && existingSession
          ? (existingSession.projectId ?? ensureProject(this.database, existingSession.cwd ?? cwd))
          : ensureProject(this.database, cwd);
      state.projectId = projectId;
      this.database
        .insert(sessions)
        .values({
          cwd,
          id: sessionId,
          lastSeenAt: now,
          projectId,
          sourceDeleted: false,
          sourcePath,
          startedAt: timestamp,
          title: null,
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            lastSeenAt: now,
            sourceDeleted: false,
            ...(agentId === sessionId ? { cwd, projectId, sourcePath, startedAt: timestamp } : {}),
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

    if (!isCanonicalLine) return 0;

    const lifecycle = this.captureTurnLifecycle(record, payload, state);
    const attributionTurnKey = this.resolveRecordTurnKey(record, payload, state, lifecycle.turnKey);
    this.insertActivity(record, state, attributionTurnKey);
    if (lifecycle.terminal && lifecycle.turnKey === state.activeTurnKey) {
      state.activeTurnKey = null;
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
    const sourceHash = createUsageFingerprint(rawLine, usage, cumulativeUsage, agentId, model);
    const eventId = createHash("sha256")
      .update(`${state.sessionId}\u0000${sourceHash}`)
      .digest("hex");
    const legacySourceHash = createLegacyUsageFingerprint(rawLine, usage, cumulativeUsage);
    const legacyEventId = createHash("sha256")
      .update(`${state.sessionId}\u0000${legacySourceHash}`)
      .digest("hex");
    const archived = this.database
      .select()
      .from(archivedUsageEventIds)
      .where(eq(archivedUsageEventIds.id, eventId))
      .get();
    if (archived) {
      this.attributeArchivedUsage(archived, attributionTurnKey, usage, model, timestamp);
      return 0;
    }
    const currentEvent = this.database
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, eventId))
      .get();
    const legacyArchived = this.database
      .select()
      .from(archivedUsageEventIds)
      .where(eq(archivedUsageEventIds.id, legacyEventId))
      .get();
    if (legacyArchived && !currentEvent && !this.legacyArchivedUsageClaims.has(legacyEventId)) {
      this.legacyArchivedUsageClaims.add(legacyEventId);
      this.database
        .insert(archivedUsageEventIds)
        .values({
          archivedAt: legacyArchived.archivedAt,
          id: eventId,
          turnAttributionVersion: legacyArchived.turnAttributionVersion,
          turnKey: legacyArchived.turnKey,
        })
        .onConflictDoNothing()
        .run();
      const migratedArchive = this.database
        .select()
        .from(archivedUsageEventIds)
        .where(eq(archivedUsageEventIds.id, eventId))
        .get();
      if (migratedArchive) {
        this.attributeArchivedUsage(migratedArchive, attributionTurnKey, usage, model, timestamp);
      }
      return 0;
    }

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
    if (currentEvent) {
      const needsRepair =
        currentEvent.agentId !== agentId ||
        currentEvent.cachedInputTokens !== usage.cachedInputTokens ||
        currentEvent.inputTokens !== usage.inputTokens ||
        currentEvent.localDate !== localDate ||
        currentEvent.model !== model ||
        currentEvent.outputTokens !== usage.outputTokens ||
        currentEvent.reasoningOutputTokens !== usage.reasoningOutputTokens ||
        currentEvent.sourceHash !== sourceHash ||
        timestamp < currentEvent.timestamp ||
        currentEvent.totalTokens !== usage.totalTokens;
      if (needsRepair) {
        const repaired = this.database.$client.transaction(() => {
          const isAttributed =
            currentEvent.turnKey !== null &&
            currentEvent.turnAttributionVersion === TURN_ATTRIBUTION_VERSION;
          if (isAttributed && currentEvent.turnKey) {
            this.applyTurnUsage(
              currentEvent.turnKey,
              turnUsageInputFromEvent(currentEvent),
              false,
              -1,
            );
          }
          const result = this.database
            .update(usageEvents)
            .set({
              agentId,
              cachedInputTokens: usage.cachedInputTokens,
              inputTokens: usage.inputTokens,
              localDate,
              model,
              outputTokens: usage.outputTokens,
              reasoningOutputTokens: usage.reasoningOutputTokens,
              sourceHash,
              ...(timestamp < currentEvent.timestamp ? { timestamp } : {}),
              totalTokens: usage.totalTokens,
            })
            .where(eq(usageEvents.id, eventId))
            .run();
          const updated = this.database
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.id, eventId))
            .get();
          if (isAttributed && currentEvent.turnKey && updated) {
            const input = turnUsageInputFromEvent(updated);
            this.applyTurnUsage(currentEvent.turnKey, input, false, 1);
            this.updateTurnContext(currentEvent.turnKey, input);
          }
          return result;
        })();
        this.status.recordsReclassified += repaired.changes;
      }
      this.attributeRawUsage(eventId, attributionTurnKey);
      return 0;
    }
    const legacyEvent = this.database
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, legacyEventId))
      .get();
    if (legacyEvent) {
      const migrated = this.database.$client.transaction(() => {
        const isAttributed =
          legacyEvent.turnKey !== null &&
          legacyEvent.turnAttributionVersion === TURN_ATTRIBUTION_VERSION;
        if (isAttributed && legacyEvent.turnKey) {
          this.applyTurnUsage(legacyEvent.turnKey, turnUsageInputFromEvent(legacyEvent), false, -1);
        }
        const result = this.database
          .update(usageEvents)
          .set({
            agentId,
            cachedInputTokens: usage.cachedInputTokens,
            id: eventId,
            inputTokens: usage.inputTokens,
            localDate,
            model,
            outputTokens: usage.outputTokens,
            reasoningOutputTokens: usage.reasoningOutputTokens,
            sourceHash,
            timestamp,
            totalTokens: usage.totalTokens,
          })
          .where(eq(usageEvents.id, legacyEventId))
          .run();
        const updated = this.database
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.id, eventId))
          .get();
        if (isAttributed && legacyEvent.turnKey && updated) {
          const input = turnUsageInputFromEvent(updated);
          this.applyTurnUsage(legacyEvent.turnKey, input, false, 1);
          this.updateTurnContext(legacyEvent.turnKey, input);
        }
        return result;
      })();
      this.status.recordsReclassified += migrated.changes;
      this.attributeRawUsage(eventId, attributionTurnKey);
      return 0;
    }
    const result = this.database
      .insert(usageEvents)
      .values({
        createdAt: Date.now(),
        id: eventId,
        sessionId: state.sessionId,
        sourceHash,
        turnAttributionVersion: 0,
        turnKey: null,
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
      if (!existing) return 0;
      if (timestamp < existing.timestamp) {
        this.database
          .update(usageEvents)
          .set({ localDate, timestamp })
          .where(eq(usageEvents.id, existing.id))
          .run();
      }
      this.attributeRawUsage(existing.id, attributionTurnKey);
    }

    if (result.changes > 0) this.attributeRawUsage(eventId, attributionTurnKey);

    return result.changes;
  }

  private captureTurnLifecycle(
    record: JsonRecord,
    payload: JsonRecord,
    state: MutableImportState,
  ): TurnLifecycle {
    if (!state.sessionId || !state.agentId) return { terminal: false, turnKey: null };

    const recordType = asString(record["type"]);
    const payloadType = asString(payload["type"]);
    const isContext = recordType === "turn_context";
    const isStart = isContext || (recordType === "event_msg" && payloadType === "task_started");
    const terminalStatus: TurnStatus | null =
      recordType === "event_msg" && payloadType === "task_complete"
        ? "completed"
        : recordType === "event_msg" && payloadType === "turn_aborted"
          ? "aborted"
          : null;
    if (!isStart && !terminalStatus) return { terminal: false, turnKey: null };

    const explicitTurnId = readExplicitTurnId(record, payload);
    if (!explicitTurnId) return { terminal: terminalStatus !== null, turnKey: null };
    const turnKey = createTurnKey(state.agentId, explicitTurnId);
    if (
      terminalStatus &&
      !this.database.select({ id: turns.id }).from(turns).where(eq(turns.id, turnKey)).get()
    ) {
      return { terminal: true, turnKey: null };
    }
    const recordTimestamp = asTimestamp(record["timestamp"]);
    const startedAt =
      isStart && payloadType === "task_started"
        ? (asTimestamp(payload["started_at"]) ?? recordTimestamp)
        : isContext
          ? recordTimestamp
          : null;
    const completedAt = terminalStatus
      ? (asTimestamp(payload["completed_at"]) ?? recordTimestamp)
      : null;
    const eventAt = startedAt ?? completedAt ?? recordTimestamp;
    if (!eventAt) return { terminal: terminalStatus !== null, turnKey: null };

    this.upsertTurn({
      agentId: state.agentId,
      collaborationMode: readCollaborationMode(payload),
      completedAt,
      durationMs: toNonNegativeNumber(payload["duration_ms"]),
      effort:
        asString(payload["effort"]) ??
        asString(payload["reasoning_effort"]) ??
        asString(asRecord(payload["reasoning"])?.["effort"]),
      eventAt,
      modelContextWindow:
        toNonNegativeInteger(payload["model_context_window"]) ?? state.sessionContextWindow,
      projectId: state.projectId,
      sessionId: state.sessionId,
      startedAt,
      status: terminalStatus ?? "unknown",
      timeToFirstTokenMs: toNonNegativeNumber(payload["time_to_first_token_ms"]),
      turnId: explicitTurnId,
      turnKey,
    });

    if (isStart) state.activeTurnKey = turnKey;
    return { terminal: terminalStatus !== null, turnKey };
  }

  private resolveRecordTurnKey(
    record: JsonRecord,
    payload: JsonRecord,
    state: MutableImportState,
    lifecycleTurnKey: string | null,
  ): string | null {
    const explicitTurnId = readExplicitTurnId(record, payload);
    if (!explicitTurnId) return lifecycleTurnKey ?? state.activeTurnKey;
    if (!state.agentId) return null;
    const turnKey = createTurnKey(state.agentId, explicitTurnId);
    return this.database.select({ id: turns.id }).from(turns).where(eq(turns.id, turnKey)).get()
      ? turnKey
      : null;
  }

  private upsertTurn(value: {
    agentId: string;
    collaborationMode: string | null;
    completedAt: string | null;
    durationMs: number | null;
    effort: string | null;
    eventAt: string;
    modelContextWindow: number | null;
    projectId: string | null;
    sessionId: string;
    startedAt: string | null;
    status: TurnStatus;
    timeToFirstTokenMs: number | null;
    turnId: string;
    turnKey: string;
  }) {
    const existing = this.database.select().from(turns).where(eq(turns.id, value.turnKey)).get();
    const now = Date.now();
    const localDate = toLocalDate(value.startedAt ?? value.eventAt);
    if (!localDate) return;

    if (!existing) {
      this.database
        .insert(turns)
        .values({
          agentId: value.agentId,
          collaborationMode: value.collaborationMode,
          completedAt: value.completedAt,
          createdAt: now,
          durationMs: value.durationMs ?? durationBetween(value.startedAt, value.completedAt),
          effort: value.effort,
          id: value.turnKey,
          lastEventAt: value.eventAt,
          localDate,
          modelContextWindow: value.modelContextWindow,
          projectId: value.projectId,
          sessionId: value.sessionId,
          startedAt: value.startedAt,
          status: value.status,
          timeToFirstTokenMs: value.timeToFirstTokenMs,
          turnId: value.turnId,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      return;
    }

    const startedAt = earlierTimestamp(existing.startedAt, value.startedAt);
    const shouldApplyTerminal =
      value.status !== "unknown" &&
      (!existing.completedAt || !value.completedAt || value.completedAt >= existing.completedAt);
    this.database
      .update(turns)
      .set({
        collaborationMode: value.collaborationMode ?? existing.collaborationMode,
        completedAt: shouldApplyTerminal ? value.completedAt : existing.completedAt,
        durationMs:
          value.durationMs ??
          durationBetween(startedAt ?? existing.startedAt, value.completedAt) ??
          existing.durationMs,
        effort: value.effort ?? existing.effort,
        lastEventAt: laterTimestamp(existing.lastEventAt, value.eventAt),
        localDate:
          toLocalDate(startedAt ?? existing.startedAt ?? value.eventAt) ?? existing.localDate,
        modelContextWindow: value.modelContextWindow ?? existing.modelContextWindow,
        projectId: value.projectId ?? existing.projectId,
        startedAt,
        status: shouldApplyTerminal ? value.status : existing.status,
        timeToFirstTokenMs: value.timeToFirstTokenMs ?? existing.timeToFirstTokenMs,
        updatedAt: now,
      })
      .where(eq(turns.id, value.turnKey))
      .run();
  }

  private attributeRawUsage(eventId: string, turnKey: string | null) {
    this.database.$client.transaction(() => {
      this.attributeRawUsageInTransaction(eventId, turnKey);
    })();
  }

  private attributeRawUsageInTransaction(eventId: string, turnKey: string | null) {
    const event = this.database.select().from(usageEvents).where(eq(usageEvents.id, eventId)).get();
    if (!event) return;
    if (!turnKey) {
      if (event.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION) {
        this.database
          .update(usageEvents)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey: null })
          .where(eq(usageEvents.id, eventId))
          .run();
      }
      return;
    }
    if (event.turnKey === turnKey && event.turnAttributionVersion === TURN_ATTRIBUTION_VERSION) {
      return;
    }

    const input: TurnUsageInput = {
      cachedInputTokens: event.cachedInputTokens,
      costUsd: event.costUsd,
      inputTokens: event.inputTokens,
      model: event.model,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      timestamp: event.timestamp,
      totalTokens: event.totalTokens,
    };
    if (event.turnKey && event.turnKey !== turnKey) {
      this.applyTurnUsage(event.turnKey, input, false, -1);
    }
    this.database
      .update(usageEvents)
      .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey })
      .where(eq(usageEvents.id, eventId))
      .run();
    if (event.turnKey !== turnKey) this.applyTurnUsage(turnKey, input, false, 1);
    this.updateTurnContext(turnKey, input);
  }

  private attributeArchivedUsage(
    archived: typeof archivedUsageEventIds.$inferSelect,
    turnKey: string | null,
    usage: TokenUsage,
    model: string,
    timestamp: string,
  ) {
    this.database.$client.transaction(() => {
      this.attributeArchivedUsageInTransaction(archived, turnKey, usage, model, timestamp);
    })();
  }

  private attributeArchivedUsageInTransaction(
    archived: typeof archivedUsageEventIds.$inferSelect,
    turnKey: string | null,
    usage: TokenUsage,
    model: string,
    timestamp: string,
  ) {
    if (!turnKey) {
      if (archived.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION) {
        this.database
          .update(archivedUsageEventIds)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION })
          .where(eq(archivedUsageEventIds.id, archived.id))
          .run();
      }
      return;
    }
    if (
      archived.turnKey === turnKey &&
      archived.turnAttributionVersion === TURN_ATTRIBUTION_VERSION
    ) {
      return;
    }
    if (archived.turnKey && archived.turnKey !== turnKey) return;
    this.database
      .update(archivedUsageEventIds)
      .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey })
      .where(eq(archivedUsageEventIds.id, archived.id))
      .run();
    if (!archived.turnKey) {
      const input: TurnUsageInput = { ...usage, costUsd: null, model, timestamp };
      this.applyTurnUsage(turnKey, input, true, 1);
      this.updateTurnContext(turnKey, input);
    }
  }

  private applyTurnUsage(
    turnKey: string,
    usage: TurnUsageInput,
    costAttributionMissing: boolean,
    direction: 1 | -1,
  ) {
    const unpriced = !costAttributionMissing && usage.costUsd === null;
    const values = {
      cachedInputTokens: usage.cachedInputTokens,
      costAttributionMissingCount: costAttributionMissing ? 1 : 0,
      costUsd: costAttributionMissing ? 0 : (usage.costUsd ?? 0),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      requestCount: 1,
      totalTokens: usage.totalTokens,
      unpricedCachedInputTokens: unpriced ? usage.cachedInputTokens : 0,
      unpricedInputTokens: unpriced ? usage.inputTokens : 0,
      unpricedOutputTokens: unpriced ? usage.outputTokens : 0,
      unpricedUsageCount: unpriced ? 1 : 0,
    };

    if (direction === -1) {
      this.database
        .update(turnModelUsage)
        .set({
          cachedInputTokens: sql`${turnModelUsage.cachedInputTokens} - ${values.cachedInputTokens}`,
          costAttributionMissingCount: sql`${turnModelUsage.costAttributionMissingCount} - ${values.costAttributionMissingCount}`,
          costUsd: sql`${turnModelUsage.costUsd} - ${values.costUsd}`,
          inputTokens: sql`${turnModelUsage.inputTokens} - ${values.inputTokens}`,
          outputTokens: sql`${turnModelUsage.outputTokens} - ${values.outputTokens}`,
          reasoningOutputTokens: sql`${turnModelUsage.reasoningOutputTokens} - ${values.reasoningOutputTokens}`,
          requestCount: sql`${turnModelUsage.requestCount} - 1`,
          totalTokens: sql`${turnModelUsage.totalTokens} - ${values.totalTokens}`,
          unpricedCachedInputTokens: sql`${turnModelUsage.unpricedCachedInputTokens} - ${values.unpricedCachedInputTokens}`,
          unpricedInputTokens: sql`${turnModelUsage.unpricedInputTokens} - ${values.unpricedInputTokens}`,
          unpricedOutputTokens: sql`${turnModelUsage.unpricedOutputTokens} - ${values.unpricedOutputTokens}`,
          unpricedUsageCount: sql`${turnModelUsage.unpricedUsageCount} - ${values.unpricedUsageCount}`,
        })
        .where(and(eq(turnModelUsage.turnKey, turnKey), eq(turnModelUsage.model, usage.model)))
        .run();
      this.database
        .delete(turnModelUsage)
        .where(
          and(
            eq(turnModelUsage.turnKey, turnKey),
            eq(turnModelUsage.model, usage.model),
            sql`${turnModelUsage.requestCount} <= 0`,
          ),
        )
        .run();
      return;
    }

    this.database
      .insert(turnModelUsage)
      .values({ model: usage.model, turnKey, ...values })
      .onConflictDoUpdate({
        target: [turnModelUsage.turnKey, turnModelUsage.model],
        set: {
          cachedInputTokens: sql`${turnModelUsage.cachedInputTokens} + ${values.cachedInputTokens}`,
          costAttributionMissingCount: sql`${turnModelUsage.costAttributionMissingCount} + ${values.costAttributionMissingCount}`,
          costUsd: sql`${turnModelUsage.costUsd} + ${values.costUsd}`,
          inputTokens: sql`${turnModelUsage.inputTokens} + ${values.inputTokens}`,
          outputTokens: sql`${turnModelUsage.outputTokens} + ${values.outputTokens}`,
          reasoningOutputTokens: sql`${turnModelUsage.reasoningOutputTokens} + ${values.reasoningOutputTokens}`,
          requestCount: sql`${turnModelUsage.requestCount} + 1`,
          totalTokens: sql`${turnModelUsage.totalTokens} + ${values.totalTokens}`,
          unpricedCachedInputTokens: sql`${turnModelUsage.unpricedCachedInputTokens} + ${values.unpricedCachedInputTokens}`,
          unpricedInputTokens: sql`${turnModelUsage.unpricedInputTokens} + ${values.unpricedInputTokens}`,
          unpricedOutputTokens: sql`${turnModelUsage.unpricedOutputTokens} + ${values.unpricedOutputTokens}`,
          unpricedUsageCount: sql`${turnModelUsage.unpricedUsageCount} + ${values.unpricedUsageCount}`,
        },
      })
      .run();
  }

  private updateTurnContext(turnKey: string, usage: TurnUsageInput) {
    const turn = this.database.select().from(turns).where(eq(turns.id, turnKey)).get();
    if (!turn) return;
    this.database
      .update(turns)
      .set({
        firstInputTokens: turn.firstInputTokens ?? usage.inputTokens,
        lastEventAt: laterTimestamp(turn.lastEventAt, usage.timestamp),
        lastInputTokens: usage.inputTokens,
        peakInputTokens: Math.max(turn.peakInputTokens ?? 0, usage.inputTokens),
        updatedAt: Date.now(),
      })
      .where(eq(turns.id, turnKey))
      .run();
  }

  private insertActivity(
    record: JsonRecord,
    state: MutableImportState,
    attributionTurnKey: string | null,
  ) {
    if (!state.sessionId) return;
    const activity = parseActivityRecord(record, state.sessionId);
    if (!activity) return;

    const agentId = state.agentId ?? state.sessionId;
    const id = createHash("sha256").update(`${agentId}\u0000${activity.eventHash}`).digest("hex");
    const legacyId = createHash("sha256")
      .update(`${agentId}\u0000${activity.legacyEventHash}`)
      .digest("hex");
    const archived = this.database
      .select()
      .from(archivedActivityEventIds)
      .where(eq(archivedActivityEventIds.id, id))
      .get();
    if (archived) {
      this.attributeArchivedActivity(
        archived,
        attributionTurnKey,
        toActivityKind(activity),
        activity.timestamp,
      );
      return;
    }
    const legacyArchived = this.database
      .select()
      .from(archivedActivityEventIds)
      .where(eq(archivedActivityEventIds.id, legacyId))
      .get();
    if (legacyArchived) {
      this.database
        .insert(archivedActivityEventIds)
        .values({
          archivedAt: legacyArchived.archivedAt,
          id,
          turnAttributionVersion: legacyArchived.turnAttributionVersion,
          turnKey: legacyArchived.turnKey,
        })
        .onConflictDoNothing()
        .run();
      const migratedArchive = this.database
        .select()
        .from(archivedActivityEventIds)
        .where(eq(archivedActivityEventIds.id, id))
        .get();
      if (migratedArchive) {
        this.attributeArchivedActivity(
          migratedArchive,
          attributionTurnKey,
          toActivityKind(activity),
          activity.timestamp,
        );
      }
      return;
    }

    const localDate = toLocalDate(activity.timestamp);
    if (!localDate) return;
    const agentKind = agentId === state.sessionId ? "main" : "subagent";
    const projectId = state.projectId ?? "legacy-unknown";
    this.database
      .insert(activityEvents)
      .values({
        agentId,
        agentKind,
        createdAt: Date.now(),
        id,
        kind: toActivityKind(activity),
        localDate,
        projectId,
        sessionId: state.sessionId,
        timestamp: activity.timestamp,
        turnAttributionVersion: 0,
        turnKey: null,
      })
      .onConflictDoNothing()
      .run();
    this.attributeRawActivity(id, attributionTurnKey, toActivityKind(activity));
  }

  private attributeRawActivity(id: string, turnKey: string | null, kind: ActivityKind) {
    this.database.$client.transaction(() => {
      this.attributeRawActivityInTransaction(id, turnKey, kind);
    })();
  }

  private attributeRawActivityInTransaction(
    id: string,
    turnKey: string | null,
    kind: ActivityKind,
  ) {
    const event = this.database
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.id, id))
      .get();
    if (!event) return;
    if (!turnKey) {
      if (event.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION) {
        this.database
          .update(activityEvents)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey: null })
          .where(eq(activityEvents.id, id))
          .run();
      }
      return;
    }
    if (event.turnKey === turnKey && event.turnAttributionVersion === TURN_ATTRIBUTION_VERSION) {
      return;
    }
    if (event.turnKey && event.turnKey !== turnKey) {
      this.applyTurnActivity(event.turnKey, kind, -1);
    }
    this.database
      .update(activityEvents)
      .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey })
      .where(eq(activityEvents.id, id))
      .run();
    if (event.turnKey !== turnKey) this.applyTurnActivity(turnKey, kind, 1);
    this.touchTurn(turnKey, event.timestamp);
  }

  private attributeArchivedActivity(
    archived: typeof archivedActivityEventIds.$inferSelect,
    turnKey: string | null,
    kind: ActivityKind,
    timestamp: string,
  ) {
    this.database.$client.transaction(() => {
      this.attributeArchivedActivityInTransaction(archived, turnKey, kind, timestamp);
    })();
  }

  private attributeArchivedActivityInTransaction(
    archived: typeof archivedActivityEventIds.$inferSelect,
    turnKey: string | null,
    kind: ActivityKind,
    timestamp: string,
  ) {
    if (!turnKey) {
      if (archived.turnAttributionVersion !== TURN_ATTRIBUTION_VERSION) {
        this.database
          .update(archivedActivityEventIds)
          .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION })
          .where(eq(archivedActivityEventIds.id, archived.id))
          .run();
      }
      return;
    }
    if (
      archived.turnKey === turnKey &&
      archived.turnAttributionVersion === TURN_ATTRIBUTION_VERSION
    ) {
      return;
    }
    if (archived.turnKey && archived.turnKey !== turnKey) return;
    this.database
      .update(archivedActivityEventIds)
      .set({ turnAttributionVersion: TURN_ATTRIBUTION_VERSION, turnKey })
      .where(eq(archivedActivityEventIds.id, archived.id))
      .run();
    if (!archived.turnKey) this.applyTurnActivity(turnKey, kind, 1);
    this.touchTurn(turnKey, timestamp);
  }

  private applyTurnActivity(turnKey: string, kind: ActivityKind, direction: 1 | -1) {
    if (direction === -1) {
      this.database
        .update(turnActivityRollups)
        .set({ eventCount: sql`${turnActivityRollups.eventCount} - 1` })
        .where(and(eq(turnActivityRollups.turnKey, turnKey), eq(turnActivityRollups.kind, kind)))
        .run();
      this.database
        .delete(turnActivityRollups)
        .where(
          and(
            eq(turnActivityRollups.turnKey, turnKey),
            eq(turnActivityRollups.kind, kind),
            sql`${turnActivityRollups.eventCount} <= 0`,
          ),
        )
        .run();
      return;
    }
    this.database
      .insert(turnActivityRollups)
      .values({ eventCount: 1, kind, turnKey })
      .onConflictDoUpdate({
        target: [turnActivityRollups.turnKey, turnActivityRollups.kind],
        set: { eventCount: sql`${turnActivityRollups.eventCount} + 1` },
      })
      .run();
  }

  private touchTurn(turnKey: string, timestamp: string) {
    const turn = this.database.select().from(turns).where(eq(turns.id, turnKey)).get();
    if (!turn) return;
    this.database
      .update(turns)
      .set({ lastEventAt: laterTimestamp(turn.lastEventAt, timestamp), updatedAt: Date.now() })
      .where(eq(turns.id, turnKey))
      .run();
  }

  private saveImportDiagnostic(
    sourcePath: string,
    malformedLines: number,
    incompleteLine: boolean,
    lastError: string | null,
  ) {
    this.database
      .insert(importDiagnostics)
      .values({ incompleteLine, lastError, malformedLines, sourcePath, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: importDiagnostics.sourcePath,
        set: { incompleteLine, lastError, malformedLines, updatedAt: Date.now() },
      })
      .run();
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

  private markSourceDeleted(sourcePath: string) {
    if (!sourcePath.endsWith(".jsonl")) return;
    this.database
      .update(sessions)
      .set({ sourceDeleted: true })
      .where(eq(sessions.sourcePath, sourcePath))
      .run();
    this.database
      .update(sessionAgents)
      .set({ sourceDeleted: true })
      .where(eq(sessionAgents.sourcePath, sourcePath))
      .run();
  }

  private refreshDeletedSources(availablePaths: Set<string>) {
    for (const session of this.database.select().from(sessions).all()) {
      const sourceDeleted = !availablePaths.has(session.sourcePath);
      if (sourceDeleted === session.sourceDeleted) continue;
      this.database
        .update(sessions)
        .set({ sourceDeleted })
        .where(eq(sessions.id, session.id))
        .run();
    }

    for (const agent of this.database.select().from(sessionAgents).all()) {
      const sourceDeleted = !availablePaths.has(agent.sourcePath);
      if (sourceDeleted === agent.sourceDeleted) continue;
      this.database
        .update(sessionAgents)
        .set({ sourceDeleted })
        .where(eq(sessionAgents.id, agent.id))
        .run();
    }
  }

  private async refreshSessionTitles(forceFull: boolean) {
    const metadata = await readSourceFileMetadata(this.sessionIndexPath);
    if (!metadata) return;

    const previous = this.sessionIndexMetadata;
    const rebuild =
      forceFull ||
      previous?.fileId !== metadata.fileId ||
      metadata.size < this.sessionIndexOffset ||
      (metadata.size === previous.size && !sourceMetadataEquals(metadata, previous));
    if (
      !rebuild &&
      previous &&
      sourceMetadataEquals(metadata, previous) &&
      this.sessionIndexOffset === metadata.size
    ) {
      return;
    }

    const titles = rebuild
      ? new Map<string, IndexedTitle>()
      : new Map<string, IndexedTitle>(this.sessionIndexTitles);
    const offset = rebuild ? 0 : this.sessionIndexOffset;
    const result = await readSessionIndexLines(this.sessionIndexPath, offset, (rawLine) => {
      mergeIndexedSessionTitle(titles, rawLine);
    });
    const currentMetadata = await readSourceFileMetadata(this.sessionIndexPath);
    this.sessionIndexMetadata =
      currentMetadata && sourceMetadataEquals(currentMetadata, metadata)
        ? currentMetadata
        : metadata;
    this.sessionIndexOffset = result.lastCompleteOffset;
    this.sessionIndexTitles = titles;

    for (const [id, value] of titles) {
      this.database.update(sessions).set({ title: value.title }).where(eq(sessions.id, id)).run();
    }
  }
}

async function findCanonicalBoundary(filePath: string): Promise<CanonicalBoundary> {
  let lineIndex = 0;
  let isSubagent = false;
  let sessionMetaCount = 0;
  let lastTaskStartLine = -1;
  let boundary: CanonicalBoundary | null = null;

  await readCompleteJsonLines(
    filePath,
    0,
    (line) => {
      const { record } = line;
      const payload = asRecord(record?.["payload"]);
      if (record?.["type"] === "session_meta" && payload) {
        sessionMetaCount += 1;
        if (sessionMetaCount === 1) {
          isSubagent =
            asString(payload["thread_source"]) === "subagent" ||
            asString(payload["parent_thread_id"]) !== null;
          if (!isSubagent) {
            boundary = { resolved: true, startLine: 0 };
            return false;
          }
        }
      }
      if (record?.["type"] === "event_msg" && payload?.["type"] === "task_started" && isSubagent) {
        lastTaskStartLine = lineIndex;
      }
      if (record?.["type"] === "inter_agent_communication_metadata" && isSubagent) {
        boundary = {
          resolved: true,
          startLine: sessionMetaCount > 1 && lastTaskStartLine >= 0 ? lastTaskStartLine : 0,
        };
        return false;
      }

      lineIndex += 1;
      return true;
    },
    "boundary",
  );

  if (boundary) return boundary;

  // Standalone subagent files contain one session_meta and are canonical from the start.
  // A multi-meta file without its handoff tail is conservatively ignored until a later rescan.
  return {
    resolved: sessionMetaCount <= 1,
    startLine: sessionMetaCount > 1 ? lineIndex : 0,
  };
}

function mergeIndexedSessionTitle(titles: Map<string, IndexedTitle>, rawLine: string) {
  let record: unknown;
  try {
    record = JSON.parse(rawLine);
  } catch {
    return;
  }
  if (!isRecord(record)) return;
  const id = asString(record["id"]);
  const title = asString(record["thread_name"])?.trim();
  if (!id || !title) return;
  const updatedAt = Date.parse(asString(record["updated_at"]) ?? "") || 0;
  const previous = titles.get(id);
  if (!previous || updatedAt >= previous.updatedAt) titles.set(id, { title, updatedAt });
}

async function readSessionIndexLines(
  filePath: string,
  offset: number,
  onLine: (rawLine: string) => void,
): Promise<{ lastCompleteOffset: number }> {
  const stream = createReadStream(filePath, { start: offset });
  const segments: Buffer[] = [];
  let bufferedBytes = 0;
  let lastCompleteOffset = offset;
  const chunks: AsyncIterable<unknown> = stream;

  for await (const chunkValue of chunks) {
    if (!Buffer.isBuffer(chunkValue)) throw new TypeError("Expected a binary session index chunk");
    let cursor = 0;
    let newlineIndex = chunkValue.indexOf(0x0a, cursor);
    while (newlineIndex !== -1) {
      const segment = chunkValue.subarray(cursor, newlineIndex);
      segments.push(segment);
      bufferedBytes += segment.length;
      const rawLine = Buffer.concat(segments, bufferedBytes).toString("utf8").replace(/\r$/, "");
      if (rawLine.trim()) onLine(rawLine);
      lastCompleteOffset += bufferedBytes + 1;
      segments.length = 0;
      bufferedBytes = 0;
      cursor = newlineIndex + 1;
      newlineIndex = chunkValue.indexOf(0x0a, cursor);
    }
    const tail = chunkValue.subarray(cursor);
    if (tail.length > 0) {
      segments.push(tail);
      bufferedBytes += tail.length;
    }
  }

  if (bufferedBytes > 0) {
    const rawLine = Buffer.concat(segments, bufferedBytes).toString("utf8").replace(/\r$/, "");
    try {
      JSON.parse(rawLine);
      onLine(rawLine);
      lastCompleteOffset += bufferedBytes;
    } catch {
      // A syntactically incomplete EOF fragment stays behind the cursor until the next append.
    }
  }
  return { lastCompleteOffset };
}

type CompleteJsonLinesResult = {
  incompleteLine: boolean;
  lastCompleteOffset: number;
};

const JSON_LINE_PREFIX_BYTES = 8 * 1024;
const JSON_LINE_PROJECTION_BYTES = JSON_LINE_PREFIX_BYTES;

async function readCompleteJsonLines(
  filePath: string,
  offset: number,
  onLine: (line: ParsedJsonLine) => boolean | Promise<boolean> | Promise<void> | void,
  purpose: "boundary" | "import" = "import",
): Promise<CompleteJsonLinesResult> {
  const stream = createReadStream(filePath, { start: offset });
  let bufferedSegments: Buffer[] = [];
  let bufferedBytes = 0;
  let projection: LargeLineProjection | null = null;
  let projectionAttempted = false;
  let projectedStructure: JsonStructureState | null = null;
  let lastCompleteOffset = offset;
  const chunks: AsyncIterable<unknown> = stream;
  const reusableStructure = createJsonStructureState();

  for await (const chunkValue of chunks) {
    if (!Buffer.isBuffer(chunkValue)) throw new TypeError("Expected a binary JSONL stream chunk");
    const chunk = chunkValue;
    let cursor = 0;
    let newlineIndex = chunk.indexOf(0x0a, cursor);

    while (newlineIndex !== -1) {
      const segment = chunk.subarray(cursor, newlineIndex);
      ({ bufferedBytes, bufferedSegments, projectedStructure, projection, projectionAttempted } =
        appendLineSegment(
          segment,
          bufferedSegments,
          bufferedBytes,
          projection,
          projectionAttempted,
          projectedStructure,
          purpose,
          reusableStructure,
        ));
      const line = finalizeJsonLine(
        bufferedSegments,
        bufferedBytes,
        projection,
        projectedStructure,
        purpose,
        reusableStructure,
      );
      const shouldContinue = await onLine(line);
      lastCompleteOffset += bufferedBytes + 1;
      bufferedSegments = [];
      bufferedBytes = 0;
      projection = null;
      projectionAttempted = false;
      projectedStructure = null;
      if (shouldContinue === false) {
        return { incompleteLine: false, lastCompleteOffset };
      }
      cursor = newlineIndex + 1;
      newlineIndex = chunk.indexOf(0x0a, cursor);
    }

    const segment = chunk.subarray(cursor);
    ({ bufferedBytes, bufferedSegments, projectedStructure, projection, projectionAttempted } =
      appendLineSegment(
        segment,
        bufferedSegments,
        bufferedBytes,
        projection,
        projectionAttempted,
        projectedStructure,
        purpose,
        reusableStructure,
      ));
  }

  return { incompleteLine: bufferedBytes > 0, lastCompleteOffset };
}

function appendLineSegment(
  segment: Buffer,
  bufferedSegments: Buffer[],
  bufferedBytes: number,
  projection: LargeLineProjection | null,
  projectionAttempted: boolean,
  projectedStructure: JsonStructureState | null,
  purpose: "boundary" | "import",
  reusableStructure: JsonStructureState,
) {
  const nextBytes = bufferedBytes + segment.length;
  if (projection && projectedStructure) {
    updateJsonStructure(projectedStructure, segment);
    return {
      bufferedBytes: nextBytes,
      bufferedSegments,
      projectedStructure,
      projection,
      projectionAttempted,
    };
  }

  bufferedSegments.push(segment);
  if (nextBytes < JSON_LINE_PROJECTION_BYTES || projectionAttempted) {
    return {
      bufferedBytes: nextBytes,
      bufferedSegments,
      projectedStructure,
      projection,
      projectionAttempted,
    };
  }

  const prefix = copyBufferPrefix(bufferedSegments, JSON_LINE_PREFIX_BYTES).toString("utf8");
  const nextProjection = projectLargeRecord(prefix, purpose);
  if (!nextProjection) {
    return {
      bufferedBytes: nextBytes,
      bufferedSegments,
      projectedStructure,
      projection,
      projectionAttempted: true,
    };
  }

  const nextStructure = resetJsonStructure(reusableStructure);
  for (const bufferedSegment of bufferedSegments) {
    updateJsonStructure(nextStructure, bufferedSegment);
  }

  return {
    bufferedBytes: nextBytes,
    bufferedSegments: [],
    projectedStructure: nextStructure,
    projection: nextProjection,
    projectionAttempted: true,
  };
}

function finalizeJsonLine(
  bufferedSegments: Buffer[],
  bufferedBytes: number,
  projection: LargeLineProjection | null,
  projectedStructure: JsonStructureState | null,
  purpose: "boundary" | "import",
  reusableStructure: JsonStructureState,
): ParsedJsonLine {
  if (projection && projectedStructure) {
    return finalizeProjectedJsonLine(projection, projectedStructure);
  }

  const onlySegment = bufferedSegments[0];
  const prefixBytes =
    bufferedSegments.length === 1 && onlySegment
      ? onlySegment.subarray(0, JSON_LINE_PREFIX_BYTES)
      : copyBufferPrefix(bufferedSegments, JSON_LINE_PREFIX_BYTES);
  const prefix = prefixBytes.toString("utf8");
  const completeProjection = projectLargeRecord(prefix, purpose);
  if (completeProjection) {
    const structure = resetJsonStructure(reusableStructure);
    for (const segment of bufferedSegments) updateJsonStructure(structure, segment);
    return finalizeProjectedJsonLine(completeProjection, structure);
  }

  const lineBytes =
    bufferedSegments.length === 1 && onlySegment
      ? onlySegment
      : Buffer.concat(bufferedSegments, bufferedBytes);
  const rawLine = (
    bufferedBytes <= JSON_LINE_PREFIX_BYTES ? prefix : lineBytes.toString("utf8")
  ).replace(/\r$/, "");
  if (!rawLine.trim()) return { malformed: false, rawLine, record: null };
  try {
    const parsed: unknown = JSON.parse(rawLine);
    return { malformed: !isRecord(parsed), rawLine, record: isRecord(parsed) ? parsed : null };
  } catch {
    return { malformed: true, rawLine, record: null };
  }
}

function finalizeProjectedJsonLine(
  projection: LargeLineProjection,
  structure: JsonStructureState,
): ParsedJsonLine {
  const structurallyValid = finishJsonStructure(structure);
  return {
    malformed: !structurallyValid,
    rawLine: "",
    record: structurallyValid && projection.kind === "record" ? projection.record : null,
  };
}

const RELEVANT_EVENT_TYPES = new Set([
  "context_compacted",
  "mcp_tool_call_end",
  "patch_apply_end",
  "task_complete",
  "task_started",
  "token_count",
  "turn_aborted",
  "user_message",
  "web_search_end",
]);
const RELEVANT_RESPONSE_ITEM_TYPES = new Set([
  "custom_tool_call",
  "function_call",
  "web_search_call",
]);
const CANONICAL_RECORD_PREFIX_PATTERN =
  /^\s*\{\s*"timestamp"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"type"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"payload"\s*:\s*\{/;

function projectLargeRecord(
  prefix: string,
  purpose: "boundary" | "import",
): LargeLineProjection | null {
  const envelope = CANONICAL_RECORD_PREFIX_PATTERN.exec(prefix);
  if (!envelope?.[1] || !envelope[2]) return null;
  const timestamp = parseJsonString(envelope[1]);
  const recordType = parseJsonString(envelope[2]);
  if (!timestamp || !recordType) return null;
  const payloadFields = readShallowStringFields(prefix.slice(envelope[0].length));
  const payloadType = payloadFields.get("type");

  if (purpose === "boundary") {
    if (recordType === "session_meta" || recordType === "inter_agent_communication_metadata") {
      return null;
    }
    if (recordType === "event_msg" && payloadType === "task_started") return null;
    return payloadType || ["compacted", "turn_context", "world_state"].includes(recordType)
      ? { kind: "ignored" }
      : null;
  }

  if (recordType === "world_state") return { kind: "ignored" };
  if (recordType === "event_msg" || recordType === "response_item") {
    if (!payloadType) return null;
    const relevantTypes =
      recordType === "event_msg" ? RELEVANT_EVENT_TYPES : RELEVANT_RESPONSE_ITEM_TYPES;
    if (!relevantTypes.has(payloadType)) return { kind: "ignored" };
    if (
      recordType === "event_msg" &&
      (payloadType === "mcp_tool_call_end" || payloadType === "patch_apply_end")
    ) {
      const callId = payloadFields.get("call_id");
      if (!callId) return null;
      const turnId = payloadFields.get("turn_id");
      return {
        kind: "record",
        record: {
          payload: { call_id: callId, type: payloadType, ...(turnId ? { turn_id: turnId } : {}) },
          timestamp,
          type: recordType,
        },
      };
    }
    return null;
  }

  if (recordType !== "compacted") return null;
  return {
    kind: "record",
    record: { payload: {}, timestamp, type: "compacted" },
  };
}

function readShallowStringFields(fragment: string): Map<string, string> {
  const fields = new Map<string, string>();
  let cursor = 0;
  while (cursor < fragment.length) {
    cursor = skipStringWhitespace(fragment, cursor);
    if (fragment.charAt(cursor) === "}") return fields;
    const key = readJsonStringToken(fragment, cursor);
    if (!key) return fields;
    cursor = skipStringWhitespace(fragment, key.end);
    if (fragment.charAt(cursor) !== ":") return fields;
    cursor = skipStringWhitespace(fragment, cursor + 1);
    const stringValue = readJsonStringToken(fragment, cursor);
    if (stringValue) {
      fields.set(key.value, stringValue.value);
      cursor = stringValue.end;
    } else {
      const valueEnd = skipJsonValuePrefix(fragment, cursor);
      if (valueEnd === null) return fields;
      cursor = valueEnd;
    }
    cursor = skipStringWhitespace(fragment, cursor);
    if (fragment.charAt(cursor) === "}") return fields;
    if (fragment.charAt(cursor) !== ",") return fields;
    cursor += 1;
  }
  return fields;
}

function readJsonStringToken(value: string, start: number): { end: number; value: string } | null {
  if (value.charAt(start) !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      const parsed = parseJsonString(value.slice(start, index + 1));
      return parsed === null ? null : { end: index + 1, value: parsed };
    }
  }
  return null;
}

function skipJsonValuePrefix(value: string, start: number): number | null {
  const opening = value.charAt(start);
  if (opening !== "{" && opening !== "[") {
    for (let index = start; index < value.length; index += 1) {
      if (value.charAt(index) === "," || value.charAt(index) === "}") return index;
    }
    return null;
  }

  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function skipStringWhitespace(value: string, start: number): number {
  let index = start;
  while (
    value.charAt(index) === " " ||
    value.charAt(index) === "\t" ||
    value.charAt(index) === "\n" ||
    value.charAt(index) === "\r"
  ) {
    index += 1;
  }
  return index;
}

function parseJsonString(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function copyBufferPrefix(segments: Buffer[], maximumBytes: number): Buffer {
  const prefix = Buffer.allocUnsafe(
    Math.min(
      maximumBytes,
      segments.reduce((total, segment) => total + segment.length, 0),
    ),
  );
  let written = 0;
  for (const segment of segments) {
    if (written >= prefix.length) break;
    written += segment.copy(prefix, written, 0, prefix.length - written);
  }
  return prefix;
}

const JSON_MAX_DEPTH = 256;
const CONTAINER_OBJECT = 1;
const CONTAINER_ARRAY = 2;
const EXPECT_OBJECT_KEY_OR_END = 1;
const EXPECT_OBJECT_KEY = 2;
const EXPECT_OBJECT_COLON = 3;
const EXPECT_OBJECT_VALUE = 4;
const EXPECT_OBJECT_COMMA_OR_END = 5;
const EXPECT_ARRAY_VALUE_OR_END = 6;
const EXPECT_ARRAY_VALUE = 7;
const EXPECT_ARRAY_COMMA_OR_END = 8;
const TOKEN_NONE = 0;
const TOKEN_STRING_KEY = 1;
const TOKEN_STRING_VALUE = 2;
const TOKEN_TRUE = 3;
const TOKEN_FALSE = 4;
const TOKEN_NULL = 5;
const TOKEN_NUMBER = 6;
const NUMBER_AFTER_MINUS = 1;
const NUMBER_ZERO = 2;
const NUMBER_INTEGER = 3;
const NUMBER_AFTER_DECIMAL = 4;
const NUMBER_FRACTION = 5;
const NUMBER_AFTER_EXPONENT = 6;
const NUMBER_AFTER_EXPONENT_SIGN = 7;
const NUMBER_EXPONENT = 8;

function createJsonStructureState(): JsonStructureState {
  return resetJsonStructure({
    complete: false,
    containerKinds: new Uint8Array(JSON_MAX_DEPTH),
    depth: 0,
    escaped: false,
    expectations: new Uint8Array(JSON_MAX_DEPTH),
    invalid: false,
    literalIndex: 0,
    numberState: 0,
    tokenKind: TOKEN_NONE,
    unicodeDigits: 0,
  });
}

function resetJsonStructure(state: JsonStructureState): JsonStructureState {
  state.complete = false;
  state.depth = 0;
  state.escaped = false;
  state.invalid = false;
  state.literalIndex = 0;
  state.numberState = 0;
  state.tokenKind = TOKEN_NONE;
  state.unicodeDigits = 0;
  return state;
}

function updateJsonStructure(state: JsonStructureState, buffer: Buffer) {
  let index = 0;
  while (index < buffer.length) {
    if (state.invalid) return;
    const byte = buffer.readUInt8(index);
    if (state.tokenKind !== TOKEN_NONE) {
      if (consumeJsonToken(state, byte)) index += 1;
      continue;
    }

    if (isJsonWhitespace(byte)) {
      index += 1;
      continue;
    }
    if (state.complete) {
      state.invalid = true;
      return;
    }

    if (state.depth === 0) {
      startJsonValue(state, byte);
    } else {
      const top = state.depth - 1;
      const kind = state.containerKinds.at(top);
      const expectation = state.expectations.at(top);
      if (kind === CONTAINER_OBJECT) {
        if (expectation === EXPECT_OBJECT_KEY || expectation === EXPECT_OBJECT_KEY_OR_END) {
          if (byte === 0x7d && expectation === EXPECT_OBJECT_KEY_OR_END) {
            closeJsonContainer(state, CONTAINER_OBJECT);
          } else if (byte === 0x22) {
            startJsonString(state, TOKEN_STRING_KEY);
          } else {
            state.invalid = true;
          }
        } else if (expectation === EXPECT_OBJECT_COLON) {
          if (byte === 0x3a) setTopExpectation(state, EXPECT_OBJECT_VALUE);
          else state.invalid = true;
        } else if (expectation === EXPECT_OBJECT_VALUE) {
          startJsonValue(state, byte);
        } else if (byte === 0x2c) {
          setTopExpectation(state, EXPECT_OBJECT_KEY);
        } else if (byte === 0x7d) {
          closeJsonContainer(state, CONTAINER_OBJECT);
        } else {
          state.invalid = true;
        }
      } else if (expectation === EXPECT_ARRAY_VALUE || expectation === EXPECT_ARRAY_VALUE_OR_END) {
        if (byte === 0x5d && expectation === EXPECT_ARRAY_VALUE_OR_END) {
          closeJsonContainer(state, CONTAINER_ARRAY);
        } else if (byte === 0x22) {
          startJsonString(state, TOKEN_STRING_VALUE);
        } else {
          startJsonValue(state, byte);
        }
      } else if (byte === 0x2c) {
        setTopExpectation(state, EXPECT_ARRAY_VALUE);
      } else if (byte === 0x5d) {
        closeJsonContainer(state, CONTAINER_ARRAY);
      } else {
        state.invalid = true;
      }
    }
    index += 1;
  }
}

function startJsonValue(state: JsonStructureState, byte: number) {
  if (byte === 0x7b) {
    pushJsonContainer(state, CONTAINER_OBJECT, EXPECT_OBJECT_KEY_OR_END);
  } else if (byte === 0x5b) {
    pushJsonContainer(state, CONTAINER_ARRAY, EXPECT_ARRAY_VALUE_OR_END);
  } else if (byte === 0x22) {
    startJsonString(state, TOKEN_STRING_VALUE);
  } else if (byte === 0x74) {
    startJsonLiteral(state, TOKEN_TRUE);
  } else if (byte === 0x66) {
    startJsonLiteral(state, TOKEN_FALSE);
  } else if (byte === 0x6e) {
    startJsonLiteral(state, TOKEN_NULL);
  } else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
    state.tokenKind = TOKEN_NUMBER;
    state.numberState =
      byte === 0x2d ? NUMBER_AFTER_MINUS : byte === 0x30 ? NUMBER_ZERO : NUMBER_INTEGER;
  } else {
    state.invalid = true;
  }
}

function startJsonString(state: JsonStructureState, tokenKind: number) {
  state.tokenKind = tokenKind;
  state.escaped = false;
  state.unicodeDigits = 0;
}

function startJsonLiteral(state: JsonStructureState, tokenKind: number) {
  state.tokenKind = tokenKind;
  state.literalIndex = 1;
}

function pushJsonContainer(state: JsonStructureState, kind: number, expectation: number) {
  if (state.depth >= JSON_MAX_DEPTH) {
    state.invalid = true;
    return;
  }
  state.containerKinds.fill(kind, state.depth, state.depth + 1);
  state.expectations.fill(expectation, state.depth, state.depth + 1);
  state.depth += 1;
}

function closeJsonContainer(state: JsonStructureState, kind: number) {
  if (state.depth === 0 || state.containerKinds.at(state.depth - 1) !== kind) {
    state.invalid = true;
    return;
  }
  state.depth -= 1;
  finishJsonValue(state);
}

function consumeJsonToken(state: JsonStructureState, byte: number): boolean {
  if (state.tokenKind === TOKEN_STRING_KEY || state.tokenKind === TOKEN_STRING_VALUE) {
    if (state.unicodeDigits > 0) {
      if (!isHexDigit(byte)) state.invalid = true;
      else state.unicodeDigits -= 1;
    } else if (state.escaped) {
      state.escaped = false;
      if (byte === 0x75) state.unicodeDigits = 4;
      else if (!isJsonEscapeByte(byte)) {
        state.invalid = true;
      }
    } else if (byte === 0x5c) {
      state.escaped = true;
    } else if (byte === 0x22) {
      const completedToken = state.tokenKind;
      state.tokenKind = TOKEN_NONE;
      if (completedToken === TOKEN_STRING_KEY) finishJsonKey(state);
      else finishJsonValue(state);
    } else if (byte < 0x20) {
      state.invalid = true;
    }
    return true;
  }

  if (
    state.tokenKind === TOKEN_TRUE ||
    state.tokenKind === TOKEN_FALSE ||
    state.tokenKind === TOKEN_NULL
  ) {
    if (byte !== expectedJsonLiteralByte(state.tokenKind, state.literalIndex)) {
      state.invalid = true;
      return true;
    }
    state.literalIndex += 1;
    if (state.literalIndex === jsonLiteralLength(state.tokenKind)) {
      state.tokenKind = TOKEN_NONE;
      finishJsonValue(state);
    }
    return true;
  }

  return consumeJsonNumber(state, byte);
}

function finishJsonKey(state: JsonStructureState) {
  if (state.depth === 0 || state.containerKinds.at(state.depth - 1) !== CONTAINER_OBJECT) {
    state.invalid = true;
    return;
  }
  const expectation = state.expectations.at(state.depth - 1);
  if (expectation !== EXPECT_OBJECT_KEY && expectation !== EXPECT_OBJECT_KEY_OR_END) {
    state.invalid = true;
    return;
  }
  setTopExpectation(state, EXPECT_OBJECT_COLON);
}

function finishJsonValue(state: JsonStructureState) {
  if (state.depth === 0) {
    state.complete = true;
    return;
  }
  const top = state.depth - 1;
  const kind = state.containerKinds.at(top);
  const expectation = state.expectations.at(top);
  if (kind === CONTAINER_OBJECT && expectation === EXPECT_OBJECT_VALUE) {
    setTopExpectation(state, EXPECT_OBJECT_COMMA_OR_END);
  } else if (
    kind === CONTAINER_ARRAY &&
    (expectation === EXPECT_ARRAY_VALUE || expectation === EXPECT_ARRAY_VALUE_OR_END)
  ) {
    setTopExpectation(state, EXPECT_ARRAY_COMMA_OR_END);
  } else {
    state.invalid = true;
  }
}

function consumeJsonNumber(state: JsonStructureState, byte: number): boolean {
  const isDigit = byte >= 0x30 && byte <= 0x39;
  switch (state.numberState) {
    case NUMBER_AFTER_MINUS:
      if (!isDigit) state.invalid = true;
      else state.numberState = byte === 0x30 ? NUMBER_ZERO : NUMBER_INTEGER;
      return true;
    case NUMBER_ZERO:
      if (byte === 0x2e) state.numberState = NUMBER_AFTER_DECIMAL;
      else if (byte === 0x45 || byte === 0x65) state.numberState = NUMBER_AFTER_EXPONENT;
      else if (isDigit) state.invalid = true;
      else return finishJsonNumber(state);
      return true;
    case NUMBER_INTEGER:
      if (isDigit) return true;
      if (byte === 0x2e) state.numberState = NUMBER_AFTER_DECIMAL;
      else if (byte === 0x45 || byte === 0x65) state.numberState = NUMBER_AFTER_EXPONENT;
      else return finishJsonNumber(state);
      return true;
    case NUMBER_AFTER_DECIMAL:
      if (!isDigit) state.invalid = true;
      else state.numberState = NUMBER_FRACTION;
      return true;
    case NUMBER_FRACTION:
      if (isDigit) return true;
      if (byte === 0x45 || byte === 0x65) state.numberState = NUMBER_AFTER_EXPONENT;
      else return finishJsonNumber(state);
      return true;
    case NUMBER_AFTER_EXPONENT:
      if (byte === 0x2b || byte === 0x2d) state.numberState = NUMBER_AFTER_EXPONENT_SIGN;
      else if (isDigit) state.numberState = NUMBER_EXPONENT;
      else state.invalid = true;
      return true;
    case NUMBER_AFTER_EXPONENT_SIGN:
      if (!isDigit) state.invalid = true;
      else state.numberState = NUMBER_EXPONENT;
      return true;
    case NUMBER_EXPONENT:
      if (isDigit) return true;
      return finishJsonNumber(state);
    default:
      state.invalid = true;
      return true;
  }
}

function finishJsonNumber(state: JsonStructureState): false {
  state.tokenKind = TOKEN_NONE;
  finishJsonValue(state);
  return false;
}

function expectedJsonLiteralByte(tokenKind: number, index: number): number {
  if (tokenKind === TOKEN_TRUE) return "true".charCodeAt(index);
  if (tokenKind === TOKEN_FALSE) return "false".charCodeAt(index);
  if (tokenKind === TOKEN_NULL) return "null".charCodeAt(index);
  return -1;
}

function jsonLiteralLength(tokenKind: number): number {
  return tokenKind === TOKEN_FALSE ? 5 : 4;
}

function setTopExpectation(state: JsonStructureState, expectation: number) {
  if (state.depth === 0) {
    state.invalid = true;
    return;
  }
  state.expectations.fill(expectation, state.depth - 1, state.depth);
}

function finishJsonStructure(state: JsonStructureState): boolean {
  if (
    state.tokenKind === TOKEN_NUMBER &&
    (state.numberState === NUMBER_ZERO ||
      state.numberState === NUMBER_INTEGER ||
      state.numberState === NUMBER_FRACTION ||
      state.numberState === NUMBER_EXPONENT)
  ) {
    finishJsonNumber(state);
  }
  return !state.invalid && state.tokenKind === TOKEN_NONE && state.complete && state.depth === 0;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isJsonEscapeByte(byte: number): boolean {
  return (
    byte === 0x22 ||
    byte === 0x2f ||
    byte === 0x5c ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

function isHexDigit(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
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

function toActivityKind(activity: ParsedActivityEvent): ActivityKind {
  if (activity.category === "task_start") return "task_started";
  if (activity.category === "task_complete") return "task_completed";
  return activity.category;
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
  agentId: string,
  model: string,
): string {
  const observation = cumulativeUsage ? { cumulativeUsage, lastUsage } : rawLine;
  const value = JSON.stringify({ agentId, model, observation });
  return createHash("sha256").update(value).digest("hex");
}

function createLegacyUsageFingerprint(
  rawLine: string,
  lastUsage: TokenUsage,
  cumulativeUsage: TokenUsage | null,
): string {
  const value = cumulativeUsage ? JSON.stringify({ cumulativeUsage, lastUsage }) : rawLine;
  return createHash("sha256").update(value).digest("hex");
}

export function createTurnKey(agentId: string, turnId: string): string {
  return createHash("sha256").update(`${agentId}\u0000${turnId}`).digest("hex");
}

function readExplicitTurnId(record: JsonRecord, payload: JsonRecord): string | null {
  return asString(payload["turn_id"]) ?? asString(record["turn_id"]);
}

function turnUsageInputFromEvent(event: typeof usageEvents.$inferSelect): TurnUsageInput {
  return {
    cachedInputTokens: event.cachedInputTokens,
    costUsd: event.costUsd,
    inputTokens: event.inputTokens,
    model: event.model,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
    timestamp: event.timestamp,
    totalTokens: event.totalTokens,
  };
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function readCollaborationMode(payload: JsonRecord): string | null {
  const direct = asString(payload["collaboration_mode_kind"]);
  if (direct) return direct;
  const value = payload["collaboration_mode"];
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  return asString(record?.["kind"]) ?? asString(record?.["mode"]);
}

function asTimestamp(value: unknown): string | null {
  const timestamp = asString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

function earlierTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function laterTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function sourceMetadataEquals(left: SourceFileMetadata, right: SourceFileMetadata): boolean {
  return (
    left.path === right.path &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.fileId === right.fileId
  );
}

function emptySourceScanStatus(): SourceScanStatus {
  return {
    current: null,
    deepQueued: false,
    lastCompleted: null,
    nextScheduledAt: null,
  };
}

function cloneSourceScanStatus(status: SourceScanStatus): SourceScanStatus {
  return {
    current: status.current ? { ...status.current } : null,
    deepQueued: status.deepQueued,
    lastCompleted: status.lastCompleted ? { ...status.lastCompleted } : null,
    nextScheduledAt: status.nextScheduledAt,
  };
}

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown import error";
}
