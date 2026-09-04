"use client";

// 推理服务 (Inference Services) — rebuilt from the static prototype
// (web/public/inference-services.html) against the live cluster. Every value
// comes from /api/inferenceservices, which reads the operator's InferenceService
// and InferenceRuntimeProfile CRs directly; the prototype is only the visual
// reference, never a data source. The scale panel edits the real override knobs
// (decodeReplicas / prefillReplicas / groupSize) via a PATCH. Metrics are
// best-effort Prometheus data and show an empty state when absent.

import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Select, Switch, TextField, Typography, Stepper, Step, StepLabel } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CreateOptionsResponse } from "@/app/api/inferenceservices/options/route";
import type { InferenceServiceSummary } from "@/app/api/inferenceservices/route";
import { useI18n } from "@/lib/i18n";
import { platformPalette, usePlatformTheme } from "@/lib/perses/theme";

// The prototype's filter set is 全部 / Ready / 扩缩容中, where "scaling" keeps
// the prototype's inclusive predicate: every service that is not ready yet
// (provisioning, mid-scale, or errored).
type Filter = "all" | "ready" | "scaling";

// Status hues derived from the platform accent, matching the semantic tokens the
// prototype derives in public/inference-services.html. Light-theme values, used
// for the dots/chips; soft backgrounds are near-transparent mixes of the same.
const STATUS_OK = "#27c37b";
const STATUS_WARN = "#e0a13a";
const STATUS_ERR = "#e15c5c";

const soft = (hex: string, pct = 13) => `color-mix(in oklch, ${hex} ${pct}%, transparent)`;

