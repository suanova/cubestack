"use client";

// 开发环境 (Dev Environments) — every value comes from /api/devenvironments,
// which reads the operator's DevEnvironment CRs directly.
// The CRD carries compute inline (resources.gpu/cpu/memory) — there is no
// ComputeProfile CR and no auto-stop schedule, so the wizard collects only the
// fields the operator actually understands (spec.type / image / resources /
// storage.size / storage.mountPath / volumes / runtime / ports /
// lifecycle.idleTimeout). The one shape that needs care is the
// accelerator: spec.resources.gpu has no zero count, so "no GPU" is expressed
// by omitting the block, which is also what keeps a CPU image out of the
// controller's brand gate. Start/stop toggles spec.running via a PATCH; delete
// removes the CR.

import {
  Autocomplete,
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
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DevEnvironmentSummary } from "@/app/api/devenvironments/route";
import type { DevEnvImageOption, DevEnvOptionsResponse } from "@/app/api/devenvironments/options/route";
import { PLATFORM_GID, PLATFORM_UID, PLATFORM_USER } from "@/lib/devenvironments/images";
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

const PORT_TYPE_LABEL: Record<PortType, "dev.wizard.portType.http" | "dev.wizard.portType.tcp" | "dev.wizard.portType.udp"> = {
  http: "dev.wizard.portType.http",
  tcp: "dev.wizard.portType.tcp",
  udp: "dev.wizard.portType.udp",
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
      <Box sx={{ p: "26px 28px 64px", width: "100%", mx: "auto" }}>
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
              // The accelerator cell: "2 × nvidia", or the no-accelerator label
              // when the environment carries no spec.resources.gpu block.
              const gpu = e.resources.gpu;
              const gpuText = gpu
                ? `${gpu.count} × ${gpu.vendor === "metax" ? "metax" : "GPU"}`
                : t("dev.gpu.none");
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
                      {gpuText} · {t("dev.cpu.cores", { n: e.resources.cpu })} / {e.resources.memory}
                    </Box>
                  </td>
                  <td style={tdSx}>
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "nowrap" }}>
                      {gpuText}
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
  const gpu = e.resources.gpu;
  const rows: Array<[string, string]> = [
    [t("dev.spec.type"), e.type],
    [t("dev.spec.image"), e.image],
    [t("dev.spec.gpu"), gpu ? `${gpu.count} × ${gpu.vendor}` : t("dev.gpu.none")],
    [t("dev.spec.cpu"), `${t("dev.cpu.cores", { n: e.resources.cpu })} / ${e.resources.memory}`],
    [
      t("dev.spec.storage"),
      // A null mountPath is not "/workspace": the controller derives it from the
      // runtime identity, and for a jupyter image that is /home/jovyan.
      e.storage
        ? `${e.storage.size} · ${e.storage.mountPath ?? t("dev.spec.mountPathDerived")}`
        : t("dev.spec.idleOff"),
    ],
    [t("dev.spec.idle"), e.idleTimeout === 0 ? t("dev.spec.idleOff") : t("dev.spec.idleMin", { minutes: String(Math.round(e.idleTimeout / 60)) })],
    [t("dev.spec.sshKey"), e.sshClientKeySecret ?? t("dev.spec.sshKeyNone")],
    [t("dev.spec.node"), e.namespace],
  ];
  // Only what the environment actually states: four rows of "nothing configured"
  // on every environment would drown the ones that do configure something.
  if (e.volumes.length) {
    rows.push([
      t("dev.spec.volumes"),
      e.volumes
        .map((v) => `${v.pvcName} → ${v.mountPath}${v.readOnly ? ` (${t("dev.spec.readOnly")})` : ""}`)
        .join(" · "),
    ]);
  }
  if (e.envNames.length) rows.push([t("dev.spec.env"), e.envNames.join(" · ")]);
  if (e.args.length) rows.push([t("dev.spec.args"), e.args.join(" ")]);
  if (e.ports.length) rows.push([t("dev.spec.ports"), e.ports.map((p) => `${p.name}:${p.containerPort}/${p.type}`).join(" · ")]);
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
// spec.runtime.user's own validation, mirrored from the CRD's schema (Pattern
// ^[a-z_][a-z0-9_-]*$ with MaxLength 32) and from the create route, so the
// wizard cannot walk the user to a spec the API server would reject.
const RUNTIME_USER_RE = /^[a-z_][a-z0-9_-]*$/;
const RUNTIME_USER_MAX = 32;
const RUN_AS_ID_MAX = 2147483647;
// The create route's own rules, mirrored so the wizard cannot walk the user to a
// spec the server would refuse. corev1.EnvVar.name, and the CRD's port type enum.
const ENV_NAME_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const PORT_TYPES = ["http", "tcp", "udp"] as const;
type PortType = (typeof PORT_TYPES)[number];

