// Self-contained server output for the runtime Docker image. Produces
// .next/standalone/server.js plus a traced node_modules.
// (next.config.mjs so it loads on Next 14; TS config support arrived in 15.)
const nextConfig = {
  output: "standalone",
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
