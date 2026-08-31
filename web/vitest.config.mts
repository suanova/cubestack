import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run in jsdom (theme-storage touches localStorage/matchMedia/
// document.documentElement). The @/ alias mirrors tsconfig paths so test
// imports resolve the same way the app's do.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": root,
    },
  },
});
