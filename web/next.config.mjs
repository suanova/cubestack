import { BASE_PATH } from "./base-path.mjs";

// Self-contained server output for the runtime Docker image. Produces
// .next/standalone/server.js plus a traced node_modules.
// (next.config.mjs so it loads on Next 14; TS config support arrived in 15.)
const nextConfig = {
  output: "standalone",
  // The portal is served under a sub-path (see base-path.mjs). Next rewrites
  // <Link>/<Image>/router and static assets for us, but NOT raw fetch() calls
  // or server-side redirects — those go through lib/base-path.ts.
  basePath: BASE_PATH,
  // Next 16 blocks dev-resource requests from cross-origin hosts by default;
  // the portal is commonly reached as http://127.0.0.1:3000 as well as
  // localhost, so allow both in development.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
