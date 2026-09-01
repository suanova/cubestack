// Frontend-side descriptions for the provisioned dashboards, since their specs
// carry no display.description. Keyed by metadata.name (the dashboard route
// param) → a localized MessageKey; the landing page renders the description
// only when a mapping exists.
import type { MessageKey } from "@/lib/i18n";

export const DASHBOARD_DESCRIPTIONS: Record<string, MessageKey> = {
  "metax-gpu": "dash.desc.metax",
  "sglang-dashboard": "dash.desc.sglang",
  "nvidia-dcgm": "dash.desc.dcgm",
};
