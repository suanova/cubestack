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
    // Unit tests are *.test.ts(x); the Playwright specs in e2e/ use *.spec.ts
    // and must not be collected by vitest.
    include: ["**/*.test.{ts,tsx}"],
  },
  // tsconfig sets jsx: "preserve" for Next, which leaves JSX in the transform
  // output and trips vite's import-analysis lexer when a test imports a .tsx
  // component. The test runner transforms .tsx with oxc (vitest rebuilds the
  // esbuild config but leaves oxc alone), so lower JSX with the automatic
  // runtime here.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      "@": root,
    },
  },
});
