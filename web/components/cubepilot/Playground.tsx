"use client";

// Context cards for the model side of the unified chat rail, adapted from
// public/chat.html (sampling params / service metrics / cURL). Rendered by
// ChatPane while an inference-service object is selected.

import { Box } from "@mui/material";

import type { PlaygroundService } from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import { Card, CardHead, monoSx } from "./ui";

export const GATEWAY_BASE = "https://gateway.cubestack.local";

/** Sampling params shown in the rail and used in the cURL snippet. */
export interface SampleParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

/** Model endpoint at the AI Gateway. */
export function gatewayEndpoint(svc: PlaygroundService): string {
  return `${GATEWAY_BASE}/v1/models/${svc.name}`;
}

/** Illustrative cURL snippet for a service + params (the $CUBE_TOKEN form). */
export function gatewayCurl(svc: PlaygroundService, p: SampleParams): string {
  return (
    `curl -X POST \\\n  ${GATEWAY_BASE}/v1/chat/completions \\\n` +
    `  -H "Authorization: Bearer $CUBE_TOKEN" \\\n  -H "Content-Type: application/json" \\\n` +
    `  -d '{\n    "model": "${svc.name}",\n` +
    `    "messages": [{"role": "user", "content": "你好"}],\n` +
    `    "temperature": ${p.temperature},\n` +
    `    "max_tokens": ${p.maxTokens}\n  }'`
  );
}

/** One sampling-parameter slider row in the params card. */
function SliderRow({
  id,
  label,
  min,
  max,
  step,
  value,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Box sx={{ p: "14px 18px", borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", mb: "8px" }}>
        <Box component="label" htmlFor={id} sx={{ fontSize: 12.5, fontWeight: 550 }}>
          {label}
        </Box>
        <Box component="output" sx={{ ...monoSx, fontSize: 12 }}>
          {value}
        </Box>
      </Box>
      <Box
        component="input"
        type="range"
        id={id}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        sx={{ width: "100%", accentColor: "var(--accent)", height: 22 }}
      />
      {hint ? <Box sx={{ fontSize: 11, color: "text.secondary", mt: "6px" }}>{hint}</Box> : null}
    </Box>
  );
}

/** One metric cell of the 2×2 service-metrics grid. */
function MetricCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <Box
      sx={{
        p: "12px 18px",
        borderBottom: 1,
        borderColor: "divider",
        "&:nth-child(odd)": { borderRight: 1 },
        "&:nth-last-child(-n+2)": { borderBottom: 0 },
      }}
    >
      <Box sx={{ fontSize: 11, color: "text.secondary" }}>{label}</Box>
      <Box sx={{ ...monoSx, fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", mt: "3px" }}>
        {value}
        {unit ? (
          <Box component="small" sx={{ fontSize: 11, fontWeight: 400, color: "text.secondary" }}>
            {unit}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** Small text button used inside the endpoint chip and the cURL card head. */
export function CopyBtn({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        border: 0,
        bg: "transparent",
        color: "var(--accent-strong)",
        ...monoSx,
        fontSize: 11,
        fontWeight: 550,
        p: 0,
        cursor: "pointer",
        flex: "none",
        "&:hover": { textDecoration: "underline", textUnderlineOffset: 3 },
      }}
    >
      {text}
    </Box>
  );
}

/** 采样参数 card: temperature / top_p / max_tokens sliders. */
export function ParamsCard({
  params,
  onChange,
}: {
  params: SampleParams;
  onChange: (patch: Partial<SampleParams>) => void;
}) {
  const { t } = useI18n();
  return (
    <Card data-od-id="params-card">
      <CardHead title={t("cubepilot.playground.paramsTitle")} hint={t("cubepilot.playground.paramsSession")} />
      <SliderRow
        id="pg-temperature"
        label="temperature"
        min={0}
        max={2}
        step={0.1}
        value={params.temperature}
        onChange={(v) => onChange({ temperature: v })}
      />
      <SliderRow
        id="pg-topP"
        label="top_p"
        min={0}
        max={1}
        step={0.05}
        value={params.topP}
        onChange={(v) => onChange({ topP: v })}
      />
      <SliderRow
        id="pg-maxTokens"
        label="max_tokens"
        min={128}
        max={4096}
        step={128}
        value={params.maxTokens}
        hint={t("cubepilot.playground.maxTokensHint")}
        onChange={(v) => onChange({ maxTokens: v })}
      />
    </Card>
  );
}

/** 服务指标 card: QPS / P95 / throughput / replicas of the selected service. */
export function MetricsCard({ svc }: { svc: PlaygroundService | null }) {
  const { t } = useI18n();
  return (
    <Card data-od-id="metrics-card">
      <CardHead title={t("cubepilot.playground.metricsTitle")} hint={t("cubepilot.playground.metricsWindow")} />
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <MetricCell label={t("cubepilot.playground.metricsQps")} value={svc ? String(svc.qps) : "—"} />
        <MetricCell label={t("cubepilot.playground.metricsP95")} value={svc ? String(svc.p95Ms) : "—"} unit=" ms" />
        <MetricCell
          label={t("cubepilot.playground.metricsTps")}
          value={svc ? svc.tps.toLocaleString("en-US") : "—"}
          unit=" /s"
        />
        <MetricCell
          label={t("cubepilot.playground.metricsReplicas")}
          value={svc ? svc.replicas.split(" /")[0] : "—"}
          unit={svc ? ` / ${svc.replicas.split(" /")[1]}` : undefined}
        />
      </Box>
    </Card>
  );
}

/** API 调用 card: live cURL snippet with a copy button. */
export function ApiCard({
  svc,
  params,
  copied,
  onCopy,
}: {
  svc: PlaygroundService | null;
  params: SampleParams;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const curl = svc ? gatewayCurl(svc, params) : "";
  return (
    <Card data-od-id="api-card">
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: "18px",
          py: "10px",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ fontSize: 12.5, fontWeight: 600 }}>{t("cubepilot.playground.apiTitle")}</Box>
        {svc ? (
          <CopyBtn text={copied ? t("cubepilot.playground.copied") : t("cubepilot.playground.apiCopy")} onClick={onCopy} />
        ) : null}
      </Box>
      <Box
        data-od-id="pg-curl"
        sx={{
          m: 0,
          bg: "text.primary",
          color: "background.default",
          px: "18px",
          py: "14px",
          ...monoSx,
          fontSize: 11.5,
          lineHeight: 1.7,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {curl}
      </Box>
    </Card>
  );
}
