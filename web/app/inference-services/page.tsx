"use client";

// 推理服务 (Inference Services) — rebuilt from the static prototype
// (web/public/inference-services.html) against the live cluster. Every value
// comes from /api/inferenceservices, which reads the operator's InferenceService
// and InferenceRuntimeProfile CRs directly; the prototype is only the visual
// reference, never a data source. The scale panel edits the real override knobs
// (decodeReplicas / prefillReplicas / groupSize) via a PATCH. Metrics are
// best-effort Prometheus data and show an empty state when absent.

import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Menu, MenuItem, Select, Switch, TextField, Typography, Stepper, Step, StepLabel } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CreateOptionsResponse } from "@/app/api/inferenceservices/options/route";
import type { InferenceServiceSummary } from "@/app/api/inferenceservices/route";
import { validationMessage, type ValidationErrorBody } from "@/lib/api-error";
import { apiFetch } from "@/lib/base-path";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/lib/i18n";
import { AIGATEWAY_ROUTER_PRIVATE, AIGATEWAY_ROUTER_PUBLIC, CATALOG_PATHS, type AIGatewayRouter, type CatalogPath } from "@/lib/inference-routes";
import { platformPalette, usePlatformTheme } from "@/lib/perses/theme";

// The prototype's filter set is 全部 / Ready / 准备中. "准备中" is a service the
// platform is still working on; a Failed one is not preparing, and is reached
// through 全部. The predicate itself is at the filter below.
type Filter = "all" | "ready" | "progressing";

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

/** Phase → chip colours, mirroring the dev-environments page. */
function statusInfo(phase: string | null): { dot: string; bg: string } {
  if (phase === "Ready") return { dot: STATUS_OK, bg: soft(STATUS_OK) };
  if (phase === "Failed") return { dot: STATUS_ERR, bg: soft(STATUS_ERR, 12) };
  return { dot: STATUS_WARN, bg: soft(STATUS_WARN) };
}

