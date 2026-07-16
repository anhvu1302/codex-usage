import { describe, expect, it } from "vitest";

import { parseRevision, parseScan } from "@/web/lib/live-event-parser";

describe("live event parsing", () => {
  it("keeps legacy revisions and sanitizes additive scopes", () => {
    expect(parseRevision('{"reason":"import","revision":7}')).toEqual({
      reason: "import",
      revision: 7,
    });
    expect(
      parseRevision('{"reason":"import","revision":8,"scopes":["activity","unknown","activity"]}'),
    ).toEqual({ reason: "import", revision: 8, scopes: ["activity"] });
    expect(parseRevision('{"reason":"import","revision":9,"scopes":[]}')).toEqual({
      reason: "import",
      revision: 9,
      scopes: [],
    });
  });

  it("rejects invalid revisions without dropping a legacy malformed scope field", () => {
    expect(parseRevision('{"reason":"import","revision":-1}')).toBeNull();
    expect(parseRevision('{"reason":"unknown","revision":1}')).toBeNull();
    expect(parseRevision('{"reason":"import","revision":1,"scopes":"activity"}')).toEqual({
      reason: "import",
      revision: 1,
    });
  });

  it("requires the full privacy-safe importer status shape for scan events", () => {
    const scan = {
      error: null,
      filesProcessed: 1,
      isSyncing: false,
      lastSyncAt: "2026-07-16T05:00:00.000Z",
      recordsBackfilled: 0,
      recordsInserted: 1,
      recordsReclassified: 0,
      sourceScan: {
        current: null,
        deepQueued: false,
        lastCompleted: {
          completedAt: "2026-07-16T05:00:00.000Z",
          discoveredFiles: 1,
          durationMs: 12,
          filesRead: 1,
          filesSkipped: 0,
          mode: "inventory",
          sourceBytes: 128,
          trigger: "manual",
        },
        nextScheduledAt: "2026-07-16T05:15:00.000Z",
      },
      turnBackfill: {
        attributionVersion: 1,
        costAttributionMissingCount: 0,
        error: null,
        filesProcessed: 1,
        isRunning: false,
        lastRunAt: "2026-07-16T05:00:00.000Z",
        sourceDeletedGaps: 0,
        totalFiles: 1,
      },
    };
    expect(parseScan(JSON.stringify(scan))).toEqual(scan);
    expect(parseScan(JSON.stringify({ ...scan, recordsInserted: -1 }))).toBeNull();
    expect(parseScan(JSON.stringify({ ...scan, turnBackfill: null }))).toBeNull();
    expect(
      parseScan(
        JSON.stringify({
          ...scan,
          sourceScan: { ...scan.sourceScan, current: { phase: "reading" } },
        }),
      ),
    ).toBeNull();
  });
});
