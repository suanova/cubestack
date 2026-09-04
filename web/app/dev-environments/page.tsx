"use client";

// 开发环境 (Dev Environments) — rebuilt from the static prototype
// (web/public/devenv.html) against the live cluster. Every value comes from
// /api/devenvironments, which reads the operator's DevEnvironment CRs
// directly; the prototype is only the visual reference, never a data source.
// The CRD carries compute inline (gpuType/gpuCount/cpu/memory) — there is no
// ComputeProfile CR and no auto-stop schedule, so the wizard collects only the
// fields the operator actually understands (spec.type / image / resources /
// storage.size / lifecycle.idleTimeout). Start/stop toggles spec.running via a
// PATCH; delete removes the CR.

import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stepper,
  Step,
  StepLabel,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DevEnvironmentSummary } from "@/app/api/devenvironments/route";
import type { DevEnvOptionsResponse } from "@/app/api/devenvironments/options/route";
import { useI18n } from "@/lib/i18n";

type Filter = "all" | "Running" | "Stopped";

// Status hues matching the semantic tokens the prototype derives in its CSS.
const STATUS_OK = "#27c37b";
const STATUS_WARN = "#e0a13a";
const STATUS_ERR = "#e15c5c";
const violet = "#8b5cf6";
const cyan = "#00b3a4";

const soft = (hex: string, pct = 13) => `color-mix(in oklch, ${hex} ${pct}%, transparent)`;

const TYPE_LABEL: Record<DevEnvironmentSummary["type"], "dev.type.jupyter" | "dev.type.ssh" | "dev.type.vscode"> = {
  jupyter: "dev.type.jupyter",
  ssh: "dev.type.ssh",
  vscode: "dev.type.vscode",
};

const typeColor: Record<DevEnvironmentSummary["type"], string> = {
  jupyter: violet,
  ssh: cyan,
  vscode: "#1677ff",
};

function TypeBadge({ type }: { type: DevEnvironmentSummary["type"] }) {
  const { t } = useI18n();
  const c = typeColor[type];
  return (
    <Box
      component="span"
      sx={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.06em",
        border: 1,
        borderColor: soft(c, 32),
        borderRadius: "4px",
        padding: "1px 6px",
        color: `color-mix(in oklch, ${c} 66%, var(--fg))`,
        bgcolor: soft(c, 9),
        fontWeight: 550,
        flex: "none",
      }}
    >
      {t(TYPE_LABEL[type])}
    </Box>
  );
}

function statusInfo(phase: string | null): { dot: string; bg: string } {
  if (phase === "Running") return { dot: STATUS_OK, bg: soft(STATUS_OK) };
  if (phase === "Stopped") return { dot: "var(--muted)", bg: soft("var(--muted)") };
  if (phase === "Failed") return { dot: STATUS_ERR, bg: soft(STATUS_ERR) };
  return { dot: STATUS_WARN, bg: soft(STATUS_WARN) };
}

function StatusChip({ phase }: { phase: string | null }) {
  const { t } = useI18n();
  const c = statusInfo(phase);
  const label =
    phase === "Running" || phase === "Stopped" || phase === "Pending" || phase === "Terminating" || phase === "Failed"
      ? t(`dev.phase.${phase as "Running"}`)
      : phase ?? "—";
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: "6px", px: "9px", py: "2px", borderRadius: 999, fontSize: 12, bgcolor: c.bg, whiteSpace: "nowrap" }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          bgcolor: c.dot,
          flex: "none",
          ...(phase === "Pending" || phase === "Terminating" ? { animation: "pend-pulse 1.6s ease-in-out infinite" } : {}),
          "@keyframes pend-pulse": { "50%": { opacity: 0.35 } },
        }}
      />
      {label}
    </Box>
  );
}

const envKey = (e: { namespace: string; name: string }) => `${e.namespace}/${e.name}`;