// The repeatable rows of step 3. Each carries an id so a deletion addresses the
// row by identity rather than by an index captured when the row was rendered.
interface PvcRow {
  id: number;
  pvcName: string;
  mountPath: string;
}
interface EnvRow {
  id: number;
  name: string;
  value: string;
}
interface PortRow {
  id: number;
  name: string;
  // A string for the same reason uid and gid are: an empty box must not read as
  // port 0, which is not a valid port and not "unset" either.
  port: string;
  type: PortType;
}

interface Draft {
  name: string;
  namespace: string;
  type: "jupyter" | "ssh" | "vscode";
  image: string;
  accelerator: "none" | "nvidia" | "metax";
  gpuCount: number;
  cpu: string;
  memory: string;
  storageGi: number;
  idle: number;
  // The runtime identity. uid and gid are held as strings, not numbers: a
  // number field would turn an empty box into 0, and 0 is not a missing uid —
  // it is the request to run as root.
  runAsRoot: boolean;
  runtimeUser: string;
  runAsUser: string;
  runAsGroup: string;
  // step 3's storage / runtime / network sections: spec.storage.mountPath,
  // spec.volumes, spec.runtime.env / args and spec.ports. Held in the draft like
  // every other field so the summary, the validation and the request body read
  // one source of truth.
  //
  // An empty mountPath is "not stated": the controller derives the workspace
  // path — and the container's HOME — from the identity above, and pinning it
  // from the wizard would move a jupyter environment's home off /home/jovyan.
  mountPath: string;
  pvcs: PvcRow[];
  envs: EnvRow[];
  // One command line, as the prototype's single box takes it; split into
  // spec.runtime.args by the route.
  args: string;
  ports: PortRow[];
}

// CPU is picked in cores and memory follows it: the platform offers 1x, 2x or 4x
// the core count in GiB, so the two selects cannot be driven into a pairing the
// platform does not have (1 core / 1Gi, 2 cores / 8Gi, ...).
const CPU_OPTIONS = ["1", "2", "4", "8", "16"];
const MEM_TIER = [1, 2, 4];

function memoryOptions(cpu: string): string[] {
  return MEM_TIER.map((tier) => `${Number(cpu) * tier}Gi`);
}

