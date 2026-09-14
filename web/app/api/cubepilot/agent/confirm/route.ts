// /api/cubepilot/agent/confirm — confirmation policy + allowlist (GET/PUT).
// The PUT body carries the full desired owned state (reference issue #116).

import { getConfirm, saveConfirm } from "@/lib/cubepilot/store";
import type { AllowlistRule } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLICIES = ["Allowlist", "AlwaysAsk", "None"];

export const GET = withAuth(async () => {
  return Response.json(getConfirm());
});

export const PUT = withAuth(async (req) => {
  let body: { confirmPolicy?: string; allowlist?: AllowlistRule[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // "" / omitted = follow the template default.
  if (body.confirmPolicy !== undefined && body.confirmPolicy !== "" && !POLICIES.includes(body.confirmPolicy)) {
    return Response.json({ error: `invalid confirmPolicy "${body.confirmPolicy}"` }, { status: 400 });
  }
  return Response.json(saveConfirm(body));
});