/** Port of the prototype's sparkline: an SVG polyline + filled area. */
function Sparkline({ data }: { data: number[] }) {
  const mode = usePlatformTheme();
  const p = platformPalette[mode];
  const W = 300;
  const H = 56;
  const max = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(H - 4 - (v / max) * (H - 10)).toFixed(1)}`);
  const line = pts.join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: "block", width: "100%", height: 56 }}>
      <polygon points={area} fill="var(--accent-soft)" />
      <polyline points={line} fill="none" stroke={p.accent} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

type StatusClass = "ready" | "pending" | "err";

const statusInfo: Record<StatusClass, { dot: string; bg: string }> = {
  ready: { dot: STATUS_OK, bg: soft(STATUS_OK) },
  pending: { dot: STATUS_WARN, bg: soft(STATUS_WARN) },
  err: { dot: STATUS_ERR, bg: soft(STATUS_ERR, 12) },
};

function StatusChip({ cls, label }: { cls: StatusClass; label: string }) {
  const c = statusInfo[cls];
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: "6px", px: "9px", py: "2px", borderRadius: 999, fontSize: 12, bgcolor: c.bg, whiteSpace: "nowrap" }}
    >
      <Box component="span" sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: c.dot, flex: "none" }} />
      {label}
    </Box>
  );
}

function serviceStatus(s: InferenceServiceSummary): StatusClass {
  if (s.ready === true) return "ready";
  if (s.ready === false) return "err";
  return "pending";
}

const gpuText = (s: InferenceServiceSummary): string =>
  s.gpuPerPod ? `${s.gpuPerPod} × ${s.gpuModel ?? s.vendor ?? "GPU"}` : "—";

// Render the replica counts as separate lines (decode / prefill / group size)
// so the column reads clearly instead of one crammed line.
function ReplicaRows({ s }: { s: InferenceServiceSummary }) {
  const rows: Array<[string, string]> = [
    ["decode", String(s.decode.current)],
    ["prefill", String(s.prefill.current)],
    ["group", String(s.groupSize.current)],
  ];
  return (
    <Box sx={{ fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7 }}>
      {rows.map(([label, value]) => (
        <Box key={label} sx={{ whiteSpace: "nowrap" }}>
          {label} <Typography component="span" sx={{ color: "text.secondary" }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  );
}

const numFmt = (n: number | null): string => (n === null ? "—" : String(Math.round(n)));

// The list spans all namespaces, and the same service name can exist in two of
// them (team-a/api and team-b/api). Selection, lookup and row keys therefore
// use the composite namespace/name — never the bare name, which would resolve
// to the first match and could scale the wrong namespace's service.
const svcKey = (s: { namespace: string; name: string }): string => `${s.namespace}/${s.name}`;

export default function InferenceServicesPage() {
  const { t } = useI18n();

  const [items, setItems] = useState<InferenceServiceSummary[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleMsg, setScaleMsg] = useState<string | null>(null);
  const [scaleErr, setScaleErr] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);

  // After a successful deploy, select the just-created service on the next
  // reload (the ref is consumed by load()). Holds the composite namespace/name
  // key so a same-named service in another namespace cannot steal the selection.
  const selectAfterLoad = useRef<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/inferenceservices")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: { items: InferenceServiceSummary[] }) => {
        setItems(d.items);
        setLoading(false);
        setFailed(false);
        setErrorMsg("");
        // Keep the selection stable across refreshes; honor a pending select
        // (from a just-created service) and fall back to the first item.
        setSelKey((prev) => {
          if (selectAfterLoad.current && d.items.some((s) => svcKey(s) === selectAfterLoad.current)) {
            return selectAfterLoad.current;
          }
          return prev && d.items.some((s) => svcKey(s) === prev) ? prev : d.items[0] ? svcKey(d.items[0]) : null;
        });
        selectAfterLoad.current = null;
      })
      .catch((err: Error) => {
        setLoading(false);
        setFailed(true);
        setErrorMsg(err.message);
      });
  }, []);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, 30_000);
    const onVis = () => {
      if (document.hidden) {
        if (timer) clearInterval(timer);
        timer = null;
      } else if (!timer) {
        // The tab became visible again: refresh immediately and resume the 30s
        // cycle so the poll doesn't stop permanently after a hidden period.
        load();
        timer = setInterval(load, 30_000);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reloadKey, load]);

  const selected = items.find((s) => svcKey(s) === selKey) ?? null;

  const visible = items.filter((s) => {
    if (filter === "ready") return s.ready === true;
    if (filter === "scaling") return s.ready !== true;
    return true;
  });

  const handleApply = useCallback(
    (decode: number, prefill: number, group: number) => {
      if (!selected) return;
      setScaleMsg(null);
      setScaleErr(null);
      setScaleBusy(true);
      fetch("/api/inferenceservices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: selected.namespace, name: selected.name, overrides: { decodeReplicas: decode, prefillReplicas: prefill, groupSize: group } }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setScaleMsg(t("inf.scale.applied"));
          load();
        })
        .catch((err: Error) => setScaleErr(err.message))
        .finally(() => setScaleBusy(false));
    },
    [selected, load, t],
  );

  return (
    <>
    <Box sx={{ p: "26px 28px 64px", maxWidth: 1320, width: "100%", mx: "auto" }}>
      <Box
        data-od-id="page-head"
        sx={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "20px", mb: "22px" }}
      >
        <Box>
          <Typography sx={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", color: "text.primary" }}>
            {t("nav.inference")}
          </Typography>
          <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>{t("inf.sub")}</Typography>
        </Box>
        <Box sx={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Button
            variant="contained"
            disableElevation
            data-od-id="deploy-btn"
            onClick={() => setDeployOpen(true)}
            sx={{ textTransform: "none", fontSize: 13, fontWeight: 550 }}
          >
            {t("inf.deploy.button")}
          </Button>
        </Box>
      </Box>

      {failed ? (
        <Box
          data-od-id="infsvc-error"
          sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", p: "32px 20px", textAlign: "center" }}
        >
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{t("inf.loadError", { error: errorMsg })}</Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              setLoading(true);
              setFailed(false);
              setReloadKey((k) => k + 1);
            }}
            sx={{ mt: "12px", textTransform: "none", fontSize: 12.5 }}
          >
            {t("inf.retry")}
          </Button>
        </Box>
      ) : loading ? (
        <Box data-od-id="infsvc-loading" sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
          {t("inf.loading")}
        </Box>
      ) : (
        <>
          <Box
            data-od-id="svc-toolbar"
            sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", mb: "12px" }}
          >
            <Box
              role="tablist"
              aria-label={t("inf.filter.label")}
              sx={{
                display: "inline-flex",
                border: 1,
                borderColor: "divider",
                borderRadius: "var(--radius)",
                p: "2px",
                gap: "2px",
                bgcolor: "background.paper",
              }}
            >
              {(
                [
                  ["all", t("inf.filter.all")],
                  ["ready", t("inf.filter.ready")],
                  ["scaling", t("inf.filter.scaling")],
                ] as Array<[Filter, string]>
              ).map(([key, label]) => {
                const on = filter === key;
                return (
                  <Box
                    key={key}
                    component="button"
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setFilter(key)}
                    sx={{
                      border: 0,
                      appearance: "none",
                      WebkitAppearance: "none",
                      backgroundImage: "none",
                      background: "transparent",
                      color: on ? "var(--bg)" : "var(--muted)",
                      bgcolor: on ? "var(--fg)" : "transparent",
                      fontWeight: on ? 550 : 500,
                      px: "13px",
                      py: "5px",
                      borderRadius: "6px",
                      fontSize: 12.5,
                      lineHeight: 1.4,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      transition: "background-color .15s ease, color .15s ease",
                      "&:hover": {
                        color: on ? "var(--bg)" : "var(--fg)",
                        bgcolor: on ? "var(--fg)" : "var(--surface)",
                      },
                    }}
                  >
                    {label}
                  </Box>
                );
              })}
            </Box>
            <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
              {t("inf.list.meta", { shown: String(visible.length), total: String(items.length) })}
            </Typography>
          </Box>

          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0,1fr) 348px" }, gap: "14px", alignItems: "start" }}>
            <ServiceTable items={visible} selectedKey={selected ? svcKey(selected) : null} onSelect={setSelKey} />
            {items.length === 0 ? (
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
                {t("inf.empty")}
              </Box>
            ) : selected ? (
              <DetailPanel
                s={selected}
                busy={scaleBusy}
                msg={scaleMsg}
                err={scaleErr}
                onApply={handleApply}
              />
            ) : (
              <Box sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>{t("inf.filter.none")}</Box>
            )}
          </Box>
        </>
      )}
    </Box>

    <DeployWizard
      key={deployOpen ? "open" : "closed"}
      open={deployOpen}
      onClose={() => setDeployOpen(false)}
      onCreated={(namespace, name) => {
        selectAfterLoad.current = `${namespace}/${name}`;
        setDeployOpen(false);
        load();
      }}
    />
    </>
  );
}

// ── service table ─────────────────────────────────────────────────────────

function ServiceTable({
  items,
  selectedKey,
  onSelect,
}: {
  items: InferenceServiceSummary[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const thSx = {
    textAlign: "left" as const,
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--muted)",
    fontWeight: 500,
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap" as const,
  };
  return (
    <Box data-od-id="svc-table" sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: "18px", py: "13px", borderBottom: 1, borderColor: "divider" }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t("inf.list.title")}</Typography>
        <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
          {t("inf.list.meta", { shown: String(items.length), total: String(items.length) })}
        </Typography>
      </Box>
      <Box sx={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 840 }}>
          <thead>
            <tr>
              <th style={{ ...thSx, width: "26%" }}>{t("inf.col.service")}</th>
              <th style={thSx}>{t("inf.col.status")}</th>
              <th style={thSx}>{t("inf.col.engine")}</th>
              <th style={thSx}>{t("inf.col.gpu")}</th>
              <th style={thSx}>{t("inf.col.replicas")}</th>
              <th style={thSx}>{t("inf.col.qps")}</th>
              <th style={thSx}>{t("inf.col.p95")}</th>
              <th style={thSx}>{t("inf.col.model")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const sel = svcKey(s) === selectedKey;
              return (
                <tr
                  key={svcKey(s)}
                  data-od-id={`svc-row-${s.name}`}
                  tabIndex={0}
                  aria-selected={sel}
                  onClick={() => onSelect(svcKey(s))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(svcKey(s));
                    }
                  }}
                  style={{
                    cursor: "pointer",
                    background: sel ? "var(--accent-soft)" : "transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) (e.currentTarget as HTMLElement).style.background = "var(--surface)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = sel ? "var(--accent-soft)" : "transparent";
                  }}
                >
                  <td style={tdSx}>
                    <Box sx={{ fontWeight: 600, fontSize: 13.5 }}>{s.name}</Box>
                    <Box sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", mt: "2px" }}>{s.namespace}</Box>
                  </td>
                  <td style={tdSx}>
                    <StatusChip cls={serviceStatus(s)} label={t(`inf.status.${serviceStatus(s)}`)} />
                  </td>
                  <td style={tdSx}>{s.engine ?? "—"}</td>
                  <td style={{ ...tdSx, whiteSpace: "nowrap" }}>{gpuText(s)}</td>
                  <td style={tdSx}>
                    <ReplicaRows s={s} />
                  </td>
                  <td style={{ ...tdSx, fontFamily: "var(--font-mono)", fontSize: 12.5, whiteSpace: "nowrap" }}>
                    {s.metrics ? numFmt(s.metrics.qps) : "—"}
                  </td>
                  <td style={{ ...tdSx, fontFamily: "var(--font-mono)", fontSize: 12.5, whiteSpace: "nowrap" }}>
                    {s.metrics && s.metrics.p95 != null ? `${Math.round(s.metrics.p95)} ms` : "—"}
                  </td>
                  <td style={tdSx}>{s.modelRef}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...tdSx, textAlign: "center", borderBottom: 0 }}>
                  <Box sx={{ py: "20px", fontSize: 13, color: "text.secondary" }}>{t("inf.filter.none")}</Box>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Box>
    </Box>
  );
}

const tdSx = {
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
  verticalAlign: "middle",
  color: "var(--fg)",
};

// ── detail panel ──────────────────────────────────────────────────────────

function DetailPanel({
  s,
  busy,
  msg,
  err,
  onApply,
}: {
  s: InferenceServiceSummary;
  busy: boolean;
  msg: string | null;
  err: string | null;
  onApply: (decode: number, prefill: number, group: number) => void;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
      <EndpointsCard s={s} />
      <MetricsCard s={s} />
      <ScaleCard s={s} busy={busy} msg={msg} err={err} onApply={onApply} />
      <ParamsCard s={s} />
      <ConditionsCard s={s} />
    </Box>
  );
}

function Card({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: "18px", py: "13px", borderBottom: 1, borderColor: "divider" }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{title}</Typography>
        {meta ? <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>{meta}</Typography> : null}
      </Box>
      {children}
    </Box>
  );
}

function Kvs({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Box sx={{ px: "18px", py: "4px" }}>
      {rows.map(([k, v], i) => (
        <Box
          key={k}
          sx={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "14px",
            py: "7px",
            fontSize: 13,
            ...(i > 0 ? { borderTop: "1px dashed var(--border)" } : {}),
          }}
        >
          <Box component="span" sx={{ color: "text.secondary", flex: "none" }}>{k}</Box>
          <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "right", overflowWrap: "anywhere" }}>{v}</Box>
        </Box>
      ))}
    </Box>
  );
}

function EndpointsCard({ s }: { s: InferenceServiceSummary }) {
  const { t } = useI18n();
  const internal = s.internalEndpoint ?? "—";
  // The public endpoint is the observed value the operator reports (the gateway
  // host differs per cluster); fall back to "—" when it isn't published yet.
  const external = s.publicEndpoint ?? "—";
  return (
    <Card title={t("inf.endpoints.title")}>
      <Box sx={{ px: "18px", py: "14px" }}>
        <EndpointRow label={t("inf.endpoints.internal")} value={internal} />
        <EndpointRow label={t("inf.endpoints.public")} value={external} />
      </Box>
    </Card>
  );
}

function EndpointRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Box sx={{ mb: "12px" }}>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", px: "9px", py: "5px", overflow: "hidden" }}>
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{value}</Box>
        {value !== "—" ? (
          <Button
            disableRipple
            onClick={() => {
              navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            sx={{ p: 0, minWidth: 0, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--accent-strong)", textTransform: "none", "&:hover": { textDecoration: "underline" } }}
          >
            {copied ? "✓" : t("inf.endpoints.copy")}
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}

function MetricsCard({ s }: { s: InferenceServiceSummary }) {
  const { t } = useI18n();
  const m = s.metrics;
  if (!m) {
    return (
      <Card title={t("inf.metrics.title")} meta={t("inf.metrics.source")}>
        <Box data-od-id="metrics-empty" sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
          {t("inf.metrics.empty")}
        </Box>
      </Card>
    );
  }
  const spark = m.spark ?? [];
  const readyPods = s.roles.reduce((a, r) => a + r.ready, 0);
  const desiredPods = s.roles.reduce((a, r) => a + r.desired, 0);
  return (
    <Card title={t("inf.metrics.title")} meta={t("inf.metrics.window")}>
      <Box sx={{ px: "18px", pt: "10px", pb: "14px", borderBottom: 1, borderColor: "divider" }}>
        <Sparkline data={spark.length > 1 ? spark : [0, 0]} />
        <Box sx={{ display: "flex", justifyContent: "space-between", mt: "6px" }}>
          <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>{t("inf.metrics.qpsTrend")}</Typography>
          <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>{numFmt(m.qps)}</Typography>
        </Box>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <Metric label={t("inf.metrics.qps")} value={numFmt(m.qps)} />
        <Metric label={t("inf.metrics.p95")} value={m.p95 === null ? "—" : `${Math.round(m.p95)} ms`} />
        <Metric label={t("inf.metrics.tps")} value={m.tps === null ? "—" : `${Math.round(m.tps)} /s`} />
        <Metric label={t("inf.metrics.ready")} value={desiredPods === 0 ? "—" : `${readyPods} / ${desiredPods}`} />
      </Box>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ px: "18px", py: "12px", borderBottom: "1px solid var(--border)" }}>
      <Box sx={{ fontSize: 11, color: "text.secondary" }}>{label}</Box>
      <Box sx={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", mt: "3px", color: "text.primary" }}>{value}</Box>
    </Box>
  );
}

function ScaleCard({
  s,
  busy,
  msg,
  err,
  onApply,
}: {
  s: InferenceServiceSummary;
  busy: boolean;
  msg: string | null;
  err: string | null;
  onApply: (decode: number, prefill: number, group: number) => void;
}) {
  const { t } = useI18n();
  const [decode, setDecode] = useState(s.decode.current);
  const [prefill, setPrefill] = useState(s.prefill.current);
  const [group, setGroup] = useState(s.groupSize.current);

  // Re-sync local state when the selected service changes, or when its reported
  // values actually change (e.g. the controller applied a scale). Depends on the
  // service identity + the specific values read — NOT on the `s` object
  // reference or the `s.decode` object (whose identity changes on every poll
  // refresh) — so a 30s poll refresh (same values) must not clobber in-progress
  // edits. exhaustive-deps is suppressed because the correct deps here are the
  // primitive values, not the enclosing `s.*` objects.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    setDecode(s.decode.current);
    setPrefill(s.prefill.current);
    setGroup(s.groupSize.current);
  }, [s.namespace, s.name, s.decode.current, s.prefill.current, s.groupSize.current]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const decodeInvalid = decode < s.decode.min || decode > s.decode.max;
  const prefillInvalid = prefill < s.prefill.min || prefill > s.prefill.max;
  const groupInvalid = s.groupSize.enum ? !s.groupSize.enum.includes(group) : group < 1;
  const valid = !decodeInvalid && !prefillInvalid && !groupInvalid;
  const unchanged = decode === s.decode.current && prefill === s.prefill.current && group === s.groupSize.current;

  return (
    <Card title={t("inf.scale.title")} meta={t("inf.scale.hint", { decodeMax: String(s.decode.max), prefillMax: String(s.prefill.max) })}>
      <Box sx={{ px: "18px", py: "12px", display: "flex", alignItems: "flex-end", gap: "12px" }}>
        <Field label="decodeReplicas" error={decodeInvalid}>
          <NumberInput value={decode} min={s.decode.min} max={s.decode.max} onChange={setDecode} />
        </Field>
        <Field label="prefillReplicas" error={prefillInvalid}>
          <NumberInput value={prefill} min={s.prefill.min} max={s.prefill.max} onChange={setPrefill} />
        </Field>
        {s.groupSize.enum ? (
          <Field label="groupSize" error={false}>
            <Select value={group} size="small" onChange={(e) => setGroup(Number(e.target.value))} sx={{ width: "100%", fontSize: 13, fontFamily: "var(--font-mono)" }}>
              {s.groupSize.enum.map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="groupSize" error={groupInvalid}>
            <NumberInput value={group} min={1} onChange={setGroup} />
          </Field>
        )}
      </Box>
      {err ? (
        <Box sx={{ px: "18px", pb: "8px", fontSize: 11.5, color: soft(STATUS_ERR, 70) }}>{err}</Box>
      ) : null}
      {msg ? (
        <Box sx={{ px: "18px", pb: "8px", fontSize: 11.5, color: "text.secondary" }}>{msg}</Box>
      ) : null}
      <Box sx={{ px: "18px", pb: "14px" }}>
        <Button variant="contained" disabled={busy || !valid || unchanged} onClick={() => onApply(decode, prefill, group)} sx={{ textTransform: "none", fontSize: 12.5 }}>
          {busy ? t("inf.scale.applying") : t("inf.scale.apply")}
        </Button>
      </Box>
    </Card>
  );
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error: boolean }) {
  return (
    <Box sx={{ flex: 1 }}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 550, mb: "7px" }}>{label}</Typography>
      <Box sx={error ? { border: "1px solid var(--accent-strong)", borderRadius: "var(--radius)" } : {}}>{children}</Box>
    </Box>
  );
}

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max?: number; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        width: "100%",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "8px 10px",
        font: "inherit",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        background: "var(--bg)",
        color: "var(--fg)",
        outline: "none",
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
      }}
    />
  );
}

function ParamsCard({ s }: { s: InferenceServiceSummary }) {
  const { t } = useI18n();
  const timeout = s.timeoutSeconds === null ? "—" : `${s.timeoutSeconds}s`;
  const maxLen = s.overrideNums.maxModelLen !== undefined ? String(s.overrideNums.maxModelLen) : "—";
  return (
    <Card title={t("inf.params.title")} meta={s.engine ?? "—"}>
      <Kvs
        rows={[
          [t("inf.params.engine"), s.engine ? `${s.engine} · ${s.engineVersion ?? ""}`.trim() : "—"],
          [t("inf.params.accelerator"), s.vendor ? `${s.vendor}${s.gpuModel ? ` / ${s.gpuModel}` : ""}` : "—"],
          [t("inf.params.gpuPerPod"), gpuText(s)],
          ["modelRef", s.modelRef],
          ["profileRef", s.profileRef],
          [t("inf.params.route"), s.published ? `${t("inf.params.published")} ${s.routeModelName ?? ""}`.trim() : t("inf.params.unpublished")],
          [t("inf.params.timeout"), timeout],
          [t("inf.params.maxModelLen"), maxLen],
        ]}
      />
    </Card>
  );
}

function ConditionsCard({ s }: { s: InferenceServiceSummary }) {
  const { t } = useI18n();
  const dot = (status: string) =>
    status === "True"
      ? { bgcolor: STATUS_OK }
      : status === "False"
        ? { bgcolor: STATUS_ERR, boxShadow: `0 0 0 4px ${soft(STATUS_ERR)}` }
        : { bgcolor: "transparent", border: "1.5px solid var(--muted)", width: 5, height: 5 };
  return (
    <Card title={t("inf.conds.title")} meta={t("inf.conds.meta")}>
      {s.conditions.length === 0 ? (
        <Box sx={{ px: "18px", py: "14px", fontSize: 12.5, color: "text.secondary" }}>{t("inf.conds.empty")}</Box>
      ) : (
        <Box sx={{ px: "18px", py: "8px" }}>
          {s.conditions.map((c) => (
            <Box key={c.type} data-od-id={`cond-${c.type}`} sx={{ display: "flex", alignItems: "center", gap: "9px", py: "6px", fontSize: 12.5 }}>
              <Box component="span" sx={{ width: 7, height: 7, borderRadius: "50%", flex: "none", ...dot(c.status) }} />
              <Box component="span" sx={{ fontWeight: 500, color: "text.primary" }}>{c.type}</Box>
              <Box component="span" sx={{ ml: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
                {c.status}
                {c.reason ? ` · ${c.reason}` : ""}
              </Box>
            </Box>
          ))}
          <Box sx={{ mt: "8px" }}>
            {s.conditions.filter((c) => c.message).map((c) => (
              <Typography key={c.type} sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6, mt: "4px" }}>
                {c.type}: {c.message}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
    </Card>
  );
}
// ── deploy wizard ──────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface DeployDraft {
  name: string;
  namespace: string;
  profileRef: string;
  modelRef: string;
  overrides: Record<string, number | string | boolean>;
  publish: boolean;
  modelName: string;
  timeout: string; // keep as string until parse for a friendlier error path
}

type OverrideDecl = CreateOptionsResponse["profiles"][number]["overrides"][number];

function DeployWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (namespace: string, name: string) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [options, setOptions] = useState<CreateOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DeployDraft>({
    name: "",
    namespace: "",
    profileRef: "",
    modelRef: "",
    overrides: {},
    publish: false,
    modelName: "",
    timeout: "60",
  });
  const [nameError, setNameError] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load the create options when the dialog opens. The wizard is remounted via
  // a changing `key` on each open, so its state starts blank here; this effect
  // only fetches the catalog and applies the namespace/profile defaults.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/inferenceservices/options")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: CreateOptionsResponse) => {
        if (cancelled) return;
        setOptions(d);
        setLoadError(null);
        setDraft((prev) => ({
          ...prev,
          namespace: d.namespaces.find((n) => n.name === "project-a")?.name || d.namespaces[0]?.name || "",
          profileRef: d.profiles[0]?.name || "",
          modelRef: "",
        }));
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const profile = options?.profiles.find((p) => p.name === draft.profileRef) ?? null;
  // Model versions compatible with the selected profile (architecture + quant).
  const compatibleModels = (options?.modelversions ?? []).filter((mv) => {
    if (!profile) return true;
    const archOk = !profile.architectures.length || (mv.architecture && profile.architectures.includes(mv.architecture));
    const quantOk = !profile.quantizations.length || (mv.quantization && profile.quantizations.includes(mv.quantization));
    return archOk && quantOk;
  });

  const setField = <K extends keyof DeployDraft>(key: K, value: DeployDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const nameValid = DNS_LABEL_RE.test(draft.name.trim());
  const step1Valid = nameValid && draft.name.trim().length > 0 && !!draft.namespace && !!draft.profileRef;
  const step2Valid = !!draft.modelRef;

  // Default override value, or the declared default.
  const overrideValue = (o: OverrideDecl): number | string | boolean => {
    const held = draft.overrides[o.name];
    if (held !== undefined) return held;
    if (o.default !== null && o.default !== undefined) return o.default;
    if (o.type === "boolean") return true;
    if (o.type === "integer") return o.min ?? 1;
    return "";
  };

  const next = () => {
    if (step === 1) {
      if (!step1Valid) {
        setNameError(!nameValid);
        return;
      }
      setNameError(false);
    } else if (step === 2 && !step2Valid) {
      return; // model is required to proceed
    }
    setStep((s) => Math.min(3, s + 1));
  };

  const create = () => {
    setCreateBusy(true);
    setCreateError(null);
    const timeout = parseInt(draft.timeout, 10);
    const body = {
      namespace: draft.namespace,
      name: draft.name.trim(),
      profileRef: draft.profileRef,
      modelRef: draft.modelRef,
      overrides: draft.overrides,
      route: { publish: draft.publish, modelName: draft.modelName.trim(), timeoutSeconds: Number.isFinite(timeout) ? timeout : 60 },
    };
    fetch("/api/inferenceservices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { error?: string; name?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        onCreated(draft.namespace, data.name ?? draft.name.trim());
      })
      .catch((err: Error) => setCreateError(err.message))
      .finally(() => setCreateBusy(false));
  };

  const stepTitles = [
    t("inf.deploy.step.basic"),
    t("inf.deploy.step.engine"),
    t("inf.deploy.step.confirm"),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      data-od-id="deploy-wizard"
      sx={{ "& .MuiDialog-paper": { maxHeight: "88vh" } }}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("inf.deploy.title")}</DialogTitle>
      {/* steps */}
      <Box sx={{ px: "24px", pb: "12px" }}>
        <Stepper activeStep={step - 1} sx={{ py: "8px" }}>
          {stepTitles.map((label) => (
            <Step key={label}>
              <StepLabel sx={{ "& .MuiStepLabel-label": { fontSize: 12.5 } }}>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
      </Box>

      <DialogContent dividers sx={{ overflowY: "auto" }}>
        {loadError ? (
          <Typography sx={{ fontSize: 13, color: "text.secondary" }} data-od-id="deploy-options-error">
            {t("inf.deploy.loadError", { error: loadError })}
          </Typography>
        ) : !options ? (
          <Box sx={{ p: "40px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }} data-od-id="deploy-loading">
            {t("inf.deploy.loading")}
          </Box>
        ) : (
          <>
            {step === 1 && (
              <Box data-step="1">
                <WizField label={t("inf.deploy.name")} hint={t("inf.deploy.nameHint")} error={nameError} errorText={t("inf.deploy.errName")}>
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    value={draft.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="e.g. dsv4-flash-serve"
                  />
                </WizField>
                <WizField label={t("inf.deploy.namespace")}>
                  <Select size="small" fullWidth value={draft.namespace} onChange={(e) => setField("namespace", e.target.value)}>
                    {(options?.namespaces ?? []).map((n) => (
                      <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
                    ))}
                  </Select>
                </WizField>
                <WizField label={t("inf.deploy.profile")} hint={profile ? profileSummary(profile) : undefined}>
                  <Select size="small" fullWidth value={draft.profileRef} onChange={(e) => setDraft((prev) => ({ ...prev, profileRef: e.target.value, modelRef: "", overrides: {} }))}>
                    {(options?.profiles ?? []).map((p) => (
                      <MenuItem key={p.name} value={p.name}>{p.name}</MenuItem>
                    ))}
                  </Select>
                </WizField>
              </Box>
            )}

            {step === 2 && (
              <Box data-step="2">
                <WizField label={t("inf.deploy.model")} hint={t("inf.deploy.modelHint")}>
                  <Select
                    size="small"
                    fullWidth
                    value={draft.modelRef}
                    onChange={(e) => {
                      setField("modelRef", e.target.value);
                    }}
                    displayEmpty
                    renderValue={(v) => (v ? v : t("inf.deploy.selectModel"))}
                  >
                    {compatibleModels.length === 0 ? (
                      <MenuItem disabled value="">{t("inf.deploy.noCompatible")}</MenuItem>
                    ) : (
                      compatibleModels.map((m) => (
                        <MenuItem key={m.name} value={m.name}>{m.name}</MenuItem>
                      ))
                    )}
                  </Select>
                </WizField>

                {profile && profile.overrides.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: "8px", color: "text.secondary" }}>
                      {t("inf.deploy.overrides")}
                    </Typography>
                    <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      {profile.overrides.map((o) => (
                        <OverrideInput
                          key={o.name}
                          decl={o}
                          value={overrideValue(o)}
                          onChange={(v) => setDraft((prev) => ({ ...prev, overrides: { ...prev.overrides, [o.name]: v } }))}
                        />
                      ))}
                    </Box>
                  </Box>
                )}

                <Box sx={{ mt: 3, border: 1, borderColor: "divider", borderRadius: "var(--radius)", p: "14px" }}>
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{t("inf.deploy.route")}</Typography>
                    <Switch checked={draft.publish} onChange={(e) => setField("publish", e.target.checked)} />
                  </Box>
                  {draft.publish && (
                    <Box sx={{ mt: "12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <WizField label={t("inf.deploy.modelName")} hint={t("inf.deploy.modelNameHint")}>
                        <TextField size="small" fullWidth value={draft.modelName} onChange={(e) => setField("modelName", e.target.value)} />
                      </WizField>
                      <WizField label={t("inf.deploy.timeout")} hint="1–86400 s">
                        <TextField size="small" fullWidth type="number" value={draft.timeout} onChange={(e) => setField("timeout", e.target.value)} />
                      </WizField>
                    </Box>
                  )}
                </Box>
              </Box>
            )}

            {step === 3 && (
              <Box data-step="3">
                <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: "10px" }}>{t("inf.deploy.summary")}</Typography>
                <Kvs
                  rows={[
                    [t("inf.deploy.name"), draft.name.trim()],
                    [t("inf.deploy.namespace"), draft.namespace],
                    ["profileRef", draft.profileRef],
                    ["modelRef", draft.modelRef],
                    ...(profile
                      ? profile.overrides.map((o) => [`${t("inf.deploy.override")} ${o.name}`, String(overrideValue(o))] as [string, string])
                      : []),
                    [t("inf.deploy.route"), draft.publish ? `${t("inf.params.published")} ${draft.modelName}` : t("inf.params.unpublished")],
                  ]}
                />
                {createError ? (
                  <Typography sx={{ fontSize: 12.5, color: soft(STATUS_ERR, 70), mt: "12px" }} data-od-id="deploy-error">
                    {createError}
                  </Typography>
                ) : null}
              </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: "24px", py: "14px", justifyContent: "space-between" }}>
        <Button sx={{ textTransform: "none", fontSize: 12.5 }} onClick={onClose} disabled={createBusy}>
          {t("inf.deploy.cancel")}
        </Button>
        <Box sx={{ display: "flex", gap: "10px" }}>
          {step > 1 ? (
            <Button variant="outlined" sx={{ textTransform: "none", fontSize: 12.5 }} disabled={createBusy} onClick={() => setStep((s) => s - 1)}>
              {t("inf.deploy.prev")}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button variant="contained" disableElevation sx={{ textTransform: "none", fontSize: 12.5 }} onClick={next}>
              {t("inf.deploy.next")}
            </Button>
          ) : (
            <Button
              variant="contained"
              disableElevation
              data-od-id="wizard-create"
              disabled={createBusy}
              onClick={create}
              sx={{ textTransform: "none", fontSize: 12.5 }}
            >
              {createBusy ? t("inf.deploy.creating") : t("inf.deploy.create")}
            </Button>
          )}
        </Box>
      </DialogActions>
    </Dialog>
  );
}

function profileSummary(p: CreateOptionsResponse["profiles"][number]): string {
  const acc = [p.vendor, p.models.join("/")].filter(Boolean).join(" · ");
  const gpu = p.gpuPerPod ? ` · ${p.gpuPerPod}/pod` : "";
  return `${p.engine ?? ""} ${p.engineVersion ?? ""} · ${acc}${gpu}`;
}

function WizField({
  label,
  hint,
  children,
  error,
  errorText,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  error?: boolean;
  errorText?: string;
}) {
  return (
    <Box sx={{ mb: "16px" }}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 550, mb: "7px" }}>{label}</Typography>
      {children}
      {error && errorText ? (
        <Typography data-od-id="field-error" sx={{ fontSize: 11.5, color: soft(STATUS_ERR, 75), fontWeight: 550, mt: "6px" }}>
          {errorText}
        </Typography>
      ) : hint ? (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: "6px" }}>{hint}</Typography>
      ) : null}
    </Box>
  );
}

function OverrideInput({
  decl,
  value,
  onChange,
}: {
  decl: OverrideDecl;
  value: number | string | boolean;
  onChange: (v: number | string | boolean) => void;
}) {
  if (decl.type === "boolean") {
    return (
      <WizField label={decl.name} hint={decl.description ?? undefined}>
        <Switch checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      </WizField>
    );
  }
  const label = `${decl.name}${decl.min !== null && decl.max !== null ? ` (${decl.min}–${decl.max})` : ""}`;
  if (decl.enum && decl.enum.length > 0) {
    return (
      <WizField label={label} hint={decl.description ?? undefined}>
        <Select size="small" fullWidth value={value} onChange={(e) => onChange(e.target.value as number | string)}>
          {decl.enum.map((v) => (
            <MenuItem key={String(v)} value={v}>{String(v)}</MenuItem>
          ))}
        </Select>
      </WizField>
    );
  }
  return (
    <WizField label={label} hint={decl.description ?? undefined}>
      <TextField
        size="small"
        fullWidth
        type={decl.type === "integer" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(decl.type === "integer" ? Number(e.target.value) : e.target.value)}
      />
    </WizField>
  );
}