function StatusChip({ phase }: { phase: string | null }) {
  const { t } = useI18n();
  const c = statusInfo(phase);
  // A phase this console does not know yet is shown as it came rather than
  // mapped onto one of the four, so a newer controller reads as itself.
  const label =
    phase === "Ready" || phase === "Progressing" || phase === "Pending" || phase === "Failed"
      ? t(`inf.phase.${phase as "Ready"}`)
      : phase ?? "—";
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

// GPU facts per role. The API projects them from the profile; fixtures that
// predate the field fall back to the single gpuPerPod/gpuModel pair.
const gpuRoleFacts = (s: InferenceServiceSummary) =>
  s.gpuRoles.length > 0
    ? s.gpuRoles
    : s.gpuPerPod
      ? [{ name: "", gpuPerPod: s.gpuPerPod, model: s.gpuModel }]
      : [];

const gpuAmountText = (gpuPerPod: number, model: string | null): string =>
  `${gpuPerPod} × ${model ?? "GPU"}`;

// The list's GPU resource column: the service's whole footprint. Roles asking
// for the same cards on the same model collapse into one product — a PD
// service whose prefill and decode each take 8 MXC550 reads "2 × 8 × MXC550" —
// while roles on different models or card counts are listed per role.
const gpuText = (s: InferenceServiceSummary): string => {
  const roles = gpuRoleFacts(s);
  if (roles.length === 0) return "—";
  const [first] = roles;
  const uniform = roles.every((r) => r.gpuPerPod === first.gpuPerPod && r.model === first.model);
  if (!uniform) {
    return roles.map((r) => `${roleLabel(r.name)} ${gpuAmountText(r.gpuPerPod, r.model)}`).join(" · ");
  }
  return roles.length > 1
    ? `${roles.length} × ${gpuAmountText(first.gpuPerPod, first.model)}`
    : gpuAmountText(first.gpuPerPod, first.model);
};

// The detail card's per-replica row: one entry per GPU role, since each role is
// its own workload.
const gpuPerRoleText = (s: InferenceServiceSummary): string => {
  const roles = gpuRoleFacts(s);
  if (roles.length === 0) return "—";
  if (roles.length === 1) return gpuAmountText(roles[0].gpuPerPod, roles[0].model);
  return roles.map((r) => `${roleLabel(r.name)} ${gpuAmountText(r.gpuPerPod, r.model)}`).join(" · ");
};

// One row per integer override the profile declares (decodeReplicas /
// prefillReplicas / groupSize on a PD profile, whatever a standard profile
// declares), so no knob name is hardcoded and the column reads clearly
// instead of one crammed line.
function ReplicaRows({ s }: { s: InferenceServiceSummary }) {
  const rows = s.overrides
    .filter((o) => o.type === "integer")
    .map((o) => [o.name, overrideDisplayName(o.name), o.current !== null ? String(o.current) : "—"] as const);
  if (rows.length === 0) {
    return <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>—</Typography>;
  }
  return (
    <Box sx={{ fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7 }}>
      {rows.map(([name, label, value]) => (
        <Box key={name} sx={{ whiteSpace: "nowrap" }}>
          {label} <Typography component="span" sx={{ color: "text.secondary" }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  );
}

// QPS is a rate, not a count: a service handling a few requests a minute is
// well below 1/s, and rounding it to an integer would render as "0" — reading
// as no traffic at all. Keep two decimals below 1 and round above it.
const qpsFmt = (n: number | null): string =>
  n === null ? "—" : n > 0 && n < 1 ? n.toFixed(2) : String(Math.round(n));

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
  // The delete flow: the row names the target, the row's dialog confirms it, and
  // a failure lands in a dialog of its own.
  const [pendingDelete, setPendingDelete] = useState<InferenceServiceSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // After a successful deploy, select the just-created service on the next
  // reload (the ref is consumed by load()). Holds the composite namespace/name
  // key so a same-named service in another namespace cannot steal the selection.
  const selectAfterLoad = useRef<string | null>(null);

  const load = useCallback(() => {
    apiFetch("/api/inferenceservices")
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

  // The detail panel's node pickers list the same schedulable nodes as the
  // deploy wizard: the value a pin carries is kubernetes.io/hostname=<node>,
  // so users pick a node rather than composing the label pair. Best-effort —
  // when the read fails (or the principal may not list nodes) the picker
  // keeps its free-text input, which still accepts the pair by hand.
  const [nodes, setNodes] = useState<CreateOptionsResponse["nodes"]>([]);
  useEffect(() => {
    apiFetch("/api/inferenceservices/options")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: CreateOptionsResponse) => setNodes(d.nodes ?? []))
      .catch(() => setNodes([]));
  }, [reloadKey]);

  const selected = items.find((s) => svcKey(s) === selKey) ?? null;

  const visible = items.filter((s) => {
    if (filter === "ready") return s.phase === "Ready";
    // 准备中 is "not settled": neither ready nor given up on. A service the
    // controller has not reached a verdict on yet carries no phase at all
    // (the API spells Pending as an absent field, like a null ready did
    // before), and it is certainly still preparing — so it belongs here too,
    // and no row is ever hidden from every filtered tab.
    if (filter === "progressing") return s.phase !== "Ready" && s.phase !== "Failed";
    return true;
  });

  const handleApply = useCallback(
    (overrides: Record<string, OverrideValue>) => {
      if (!selected) return;
      setScaleMsg(null);
      setScaleErr(null);
      setScaleBusy(true);
      apiFetch("/api/inferenceservices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: selected.namespace, name: selected.name, overrides }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
          if (!res.ok) throw new Error(validationMessage(t, body, res.status, "inf"));
          setScaleMsg(t("inf.scale.applied"));
          load();
        })
        .catch((err: Error) => setScaleErr(err.message))
        .finally(() => setScaleBusy(false));
    },
    [selected, load, t],
  );

  /**
   * Delete the service the dialog is about. It comes off the dialog's state
   * rather than the row's: the confirming click is the dialog's, and by the time
   * it fires the row it named may be behind a menu that has already closed.
   */
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { namespace, name } = pendingDelete;
    setPendingDelete(null);
    apiFetch("/api/inferenceservices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace, name }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ValidationErrorBody;
        if (!res.ok) throw new Error(validationMessage(t, body, res.status, "inf"));
        load();
      })
      .catch((err: Error) => setActionError(err.message));
  };

  return (
    <>
    <Box sx={{ p: "26px 28px 64px", width: "100%", mx: "auto" }}>
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
                  ["progressing", t("inf.filter.progressing")],
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

          {/* Only the table: the detail is disclosed inside it, under the row
              it belongs to, so there is no second column to give it. Clicking
              the open row closes it again. */}
          <ServiceTable
            items={visible}
            total={items.length}
            selectedKey={selected ? svcKey(selected) : null}
            onSelect={(key) => setSelKey((prev) => (prev === key ? null : key))}
            // The row's button only names the target; the dialog mounted below
            // asks. Deleting cannot be taken back, so the request waits for its
            // answer rather than firing under the click.
            onDelete={setPendingDelete}
            nodes={nodes}
            busy={scaleBusy}
            msg={scaleMsg}
            err={scaleErr}
            onApply={handleApply}
          />
        </>
      )}
    </Box>

    {pendingDelete ? (
      <DeleteServiceDialog
        s={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    ) : null}
    {actionError ? <ErrorDialog message={actionError} onClose={() => setActionError(null)} /> : null}

    <DeployWizard
      key={deployOpen ? "open" : "closed"}
      open={deployOpen}
      services={items}
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

/** The row's disclosure caret: it points at the detail, so it turns when the row is open. */
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

/**
 * The row's actions. A closed row keeps them behind a kebab, where they cost one
 * column and the table stays a table; the open row has the width to lay them out
 * in, so it does (`open`).
 *
 * Delete is the only one. An InferenceService has no start/stop to offer — the
 * profile's override knobs are the console's other handle on a service, and they
 * are edited in the panel the row opens onto rather than from the row.
 *
 * The menu is a MUI `Menu` rather than an absolutely positioned box, because the
 * table sits in a scroll container that would clip a menu laid out inside it.
 */
function RowActions({
  s,
  onDelete,
  open,
}: {
  s: InferenceServiceSummary;
  onDelete: (s: InferenceServiceSummary) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const itemSx = { fontSize: 12.5, fontWeight: 550, px: "11px", py: "7px", borderRadius: "6px" };
  // Worn by the button whether it is drawn flat or in the menu, so the two
  // layouts cannot drift apart on what the action is styled as.
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
  const run = () => {
    // Deleting removes the row — and with it the kebab MUI hands focus back to —
    // which would leave the closing dialog aria-hidden around a focused item.
    // Drop that focus first so there is nothing to hide.
    (document.activeElement as HTMLElement | null)?.blur();
    setAnchor(null);
    onDelete(s);
  };
  const dangerSx = {
    ...flatSx,
    color: STATUS_ERR,
    borderColor: soft(STATUS_ERR, 55),
    "&:hover": { borderColor: STATUS_ERR, bgcolor: soft(STATUS_ERR, 10) },
  };
  if (open) {
    return (
      <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex" }}>
        <Button size="small" variant="outlined" data-od-id={`act-del-${s.name}`} onClick={run} sx={dangerSx}>
          {t("inf.act.delete")}
        </Button>
      </Box>
    );
  }
  return (
    // The row itself is the selection control, so the kebab and its item must
    // not reach it: one click means one thing.
    <Box onClick={(ev) => ev.stopPropagation()} sx={{ display: "inline-flex" }}>
      <Button
        size="small"
        data-od-id={`svc-ops-${s.name}`}
        aria-label={t("inf.col.ops")}
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
        <MenuItem data-od-id={`act-del-${s.name}`} onClick={run} sx={{ ...itemSx, color: STATUS_ERR }}>
          {t("inf.act.delete")}
        </MenuItem>
      </Menu>
    </Box>
  );
}

function ServiceTable({
  items,
  total,
  selectedKey,
  onSelect,
  onDelete,
  nodes,
  busy,
  msg,
  err,
  onApply,
}: {
  items: InferenceServiceSummary[];
  total: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onDelete: (s: InferenceServiceSummary) => void;
  // The schedulable nodes the detail panel's node pickers offer.
  nodes: CreateOptionsResponse["nodes"];
  // The detail panel's own state, threaded straight through: the table is what
  // renders the panel, inside the row it belongs to.
  busy: boolean;
  msg: string | null;
  err: string | null;
  onApply: (overrides: Record<string, OverrideValue>) => void;
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
              <th style={{ ...thSx, textAlign: "right" }}>{t("inf.col.ops")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const sel = svcKey(s) === selectedKey;
              const row = (
                <tr
                  key={svcKey(s)}
                  data-od-id={`svc-row-${s.name}`}
                  tabIndex={0}
                  aria-selected={sel}
                  // The row discloses the detail below it rather than pointing at
                  // a block beside the table, so its open state is announced the
                  // way a disclosure's is.
                  aria-expanded={sel}
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
                    <Box sx={{ display: "flex", alignItems: "center", gap: "9px" }}>
                      <Caret open={sel} />
                      <Box sx={{ minWidth: 0 }}>
                        <Box sx={{ fontWeight: 600, fontSize: 13.5 }}>{s.name}</Box>
                        <Box sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", mt: "2px" }}>{s.namespace}</Box>
                      </Box>
                    </Box>
                  </td>
                  <td style={tdSx}>
                    <StatusChip phase={s.phase} />
                  </td>
                  <td style={tdSx}>{s.engine ?? "—"}</td>
                  <td style={{ ...tdSx, whiteSpace: "nowrap" }}>{gpuText(s)}</td>
                  <td style={tdSx}>
                    <ReplicaRows s={s} />
                  </td>
                  <td style={{ ...tdSx, fontFamily: "var(--font-mono)", fontSize: 12.5, whiteSpace: "nowrap" }}>
                    {s.metrics ? qpsFmt(s.metrics.qps) : "—"}
                  </td>
                  <td style={{ ...tdSx, fontFamily: "var(--font-mono)", fontSize: 12.5, whiteSpace: "nowrap" }}>
                    {s.metrics && s.metrics.p95 != null ? `${Math.round(s.metrics.p95)} ms` : "—"}
                  </td>
                  <td style={tdSx}>{s.modelRef}</td>
                  <td style={{ ...tdSx, textAlign: "right" }}>
                    <RowActions s={s} onDelete={onDelete} open={sel} />
                  </td>
                </tr>
              );
              if (!sel) return [row];
              // The detail, in the table rather than in a stack below it: the
              // panel keeps the service's own row in view while it is read, and
              // its row stays outside the `svc-row-` family the table counts.
              return [
                row,
                <tr key={`${svcKey(s)}/detail`} data-od-id={`svc-detail-${s.name}`}>
                  <td
                    colSpan={9}
                    style={{ padding: 0, background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
                  >
                    <Box sx={{ p: "18px 20px 20px" }}>
                      <DetailPanel s={s} nodes={nodes} busy={busy} msg={msg} err={err} onApply={onApply} />
                    </Box>
                  </td>
                </tr>,
              ];
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={9} style={{ ...tdSx, textAlign: "center", borderBottom: 0 }}>
                  <Box sx={{ py: "20px", fontSize: 13, color: "text.secondary" }}>
                    {total === 0 ? t("inf.empty") : t("inf.filter.none")}
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

/**
 * Deleting, asked in a dialog of the console's own. An InferenceService owns no
 * storage a user put there — the operator garbage-collects the workloads and the
 * route it created — so the prompt names what goes and nothing more.
 *
 * The caller mounts it only while there is a target, so `open` is the mount.
 */
function DeleteServiceDialog({ s, onClose, onConfirm }: { s: InferenceServiceSummary; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth data-od-id="delete-dialog">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("inf.delete.title")}</DialogTitle>
      <DialogContent dividers>
        <Typography data-od-id="delete-prompt" sx={{ fontSize: 13, lineHeight: 1.8, color: "text.secondary" }}>
          {t("inf.delete.confirm", { name: s.name })}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: "24px", py: "14px" }}>
        <Button data-od-id="delete-cancel" onClick={onClose} sx={{ textTransform: "none", fontSize: 12.5 }}>
          {t("inf.delete.cancel")}
        </Button>
        <Button
          data-od-id="delete-confirm"
          variant="contained"
          disableElevation
          color="error"
          onClick={onConfirm}
          sx={{ textTransform: "none", fontSize: 12.5 }}
        >
          {t("inf.act.delete")}
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
      <DialogTitle sx={{ fontSize: 15, fontWeight: 650 }}>{t("inf.error.title")}</DialogTitle>
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
          {t("inf.error.close")}
        </Button>
      </DialogActions>
    </Dialog>
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
  nodes,
  busy,
  msg,
  err,
  onApply,
}: {
  s: InferenceServiceSummary;
  nodes: CreateOptionsResponse["nodes"];
  busy: boolean;
  msg: string | null;
  err: string | null;
  onApply: (overrides: Record<string, OverrideValue>) => void;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
      {/* The three the row is opened to read: where the service answers, how it
          is doing, and what turns the knobs. One row of three equal widths, so
          they are compared at a glance instead of scrolled past. Below lg there
          is no width for a third column and they stack as they did before. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "repeat(3, minmax(0, 1fr))" },
          gap: "14px",
          // Stretched, not start-aligned: the three are read as a row, so they
          // end together — a card whose content is short leaves the space at the
          // bottom rather than letting its border stop short of its neighbours'.
        }}
      >
        <EndpointsCard s={s} />
        <MetricsCard s={s} />
        <ScaleCard s={s} nodes={nodes} busy={busy} msg={msg} err={err} onApply={onApply} />
      </Box>
      <ParamsCard s={s} />
      <ConditionsCard s={s} />
    </Box>
  );
}

function Card({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: "var(--radius)", bgcolor: "background.paper" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", px: "18px", py: "13px", borderBottom: 1, borderColor: "divider" }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, flex: "none" }}>{title}</Typography>
        {meta ? <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", textAlign: "right" }}>{meta}</Typography> : null}
      </Box>
      {children}
    </Box>
  );
}

function Kvs({ rows }: { rows: Array<[string, string]> }) {
  return (
    // Two columns of rows, filled left to right: with the card this wide a single
    // column would set every value the width of the table away from its label.
    // The dashed rule separates rows within a column, so it is absent from the
    // first grid row — and that is a different set of items per breakpoint, since
    // below lg the grid is one column and only the first item starts a row.
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
            borderTop: {
              xs: i === 0 ? "none" : "1px dashed var(--border)",
              lg: i < 2 ? "none" : "1px dashed var(--border)",
            },
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
  // A service published to the private catalog route is not reachable through
  // the platform's public listener. Its AI Gateway endpoint is therefore the
  // private gateway's in-cluster Service address, not the cluster's public
  // catalog host (`status.endpoint.public`, which the operator reports for
  // either route). The public route's address is the observed value; fall back
  // to "—" when it isn't published yet. The catalog host serves every published
  // model, so the model name that selects this service is shown alongside it.
  // The private address is discovered by the API route, not composed here: the
  // dataplane Service name carries a generated suffix.
  const isPrivate = s.aigatewayRouter === AIGATEWAY_ROUTER_PRIVATE;
  const gatewayLabel = isPrivate ? t("inf.endpoints.gatewayInternal") : t("inf.endpoints.public");
  const gateway = isPrivate ? (s.privateGatewayEndpoint ?? "—") : (s.publicEndpoint ?? "—");
  return (
    <Card title={t("inf.endpoints.title")}>
      {/* Stacked, not side by side: this card is a third of the panel's width
          now, and two addresses across it would ellipsise both. The track's
          minimum is 0, not the row's min-content: a long in-cluster gateway
          address is one unbreakable token, and an `auto` minimum sized the
          track past the card, pushing the copy button outside its border. */}
      <Box
        sx={{
          px: "18px",
          py: "14px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          rowGap: "14px",
          alignItems: "start",
        }}
      >
        <EndpointRow label={t("inf.endpoints.internal")} value={internal} />
        <EndpointRow
          label={gatewayLabel}
          value={gateway}
          hint={s.published && s.routeModelName ? t("inf.endpoints.publicModel", { model: s.routeModelName }) : undefined}
        />
      </Box>
    </Card>
  );
}

function EndpointRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { t } = useI18n();
  // idle → ✓ → idle, or idle → failed, which stays long enough to be read: the
  // Clipboard API does not exist on the plain-HTTP deployment this serves, so
  // "nothing happened" is not an outcome the button may report as success.
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  return (
    // No margin of its own: the grid that places these rows sets the gap, so
    // stacking and side by side are spaced by the same number.
    <Box>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mb: "8px" }}>{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", px: "9px", py: "5px", overflow: "hidden" }}>
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{value}</Box>
        {value !== "—" ? (
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
            {copied === "ok" ? "✓" : copied === "fail" ? t("dev.conn.copyFailed") : t("inf.endpoints.copy")}
          </Button>
        ) : null}
      </Box>
      {hint ? (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: "6px" }}>{hint}</Typography>
      ) : null}
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
          <Typography component="span" sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "text.secondary" }}>{qpsFmt(m.qps)}</Typography>
        </Box>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <Metric label={t("inf.metrics.qps")} value={qpsFmt(m.qps)} />
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

// OverrideValue is what an override input edits; stringList knobs (such as a
// per-role nodeSelector) carry an array rather than a scalar.
type OverrideValue = number | string | boolean | string[];

/** Splits a comma-joined stringList input into its entries. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// One row of the scale panel: renders the input matching the override type
// declared by the profile (integer number, integer enum select, string text,
// stringList comma-separated text or enum multi-select, boolean switch). A
// nodeSelector stringList renders the shared node picker instead of free text.
function ScaleInput({
  o,
  value,
  nodes,
  onChange,
}: {
  o: InferenceServiceSummary["overrides"][number];
  value: OverrideValue;
  /** The schedulable nodes a nodeSelector pin may name, as the wizard offers them. */
  nodes: CreateOptionsResponse["nodes"];
  onChange: (v: OverrideValue) => void;
}) {
  const { t } = useI18n();
  if (o.type === "boolean") {
    return <Switch checked={value === true} onChange={(e) => onChange(e.target.checked)} size="small" />;
  }
  if (o.type === "stringList") {
    const list = Array.isArray(value) ? value : [];
    const pinned = isNodeSelectorOverride(o) && nodes.length > 0 ? pinnedNodes(value) : null;
    if (pinned !== null) {
      // Keep a pinned node visible even when the cluster no longer offers it:
      // it is the service's current choice, and hiding it would render the
      // Select blank instead of letting the user change it.
      const offered = new Set(nodes.map((n) => n.name));
      const menu = [...pinned.filter((name) => !offered.has(name)), ...nodes.map((n) => n.name)];
      return (
        <Select
          multiple
          size="small"
          displayEmpty
          value={pinned}
          data-od-id={`scale-${o.name}`}
          onChange={(e) => onChange((e.target.value as string[]).map((name) => `${NODE_SELECTOR_KEY}=${name}`))}
          renderValue={(names) => (names.length > 0 ? names.join(", ") : t("inf.deploy.nodeAny"))}
          sx={{ width: "100%", fontSize: 13, fontFamily: "var(--font-mono)" }}
        >
          {menu.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </Select>
      );
    }
    if (o.enum !== null && o.enum.length > 0) {
      return (
        <Select
          multiple
          size="small"
          value={list}
          onChange={(e) => onChange(e.target.value as string[])}
          sx={{ width: "100%", fontSize: 13, fontFamily: "var(--font-mono)" }}
        >
          {o.enum.map((n) => (
            <MenuItem key={String(n)} value={String(n)}>
              {String(n)}
            </MenuItem>
          ))}
        </Select>
      );
    }
    return (
      <input
        value={list.join(",")}
        onChange={(e) => onChange(splitList(e.target.value))}
        style={{
          width: "100%",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "8px 10px",
          font: "inherit",
          fontSize: 13,
          background: "var(--bg)",
          color: "var(--fg)",
          outline: "none",
        }}
      />
    );
  }
  // A declared enum is a closed set whatever its type, so it renders as a
  // select — checked before the string/integer branches.
  if (o.enum !== null && o.enum.length > 0) {
    return (
      <Select value={value} size="small" onChange={(e) => onChange(e.target.value as number | string)} sx={{ width: "100%", fontSize: 13, fontFamily: "var(--font-mono)" }}>
        {o.enum.map((n) => (
          <MenuItem key={String(n)} value={n}>
            {String(n)}
          </MenuItem>
        ))}
      </Select>
    );
  }
  if (o.type === "string") {
    return (
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "8px 10px",
          font: "inherit",
          fontSize: 13,
          background: "var(--bg)",
          color: "var(--fg)",
          outline: "none",
        }}
      />
    );
  }
  return <NumberInput value={typeof value === "number" ? value : o.min ?? 1} min={o.min ?? undefined} max={o.max ?? undefined} onChange={onChange} />;
}

