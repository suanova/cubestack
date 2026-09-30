"use client";

// 配置 tab — model selection, system prompt, LLM catalog, instance status,
// confirmation policy + allowlist. Model / prompt / policy persist to the
// caller's AgentInstance CR (the first save provisions it); the LLM catalog
// comes from the AgentTemplate's provider list inlined in GET /agent/config
// (reference AgentView: "models are inlined in the AgentTemplate"), so the page
// needs no AI Gateway round trip for it.

import { Box } from "@mui/material";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/base-path";
import { phaseText, waitingSeconds } from "@/lib/cubepilot/agentThread";
import { MAX_PROVIDER_MODELS, modelIdError, modelKey } from "@/lib/cubepilot/llm";
import {
  PLATFORM_MODEL_NAME,
  displayModelName,
  type AgentConfig,
  type AgentStatus,
  type AllowlistRule,
  type ConfirmView,
  type TemplateProviderOption,
} from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import { ruleKey } from "@/lib/cubepilot/allowlist";

import { fmtSeconds } from "./format";
import { Btn, Card, CardHead, CpInput, CpTextArea, Icons, Pill, Spinner, inputSx, monoSx, useToast } from "./ui";

/** The policy the select shows: the override when it is one we offer, else the
 *  effective policy when that is, else Allowlist. */
function supportedPolicy(v: Pick<ConfirmView, "override" | "confirmPolicy">): string {
  for (const candidate of [v.override, v.confirmPolicy]) {
    if (candidate === "Allowlist" || candidate === "None") return candidate;
  }
  return "Allowlist";
}

