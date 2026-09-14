// /api/cubepilot/playground/chat — a simulated one-shot inference against
// the selected service. Demo counterpart of an AI Gateway
// /v1/chat/completions call: the reply is returned whole and the client
// plays back the typed-out streaming effect.

import { playgroundChat } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuth(async (req) => {
  let service = "";
  let text = "";
  let turn = 0;
  try {
    const body = (await req.json()) as { service?: string; text?: string; turn?: number };
    service = (body.service ?? "").trim();
    text = (body.text ?? "").trim();
    turn = typeof body.turn === "number" && Number.isFinite(body.turn) ? body.turn : 0;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!service) {
    return Response.json({ error: "service is required" }, { status: 400 });
  }
  if (!text) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  const reply = playgroundChat(service, turn);
  if (reply === null) {
    return Response.json({ error: `service "${service}" not found` }, { status: 404 });
  }
  return Response.json({ reply: { text: reply } }, { status: 201 });
});
