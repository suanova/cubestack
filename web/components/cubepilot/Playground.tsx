"use client";

// Context cards for the model side of the unified chat rail, adapted from
// public/chat.html (sampling params / cURL). Rendered by ChatPane while a
// gateway model is selected.

import { Box } from "@mui/material";

import { useI18n } from "@/lib/i18n";

import { Card, CardHead, monoSx } from "./ui";

/** Sampling params shown in the rail and used in the cURL snippet. */
export interface SampleParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

/** cURL snippet for the real gateway endpoint + selected model + params. */
export function gatewayCurl(endpoint: string, model: string, p: SampleParams): string {
  return (
    `curl -X POST \\\n  ${endpoint}/v1/chat/completions \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{\n    "model": "${model}",\n` +
    `    "messages": [{"role": "user", "content": "你好"}],\n` +
    `    "temperature": ${p.temperature},\n` +
    `    "max_tokens": ${p.maxTokens},\n` +
    `    "stream": true\n  }'`
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
        onChange={(v) => onChange({ maxTokens: v })}
      />
    </Card>
  );
}

/** API 调用 card: live cURL snippet with a copy button. */
export function ApiCard({
  endpoint,
  model,
  params,
  copied,
  onCopy,
}: {
  endpoint: string;
  model: string;
  params: SampleParams;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const curl = gatewayCurl(endpoint, model, params);
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
        <CopyBtn text={copied ? t("cubepilot.playground.copied") : t("cubepilot.playground.apiCopy")} onClick={onCopy} />
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
