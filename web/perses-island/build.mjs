// Builds the react-18 perses island bundle into public/perses-viewer/. Run via
// `npm run build:island` before `next build` / `next dev` so the static assets
// (JS + CSS + fonts) exist under public/ for Next to serve.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/perses-island
const root = path.resolve(here, ".."); // web

// perses 0.55's EChart module registers the echarts chart extensions at module
// top level. Its module graph has a cycle (components/index <-> EChart/index)
// and esbuild now inlines EChart.js eagerly while leaving echarts' extension
// registry in a lazily initialized module, so the registration runs first and
// throws "Cannot read properties of undefined (reading 'push')" at bundle
// load. Empty the registration list: the island never renders the local EChart
// component (it is tree-shaken), and remote plugin bundles get echarts through
// the module-federation shared module, which loads echarts on demand.
const neutralizePersesEChartsRegistration = {
  name: "perses-echarts-registration",
  setup(build) {
    build.onLoad(
      { filter: /@perses-dev\/components\/dist\/EChart\/EChart\.js$/ },
      async (args) => {
        const source = await fs.readFile(args.path, "utf8");
        const contents = source.replace(
          /registerEChartsComponents\(\[[\s\S]*?\]\);/,
          "registerEChartsComponents([]);",
        );
        if (contents === source) {
          throw new Error(
            `Expected a top-level registerEChartsComponents([...]) call in ${args.path}; ` +
              "the perses EChart registration workaround needs updating.",
          );
        }
        return { contents, loader: "js" };
      },
    );
  },
};

await esbuild.build({
  entryPoints: [path.join(root, "perses-island/index.tsx")],
  bundle: true,
  outfile: path.join(root, "public/perses-viewer/perses-viewer.js"),
  format: "iife",
  // The entry's exports land on window.PersesIsland (e.g. mountPersesIsland).
  globalName: "PersesIsland",
  platform: "browser",
  target: ["es2020"],
  // Match tsconfig "jsx": "react-jsx"; resolves react/jsx-runtime from
  // node_modules/react (18.3.1), NOT Next's bundled react-builtin.
  jsx: "automatic",
  // Make react resolve its production build. process.env itself is folded to {}
  // (lib/perses/config.ts reads process.env.NEXT_PUBLIC_PERSES_PROJECT, which
  // then falls back to the "monitoring" default like the Next build).
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env": "{}",
  },
  // Mirror tsconfig paths @/* -> ./*. esbuild prefix-matches with a `/`
  // boundary, so @perses-dev/* scoped imports are left untouched.
  alias: {
    "@": root,
    // perses is bundled from its CJS dist, which requires react-query via the
    // "default" exports condition (build/lib/index.js). Our own ESM imports
    // would resolve the "import" condition (build/lib/index.mjs), giving two
    // react-query instances whose QueryClient contexts never meet — perses
    // hooks then throw "No QueryClient set". Pin every import to the CJS build.
    "@tanstack/react-query": path.join(root, "node_modules/@tanstack/react-query/build/lib/index.js"),
  },
  // perses pulls in @fontsource/inter/*.css; copy the font files next to the
  // bundle so the CSS resolves them.
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".eot": "file",
  },
  // The perses zustand store breaks under minification (`get is not a function`
  // in view-panel-slice.js), the same reason next.config.mjs disables webpack
  // minification. esbuild leaves function params untouched without minify.
  minify: false,
  sourcemap: true,
  // zustand/react-router use import.meta.env / import.meta.hot; in an IIFE
  // esbuild substitutes import.meta with {} (guards just take the dev path).
  logOverride: { "empty-import-meta": "silent" },
  logLevel: "info",
  plugins: [neutralizePersesEChartsRegistration],
});
