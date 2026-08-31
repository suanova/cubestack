// Builds the react-18 perses island bundle into public/perses-viewer/. Run via
// `npm run build:island` before `next build` / `next dev` so the static assets
// (JS + CSS + fonts) exist under public/ for Next to serve.

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/perses-island
const root = path.resolve(here, ".."); // web

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
  // node_modules/react (18.2.0), NOT Next's bundled react-builtin.
  jsx: "automatic",
  // Make react resolve its production build. process.env itself is folded to {}
  // (lib/perses/config.ts reads process.env.NEXT_PUBLIC_PERSES_PROJECT, which
  // then falls back to the "perses-dev" default like the Next build).
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
});