/** The identity an image states, or the platform's own for one it does not publish. */
function identityOf(image: DevEnvImageOption | undefined) {
  return {
    runtimeUser: image?.user ?? PLATFORM_USER,
    runAsUser: String(PLATFORM_UID),
    runAsGroup: String(image?.runAsGroup ?? PLATFORM_GID),
  };
}

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
    // The image catalog opens on a CPU image, so the accelerator starts at
    // "none" rather than defaulting the environment into a brand-gate failure.
    accelerator: "none",
    gpuCount: 1,
    cpu: "2",
    memory: "4Gi",
    storageGi: 200,
    idle: 0,
    runAsRoot: false,
    runtimeUser: "",
    runAsUser: String(PLATFORM_UID),
    runAsGroup: String(PLATFORM_GID),
    mountPath: "",
    pvcs: [],
    envs: [],
    args: "",
    ports: [],
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
          ...identityOf(d.images[0]),
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

  // Monotonic ids for the step-3 rows, so a row keeps its identity across
  // edits and a deletion removes the row that was clicked rather than whatever
  // has since moved into that index.
  const rowSeq = useRef(0);
  const addRow = <K extends "pvcs" | "envs" | "ports">(key: K, row: Omit<Draft[K][number], "id">) =>
    setDraft((prev) => ({ ...prev, [key]: [...prev[key], { ...row, id: (rowSeq.current += 1) }] }) as Draft);
  const patchRow = <K extends "pvcs" | "envs" | "ports">(key: K, id: number, patch: Partial<Draft[K][number]>) =>
    setDraft((prev) => ({ ...prev, [key]: prev[key].map((r) => (r.id === id ? { ...r, ...patch } : r)) }) as Draft);
  const removeRow = <K extends "pvcs" | "envs" | "ports">(key: K, id: number) =>
    setDraft((prev) => ({ ...prev, [key]: (prev[key] as Array<{ id: number }>).filter((r) => r.id !== id) }) as Draft);

  // Changing the core count changes which memory sizes are legal, so the memory
  // is re-derived rather than left pointing at a total that is no longer on the
  // list. The 1x/2x/4x ratio the user picked is what carries over.
  const setCpu = (cpu: string) =>
    setDraft((prev) => {
      const tier = MEM_TIER.find((t) => `${Number(prev.cpu) * t}Gi` === prev.memory) ?? 2;
      return { ...prev, cpu, memory: `${Number(cpu) * tier}Gi` };
    });

  // Re-derives the identity only when the tag actually changes: the freeSolo
  // Autocomplete echoes the same value back on blur, and re-deriving there would
  // silently undo the account and uid/gid the user edited in step 3.
  const setImageTag = (tag: string) =>
    setDraft((prev) =>
      tag === prev.image ? prev : { ...prev, image: tag, ...identityOf(options?.images.find((i) => i.tag === tag)) },
    );

  const nameValid = DNS_LABEL_RE.test(draft.name.trim()) && draft.name.trim().length > 0;
  const step1Valid = nameValid && !!draft.namespace && !!draft.image;
  // Client-side validation mirrors the server (POST) rules so a user cannot
  // advance or submit out-of-range / fractional GPU or storage values. A card
  // count is only asked for, and only checked, when an accelerator is wanted:
  // "none" is sent as the absence of spec.resources.gpu, not as a count of 0.
  const gpuRequested = draft.accelerator !== "none";
  const gpuValid = !gpuRequested || (Number.isInteger(draft.gpuCount) && draft.gpuCount >= 1 && draft.gpuCount <= 16);
  const storageValid = Number.isInteger(draft.storageGi) && draft.storageGi >= 20 && draft.storageGi <= 800;
  const step2Valid = gpuValid && storageValid;
  const [gpuError, setGpuError] = useState(false);
  const [storageError, setStorageError] = useState(false);

  // Root is expressed as uid 0 alone, so the identity the user typed is kept in
  // the draft and only overridden for display and for submission. Turning root
  // back off restores whatever was there before, rather than leaving the fields
  // zeroed out from a toggle the user changed their mind about.
  const effectiveUser = draft.runAsRoot ? "root" : draft.runtimeUser.trim();
  const effectiveUid = draft.runAsRoot ? "0" : draft.runAsUser.trim();
  const effectiveGid = draft.runAsRoot ? "0" : draft.runAsGroup.trim();
  const accountValid = RUNTIME_USER_RE.test(effectiveUser) && effectiveUser.length <= RUNTIME_USER_MAX;
  const idValid = (v: string) => /^\d+$/.test(v) && Number(v) <= RUN_AS_ID_MAX;
  const uidGidValid = idValid(effectiveUid) && idValid(effectiveGid);
  const [accountError, setAccountError] = useState(false);
  const [uidGidError, setUidGidError] = useState(false);

  // A row the user added and never filled is not configuration: it is dropped
  // rather than reported, so an untouched row neither blocks the step nor
  // reaches the server as an error.
  const filledPvcs = draft.pvcs.filter((r) => r.pvcName.trim() || r.mountPath.trim());
  const filledEnvs = draft.envs.filter((r) => r.name.trim() || r.value.trim());
  const filledPorts = draft.ports.filter((r) => r.name.trim() || r.port.trim());

  const mountPath = draft.mountPath.trim();
  const pathOk = (p: string) => p.startsWith("/") && p !== "/";
  const mountPathValid = !mountPath || pathOk(mountPath);
  const pvcRowsValid =
    filledPvcs.every((r) => !!r.pvcName.trim() && pathOk(r.mountPath.trim())) &&
    // One path may be claimed once — the workspace's included, since it too
    // becomes a mount in the same pod.
    new Set([...(mountPath ? [mountPath] : []), ...filledPvcs.map((r) => r.mountPath.trim())]).size ===
      (mountPath ? 1 : 0) + filledPvcs.length;
  const envRowsValid =
    filledEnvs.every((r) => ENV_NAME_RE.test(r.name.trim()) && (r.name.trim() !== "HOME" || r.value.startsWith("/"))) &&
    new Set(filledEnvs.map((r) => r.name.trim())).size === filledEnvs.length;
  const l4Ports = filledPorts.filter((r) => r.type !== "http");
  const portRowsValid =
    filledPorts.every(
      (r) => !!r.name.trim() && /^\d+$/.test(r.port.trim()) && Number(r.port.trim()) >= 1 && Number(r.port.trim()) <= 65535,
    ) &&
    new Set(filledPorts.map((r) => r.name.trim())).size === filledPorts.length &&
    // tcp and udp are published over one L4 pool, where a number is held by a
    // single protocol; http goes through the Gateway and may share a number.
    new Set(l4Ports.map((r) => r.port.trim())).size === l4Ports.length;

  const [mountPathError, setMountPathError] = useState(false);
  const [pvcError, setPvcError] = useState(false);
  const [envError, setEnvError] = useState(false);
  const [portError, setPortError] = useState(false);
  const step3Valid = accountValid && uidGidValid && mountPathValid && pvcRowsValid && envRowsValid && portRowsValid;

  // What spec.storage.mountPath would derive to if left empty, in the CRD's own
  // order (StorageSpec.MountPath): an absolute HOME in spec.runtime.env first,
  // then /root for a root container, then the account's /home/<user>, then
  // /workspace. A placeholder only — it is never sent.
  const derivedMountPath =
    filledEnvs.find((r) => r.name.trim() === "HOME" && r.value.startsWith("/"))?.value ??
    (draft.runAsRoot ? "/root" : effectiveUser ? `/home/${effectiveUser}` : "/workspace");

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
    } else if (step === 3) {
      setAccountError(!accountValid);
      setUidGidError(!uidGidValid);
      setMountPathError(!mountPathValid);
      setPvcError(!pvcRowsValid);
      setEnvError(!envRowsValid);
      setPortError(!portRowsValid);
      if (!step3Valid) return;
    }
    setStep((s) => Math.min(4, s + 1));
  };

  const create = () => {
    // Defense in depth: never submit out-of-range / fractional GPU or storage
    // values, nor an invalid runtime identity, even if the wizard state is
    // manipulated directly.
    setGpuError(!gpuValid);
    setStorageError(!storageValid);
    setAccountError(!accountValid);
    setUidGidError(!uidGidValid);
    setMountPathError(!mountPathValid);
    setPvcError(!pvcRowsValid);
    setEnvError(!envRowsValid);
    setPortError(!portRowsValid);
    if (!step2Valid || !step3Valid) return;
    setCreateBusy(true);
    setCreateError(null);
    const body = {
      namespace: draft.namespace,
      name: draft.name.trim(),
      type: draft.type,
      image: draft.image.trim(),
      accelerator: draft.accelerator,
      // A card count is only meaningful with an accelerator: sending the stale
      // default alongside "none" would describe a GPU the user did not ask for.
      ...(gpuRequested ? { gpuCount: draft.gpuCount } : {}),
      cpu: draft.cpu,
      memory: draft.memory,
      storageGi: draft.storageGi,
      idleTimeout: draft.idle,
      // Root is requested by runAsUser 0 alone; the operator serves "root" and
      // ignores spec.runtime.user, so no account is sent with it — sending one
      // would only be reported back as an overridden field.
      ...(draft.runAsRoot
        ? { runAsUser: 0, runAsGroup: 0 }
        : {
            runtimeUser: effectiveUser,
            runAsUser: Number(effectiveUid),
            runAsGroup: Number(effectiveGid),
          }),
      // Step 3's storage / runtime / network sections. Each is sent only when it
      // states something, so an untouched wizard describes exactly the
      // environment it used to: `mountPath` in particular is never sent as a
      // blank, which would pin a path the controller was deriving.
      ...(mountPath ? { mountPath } : {}),
      ...(filledPvcs.length
        ? { volumes: filledPvcs.map((r) => ({ pvcName: r.pvcName.trim(), mountPath: r.mountPath.trim() })) }
        : {}),
      ...(filledEnvs.length ? { env: filledEnvs.map((r) => ({ name: r.name.trim(), value: r.value })) } : {}),
      ...(draft.args.trim() ? { args: draft.args.trim() } : {}),
      ...(filledPorts.length
        ? {
            ports: filledPorts.map((r) => ({
              name: r.name.trim(),
              containerPort: Number(r.port.trim()),
              type: r.type,
            })),
          }
        : {}),
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

  const stepTitles = [
    t("dev.wizard.step.basic"),
    t("dev.wizard.step.resources"),
    t("dev.wizard.step.advanced"),
    t("dev.wizard.step.confirm"),
  ];
  const labelFor = (tag: string) => options?.images.find((i) => i.tag === tag)?.label ?? tag;

  // What the user will see on the confirm step. Built by pushing into a typed
  // array rather than spreading, so the conditional rows stay [string, string].
  const summaryRows: Array<[string, string]> = [
    [t("dev.wizard.name"), draft.name.trim()],
    [t("dev.wizard.namespace"), draft.namespace],
    [t("dev.wizard.type"), draft.type],
    [t("dev.wizard.image"), draft.image],
    [t("dev.wizard.accelerator"), gpuRequested ? `${draft.gpuCount} × ${draft.accelerator}` : t("dev.wizard.accelerator.none")],
    [t("dev.wizard.cpu"), t("dev.cpu.cores", { n: draft.cpu })],
    [t("dev.wizard.memory"), draft.memory],
    [t("dev.wizard.storage"), `${draft.storageGi}Gi`],
    [t("dev.wizard.idle"), draft.idle === 0 ? t("dev.spec.idleOff") : t("dev.spec.idleMin", { minutes: String(draft.idle / 60) })],
    [
      t("dev.wizard.identity"),
      draft.runAsRoot
        ? t("dev.wizard.identityRoot")
        : t("dev.wizard.identityValue", { user: effectiveUser, uid: effectiveUid, gid: effectiveGid }),
    ],
  ];
  // Only what the user actually stated: a list of empty rows would bury the
  // handful of fields they set.
  if (mountPath) summaryRows.push([t("dev.wizard.mountPath"), mountPath]);
  if (filledPvcs.length) {
    summaryRows.push([t("dev.wizard.pvcs"), filledPvcs.map((r) => `${r.pvcName.trim()} → ${r.mountPath.trim()}`).join(" · ")]);
  }
  if (filledEnvs.length) summaryRows.push([t("dev.wizard.envs"), filledEnvs.map((r) => r.name.trim()).join(" · ")]);
  if (draft.args.trim()) summaryRows.push([t("dev.wizard.args"), draft.args.trim()]);
  if (filledPorts.length) {
    summaryRows.push([t("dev.wizard.ports"), filledPorts.map((r) => `${r.name.trim()}:${r.port.trim()}/${r.type}`).join(" · ")]);
  }

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
                  <Autocomplete
                    freeSolo
                    size="small"
                    fullWidth
                    data-od-id="wizard-image"
                    options={options.images.map((img) => img.tag)}
                    value={draft.image}
                    inputValue={draft.image}
                    onChange={(_, v) => setImageTag(v ?? "")}
                    onInputChange={(_, v) => setImageTag(v)}
                    // The list is keyed by tag but reads as the human label, so a
                    // search for "cpu" or "jovyan" has to match the label too.
                    filterOptions={(tags, state) => {
                      const q = state.inputValue.trim().toLowerCase();
                      if (!q) return tags;
                      return tags.filter((tag) => `${tag} ${labelFor(tag)}`.toLowerCase().includes(q));
                    }}
                    renderOption={(props, tag) => {
                      // MUI 6.5 spreads a key into props; React 18 warns when the
                      // spread carries one, so it is pulled out and passed directly.
                      const { key, ...optionProps } = props;
                      return (
                        <Box component="li" key={key} {...optionProps} sx={{ display: "block" }}>
                          <Box sx={{ fontSize: 12.5 }}>{labelFor(tag)}</Box>
                          <Box component="span" sx={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", mt: "2px" }}>
                            {tag}
                          </Box>
                        </Box>
                      );
                    }}
                    renderInput={(params) => <TextField {...params} placeholder={t("dev.wizard.image")} />}
                  />
                </WizField>
              </Box>
            )}

            {step === 2 && (
              <Box data-step="2">
                <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: "0 14px" }}>
                  <WizField label={t("dev.wizard.accelerator")}>
                    <Select size="small" fullWidth value={draft.accelerator} onChange={(e) => setField("accelerator", e.target.value as Draft["accelerator"])}>
                      <MenuItem value="none">{t("dev.wizard.accelerator.none")}</MenuItem>
                      <MenuItem value="nvidia">nvidia</MenuItem>
                      <MenuItem value="metax">metax</MenuItem>
                    </Select>
                  </WizField>
                  {gpuRequested ? (
                    <WizField label={t("dev.wizard.gpuCount")} error={gpuError} errorText={t("dev.wizard.errGpu")}>
                      <TextField size="small" fullWidth type="number" inputProps={{ min: 1, max: 16 }} value={draft.gpuCount} onChange={(e) => setField("gpuCount", Number(e.target.value))} />
                    </WizField>
                  ) : null}
                  <WizField label={t("dev.wizard.cpu")}>
                    <Select size="small" fullWidth value={draft.cpu} onChange={(e) => setCpu(e.target.value)}>
                      {CPU_OPTIONS.map((c) => (
                        <MenuItem key={c} value={c}>{t("dev.cpu.cores", { n: c })}</MenuItem>
                      ))}
                    </Select>
                  </WizField>
                  <WizField label={t("dev.wizard.memory")} hint={t("dev.wizard.memoryHint")}>
                    <Select size="small" fullWidth value={draft.memory} onChange={(e) => setField("memory", e.target.value)}>
                      {memoryOptions(draft.cpu).map((m) => (
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
              <Box data-step="3" sx={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <WizSection odId="sec-workspace" title={t("dev.wizard.workspace")} badge="storage.mountPath / volumes">
                  <WizField
                    label={t("dev.wizard.mountPath")}
                    hint={t("dev.wizard.mountPathHint")}
                    error={mountPathError}
                    errorText={t("dev.wizard.errMountPath")}
                  >
                    <TextField
                      size="small"
                      fullWidth
                      data-od-id="wizard-mount-path"
                      value={draft.mountPath}
                      onChange={(e) => setField("mountPath", e.target.value)}
                      placeholder={derivedMountPath}
                    />
                  </WizField>
                  <WizField label={t("dev.wizard.pvcs")} error={pvcError} errorText={t("dev.wizard.errPvc")}>
                    {draft.pvcs.map((r) => (
                      <Box key={r.id} sx={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", alignItems: "center", mb: "8px" }}>
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="pvc-name"
                          placeholder={t("dev.wizard.pvcNamePh")}
                          value={r.pvcName}
                          onChange={(e) => patchRow("pvcs", r.id, { pvcName: e.target.value })}
                        />
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="pvc-path"
                          placeholder={t("dev.wizard.pvcPathPh")}
                          value={r.mountPath}
                          onChange={(e) => patchRow("pvcs", r.id, { mountPath: e.target.value })}
                        />
                        <RowDelete label={t("dev.wizard.removeRow")} onClick={() => removeRow("pvcs", r.id)} />
                      </Box>
                    ))}
                    <AddRowButton label={t("dev.wizard.addPvc")} onClick={() => addRow("pvcs", { pvcName: "", mountPath: "" })} />
                  </WizField>
                </WizSection>

                <WizSection odId="sec-security" title={t("dev.wizard.security")} badge="securityContext">
                  <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", py: "8px" }}>
                    <Box>
                      <Box sx={{ fontSize: 12.5 }}>{t("dev.wizard.root")}</Box>
                      <Box sx={{ fontSize: 11, color: "text.secondary", mt: "2px" }}>{t("dev.wizard.rootHint")}</Box>
                    </Box>
                    <Switch size="small" checked={draft.runAsRoot} onChange={(e) => setField("runAsRoot", e.target.checked)} data-od-id="wizard-root" />
                  </Box>
                  <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: "0 14px", pt: "6px" }}>
                    <WizField label={t("dev.wizard.account")} hint={t("dev.wizard.accountHint")} error={accountError} errorText={t("dev.wizard.errAccount")}>
                      <TextField
                        size="small"
                        fullWidth
                        disabled={draft.runAsRoot}
                        value={effectiveUser}
                        onChange={(e) => setField("runtimeUser", e.target.value)}
                      />
                    </WizField>
                    <WizField label={t("dev.wizard.uidGid")} hint={t("dev.wizard.uidGidHint")} error={uidGidError} errorText={t("dev.wizard.errUidGid")}>
                      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                        <TextField
                          size="small"
                          fullWidth
                          disabled={draft.runAsRoot}
                          inputProps={{ inputMode: "numeric" }}
                          placeholder="uid"
                          value={effectiveUid}
                          onChange={(e) => setField("runAsUser", e.target.value)}
                        />
                        <TextField
                          size="small"
                          fullWidth
                          disabled={draft.runAsRoot}
                          inputProps={{ inputMode: "numeric" }}
                          placeholder="gid"
                          value={effectiveGid}
                          onChange={(e) => setField("runAsGroup", e.target.value)}
                        />
                      </Box>
                    </WizField>
                  </Box>
                </WizSection>

                <WizSection odId="sec-runtime" title={t("dev.wizard.runtime")} badge="runtime.env / args">
                  <WizField label={t("dev.wizard.envs")} hint={t("dev.wizard.envHint")} error={envError} errorText={t("dev.wizard.errEnv")}>
                    {draft.envs.map((r) => (
                      <Box key={r.id} sx={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", alignItems: "center", mb: "8px" }}>
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="env-name"
                          placeholder={t("dev.wizard.envNamePh")}
                          value={r.name}
                          onChange={(e) => patchRow("envs", r.id, { name: e.target.value })}
                        />
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="env-value"
                          placeholder={t("dev.wizard.envValuePh")}
                          value={r.value}
                          onChange={(e) => patchRow("envs", r.id, { value: e.target.value })}
                        />
                        <RowDelete label={t("dev.wizard.removeRow")} onClick={() => removeRow("envs", r.id)} />
                      </Box>
                    ))}
                    <AddRowButton label={t("dev.wizard.addEnv")} onClick={() => addRow("envs", { name: "", value: "" })} />
                  </WizField>
                  <WizField label={t("dev.wizard.args")} hint={t("dev.wizard.argsHint")}>
                    <TextField
                      size="small"
                      fullWidth
                      data-od-id="wizard-args"
                      placeholder={t("dev.wizard.argsPh")}
                      value={draft.args}
                      onChange={(e) => setField("args", e.target.value)}
                    />
                  </WizField>
                </WizSection>

                <WizSection odId="sec-network" title={t("dev.wizard.network")} badge="ports">
                  <WizField label={t("dev.wizard.ports")} hint={t("dev.wizard.portsHint")} error={portError} errorText={t("dev.wizard.errPort")}>
                    {draft.ports.map((r) => (
                      <Box key={r.id} sx={{ display: "grid", gridTemplateColumns: "1fr 110px 110px auto", gap: "8px", alignItems: "center", mb: "8px" }}>
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="port-name"
                          placeholder={t("dev.wizard.portNamePh")}
                          value={r.name}
                          onChange={(e) => patchRow("ports", r.id, { name: e.target.value })}
                        />
                        <TextField
                          size="small"
                          fullWidth
                          data-od-id="port-num"
                          inputProps={{ inputMode: "numeric" }}
                          placeholder={t("dev.wizard.portPh")}
                          value={r.port}
                          onChange={(e) => patchRow("ports", r.id, { port: e.target.value })}
                        />
                        <Select
                          size="small"
                          fullWidth
                          data-od-id="port-type"
                          value={r.type}
                          onChange={(e) => patchRow("ports", r.id, { type: e.target.value as PortType })}
                        >
                          {PORT_TYPES.map((ty) => (
                            <MenuItem key={ty} value={ty}>
                              {t(PORT_TYPE_LABEL[ty])}
                            </MenuItem>
                          ))}
                        </Select>
                        <RowDelete label={t("dev.wizard.removeRow")} onClick={() => removeRow("ports", r.id)} />
                      </Box>
                    ))}
                    <AddRowButton label={t("dev.wizard.addPort")} onClick={() => addRow("ports", { name: "", port: "", type: "http" })} />
                  </WizField>
                </WizSection>
              </Box>
            )}

            {step === 4 && (
              <Box data-step="4">
                <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: "10px" }}>{t("dev.wizard.summary")}</Typography>
                <Kvs rows={summaryRows} />
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
          {step < 4 ? (
            <Button variant="contained" disableElevation sx={{ textTransform: "none", fontSize: 12.5 }} onClick={next}>
              {t("dev.wizard.next")}
            </Button>
          ) : (
            <Button variant="contained" disableElevation data-od-id="wizard-create" disabled={!step3Valid || createBusy} onClick={create} sx={{ textTransform: "none", fontSize: 12.5 }}>
              {createBusy ? t("dev.wizard.creating") : t("dev.wizard.create")}
            </Button>
          )}
        </Box>
      </DialogActions>
    </Dialog>
  );
}

/** One step-3 section: the fields of one part of the spec, and which part. */
function WizSection({ odId, title, badge, children }: { odId: string; title: string; badge: string; children: React.ReactNode }) {
  return (
    <Box data-od-id={odId} sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", p: "14px 16px" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: "4px" }}>
        <Box sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Box>
        {/* The CRD path this section writes, as the mono badge the security
            section already carries — so a value can be traced to its field. */}
        <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", px: "9px", py: "5px" }}>
          {badge}
        </Box>
      </Box>
      {children}
    </Box>
  );
}

function RowDelete({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      title={label}
      data-od-id="row-del"
      onClick={onClick}
      sx={{
        width: 32,
        height: 32,
        flex: "none",
        border: 1,
        borderColor: "divider",
        borderRadius: "var(--radius)",
        bgcolor: "transparent",
        color: "text.secondary",
        fontSize: 15,
        lineHeight: 1,
        cursor: "pointer",
        "&:hover": { color: STATUS_ERR, borderColor: soft(STATUS_ERR, 55) },
      }}
    >
      ×
    </Box>
  );
}

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      data-od-id="row-add"
      onClick={onClick}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        bgcolor: "transparent",
        color: "text.secondary",
        px: "12px",
        py: "7px",
        fontSize: 12.5,
        fontFamily: "inherit",
        cursor: "pointer",
        "&:hover": { color: "var(--accent-strong)", borderColor: "var(--accent)" },
      }}
    >
      + {label}
    </Box>
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