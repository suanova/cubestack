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
  Divider,
  Menu,
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
import type { SshKeySecretOption } from "@/app/api/devenvironments/ssh-keys/route";
import { validationMessage, type ValidationErrorBody } from "@/lib/api-error";
import { apiFetch } from "@/lib/base-path";
import { copyText } from "@/lib/clipboard";
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
    apiFetch("/api/devenvironments")
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

  /**
   * What deleting this environment does to its workspace, stated as the
   * consequence for this environment rather than as the field that decides it:
   * pvcRetention is chosen once, in the wizard, and never seen again — naming it
   * at the moment of deletion tells the user nothing. The claim name is the same
   * one the StatefulSet provisions (workspace-<name>-0), which is how a retained
   * workspace can be found again after the environment is gone.
   */
  const deletePrompt = (e: DevEnvironmentSummary) => {
    if (!e.storage) return t("dev.delete.confirm", { name: e.name });
    const claim = `workspace-${e.name}-0`;
    return e.storage.pvcRetention === "retain"
      ? t("dev.delete.confirmRetain", { name: e.name, size: e.storage.size, claim })
      : t("dev.delete.confirmDelete", { name: e.name, size: e.storage.size, claim });
  };

  const runAction = (e: DevEnvironmentSummary, act: string) => {
    if (act === "stop") {
      patch({ namespace: e.namespace, name: e.name, running: false });
    } else if (act === "start") {
      patch({ namespace: e.namespace, name: e.name, running: true });
    } else if (act === "del") {
      if (!window.confirm(deletePrompt(e))) return;
      apiFetch("/api/devenvironments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: e.namespace, name: e.name }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
          if (!res.ok) throw new Error(validationMessage(t, body, res.status, "dev"));
          load();
        })
        .catch((err: Error) => window.alert(err.message));
    }
  };

  const patch = useCallback(
    ({ namespace, name, running }: { namespace: string; name: string; running: boolean }) => {
      apiFetch("/api/devenvironments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name, running }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
          if (!res.ok) throw new Error(validationMessage(t, body, res.status, "dev"));
          load();
        })
        .catch((err: Error) => window.alert(err.message));
    },
    [load, t],
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
        environments={items}
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ ...thSx, width: "26%" }}>{t("dev.col.env")}</th>
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
                    <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {t("dev.cpu.cores", { n: e.resources.cpu })} / {e.resources.memory}
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
                <td colSpan={6} style={{ ...tdSx, textAlign: "center", borderBottom: 0 }}>
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

/**
 * A row's kebab menu. Start and stop follow from the phase rather than the type:
 * a Running environment can only be stopped, since its work is live; a Stopped
 * one can be started again. Deleting is outside that gate — it is offered in
 * every phase, including the ones the console does not know (an empty phase, a
 * Failed one), because an environment a user can see is one they must be able to
 * remove: a phase allowlist would otherwise leave a stuck object that no console
 * action can reach, and the storage behind it unreclaimable too.
 *
 * The menu itself is a MUI `Menu` rather than the prototype's absolutely
 * positioned box: the table sits in a scroll container, which would clip a
 * menu laid out inside it.
 */
