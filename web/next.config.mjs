// Self-contained server output for the runtime Docker image. Produces
// .next/standalone/server.js plus a traced node_modules.
// (next.config.mjs so it loads on Next 14; TS config support arrived in 15.)
const nextConfig = {
  output: "standalone",
  // Next 16 blocks dev-resource requests from cross-origin hosts by default;
  // the portal is commonly reached as http://127.0.0.1:3000 as well as
  // localhost, so allow both in development.
  allowedDevOrigins: ["127.0.0.1"],
  webpack: (config) => {
    // The perses DashboardProvider builds its zustand store by spreading
    // slice creators through a rest-arg initializer. Production minification
    // and module concatenation both break that closure (`get is not a
    // function` at view-panel-slice.js); the dev build — where both are off —
    // renders the dashboards correctly. Keep them off for a correct bundle.
    config.optimization.minimize = false;
    config.optimization.concatenateModules = false;
    return config;
  },
};

export default nextConfig;
