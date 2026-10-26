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
  IconButton,
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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { DevEnvironmentSummary } from "@/app/api/devenvironments/route";
import type { DevEnvImageOption, DevEnvOptionsResponse } from "@/app/api/devenvironments/options/route";
import { validationMessage, type ValidationErrorBody } from "@/lib/api-error";
import { apiFetch, withBasePath } from "@/lib/base-path";
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
  // The environment the delete dialog is about, or null when it is closed.
  const [pendingDelete, setPendingDelete] = useState<DevEnvironmentSummary | null>(null);
  // The message of an action that failed, or null when none has. One slot for
  // start, stop and delete alike: only one action can be in flight at a time, so
  // a queue of them would be a queue of one.
  const [actionError, setActionError] = useState<string | null>(null);

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
        // Read what the wizard asked to select before clearing it: the updater
        // below runs at render, by which point the ref has long been nulled, so
        // reading it inside left the environment just created unselected.
        const justCreated = selectAfterLoad.current;
        selectAfterLoad.current = null;
        setSelKey((prev) => {
          if (justCreated && d.items.some((s) => envKey(s) === justCreated)) {
            return justCreated;
          }
          return prev && d.items.some((s) => envKey(s) === prev) ? prev : d.items[0] ? envKey(d.items[0]) : null;
        });
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
   * The row's click only marks the target. What deleting does to the workspace
   * is a sentence the user has to read before it happens, so the request waits
   * for the dialog's answer rather than firing under the prompt.
   */
  const runAction = (e: DevEnvironmentSummary, act: string) => {
    if (act === "stop") {
      patch({ namespace: e.namespace, name: e.name, running: false });
    } else if (act === "start") {
      patch({ namespace: e.namespace, name: e.name, running: true });
    } else if (act === "del") {
      setPendingDelete(e);
    }
  };

  /**
   * Delete the environment the dialog is about. It comes off the dialog's state
   * rather than the row's: the confirming click is the dialog's, and by the time
   * it fires the row it names may be behind a menu that has already closed.
   */
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { namespace, name } = pendingDelete;
    setPendingDelete(null);
    apiFetch("/api/devenvironments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace, name }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
        if (!res.ok) throw new Error(validationMessage(t, body, res.status, "dev"));
        load();
      })
      .catch((err: Error) => setActionError(err.message));
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
        .catch((err: Error) => setActionError(err.message));
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

            {/* The table carries the detail itself, under the row it belongs to,
                so a row click is a disclosure: a second click on the open row
                closes it again. */}
            <EnvTable
              items={visible}
              total={items.length}
              selectedKey={selected ? envKey(selected) : null}
              onSelect={(key) => setSelKey((prev) => (prev === key ? null : key))}
              onAct={runAction}
            />
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

      {/* Mounted only while there is something to delete, so the prompt cannot
          outlive the environment it names. */}
      {pendingDelete ? (
        <DeleteEnvDialog
          e={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}

      {actionError ? <ErrorDialog message={actionError} onClose={() => setActionError(null)} /> : null}
    </>
  );
}

/**
 * Deleting an environment asks first, in the console's own dialog rather than
 * the browser's. The prompt is not a courtesy: it is the only place the
 * workspace's fate is stated, and what it says depends on `pvcRetention`, which
 * is chosen once in the wizard and never shown again — so it names the
 * consequence for this environment rather than the field that decides it, and
 * the claim by the name the StatefulSet provisions (`workspace-<name>-0`), which
 * is how a retained workspace is found again once the environment is gone.
 *
 * The caller mounts it only while there is a target, so `open` is the mount.
 */
