import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SourceInventory,
  type SourceFileMetadata,
  type SourceInventoryScanner,
} from "@/server/source-inventory";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("source inventory", () => {
  it("streams regular files, ignores symlinks, sorts JSONL and caches a complete snapshot", async () => {
    const root = await createTemporaryDirectory();
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, "z.jsonl"), "1234");
    await writeFile(join(nested, "a.jsonl"), "12");
    await writeFile(join(root, "notes.txt"), "123");
    await symlink(join(root, "z.jsonl"), join(root, "linked.jsonl"));

    const inventory = new SourceInventory(root, () => new Date("2026-07-15T00:00:00.000Z"));
    await expect(inventory.getSummaryOrJoin()).resolves.toBeNull();
    expect(inventory.getScanCount()).toBe(0);
    const first = await inventory.refresh();

    expect(first.files.map((file) => file.path)).toEqual([
      join(nested, "a.jsonl"),
      join(root, "z.jsonl"),
    ]);
    expect(first).toMatchObject({
      scannedAt: "2026-07-15T00:00:00.000Z",
      sourceBytes: 9,
      sourceFileCount: 2,
    });
    first.files.length = 0;
    expect((await inventory.getOrRefresh()).files).toHaveLength(2);
    expect(inventory.getScanCount()).toBe(1);
  });

  it("coalesces concurrent refreshes and preserves the previous snapshot after failure", async () => {
    const root = await createTemporaryDirectory();
    const file = metadata(join(root, "source.jsonl"));
    let attempts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanner: SourceInventoryScanner = async () => {
      attempts += 1;
      if (attempts === 1) {
        await gate;
        return { files: [file], sourceBytes: file.size };
      }
      throw new Error("inventory unavailable");
    };
    const inventory = new SourceInventory(
      root,
      () => new Date("2026-07-15T00:00:00.000Z"),
      32,
      scanner,
    );

    const left = inventory.refresh();
    const right = inventory.getSummaryOrJoin();
    expect(attempts).toBe(1);
    release?.();
    await expect(Promise.all([left, right])).resolves.toHaveLength(2);
    await expect(inventory.refresh()).rejects.toThrow("inventory unavailable");
    expect(inventory.getSnapshot()).toMatchObject({ sourceBytes: file.size, sourceFileCount: 1 });
    expect(inventory.getScanCount()).toBe(1);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-inventory-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function metadata(path: string): SourceFileMetadata {
  return {
    ctimeNs: "1",
    fileId: "1:1",
    mtimeNs: "1",
    path,
    size: 100,
  };
}