function RowActions({ e, onAct }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void }) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const canStop = e.phase === "Running";
  const canStart = e.phase === "Stopped";
  const itemSx = {
    fontSize: 12.5,
    fontWeight: 550,
    px: "11px",
    py: "7px",
    borderRadius: "6px",
  };
  const run = (act: string) => {
    // Deleting removes the row — and with it the kebab MUI hands focus back to
    // — which leaves the closing modal aria-hidden around a focused item. Drop
    // that focus first so there is nothing to hide. Start and stop keep their
    // row, so their item stays focused and the kebab takes the focus back.
    if (act === "del") (document.activeElement as HTMLElement | null)?.blur();
    setAnchor(null);
    onAct(e, act);
  };
  return (
    // The row itself is the selection control, so the kebab and its items must
    // not reach it: one click means one thing.
    <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex" }}>
      <Button
        size="small"
        data-od-id={`env-ops-${e.name}`}
        aria-label={t("dev.col.ops")}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : "false"}
        onClick={(ev) => setAnchor(ev.currentTarget)}
        sx={{
          minWidth: 0,
          width: 30,
          height: 30,
          p: 0,
          border: 1,
          borderColor: "divider",
          borderRadius: "6px",
          bgcolor: "background.paper",
          color: "text.primary",
          "&:hover": { borderColor: "text.primary", bgcolor: "var(--surface)" },
        }}
      >
        <Box component="svg" viewBox="0 0 16 16" aria-hidden sx={{ width: 16, height: 16, fill: "currentColor" }}>
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </Box>
      </Button>
      <Menu
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 128,
              mt: "6px",
              border: 1,
              borderColor: "divider",
              borderRadius: "8px",
              boxShadow: "0 12px 28px color-mix(in oklch, var(--fg) 14%, transparent)",
            },
          },
          list: { sx: { py: "4px", px: "4px" } },
        }}
      >
        {canStop ? (
          <MenuItem data-od-id={`act-stop-${e.name}`} onClick={() => run("stop")} sx={itemSx}>
            {t("dev.act.stop")}
          </MenuItem>
        ) : null}
        {canStart ? (
          <MenuItem data-od-id={`act-start-${e.name}`} onClick={() => run("start")} sx={itemSx}>
            {t("dev.act.start")}
          </MenuItem>
        ) : null}
        {canStop || canStart ? <Divider sx={{ my: "4px", mx: "6px" }} /> : null}
        <MenuItem
          data-od-id={`act-del-${e.name}`}
          onClick={() => run("del")}
          sx={{ ...itemSx, color: soft(STATUS_ERR, 70), "&:hover": { bgcolor: soft(STATUS_ERR, 10), color: soft(STATUS_ERR, 70) } }}
        >
          {t("dev.act.delete")}
        </MenuItem>
      </Menu>
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
  // idle → copied → idle, or idle → failed, which stays long enough to be read
  // and to be retried by hand: the clipboard is unavailable on the plain-HTTP
  // deployment this serves, so a silent no-op is the one outcome a copy button
  // may not have.
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <Box sx={{ mb: "12px" }}>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", px: "9px", py: "5px", overflow: "hidden" }}>
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{value}</Box>
        <Button
          disableRipple
          onClick={async () => {
            const ok = await copyText(value);
            setCopied(ok ? "ok" : "fail");
            setTimeout(() => setCopied("idle"), ok ? 1200 : 4000);
          }}
          sx={{
            p: 0,
            minWidth: 0,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: copied === "fail" ? STATUS_ERR : "var(--accent-strong)",
            textTransform: "none",
            "&:hover": { textDecoration: "underline" },
          }}
        >
          {copied === "ok" ? t("dev.conn.copied") : copied === "fail" ? t("dev.conn.copyFailed") : t("dev.conn.copy")}
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
          {/* Reaching a jupyter environment needs its token, and the Copy button
              is the same one the endpoints use — what is offered is the command
              that reads the Secret, never its value. */}
          {e.type === "jupyter" && e.jupyterTokenSecret ? (
            <EndpointRow
              label={t("dev.conn.tokenFrom", { name: e.jupyterTokenSecret.name })}
              value={`kubectl -n ${e.jupyterTokenSecret.namespace} get secret ${e.jupyterTokenSecret.name} -o jsonpath='{.data.token}' | base64 -d`}
            />
          ) : null}
          <Typography sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.7 }}>{t("dev.conn.guide")}</Typography>
          {/* Said only when it is true of this environment: the idle clause used
              to be part of the guide, so an environment created with the timeout
              disabled still claimed an expiry on the same screen that showed
              "disabled". */}
          {e.idleTimeout > 0 ? (
            <Typography sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.7 }}>
              {t("dev.conn.idle", { minutes: String(Math.round(e.idleTimeout / 60)) })}
            </Typography>
          ) : null}
        </Box>
      </Card>
    );
  }
  return (
    <Card title={t("dev.conn.title")} meta={t("dev.conn.meta")}>
      <Box sx={{ px: "18px", py: "20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          {/* The line states a phase only when the environment reports one: an
              environment whose controller failed before the status write has
              none, and interpolating it made the card read "The environment is
              —". What is true without a phase is that there is nothing to
              connect to yet. */}
          {e.phase ? t("dev.conn.none", { phase: e.phase }) : t("dev.conn.noPhase")}
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
      // runtime identity, and for a jupyter image that is /home/jovyan. The
      // retention policy is named only when it is the unusual one — delete is
      // the CRD's default and what most environments carry, and it is stated
      // where it matters, in the delete confirmation.
      e.storage
        ? `${e.storage.size} · ${e.storage.mountPath ?? t("dev.spec.mountPathDerived")}${
            e.storage.pvcRetention === "retain" ? ` · ${t("dev.spec.storageRetained")}` : ""
          }`
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
  if (e.command.length) rows.push([t("dev.spec.command"), e.command.join(" ")]);
  if (e.args.length) rows.push([t("dev.spec.args"), e.args.join(" ")]);
  if (e.ports.length) rows.push([t("dev.spec.ports"), e.ports.map((p) => `${p.name}:${p.containerPort}/${p.type}`).join(" · ")]);
  // Only a jupyter environment has one, and only once the controller has made
  // it. The value stays in the cluster — the portal has no cluster-wide Secret
  // read — so the name is all this row can honestly show.
  if (e.jupyterTokenSecret) rows.push([t("dev.spec.jupyterToken"), e.jupyterTokenSecret.name]);
  return (
    <Card title={t("dev.spec.title")} meta={t("dev.spec.meta")}>
      <Kvs rows={rows} />
      <Box sx={{ display: "flex", flexDirection: "column", gap: "8px", px: "18px", py: "12px", borderTop: 1, borderColor: "divider" }}>
        {e.conditions.length === 0 ? (
          <Typography data-od-id="env-conds-empty" sx={{ fontSize: 12, color: "text.secondary" }}>{t("dev.cond.empty")}</Typography>
        ) : (
          <>
            <Box sx={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {e.conditions.map((c) => {
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
                // The object's own sentence about this condition, in the shape
                // `kubectl describe` prints it. It is the diagnosis for whatever
                // the environment is doing wrong — a Ready=False reads "the pod
                // is running but not ready", which is what a 503 from the route
                // means — and until now nothing in the console reached it.
                const detail = [c.reason ? `(${c.reason})` : "", c.message].filter(Boolean).join(" ");
                return (
                  <Box
                    key={c.type}
                    data-od-id={`cond-${c.type}`}
                    component="span"
                    // A hover on the pill answers for every condition, including
                    // the True ones, which carry no line of their own.
                    title={detail ? `${c.type} ${c.status} ${detail}` : undefined}
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
                      // Decorative once the status is text beside it: hue was the
                      // only carrier, which reads as nothing to a screen reader and
                      // little to a colour-blind one.
                      aria-hidden="true"
                      sx={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        bgcolor: dot,
                        flex: "none",
                      }}
                    />
                    {c.type}
                    {/* The status itself, as the object states it. It is a
                        Kubernetes enum, so it reads the same in every locale —
                        the way an unrecognised phase already does. */}
                    <Box component="span" sx={{ fontWeight: 600, opacity: 0.75 }}>{c.status}</Box>
                  </Box>
                );
              })}
            </Box>
            {e.conditions
              .filter((c) => c.status !== "True" && (c.reason || c.message))
              .map((c) => (
                <Typography key={c.type} data-od-id={`cond-note-${c.type}`} sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>
                  <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>{c.type}</Box>
                  {c.reason ? <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>{` (${c.reason})`}</Box> : null}
                  {c.message ? `: ${c.message}` : ""}
                </Typography>
              ))}
          </>
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
// spec.lifecycle.idleTimeout is an int32 in seconds, 0 meaning "never shut down",
// and the CRD bounds it no further, so an int32 is the ceiling. Mirrored from the
// create route, so the custom box cannot walk the user to a 400.
const IDLE_TIMEOUT_MAX = 2147483647;
// The create route's own rules, mirrored so the wizard cannot walk the user to a
// spec the server would refuse. corev1.EnvVar.name, and the CRD's port type enum.
const ENV_NAME_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const PORT_TYPES = ["http", "tcp", "udp"] as const;
type PortType = (typeof PORT_TYPES)[number];

// The types the wizard offers, which is not the CRD's enum: `vscode` is a legal
// spec.type the platform cannot serve. mainContainerPort maps it to 8080 and the
// readiness probe and the Service both target that port, but no published image
// binds it — the catalog is jupyter (8888) and ssh images, so a `vscode`
// environment is created 0/1 with a route that 503s while reporting
// RouteReady=True. Offering it would be offering a spec the platform cannot
// honour, so it is dropped here rather than left as a trap; the CRD keeps the
// value, and an object applied by hand still renders with its own badge.
const WIZARD_TYPES = ["jupyter", "ssh"] as const;

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
  // spec.storage.pvcRetention: what deleting the environment does to the
  // workspace claim. "delete" is the CRD's default and the one the wizard opens
  // on, stated rather than implied so the choice is visible before it is made.
  pvcRetention: "retain" | "delete";
  idle: number;
  // The presets cover the common choices; the custom branch carries everything
  // else, in minutes as typed — held as a string like the uid/gid boxes, since
  // an empty box is not 0 (which means "never shut down").
  idleCustom: boolean;
  idleMinutes: string;
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
  // One command line each, as the prototype's single box takes them; split into
  // spec.runtime.command / .args by the route. They override different things —
  // the image's ENTRYPOINT and its CMD — so they are two boxes, not one.
  args: string;
  command: string;
  ports: PortRow[];
  // spec.network: RDMA access, independent of the accelerator. rdmaEnabled gates
  // the block; rdmaType names the fabric, defaulting to roce (the CRD default).
  // A fabric no node advertises does not fail the write — the environment stays
  // Pending — so the choice is offered with a hint rather than hidden.
  rdmaEnabled: boolean;
  rdmaType: "roce" | "infiniband";
  // spec.ssh: independent of the environment's type. sshEnabled opens the SSH
  // endpoint on any type (a jupyter + ssh environment); sshKeysSecret /
  // sshKeysKey point at the user's own key Secret — one of the labelled Secrets
  // in the namespace, with a data entry to mount as authorized_keys. Empty means
  // "let the operator mint a keypair" (the default).
  sshEnabled: boolean;
  sshKeysSecret: string;
  sshKeysKey: string;
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
  environments,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** What exists now, for the name check step 1 makes against the namespace. */
  environments: DevEnvironmentSummary[];
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
    pvcRetention: "delete",
    idle: 0,
    idleCustom: false,
    idleMinutes: "",
    runAsRoot: false,
    runtimeUser: "",
    runAsUser: String(PLATFORM_UID),
    runAsGroup: String(PLATFORM_GID),
    mountPath: "",
    pvcs: [],
    envs: [],
    args: "",
    command: "",
    ports: [],
    rdmaEnabled: false,
    rdmaType: "roce",
    sshEnabled: false,
    sshKeysSecret: "",
    sshKeysKey: "",
  });
  // The labelled key Secrets in the current namespace, for the SSH picker.
  // Loaded on demand (when the SSH toggle is turned on) rather than with the
  // other options, because it depends on the namespace the user picks in step 1.
  const [sshSecrets, setSshSecrets] = useState<SshKeySecretOption[]>([]);
  const [sshSecretsLoading, setSshSecretsLoading] = useState(false);
  const [sshSecretsError, setSshSecretsError] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch("/api/devenvironments/options")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: DevEnvOptionsResponse) => {
        if (cancelled) return;
        setOptions(d);
        setLoadError(null);
        setDraft((prev) => ({
          ...prev,
          // The namespace the API offers as the starting point — `default`, or
          // the platform's configured one. Not "the first that sorts": on a
          // CubeStack install that was a platform namespace.
          namespace: d.defaultNamespace ?? "",
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

  // Loads the labelled key Secrets for one namespace, so the SSH picker can
  // offer only the Secrets the operator will actually mount. Runs on demand
  // (when the SSH toggle is turned on) and again if the namespace changes while
  // SSH is on. A failure or an empty list does not block the step — the user can
  // still create the environment without a bring-your-own key (the operator
  // mints a keypair in that case) — so the picker degrades to a hint.
  const loadSshSecrets = useCallback(async (namespace: string) => {
    if (!namespace) {
      setSshSecrets([]);
      return;
    }
    setSshSecretsLoading(true);
    setSshSecretsError(null);
    try {
      const res = await apiFetch(`/api/devenvironments/ssh-keys?namespace=${encodeURIComponent(namespace)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const d = (await res.json()) as { secrets: SshKeySecretOption[] };
      setSshSecrets(d.secrets ?? []);
    } catch (err) {
      setSshSecrets([]);
      setSshSecretsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSshSecretsLoading(false);
    }
  }, []);

  // The namespace is picked in step 1; the SSH picker (step 3) is scoped to it.
  // Changing the namespace while SSH is on invalidates the loaded key Secrets,
  // so they are cleared and re-fetched for the new namespace.
  const changeNamespace = (namespace: string) => {
    setDraft((prev) => ({ ...prev, namespace, sshKeysSecret: "", sshKeysKey: "" }));
    if (draft.sshEnabled) {
      void loadSshSecrets(namespace);
    }
  };

  // The SSH toggle: turning it on loads the labelled key Secrets for the current
  // namespace (so the picker can offer them); turning it off clears the
  // bring-your-own key selection.
  const toggleSsh = (enabled: boolean) => {
    setDraft((prev) => ({
      ...prev,
      sshEnabled: enabled,
      ...(enabled ? {} : { sshKeysSecret: "", sshKeysKey: "" }),
    }));
    if (enabled) {
      void loadSshSecrets(draft.namespace);
    }
  };

  // Selecting a key Secret also picks its first data entry as the default
  // authorized_keys key, so the user only has to change it if the Secret holds
  // several entries.
  const changeSshSecret = (name: string) => {
    const secret = sshSecrets.find((s) => s.name === name);
    setDraft((prev) => ({ ...prev, sshKeysSecret: name, sshKeysKey: secret?.keys[0] ?? "" }));
  };

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

  // The name is checked against the target namespace's existing environments, not
  // only against the DNS-1123 pattern: the field's own message promises an
  // already-taken check ("Invalid or already-taken name"), and the list is already
  // in hand — the table behind this dialog renders it. Same name in another
  // namespace is a different environment and is not a clash. This is a
  // convenience: an environment created by someone else in the meantime is still
  // the server's to refuse, and its `nameTaken` is what the user then reads.
  const nameTaken = environments.some(
    (e) => e.namespace === draft.namespace && e.name === draft.name.trim(),
  );
  const nameValid = DNS_LABEL_RE.test(draft.name.trim()) && draft.name.trim().length > 0;
  const step1Valid = nameValid && !nameTaken && !!draft.namespace && !!draft.image;
  // Client-side validation mirrors the server (POST) rules so a user cannot
  // advance or submit out-of-range / fractional GPU or storage values. A card
  // count is only asked for, and only checked, when an accelerator is wanted:
  // "none" is sent as the absence of spec.resources.gpu, not as a count of 0.
  const gpuRequested = draft.accelerator !== "none";
  const gpuValid = !gpuRequested || (Number.isInteger(draft.gpuCount) && draft.gpuCount >= 1 && draft.gpuCount <= 16);
  const storageValid = Number.isInteger(draft.storageGi) && draft.storageGi >= 20 && draft.storageGi <= 800;
  // spec.lifecycle.idleTimeout is whatever the user needs it to be, not one of
  // four values: 30 minutes — the shortest preset — is short enough to stop an
  // environment someone is reading a notebook in. The custom box is minutes, as
  // the presets are, and is bounded only by the int32 the CRD holds.
  const idleMinutes = draft.idleMinutes.trim();
  const idleCustomValid =
    /^\d+$/.test(idleMinutes) && Number(idleMinutes) * 60 <= IDLE_TIMEOUT_MAX;
  const idleValid = !draft.idleCustom || idleCustomValid;
  const idleTimeoutSeconds = draft.idleCustom ? Number(idleMinutes) * 60 : draft.idle;
  const step2Valid = gpuValid && storageValid && idleValid;
  const [gpuError, setGpuError] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [idleError, setIdleError] = useState(false);

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
        setNameError(!nameValid || nameTaken);
        setImageError(!draft.image);
        return;
      }
      setNameError(false);
      setImageError(false);
    } else if (step === 2) {
      setGpuError(!gpuValid);
      setStorageError(!storageValid);
      setIdleError(!idleValid);
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
    setIdleError(!idleValid);
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
      // Sent only when the workspace is to outlive the environment: delete is
      // the CRD's default, and stating it would put a decision in the body the
      // user never made.
      ...(draft.pvcRetention === "retain" ? { pvcRetention: "retain" } : {}),
      idleTimeout: idleTimeoutSeconds,
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
      ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
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
      // spec.network: sent only when RDMA is on; rdmaType names the fabric the
      // environment joins. Off, the block is absent — the one spelling of no RDMA.
      ...(draft.rdmaEnabled ? { rdmaEnabled: true, rdmaType: draft.rdmaType } : {}),
      // spec.ssh: sent only when SSH is on (independent of type). The bring-your-
      // own key Secret is included only when one is chosen; otherwise the operator
      // mints a keypair for the environment.
      ...(draft.sshEnabled
        ? {
            sshEnabled: true,
            ...(draft.sshKeysSecret
              ? { sshKeysSecret: draft.sshKeysSecret, sshKeysKey: draft.sshKeysKey }
              : {}),
          }
        : {}),
    };
    apiFetch("/api/devenvironments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ValidationErrorBody & { name?: string };
        if (!res.ok) throw new Error(validationMessage(t, data, res.status, "dev"));
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
  // The interface the chosen image was built for, when the catalog knows it. The
  // image and the type are two independent choices, and the vendor images come
  // in per-interface pairs, so the two can disagree: an ssh image under type
  // jupyter is a token nothing serves. The list below offers only the images
  // that serve the chosen type, so this can only speak for a reference the user
  // typed in by hand — which is left alone and reported rather than corrected.
  const imageInterface = options?.images.find((i) => i.tag === draft.image)?.interface;

  // The images that can serve the chosen type. CUBESTACK_IMAGE is baked into
  // each image, so an image built for one interface cannot serve the other: an
  // ssh image under type jupyter runs sshd with nothing serving the token the
  // operator publishes for it, and a jupyter image under type ssh runs a
  // notebook nobody can reach.
  const imageOptions = (options?.images ?? []).filter((img) => img.interface === draft.type);

  // Switching the type keeps the vendor when the catalog has the pair: the two
  // images of a stack differ only in the mode baked into them, so a CUDA
  // environment moved to ssh lands on ssh-cuda-pytorch rather than on the CPU
  // image, which the operator would refuse as a brand mismatch. A reference the
  // user typed in by hand is their own and is left alone.
  const switchType = (tp: Draft["type"]) =>
    setDraft((prev) => {
      const current = options?.images.find((i) => i.tag === prev.image);
      if (!current || current.interface === tp) return { ...prev, type: tp };
      const pair =
        options?.images.find((i) => i.vendor === current.vendor && i.interface === tp) ??
        options?.images.find((i) => i.interface === tp);
      return pair ? { ...prev, type: tp, image: pair.tag, ...identityOf(pair) } : { ...prev, type: tp };
    });

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
    [
      t("dev.wizard.pvcRetention"),
      draft.pvcRetention === "retain" ? t("dev.wizard.pvcRetentionRetain") : t("dev.wizard.pvcRetentionDelete"),
    ],
    [t("dev.wizard.idle"), idleTimeoutSeconds === 0 ? t("dev.spec.idleOff") : t("dev.spec.idleMin", { minutes: String(idleTimeoutSeconds / 60) })],
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
  if (draft.command.trim()) summaryRows.push([t("dev.wizard.command"), draft.command.trim()]);
  if (draft.args.trim()) summaryRows.push([t("dev.wizard.args"), draft.args.trim()]);
  if (filledPorts.length) {
    summaryRows.push([t("dev.wizard.ports"), filledPorts.map((r) => `${r.name.trim()}:${r.port.trim()}/${r.type}`).join(" · ")]);
  }
  if (draft.rdmaEnabled) {
    summaryRows.push([t("dev.wizard.rdma"), draft.rdmaType === "roce" ? "RoCE" : "InfiniBand"]);
  }
  if (draft.sshEnabled) {
    summaryRows.push([
      t("dev.wizard.ssh"),
      draft.sshKeysSecret ? `${draft.sshKeysSecret}:${draft.sshKeysKey}` : t("dev.wizard.sshKeysPlatform"),
    ]);
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
                  <Select size="small" fullWidth data-od-id="wizard-namespace" value={draft.namespace} onChange={(e) => changeNamespace(e.target.value)}>
                    {options.namespaces.map((n) => (
                      <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
                    ))}
                  </Select>
                </WizField>
                <WizField
                  label={t("dev.wizard.type")}
                  hint={
                    imageInterface && imageInterface !== draft.type
                      ? t("dev.wizard.typeMismatch", { interface: t(`dev.wizard.type.${imageInterface}`) })
                      : undefined
                  }
                >
                  <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
                    {WIZARD_TYPES.map((tp) => (
                      <Box
                        key={tp}
                        component="button"
                        type="button"
                        onClick={() => switchType(tp)}
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
                <WizField
                  label={t("dev.wizard.image")}
                  hint={t("dev.wizard.imageHint")}
                  // An empty image is the one required field on this step that
                  // failed silently: clearing it (which is what the field's own
                  // clear button does before a new reference is typed) left Next
                  // with nothing to say, and no way to learn why.
                  error={imageError}
                  errorText={t("dev.wizard.errImage")}
                >
                  <Autocomplete
                    freeSolo
                    size="small"
                    fullWidth
                    data-od-id="wizard-image"
                    options={imageOptions.map((img) => img.tag)}
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
                    <Select
                      size="small"
                      fullWidth
                      data-od-id="wizard-idle"
                      value={draft.idleCustom ? "custom" : String(draft.idle)}
                      onChange={(e) => {
                        const v = e.target.value;
                        // Choosing custom keeps whatever was in the minutes box,
                        // so switching back and forth does not lose the value.
                        setDraft((prev) =>
                          v === "custom"
                            ? { ...prev, idleCustom: true, idleMinutes: prev.idleMinutes || (prev.idle ? String(prev.idle / 60) : "") }
                            : { ...prev, idleCustom: false, idle: Number(v) },
                        );
                      }}
                    >
                      <MenuItem value="0">{t("dev.wizard.idle0")}</MenuItem>
                      <MenuItem value="1800">30</MenuItem>
                      <MenuItem value="3600">60</MenuItem>
                      <MenuItem value="14400">240</MenuItem>
                      <MenuItem value="custom">{t("dev.wizard.idleCustom")}</MenuItem>
                    </Select>
                  </WizField>
                  {draft.idleCustom ? (
                    <WizField
                      label={t("dev.wizard.idleMinutes")}
                      hint={t("dev.wizard.idleMinutesHint")}
                      error={idleError && !idleCustomValid}
                      errorText={t("dev.wizard.errIdleCustom")}
                    >
                      <TextField
                        size="small"
                        fullWidth
                        type="number"
                        inputProps={{ min: 0 }}
                        data-od-id="wizard-idle-minutes"
                        value={draft.idleMinutes}
                        onChange={(e) => setField("idleMinutes", e.target.value)}
                      />
                    </WizField>
                  ) : null}
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
                  <WizField label={t("dev.wizard.pvcRetention")} hint={t("dev.wizard.pvcRetentionHint")}>
                    <Select
                      size="small"
                      fullWidth
                      data-od-id="wizard-pvc-retention"
                      value={draft.pvcRetention}
                      onChange={(e) => setField("pvcRetention", e.target.value as Draft["pvcRetention"])}
                    >
                      <MenuItem value="delete">{t("dev.wizard.pvcRetentionDelete")}</MenuItem>
                      <MenuItem value="retain">{t("dev.wizard.pvcRetentionRetain")}</MenuItem>
                    </Select>
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

                <WizSection odId="sec-runtime" title={t("dev.wizard.runtime")} badge="runtime.env / args / command">
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
                  <WizField label={t("dev.wizard.command")} hint={t("dev.wizard.commandHint")}>
                    <TextField
                      size="small"
                      fullWidth
                      data-od-id="wizard-command"
                      placeholder={t("dev.wizard.commandPh")}
                      value={draft.command}
                      onChange={(e) => setField("command", e.target.value)}
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

                <WizSection odId="sec-rdma" title={t("dev.wizard.rdma")} badge="network">
                  <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", py: "8px" }}>
                    <Box>
                      <Box sx={{ fontSize: 12.5 }}>{t("dev.wizard.rdmaEnabled")}</Box>
                      <Box sx={{ fontSize: 11, color: "text.secondary", mt: "2px" }}>{t("dev.wizard.rdmaHint")}</Box>
                    </Box>
                    <Switch size="small" checked={draft.rdmaEnabled} onChange={(e) => setField("rdmaEnabled", e.target.checked)} data-od-id="wizard-rdma" />
                  </Box>
                  {draft.rdmaEnabled ? (
                    <WizField label={t("dev.wizard.rdmaType")} hint={t("dev.wizard.rdmaTypeHint")}>
                      <Select size="small" value={draft.rdmaType} onChange={(e) => setField("rdmaType", e.target.value as Draft["rdmaType"])} data-od-id="wizard-rdma-type">
                        <MenuItem value="roce">RoCE</MenuItem>
                        <MenuItem value="infiniband">InfiniBand</MenuItem>
                      </Select>
                    </WizField>
                  ) : null}
                </WizSection>

                <WizSection odId="sec-ssh" title={t("dev.wizard.ssh")} badge="ssh">
                  <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", py: "8px" }}>
                    <Box>
                      <Box sx={{ fontSize: 12.5 }}>{t("dev.wizard.sshEnabled")}</Box>
                      <Box sx={{ fontSize: 11, color: "text.secondary", mt: "2px" }}>{t("dev.wizard.sshHint")}</Box>
                    </Box>
                    <Switch size="small" checked={draft.sshEnabled} onChange={(e) => toggleSsh(e.target.checked)} data-od-id="wizard-ssh" />
                  </Box>
                  {draft.sshEnabled ? (
                    <WizField label={t("dev.wizard.sshKeysSecret")} hint={t("dev.wizard.sshKeysSecretHint")}>
                      {sshSecretsLoading ? (
                        <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-od-id="wizard-ssh-keys-loading">
                          {t("dev.wizard.sshKeysLoading")}
                        </Typography>
                      ) : sshSecretsError ? (
                        <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-od-id="wizard-ssh-keys-error">
                          {t("dev.wizard.sshKeysError", { error: sshSecretsError })}
                        </Typography>
                      ) : sshSecrets.length === 0 ? (
                        <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-od-id="wizard-ssh-keys-empty">
                          {t("dev.wizard.sshKeysEmpty")}
                        </Typography>
                      ) : (
                        <>
                          <Select size="small" fullWidth value={draft.sshKeysSecret} onChange={(e) => changeSshSecret(e.target.value)} data-od-id="wizard-ssh-secret">
                            <MenuItem value="">{t("dev.wizard.sshKeysPlatform")}</MenuItem>
                            {sshSecrets.map((s) => (
                              <MenuItem key={s.name} value={s.name}>{s.name}</MenuItem>
                            ))}
                          </Select>
                          {draft.sshKeysSecret ? (
                            <WizField label={t("dev.wizard.sshKeysKey")} hint={t("dev.wizard.sshKeysKeyHint")}>
                              <Select size="small" value={draft.sshKeysKey} onChange={(e) => setField("sshKeysKey", e.target.value)} data-od-id="wizard-ssh-key">
                                {(sshSecrets.find((s) => s.name === draft.sshKeysSecret)?.keys ?? []).map((k) => (
                                  <MenuItem key={k} value={k}>{k}</MenuItem>
                                ))}
                              </Select>
                            </WizField>
                          ) : null}
                        </>
                      )}
                    </WizField>
                  ) : null}
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
        // Announced when it appears: a wizard step that refuses to advance has to
        // say why, and the helper text is the only thing that does.
        <Typography role="alert" data-od-id="field-error" sx={{ fontSize: 11.5, color: soft(STATUS_ERR, 75), fontWeight: 550, mt: "6px" }}>
          {errorText}
        </Typography>
      ) : hint ? (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: "6px" }}>{hint}</Typography>
      ) : null}
    </Box>
  );
}