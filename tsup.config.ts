import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  clean: true,
  dts: false,
  external: ["better-sqlite3", "vite"],
  format: ["esm"],
  outDir: "build-server",
  platform: "node",
  sourcemap: true,
  target: "node24",
});
