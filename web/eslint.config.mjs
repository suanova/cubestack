import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 exports flat configs directly; ESLint 9+ requires
// flat config, so no legacy FlatCompat bridge is needed.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Static assets, including the generated react-18 island bundle
    // (perses-island/build.mjs writes public/perses-viewer/).
    "public/**",
  ]),
]);

export default eslintConfig;