function DeleteEnvDialog({ e, onClose, onConfirm }: { e: DevEnvironmentSummary; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  const claim = `workspace-${e.name}-0`;
  const prompt = !e.storage
    ? t("dev.delete.confirm", { name: e.name })
    : e.storage.pvcRetention === "retain"
      ? t("dev.delete.confirmRetain", { name: e.name, size: e.storage.size, claim })
      : t("dev.delete.confirmDelete", { name: e.name, size: e.storage.size, claim });
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth data-od-id="delete-dialog">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("dev.delete.title")}</DialogTitle>
      <DialogContent dividers>
        <Typography data-od-id="delete-prompt" sx={{ fontSize: 13, lineHeight: 1.8, color: "text.secondary" }}>
          {prompt}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: "24px", py: "14px" }}>
        <Button data-od-id="delete-cancel" onClick={onClose} sx={{ textTransform: "none", fontSize: 12.5 }}>
          {t("dev.delete.cancel")}
        </Button>
        <Button
          data-od-id="delete-confirm"
          variant="contained"
          disableElevation
          color="error"
          onClick={onConfirm}
          sx={{ textTransform: "none", fontSize: 12.5 }}
        >
          {t("dev.act.delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * An action that failed, said in the console's own dialog rather than the
 * browser's alert — the message is the API's, and where it lands should be the
 * console's too. One button, because there is nothing to decide: the action did
 * not happen, and the row behind this dialog is unchanged.
 *
 * The caller mounts it only while there is a message, so `open` is the mount.
 */
function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth data-od-id="error-dialog">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("dev.error.title")}</DialogTitle>
      <DialogContent dividers>
        <Typography data-od-id="error-message" sx={{ fontSize: 13, lineHeight: 1.8, color: "text.secondary" }}>
          {message}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: "24px", py: "14px" }}>
        <Button
          data-od-id="error-close"
          variant="contained"
          disableElevation
          onClick={onClose}
          sx={{ textTransform: "none", fontSize: 12.5 }}
        >
          {t("dev.error.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── environment table ────────────────────────────────────────────────────────

/** The disclosure arrow a row carries: it turns as the row opens, so the table
 *  says which row holds the open detail without reading the panel. */
function Caret({ open }: { open: boolean }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        display: "inline-flex",
        flex: "none",
        color: open ? "var(--accent-strong)" : "var(--muted)",
        transition: "transform .16s ease",
        transform: open ? "rotate(90deg)" : "none",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </Box>
  );
}

function EnvTable({
  items,
  total,
  selectedKey,
  onSelect,
  onAct,
}: {
  items: DevEnvironmentSummary[];
  /** How many environments exist before the filter: the table is empty because
   *  nothing matched only when the filter is not why, and the two say so
   *  differently. */
  total: number;
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
            {items.flatMap((e) => {
              const sel = envKey(e) === selectedKey;
              // The accelerator cell: "2 × nvidia · H200", or the no-accelerator
              // label when the environment carries no spec.resources.gpu block.
              // The model is appended only when one was pinned — an environment
              // that left it open says so by saying nothing.
              const gpu = e.resources.gpu;
              const gpuText = gpu
                ? `${gpu.count} × ${gpu.vendor === "metax" ? "metax" : "GPU"}${gpu.model ? ` · ${gpu.model}` : ""}`
                : t("dev.gpu.none");
              const row = (
                <tr
                  key={envKey(e)}
                  data-od-id={`dev-row-${e.name}`}
                  tabIndex={0}
                  aria-selected={sel}
                  // The row discloses the detail below it rather than pointing at
                  // a column beside the table, so its open state is announced the
                  // way a disclosure's is.
                  aria-expanded={sel}
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
                      <Caret open={sel} />
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
                    <RowActions e={e} onAct={onAct} open={sel} />
                  </td>
                </tr>
              );
              if (!sel) return [row];
              // The detail, in the table rather than in a column beside it: the
              // panel keeps the environment's own row in view while it is read,
              // and its row stays outside the `dev-row-` family the table counts.
              return [
                row,
                <tr key={`${envKey(e)}/detail`} data-od-id={`dev-detail-${e.name}`}>
                  <td
                    colSpan={6}
                    style={{ padding: 0, background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
                  >
                    <Box sx={{ p: "18px 20px 20px" }}>
                      <DetailPanel e={e} onAct={onAct} />
                    </Box>
                  </td>
                </tr>,
              ];
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tdSx, textAlign: "center", borderBottom: 0 }}>
                  <Box sx={{ py: "20px", fontSize: 13, color: "text.secondary" }}>
                    {total === 0 ? t("dev.empty") : t("dev.filter.none")}
                  </Box>
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
 * A row's actions. Start and stop follow from the phase rather than the type:
 * a Running environment can only be stopped, since its work is live; a Stopped
 * one can be started again. Deleting is outside that gate — it is offered in
 * every phase, including the ones the console does not know (an empty phase, a
 * Failed one), because an environment a user can see is one they must be able to
 * remove: a phase allowlist would otherwise leave a stuck object that no console
 * action can reach, and the storage behind it unreclaimable too.
 *
 * A closed row keeps them behind a kebab, where they cost one column and the
 * table stays a table. The open row has the width to lay them out, so it does
 * (`open`). The menu is a MUI `Menu` rather than the prototype's absolutely
 * positioned box: the table sits in a scroll container, which would clip a menu
 * laid out inside it.
 */
function RowActions({ e, onAct, open }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void; open: boolean }) {
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
  // Worn by a button whether it is drawn flat or in the menu, so the two
  // layouts cannot drift apart on what each action is styled as.
  const flatSx = {
    minWidth: 0,
    px: "10px",
    py: "3px",
    fontSize: 12,
    textTransform: "none",
    whiteSpace: "nowrap",
    borderColor: "divider",
    bgcolor: "background.paper",
  } as const;
  // The row is open, so its actions are laid out in it: a menu the user has to
  // open to reach a button the open row has room to show is a click that buys
  // nothing.
  if (open) {
    return (
      <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex", gap: "6px" }}>
        {canStop ? (
          <Button size="small" variant="outlined" data-od-id={`act-stop-${e.name}`} onClick={() => run("stop")} sx={flatSx}>
            {t("dev.act.stop")}
          </Button>
        ) : null}
        {canStart ? (
          <Button size="small" variant="outlined" data-od-id={`act-start-${e.name}`} onClick={() => run("start")} sx={flatSx}>
            {t("dev.act.start")}
          </Button>
        ) : null}
        <Button
          size="small"
          variant="outlined"
          data-od-id={`act-del-${e.name}`}
          onClick={() => run("del")}
          sx={{ ...flatSx, color: STATUS_ERR, borderColor: soft(STATUS_ERR, 55), "&:hover": { borderColor: STATUS_ERR, bgcolor: soft(STATUS_ERR, 10) } }}
        >
          {t("dev.act.delete")}
        </Button>
      </Box>
    );
  }
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
          sx={{ ...itemSx, color: STATUS_ERR, "&:hover": { bgcolor: soft(STATUS_ERR, 10), color: STATUS_ERR } }}
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

function Kvs({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    // Two columns of rows, filled left to right: with the card this wide a single
    // column would set every value the width of the table away from its label.
    // The dashed rule separates rows within a column, so it starts on the second
    // grid row rather than the second item.
    <Box
      sx={{
        px: "18px",
        py: "4px",
        display: "grid",
        gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
        columnGap: "28px",
      }}
    >
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
            ...(i >= 2 ? { borderTop: "1px dashed var(--border)" } : {}),
          }}
        >
          <Box component="span" sx={{ color: "text.secondary", flex: "none" }}>{k}</Box>
          <Box component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "right", overflowWrap: "anywhere", whiteSpace: "pre-line" }}>{v}</Box>
        </Box>
      ))}
    </Box>
  );
}

/** An endpoint address is a link when it is one, and text when it is not. */
function isLink(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * The Copy affordance every connection row ends with: idle → copied → idle, or
 * idle → failed, which stays long enough to be read and to be retried by hand —
 * the clipboard is unavailable on the plain-HTTP deployment this serves, so a
 * silent no-op is the one outcome a copy button may not have.
 *
 * `value` is a string for what the row already holds (an endpoint address) and a
 * function for what has to be fetched first (the token); returning null from the
 * latter means the fetch failed and its message is already on the row.
 */
function CopyButton({ value }: { value: string | (() => Promise<string | null>) }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <Button
      disableRipple
      onClick={async () => {
        const text = typeof value === "string" ? value : await value();
        if (text === null) return;
        const ok = await copyText(text);
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
  );
}

/** The shell every connection row is drawn in: a label above a monospace box. */
const CONN_ROW_SX = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "text.secondary",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  px: "9px",
  py: "5px",
  overflow: "hidden",
} as const;

const CONN_VALUE_SX = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
} as const;

function EndpointRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      {/* Endpoint names are lowercase DNS labels in the CR ("jupyter"); the row
          shows one as a name, so it is capitalised here rather than in the data. */}
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px", textTransform: "capitalize" }}>{label}</Typography>
      <Box sx={CONN_ROW_SX}>
        {/* The address is the thing the user came for, and a Jupyter URL they
            have to select, copy and paste themselves is a step that only exists
            because the row was text. Deep-linking to the container's own UI is
            the point of publishing the endpoint; the copy button stays for the
            cases a link cannot serve (a terminal, a notebook client config). */}
        {isLink(value) ? (
          <Box
            component="a"
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            data-od-id="endpoint-link"
            sx={{ ...CONN_VALUE_SX, color: "var(--accent-strong)", textDecoration: "none", "&:hover": { textDecoration: "underline" } }}
          >
            {value}
          </Box>
        ) : (
          <Box component="span" sx={CONN_VALUE_SX}>{value}</Box>
        )}
        <CopyButton value={value} />
      </Box>
    </Box>
  );
}

// Twelve bullets, whatever the value's length: the mask says "there is a secret
// here" and says nothing about how long it is.
const SECRET_MASK = "•".repeat(12);

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
      {open ? null : <path d="M4 20 20 4" />}
    </svg>
  );
}

/**
 * The environment's own Jupyter token, masked until the user asks for it.
 *
 * The card used to print the `kubectl` command that reads the Secret, which asks
 * the user to hold cluster access the console already has. The value is fetched
 * only when it is asked for — reveal or copy — so a credential is not pulled into
 * the page (and into a screenshot) for every environment the user clicks past,
 * and a failed read leaves its reason on the row instead of an empty box.
 */
