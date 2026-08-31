import { DashboardResource } from "@perses-dev/core";

import { PERSES_PROXY_BASE_PATH } from "./config";

/**
 * GET a dashboard resource from the Perses server, proxied through the portal.
 *
 * The portal serves `/api/perses/*` -> Perses server, so the same-origin path
 * below is the only thing the browser ever sees.
 */
export async function fetchDashboard(
  project: string,
  name: string,
): Promise<DashboardResource> {
  const res = await fetch(
    `${PERSES_PROXY_BASE_PATH}/api/v1/projects/${encodeURIComponent(project)}/dashboards/${encodeURIComponent(name)}`,
  );
  if (!res.ok) {
    throw new Error(`Perses dashboard request failed (${res.status})`);
  }
  return res.json();
}

/** List the dashboards in a project (used by the dashboard index page). */
export async function fetchDashboards(project: string): Promise<DashboardResource[]> {
  const res = await fetch(
    `${PERSES_PROXY_BASE_PATH}/api/v1/projects/${encodeURIComponent(project)}/dashboards`,
  );
  if (!res.ok) {
    throw new Error(`Perses dashboard list request failed (${res.status})`);
  }
  return res.json();
}
