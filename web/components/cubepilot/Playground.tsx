"use client";

// Context cards for the model side of the unified chat surface, adapted from
// public/chat.html (sampling params). The sampling panel opens in a popover
// from the composer's params chip (see ChatPane).

import { Box } from "@mui/material";

import { monoSx } from "./ui";

/** Sampling params shown in the rail and used in the cURL snippet. */
export interface SampleParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

/** One sampling-parameter slider row in the params panel. */
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
    <Box
      sx={{
        p: "10px 4px",
        borderBottom: 1,
        borderColor: "divider",
        "&:last-child": { borderBottom: 0 },
      }}
    >
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

/** Small text button used inside the endpoint chip. */
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

/** 采样参数 panel: temperature / top_p / max_tokens sliders, shown in the
 *    popover opened by the composer's params chip. */
export function ParamsPanel({
  params,
  onChange,
}: {
  params: SampleParams;
  onChange: (patch: Partial<SampleParams>) => void;
}) {
  return (
    <Box data-od-id="params-card">
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
    </Box>
  );
}
