"use client";

// Overview landing, rebuilt from the static prototype (public/overview.html):
// a KPI row plus the GPU utilization trend and allocation cards. The prototype's
// 活跃告警 KPI is replaced by active nodes. Every value is read live from the
// cluster via /api/overview (nodes, the operator's InferenceService /
// DevEnvironment / InferenceRuntimeProfile CRs, and Prometheus through the
// perses datasource proxy); nothing is hardcoded.

import { Box, Button, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OverviewSummary } from "@/app/api/overview/route";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { MessageKey, useI18n } from "@/lib/i18n";
import { platformPalette, usePlatformTheme } from "@/lib/perses/theme";

// Platform chart hues derived from the accent in the prototype (overview.html);
// matching values live in PLATFORM_CHART_COLORS in lib/perses/theme.ts.
const VIOLET = "#8b5cf6";
const CYAN = "#00b3a4";

const TREND_GRID = [0, 25, 50, 75, 100];

interface Kpi {
  dataOdId: string;
  label: string;
  /** Top-right meta text; hidden while null (e.g. vendor count still loading). */
  meta: string | null;
  value: number;
  unit: string;
  /** Optional foot line; hidden when null (e.g. no trend data for the GPU card). */
  footKey: MessageKey | null;
  footParams: Record<string, string> | null;
}

/**
 * Renders a localized foot template, bolding the interpolated {params} like the
 * prototype's `<b class="num">`. The template is read raw from the dictionary so
 * the placeholders are still present to split on.
 */
