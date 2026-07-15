import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_STAT_CONCURRENCY = 32;

export type SourceFileMetadata = {
  ctimeNs: string;
  fileId: string | null;
  mtimeNs: string;
  path: string;
  size: number;
};

export type SourceInventorySnapshot = {
  files: SourceFileMetadata[];
  scannedAt: string;
  sourceBytes: number;
  sourceFileCount: number;
};

export type SourceInventorySummary = Omit<SourceInventorySnapshot, "files">;

export type SourceInventoryScanner = (
  directory: string,
  statConcurrency: number,
) => Promise<{ files: SourceFileMetadata[]; sourceBytes: number }>;

export class SourceInventory {
  private inFlight: Promise<SourceInventorySnapshot> | null = null;
  private scanCount = 0;
  private snapshot: SourceInventorySnapshot | null = null;

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly statConcurrency = DEFAULT_STAT_CONCURRENCY,
    private readonly scan: SourceInventoryScanner = scanSourceDirectory,
  ) {}

  getScanCount(): number {
    return this.scanCount;
  }

  getSnapshot(): SourceInventorySnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  getOrRefresh(): Promise<SourceInventorySnapshot> {
    return this.snapshot ? Promise.resolve(cloneSnapshot(this.snapshot)) : this.refresh();
  }

  getSummaryOrJoin(): Promise<SourceInventorySummary | null> {
    if (this.snapshot) return Promise.resolve(toSummary(this.snapshot));
    return this.inFlight ? this.inFlight.then(toSummary) : Promise.resolve(null);
  }

  refresh(): Promise<SourceInventorySnapshot> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.scan(this.directory, this.statConcurrency)
      .then((result) => {
        this.scanCount += 1;
        this.snapshot = {
          files: result.files,
          scannedAt: this.now().toISOString(),
          sourceBytes: result.sourceBytes,
          sourceFileCount: result.files.length,
        };
        return cloneSnapshot(this.snapshot);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

export async function readSourceFileMetadata(path: string): Promise<SourceFileMetadata | null> {
  try {
    const value = await lstat(path, { bigint: true });
    if (!value.isFile()) return null;
    return metadataFromStat(path, value);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export function sameSourceMetadata(
  left: SourceFileMetadata,
  right: {
    sourceCtimeNs: string | null;
    sourceFileId: string | null;
    sourceMtimeNs: string | null;
    sourceSize: number | null;
  },
): boolean {
  return (
    right.sourceSize === left.size &&
    right.sourceMtimeNs === left.mtimeNs &&
    right.sourceCtimeNs === left.ctimeNs &&
    right.sourceFileId === left.fileId
  );
}

async function scanSourceDirectory(
  directory: string,
  statConcurrency: number,
): Promise<{ files: SourceFileMetadata[]; sourceBytes: number }> {
  const concurrency = Math.max(1, statConcurrency);
  const pending = new Set<Promise<void>>();
  let sourceBytes = 0;
  const files: SourceFileMetadata[] = [];
  let failure: unknown;

  try {
    for await (const path of walkRegularFilePaths(directory)) {
      const task = readSourceFileMetadata(path)
        .then((value) => {
          if (!value) return;
          const nextSourceBytes = sourceBytes + value.size;
          if (!Number.isSafeInteger(nextSourceBytes)) {
            throw new RangeError("Source inventory byte total exceeds the safe integer range");
          }
          sourceBytes = nextSourceBytes;
          if (value.path.endsWith(".jsonl")) files.push(value);
        })
        .catch((error: unknown) => {
          failure ??= error;
        });
      pending.add(task);
      void task.then(() => pending.delete(task));
      if (pending.size >= concurrency) await Promise.race(pending);
      if (failure) break;
    }
  } catch (error) {
    failure ??= error;
  }
  await Promise.all(pending);
  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error("Source inventory failed", { cause: failure });
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, sourceBytes };
}

async function* walkRegularFilePaths(directory: string): AsyncGenerator<string> {
  const pending = [directory];

  while (pending.length > 0) {
    const current = pending.pop()!;
    let handle;
    try {
      handle = await opendir(current);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }

    for await (const entry of handle) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) yield path;
    }
  }
}

function metadataFromStat(path: string, value: BigIntStats): SourceFileMetadata {
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`Source file is too large to index safely: ${path}`);
  }
  return {
    ctimeNs: value.ctimeNs.toString(),
    fileId: value.dev === 0n && value.ino === 0n ? null : `${value.dev}:${value.ino}`,
    mtimeNs: value.mtimeNs.toString(),
    path,
    size,
  };
}

function cloneSnapshot(snapshot: SourceInventorySnapshot): SourceInventorySnapshot {
  return { ...snapshot, files: snapshot.files.map((file) => ({ ...file })) };
}

function toSummary(snapshot: SourceInventorySnapshot): SourceInventorySummary {
  return {
    scannedAt: snapshot.scannedAt,
    sourceBytes: snapshot.sourceBytes,
    sourceFileCount: snapshot.sourceFileCount,
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
