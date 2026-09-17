#!/usr/bin/env node
// Zero-dependency OpenAI-compatible mock LLM for local development: serves
// GET /v1/models and POST /v1/chat/completions (SSE streaming) with a scripted
// reply, so the CubePilot playground chat window can be exercised without a
// real AI Gateway or model runtime.
//
// Usage:
//   node scripts/mock-llm.mjs [port]        # default 8899 (MOCK_LLM_PORT)
//   CUBESTACK_GATEWAT_URL=http://localhost:8899 npm run dev

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_LLM_PORT ?? 8899);
const MODEL_ID = "mock-glm-5.2-chat";

/** Scripted reply: echoes the user turn and reports the sampling params. */
function replyFor(messages, params) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return [
    `(mock ${MODEL_ID} 流式回复)`,
    `你说:「${last}」`,
    "这是一段脚本化回复,按小切片经 SSE 逐段推送,用来验证聊天窗口的流式渲染、采样参数面板与线程滚动。",
    `你设置的采样参数: temperature=${params.temperature}, top_p=${params.topP}, max_tokens=${params.maxTokens}。`,
  ].join("\n");
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "cubestack" }] }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      const params = {
        temperature: parsed.temperature ?? 0.7,
        topP: parsed.top_p ?? 0.9,
        maxTokens: parsed.max_tokens ?? 1024,
      };
      const text = replyFor(parsed.messages ?? [], params);
      const id = `chatcmpl-mock-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = parsed.model ?? MODEL_ID;

      if (!parsed.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
          }),
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta, finishReason) =>
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
          })}\n\n`,
        );
      chunk({ role: "assistant", content: "" });
      // Slice the reply into small pieces with a short delay to look like a
      // real model streaming.
      for (let i = 0; i < text.length; i += 3) {
        await new Promise((r) => setTimeout(r, 30));
        chunk({ content: text.slice(i, i + 3) });
      }
      chunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found (mock-llm serves /v1/models and /v1/chat/completions)" }));
});

server.listen(PORT, () => {
  console.log(`mock-llm: OpenAI-compatible mock on http://localhost:${PORT} (model: ${MODEL_ID})`);
});
