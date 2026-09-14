// /api/cubepilot/agent/config — the caller's assistant selections (GET/PUT).

import { getConfig, saveConfig } from "@/lib/cubepilot/store";
import { listLlms } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ config: getConfig() });
});

export const PUT = withAuth(async (req) => {
  let body: { config?: { model?: string; systemPrompt?: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const patch = body.config ?? {};
  if (patch.model !== undefined) {
    // The selected model must exist in the catalog ("" clears to default).
    if (patch.model && !listLlms().some((m) => m.name === patch.model)) {
      return Response.json({ error: `unknown model "${patch.model}"` }, { status: 400 });
    }
  }
  if (patch.systemPrompt !== undefined && typeof patch.systemPrompt !== "string") {
    return Response.json({ error: "systemPrompt must be a string" }, { status: 400 });
  }
  return Response.json({ config: saveConfig(patch) });
});
