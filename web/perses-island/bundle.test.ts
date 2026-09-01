// Regression test for the react-18 island bundle. The dashboard renders in a
// standalone esbuild bundle built against the real react 18.2.0 (Next 16
// forces react 19 into its client bundles, which perses 0.54 cannot run
// under). Build the bundle with the real build script and assert the runtime
// properties the fix depends on, so a future change that regresses any of them
// fails here instead of breaking panels at runtime.
//
// Each assertion fails under the previous incorrect behavior:
// - react 19 in the bundle (island picking up Next's react) -> would contain
//   next/dist/compiled react instead of node_modules/react 18.2.0
// - un-folded process.env.NEXT_PUBLIC_PERSES_PROJECT -> "process is not defined"
// - a second (ESM) @tanstack/react-query instance -> "No QueryClient set"

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "public/perses-viewer/perses-viewer.js");

let bundle = "";

beforeAll(() => {
  // Build via the real build script (not a copy of its options) so the test
  // exercises exactly what build:island produces.
  execFileSync(process.execPath, ["perses-island/build.mjs"], { cwd: root });
  bundle = readFileSync(bundlePath, "utf8");
}, 30000);

describe("react-18 perses island bundle", () => {
  it("bundles the real react 18.2.0, not Next's react 19", () => {
    // esbuild emits a module header for node_modules/react (18.2.0). Next's
    // bundled react lives under next/dist/compiled and must not be here.
    expect(bundle).toContain("// node_modules/react/index.js");
    expect(bundle).toContain('version: "18.2.0"');
    expect(bundle).not.toContain("next/dist/compiled");
  });

  it("folds process.env so lib/perses/config.ts does not crash on the browser `process`", () => {
    expect(bundle).not.toMatch(/process\.env\.[A-Za-z0-9_]+/);
  });

  it("bundles a single @tanstack/react-query instance so the QueryClient context is shared", () => {
    // Two react-query instances (CJS + ESM) put the QueryClientProvider and the
    // perses hooks on different contexts -> "No QueryClient set". Only the CJS
    // build may be bundled.
    expect(bundle.match(/No QueryClient set/g)).toHaveLength(1);
    expect(bundle).not.toContain("QueryClientProvider.mjs");
  });

  it("executes cleanly and exposes mountPersesIsland", () => {
    // Executing the IIFE in jsdom catches top-level crashes (e.g. `process`).
    // The bundle declares `var PersesIsland = (() => {...})()`; the leading
    // `"use strict"` keeps that var scoped to the eval in jsdom (it never
    // reaches window), so instead of relying on global attachment we append a
    // final expression that returns the IIFE's exports object — eval returns
    // the completion value of its last statement.
    const island = globalThis.eval(`${bundle}\n;PersesIsland`);
    expect(island?.mountPersesIsland).toBeTypeOf("function");
  }, 20000);
});