function Foot({
  templateKey,
  params,
}: {
  templateKey: MessageKey;
  params: Record<string, string>;
}) {
  const { locale } = useI18n();
  const template = dictionaries[locale][templateKey];
  const parts = template.split(/(\{[^}]+\})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\{[^}]+\}$/.test(part) ? (
          <Box
            key={i}
            component="b"
            sx={{
              color: "text.primary",
              fontWeight: 550,
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {params[part.slice(1, -1)]}
          </Box>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <Box
      data-od-id={kpi.dataOdId}
      sx={{
        p: "16px 18px",
        border: 1,
        borderColor: "divider",
        borderRadius: "var(--radius)",
        bgcolor: "background.paper",
        transition: "transform .18s ease, box-shadow .18s ease, border-color .18s ease",
        "&:hover": {
          transform: "translateY(-2px)",
          borderColor: "var(--accent-soft)",
          boxShadow: "0 12px 28px color-mix(in oklch, var(--fg) 12%, transparent)",
        },
      }}
    >
      <Typography
        sx={{
          fontSize: 12.5,
          color: "text.secondary",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 2,
        }}
      >
        {kpi.label}
        {kpi.meta !== null ? (
          <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
            {kpi.meta}
          </Box>
        ) : null}
      </Typography>
      <Typography
        sx={{
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 30,
          fontWeight: 650,
          letterSpacing: "-0.03em",
          mt: "8px",
          lineHeight: 1,
          color: "text.primary",
        }}
      >
        {kpi.value}
        <Box component="small" sx={{ fontSize: 14, color: "text.secondary", fontWeight: 400, ml: "4px" }}>
          {kpi.unit}
        </Box>
      </Typography>
      {kpi.footKey && kpi.footParams ? (
        <Typography sx={{ fontSize: 12, color: "text.secondary", mt: "8px" }}>
          <Foot templateKey={kpi.footKey} params={kpi.footParams} />
        </Typography>
      ) : null}
    </Box>
  );
}

function CardHead({ title, meta }: { title: string; meta: string }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "14px 20px",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Typography sx={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.005em", color: "text.primary" }}>
        {title}
      </Typography>
      <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
        {meta}
      </Typography>
    </Box>
  );
}

// The prototype's utilization chart is hand-drawn canvas (public/overview.html);
// ported as-is so it tracks the platform palette and redraws on resize / theme.
// The series come from the live overview payload; without them the card shows
// an empty state instead of the canvas.
function TrendCard({ series }: { series: { util: number[]; mem: number[] } | null }) {
  const { t } = useI18n();
  const mode = usePlatformTheme();
  const p = platformPalette[mode];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const draw = useCallback(() => {
    if (!series) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // Resolve inside the callback so its only deps are `mode` and `series` (not
    // the derived `p` object the legend below also uses).
    const p = platformPalette[mode];
    const fontMono =
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      "ui-monospace, Menlo, monospace";
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = w * dpr;
    cv.height = h * dpr;
    // Non-null alias for the nested path() closure below (TS doesn't narrow
    // captured bindings into nested functions).
    const g = ctx;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);

    const padL = 34;
    const padR = 10;
    const padT = 12;
    const padB = 24;
    const iw = w - padL - padR;
    const ih = h - padT - padB;

    // gridlines + y labels
    ctx.font = `10px ${fontMono}`;
    ctx.fillStyle = p.muted;
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    TREND_GRID.forEach((g) => {
      const y = padT + ih - (g / 100) * ih;
      ctx.beginPath();
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(w - padR, y + 0.5);
      ctx.stroke();
      ctx.fillText(String(g), 6, y + 3);
    });
    // x labels: real hours over the rolling 24h window (oldest -> now)
    const hour = (hoursAgo: number) => {
      const d = new Date(Date.now() - hoursAgo * 3600 * 1000);
      return `${String(d.getHours()).padStart(2, "0")}:00`;
    };
    [24, 18, 12, 6, 0].forEach((hoursAgo, i) => {
      const x = padL + (iw * i) / 4;
      ctx.fillText(hour(hoursAgo), i === 0 ? x : x - 14, h - 8);
    });

    function path(data: number[]) {
      g.beginPath();
      data.forEach((v, i) => {
        const x = padL + (i / (data.length - 1)) * iw;
        const y = padT + ih - (v / 100) * ih;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
    }

    // memory (violet, mid)
    path(series.mem);
    ctx.strokeStyle = VIOLET;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // utilization: filled area + line
    path(series.util);
    ctx.lineTo(padL + iw, padT + ih);
    ctx.lineTo(padL, padT + ih);
    ctx.closePath();
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;
    path(series.util);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // current point
    const current = series.util[series.util.length - 1];
    const lx = padL + iw;
    const ly = padT + ih - (current / 100) * ih;
    ctx.beginPath();
    ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = p.accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 7, 0, Math.PI * 2);
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [mode, series]);

  useEffect(() => {
    if (!series) return;
    draw();
    const cv = canvasRef.current;
    const parent = cv?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [draw, series]);

  return (
    <Box
      data-od-id="gpu-trend-card"
      sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper" }}
    >
      <CardHead title={t("ov.trend.title")} meta={t("ov.trend.source")} />
      <Box sx={{ display: "flex", gap: "18px", padding: "12px 20px 0", fontSize: 12, color: "text.secondary" }}>
        <Box component="span" sx={{ display: "inline-flex", alignItems: "center" }}>
          <Box component="i" sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: p.accent, display: "inline-block", mr: "6px" }} />
          {t("ov.trend.legend.util", { value: series ? String(Math.round(series.util[series.util.length - 1] ?? 0)) : "" })}
        </Box>
        <Box component="span" sx={{ display: "inline-flex", alignItems: "center" }}>
          <Box component="i" sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: VIOLET, opacity: 0.6, display: "inline-block", mr: "6px" }} />
          {t("ov.trend.legend.mem", { value: series ? String(Math.round(series.mem[series.mem.length - 1] ?? 0)) : "" })}
        </Box>
      </Box>
      {series ? (
        <Box sx={{ p: "12px 20px 16px" }}>
          <canvas ref={canvasRef} aria-label={t("ov.trend.title")} style={{ width: "100%", height: 220, display: "block" }} />
        </Box>
      ) : (
        <Box
          data-od-id="trend-empty"
          sx={{ p: "64px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}
        >
          {t("ov.trend.empty")}
        </Box>
      )}
    </Box>
  );
}

function AllocationCard({
  total,
  compute,
  inference,
  free,
}: {
  total: number;
  compute: number;
  inference: number;
  free: number;
}) {
  const { t } = useI18n();
  const mode = usePlatformTheme();
  const p = platformPalette[mode];
  const assigned = compute + inference;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const pcCompute = pct(compute);
  const pcInference = pct(inference);
  const pcFree = pct(free);

  return (
    <Box
      data-od-id="gpu-alloc-card"
      sx={{
        display: "flex",
        flexDirection: "column",
        border: 1,
        borderColor: "divider",
        borderRadius: "var(--radius)",
        bgcolor: "background.paper",
      }}
    >
      <CardHead title={t("ov.alloc.title")} meta={t("ov.alloc.total", { total: String(total) })} />
      <Box sx={{ flex: 1, display: "flex", alignItems: "center", gap: "20px", p: "18px 20px" }}>
        <Box
          role="img"
          aria-label={t("ov.alloc.aria", {
            compute: String(pcCompute),
            inference: String(pcInference),
            free: String(pcFree),
          })}
          sx={{
            position: "relative",
            width: 132,
            height: 132,
            borderRadius: "50%",
            flex: "none",
            background: `conic-gradient(${p.accent} 0 ${pcCompute}%, ${CYAN} ${pcCompute}% ${pcCompute + pcInference}%, ${p.border} ${pcCompute + pcInference}% 100%)`,
          }}
        >
          <Box sx={{ position: "absolute", inset: 26, borderRadius: "50%", bgcolor: "background.paper" }} />
          <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
            <Box>
              <Box component="b" sx={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 650, lineHeight: 1.1, color: "text.primary" }}>
                {assigned}
              </Box>
              <Box component="span" sx={{ fontSize: 10.5, color: "text.secondary" }}>
                {t("ov.alloc.assigned")}
              </Box>
            </Box>
          </Box>
        </Box>
        <Box sx={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: 12.5, flex: 1, color: "text.primary" }}>
          <AllocLegend swatch={p.accent} label={t("ov.alloc.compute")} value={String(compute)} />
          <AllocLegend swatch={CYAN} label={t("ov.alloc.inference")} value={String(inference)} />
          <AllocLegend swatch={p.border} label={t("ov.alloc.free")} value={String(free)} />
        </Box>
      </Box>
    </Box>
  );
}