function fmtAge(createdAt: string | null): string {
  if (!createdAt) return "—";
  const diff = Date.now() - new Date(createdAt).getTime();
  if (diff < 0 || Number.isNaN(diff)) return createdAt;
  const hours = Math.floor(diff / 3600_000);
  if (hours < 1) return `<1h`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function DevEnvironmentsPage() {
  const { t } = useI18n();

  const [items, setItems] = useState<DevEnvironmentSummary[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);

  // After a successful create, select the just-created env on next reload.
  const selectAfterLoad = useRef<string | null>(null);
  // Monotonic generation counter for load(): if a newer request started while
  // an older one was in flight, only the newest may commit its result to state,
  // so a slow poll response cannot overwrite the fresher list / selection.
  const loadGen = useRef(0);

  const load = useCallback(() => {
    const gen = ++loadGen.current;
    fetch("/api/devenvironments")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: { items: DevEnvironmentSummary[] }) => {
        if (gen !== loadGen.current) return; // a newer load started; ignore this one
        setItems(d.items);
        setLoading(false);
        setFailed(false);
        setErrorMsg("");
        setSelKey((prev) => {
          if (selectAfterLoad.current && d.items.some((s) => envKey(s) === selectAfterLoad.current)) {
            return selectAfterLoad.current;
          }
          return prev && d.items.some((s) => envKey(s) === prev) ? prev : d.items[0] ? envKey(d.items[0]) : null;
        });
        selectAfterLoad.current = null;
      })
      .catch((err: Error) => {
        if (gen !== loadGen.current) return; // a newer load started; ignore this one
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

  const selected = items.find((e) => envKey(e) === selKey) ?? null;

  const visible = items.filter((e) => {
    if (filter === "Running") return e.phase === "Running";
    if (filter === "Stopped") return e.phase === "Stopped";
    return true;
  });

  const runAction = (e: DevEnvironmentSummary, act: string) => {
    if (act === "stop") {
      patch({ namespace: e.namespace, name: e.name, running: false });
    } else if (act === "start") {
      patch({ namespace: e.namespace, name: e.name, running: true });
    } else if (act === "del") {
      if (!window.confirm(t("dev.delete.confirm", { name: e.name }))) return;
      fetch("/api/devenvironments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: e.namespace, name: e.name }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          load();
        })
        .catch((err: Error) => window.alert(err.message));
    }
  };

  const patch = useCallback(
    ({ namespace, name, running }: { namespace: string; name: string; running: boolean }) => {
      fetch("/api/devenvironments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name, running }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          load();
        })
        .catch((err: Error) => window.alert(err.message));
    },
    [load],
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
              {t("nav.devenv")}
            </Typography>
            <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>{t("dev.sub")}</Typography>
          </Box>
          <Box sx={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <Button
              variant="contained"
              disableElevation
              data-od-id="create-env-btn"
              onClick={() => setWizardOpen(true)}
              sx={{ textTransform: "none", fontSize: 13, fontWeight: 550 }}
            >
              {t("dev.create.button")}
            </Button>
          </Box>
        </Box>

        {failed ? (
          <Box
            data-od-id="dev-error"
            sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", p: "32px 20px", textAlign: "center" }}
          >
            <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{t("dev.loadError", { error: errorMsg })}</Typography>
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
              {t("dev.retry")}
            </Button>
          </Box>
        ) : loading ? (
          <Box data-od-id="dev-loading" sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
            {t("dev.loading")}
          </Box>
        ) : (
          <>
            <Box
              data-od-id="dev-toolbar"
              sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", mb: "12px" }}
            >
              <Box
                role="tablist"
                aria-label={t("dev.filter.label")}
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
                    ["all", t("dev.filter.all")],
                    ["Running", t("dev.filter.running")],
                    ["Stopped", t("dev.filter.stopped")],
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
                        "&:hover": { color: on ? "var(--bg)" : "var(--fg)", bgcolor: on ? "var(--fg)" : "var(--surface)" },
                      }}
                    >
                      {label}
                    </Box>
                  );
                })}
              </Box>
              <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
                {t("dev.list.meta", { shown: String(visible.length), total: String(items.length) })}
              </Typography>
            </Box>

            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0,1fr) 348px" }, gap: "14px", alignItems: "start" }}>
              <EnvTable items={visible} selectedKey={selected ? envKey(selected) : null} onSelect={setSelKey} onAct={runAction} />
              {items.length === 0 ? (
                <Box sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
                  {t("dev.empty")}
                </Box>
              ) : selected ? (
                <DetailPanel e={selected} onAct={runAction} />
              ) : (
                <Box sx={{ p: "48px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>{t("dev.filter.none")}</Box>
              )}
            </Box>
          </>
        )}
      </Box>

      <CreateWizard
        key={wizardOpen ? "open" : "closed"}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(namespace, name) => {
          selectAfterLoad.current = `${namespace}/${name}`;
          setWizardOpen(false);
          load();
        }}
      />
    </>
  );
}