/** Parse the comma/newline separated model ids of the form field. */
function parseModels(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function ConfigPane() {
  const { t } = useI18n();
  const { showToast, toastView } = useToast();

  const [config, setConfig] = useState<AgentConfig>({ exists: false, selectedModel: "", userInstructions: "" });
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [confirm, setConfirm] = useState<ConfirmView | null>(null);
  const [policySel, setPolicySel] = useState("");
  const providers: TemplateProviderOption[] = config.providers ?? [];
  const gatewayModels = config.gatewayModels ?? [];
  /** The platform's own provider — the builtin entry pointing at the gateway. */
  const platformProvider = providers.find((p) => p.name === PLATFORM_MODEL_NAME);
  /** Every selectable model, grouped by the provider it belongs to: the ref is
   *  what the CR stores, and the template's providers are the catalog — the
   *  reference says as much in its own hint ("models come from the template's
   *  providers"), so an external provider added in the card below is selectable
   *  the moment it is saved.
   *
   *  The gateway's served list is NOT the catalog: it is the ids the PLATFORM
   *  provider's entry gets written with, and they are already in here as that
   *  provider's models. Reading the catalog from it instead is what hid every
   *  provider the user added. */
  const modelGroups = providers
    .map((p) => ({
      name: p.name,
      options: (p.models ?? []).map((id) => ({ ref: modelKey(p.name, id), id })),
    }))
    .filter((g) => g.options.length > 0)
    .map((g) => ({ ...g, options: g.options.filter((o, i, all) => all.findIndex((x) => x.ref === o.ref) === i) }));
  const modelOptions = modelGroups.flatMap((g) => g.options);
  /** The ref the select shows and saves: the stored one while it is still
   *  selectable, else the first option — a stale ref is what the save refuses. */
  const modelValue = modelOptions.some((o) => o.ref === config.selectedModel)
    ? config.selectedModel
    : (modelOptions[0]?.ref ?? "");
  /** The provider the current selection belongs to, for the note under the
   *  select: an external model does not run through the platform endpoint. */
  const selectedProvider = providers.find((p) => modelValue.startsWith(`${p.name}/`)) ?? platformProvider;
  /** The platform provider's ids: what the gateway serves, as the template's
   *  platform entry holds them. This is the card's "platform" list — the select
   *  above no longer reads it as the catalog, because that is what hid every
   *  provider the user added. */
  const systemModels: string[] = platformProvider?.models?.length ? platformProvider.models : gatewayModels;
  const selectedId = displayModelName(config.selectedModel);
  const externalProviders = providers.filter((p) => p.origin !== "system");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [ruleForm, setRuleForm] = useState({ pattern: "", argPattern: "" });
  /** Which LLM source the card shows: the platform's catalog or your own. */
  const [llmSource, setLlmSource] = useState<"system" | "external">("system");
  const [llmForm, setLlmForm] = useState({ name: "", endpoint: "", models: "", apiKey: "", public: false });
  const [editingProvider, setEditingProvider] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  /** The ids the last fetch found, plus how many the endpoint offered in total
   *  (the card lists the first MAX_PROVIDER_MODELS of them, which is all a
   *  provider may declare). */
  const [llmFetched, setLlmFetched] = useState<{ ids: string[]; total: number; warning: string } | null>(null);
  const [llmFetchError, setLlmFetchError] = useState("");
  const [llmFetching, setLlmFetching] = useState(false);
  /** Bumped whenever what the request would be made with changes (or the form
   *  moves to another provider), so an answer that arrives late is dropped
   *  instead of installing one endpoint's ids under another's. */
  const llmFetchGenRef = useRef(0);
  const [saving, setSaving] = useState(false);
  /** The last load failure: kept on screen (a toast disappears before it can be
   *  read, which is what makes an empty page look like "nothing loaded"). */
  const [loadError, setLoadError] = useState("");
  /** Whether the first read has settled. The card's own warning ("the template
   *  declares no provider") is a statement about the TEMPLATE, and the catalog
   *  arrives one gateway round-trip late — saying it while the read is still in
   *  flight is what made every refresh open on a contradiction. */
  const [loaded, setLoaded] = useState(false);

  const loadAll = useCallback(async () => {
    const get = async <T,>(path: string) => {
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    };
    try {
      const [cfgRes, stRes, cfRes] = await Promise.all([
        get<{ config: AgentConfig }>("/api/cubepilot/agent/config"),
        get<AgentStatus>("/api/cubepilot/agent/status"),
        get<ConfirmView>("/api/cubepilot/agent/confirm"),
      ]);
      setConfig(cfgRes.config);
      setStatus(stRes);
      setConfirm(cfRes);
      setPolicySel(supportedPolicy(cfRes));
      setLoadError("");
    } catch (e) {
      setLoadError(String(e));
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    } finally {
      setLoaded(true);
    }
  }, [showToast, t]);

  // Mount-only: loadAll's identity changes every render (its t dep is
  // regenerated by useI18n), and the fetched data is locale-neutral, so a
  // load-once effect is what we want.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadAll();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  /** The waiting line counts seconds, so the card needs a clock while the
   *  instance is coming up — and only then. */
  const [now, setNow] = useState(() => Date.now());
  /** Guards the status reads above against landing out of order. */
  const statusGenRef = useRef(0);
  useEffect(() => {
    if (!status || status.phase === "Ready") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // A save leaves the instance starting (its identity is minted, then the pod
  // comes up), so the card asks again until it is Ready instead of sitting on
  // "Creating" until a reload.
  useEffect(() => {
    if (!status || status.phase === "Ready") return;
    const id = setInterval(() => {
      // Only the newest read counts: a slow one must not put an older phase
      // back on the card after a newer one said Ready.
      const gen = ++statusGenRef.current;
      void apiFetch("/api/cubepilot/agent/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (s && statusGenRef.current === gen) setStatus(s as AgentStatus);
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(id);
  }, [status]);

  async function saveConfig() {
    if (saving) return;
    // A first save only starts the instance, which is not "saved" in the sense
    // the reader expects.
    const wasMissing = !config.exists;
    setSaving(true);
    try {
      const res = await apiFetch("/api/cubepilot/agent/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // selectedModel is the platform ref the select offers; the route checks
        // it against the served catalog and selects it on the instance.
        body: JSON.stringify({ config: { selectedModel: modelValue, userInstructions: config.userInstructions } }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { config: AgentConfig };
      setConfig(body.config);
      showToast(t(wasMissing ? "cubepilot.config.savedCreating" : "cubepilot.config.saved"));
      // The first save provisions the instance — refresh status/confirm.
      void loadAll();
    } catch (e) {
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    } finally {
      setSaving(false);
    }
  }

  // ── confirmations ──
  // The PUT carries the instance's OWNED state only (template rules are
  // inherited, never stored on the instance).

  async function persistConfirm(body: { confirmPolicy?: string; allowlist?: AllowlistRule[] }) {
    if (confirmBusy) return;
    setConfirmBusy(true);
    try {
      const res = await apiFetch("/api/cubepilot/agent/confirm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      const v = (await res.json()) as ConfirmView;
      setConfirm(v);
      setPolicySel(supportedPolicy(v));
    } catch (e) {
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    } finally {
      setConfirmBusy(false);
    }
  }

  function ownedRules(): AllowlistRule[] {
    return (confirm?.allowlist ?? []).filter((r) => r.owned);
  }

  function changePolicy(value: string) {
    setPolicySel(value);
    void persistConfirm({ confirmPolicy: value });
  }

  function addRule() {
    const pattern = ruleForm.pattern.trim();
    if (!pattern) {
      showToast(t("cubepilot.config.errPattern"));
      return;
    }
    const entry: AllowlistRule = { pattern, argPattern: ruleForm.argPattern.trim() || undefined, owned: true };
    if (ownedRules().some((r) => ruleKey(r) === ruleKey(entry))) {
      showToast(t("cubepilot.config.dupeRule"));
      return;
    }
    void persistConfirm({ allowlist: [...ownedRules(), entry] });
    setRuleForm({ pattern: "", argPattern: "" });
    showToast(t("cubepilot.config.ruleAdded"));
  }

  function removeRule(key: string) {
    void persistConfirm({ allowlist: ownedRules().filter((r) => ruleKey(r) !== key) });
    showToast(t("cubepilot.config.ruleRemoved"));
  }

  // ── external providers (AgentTemplate.spec.providers; keys live in Secrets) ──

  function resetLlmForm() {
    clearFetched();
    setLlmForm({ name: "", endpoint: "", models: "", apiKey: "", public: false });
    setEditingProvider("");
  }

  function startEditLlm(p: TemplateProviderOption) {
    clearFetched();
    setEditingProvider(p.name);
    setLlmForm({ name: p.name, endpoint: p.endpoint ?? "", models: p.models.join(", "), apiKey: "", public: !p.keyed });
  }

  function cancelEditLlm() {
    resetLlmForm();
  }

  /** A fetched list belongs to the endpoint it came from: editing what the
   *  request is made with drops it rather than letting stale ids be ticked. */
  function clearFetched(): void {
    llmFetchGenRef.current += 1;
    setLlmFetched(null);
    setLlmFetchError("");
  }

  /** Ask the endpoint which ids it serves. The portal makes the call — a page
   *  cannot reach an arbitrary endpoint, and the key is not stored yet. */
  async function fetchLlmModels(): Promise<void> {
    if (llmFetching) return;
    const gen = (llmFetchGenRef.current += 1);
    setLlmFetching(true);
    setLlmFetchError("");
    setLlmFetched(null);
    try {
      const res = await apiFetch("/api/cubepilot/agent/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: llmForm.endpoint, apiKey: llmForm.apiKey, public: llmForm.public }),
      });
      const body = (await res.json().catch(() => null)) as { models?: string[]; error?: string; warning?: string } | null;
      if (llmFetchGenRef.current !== gen) return;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Only ids this form can carry are offered: one the CR would refuse makes
      // the save fail, and one holding the field's own separator (a comma)
      // cannot be written into it at all.
      const valid = (body?.models ?? []).filter((id) => modelIdError(id) === "" && !/[,]/.test(id));
      setLlmFetched({ ids: valid.slice(0, MAX_PROVIDER_MODELS), total: valid.length, warning: body?.warning ?? "" });
    } catch (e) {
      if (llmFetchGenRef.current !== gen) return;
      setLlmFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      // Unconditional: only one attempt runs at a time, and a stale one still
      // has to release the button it disabled.
      setLlmFetching(false);
    }
  }

  /** Tick or untick a fetched id. The field stays the one source of truth, so
   *  the ticks and a hand-typed list can never disagree. */
  function toggleModel(id: string): void {
    const ids = parseModels(llmForm.models);
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setLlmForm((f) => ({ ...f, models: next.join(", ") }));
  }

  /** Both routes answer with the affected provider; reloading the config keeps
   *  the model card, the catalog and the source lists in step. */
  async function submitLlm() {
    if (llmBusy) return;
    const name = llmForm.name.trim();
    const endpoint = llmForm.endpoint.trim();
    const models = parseModels(llmForm.models);
    if (!editingProvider && !name) {
      showToast(t("cubepilot.config.llmErrName"));
      return;
    }
    if (!endpoint) {
      showToast(t("cubepilot.config.llmErrEndpoint"));
      return;
    }
    if (models.length === 0) {
      showToast(t("cubepilot.config.llmErrModels"));
      return;
    }
    // A provider that ends up keyed needs a key: either it is new, or it was
    // public and is being switched (nothing is stored to fall back on). An
    // already-keyed provider leaves the field empty to keep its key.
    const wasKeyed = providers.some((p) => p.name === editingProvider && p.keyed);
    if (!llmForm.public && !llmForm.apiKey.trim() && !wasKeyed) {
      showToast(t("cubepilot.config.llmErrKey"));
      return;
    }
    setLlmBusy(true);
    try {
      const res = editingProvider
        ? await apiFetch(`/api/cubepilot/agent/llms/${encodeURIComponent(editingProvider)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint, models, apiKey: llmForm.apiKey || undefined, public: llmForm.public }),
          })
        : await apiFetch("/api/cubepilot/agent/llms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, endpoint, models, apiKey: llmForm.apiKey || undefined, public: llmForm.public }),
          });
      const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      showToast(
        editingProvider
          ? t("cubepilot.config.llmUpdated", { name: editingProvider })
          : t("cubepilot.config.llmAdded", { name }),
      );
      if (body.warning) showToast(body.warning);
      resetLlmForm();
      await loadAll();
    } catch (e) {
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    } finally {
      setLlmBusy(false);
    }
  }

  async function removeLlm(name: string) {
    if (llmBusy) return;
    if (!window.confirm(t("cubepilot.config.llmRemoveConfirm", { name }))) return;
    setLlmBusy(true);
    try {
      const res = await apiFetch(`/api/cubepilot/agent/llms/${encodeURIComponent(name)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      showToast(t("cubepilot.config.llmRemoved", { name }));
      if (body.warning) showToast(body.warning);
      if (editingProvider === name) resetLlmForm();
      await loadAll();
    } catch (e) {
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    } finally {
      setLlmBusy(false);
    }
  }

  function resetConfirm() {
    setPolicySel("Allowlist");
    void persistConfirm({ confirmPolicy: "", allowlist: [] });
  }

  const hasInstance = !!status?.exists;
  const allowlistPolicy = confirm?.confirmPolicy === "Allowlist";
  // The select offers Allowlist / None only: a CR holding anything else (e.g. a
  // legacy AlwaysAsk) shows the safe default instead of a blank select, and the
  // effective pill below still reports what the runtime enforces.
  const defaultRules = (confirm?.allowlist ?? []).filter((r) => !r.owned);
  const ownedList = (confirm?.allowlist ?? []).filter((r) => r.owned);

  return (
    <Box data-od-id="cp-config-pane">
      {config.templateMissing ? (
        <Box
          data-od-id="cp-config-template-missing"
          sx={{ mb: "14px", border: 1, borderColor: "color-mix(in oklch, #e0a13a 45%, var(--border))", bgcolor: "color-mix(in oklch, #e0a13a 8%, transparent)", borderRadius: "8px", p: "12px 14px", fontSize: 12.5, lineHeight: 1.7 }}
        >
          <Box sx={{ fontWeight: 650, mb: "3px" }}>{t("cubepilot.config.templateMissing")}</Box>
          {/* The hint names env vars and custom resources: worth keeping for
              whoever has to fix this, not worth showing to everyone who reads
              the card, so it starts folded. */}
          <Box component="details" sx={{ color: "text.secondary" }}>
            <Box component="summary" sx={{ cursor: "pointer" }}>{t("cubepilot.config.troubleshoot")}</Box>
            <Box sx={{ mt: "4px" }}>{t("cubepilot.config.templateMissingHint")}</Box>
          </Box>
        </Box>
      ) : null}
      {loadError ? (
        <Box
          data-od-id="cp-config-load-error"
          sx={{ mb: "14px", border: 1, borderColor: "color-mix(in oklch, #e15c5c 45%, var(--border))", bgcolor: "color-mix(in oklch, #e15c5c 8%, transparent)", borderRadius: "8px", p: "12px 14px", fontSize: 12.5, lineHeight: 1.7, wordBreak: "break-word" }}
        >
          <Box sx={{ fontWeight: 650, mb: "3px" }}>{t("cubepilot.config.loadFailed")}</Box>
          <Box sx={{ ...monoSx, fontSize: 11.5 }}>{loadError}</Box>
          <Box component="details" sx={{ color: "text.secondary", mt: "6px" }}>
            <Box component="summary" sx={{ cursor: "pointer" }}>{t("cubepilot.config.troubleshoot")}</Box>
            <Box sx={{ mt: "4px" }}>{t("cubepilot.config.loadFailedHint")}</Box>
          </Box>
        </Box>
      ) : null}
      {/* head */}
      <Box sx={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", mb: "16px", flexWrap: "wrap" }}>
        <Box>
          <Box sx={{ fontSize: 18, fontWeight: 650, letterSpacing: "-0.01em" }}>{t("cubepilot.config.title")}</Box>
          <Box sx={{ fontSize: 13, color: "text.secondary", mt: "3px" }}>{t("cubepilot.config.desc")}</Box>
        </Box>
        <Btn variant="primary" onClick={() => void saveConfig()} disabled={saving} data-od-id="cp-config-save">
          {Icons.check()}
          {t("cubepilot.config.save")}
        </Btn>
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "14px", alignItems: "start" }}>
        {/* ── left column ── */}
        <Box sx={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
          {/* Model & Runtime */}
          <Card data-od-id="cp-config-model">
            <CardHead title={t("cubepilot.config.modelTitle")} hint={t("cubepilot.config.modelHint")} />
            <Box sx={{ p: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
              <Box sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <Box component="label" sx={{ fontSize: 12.5, color: "text.secondary", fontWeight: 550 }}>{t("cubepilot.config.model")}</Box>
                {/* The catalog is the template's providers, grouped by provider
                    (the labels stay bare ids; the value is the ref the CR
                    stores). Disabled only when there is nothing to choose — a
                    save needs a ref the template can resolve. */}
                <Box
                  component="select"
                  aria-label={t("cubepilot.config.model")}
                  value={modelValue}
                  onChange={(e) => setConfig({ ...config, selectedModel: e.target.value })}
                  disabled={modelOptions.length === 0}
                  sx={inputSx}
                  data-od-id="cp-config-model-select"
                >
                  {modelGroups.map((g) => (
                    <Box key={g.name} component="optgroup" label={g.name}>
                      {g.options.map((o) => (
                        <Box key={o.ref} component="option" value={o.ref}>
                          {o.id}
                        </Box>
                      ))}
                    </Box>
                  ))}
                </Box>
                <Box sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }} data-od-id="cp-config-model-note">
                  {t("cubepilot.config.modelPlatformNote", {
                    // The option's own id, not the ref: displayModelName strips the
                    // platform prefix only, so an external selection would read as
                    // "cuberouter/deepseek-flash" while the picker beside it shows
                    // "deepseek-flash".
                    model: modelOptions.find((o) => o.ref === modelValue)?.id || "—",
                    // The platform's own provider is described as the platform's;
                    // any other one is named, because the sentence's whole point is
                    // which endpoint the model runs through.
                    provider:
                      selectedProvider && selectedProvider.name !== PLATFORM_MODEL_NAME
                        ? selectedProvider.name
                        : t("cubepilot.config.providerPlatform"),
                    endpoint: selectedProvider?.endpoint || "—",
                  })}
                </Box>
                {/* Only after a read that SUCCEEDED: a failed read leaves the
                    catalog empty too, and "the template declares no provider" is a
                    statement about the template, not about this page's luck. */}
                {loaded && !loadError && providers.length === 0 ? (
                  <Box sx={{ fontSize: 12, color: "#e15c5c" }} data-od-id="cp-config-model-empty">
                    {t("cubepilot.config.noModels")}
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Card>

          {/* LLM 配置:两个来源 —— 系统默认(平台 AI Gateway,与聊天 tab 同源,
              只读)或外部 provider(自建 OpenAI 兼容端点 + 模型 id,写进
              AgentTemplate 的 providers;密钥存平台管理的 Secret,CR 里只有引用)。 */}
          <Card data-od-id="cp-config-llm">
            <CardHead
              title={t("cubepilot.config.llmTitle")}
              hint={llmSource === "system" ? t("cubepilot.config.llmHintSystem") : t("cubepilot.config.llmHintExternal")}
            />
            <Box sx={{ px: "16px", pt: "12px", display: "flex", gap: "6px" }} data-od-id="cp-config-llm-source">
              {(["system", "external"] as const).map((src) => (
                <Box
                  key={src}
                  component="button"
                  type="button"
                  aria-pressed={llmSource === src}
                  onClick={() => setLlmSource(src)}
                  data-od-id={`cp-config-llm-src-${src}`}
                  sx={{
                    px: "12px",
                    py: "6px",
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    border: 1,
                    borderRadius: 999,
                    cursor: "pointer",
                    color: llmSource === src ? "var(--accent-strong)" : "text.secondary",
                    borderColor: llmSource === src ? "var(--accent)" : "divider",
                    bgcolor: llmSource === src ? "var(--accent-soft)" : "transparent",
                    fontWeight: llmSource === src ? 600 : 400,
                  }}
                >
                  {src === "system" ? t("cubepilot.config.llmSourceSystem") : t("cubepilot.config.llmSourceExternal")}
                </Box>
              ))}
            </Box>

            {llmSource === "system" ? (
              <Box sx={{ p: "12px 16px 16px", display: "flex", flexDirection: "column", gap: "8px" }} data-od-id="cp-config-llm-system">
                {systemModels.length === 0 ? (
                  <Box sx={{ fontSize: 12.5, color: "text.secondary" }}>{t("cubepilot.config.llmSystemNone")}</Box>
                ) : null}
                {systemModels.map((id) => (
                  <Box key={id} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", fontSize: 13 }}>
                    <Box sx={{ ...monoSx, fontSize: 12.5 }}>{id}</Box>
                    <Pill variant="neutral">{id === selectedId ? t("cubepilot.config.llmSelected") : t("cubepilot.config.llmGatewayPill")}</Pill>
                  </Box>
                ))}
              </Box>
            ) : (
              <Box sx={{ p: "12px 16px 16px", display: "flex", flexDirection: "column", gap: "10px" }} data-od-id="cp-config-llm-external">
                {externalProviders.length === 0 ? (
                  <Box sx={{ fontSize: 12.5, color: "text.secondary" }}>{t("cubepilot.config.llmNone")}</Box>
                ) : null}
                {externalProviders.map((p) => {
                  const refs = p.models.map((id) => modelKey(p.name, id));
                  return (
                    <Box key={p.name} data-od-id="cp-config-llm-row" sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {/* The provider key is the ref prefix, so the row reads
                              "provider/modelId" — the name an externally hosted
                              model is known by. */}
                          <Box sx={{ ...monoSx, fontSize: 12.5 }}>{p.name}</Box>
                          {refs.includes(config.selectedModel) ? <Pill variant="neutral">{t("cubepilot.config.llmSelected")}</Pill> : null}
                          <Pill variant="neutral">{p.keyed ? t("cubepilot.config.llmKeyed") : t("cubepilot.config.llmPublic")}</Pill>
                        </Box>
                        <Box
                          sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={refs.join(", ")}
                        >
                          {refs.join(", ")}
                        </Box>
                        <Box
                          sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={p.endpoint}
                        >
                          {p.endpoint}
                        </Box>
                      </Box>
                      <Btn small variant="ghost" disabled={llmBusy} onClick={() => startEditLlm(p)} data-od-id="cp-config-llm-edit">
                        {t("cubepilot.config.llmEdit")}
                      </Btn>
                      <Btn small variant="ghost" disabled={llmBusy} onClick={() => void removeLlm(p.name)} data-od-id="cp-config-llm-remove">
                        {t("cubepilot.config.llmRemove")}
                      </Btn>
                    </Box>
                  );
                })}

                <Box sx={{ display: "flex", flexDirection: "column", gap: "6px", pt: "2px" }}>
                  <CpInput
                    placeholder={t("cubepilot.config.llmNamePh")}
                    aria-label={t("cubepilot.config.llmNamePh")}
                    value={llmForm.name}
                    disabled={editingProvider !== ""}
                    onChange={(e) => setLlmForm((f) => ({ ...f, name: e.target.value }))}
                    sx={{ ...monoSx, fontSize: 12.5 }}
                    data-od-id="cp-config-llm-name"
                  />
                  <CpInput
                    placeholder={t("cubepilot.config.llmEndpointPh")}
                    aria-label={t("cubepilot.config.llmEndpointPh")}
                    value={llmForm.endpoint}
                    onChange={(e) => {
                      clearFetched();
                      setLlmForm((f) => ({ ...f, endpoint: e.target.value }));
                    }}
                    sx={{ ...monoSx, fontSize: 12.5 }}
                    data-od-id="cp-config-llm-endpoint"
                  />
                  <Box sx={{ display: "flex", alignItems: "center", gap: "14px", fontSize: 12.5, color: "text.secondary" }}>
                    {/* One choice, not a checkbox beside a field: the two are
                        exclusive (a provider has a credential or is public), and
                        picking public drops whatever key was typed. */}
                    <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="cp-config-llm-cred"
                        checked={!llmForm.public}
                        onChange={() => setLlmForm((f) => ({ ...f, public: false }))}
                        data-od-id="cp-config-llm-cred-key"
                      />
                      {t("cubepilot.config.llmKeyed")}
                    </Box>
                    <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="cp-config-llm-cred"
                        checked={llmForm.public}
                        onChange={() => {
                          clearFetched();
                          setLlmForm((f) => ({ ...f, public: true, apiKey: "" }));
                        }}
                        data-od-id="cp-config-llm-cred-public"
                      />
                      {t("cubepilot.config.llmPublicLabel")}
                    </Box>
                  </Box>
                  {llmForm.public ? null : (
                  <CpInput
                    type="password"
                    placeholder={editingProvider ? t("cubepilot.config.llmKeyPhEdit") : t("cubepilot.config.llmKeyPh")}
                    aria-label={t("cubepilot.config.llmKeyPh")}
                    value={llmForm.apiKey}
                    onChange={(e) => {
                      clearFetched();
                      setLlmForm((f) => ({ ...f, apiKey: e.target.value }));
                    }}
                    sx={{ ...monoSx, fontSize: 12.5 }}
                    data-od-id="cp-config-llm-key"
                  />
                  )}
                  <Box sx={{ display: "flex", gap: "6px", alignItems: "stretch" }}>
                    <CpInput
                      placeholder={t("cubepilot.config.llmModelsPh")}
                      aria-label={t("cubepilot.config.llmModelsPh")}
                      value={llmForm.models}
                      onChange={(e) => setLlmForm((f) => ({ ...f, models: e.target.value }))}
                      sx={{ ...monoSx, fontSize: 12.5 }}
                      data-od-id="cp-config-llm-models"
                    />
                    {/* Fetching needs what the request would be made with: an
                        endpoint, and either a key or public. */}
                    <Btn
                      small
                      variant="ghost"
                      disabled={llmFetching || llmForm.endpoint.trim() === "" || (!llmForm.public && llmForm.apiKey.trim() === "")}
                      title={!llmForm.public && llmForm.apiKey.trim() === "" ? t("cubepilot.config.llmFetchNeedsKey") : undefined}
                      onClick={() => void fetchLlmModels()}
                      data-od-id="cp-config-llm-fetch"
                    >
                      {llmFetching ? t("cubepilot.config.llmFetching") : t("cubepilot.config.llmFetch")}
                    </Btn>
                  </Box>
                  {llmFetchError ? (
                    <Box sx={{ fontSize: 11.5, color: "var(--danger)" }} data-od-id="cp-config-llm-fetch-error">
                      {t("cubepilot.config.llmFetchFailed", { error: llmFetchError })}
                    </Box>
                  ) : null}
                  {llmFetched ? (
                    <Box
                      data-od-id="cp-config-llm-fetched"
                      sx={{
                        maxHeight: 180,
                        overflowY: "auto",
                        border: 1,
                        borderColor: "divider",
                        borderRadius: "var(--radius)",
                        p: "6px 8px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px",
                      }}
                    >
                      {llmFetched.ids.length === 0 ? (
                        <Box sx={{ fontSize: 11.5, color: "text.secondary" }}>{t("cubepilot.config.llmFetchNone")}</Box>
                      ) : null}
                      {llmFetched.ids.map((id) => (
                        <Box
                          key={id}
                          component="label"
                          data-od-id={`cp-config-llm-fetched-${id}`}
                          sx={{ display: "flex", alignItems: "center", gap: "6px", fontSize: 12, ...monoSx, cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={parseModels(llmForm.models).includes(id)}
                            onChange={() => toggleModel(id)}
                          />
                          {id}
                        </Box>
                      ))}
                      {llmFetched.warning === "key-over-http" ? (
                        <Box sx={{ fontSize: 10.5, color: "var(--warn)", pt: "2px" }} data-od-id="cp-config-llm-fetch-warning">
                          {t("cubepilot.config.llmFetchHttpWarning")}
                        </Box>
                      ) : null}
                      {llmFetched.total > llmFetched.ids.length ? (
                        <Box sx={{ fontSize: 10.5, color: "text.secondary", pt: "2px" }}>
                          {t("cubepilot.config.llmFetchCapped", {
                            shown: String(llmFetched.ids.length),
                            total: String(llmFetched.total),
                          })}
                        </Box>
                      ) : null}
                    </Box>
                  ) : null}
                  <Box sx={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <Box sx={{ flex: 1 }} />
                    {editingProvider ? (
                      <Btn small disabled={llmBusy} onClick={cancelEditLlm} data-od-id="cp-config-llm-cancel">
                        {t("cubepilot.config.llmCancel")}
                      </Btn>
                    ) : null}
                    <Btn small variant="primary" disabled={llmBusy} onClick={() => void submitLlm()} data-od-id="cp-config-llm-save">
                      {llmBusy
                        ? t("cubepilot.config.llmSaving")
                        : editingProvider
                          ? t("cubepilot.config.llmSaveEdit")
                          : t("cubepilot.config.llmAdd")}
                    </Btn>
                  </Box>
                  <Box sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>{t("cubepilot.config.llmNote")}</Box>
                </Box>
              </Box>
            )}
          </Card>

          {/* System Prompt */}
          <Card data-od-id="cp-config-prompt">
            <CardHead title={t("cubepilot.config.promptTitle")} hint={t("cubepilot.config.promptHint")} />
            <Box sx={{ p: "16px" }}>
              <CpTextArea
                rows={6}
                placeholder={t("cubepilot.config.promptPh")}
                aria-label={t("cubepilot.config.promptTitle")}
                value={config.userInstructions || ""}
                onChange={(e) => setConfig((c) => ({ ...c, userInstructions: e.target.value }))}
                data-od-id="cp-config-prompt-input"
              />
            </Box>
          </Card>
        </Box>

        {/* ── instance status ── */}
        <Card sx={{ position: "sticky", top: 70 }} data-od-id="cp-config-status">
          <CardHead
            title={t("cubepilot.config.instTitle")}
            actions={
              <>
                {/* The pulse belongs to a start in progress, not to a finished one. */}
                <Pill
                  variant={hasInstance ? (status?.phase === "Ready" ? "ok" : status?.phase === "Failed" ? "danger" : "warn") : "neutral"}
                  dot
                  pulse={hasInstance && status?.phase !== "Ready"}
                >
                  {hasInstance ? phaseText(t, status?.phase) || t("cubepilot.config.instPending") : "—"}
                </Pill>
                {hasInstance && status?.phase !== "Ready" ? (
                  <Box sx={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: 12, color: "text.secondary", ml: "8px" }}>
                    <Spinner size={12} />
                    {t("cubepilot.config.instWaiting", { secs: String(waitingSeconds(status?.startedAt, now) ?? 0) })}
                  </Box>
                ) : null}
              </>
            }
          />
          <Box sx={{ p: "16px", display: "grid", gridTemplateColumns: "1fr", gap: "12px" }}>
            {status ? (
              <>
                <InstRow k={t("cubepilot.config.instId")} v={<Box component="span" sx={{ ...monoSx, fontSize: 12 }}>{status.id || "-"}</Box>} />
                <InstRow k={t("cubepilot.config.instUptime")} v={fmtSeconds(status.uptimeSeconds)} />
                <InstRow k={t("cubepilot.config.instPod")} v={<Box component="span" sx={{ ...monoSx, fontSize: 11.5 }}>{status.podName || "-"}</Box>} />
                <InstRow k={t("cubepilot.config.instVolume")} v={<Box component="span" sx={{ ...monoSx, fontSize: 11.5 }}>{status.pvcName || "-"}</Box>} />
                {status.message ? (
                  <InstRow k={t("cubepilot.config.instMessage")} v={<Box sx={{ fontSize: 12 }}>{status.message}</Box>} />
                ) : null}
                {/* Ready is not enough: without a usable provider every turn
                    fails, and the operator says so in the ModelConfigured
                    condition. Saving the config writes one. */}
                {status.modelConfigured === false ? (
                  <InstRow
                    k={t("cubepilot.config.instModel")}
                    v={<Box sx={{ fontSize: 12, color: "#e0a13a" }} data-od-id="cp-config-model-condition">{status.modelMessage || "—"}</Box>}
                  />
                ) : null}
              </>
            ) : null}
          </Box>
        </Card>
      </Box>

      {/* ── confirmations ── */}
      <Card sx={{ mt: "14px" }} data-od-id="cp-config-confirm">
        <CardHead title={t("cubepilot.config.confirmTitle")} hint={t("cubepilot.config.confirmHint")} />
        <Box sx={{ p: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <Box component="label" sx={{ fontSize: 12.5, color: "text.secondary", fontWeight: 550 }}>{t("cubepilot.config.policy")}</Box>
            {/* Two policies only: Allowlist (safe commands auto-pass) and None
                (everything passes, audited). */}
            <Box
              component="select"
              aria-label={t("cubepilot.config.policy")}
              value={policySel}
              disabled={!confirm?.exists || confirmBusy}
              onChange={(e) => changePolicy(e.target.value)}
              sx={inputSx}
              data-od-id="cp-config-policy"
            >
              <Box component="option" value="Allowlist">{t("cubepilot.config.policyAllowlist")}</Box>
              <Box component="option" value="None">{t("cubepilot.config.policyNone")}</Box>
            </Box>
            {confirm?.exists ? (
              <Box sx={{ fontSize: 12, color: "text.secondary" }}>
                {t("cubepilot.config.effective")}: <Pill variant="neutral">{confirm.confirmPolicy || "None"}</Pill>{" "}
                {confirm.override ? t("cubepilot.config.override") : t("cubepilot.config.inherited")}
              </Box>
            ) : null}
          </Box>

          {allowlistPolicy ? (
            <>
              <Box sx={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <Box component="label" sx={{ fontSize: 12.5, color: "text.secondary", fontWeight: 550 }}>{t("cubepilot.config.allowlistTitle")}</Box>
                <AllowlistTagGroup
                  groupId="cp-allowlist-default"
                  label={t("cubepilot.config.allowlistDefault")}
                  rules={defaultRules}
                  hint={t("cubepilot.config.allowlistDefaultNote")}
                />
                <AllowlistTagGroup
                  groupId="cp-allowlist-owned"
                  label={t("cubepilot.config.allowlistYours")}
                  rules={ownedList}
                  busy={confirmBusy}
                  emptyText={t("cubepilot.config.allowlistEmpty")}
                  removeLabel={t("cubepilot.config.ruleRemove")}
                  onRemove={removeRule}
                />
              </Box>
              <Box sx={{ display: "flex", gap: "6px" }}>
                <CpInput
                  placeholder={t("cubepilot.config.rulePatternPh")}
                  aria-label={t("cubepilot.config.rulePatternPh")}
                  value={ruleForm.pattern}
                  onChange={(e) => setRuleForm((f) => ({ ...f, pattern: e.target.value }))}
                  sx={{ flex: 1, minWidth: 0, ...monoSx, fontSize: 12.5 }}
                  data-od-id="cp-config-rule-pattern"
                />
                {/* The placeholder is the safe-args regex (the argPattern the
                    platform's read-only builtins use); the aria-label stays a
                    short human name so screen readers do not read a regex. */}
                <CpInput
                  placeholder={t("cubepilot.config.ruleArgPh")}
                  aria-label={t("cubepilot.config.ruleArgLabel")}
                  title={t("cubepilot.config.ruleArgPh")}
                  value={ruleForm.argPattern}
                  onChange={(e) => setRuleForm((f) => ({ ...f, argPattern: e.target.value }))}
                  sx={{ flex: 1, minWidth: 0, ...monoSx, fontSize: 12.5 }}
                  data-od-id="cp-config-rule-arg"
                />
                <Btn disabled={confirmBusy} onClick={addRule} data-od-id="cp-config-rule-add">
                  {t("cubepilot.config.ruleAdd")}
                </Btn>
              </Box>
              <Btn disabled={confirmBusy} onClick={resetConfirm}>
                {t("cubepilot.config.resetDefault")}
              </Btn>
            </>
          ) : (
            <Box sx={{ fontSize: 13, color: "text.secondary" }}>{t("cubepilot.config.policyNoneNote")}</Box>
          )}
        </Box>
      </Card>

      {toastView}
    </Box>
  );
}

/** One labelled group of allowlist tags. Rules the caller owns carry a remove
 *  control; the hardcoded platform defaults are read-only. */
function AllowlistTagGroup({
  groupId,
  label,
  rules,
  hint,
  emptyText,
  removeLabel,
  busy,
  onRemove,
}: {
  groupId: string;
  label: string;
  rules: AllowlistRule[];
  hint?: string;
  emptyText?: string;
  removeLabel?: string;
  busy?: boolean;
  onRemove?: (key: string) => void;
}) {
  return (
    <Box data-od-id={groupId} sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <Box sx={{ fontSize: 11.5, color: "text.secondary" }}>
        {label}
        {hint ? <Box component="span" sx={{ ml: "6px" }}>{hint}</Box> : null}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {rules.map((r) => (
          <Box
            key={ruleKey(r)}
            data-od-id="cp-allowlist-tag"
            data-owned={r.owned ? "true" : "false"}
            title={[r.label || r.pattern, r.argPattern ? `argPattern: ${r.argPattern}` : ""].filter(Boolean).join("\n")}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              maxWidth: "100%",
              border: 1,
              borderColor: r.owned ? "color-mix(in oklch, var(--accent) 40%, var(--border))" : "divider",
              bgcolor: r.owned ? "var(--accent-soft)" : "var(--surface)",
              borderRadius: 999,
              p: "3px 9px",
            }}
          >
            {/* The tag shows the command; the human meaning (and the
                argPattern) live in the tooltip. */}
            <Box component="span" sx={{ ...monoSx, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.pattern}
            </Box>
            {r.owned && onRemove ? (
              <Box
                component="button"
                type="button"
                aria-label={removeLabel}
                disabled={busy}
                onClick={() => onRemove(ruleKey(r))}
                data-od-id="cp-allowlist-remove"
                sx={{
                  border: "none",
                  bgcolor: "transparent",
                  p: 0,
                  cursor: busy ? "default" : "pointer",
                  color: "text.secondary",
                  display: "flex",
                  "&:hover": { color: "text.primary" },
                }}
              >
                {Icons.close({ size: 12 })}
              </Box>
            ) : null}
          </Box>
        ))}
        {rules.length === 0 && emptyText ? <Box sx={{ fontSize: 12.5, color: "text.secondary" }}>{emptyText}</Box> : null}
      </Box>
    </Box>
  );
}

function InstRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      <Box sx={{ fontSize: 11.5, color: "text.secondary" }}>{k}</Box>
      <Box sx={{ fontSize: 13 }}>{v}</Box>
    </Box>
  );
}
