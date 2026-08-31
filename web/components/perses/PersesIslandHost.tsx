"use client";

// Host for the react-18 perses island. Next 16 forces react 19 into its client
// bundles, which perses 0.54 cannot run under, so the dashboard renders in a
// standalone esbuild bundle (perses-island/) built against the real react 18.2.0
// and mounted here via react-dom 18 createRoot. This component lives in the
// react-19 Next tree and only provides the container div + loads the island's
// static assets; it never renders into the island's DOM itself.

import { Box, CircularProgress, Typography } from "@mui/material";
import type { DashboardResource } from "@perses-dev/core";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";

const ISLAND_CSS = "/perses-viewer/perses-viewer.css";
const ISLAND_JS = "/perses-viewer/perses-viewer.js";

// Structural match for perses-island/index.tsx's PersesIslandOptions. Re-imported
// locally (not from the island entry) so the Next bundle never pulls in react 18.
interface PersesIslandOptions {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
}

interface PersesIslandApi {
  mountPersesIsland(el: HTMLElement, options: PersesIslandOptions): () => void;
}

declare global {
  interface Window {
    PersesIsland?: PersesIslandApi;
  }
}

// Both loaders resolve even on error so a CSS/font hiccup never blocks the
// mount; the island mount itself is the error surface.
function loadStylesheet(): Promise<void> {
  const present = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some(
    (link) => link.getAttribute("href") === ISLAND_CSS,
  );
  if (present) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = ISLAND_CSS;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(link);
  });
}

function loadScript(): Promise<void> {
  if (window.PersesIsland) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${ISLAND_JS}"]`);
  if (existing) {
    return new Promise((resolve) => {
      if (window.PersesIsland) return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => resolve(), { once: true });
    });
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = ISLAND_JS;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(script);
  });
}

export interface PersesIslandHostProps {
  project: string;
  dashboardName: string;
  dashboardResource: DashboardResource;
}

export function PersesIslandHost({
  project,
  dashboardName,
  dashboardResource,
}: PersesIslandHostProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unmount: (() => void) | null = null;

    async function mount() {
      const el = hostRef.current;
      if (!el) return;
      try {
        await loadStylesheet();
        await loadScript();
        if (cancelled) return;
        if (!window.PersesIsland) {
          throw new Error("Perses viewer script failed to load");
        }
        unmount = window.PersesIsland.mountPersesIsland(el, {
          project,
          dashboardName,
          dashboardResource,
        });
        if (!cancelled) setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          setMountError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        }
      }
    }
    void mount();

    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [project, dashboardName, dashboardResource]);

  if (mountError) {
    return <Typography color="error">{t("dash.viewError", { error: mountError })}</Typography>;
  }

  return (
    <Box sx={{ position: "relative", width: "100%" }}>
      {/* React 19 never renders into this div; the island owns its subtree. */}
      <div ref={hostRef} style={{ width: "100%", minHeight: 480 }} />
      {isLoading && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress />
        </Box>
      )}
    </Box>
  );
}
