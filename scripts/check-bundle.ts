import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

type ManifestChunk = {
  dynamicImports?: string[];
  file: string;
  imports?: string[];
  isDynamicEntry?: boolean;
  isEntry?: boolean;
  name?: string;
  src?: string;
};

const DISTANCE_BUDGETS = {
  coldActivityNonChartGzip: 190 * 1024,
  coldRouteGzip: 179 * 1024,
  coldRouteRaw: 700 * 1024,
  entryGzip: 160 * 1024,
  entryRaw: 550 * 1024,
} as const;
const distDirectory = join(process.cwd(), "dist");
const manifestPath = join(distDirectory, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, ManifestChunk>;
const indexHtml = await readFile(join(distDirectory, "index.html"), "utf8");
const violations: string[] = [];
const entryKey = Object.entries(manifest).find(([, chunk]) => chunk.isEntry)?.[0];
if (!entryKey) throw new Error("Vite manifest does not contain an HTML entry");

const entryFiles = staticClosure(entryKey);
const sessionsKey = Object.entries(manifest).find(
  ([key, chunk]) =>
    key.endsWith("src/web/components/sessions-page.tsx") ||
    chunk.src?.endsWith("src/web/components/sessions-page.tsx"),
)?.[0];
if (!sessionsKey) throw new Error("Vite manifest does not contain SessionsPage as a lazy entry");
const sessionsFiles = new Set([...entryFiles, ...staticClosure(sessionsKey)]);
const activityKey = Object.entries(manifest).find(
  ([key, chunk]) =>
    key.endsWith("src/web/components/activity-page.tsx") ||
    chunk.src?.endsWith("src/web/components/activity-page.tsx"),
)?.[0];
if (!activityKey) throw new Error("Vite manifest does not contain ActivityPage as a lazy entry");
const activityFiles = new Set([...entryFiles, ...staticClosure(activityKey)]);
const entrySize = await measure(entryFiles);
const sessionsSize = await measure(sessionsFiles);
const activitySize = await measure(activityFiles);
const chartFiles = outputFilesNamed("charts");
const reactFiles = outputFilesNamed("react");
const dynamicSources = Object.values(manifest)
  .filter((chunk) => chunk.isDynamicEntry)
  .map((chunk) => chunk.src ?? chunk.name ?? chunk.file)
  .sort();

if (chartFiles.some((file) => entryFiles.has(file)) || /charts-[^"']+\.js/.test(indexHtml)) {
  violations.push("dist/index.html entry graph preloads the chart chunk");
}
for (const chartFile of chartFiles) {
  const cycle = findStaticCycle(chartFile);
  if (cycle) violations.push(`chart chunk has a static import cycle: ${cycle.join(" -> ")}`);
}
if (reactFiles.length !== 1) {
  violations.push(`React core must be emitted once; found ${reactFiles.length} React chunks`);
}
if (chartFiles.some((file) => activityFiles.has(file))) {
  violations.push("cold activity timeline/data-health graph statically imports chart code");
}
if (activitySize.gzip > DISTANCE_BUDGETS.coldActivityNonChartGzip) {
  violations.push(
    `cold activity non-chart gzip ${activitySize.gzip} B exceeds ${DISTANCE_BUDGETS.coldActivityNonChartGzip} B`,
  );
}
if (entrySize.raw > DISTANCE_BUDGETS.entryRaw) {
  violations.push(`entry raw ${entrySize.raw} B exceeds ${DISTANCE_BUDGETS.entryRaw} B`);
}
if (entrySize.gzip > DISTANCE_BUDGETS.entryGzip) {
  violations.push(`entry gzip ${entrySize.gzip} B exceeds ${DISTANCE_BUDGETS.entryGzip} B`);
}
if (sessionsSize.raw > DISTANCE_BUDGETS.coldRouteRaw) {
  violations.push(
    `cold sessions route raw ${sessionsSize.raw} B exceeds ${DISTANCE_BUDGETS.coldRouteRaw} B`,
  );
}
if (sessionsSize.gzip > DISTANCE_BUDGETS.coldRouteGzip) {
  violations.push(
    `cold sessions route gzip ${sessionsSize.gzip} B exceeds ${DISTANCE_BUDGETS.coldRouteGzip} B`,
  );
}
for (const route of [
  "activity-page.tsx",
  "agents-page.tsx",
  "dashboard-view.tsx",
  "projects-page.tsx",
  "sessions-page.tsx",
  "settings-page.tsx",
  "turns-page.tsx",
]) {
  if (!dynamicSources.some((source) => source.endsWith(route))) {
    violations.push(`${route} is no longer a dynamic route entry`);
  }
}

const report = {
  budgets: DISTANCE_BUDGETS,
  coldActivityNonChart: { files: activityFiles.size, ...activitySize },
  chartFiles,
  coldSessionsRoute: { files: sessionsFiles.size, ...sessionsSize },
  dynamicRoutes: dynamicSources,
  entry: { files: entryFiles.size, ...entrySize },
  reactFiles,
  violations,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (violations.length > 0) process.exitCode = 1;

function staticClosure(key: string): Set<string> {
  const files = new Set<string>();
  const visited = new Set<string>();
  const visit = (currentKey: string) => {
    if (visited.has(currentKey)) return;
    visited.add(currentKey);
    const chunk = Reflect.get(manifest, currentKey) as ManifestChunk | undefined;
    if (!chunk) throw new Error(`Manifest import ${currentKey} is missing`);
    if (chunk.file.endsWith(".js")) files.add(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(key);
  return files;
}

function outputFilesNamed(name: string): string[] {
  return [
    ...new Set(
      Object.values(manifest)
        .map((chunk) => chunk.file)
        .filter((file) => basename(file).startsWith(`${name}-`) && file.endsWith(".js")),
    ),
  ].sort();
}

function findStaticCycle(startFile: string): string[] | null {
  const keyByFile = new Map(
    Object.entries(manifest).map(([key, chunk]) => [chunk.file, key] as const),
  );
  const startKey = keyByFile.get(startFile);
  if (!startKey) return null;
  const visit = (key: string, path: string[], visiting: Set<string>): string[] | null => {
    const chunk = Reflect.get(manifest, key) as ManifestChunk | undefined;
    if (!chunk) return null;
    for (const importedKey of chunk.imports ?? []) {
      const imported = Reflect.get(manifest, importedKey) as ManifestChunk | undefined;
      if (!imported) continue;
      if (imported.file === startFile) return [...path, imported.file];
      if (visiting.has(importedKey)) continue;
      const cycle = visit(
        importedKey,
        [...path, imported.file],
        new Set([...visiting, importedKey]),
      );
      if (cycle) return cycle;
    }
    return null;
  };
  return visit(startKey, [startFile], new Set([startKey]));
}

async function measure(files: Iterable<string>) {
  let brotli = 0;
  let gzip = 0;
  let raw = 0;
  for (const file of files) {
    const contents = await readFile(join(distDirectory, file));
    raw += contents.byteLength;
    gzip += gzipSync(contents, { level: 9 }).byteLength;
    brotli += brotliCompressSync(contents).byteLength;
  }
  return { brotli, gzip, raw };
}