function AllocLegend({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <Box sx={{ width: 9, height: 9, borderRadius: "2px", flex: "none", bgcolor: swatch }} />
      <Box component="span">{label}</Box>
      <Box component="span" sx={{ ml: "auto", fontFamily: "var(--font-mono)", color: "text.primary" }}>
        {value}
      </Box>
    </Box>
  );
}

export default function OverviewPage() {
  const { t } = useI18n();
  const [data, setData] = useState<OverviewSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // Refetch on mount, then every 30s (the overview claims live data). The
  // interval pauses while the tab is hidden so we don't keep hitting the
  // cluster in the background. `reloadKey` (the retry button) restarts both.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = () => {
      fetch("/api/overview")
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((d: OverviewSummary) => {
          if (cancelled) return;
          setData(d);
          setFailed(false);
          setErrorMsg("");
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setErrorMsg(err.message);
          setFailed(true);
        });
    };

    load();
    timer = setInterval(load, 30_000);

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearInterval(timer);
        timer = undefined;
      } else if (!timer) {
        timer = setInterval(load, 30_000);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reloadKey]);

  const trendLast = (arr?: number[]): number | null => {
    if (!arr || arr.length === 0) return null;
    return Math.round(arr[arr.length - 1]);
  };

  const kpis: Kpi[] = data
    ? [
        {
          dataOdId: "kpi-nodes",
          label: t("ov.kpi.nodes.label"),
          meta: t("ov.kpi.nodes.meta"),
          value: data.nodes.total,
          unit: t("ov.kpi.nodes.unit"),
          footKey: "ov.kpi.nodes.foot",
          footParams: {
            ready: String(data.nodes.ready),
            notReady: String(data.nodes.total - data.nodes.ready),
          },
        },
        {
          dataOdId: "kpi-gpu",
          label: t("ov.kpi.gpu.label"),
          meta: t("ov.kpi.gpu.meta", { count: String(data.gpu.vendors) }),
          value: data.gpu.totalCards,
          unit: t("ov.kpi.gpu.unit"),
          footKey: data.trend ? "ov.kpi.gpu.foot" : null,
          footParams: data.trend
            ? { util: `${trendLast(data.trend.util)}%`, mem: `${trendLast(data.trend.mem)}%` }
            : null,
        },
        {
          dataOdId: "kpi-inference",
          label: t("ov.kpi.inf.label"),
          meta: t("ov.kpi.inf.meta"),
          value: data.inference.total,
          unit: t("ov.kpi.inf.unit"),
          footKey: "ov.kpi.inf.foot",
          footParams: {
            ready: String(data.inference.ready),
            scaling: String(data.inference.scaling),
          },
        },
        {
          dataOdId: "kpi-devenv",
          label: t("ov.kpi.dev.label"),
          meta: t("ov.kpi.dev.meta"),
          value: data.devenv.total,
          unit: t("ov.kpi.dev.unit"),
          footKey: "ov.kpi.dev.foot",
          footParams: {
            running: String(data.devenv.running),
            stopped: String(data.devenv.stopped),
          },
        },
      ]
    : [];

  return (
    <Box sx={{ p: "26px 28px 64px", maxWidth: 1240, mx: "auto", width: "100%" }}>
      <Box
        data-od-id="page-head"
        sx={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "20px", mb: "22px" }}
      >
        <Box>
          <Typography sx={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", lineHeight: 1.2, color: "text.primary" }}>
            {t("nav.overview")}
          </Typography>
          <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>
            {data ? t("ov.sub", { version: data.nodes.version ?? "—", nodes: String(data.nodes.total) }) : ""}
          </Typography>
        </Box>
      </Box>

      {failed ? (
        <Box
          data-od-id="overview-error"
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: "var(--radius)",
            bgcolor: "background.paper",
            p: "32px 20px",
            textAlign: "center",
          }}
        >
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            {t("ov.loadError", { error: errorMsg })}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              setData(null);
              setFailed(false);
              setErrorMsg("");
              setReloadKey((k) => k + 1);
            }}
            sx={{ mt: "12px", textTransform: "none", fontSize: 12.5 }}
          >
            {t("ov.retry")}
          </Button>
        </Box>
      ) : !data ? (
        <Box
          data-od-id="overview-loading"
          sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}
        >
          {t("ov.loading")}
        </Box>
      ) : (
        <>
          <Box
            data-od-id="kpi-row"
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(4, 1fr)" },
              gap: "14px",
              mb: "14px",
            }}
          >
            {kpis.map((kpi) => (
              <KpiCard key={kpi.dataOdId} kpi={kpi} />
            ))}
          </Box>

          <Box
            data-od-id="usage-section"
            sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: "14px" }}
          >
            <TrendCard series={data.trend} />
            <AllocationCard
              total={data.gpu.totalCards}
              compute={data.gpu.compute}
              inference={data.gpu.inference}
              free={data.gpu.free}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
