import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    watch: {
      ignored: ["**/coverage/**", "**/test-results/**", "**/.local/**"],
    },
  },
  build: {
    manifest: true,
    rolldownOptions: {
      preserveEntrySignatures: false,
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: "react",
              priority: 30,
              test: (id) => {
                const packageName = packageNameFromModuleId(id);
                return packageName === "react" || packageName === "react-dom";
              },
            },
            {
              name: "charts",
              priority: 20,
              test: isChartModule,
            },
            {
              entriesAware: true,
              name: "icons",
              priority: 10,
              test: (id) => packageNameFromModuleId(id) === "lucide-react",
            },
            {
              entriesAware: true,
              name: "tanstack",
              priority: 10,
              test: (id) => packageNameFromModuleId(id)?.startsWith("@tanstack/") === true,
            },
            {
              entriesAware: true,
              name: "radix",
              priority: 10,
              test: (id) => packageNameFromModuleId(id)?.startsWith("@radix-ui/") === true,
            },
            {
              name(id) {
                const packageName = packageNameFromModuleId(id);
                if (!packageName) return null;
                if (
                  packageName === "react-hook-form" ||
                  packageName.startsWith("@hookform/") ||
                  packageName === "zod"
                ) {
                  return "forms";
                }
                return null;
              },
            },
          ],
        },
        strictExecutionOrder: true,
      },
    },
  },
});

function packageNameFromModuleId(id: string): string | null {
  const normalized = id.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const segments = normalized.slice(index + marker.length).split("/");
  const first = segments[0];
  if (!first) return null;
  if (first.startsWith("@")) {
    const second = segments[1];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function isChartModule(id: string): boolean {
  const normalized = id.replaceAll("\\", "/");
  return (
    packageNameFromModuleId(normalized) === "recharts" ||
    normalized.endsWith("/src/web/components/ui/chart.tsx")
  );
}
