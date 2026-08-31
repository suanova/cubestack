"use client";

// Monitoring landing: a card per provisioned dashboard, styled like the static
// prototype pages' `.card` + `.hover-float`. Each card links to the dashboard's
// own page at /dashboards/[name].

import { Box, CircularProgress, Typography } from "@mui/material";
import { DashboardResource } from "@perses-dev/core";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { DASHBOARD_DESCRIPTIONS } from "@/lib/perses/dashboard-catalog";
import { PERSES_PROJECT } from "@/lib/perses/config";
import { fetchDashboards } from "@/lib/perses/perses-client";

function DashboardCard({ dashboard }: { dashboard: DashboardResource }) {
  const { t } = useI18n();
  const name = dashboard.metadata.name;
  const descKey = DASHBOARD_DESCRIPTIONS[name];
  return (
    <Box
      component={Link}
      href={`/dashboards/${name}`}
      sx={{
        display: "block",
        padding: "18px 20px",
        border: 1,
        borderColor: "divider",
        borderRadius: "var(--radius)",
        bgcolor: "background.paper",
        textDecoration: "none",
        color: "text.primary",
        transition:
          "transform .18s ease, box-shadow .18s ease, border-color .18s ease",
        "&:hover": {
          transform: "translateY(-2px)",
          borderColor: "var(--accent-soft)",
          boxShadow: "0 12px 28px color-mix(in oklch, var(--fg) 12%, transparent)",
        },
      }}
    >
      <Typography
        sx={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1.3 }}
      >
        {dashboard.spec.display?.name ?? name}
      </Typography>
      {descKey ? (
        <Typography
          sx={{ marginTop: "8px", fontSize: 12.5, lineHeight: 1.5, color: "text.secondary" }}
        >
          {t(descKey)}
        </Typography>
      ) : null}
    </Box>
  );
}

export default function DashboardsPage() {
  const { t } = useI18n();
  const [dashboards, setDashboards] = useState<DashboardResource[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  // Tracks whether the request has settled, so a successful but empty list is
  // distinguishable from the not-yet-loaded state (both have length 0).
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDashboards(PERSES_PROJECT)
      .then((items) => {
        if (!cancelled) setDashboards(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box sx={{ p: 3, maxWidth: 1240, mx: "auto", width: "100%" }}>
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
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            gap: "14px",
          }}
        >
          {dashboards.map((d) => (
            <DashboardCard key={d.metadata.name} dashboard={d} />
          ))}
        </Box>
      )}
    </Box>
  );
}
