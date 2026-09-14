// /api/cubepilot/playground/chat — a real chat completion, proxied to the AI
// Gateway's OpenAI-compatible POST /v1/chat/completions. The gateway's SSE
// stream is passed straight through to the browser; the browser accumulates
// the deltas. See lib/cubepilot/gateway.ts for base-URL resolution.

import { gatewayFetch } from "@/lib/cubepilot/gateway";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const POST = withAuth(async (req) => {
  let model = "";
  let messages: ChatMessage[] = [];
  let temperature: number | undefined;
  let topP: number | undefined;
  let maxTokens: number | undefined;
  try {
    const body = (await req.json()) as {
      model?: string;
      messages?: ChatMessage[];
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    };
    model = (body.model ?? "").trim();
    messages = Array.isArray(body.messages)
      ? body.messages.filter(
          (m): m is ChatMessage =>
            !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0,
        )
      : [];
    if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) temperature = body.temperature;
    if (typeof body.topP === "number" && Number.isFinite(body.topP)) topP = body.topP;
    if (typeof body.maxTokens === "number" && Number.isInteger(body.maxTokens) && body.maxTokens > 0) maxTokens = body.maxTokens;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!model) {
    return Response.json({ error: "model is required" }, { status: 400 });
  }
  if (messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }
  const payload: Record<string, unknown> = { model, messages, stream: true };
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;
  let upstream: Response;
  try {
    upstream = await gatewayFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: (req as { signal?: AbortSignal }).signal,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 300);
    return Response.json(
      { error: `gateway returned HTTP ${upstream.status}${detail ? `: ${detail}` : ""}` },
      { status: 502 },
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});