function TokenRow({
  name,
  namespace,
  secret,
}: {
  name: string;
  namespace: string;
  secret: { name: string; namespace: string };
}) {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<string | null> => {
    if (token !== null) return token;
    setBusy(true);
    try {
      const res = await apiFetch(
        `/api/devenvironments/token?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
      );
      const body = (await res.json().catch(() => ({}))) as ValidationErrorBody & { token?: string };
      if (!res.ok || !body.token) {
        setError(validationMessage(t, body, res.status, "dev"));
        return null;
      }
      setToken(body.token);
      setError(null);
      return body.token;
    } catch {
      // The route's own sentence for this: from the user's side a request that
      // never arrived and a read that failed are the same thing to retry.
      setError(t("dev.err.tokenUnreadable"));
      return null;
    } finally {
      setBusy(false);
    }
  }, [name, namespace, t, token]);

  return (
    <Box>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{t("dev.conn.token")}</Typography>
      <Box sx={CONN_ROW_SX}>
        <Box component="span" data-od-id="token-value" sx={{ ...CONN_VALUE_SX, color: error ? STATUS_ERR : "text.secondary" }}>
          {error ?? (revealed && token !== null ? token : SECRET_MASK)}
        </Box>
        <IconButton
          data-od-id="token-toggle"
          aria-label={revealed ? t("dev.conn.tokenHide") : t("dev.conn.tokenReveal")}
          aria-pressed={revealed}
          disabled={busy}
          onClick={async () => {
            if (revealed) {
              setRevealed(false);
              return;
            }
            // The mask stays if the token could not be read: the row says why.
            if (token === null && (await load()) === null) return;
            setRevealed(true);
          }}
          sx={{ p: 0, width: 20, height: 20, color: "var(--accent-strong)", "&:hover": { background: "transparent" } }}
        >
          <EyeIcon open={revealed} />
        </IconButton>
        <CopyButton value={load} />
      </Box>
      {/* Named where it lives, because rotating it is a `kubectl delete secret`
          away and the card is where the user finds out which one. */}
      <Typography data-od-id="token-secret" sx={{ fontSize: 11, color: "text.secondary", mt: "6px" }}>
        {t("dev.conn.tokenSecret", { name: `${secret.namespace}/${secret.name}` })}
      </Typography>
    </Box>
  );
}

// The ssh endpoint the operator publishes as ssh://user@host:port (the host
// bracketed when it is an IPv6 address) — split here so the card can state the
// login command instead of asking the user to reassemble it from the endpoint.
function sshParts(address: string): { user: string; host: string; port: string } | null {
  const m = /^ssh:\/\/([^@\/]+)@(\[[^\]]+\]|[^:\/]+):(\d+)$/.exec(address);
  if (!m) return null;
  return { user: m[1], host: m[2].replace(/^\[|\]$/g, ""), port: m[3] };
}

// A value as a POSIX shell single-quoted word. A minted key is base64 PEM and
// never holds a quote, but a hand-edited Secret could, so a quote is closed,
// escaped and reopened rather than trusted.
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// One command the user can paste into a shell: it writes the key to a private
// temporary file, logs in with it, and removes the file on the way out, so the
// key never has to be saved first. `printf '%s\n'` rather than echo: the key is
// carried verbatim, and echo's handling of backslashes varies between shells.
// The whole sequence runs in a subshell: the pasted line lands in the user's
// interactive shell, and a bare `exit` would close it — on a failed login too,
// before the error could be read — and would leave `tmp`/`rc` set.
function sshCommand(key: string, parts: { user: string; host: string; port: string }): string {
  return (
    `(tmp=$(mktemp) && chmod 600 "$tmp" && printf '%s\\n' ${shQuote(key)} > "$tmp" && ` +
    `ssh -i "$tmp" -p ${parts.port} ${shQuote(`${parts.user}@${parts.host}`)}; ` +
    `rc=$?; rm -f "$tmp"; exit "$rc")`
  );
}

// The SSH endpoint and the private half of the keypair the operator minted for
// it, in one block: the address, then the two ways to reach it with the key. The
// download is a plain link — the session cookie authorizes the route, and the
// Secret the key comes from is derived server-side from the environment's own
// status, so the href cannot be turned into a read of an arbitrary Secret.
//
// The second shape is one paste-ready command that embeds the key and cleans up
// after itself, for the user who has nowhere to keep a file. It is fetched only
// when asked for, and masked until then like the token: the line contains the
// key, so the card treats it as part of the credential.
function SshKeyRow({
  name,
  namespace,
  address,
  label,
}: {
  name: string;
  namespace: string;
  address: string;
  label: string;
}) {
  const { t } = useI18n();
  const [command, setCommand] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parts = sshParts(address);
  // The command the downloaded key is used with: the file is the fixed target of
  // the download above, so only user, host and port vary.
  const login = parts
    ? t("dev.conn.sshLoginCommand", { user: parts.user, host: parts.host, port: parts.port })
    : address;

  const load = async (): Promise<string | null> => {
    if (command !== null) return command;
    const target = sshParts(address);
    if (!target) return null;
    setBusy(true);
    try {
      const res = await apiFetch(
        `/api/devenvironments/ssh-key?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
        setError(validationMessage(t, body, res.status, "dev"));
        return null;
      }
      const built = sshCommand(await res.text(), target);
      setCommand(built);
      setError(null);
      return built;
    } catch {
      // The route's own sentence for this: from the user's side a request that
      // never arrived and a read that failed are the same thing to retry.
      setError(t("dev.err.keyUnreadable"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    // The card's own grid is two columns; this block spans both and lays its
    // two halves out the same way, so the endpoint and the command that logs in
    // with it sit side by side rather than stacked.
    <Box sx={{ gridColumn: { lg: "1 / -1" } }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "repeat(2, minmax(0, 1fr))" },
          columnGap: "28px",
          rowGap: "14px",
          alignItems: "start",
        }}
      >
        <Box>
          <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px", textTransform: "uppercase" }}>{label}</Typography>
          <Box sx={CONN_ROW_SX}>
            {/* The command and the key that opens it belong on one line: the user
                arrived here to log in, and the link beside it is how they get the
                key that command names. */}
            <Box component="span" data-od-id="ssh-endpoint" sx={CONN_VALUE_SX}>{login}</Box>
            {/* A plain link, not a fetch: the session cookie authorizes the route
                and the browser saves the file. The base path is the deployment's,
                so the href goes through withBasePath as every hand-addressed URL does. */}
            <Box
              component="a"
              data-od-id="ssh-key-download"
              href={withBasePath(`/api/devenvironments/ssh-key?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`)}
              sx={{ flex: "none", color: "var(--accent-strong)", textDecoration: "none", "&:hover": { textDecoration: "underline" } }}
            >
              {t("dev.conn.sshKeyDownload")}
            </Box>
            <CopyButton value={login} />
          </Box>
          {/* Stated when the endpoint could be read: without user/host/port the
              command is a guess, and a guess in a credential card is worse than
              none. chmod first — ssh refuses a key any other local user can read. */}
          {parts ? (
            <Typography data-od-id="ssh-key-hint" sx={{ fontSize: 11, color: "text.secondary", mt: "6px" }}>
              {t("dev.conn.sshKeyHint")}
            </Typography>
          ) : null}
        </Box>
        {/* The same key without the download step. */}
        {parts ? (
          <Box>
            <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{t("dev.conn.sshCommand")}</Typography>
            <Box sx={CONN_ROW_SX}>
              <Box
                component="span"
                data-od-id="ssh-command-value"
                sx={{
                  ...CONN_VALUE_SX,
                  color: error ? STATUS_ERR : "text.secondary",
                  // The key makes this several lines; they wrap inside the row
                  // rather than stretching the card.
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 140,
                  overflowY: "auto",
                }}
              >
                {error ?? (revealed && command !== null ? command : SECRET_MASK)}
              </Box>
              <IconButton
                data-od-id="ssh-command-toggle"
                aria-label={revealed ? t("dev.conn.sshCommandHide") : t("dev.conn.sshCommandReveal")}
                aria-pressed={revealed}
                disabled={busy}
                onClick={async () => {
                  if (revealed) {
                    setRevealed(false);
                    return;
                  }
                  // The mask stays if the key could not be read: the row says why.
                  if (command === null && (await load()) === null) return;
                  setRevealed(true);
                }}
                sx={{ p: 0, width: 20, height: 20, color: "var(--accent-strong)", "&:hover": { background: "transparent" } }}
              >
                <EyeIcon open={revealed} />
              </IconButton>
              <CopyButton value={load} />
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function ConnectionCard({ e, onAct }: { e: DevEnvironmentSummary; onAct: (e: DevEnvironmentSummary, act: string) => void }) {
  const { t } = useI18n();
  const sshEndpoint = e.endpoints.find((ep) => ep.name === "ssh");
  if (e.phase === "Running" && e.endpoints.length > 0) {
    return (
      <Card title={t("dev.conn.title")} meta={t("dev.conn.meta")}>
        {/* One column per row rather than a column of rows: an address and the
            token that opens it are read together, and side by side neither is
            pushed under the other when one of them wraps. */}
        <Box
          sx={{
            px: "18px",
            py: "14px",
            display: "grid",
            gridTemplateColumns: { xs: "1fr", lg: "repeat(2, minmax(0, 1fr))" },
            columnGap: "28px",
            rowGap: "14px",
            alignItems: "start",
          }}
        >
          {/* The ssh endpoint and its key are one block, so the generic endpoint
              row stands aside when the key row renders: two boxes would say the
              same address twice. */}
          {e.endpoints
            .filter((ep) => !(e.sshClientKeySecret && sshEndpoint && ep.name === sshEndpoint.name))
            .map((ep) => (
              <EndpointRow key={ep.name} label={ep.name} value={ep.address} />
            ))}
          {/* Reaching a jupyter environment needs its token, so the card carries
              the token itself — masked until asked for, read from the Secret the
              environment's own status names. */}
          {e.type === "jupyter" && e.jupyterTokenSecret ? (
            // Keyed by environment: the detail panel is the same component for
            // whichever row is selected, and without this a token revealed for
            // one environment would stay revealed — showing the previous
            // environment's credential — when the next row is clicked.
            <TokenRow key={`${e.namespace}/${e.name}`} name={e.name} namespace={e.namespace} secret={e.jupyterTokenSecret} />
          ) : null}
          {/* The minted client keypair is published as the private half's Secret
              name, and only for environments the user did not key with their
              own — so its presence is what earns the download row. */}
          {e.sshClientKeySecret && sshEndpoint ? (
            <SshKeyRow
              key={`${e.namespace}/${e.name}-ssh-key`}
              name={e.name}
              namespace={e.namespace}
              address={sshEndpoint.address}
              label={sshEndpoint.name}
            />
          ) : null}
        </Box>
        {/* Said only when it is true of this environment: the idle clause used to
            be part of the guide, so an environment created with the timeout
            disabled still claimed an expiry on the same screen that showed
            "disabled". */}
        {e.idleTimeout > 0 ? (
          <Typography sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.7, px: "18px", pb: "14px" }}>
            {t("dev.conn.idle", { minutes: String(Math.round(e.idleTimeout / 60)) })}
          </Typography>
        ) : null}
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
  const rows: Array<[string, ReactNode]> = [
    [t("dev.spec.type"), e.type],
    [t("dev.spec.image"), e.image],
    [t("dev.spec.gpu"), gpu ? `${gpu.count} × ${gpu.vendor}${gpu.model ? ` · ${gpu.model}` : ""}` : t("dev.gpu.none")],
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
    // Always shown, unlike the rows below: every environment is in one of the two
    // states, so a row naming only the unusual one would leave the common case
    // looking unconfigured rather than restricted. The restricted value carries a
    // "(default)" marker so the row never reads as a choice the user made — and it
    // is the state that explains an install which raised nothing and failed later
    // on a missing import.
    [t("dev.spec.egress"), e.egressUnrestricted ? t("dev.spec.egressUnrestricted") : t("dev.spec.egressRestricted")],
  ];
  // Only what the environment actually states: four rows of "nothing configured"
  // on every environment would drown the ones that do configure something.
  if (Object.keys(e.nodeSelector).length) {
    // The map verbatim rather than assuming kubernetes.io/hostname: an environment
    // pinned by hand with other labels is still pinned, and the panel's job is to
    // say where it will land, not where the wizard would have put it.
    rows.push([t("dev.spec.nodeSelector"), Object.entries(e.nodeSelector).map(([k, v]) => `${k}=${v}`).join(" · ")]);
  }
  if (e.volumes.length) {
    rows.push([
      t("dev.spec.volumes"),
      e.volumes
        .map((v) => `${v.pvcName} → ${v.mountPath}${v.readOnly ? ` (${t("dev.spec.readOnly")})` : ""}`)
        .join(" · "),
    ]);
  }
  if (e.env.length) {
    // The variables themselves are one block per environment: the list that
    // produced this panel deliberately does not carry literal values, so the
    // block fetches them for this environment when it opens.
    rows.push([t("dev.spec.env"), <EnvValues key="env" e={e} />]);
  }
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
    </Card>
  );
}

/**
 * spec.runtime.env, one variable per line, with literal values shown as they are.
 *
 * The environment list is cluster-wide and carries only names (and valueFrom
 * sources): a literal value can be a credential, so it is fetched for this one
 * environment when its detail opens. A valueFrom is shown by its source — the
 * value itself lives in a Secret or ConfigMap, not in the CR.
 */
function EnvValues({ e }: { e: DevEnvironmentSummary }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nothing to fetch when every entry is a reference: there are no literals.
  const hasLiteral = e.env.some((v) => v.hasValue);
  // One request per mounted row. React's development StrictMode runs every
  // effect twice (mount, simulated unmount, mount); sharing the in-flight
  // promise keeps the second run from issuing another read — and lets the
  // second run still apply the first one's answer, which a per-run
  // cancellation flag alone would discard.
  const requestRef = useRef<Promise<{ values: Record<string, string> } | { error: string }> | null>(null);

  useEffect(() => {
    if (!hasLiteral) return;
    if (requestRef.current === null) {
      requestRef.current = apiFetch(
        `/api/devenvironments/env-values?namespace=${encodeURIComponent(e.namespace)}&name=${encodeURIComponent(e.name)}`,
      )
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as ValidationErrorBody & { values?: Record<string, string> };
          if (!res.ok || !body.values) {
            return { error: validationMessage(t, body, res.status, "dev") };
          }
          return { values: body.values };
        })
        .catch(() => ({ error: t("dev.err.envUnreadable") }));
    }
    let cancelled = false;
    void requestRef.current.then((result) => {
      if (cancelled) return;
      if ("values" in result) {
        setValues(result.values);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
    // `t` is rebuilt on every render by useI18n; the fetch is keyed to the
    // environment alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLiteral, e.namespace, e.name]);

  return (
    <Box sx={{ display: "grid", justifyItems: "end", gap: "2px", minWidth: 0 }}>
      {error ? (
        <Box component="span" data-od-id="env-values-error" sx={{ color: STATUS_ERR }}>{error}</Box>
      ) : null}
      <Box component="span" data-od-id="env-values" sx={{ whiteSpace: "pre-line", overflowWrap: "anywhere", textAlign: "right" }}>
        {e.env
          .map((v) => {
            if (v.valueFrom) return `${v.name} → ${v.valueFrom}`;
            // A literal's value arrives with the fetch above; until it lands,
            // name the variable alone rather than pretending it is empty.
            const value = values?.[v.name];
            return value === undefined ? v.name : `${v.name}=${value}`;
          })
          .join("\n")}
      </Box>
    </Box>
  );
}

/**
 * The environment's conditions, in their own section rather than under the spec
 * rows: what the object *is* and what it is *doing* are read for different
 * reasons, and the status is what a failing environment is diagnosed from.
 */
function StatusCard({ e }: { e: DevEnvironmentSummary }) {
  const { t } = useI18n();
  return (
    <Card title={t("dev.status.title")} meta={t("dev.status.meta")}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: "8px", px: "18px", py: "12px" }}>
        {e.conditions.length === 0 ? (
          <Typography data-od-id="env-conds-empty" sx={{ fontSize: 12, color: "text.secondary" }}>{t("dev.cond.empty")}</Typography>
        ) : (
          // One line per condition, pill first: the pill already names the
          // condition and states its status, so the object's own sentence about
          // it follows on the same line instead of in a second list keyed by
          // type. Every condition is listed, not only the ones that are False —
          // a True one's sentence is the controller saying what it did, and
          // reading them in order is how a half-converged environment (routes
          // published, pod not scheduled) is told from a working one.
          e.conditions.map((c) => {
            // Green only for an observed True condition; False (a real failure
            // or an expected non-ready state like a stopped Ready) and Unknown
            // (pending) get distinct non-success styling.
            // Progressing is inverted: False means the controller has nothing
            // in flight — the settled, healthy state — so it reads as success.
            const cls =
              c.type === "Progressing" && c.status === "False"
                ? "ok"
                : c.status === "True"
                  ? "ok"
                  : c.status === "Unknown"
                    ? "pending"
                    : "err";
            const [chip, dot] =
              cls === "ok"
                ? [STATUS_OK, STATUS_OK]
                : cls === "pending"
                  ? [STATUS_WARN, STATUS_WARN]
                  : [soft(STATUS_ERR, 55), STATUS_ERR];
            // The reason stays off the line: the pill names the condition
            // already, and for most of them the reason repeats it ("Accepted",
            // "Scheduled"). It is still on the hover, beside the message.
            const detail = [c.reason ? `(${c.reason})` : "", c.message].filter(Boolean).join(" ");
            return (
              <Box key={c.type} sx={{ fontSize: 12, color: "text.secondary", lineHeight: 2 }}>
                <Box
                  data-od-id={`cond-${c.type}`}
                  component="span"
                  title={detail ? `${c.type} ${c.status} ${detail}` : undefined}
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    px: "9px",
                    py: "2px",
                    mr: "5px",
                    borderRadius: 999,
                    fontSize: 12,
                    verticalAlign: "middle",
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
                {/* A condition with no message has nothing to add to its pill,
                    and an empty ": " would read as a message that failed to
                    arrive. */}
                {c.message ? (
                  <Box component="span" data-od-id={`cond-note-${c.type}`}>{`: ${c.message}`}</Box>
                ) : null}
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
    // One card per row: the panel spans the table, so side by side each card got
    // half of it. Stacked they get the whole width, and the two columns are drawn
    // inside each card instead, around the rows themselves.
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "14px",
        minWidth: 0,
      }}
    >
      <ConnectionCard e={e} onAct={onAct} />
      <SpecCard e={e} />
      <StatusCard e={e} />
    </Box>
  );
}

// ── create wizard ────────────────────────────────────────────────────────────

// A DNS-1035 label: the name is the environment's Service name, which must
// start with a letter. Mirrored from the create route and the operator's
// admission policy (config/vap/devenvironment_policy.yaml).
const DNS_LABEL_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
// The namespace select's "create a new one" entry. A name cannot carry an
// underscore (the API server takes a DNS-1123 label), so it can never collide
// with a namespace the cluster has, and it is never sent anywhere: `create()`
// resolves it to the name the user typed before the request is built.
const NEW_NAMESPACE = "__new__";
// A Namespace's name is a DNS-1123 label, which is looser than the DNS-1035 rule
// the environment's own name obeys: it may start with a digit.
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
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
// spec.nodeSelector's value, which is a node's own name — mirrored from the
// create route, which writes it as the node's kubernetes.io/hostname label. The
// select only ever offers names the cluster advertised, so this guards a
// hand-edited request rather than the ordinary path.
const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const NODE_NAME_MAX = 63;

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
  // spec.resources.gpu.model, in the vendor's own spelling — the value its
  // device plugin writes to the node label. "" is "any": the absence of the
  // field, not an empty model (which the CRD rejects at MinLength 1).
  gpuModel: string;
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
  // spec.runtime.sudo: passwordless sudo for the container's non-root account.
  // Off by default; a root container already has the privilege, so the grant is
  // neither offered nor sent when runAsRoot is on.
  sudo: boolean;
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
  // spec.network: RDMA access, and what the environment may reach on its own
  // behalf. rdmaEnabled gates the RDMA half; rdmaType names the fabric,
  // defaulting to roce (the CRD default). egressUnrestricted is the other half
  // and opens on the CRD's default of restricted. A fabric no node advertises
  // does not fail the write — the environment stays Pending — so the choice is
  // offered with a hint rather than hidden.
  rdmaEnabled: boolean;
  rdmaType: "roce" | "infiniband";
  egressUnrestricted: boolean;
  // spec.nodeSelector, as the one node the wizard pins to. "" is "let the
  // scheduler decide", which is the absence of the field rather than an empty
  // label: the route writes the pin as the node's kubernetes.io/hostname label,
  // and only the nodes the cluster advertised are ever offered, so the choice
  // cannot name a node that does not exist.
  nodeName: string;
  // spec.ssh: independent of the environment's type. sshEnabled opens the SSH
  // endpoint on any type (a jupyter + ssh environment); sshKeys holds the
  // user's own public keys, one per line — non-empty, the route writes them to
  // a <name>-ssh-user-keys Secret the operator mounts as authorized_keys.
  // Empty means "let the operator mint a keypair" (the default), whose private
  // half the user then downloads from the connection card.
  sshEnabled: boolean;
  sshKeys: string;
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
    gpuModel: "",
    cpu: "2",
    memory: "4Gi",
    // The smallest workspace the route accepts, not the largest: a claim is
    // provisioned at its full size up front, and 200Gi is 200Gi of the cluster
    // spent on a wizard nobody has edited yet. The field is editable, and the
    // summary step states the size before it is created.
    storageGi: 20,
    pvcRetention: "delete",
    idle: 0,
    idleCustom: false,
    idleMinutes: "",
    runAsRoot: false,
    sudo: false,
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
    egressUnrestricted: false,
    // "Let the scheduler decide" — the pin is the environment stating a node, and
    // opening on one would be the wizard placing the pod on the user's behalf.
    nodeName: "",
    sshEnabled: false,
    sshKeys: "",
  });
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

  // The select offers `default` plus "create a new one": the tenant namespaces
  // the platform does not manage are not listed, because a denylist of the ones
  // it does manage was always one install behind (issue #367). A namespace the
  // user names here is created first, then the environment is created in it.
  const [newNamespace, setNewNamespace] = useState(false);
  const [newNamespaceName, setNewNamespaceName] = useState("");
  const [namespaceError, setNamespaceError] = useState(false);
  const newNamespaceValid = !newNamespace || NAMESPACE_RE.test(newNamespaceName.trim());
  const effectiveNamespace = newNamespace ? newNamespaceName.trim() : draft.namespace;

  const changeNamespace = (namespace: string) => {
    if (namespace === NEW_NAMESPACE) {
      setNewNamespace(true);
      return;
    }
    setNewNamespace(false);
    setNamespaceError(false);
    setDraft((prev) => ({ ...prev, namespace }));
  };

  // The SSH toggle: turning it on opens the public-key input; turning it off
  // clears what was typed, so a toggle the user changed their mind about leaves
  // no half-finished keys behind.
  const toggleSsh = (enabled: boolean) => {
    setDraft((prev) => ({
      ...prev,
      sshEnabled: enabled,
      ...(enabled ? {} : { sshKeys: "" }),
    }));
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

  // Changing the vendor changes which models are on offer, so the pin is cleared
  // rather than left naming a card of the vendor the user moved away from — a
  // pairing the operator could never schedule, since the label and the model
  // always have to describe one vendor.
  const setAccelerator = (accelerator: Draft["accelerator"]) =>
    setDraft((prev) => (prev.accelerator === accelerator ? prev : { ...prev, accelerator, gpuModel: "" }));

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
    (e) => e.namespace === effectiveNamespace && e.name === draft.name.trim(),
  );
  const nameValid = DNS_LABEL_RE.test(draft.name.trim()) && draft.name.trim().length > 0;
  const step1Valid = nameValid && !nameTaken && !!effectiveNamespace && newNamespaceValid && !!draft.image;
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

  // spec.nodeSelector's value. The select only ever offers names the cluster
  // advertised, so this guards a hand-edited draft rather than the ordinary path —
  // an empty one is "let the scheduler decide" and states nothing to check.
  const nodeNameValid =
    !draft.nodeName || (draft.nodeName.length <= NODE_NAME_MAX && NODE_NAME_RE.test(draft.nodeName));

  const [mountPathError, setMountPathError] = useState(false);
  const [pvcError, setPvcError] = useState(false);
  const [envError, setEnvError] = useState(false);
  const [portError, setPortError] = useState(false);
  const [nodeNameError, setNodeNameError] = useState(false);
  const step3Valid =
    accountValid && uidGidValid && mountPathValid && pvcRowsValid && envRowsValid && portRowsValid && nodeNameValid;

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
        setNamespaceError(!effectiveNamespace || !newNamespaceValid);
        return;
      }
      setNameError(false);
      setImageError(false);
      setNamespaceError(false);
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
      setNodeNameError(!nodeNameValid);
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
    setNodeNameError(!nodeNameValid);
    setNamespaceError(!effectiveNamespace || !newNamespaceValid);
    if (!step1Valid || !step2Valid || !step3Valid) return;
    setCreateBusy(true);
    setCreateError(null);
    const body = {
      namespace: effectiveNamespace,
      name: draft.name.trim(),
      type: draft.type,
      image: draft.image.trim(),
      accelerator: draft.accelerator,
      // A card count is only meaningful with an accelerator: sending the stale
      // default alongside "none" would describe a GPU the user did not ask for.
      ...(gpuRequested ? { gpuCount: draft.gpuCount } : {}),
      // A model is sent only when one was pinned. "Any" is the absence of the
      // field rather than an empty string, which is a model the CRD rejects.
      ...(gpuRequested && draft.gpuModel ? { gpuModel: draft.gpuModel } : {}),
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
            // The grant follows the container's non-root account; a root
            // environment already has the privilege and states nothing.
            ...(draft.sudo ? { sudo: true } : {}),
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
      // spec.network, both leaves independently: asking for RDMA never states an
      // egress policy and opening egress never states RDMA. Off, each is absent —
      // the one spelling of the CRD's own defaults.
      ...(draft.rdmaEnabled ? { rdmaEnabled: true, rdmaType: draft.rdmaType } : {}),
      ...(draft.egressUnrestricted ? { egressUnrestricted: true } : {}),
      // spec.nodeSelector, sent only when a node was picked: "any" is the absence
      // of the field rather than an empty selector, which selects nothing.
      ...(draft.nodeName ? { nodeName: draft.nodeName } : {}),
      // spec.ssh: sent only when SSH is on (independent of type). The user's own
      // public keys are included only when some are pasted; otherwise the
      // operator mints a keypair for the environment.
      ...(draft.sshEnabled
        ? {
            sshEnabled: true,
            ...(draft.sshKeys.trim() ? { sshKeys: draft.sshKeys.trim() } : {}),
          }
        : {}),
    };
    // The namespace first, then the environment in it: the wizard no longer
    // offers a tenant namespace, so the one the user names here may not exist
    // yet. The route answers 200 for one that does, which is what lets the same
    // field deploy into an existing tenant namespace by name.
    (newNamespace
      ? apiFetch("/api/namespaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: effectiveNamespace }),
        }).then(async (res) => {
          if (res.ok) return;
          const data = (await res.json().catch(() => ({}))) as ValidationErrorBody;
          throw new Error(validationMessage(t, data, res.status, "dev"));
        })
      : Promise.resolve()
    )
      .then(() =>
        apiFetch("/api/devenvironments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ValidationErrorBody & { name?: string };
        if (!res.ok) throw new Error(validationMessage(t, data, res.status, "dev"));
        onCreated(effectiveNamespace, data.name ?? draft.name.trim());
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

  // The models the chosen vendor's device plugin advertises on this cluster.
  // Empty when it advertises none — or when the options read could not list the
  // nodes, which the select handles the same way, by offering "any" alone.
  const gpuModels = draft.accelerator === "none" ? [] : (options?.gpuModels?.[draft.accelerator] ?? []);

  // The nodes the cluster advertised, in the options route's own order. Empty for
  // the same two reasons as gpuModels — a cluster with nothing to offer, and a
  // best-effort read that failed — and the select offers "any" alone either way,
  // so an empty list reads as "the scheduler decides" rather than as an error.
  const nodes = options?.nodes ?? [];

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
    [t("dev.wizard.namespace"), effectiveNamespace],
    [t("dev.wizard.type"), draft.type],
    [t("dev.wizard.image"), draft.image],
    [t("dev.wizard.accelerator"), gpuRequested ? `${draft.gpuCount} × ${draft.accelerator}${draft.gpuModel ? ` · ${draft.gpuModel}` : ""}` : t("dev.wizard.accelerator.none")],
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
        : `${t("dev.wizard.identityValue", { user: effectiveUser, uid: effectiveUid, gid: effectiveGid })}${draft.sudo ? " · sudo" : ""}`,
    ],
  ];
  // Only what the user actually stated: a list of empty rows would bury the
  // handful of fields they set.
  if (mountPath) summaryRows.push([t("dev.wizard.mountPath"), mountPath]);
  if (filledPvcs.length) {
    summaryRows.push([t("dev.wizard.pvcs"), filledPvcs.map((r) => `${r.pvcName.trim()} → ${r.mountPath.trim()}`).join(" · ")]);
  }
  // Name and value, the same pair the user typed in the runtime section — a
  // bare name would not say enough to confirm what is about to be created.
  if (filledEnvs.length) {
    summaryRows.push([t("dev.wizard.envs"), filledEnvs.map((r) => `${r.name.trim()}=${r.value}`).join(" · ")]);
  }
  if (draft.command.trim()) summaryRows.push([t("dev.wizard.command"), draft.command.trim()]);
  if (draft.args.trim()) summaryRows.push([t("dev.wizard.args"), draft.args.trim()]);
  if (filledPorts.length) {
    summaryRows.push([t("dev.wizard.ports"), filledPorts.map((r) => `${r.name.trim()}:${r.port.trim()}/${r.type}`).join(" · ")]);
  }
  if (draft.rdmaEnabled) {
    summaryRows.push([t("dev.wizard.rdma"), draft.rdmaType === "roce" ? "RoCE" : "InfiniBand"]);
  }
  if (draft.egressUnrestricted) {
    summaryRows.push([t("dev.wizard.egress"), t("dev.wizard.egressUnrestricted")]);
  }
  if (draft.nodeName) summaryRows.push([t("dev.wizard.placement"), draft.nodeName]);
  if (draft.sshEnabled) {
    summaryRows.push([
      t("dev.wizard.ssh"),
      draft.sshKeys.trim()
        ? t("dev.wizard.sshKeysProvided", { n: draft.sshKeys.split("\n").filter((l) => l.trim()).length })
        : t("dev.wizard.sshKeysPlatform"),
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
                <WizField
                  label={t("dev.wizard.namespace")}
                  error={namespaceError}
                  errorText={t("dev.wizard.errNamespaceName")}
                >
                  <Select
                    size="small"
                    fullWidth
                    data-od-id="wizard-namespace"
                    value={newNamespace ? NEW_NAMESPACE : draft.namespace}
                    onChange={(e) => changeNamespace(e.target.value)}
                  >
                    {options.namespaces.map((n) => (
                      <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
                    ))}
                    <MenuItem value={NEW_NAMESPACE} data-od-id="wizard-namespace-new">
                      {t("dev.wizard.namespaceNew")}
                    </MenuItem>
                  </Select>
                  {newNamespace && (
                    <TextField
                      size="small"
                      fullWidth
                      autoFocus
                      data-od-id="wizard-namespace-name"
                      value={newNamespaceName}
                      onChange={(e) => setNewNamespaceName(e.target.value)}
                      placeholder={t("dev.wizard.namespaceNewPh")}
                      sx={{ mt: "8px" }}
                    />
                  )}
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
                    <Select size="small" fullWidth value={draft.accelerator} onChange={(e) => setAccelerator(e.target.value as Draft["accelerator"])}>
                      <MenuItem value="none">{t("dev.wizard.accelerator.none")}</MenuItem>
                      <MenuItem value="nvidia">nvidia</MenuItem>
                      <MenuItem value="metax">metax</MenuItem>
                    </Select>
                  </WizField>
                  {/* Both of the other accelerator fields exist only once one is
                      wanted: "none" has no card count and no model, and showing
                      them disabled would suggest a choice the spec ignores.

                      The model is a closed list of what this cluster's nodes
                      actually advertise, plus "any" — the absence of the field,
                      which is what leaves the environment free to land on any
                      node offering the vendor's card. It stays on offer when the
                      list is empty, because "any" is then the only honest answer
                      and hiding the field would make that indistinguishable from
                      a cluster that was never asked. */}
                  {gpuRequested ? (
                    <>
                      <WizField label={t("dev.wizard.gpuCount")} error={gpuError} errorText={t("dev.wizard.errGpu")}>
                        <TextField size="small" fullWidth type="number" inputProps={{ min: 1, max: 16 }} value={draft.gpuCount} onChange={(e) => setField("gpuCount", Number(e.target.value))} />
                      </WizField>
                      <WizField label={t("dev.wizard.gpuModel")}>
                        {/* `displayEmpty` because "" is a real choice here — the
                            "any" entry — and without it the box would render
                            blank, which reads as a field nobody filled in. */}
                        <Select size="small" fullWidth displayEmpty data-od-id="wizard-gpu-model" value={draft.gpuModel} onChange={(e) => setField("gpuModel", e.target.value)}>
                          <MenuItem value="">{t("dev.wizard.gpuModel.any")}</MenuItem>
                          {gpuModels.map((m) => (
                            <MenuItem key={m} value={m}>{m}</MenuItem>
                          ))}
                        </Select>
                      </WizField>
                    </>
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
                  <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", py: "8px" }}>
                    <Box>
                      <Box sx={{ fontSize: 12.5 }}>{t("dev.wizard.sudo")}</Box>
                      <Box sx={{ fontSize: 11, color: "text.secondary", mt: "2px" }}>{t("dev.wizard.sudoHint")}</Box>
                    </Box>
                    <Switch
                      size="small"
                      checked={draft.sudo}
                      disabled={draft.runAsRoot}
                      onChange={(e) => setField("sudo", e.target.checked)}
                      data-od-id="wizard-sudo"
                    />
                  </Box>
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

                <WizSection odId="sec-egress" title={t("dev.wizard.egress")} badge="network">
                  <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", py: "8px" }}>
                    <Box>
                      <Box sx={{ fontSize: 12.5 }}>{t("dev.wizard.egressEnabled")}</Box>
                      <Box sx={{ fontSize: 11, color: "text.secondary", mt: "2px" }}>{t("dev.wizard.egressHint")}</Box>
                    </Box>
                    <Switch
                      size="small"
                      checked={draft.egressUnrestricted}
                      onChange={(e) => setField("egressUnrestricted", e.target.checked)}
                      data-od-id="wizard-egress"
                    />
                  </Box>
                </WizSection>

                <WizSection odId="sec-placement" title={t("dev.wizard.placement")} badge="nodeSelector">
                  <WizField
                    label={t("dev.wizard.nodeSelector")}
                    hint={t("dev.wizard.nodeSelectorHint")}
                    error={nodeNameError}
                    errorText={t("dev.wizard.errNodeName")}
                  >
                    <Select
                      size="small"
                      fullWidth
                      // The "any" option's value is "", so without this MUI renders a
                      // blank select rather than the option's own label.
                      displayEmpty
                      data-od-id="wizard-node"
                      value={draft.nodeName}
                      onChange={(e) => setField("nodeName", e.target.value)}
                    >
                      <MenuItem value="">{t("dev.wizard.nodeSelectorAny")}</MenuItem>
                      {nodes.map((n) => (
                        // The node's accelerators beside its name, so a pin can be
                        // chosen with the environment's own accelerator in view:
                        // pinning a CPU node under a GPU request is a pod no node
                        // can run, and it reports nothing but Pending.
                        <MenuItem key={n.name} value={n.name}>
                          {n.vendors.length ? `${n.name} · ${n.vendors.join(" / ")}` : n.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </WizField>
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
                    <WizField label={t("dev.wizard.sshKeys")} hint={t("dev.wizard.sshKeysHint")}>
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        minRows={3}
                        maxRows={10}
                        data-od-id="wizard-ssh-keys"
                        placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
                        sx={{ "& .MuiInputBase-input": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5 } }}
                        value={draft.sshKeys}
                        onChange={(e) => setField("sshKeys", e.target.value)}
                      />
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