// Type/range/enum validity of a scale value against the profile declaration.
// A declared enum is closed for string overrides too, otherwise a string enum
// would accept any non-empty text and only be rejected by the API.
function scaleValueValid(o: InferenceServiceSummary["overrides"][number], v: OverrideValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (o.type === "boolean") return typeof v === "boolean";
  if (o.type === "stringList") {
    if (!Array.isArray(v) || !v.every((e) => typeof e === "string")) return false;
    return o.enum === null || v.every((e) => o.enum!.some((allowed) => allowed === e));
  }
  if (o.type === "string") {
    if (typeof v !== "string") return false;
    // An empty box is empty input — unless the profile declares "" as a value,
    // in which case empty is a state (the nodeSelector knob means "no node
    // selector" when empty) and must be settable back to it. The operator
    // trims the resolved value, so blank counts as empty here too.
    if (v.trim() === "") return o.default === "";
    return o.enum === null || o.enum.some((e) => e === v);
  }
  if (typeof v !== "number" || !Number.isInteger(v)) return false;
  if (o.enum !== null && !o.enum.some((e) => e === v)) return false;
  if (o.min !== null && v < o.min) return false;
  if (o.max !== null && v > o.max) return false;
  return true;
}

// Starting value for a scale input: the effective value, falling back to a
// declared enum entry (an enum select needs a value inside the set), then to a
// per-type default (mirrors the wizard's overrideValue).
function scaleInitial(o: InferenceServiceSummary["overrides"][number]): OverrideValue {
  if (o.current !== null) return o.current;
  if (o.type === "stringList") return [];
  if (o.enum !== null && o.enum.length > 0) return o.enum[0];
  if (o.type === "boolean") return true;
  if (o.type === "string") return "";
  return o.min ?? 1;
}