// ── environment table ────────────────────────────────────────────────────────

function EnvTable({
  items,
  selectedKey,
  onSelect,
  onAct,
}: {
  items: DevEnvironmentSummary[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onAct: (e: DevEnvironmentSummary, act: string) => void;
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
    <Box data-od-id="dev-table" sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper", overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: "18px", py: "13px", borderBottom: 1, borderColor: "divider" }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t("dev.list.title")}</Typography>
        <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
          {t("dev.list.meta", { shown: String(items.length), total: String(items.length) })}
        </Typography>
      </Box>
      <Box sx={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 840 }}>
          <thead>
            <tr>
              <th style={{ ...thSx, width: "24%" }}>{t("dev.col.env")}</th>
              <th style={thSx}>{t("dev.col.image")}</th>
              <th style={thSx}>{t("dev.col.resources")}</th>
              <th style={thSx}>{t("dev.col.gpu")}</th>
              <th style={thSx}>{t("dev.col.status")}</th>
              <th style={thSx}>{t("dev.col.node")}</th>
              <th style={{ ...thSx, textAlign: "right" }}>{t("dev.col.ops")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => {
              const sel = envKey(e) === selectedKey;
              return (
                <tr
                  key={envKey(e)}
                  data-od-id={`dev-row-${e.name}`}
                  tabIndex={0}
                  aria-selected={sel}
                  onClick={() => onSelect(envKey(e))}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      onSelect(envKey(e));
                    }
                  }}
                  style={{ cursor: "pointer", background: sel ? "var(--accent-soft)" : "transparent" }}
                  onMouseEnter={(ev) => {
                    if (!sel) (ev.currentTarget as HTMLElement).style.background = "var(--surface)";
                  }}
                  onMouseLeave={(ev) => {
                    (ev.currentTarget as HTMLElement).style.background = sel ? "var(--accent-soft)" : "transparent";
                  }}
                >
                  <td style={tdSx}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: "9px", fontWeight: 600, fontSize: 13.5 }}>
                      {e.name}
                      <TypeBadge type={e.type} />
                    </Box>
                  </td>
                  <td style={tdSx}>
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "text.secondary" }}>{e.image}</Box>
                  </td>
                  <td style={tdSx}>
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {e.resources.gpuCount}×{e.resources.gpuType} · {e.resources.cpu}C / {e.resources.memory}
                    </Box>
                  </td>
                  <td style={tdSx}>
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "nowrap" }}>
                      {e.resources.gpuCount} × {e.resources.gpuType === "metax" ? "metax" : "GPU"}
                    </Box>
                  </td>
                  <td style={tdSx}>
                    <StatusChip phase={e.phase} />
                  </td>
                  <td style={tdSx}>
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>
                      {e.namespace} · {fmtAge(e.createdAt)}
                    </Box>
                  </td>
                  <td style={{ ...tdSx, textAlign: "right" }}>
                    <RowActions e={e} onAct={onAct} />
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...tdSx, textAlign: "center", borderBottom: 0 }}>
                  <Box sx={{ py: "20px", fontSize: 13, color: "text.secondary" }}>{t("dev.filter.none")}</Box>
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

