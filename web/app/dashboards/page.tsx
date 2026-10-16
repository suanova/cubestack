// Route entry for the monitoring landing. The deep-link values (?dashboard=,
// ?scope=) are resolved here, from the request, and handed to the landing as
// plain props.
//
// This has to happen on the server: the route provisions nothing dynamic, so
// Next prerenders it, and the `searchParams` promise a client page receives is
// the one that prerender settled — always `{}`. Reading it inside the client
// landing therefore silently dropped the query string: measured in production,
// /dashboards and /dashboards?dashboard=inference-service-dashboard served
// byte-identical HTML, so every Overview KPI card opened Resource Overview.
// Awaiting `searchParams` is a request-time API, which is what makes this route
// render per request.

import { DashboardsLanding } from "./dashboards-landing";

export default async function DashboardsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  return (
    <DashboardsLanding
      requestedDashboard={typeof sp.dashboard === "string" ? sp.dashboard : null}
      requestedScope={typeof sp.scope === "string" ? sp.scope : null}
    />
  );
}
