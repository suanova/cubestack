import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server output for the runtime Docker image. Produces
  // .next/standalone/server.js plus a traced node_modules.
  output: "standalone",
};

export default nextConfig;