function RowActions({ e, onAct }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void }) {
  const { t } = useI18n();
  const btn = {
    fontSize: 12,
    fontWeight: 550,
    px: "11px",
    py: "4px",
    border: 1,
    borderColor: "divider",
    borderRadius: "6px",
    bgcolor: "background.paper",
    color: "text.primary",
    textTransform: "none" as const,
    minWidth: 0,
    "&:hover": { borderColor: "text.primary" },
  };
  if (e.phase === "Running") {
    return (
      <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex", gap: "8px" }}>
        <Button size="small" data-od-id={`act-stop-${e.name}`} sx={btn} onClick={() => onAct(e, "stop")}>
          {t("dev.act.stop")}
        </Button>
      </Box>
    );
  }
  if (e.phase === "Stopped") {
    return (
      <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex", gap: "8px" }}>
        <Button size="small" data-od-id={`act-start-${e.name}`} sx={btn} onClick={() => onAct(e, "start")}>
          {t("dev.act.start")}
        </Button>
        <Button
          size="small"
          data-od-id={`act-del-${e.name}`}
          sx={{ ...btn, color: soft(STATUS_ERR, 70), "&:hover": { borderColor: soft(STATUS_ERR, 70), bgcolor: soft(STATUS_ERR, 10) } }}
          onClick={() => onAct(e, "del")}
        >
          {t("dev.act.delete")}
        </Button>
      </Box>
    );
  }
  return (
    <Box sx={{ display: "inline-flex" }}>
      <Box component="span" sx={{ fontSize: 12, opacity: 0.45, color: "text.secondary" }}>
        {t("dev.act.scheduling")}
      </Box>
    </Box>
  );
}

// ── detail panel ─────────────────────────────────────────────────────────────

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

function EndpointRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Box sx={{ mb: "12px" }}>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", px: "9px", py: "5px", overflow: "hidden" }}>
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{value}</Box>
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
          {copied ? t("dev.conn.copied") : t("dev.conn.copy")}
        </Button>
      </Box>
    </Box>
  );
}

function ConnectionCard({ e, onAct }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void }) {
  const { t } = useI18n();
  if (e.phase === "Running" && e.endpoints.length > 0) {
    return (
      <Card title={t("dev.conn.title")} meta={t("dev.conn.meta")}>
        <Box sx={{ px: "18px", py: "14px" }}>
          {e.endpoints.map((ep) => (
            <EndpointRow key={ep.name} label={ep.name} value={ep.address} />
          ))}
          <Typography sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.7 }}>{t("dev.conn.guide")}</Typography>
        </Box>
      </Card>
    );
  }
  return (
    <Card title={t("dev.conn.title")} meta={t("dev.conn.meta")}>
      <Box sx={{ px: "18px", py: "20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          {t("dev.conn.none", { phase: e.phase ?? "—" })}
        </Typography>
        {e.phase === "Stopped" ? (
          <Button
            size="small"
            variant="outlined"
            data-od-id="detail-start"
            onClick={() => onAct(e, "start")}
            sx={{ textTransform: "none", fontSize: 12.5, whiteSpace: "nowrap" }}
          >
            {t("dev.act.start")}
          </Button>
        ) : null}
      </Box>
    </Card>
  );
}

function SpecCard({ e }: { e: DevEnvironmentSummary }) {
  const { t } = useI18n();
  const rows: Array<[string, string]> = [
    [t("dev.spec.type"), e.type],
    [t("dev.spec.image"), e.image],
    [t("dev.spec.gpu"), `${e.resources.gpuCount} × ${e.resources.gpuType}`],
    [t("dev.spec.cpu"), `${e.resources.cpu}C / ${e.resources.memory}`],
    [t("dev.spec.storage"), e.storage ? `${e.storage.size} · ${e.storage.mountPath}` : t("dev.spec.idleOff")],
    [t("dev.spec.idle"), e.idleTimeout === 0 ? t("dev.spec.idleOff") : t("dev.spec.idleMin", { minutes: String(Math.round(e.idleTimeout / 60)) })],
    [t("dev.spec.sshKey"), e.sshKeysSecret ?? t("dev.spec.sshKeyNone")],
    [t("dev.spec.node"), e.namespace],
  ];
  return (
    <Card title={t("dev.spec.title")} meta={t("dev.spec.meta")}>
      <Kvs rows={rows} />
      <Box sx={{ display: "flex", gap: "8px", flexWrap: "wrap", px: "18px", py: "12px", borderTop: 1, borderColor: "divider" }}>
        {e.conditions.length === 0 ? (
          <Typography data-od-id="env-conds-empty" sx={{ fontSize: 12, color: "text.secondary" }}>{t("dev.cond.empty")}</Typography>
        ) : (
          e.conditions.map((c) => {
            // Green only for an observed True condition; False (a real failure
            // or an expected non-ready state like a stopped Ready) and Unknown
            // (pending) get distinct non-success styling.
            const cls = c.status === "True" ? "ok" : c.status === "Unknown" ? "pending" : "err";
            const [chip, dot] =
              cls === "ok"
                ? [STATUS_OK, STATUS_OK]
                : cls === "pending"
                  ? [STATUS_WARN, STATUS_WARN]
                  : [soft(STATUS_ERR, 55), STATUS_ERR];
            return (
              <Box
                key={c.type}
                data-od-id={`cond-${c.type}`}
                component="span"
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  px: "9px",
                  py: "2px",
                  borderRadius: 999,
                  fontSize: 12,
                  bgcolor: cls === "ok" ? soft(STATUS_OK) : soft(chip),
                  color: cls === "ok" ? "inherit" : `color-mix(in oklch, ${chip} 66%, var(--fg))`,
                  whiteSpace: "nowrap",
                }}
              >
                <Box
                  component="span"
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    bgcolor: dot,
                    flex: "none",
                  }}
                />
                {c.type}
              </Box>
            );
          })
        )}
      </Box>
    </Card>
  );
}

