import { createServer, type Server } from "node:http";

import { getRequestListener, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "@/server/app";
import { getConfig } from "@/server/config";
import { createDatabase, migrateDatabase } from "@/server/db/client";
import { SessionImporter } from "@/server/importer";

const config = getConfig();
const database = createDatabase(config.databasePath);
migrateDatabase(database);

const importer = new SessionImporter(database, config.sessionsDirectory);
await importer.start();

const app = createApp(database, importer);
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

async function shutdown() {
  await importer.stop();
  await closeVite?.();
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

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
