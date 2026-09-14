// /api/cubepilot/sessions/[key]/messages — history (GET) and a new user
// message with its simulated assistant reply (POST).

import {
  getSession,
  listMessages,
  sendUserMessage,
} from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

export const GET = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { key } = await ctx.params;
  if (!getSession(key)) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ items: listMessages(key) });
});

export const POST = withAuth<Ctx>(async (req, _session, ctx) => {
  const { key } = await ctx.params;
  if (!getSession(key)) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  let text = "";
  try {
    const body = (await req.json()) as { text?: string };
    text = (body.text ?? "").trim();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!text) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  const { reply } = sendUserMessage(key, text);
  if (!reply) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ reply }, { status: 201 });
});
