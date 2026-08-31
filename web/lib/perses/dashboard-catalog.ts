// Frontend-side descriptions for the provisioned dashboards, since their specs
// carry no display.description. Keyed by metadata.name (the dashboard route
// param) → a localized MessageKey; the landing page renders the description
// only when a mapping exists.
import type { MessageKey } from "@/lib/i18n";

export const DASHBOARD_DESCRIPTIONS: Record<string, MessageKey> = {
  "kubernetes-cluster-resources-overview": "dash.desc.cluster",
  "kubernetes-node-resources-overview": "dash.desc.node",
  "metax-gpu": "dash.desc.metax",
  "sglang-dashboard": "dash.desc.sglang",
  "oxed_c6wz": "dash.desc.dcgm",
};
