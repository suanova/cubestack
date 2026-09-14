// /api/cubepilot/llms — the platform LLM catalog (GET) and add (POST).

import { addLlm, listLlms } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ llms: listLlms() });
});

export const POST = withAuth(async (req) => {
  let body: { name?: string; endpoint?: string; apiKey?: string; public?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // A keyless endpoint must be declared public (reference: a keyless provider
  // fails every turn, so the server refuses to guess).
  if (!body.apiKey && !body.public) {
    return Response.json({ error: "enter apiKey or mark the endpoint public" }, { status: 400 });
  }
  const res = addLlm({
    name: body.name ?? "",
    endpoint: body.endpoint ?? "",
    keyed: !body.public,
  });
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  const model = listLlms().find((m) => m.name === body.name?.trim())!;
  return Response.json({ model }, { status: 201 });
});