// The scale panel edits exactly the override knobs the profile declares (one
// input per knob) and submits them as a PATCH; nothing is hardcoded.
function ScaleCard({
  s,
  nodes,
  busy,
  msg,
  err,
  onApply,
}: {
  s: InferenceServiceSummary;
  nodes: CreateOptionsResponse["nodes"];
  busy: boolean;
  msg: string | null;
  err: string | null;
  onApply: (overrides: Record<string, OverrideValue>) => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, OverrideValue>>(() =>
    Object.fromEntries(s.overrides.map((o) => [o.name, scaleInitial(o)])),
  );

  // Re-sync local state when the selected service changes, or when its reported
  // values actually change (e.g. the controller applied a scale). Depends on
  // the service identity + a primitive snapshot of the effective values — NOT
  // on the `s` object reference (whose identity changes on every poll refresh)
  // — so a 30s poll refresh (same values) must not clobber in-progress edits.
  // exhaustive-deps is suppressed because the correct deps are the primitives,
  // not the enclosing `s` object. The snapshot serializes [name, value] tuples:
  // a "name=value;" join would collide for values containing ";" or "=" and
  // wrongly read edits as unchanged. It uses scaleInitial (not raw current) so
  // an unset knob reads "unchanged" at its displayed fallback.
  const currentValueKey = JSON.stringify(s.overrides.map((o) => [o.name, scaleInitial(o)]));
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    setValues(Object.fromEntries(s.overrides.map((o) => [o.name, scaleInitial(o)])));
  }, [s.namespace, s.name, currentValueKey]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // Effective value per declared knob: the local edit when present, else the
  // service's value or declared default (values can lag one render behind a
  // poll that changed the declared override set).
  const effective: Record<string, OverrideValue> = Object.fromEntries(
    s.overrides.map((o) => [o.name, values[o.name] ?? scaleInitial(o)]),
  );
  const invalid = s.overrides.some((o) => !scaleValueValid(o, effective[o.name]));
  const unchanged = JSON.stringify(s.overrides.map((o) => [o.name, effective[o.name]])) === currentValueKey;

  return (
    <Card title={t("inf.scale.title")} meta={t("inf.scale.hint")}>
      {s.overrides.length === 0 ? (
        <Box sx={{ px: "18px", py: "12px", fontSize: 12.5, color: "text.secondary" }}>{t("inf.scale.noOverrides")}</Box>
      ) : (
        <Box sx={{ px: "18px", py: "12px", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px", alignItems: "end" }}>
          {s.overrides.map((o) => (
            <Field key={o.name} label={overrideDisplayName(o.name)} error={!scaleValueValid(o, effective[o.name])}>
              <ScaleInput o={o} value={effective[o.name]} nodes={nodes} onChange={(v) => setValues((prev) => ({ ...prev, [o.name]: v }))} />
            </Field>
          ))}
        </Box>
      )}
      {err ? (
        <Box sx={{ px: "18px", pb: "8px", fontSize: 11.5, color: soft(STATUS_ERR, 70) }}>{err}</Box>
      ) : null}
      {msg ? (
        <Box sx={{ px: "18px", pb: "8px", fontSize: 11.5, color: "text.secondary" }}>{msg}</Box>
      ) : null}
      <Box sx={{ px: "18px", pb: "14px" }}>
        <Button variant="contained" disabled={busy || invalid || unchanged || s.overrides.length === 0} onClick={() => onApply(effective)} sx={{ textTransform: "none", fontSize: 12.5 }}>
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

function NumberInput({ value, min, max, onChange }: { value: number; min?: number; max?: number; onChange: (n: number) => void }) {
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
  // timeoutSeconds 0 is the "no total-duration cap" default, not a zero-second
  // budget; an absent field means the service predates the route contract.
  const timeout =
    s.timeoutSeconds === null
      ? "—"
      : s.timeoutSeconds === 0
        ? t("inf.params.timeoutNone")
        : `${s.timeoutSeconds}s`;
  const idleTimeout = s.idleTimeoutSeconds === null ? "—" : `${s.idleTimeoutSeconds}s`;
  // maxModelLen is normally left at the profile's default, so the declared
  // knob's effective value (user override, else default) is the value to show;
  // spec.overrides only carries it when the user set it explicitly.
  const declaredMaxLen = s.overrides.find((o) => o.name === "maxModelLen")?.current;
  const maxLenValue = typeof declaredMaxLen === "number" ? declaredMaxLen : s.overrideNums.maxModelLen;
  const maxLen = maxLenValue !== undefined ? String(maxLenValue) : "—";
  return (
    <Card title={t("inf.params.title")} meta={s.engine ?? "—"}>
      <Kvs
        rows={[
          [t("inf.params.engine"), s.engine ? `${s.engine} · ${s.engineVersion ?? ""}`.trim() : "—"],
          [t("inf.params.accelerator"), s.vendor ? `${s.vendor}${s.gpuModel ? ` / ${s.gpuModel}` : ""}` : "—"],
          [t("inf.params.gpuPerPod"), gpuPerRoleText(s)],
          ["modelRef", s.modelRef],
          ["profileRef", s.profileRef],
          [t("inf.params.route"), s.published ? `${t("inf.params.published")} ${s.routeModelName ?? ""}`.trim() : t("inf.params.unpublished")],
          [t("inf.params.timeout"), timeout],
          [t("inf.params.idleTimeout"), idleTimeout],
          [t("inf.params.maxModelLen"), maxLen],
        ]}
      />
    </Card>
  );
}

function ConditionsCard({ s }: { s: InferenceServiceSummary }) {
  const { t } = useI18n();
  return (
    <Card title={t("inf.conds.title")} meta={t("inf.conds.meta")}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: "8px", px: "18px", py: "12px" }}>
        {s.conditions.length === 0 ? (
          <Typography data-od-id="infsvc-conds-empty" sx={{ fontSize: 12, color: "text.secondary" }}>{t("inf.conds.empty")}</Typography>
        ) : (
          // One line per condition, pill first: the pill already names the
          // condition and states its status, so the object's own sentence about
          // it follows on the same line instead of in a second list keyed by
          // type. Every condition is listed, not only the ones that are False —
          // a True one's sentence is the controller saying what it did, and
          // reading them in order is how a half-converged service (routes
          // published, replicas not yet ready) is told from a working one.
          s.conditions.map((c) => {
            // Green only for an observed True condition; False (a real failure)
            // and Unknown (pending) get distinct non-success styling.
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
            // already, and for most of them the reason repeats it ("Ready",
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
// ── deploy wizard ──────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface DeployDraft {
  name: string;
  namespace: string;
  profileRef: string;
  modelRef: string;
  overrides: Record<string, OverrideValue>;
  // Publishing to the model catalog is mandatory, so the route is always set.
  aigatewayRouter: AIGatewayRouter;
  modelName: string;
  // The client paths the catalog entry exposes; publishing starts with all of
  // them selected, and the service must expose at least one.
  paths: CatalogPath[];
}

type OverrideDecl = CreateOptionsResponse["profiles"][number]["overrides"][number];

function DeployWizard({
  open,
  services,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** What exists now, for the name check step 1 makes against the namespace. */
  services: InferenceServiceSummary[];
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
    aigatewayRouter: AIGATEWAY_ROUTER_PRIVATE,
    modelName: "",
    paths: [...CATALOG_PATHS],
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
    apiFetch("/api/inferenceservices/options")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d: CreateOptionsResponse) => {
        if (cancelled) return;
        setOptions(d);
        setLoadError(null);
        setDraft((prev) => ({
          ...prev,
          // The API names the starting point — the platform's configured
          // namespace, else `default`. This used to prefer `project-a` by name
          // and otherwise take the first that sorts, which on a real install is
          // a platform namespace the user cannot deploy into.
          namespace: d.defaultNamespace ?? d.namespaces[0]?.name ?? "",
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
  // Each GPU role's vendor comes from the profile's per-role accelerator
  // (effective value: the role's own declaration, else profile-level). The
  // wizard is read-only: heterogeneous combinations are defined and tested in
  // the profile, never picked here.
  const roleVendor = (name: string): string | null =>
    profile?.roles.find((r) => r.name === name)?.vendor ?? profile?.vendor ?? null;
  // Effective allowed models of one role: its own accelerator, else the
  // profile-level one (the options projection already resolves this).
  const roleModels = (name: string): string[] =>
    profile?.roles.find((r) => r.name === name)?.models ?? profile?.models ?? [];
  // Model versions compatible with the selected profile (architecture + quant).
  const compatibleModels = (options?.modelversions ?? []).filter((mv) => {
    if (!profile) return true;
    const archOk = !profile.architectures.length || (mv.architecture && profile.architectures.includes(mv.architecture));
    const quantOk = !profile.quantizations.length || (mv.quantization && profile.quantizations.includes(mv.quantization));
    return archOk && quantOk;
  });

  const setField = <K extends keyof DeployDraft>(key: K, value: DeployDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  // The field's message promises an already-taken check, so it makes one: the
  // namespace's services are already in hand (the table behind this dialog renders
  // them). The same name in another namespace is a different service. Losing the
  // race is still the server's to report — it answers `nameTaken`.
  const nameTaken = services.some(
    (s) => s.namespace === draft.namespace && s.name === draft.name.trim(),
  );
  const nameValid = DNS_LABEL_RE.test(draft.name.trim());
  const step1Valid =
    nameValid && !nameTaken && draft.name.trim().length > 0 && !!draft.namespace && !!draft.profileRef;
  const step2Valid = !!draft.modelRef;

  // Default override value, or the declared default.
  const overrideValue = (o: OverrideDecl): OverrideValue => {
    const held = draft.overrides[o.name];
    if (held !== undefined) return held;
    if (Array.isArray(o.default)) return o.default;
    if (o.default !== null && o.default !== undefined) return o.default;
    // An enum select needs a value inside the declared set, otherwise MUI
    // reports an out-of-range value ("") on first render.
    if (o.type === "stringList") return [];
    if (o.enum !== null && o.enum.length > 0) return o.enum[0];
    if (o.type === "boolean") return true;
    if (o.type === "integer") return o.min ?? 1;
    return "";
  };

  // The GPU model the user picked: a profile pins its allowed models in
  // spec.accelerator.models and narrows them through an override (metax_model
  // for the metax profiles). The backend keeps the allowed models in a
  // nodeAffinity In term and narrows a nodeSelector to this value, so the
  // wizard shows the same choice beside the read-only vendor — otherwise
  // picking MXC500 would still display only "metax".
  const selectedGpuModel = profile
    ? (profile.overrides
        .map((o) => overrideValue(o))
        .find((v): v is string => typeof v === "string" && profile.models.includes(v)) ?? null)
    : null;

  // A role may narrow the choice through its own override, named
  // `<role>_<vendor>_model` (the PD profiles declare prefill_metax_model and
  // decode_metax_model so the two roles can run on different GPU models).
  // Fall back to the profile-wide choice when the role has no scoped override.
  const selectedRoleGpuModel = (name: string): string | null => {
    const models = roleModels(name);
    if (!profile) return null;
    const scoped = profile.overrides
      .filter((o) => o.name.startsWith(`${name}_`) && o.name.endsWith("_model"))
      .map((o) => overrideValue(o))
      .find((v): v is string => typeof v === "string" && models.includes(v));
    if (scoped !== undefined) return scoped;
    return selectedGpuModel && models.includes(selectedGpuModel) ? selectedGpuModel : null;
  };

  // "metax / MXC500" when a model is known, otherwise just the vendor (and
  // "—" when neither is known).
  const gpuTypeLabel = (vendor: string | null, model: string | null): string =>
    [vendor, model].filter(Boolean).join(" / ") || "—";

  // PD profiles declare a knob once per GPU role (prefill_metax_model /
  // decode_metax_model, prefill_nodeSelector / decode_nodeSelector). Render
  // those as one column per role and one row per knob, so the two roles' values
  // line up however the profile lists them; overrides outside the role
  // prefixes keep the plain two-column grid above the role grid.
  const roleOverrides = (() => {
    if (!profile) return null;
    const roles = (profile.roles ?? [])
      .map((r) => r.name)
      .filter((name) => profile.overrides.some((o) => o.name.startsWith(`${name}_`)));
    if (roles.length < 2) return null;
    const owner = (o: OverrideDecl): string | null =>
      roles.find((name) => o.name.startsWith(`${name}_`)) ?? null;
    const cells = new Map<string, Map<string, OverrideDecl>>();
    const suffixes: string[] = [];
    for (const o of profile.overrides) {
      const role = owner(o);
      if (!role) continue;
      const suffix = o.name.slice(role.length + 1);
      if (!cells.has(role)) cells.set(role, new Map());
      cells.get(role)!.set(suffix, o);
      if (!suffixes.includes(suffix)) suffixes.push(suffix);
    }
    return {
      roles,
      // One row per knob suffix, one cell per role; a role that does not
      // declare the knob gets an empty cell so the columns stay aligned.
      rows: suffixes.map((suffix) => roles.map((role) => cells.get(role)?.get(suffix) ?? null)),
      rest: profile.overrides.filter((o) => owner(o) === null),
    };
  })();

  // The node picker offers only nodes that can run the GPU model chosen for
  // the role the selector applies to: the operator schedules by both the
  // hostname pin and the model constraint, so a pin to a node labelled with
  // another model is a Pod that can only stay Pending. A service-level
  // selector applies to every role, so its node must satisfy all of them.
  const nodeMatchesSelectedModel = (
    decl: OverrideDecl,
    node: CreateOptionsResponse["nodes"][number],
  ): boolean => {
    if (!profile) return true;
    const scopedRole = decl.name.endsWith("_nodeSelector")
      ? decl.name.slice(0, -"_nodeSelector".length)
      : null;
    const roles = scopedRole ? [scopedRole] : (profile.roles ?? []).map((r) => r.name);
    if (roles.length === 0) {
      return !selectedGpuModel || !profile.vendor || node.gpuModels?.[profile.vendor] === selectedGpuModel;
    }
    return roles.every((name) => {
      const model = selectedRoleGpuModel(name);
      if (!model) return true;
      const vendor = roleVendor(name);
      return !vendor || node.gpuModels?.[vendor] === model;
    });
  };

  const allNodes = options?.nodes ?? [];
  const overrideInput = (o: OverrideDecl) => (
    <OverrideInput
      key={o.name}
      decl={o}
      value={overrideValue(o)}
      nodes={allNodes.filter((n) => nodeMatchesSelectedModel(o, n))}
      anyNodes={allNodes.length > 0}
      onChange={(v) => setDraft((prev) => ({ ...prev, overrides: { ...prev.overrides, [o.name]: v } }))}
    />
  );

  const next = () => {
    if (step === 1) {
      if (!step1Valid) {
        setNameError(!nameValid || nameTaken);
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
    const body = {
      namespace: draft.namespace,
      name: draft.name.trim(),
      profileRef: draft.profileRef,
      modelRef: draft.modelRef,
      overrides: draft.overrides,
      route: { aigatewayRouter: draft.aigatewayRouter, modelName: draft.modelName.trim(), paths: draft.paths },
    };
    apiFetch("/api/inferenceservices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ValidationErrorBody & { name?: string };
        if (!res.ok) throw new Error(validationMessage(t, data, res.status, "inf"));
        onCreated(draft.namespace, data.name ?? draft.name.trim());
      })
      .catch((err: Error) => setCreateError(err.message))
      .finally(() => setCreateBusy(false));
  };

  // Step-3 summary line for the GPU type: one entry per GPU role in
  // pd-separation mode, a single vendor otherwise. The vendor is the role's
  // effective accelerator from the profile (read-only, see GpuTypeSelect); the
  // model is the role-scoped accelerator-model override the user picked,
  // falling back to the profile-wide one, when it narrows that role's allowed
  // models.
  const gpuSummary = !profile
    ? "—"
    : profile.servingMode === "pd-separation"
      ? `${roleLabel("prefill")}: ${gpuTypeLabel(roleVendor("prefill"), selectedRoleGpuModel("prefill"))} / ${roleLabel("decode")}: ${gpuTypeLabel(roleVendor("decode"), selectedRoleGpuModel("decode"))}`
      : gpuTypeLabel(profile.vendor, selectedGpuModel);

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
                    onChange={(e) => {
                      const name = e.target.value;
                      setDraft((prev) => ({
                        ...prev,
                        name,
                        // Publishing is always on, and the catalog needs a model
                        // name. The service name is the natural default — it
                        // already satisfies the catalog name contract (a DNS
                        // label). A model name the user typed is never
                        // overwritten.
                        modelName: prev.modelName === "" || prev.modelName === prev.name ? name : prev.modelName,
                      }));
                    }}
                    placeholder="e.g. dsv4-flash-serve"
                  />
                </WizField>
                <WizField label={t("inf.deploy.namespace")}>
                  <Select size="small" fullWidth data-od-id="deploy-namespace" value={draft.namespace} onChange={(e) => setField("namespace", e.target.value)}>
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

                {profile?.servingMode === "pd-separation" ? (
                  <Box sx={{ mt: 3 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: "8px", color: "text.secondary" }}>
                      {t("inf.deploy.gpu")}
                    </Typography>
                    <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <WizField label={roleLabel("prefill")}>
                        <GpuTypeSelect id="wizard-gpu-prefill" label={gpuTypeLabel(roleVendor("prefill"), selectedRoleGpuModel("prefill"))} />
                      </WizField>
                      <WizField label={roleLabel("decode")}>
                        <GpuTypeSelect id="wizard-gpu-decode" label={gpuTypeLabel(roleVendor("decode"), selectedRoleGpuModel("decode"))} />
                      </WizField>
                    </Box>
                    <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: "8px" }}>
                      {t("inf.deploy.gpuPerRole")}
                    </Typography>
                  </Box>
                ) : profile ? (
                  <WizField label={t("inf.deploy.gpu")}>
                    <GpuTypeSelect id="wizard-gpu" label={gpuTypeLabel(profile.vendor, selectedGpuModel)} />
                  </WizField>
                ) : null}

                {profile && profile.overrides.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: "8px", color: "text.secondary" }}>
                      {t("inf.deploy.overrides")}
                    </Typography>
                    {roleOverrides ? (
                      <>
                        {roleOverrides.rest.length > 0 && (
                          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                            {roleOverrides.rest.map(overrideInput)}
                          </Box>
                        )}
                        <Box
                          data-od-id="override-role-grid"
                          sx={{
                            mt: roleOverrides.rest.length > 0 ? "12px" : 0,
                            display: "grid",
                            gridTemplateColumns: `repeat(${roleOverrides.roles.length}, minmax(0, 1fr))`,
                            gap: "12px",
                            alignItems: "start",
                          }}
                        >
                          {roleOverrides.roles.map((role) => (
                            <Typography
                              key={`role-${role}`}
                              data-od-id={`override-role-${role}`}
                              sx={{ fontSize: 12, fontWeight: 600, color: "text.secondary" }}
                            >
                              {roleLabel(role)}
                            </Typography>
                          ))}
                          {roleOverrides.rows.map((row, rowIdx) =>
                            row.map((decl, i) =>
                              decl ? (
                                overrideInput(decl)
                              ) : (
                                <Box key={`override-role-empty-${rowIdx}-${i}`} />
                              ),
                            ),
                          )}
                        </Box>
                      </>
                    ) : (
                      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                        {profile.overrides.map(overrideInput)}
                      </Box>
                    )}
                  </Box>
                )}

                <Box sx={{ mt: 3, border: 1, borderColor: "divider", borderRadius: "var(--radius)", p: "14px" }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{t("inf.deploy.route")}</Typography>
                  <Box sx={{ mt: "12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <WizField label={t("inf.deploy.modelName")} hint={t("inf.deploy.modelNameHint")}>
                      <TextField data-od-id="deploy-model-name" size="small" fullWidth value={draft.modelName} onChange={(e) => setField("modelName", e.target.value)} />
                    </WizField>
                    <WizField label={t("inf.deploy.aigatewayRouter")} hint={t("inf.deploy.aigatewayRouterHint")}>
                      <Select
                        size="small"
                        fullWidth
                        data-od-id="deploy-aigateway-router"
                        value={draft.aigatewayRouter}
                        onChange={(e) => setField("aigatewayRouter", e.target.value as AIGatewayRouter)}
                      >
                        <MenuItem value={AIGATEWAY_ROUTER_PRIVATE}>{t("inf.deploy.aigatewayRouterPrivate")}</MenuItem>
                        <MenuItem value={AIGATEWAY_ROUTER_PUBLIC}>{t("inf.deploy.aigatewayRouterPublic")}</MenuItem>
                      </Select>
                    </WizField>
                  </Box>
                  <Box sx={{ mt: "12px" }}>
                    <WizField label={t("inf.deploy.paths")} hint={t("inf.deploy.pathsHint")}>
                      <Select
                        multiple
                        size="small"
                        fullWidth
                        data-od-id="deploy-catalog-paths"
                        value={draft.paths}
                        onChange={(e) => {
                          const next = e.target.value as CatalogPath[];
                          // A published model must expose at least one path,
                          // so deselecting the last one is ignored.
                          if (next.length > 0) setField("paths", next);
                        }}
                        renderValue={(selected) => (selected as CatalogPath[]).join(", ")}
                      >
                        {CATALOG_PATHS.map((path) => (
                          <MenuItem key={path} value={path}>
                            <Checkbox size="small" checked={draft.paths.includes(path)} sx={{ p: 0, pr: "8px" }} />
                            {path}
                          </MenuItem>
                        ))}
                      </Select>
                    </WizField>
                  </Box>
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
                    [t("inf.deploy.gpu"), gpuSummary],
                    ["modelRef", draft.modelRef],
                    ...(profile
                      ? profile.overrides.map((o) => {
                          const v = overrideValue(o);
                          return [`${t("inf.deploy.override")} ${overrideDisplayName(o.name)}`, Array.isArray(v) ? v.join(", ") : String(v)] as [string, string];
                        })
                      : []),
                    [t("inf.deploy.route"), `${t("inf.params.published")} · ${draft.aigatewayRouter === AIGATEWAY_ROUTER_PRIVATE ? t("inf.deploy.aigatewayRouterPrivate") : t("inf.deploy.aigatewayRouterPublic")} · ${draft.modelName} · ${draft.paths.join(" ")}`],
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

/**
 * GPU type select of the create wizard: read-only, showing the role's
 * effective accelerator and the model the user selected through an override.
 * Heterogeneous combinations (prefill on one vendor, decode on another) are
 * profile authoring — InferenceService has no per-role accelerator input, so
 * the select stays disabled.
 */
function GpuTypeSelect({ id, label }: { id: string; label: string }) {
  return (
    <Select size="small" fullWidth disabled data-od-id={id} value={label} onChange={() => {}}>
      <MenuItem value={label}>{label}</MenuItem>
    </Select>
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

// Role names are profile identifiers ("prefill", "decode"); the UI shows them
// capitalized, the same way it labels override keys.
function roleLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Human-readable label for an override name. Profile declarations are keys in
// snake_case or camelCase; the UI shows them as words so a knob reads as a
// label instead of an identifier: "prefill_metax_model" becomes "Prefill Metax
// Model" and "cacheDitWarmup" becomes "Cache Dit Warmup". The raw name remains
// the override key sent to the API and the data-od-id suffix.
function overrideDisplayName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// A nodeSelector override pins one node. The wizard lists the cluster's
// schedulable nodes and injects kubernetes.io/hostname=<node> for the user's
// pick, so the user selects a node rather than composing a key=value pair. A
// value naming another label pair stays free text, so a profile's own pool
// default is never silently replaced.
const NODE_SELECTOR_KEY = "kubernetes.io/hostname";

function isNodeSelectorOverride(decl: Pick<OverrideDecl, "name" | "type">): boolean {
  return (
    (decl.type === "string" || decl.type === "stringList") &&
    (decl.name === "nodeSelector" || decl.name.endsWith("_nodeSelector"))
  );
}

/** The node a string nodeSelector value pins: "" for none, null for another label pair. */
function pinnedNode(value: unknown): string | null {
  const v = String(value ?? "");
  if (v === "") return "";
  // Several pairs are not a single-node pin; keep the free-text input.
  if (v.includes(",")) return null;
  const eq = v.indexOf("=");
  if (eq < 0) return null;
  return v.slice(0, eq) === NODE_SELECTOR_KEY ? v.slice(eq + 1) : null;
}

/**
 * The nodes a stringList nodeSelector value pins; null when any entry names
 * another label, in which case the generic list input takes over.
 */
function pinnedNodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const prefix = `${NODE_SELECTOR_KEY}=`;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.startsWith(prefix)) return null;
    names.push(entry.slice(prefix.length));
  }
  return names;
}

function OverrideInput({
  decl,
  value,
  onChange,
  nodes,
  anyNodes,
}: {
  decl: OverrideDecl;
  value: OverrideValue;
  onChange: (v: OverrideValue) => void;
  nodes: Array<{ name: string }>;
  /** Whether the cluster offered any node at all; `nodes` may be filtered to none. */
  anyNodes: boolean;
}) {
  const { t } = useI18n();
  // The picker is filtered to the role's selected GPU model; when that leaves
  // no node, say so instead of showing a list with only "any" and no reason.
  const nodeHint =
    isNodeSelectorOverride(decl) && anyNodes && nodes.length === 0
      ? t("inf.deploy.nodeNoMatch")
      : decl.description ?? undefined;
  if (decl.type === "boolean") {
    return (
      <WizField label={overrideDisplayName(decl.name)} hint={decl.description ?? undefined}>
        <Switch checked={Boolean(value)} data-od-id={`override-${decl.name}`} onChange={(e) => onChange(e.target.checked)} />
      </WizField>
    );
  }
  const label = `${overrideDisplayName(decl.name)}${decl.min !== null && decl.max !== null ? ` (${decl.min}–${decl.max})` : ""}`;
  if (decl.type === "stringList") {
    const list = Array.isArray(value) ? value : [];
    const nodeNames = isNodeSelectorOverride(decl) ? pinnedNodes(value) : null;
    if (nodeNames !== null && anyNodes) {
      // A pinned node stays listed even when the selected model no longer
      // matches it: it is the user's current choice, and hiding it would
      // render the Select blank instead of letting them change it.
      const offered = new Set(nodes.map((n) => n.name));
      const menu = [
        ...nodeNames.filter((name) => !offered.has(name)).map((name) => ({ name })),
        ...nodes,
      ];
      return (
        <WizField label={label} hint={nodeHint}>
          <Select
            multiple
            size="small"
            fullWidth
            displayEmpty
            value={nodeNames}
            data-od-id={`override-${decl.name}`}
            renderValue={(names) => (names.length > 0 ? names.join(", ") : t("inf.deploy.nodeAny"))}
            onChange={(e) => {
              const names = e.target.value as string[];
              onChange(names.map((name) => `${NODE_SELECTOR_KEY}=${name}`));
            }}
          >
            {menu.map((n) => (
              <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
            ))}
          </Select>
        </WizField>
      );
    }
    if (decl.enum && decl.enum.length > 0) {
      return (
        <WizField label={label} hint={decl.description ?? undefined}>
          <Select
            multiple
            size="small"
            fullWidth
            value={list}
            data-od-id={`override-${decl.name}`}
            onChange={(e) => onChange((e.target.value as Array<number | string>).map(String))}
          >
            {decl.enum.map((v) => (
              <MenuItem key={String(v)} value={String(v)}>{String(v)}</MenuItem>
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
          value={list.join(",")}
          data-od-id={`override-${decl.name}`}
          onChange={(e) => onChange(splitList(e.target.value))}
        />
      </WizField>
    );
  }
  const pinned = isNodeSelectorOverride(decl) ? pinnedNode(value) : null;
  if (pinned !== null && anyNodes) {
    // See the stringList branch: keep a pinned node selectable.
    const menu =
      pinned && !nodes.some((n) => n.name === pinned) ? [{ name: pinned }, ...nodes] : nodes;
    return (
      <WizField label={label} hint={nodeHint}>
        <Select
          size="small"
          fullWidth
          displayEmpty
          value={pinned}
          data-od-id={`override-${decl.name}`}
          onChange={(e) => {
            const name = e.target.value as string;
            onChange(name ? `${NODE_SELECTOR_KEY}=${name}` : "");
          }}
        >
          <MenuItem value="">{t("inf.deploy.nodeAny")}</MenuItem>
          {menu.map((n) => (
            <MenuItem key={n.name} value={n.name}>{n.name}</MenuItem>
          ))}
        </Select>
      </WizField>
    );
  }
  if (decl.enum && decl.enum.length > 0) {
    return (
      <WizField label={label} hint={decl.description ?? undefined}>
        <Select size="small" fullWidth value={value} data-od-id={`override-${decl.name}`} onChange={(e) => onChange(e.target.value as number | string)}>
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
        data-od-id={`override-${decl.name}`}
        onChange={(e) => onChange(decl.type === "integer" ? Number(e.target.value) : e.target.value)}
      />
    </WizField>
  );
}
