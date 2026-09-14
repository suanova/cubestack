// /api/cubepilot/llms/[name] — edit (PUT) or remove (DELETE) one catalog
// model. The name is the model's identity, so there is no rename.

import { deleteLlm, listLlms, updateLlm } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

function find(name: string) {
  return listLlms().find((m) => m.name === name);
}

export const PUT = withAuth<Ctx>(async (req, _session, ctx) => {
  const { name } = await ctx.params;
  if (!find(name)) {
    return Response.json({ error: `model "${name}" not found` }, { status: 404 });
  }
  let body: { endpoint?: string; apiKey?: string; public?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.public === false && body.apiKey === undefined) {
    return Response.json({ error: "enter apiKey or mark the endpoint public" }, { status: 400 });
  }
  const res = updateLlm(name, {
    endpoint: body.endpoint,
    // A blank key on edit keeps the current credential, so only an explicit
    // public flag changes the keyed state.
    keyed: body.public !== undefined ? !body.public : undefined,
  });
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  return Response.json({ model: find(name) });
});

export const DELETE = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { name } = await ctx.params;
  const res = deleteLlm(name);
  if (!res.ok) {
    const status = res.error?.includes("not found") ? 404 : 400;
    return Response.json({ error: res.error }, { status });
  }
  return Response.json({ removed: name });
});
