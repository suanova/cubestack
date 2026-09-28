// The sub-path the portal is served under. Single source of truth: imported by
// next.config.mjs (which feeds Next's `basePath`) and by lib/base-path.ts (which
// prefixes the URLs Next does not rewrite for us). Plain .mjs so the config file
// and the TypeScript app can both import it.
export const BASE_PATH = "/cubestack";
