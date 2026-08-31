"use client";

// Dashboard viewer page: fetch the dashboard named by the route param and
// render it via DashboardViewer. Next 15 passes params to client pages as a
// Promise, unwrapped below.

import { Box, CircularProgress, Typography } from "@mui/material";
import { DashboardResource } from "@perses-dev/core";
import { useEffect, useState } from "react";

import { DashboardViewer } from "@/components/perses/DashboardViewer";
import { useI18n } from "@/lib/i18n";
import { PERSES_PROJECT } from "@/lib/perses/config";
import { fetchDashboard } from "@/lib/perses/perses-client";

export default function DashboardPage({ params }: { params: Promise<{ name: string }> }) {
  const { t } = useI18n();
  const [name, setName] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResource | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  // Next 15 passes params to segments as a Promise; unwrap it here (React 18
  // has no use() to hand the promise to, so resolve it in an effect).
  useEffect(() => {
    let cancelled = false;
    params.then((p) => {
      if (!cancelled) setName(p.name);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (name === null) return;
    let cancelled = false;
    setViewError(null);
    setDashboard(null);
    fetchDashboard(PERSES_PROJECT, name)
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
  }, [name]);

  const title = dashboard?.spec.display?.name ?? name ?? "";

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
        {title}
      </Typography>

      {viewError ? (
        <Typography color="error">{t("dash.viewError", { error: viewError })}</Typography>
      ) : !dashboard ? (
        <CircularProgress />
      ) : (
        <DashboardViewer
          project={PERSES_PROJECT}
          dashboardName={dashboard.metadata.name}
          dashboardResource={dashboard}
        />
      )}
    </Box>
  );
}
