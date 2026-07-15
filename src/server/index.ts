import { createServer, type Server } from "node:http";

import { getRequestListener, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "@/server/app";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase } from "@/server/db/client";
import { SessionImporter } from "@/server/importer";
import { backfillProjects } from "@/server/projects";
import { RetentionService } from "@/server/retention";

const config = getConfig();
const database = createDatabase(config.databasePath);
migrateDatabase(database);
backfillProjects(database);

const importer = new SessionImporter(database, config.sessionsDirectory);
await importer.start();
const retention = new RetentionService(database, config.databasePath, config.sessionsDirectory);
retention.start();

const app = createApp(database, importer, retention);
const isProduction = process.env["NODE_ENV"] === "production";
let closeVite: (() => Promise<void>) | undefined;
if (isProduction) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ rewriteRequestPath: () => "/index.html", root: "./dist" }));
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
  if (message !== "shutdown") return;
  exitAfterShutdown();
});

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
