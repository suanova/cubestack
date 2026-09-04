"use client";

// Monitoring landing: a dropdown of the provisioned dashboards, with the
// selected dashboard's panels rendered inline beside it (via the react-18
// perses island). The dropdown and the dashboard's variable filters share one
// line. Defaults to the first dashboard in the list, unless a ?dashboard=
// query param (used by the Overview landing deep links) names a specific one.
// The dropdown label and the description read straight off each dashboard
// resource (spec.display), which is the single source of truth — no frontend
// catalog.

import {
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import { DashboardResource } from "@perses-dev/core";
import { useEffect, useState } from "react";

import { PersesIslandHost } from "@/components/perses/PersesIslandHost";
import { useI18n } from "@/lib/i18n";
import { PERSES_PROJECT } from "@/lib/perses/config";
import { fetchDashboard, fetchDashboards } from "@/lib/perses/perses-client";

export default function DashboardsPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { t } = useI18n();
  const [dashboards, setDashboards] = useState<DashboardResource[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  // Tracks whether the request has settled, so a successful but empty list is
  // distinguishable from the not-yet-loaded state (both have length 0).
  const [loaded, setLoaded] = useState(false);
  // Selected dashboard name; defaults to the first dashboard once the list
  // loads, unless the ?dashboard= query param names one of the listed
  // dashboards (then that one is preselected).
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Optional landing scope carried by the Overview deep links (?scope=gpu): it
  // tells the island to start the selected dashboard in that scope (see
  // DashboardConditionalPanels). A manual pick from the dropdown clears it.
  const [scope, setScope] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResource | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Next passes searchParams as a Promise; the host is React 18 (no use()),
    // so resolve it in the same async flow as the list. A query param that
    // doesn't match any provisioned dashboard falls back to the first.
    (async () => {
      const sp = searchParams ? await searchParams : {};
      const requested = typeof sp.dashboard === "string" ? sp.dashboard : null;
      const requestedScope = typeof sp.scope === "string" ? sp.scope : null;
      try {
        const items = await fetchDashboards(PERSES_PROJECT);
        if (cancelled) return;
        setDashboards(items);
        const match = requested !== null && items.some((d) => d.metadata.name === requested);
        setSelectedName(match ? requested : items[0]?.metadata.name ?? null);
        setScope(requestedScope);
      } catch (err: unknown) {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  useEffect(() => {
    if (selectedName === null) return;
    let cancelled = false;
    // Intentionally reset the view before fetching the new dashboard when the
    // selection changes. react-hooks v7 flags synchronous setState-in-effect.
    /* eslint-disable react-hooks/set-state-in-effect */
    setViewError(null);
    setDashboard(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchDashboard(PERSES_PROJECT, selectedName)
      .then((resource) => {
        if (!cancelled) setDashboard(resource);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setViewError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName]);

  // The description lives on the dashboard resource itself (spec.display), so
  // the list payload already carries it — no extra fetch needed.
  const selected = dashboards.find((d) => d.metadata.name === selectedName) ?? null;

  return (
    <Box sx={{ p: 3, maxWidth: 1240, width: "100%" }}>
      <Typography
        sx={{
          fontSize: 22,
          fontWeight: 650,
          letterSpacing: "-0.015em",
          lineHeight: 1.2,
          mb: "22px",
          color: "text.primary",
        }}
      >
        {t("nav.monitoring")}
      </Typography>

      {listError ? (
        <Typography color="error">{t("dash.loadError", { error: listError })}</Typography>
      ) : !loaded ? (
        <CircularProgress />
      ) : dashboards.length === 0 ? (
        <Typography sx={{ color: "text.secondary" }}>{t("dash.empty")}</Typography>
      ) : (
        <>
          {selected?.spec.display?.description ? (
            <Typography
              sx={{ mb: "16px", fontSize: 12.5, lineHeight: 1.5, color: "text.secondary" }}
            >
              {selected.spec.display.description}
            </Typography>
          ) : null}
          {/* The island spans the full width so the panels start at the content's
              left edge; the picker is overlaid on the variable toolbar's left and
              the toolbar is shifted over (variableRowSpacing) to make room. */}
          <Box sx={{ position: "relative", width: "100%" }}>
            <FormControl
              size="small"
              sx={{ position: "absolute", left: 0, top: 0, zIndex: 1, width: 260 }}
            >
              <InputLabel id="dashboard-select-label">{t("dash.select")}</InputLabel>
              <Select
                labelId="dashboard-select-label"
                label={t("dash.select")}
                value={selectedName ?? ""}
                onChange={(e) => {
                  setSelectedName(e.target.value as string);
                  // A manual pick is a return to that dashboard's default (full)
                  // view — drop any landing scope the deep link carried.
                  setScope(null);
                }}
                // MUI Select does not fire onChange when the already-selected item
                // is picked again, so clearing on close (any close: a pick, Esc,
                // or clicking away) is what lets a GPU-scoped deep link hand back
                // to the full dashboard by reopening the picker.
                onClose={() => setScope(null)}
              >
                {dashboards.map((d) => (
                  <MenuItem key={d.metadata.name} value={d.metadata.name}>
                    {d.spec.display?.name ?? d.metadata.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {viewError ? (
              <Typography color="error" sx={{ pt: "44px" }}>
                {t("dash.viewError", { error: viewError })}
              </Typography>
            ) : !dashboard ? (
              <Box
                sx={{ minHeight: 480, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <CircularProgress />
              </Box>
            ) : (
              <PersesIslandHost
                project={PERSES_PROJECT}
                dashboardName={dashboard.metadata.name}
                dashboardResource={dashboard}
                variableRowSpacing="276px"
                scope={scope ?? undefined}
              />
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
