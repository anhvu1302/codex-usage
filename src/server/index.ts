import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, normalize } from "node:path";

import { getRequestListener, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";

import { createApp } from "@/server/app";
import { AppEventBus } from "@/server/app-events";
import { AlertMaterializer } from "@/server/alert-materializer";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase } from "@/server/db/client";
import { SessionImporter } from "@/server/importer";
import { backfillProjects } from "@/server/projects";
import { RetentionService } from "@/server/retention";
import { SourceInventory } from "@/server/source-inventory";

const config = getConfig();
const database = createDatabase(config.databasePath);
migrateDatabase(database);
backfillProjects(database);

const sourceInventory = new SourceInventory(config.sessionsDirectory);
const appEvents = new AppEventBus();
const alertMaterializer = new AlertMaterializer(database, {
  onChanged: (reason) => appEvents.publish(reason, ["alerts"]),
});
alertMaterializer.start();
const importer = new SessionImporter(database, config.sessionsDirectory, {
  inventory: sourceInventory,
  onDataChanged: () => alertMaterializer.invalidate("import"),
  onRevision: (scopes) => appEvents.publish("import", scopes),
  scanIntervalMs: config.scanIntervalMinutes * 60 * 1_000,
});
await importer.start();
const retention = new RetentionService(
  database,
  config.databasePath,
  config.sessionsDirectory,
  () => new Date(),
  sourceInventory,
  (scopes) => appEvents.publish("retention", scopes),
  () => alertMaterializer.invalidate("retention"),
);
retention.start();

const app = createApp(database, importer, retention, appEvents, alertMaterializer);
const isProduction = process.env["NODE_ENV"] === "production";
let closeVite: (() => Promise<void>) | undefined;
if (isProduction) {
  const indexEtag = createIndexEtag("./dist/index.html");
  app.use("/*", async (context, next) => {
    if (
      (context.req.method === "GET" || context.req.method === "HEAD") &&
      isSpaDocumentPath(context.req.path) &&
      context.req.header("if-none-match") === indexEtag
    ) {
      context.header("Cache-Control", "no-cache");
      context.header("ETag", indexEtag);
      return context.body(null, 304);
    }
    return next();
  });
  app.use("/*", serveStatic({ onFound: staticHeaders(indexEtag), root: "./dist" }));
  app.get(
    "/*",
    serveStatic({
      onFound: staticHeaders(indexEtag),
      rewriteRequestPath: () => "/index.html",
      root: "./dist",
    }),
  );
}

const server = isProduction
  ? serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: config.port,
    })
  : await startDevelopmentServer(app.fetch, config.port);

console.log(
  `Codex Usage listening at http://127.0.0.1:${config.port} (${isProduction ? "production" : "development"})`,
);

let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= shutdownServices();
  return shutdownPromise;
}

async function shutdownServices() {
  alertMaterializer.stop();
  retention.stop();
  await importer.stop();
  await closeVite?.();
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.$client.close();
}

function exitAfterShutdown() {
  console.log("Codex Usage is shutting down");
  void shutdown().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("Graceful shutdown failed", error);
      process.exit(1);
    },
  );
}

process.once("SIGINT", exitAfterShutdown);
process.once("SIGTERM", exitAfterShutdown);
process.on("message", (message) => {
  if (message === "shutdown") {
    exitAfterShutdown();
    return;
  }
  if (isBenchmarkMemoryMessage(message)) {
    process.send?.({
      id: message.id,
      memory: process.memoryUsage(),
      type: "benchmark:memory",
    });
  }
});

function isBenchmarkMemoryMessage(
  value: unknown,
): value is { id: string; type: "benchmark:memory" } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; type?: unknown };
  return candidate.type === "benchmark:memory" && typeof candidate.id === "string";
}

async function startDevelopmentServer(fetch: typeof app.fetch, port: number): Promise<Server> {
  const server = createServer();
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    appType: "spa",
    server: { middlewareMode: true, ws: { server } },
  });
  closeVite = () => vite.close();
  const honoListener = getRequestListener(fetch);

  server.on("request", (request, response) => {
    if (request.url?.startsWith("/api/")) {
      void honoListener(request, response);
      return;
    }
    vite.middlewares(request, response, (error: unknown) => {
      if (!error) return;
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "Vite middleware error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function createIndexEtag(path: string): string {
  const digest = createHash("sha256").update(readFileSync(path)).digest("base64url");
  return `"${digest}"`;
}

function staticHeaders(indexEtag: string) {
  return (path: string, context: Context) => {
    const normalized = normalize(path);
    const filename = basename(normalized);
    if (filename === "index.html") {
      context.header("Cache-Control", "no-cache");
      context.header("ETag", indexEtag);
      return;
    }
    if (normalized.includes(`${normalize("dist/assets")}/`) && hasContentHash(filename)) {
      context.header("Cache-Control", "public, max-age=31536000, immutable");
      return;
    }
    if (
      filename === "site.webmanifest" ||
      filename === "favicon.ico" ||
      filename === "favicon.svg" ||
      filename.startsWith("favicon-") ||
      filename.startsWith("apple-touch-icon")
    ) {
      context.header("Cache-Control", "public, max-age=86400");
      return;
    }
    context.header("Cache-Control", "no-cache");
  };
}

function hasContentHash(filename: string): boolean {
  return /-[A-Za-z0-9_-]{8,}\.(?:css|js|map|woff2?|png|svg)$/.test(filename);
}

function isSpaDocumentPath(path: string): boolean {
  const filename = path.split("/").at(-1) ?? "";
  return path === "/" || filename === "index.html" || !filename.includes(".");
}
