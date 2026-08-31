import { NextRequest } from "next/server";

// Proxying uses Node's fetch (streams), not the Edge runtime.
export const runtime = "nodejs";

// Where the Perses server lives. Local dev defaults to the standard Docker
// mapping; in-cluster this points at the Perses Service URL.
const PERSES_SERVER_URL = process.env.PERSES_SERVER_URL ?? "http://localhost:8080";

/**
 * Forward a read-only portal `/api/perses/*` request to the Perses server.
 *
 * The portal's dashboards only render dashboards, so this proxy exposes two
 * surfaces on the Perses server:
 *
 *  - GET on any path — the resource API (`/api/v1/...`), the datasource proxy
 *    (`/proxy/...`) queries that reach Prometheus/Thanos, and the remote
 *    plugin bundles loaded by @perses-dev/plugin-system. One catch-all keeps
 *    them all same-origin.
 *  - POST only on the datasource proxy path, where a datasource query is run.
 *
 * Resource mutations (POST on `/api/v1/...`, and PUT/PATCH/DELETE anywhere)
 * are never needed for dashboard rendering: PUT/PATCH/DELETE are not exported
 * (Next.js responds 405), and POST is rejected unless it targets a datasource
 * query.
 */
function isDatasourceQuery(path: string[]): boolean {
  return path[0] === "proxy";
}

async function proxy(request: NextRequest, path: string[]) {
  const upstreamUrl = `${PERSES_SERVER_URL}/${path.join("/")}${request.nextUrl.search}`;

  if (request.method === "POST" && !isDatasourceQuery(path)) {
    // Only datasource queries may be written to; reject resource mutations.
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const headers = new Headers();
    // Only pass through headers the Perses server cares about.
    for (const name of ["accept", "content-type"]) {
      const value = request.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }

    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      // Request bodies can be large (JSON dashboards); keep the default limit.
      // `duplex` is required for streaming bodies but missing from the DOM
      // RequestInit type.
      duplex: "half",
      cache: "no-store",
    } as RequestInit & { duplex: "half" });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    console.error(`Perses proxy failed for ${request.method} ${upstreamUrl}:`, err);
    return Response.json({ error: "Failed to reach the Perses server" }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return proxy(request, path);
}