function DetailPanel({ e, onAct }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
      <ConnectionCard e={e} onAct={onAct} />
      <SpecCard e={e} />
    </Box>
  );
}

// ── create wizard ────────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface Draft {
  name: string;
  namespace: string;
  type: "jupyter" | "ssh" | "vscode";
  image: string;
  gpuType: "nvidia" | "metax";
  gpuCount: number;
  cpu: string;
  memory: string;
  storageGi: number;
  idle: number;
}

const CPU_OPTIONS = ["16", "32", "64"];
const MEM_OPTIONS = ["64Gi", "128Gi", "256Gi"];

function CreateWizard({
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
  const [options, setOptions] = useState<DevEnvOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    namespace: "",
    type: "jupyter",
    image: "",
    gpuType: "nvidia",
    gpuCount: 1,
    cpu: "16",
    memory: "64Gi",
    storageGi: 200,
    idle: 0,
  });
  const [nameError, setNameError] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/devenvironments/options")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: DevEnvOptionsResponse) => {
        if (cancelled) return;
        setOptions(d);
        setLoadError(null);
        setDraft((prev) => ({
          ...prev,
          namespace: d.namespaces[0]?.name ?? "",
          image: d.images[0]?.tag ?? "",
        }));
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const nameValid = DNS_LABEL_RE.test(draft.name.trim()) && draft.name.trim().length > 0;
  const step1Valid = nameValid && !!draft.namespace && !!draft.image;
  // Client-side validation mirrors the server (POST) rules so a user cannot
  // advance or submit out-of-range / fractional GPU or storage values.
  const gpuValid = Number.isInteger(draft.gpuCount) && draft.gpuCount >= 1 && draft.gpuCount <= 16;
  const storageValid = Number.isInteger(draft.storageGi) && draft.storageGi >= 20 && draft.storageGi <= 800;
  const step2Valid = gpuValid && storageValid;
  const [gpuError, setGpuError] = useState(false);
  const [storageError, setStorageError] = useState(false);

  const next = () => {
    if (step === 1) {
      if (!step1Valid) {
        setNameError(!nameValid);
        return;
      }
      setNameError(false);
    } else if (step === 2) {
      setGpuError(!gpuValid);
      setStorageError(!storageValid);
      if (!step2Valid) return;
    }
    setStep((s) => Math.min(3, s + 1));
  };

  const create = () => {
    // Defense in depth: never submit out-of-range / fractional GPU or storage
    // values even if the wizard state is manipulated directly.
    setGpuError(!gpuValid);
    setStorageError(!storageValid);
    if (!step2Valid) return;
    setCreateBusy(true);
    setCreateError(null);
    const body = {
      namespace: draft.namespace,
      name: draft.name.trim(),
      type: draft.type,
      image: draft.image,
      gpuType: draft.gpuType,
      gpuCount: draft.gpuCount,
      cpu: draft.cpu,
      memory: draft.memory,
      storageGi: draft.storageGi,
      idleTimeout: draft.idle,
    };
    fetch("/api/devenvironments", {
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

  const stepTitles = [t("dev.wizard.step.basic"), t("dev.wizard.step.resources"), t("dev.wizard.step.confirm")];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-od-id="create-wizard" sx={{ "& .MuiDialog-paper": { maxHeight: "88vh" } }}>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("dev.wizard.title")}</DialogTitle>
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
          <Typography sx={{ fontSize: 13, color: "text.secondary" }} data-od-id="create-options-error">
            {t("dev.wizard.loadError", { error: loadError })}
          </Typography>
        ) : !options ? (
          <Box data-od-id="create-loading" sx={{ p: "40px 20px", textAlign: "center", fontSize: 13, color: "text.secondary" }}>
            {t("dev.wizard.loading")}
          </Box>
        ) : (
          <>
            {step === 1 && (
              <Box data-step="1">
                <WizField label={t("dev.wizard.name")} hint={t("dev.wizard.nameHint")} error={nameError} errorText={t("dev.wizard.errName")}>
                  <TextField size="small" fullWidth autoFocus value={draft.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. jupyter-nlp-ln" />
                </WizField>
                <WizField label={t("dev.wizard.namespace")}>
                  <Select size="small" fullWidth value={draft.namespace} onChange={(e) => setField("namespace", e.target.value)}>
                    {options.namespaces.map((n) => (
                      <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
                    ))}
                  </Select>
                </WizField>
                <WizField label={t("dev.wizard.type")}>
                  <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
                    {(["jupyter", "ssh", "vscode"] as const).map((tp) => (
                      <Box
                        key={tp}
                        component="button"
                        type="button"
                        onClick={() => setField("type", tp)}
                        sx={{
                          border: 1,
                          borderColor: draft.type === tp ? "primary.main" : "divider",
                          borderRadius: "var(--radius)",
                          px: "13px",
                          py: "12px",
                          textAlign: "left",
                          cursor: "pointer",
                          background: draft.type === tp ? soft("#1677ff") : "transparent",
                          color: "text.primary",
                          fontFamily: "inherit",
                          "&:hover": { borderColor: "text.primary" },
                        }}
                      >
                        <Box sx={{ fontWeight: 600, fontSize: 13 }}>{t(`dev.wizard.type.${tp}`)}</Box>
                        <Box component="span" sx={{ fontSize: 11, color: "text.secondary", fontFamily: "var(--font-mono)", display: "block", mt: "4px" }}>
                          {t(`dev.wizard.type.${tp}Desc`)}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </WizField>
                <WizField label={t("dev.wizard.image")} hint={t("dev.wizard.imageHint")}>
                  <Select size="small" fullWidth value={draft.image} onChange={(e) => setField("image", e.target.value)} displayEmpty renderValue={(v) => (v ? v : t("dev.wizard.image"))}>
                    {options.images.map((img) => (
                      <MenuItem key={img.tag} value={img.tag}>{img.label}</MenuItem>
                    ))}
                  </Select>
                </WizField>
              </Box>
            )}

            {step === 2 && (
              <Box data-step="2">
                <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: "0 14px" }}>
                  <WizField label={t("dev.wizard.gpuType")}>
                    <Select size="small" fullWidth value={draft.gpuType} onChange={(e) => setField("gpuType", e.target.value as Draft["gpuType"])}>
                      <MenuItem value="nvidia">nvidia</MenuItem>
                      <MenuItem value="metax">metax</MenuItem>
                    </Select>
                  </WizField>
                  <WizField label={t("dev.wizard.gpuCount")} error={gpuError} errorText={t("dev.wizard.errGpu")}>
                    <TextField size="small" fullWidth type="number" inputProps={{ min: 1, max: 16 }} value={draft.gpuCount} onChange={(e) => setField("gpuCount", Number(e.target.value))} />
                  </WizField>
                  <WizField label={t("dev.wizard.cpu")}>
                    <Select size="small" fullWidth value={draft.cpu} onChange={(e) => setField("cpu", e.target.value)}>
                      {CPU_OPTIONS.map((c) => (
                        <MenuItem key={c} value={c}>{c}C</MenuItem>
                      ))}
                    </Select>
                  </WizField>
                  <WizField label={t("dev.wizard.memory")}>
                    <Select size="small" fullWidth value={draft.memory} onChange={(e) => setField("memory", e.target.value)}>
                      {MEM_OPTIONS.map((m) => (
                        <MenuItem key={m} value={m}>{m}</MenuItem>
                      ))}
                    </Select>
                  </WizField>
                  <WizField label={t("dev.wizard.storage")} hint={t("dev.wizard.storageHint")} error={storageError} errorText={t("dev.wizard.errStorage")}>
                    <TextField size="small" fullWidth type="number" inputProps={{ min: 20, max: 800 }} value={draft.storageGi} onChange={(e) => setField("storageGi", Number(e.target.value))} />
                  </WizField>
                  <WizField label={t("dev.wizard.idle")} hint={t("dev.wizard.idleHint")}>
                    <Select size="small" fullWidth value={draft.idle} onChange={(e) => setField("idle", Number(e.target.value))}>
                      <MenuItem value={0}>{t("dev.wizard.idle0")}</MenuItem>
                      <MenuItem value={1800}>30</MenuItem>
                      <MenuItem value={3600}>60</MenuItem>
                      <MenuItem value={14400}>240</MenuItem>
                    </Select>
                  </WizField>
                </Box>
              </Box>
            )}

            {step === 3 && (
              <Box data-step="3">
                <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: "10px" }}>{t("dev.wizard.summary")}</Typography>
                <Kvs
                  rows={[
                    [t("dev.wizard.name"), draft.name.trim()],
                    [t("dev.wizard.namespace"), draft.namespace],
                    [t("dev.wizard.type"), draft.type],
                    [t("dev.wizard.image"), draft.image],
                    [t("dev.wizard.gpuType"), draft.gpuType],
                    [t("dev.wizard.gpuCount"), String(draft.gpuCount)],
                    [t("dev.wizard.cpu"), `${draft.cpu}C`],
                    [t("dev.wizard.memory"), draft.memory],
                    [t("dev.wizard.storage"), `${draft.storageGi}Gi`],
                    [t("dev.wizard.idle"), draft.idle === 0 ? t("dev.spec.idleOff") : t("dev.spec.idleMin", { minutes: String(draft.idle / 60) })],
                  ]}
                />
                {createError ? (
                  <Typography sx={{ fontSize: 12.5, color: soft(STATUS_ERR, 70), mt: "12px" }} data-od-id="create-error">
                    {t("dev.createError", { error: createError })}
                  </Typography>
                ) : null}
              </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: "24px", py: "14px", justifyContent: "space-between" }}>
        <Button sx={{ textTransform: "none", fontSize: 12.5 }} onClick={onClose} disabled={createBusy}>
          {t("dev.wizard.cancel")}
        </Button>
        <Box sx={{ display: "flex", gap: "10px" }}>
          {step > 1 ? (
            <Button variant="outlined" sx={{ textTransform: "none", fontSize: 12.5 }} disabled={createBusy} onClick={() => setStep((s) => s - 1)}>
              {t("dev.wizard.prev")}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button variant="contained" disableElevation sx={{ textTransform: "none", fontSize: 12.5 }} onClick={next}>
              {t("dev.wizard.next")}
            </Button>
          ) : (
            <Button variant="contained" disableElevation data-od-id="wizard-create" disabled={!step2Valid || createBusy} onClick={create} sx={{ textTransform: "none", fontSize: 12.5 }}>
              {createBusy ? t("dev.wizard.creating") : t("dev.wizard.create")}
            </Button>
          )}
        </Box>
      </DialogActions>
    </Dialog>
  );
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