// /api/cubepilot/agent/confirm — confirmation policy + allowlist (GET/PUT),
// backed by the AgentInstance CR (spec.approvalPolicy = the policy override,
// spec.allowlist = the caller's OWN rules). The platform defaults are hardcoded
// in lib/cubepilot/allowlist.ts (reference: internal/allowlist), never stored on
// an instance: the view returns the effective list (defaults first, then the
// owned rules marked owned) and the PUT writes only the owned rules. The defaults
// are always in effect and the own rules only widen the list (decision note in
// lib/cubepilot/allowlist.ts: the enforcing runtime must evaluate
// defaults ∪ instance rules the same way). The HITL channel state is only known
// to the agent runtime, so it reads "unknown".

import {
  DEFAULT_AGENT_NAME,
  agentInstanceName,
  getAgentInstanceCr,
  getAgentTemplateCr,
  getOwnedAgentInstanceCr,
  k8sErrorResponse,
  patchAgentInstanceCr,
  type AllowlistRuleCr,
  type JsonPatchOp,
} from "@/lib/cubepilot/agentcrd";
import { effectiveAllowlist, ownedRules, validateRule } from "@/lib/cubepilot/allowlist";
import type { AllowlistRule, ConfirmView } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The policies the portal offers (the CRD also allows AlwaysAsk). */
const POLICIES = ["None", "Allowlist", "AlwaysAsk"];
/** The channel is runtime-only state; the CRD path cannot observe it. */
const CHANNEL_UNKNOWN = "unknown";
/** The template's policy when the CR does not carry one (the CRD default). */
const TEMPLATE_DEFAULT_POLICY = "Allowlist";

function toOwnedRule(r: AllowlistRuleCr): AllowlistRule {
  return {
    pattern: r.pattern ?? "",
    ...(r.argPattern ? { argPattern: r.argPattern } : {}),
    owned: true,
  };
}

async function confirmView(user: string): Promise<ConfirmView> {
  const [cr, tmpl] = await Promise.all([getOwnedAgentInstanceCr(user), getAgentTemplateCr(DEFAULT_AGENT_NAME)]);
  const override = cr?.spec?.approvalPolicy ?? "";
  const templatePolicy = tmpl?.spec?.approvalPolicy || TEMPLATE_DEFAULT_POLICY;
  return {
    exists: Boolean(cr),
    confirmPolicy: override || templatePolicy,
    templatePolicy,
    override,
    // Defaults are hardcoded; only the caller's own rules come from the CR.
    allowlist: effectiveAllowlist((cr?.spec?.allowlist ?? []).map(toOwnedRule)),
    channel: CHANNEL_UNKNOWN,
  };
}

export const GET = withAuth(async (_req, session) => {
  try {
    return Response.json(await confirmView(session.user));
  } catch (e) {
    return k8sErrorResponse(e);
  }
});

export const PUT = withAuth(async (req, session) => {
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
  if (body.allowlist !== undefined) {
    if (!Array.isArray(body.allowlist)) {
      return Response.json({ error: "allowlist must be an array" }, { status: 400 });
    }
    for (const r of body.allowlist) {
      if (!r || typeof r.pattern !== "string") {
        return Response.json({ error: "each allowlist rule needs a pattern string" }, { status: 400 });
      }
      if (r.argPattern !== undefined && typeof r.argPattern !== "string") {
        return Response.json({ error: "argPattern must be a string" }, { status: 400 });
      }
      // The reference API refuses these; the CRD has no CEL for them, so a
      // direct CR write would otherwise store a rule the runtime cannot apply.
      // Only a wrong TYPE is sanitized otherwise (empty patterns are dropped by
      // ownedRules), which is why an empty pattern is still refused here rather
      // than silently dropped.
      const reason = validateRule({ pattern: r.pattern, argPattern: r.argPattern });
      if (reason) {
        return Response.json({ error: reason }, { status: 400 });
      }
    }
  }
  try {
    const name = agentInstanceName(session.user);
    const cr = await getAgentInstanceCr(name);
    if (!cr) {
      return Response.json({ error: "provision your instance on the Agent Config page first" }, { status: 409 });
    }
    if (cr.spec?.owner !== session.user) {
      return Response.json({ error: "agent instance name already taken by another user" }, { status: 409 });
    }
    const ops: JsonPatchOp[] = [
      // "" = "follow the template": the CRD's approvalPolicy is enum-validated
      // (None | Allowlist | AlwaysAsk) and has no empty value, so the override is
      // cleared by REMOVING the field — the reference does the same through Go's
      // `omitempty`, which makes the field absent on update.
      ...(body.confirmPolicy === undefined
        ? []
        : body.confirmPolicy === ""
          ? cr.spec?.approvalPolicy !== undefined
            ? [{ op: "remove" as const, path: "/spec/approvalPolicy" }]
            : []
          : [{ op: "add" as const, path: "/spec/approvalPolicy", value: body.confirmPolicy }]),
      // Only the caller's own rules are persisted (sanitized: trimmed, deduped).
      ...(body.allowlist !== undefined
        ? [{ op: "add" as const, path: "/spec/allowlist", value: ownedRules(body.allowlist) }]
        : []),
    ];
    if (ops.length > 0) await patchAgentInstanceCr(name, ops);
    return Response.json(await confirmView(session.user));
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
