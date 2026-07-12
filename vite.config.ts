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
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/recharts/")) return "charts";
          if (id.includes("/@tanstack/")) return "tanstack";
          if (id.includes("/@radix-ui/")) return "radix";
          if (
            id.includes("/react-hook-form/") ||
            id.includes("/@hookform/") ||
            id.includes("/zod/")
          ) {
            return "forms";
          }
          if (id.includes("/react/") || id.includes("/react-dom/")) return "react";
          return undefined;
        },
      },
    },
  },
});
