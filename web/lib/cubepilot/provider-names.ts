// What a provider name means to the agent runtime.
//
// A provider's name is not a free-form label: it is the OpenClaw
// `models.providers` key the operator renders verbatim, and the prefix of every
// model ref. Some names therefore already mean something to the runtime, and
// picking one changes how the provider behaves. Two sets matter here:
//
//   RESERVED_PLUGIN_PROVIDERS -- names the runtime resolves through an official
//     plugin it installs at gateway startup. Where there is no internet the
//     install fails and the gateway refuses to report ready, so the assistant
//     never comes up. Source: OpenClaw's official external provider catalog
//     (scripts/lib/official-external-provider-catalog.json) at the version the
//     cubepilot agent image pins (suanova/cubepilot, deploy/openclaw-image.Dockerfile
//     OPENCLAW_IMAGE_TAG). Refresh these when that pin moves.
//
//   BUILTIN_PROVIDERS -- providers the runtime image integrates itself. Nothing
//     to install, but the runtime applies that provider's own protocol and
//     model-id rules, which can rewrite the id sent to the endpoint (see
//     agenttemplates.ai.cubestack.io spec.providers[].name).
//
// Every other name is a plain OpenAI-compatible provider: the runtime talks to
// the endpoint directly.

import { MAX_PROVIDER_NAME } from "./llm";

/** A name the runtime installs a plugin for -> the official provider it means. */
const RESERVED_PLUGIN_PROVIDERS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Amazon Bedrock",
  "amazon-bedrock-mantle": "Amazon Bedrock Mantle",
  "anthropic-vertex": "Anthropic Vertex",
  "arcee": "Arcee AI",
  "bailian-token-plan": "Alibaba Token Plan",
  "baseten": "Baseten",
  "byteplus": "BytePlus",
  "byteplus-plan": "BytePlus",
  "cerebras": "Cerebras",
  "chutes": "Chutes",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cohere": "Cohere",
  "comfy": "ComfyUI",
  "dashscope": "Qwen Cloud",
  "deepinfra": "DeepInfra",
  "deepseek": "DeepSeek",
  "featherless": "Featherless AI",
  "fireworks": "Fireworks",
  "fireworks-ai": "Fireworks",
  "gmi": "GMI Cloud",
  "gmi-cloud": "GMI Cloud",
  "gmicloud": "GMI Cloud",
  "groq": "Groq",
  "kilocode": "Kilo Gateway",
  "kimi": "Kimi Coding",
  "kimi-coding": "Kimi Coding",
  "longcat": "LongCat",
  "meituan-longcat": "LongCat",
  "meta": "Meta",
  "mistral": "Mistral",
  "modelstudio": "Qwen Cloud",
  "moonshot": "Moonshot",
  "moonshot-ai": "Moonshot",
  "moonshotai": "Moonshot",
  "novita": "NovitaAI",
  "novita-ai": "NovitaAI",
  "novitaai": "NovitaAI",
  "opencode": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "pixverse": "PixVerse",
  "qianfan": "Qianfan",
  "qwen": "Qwen Cloud",
  "qwen-token-plan": "Qwen Token Plan",
  "qwencloud": "Qwen Cloud",
  "stepfun": "StepFun",
  "stepfun-plan": "StepFun",
  "synthetic": "Synthetic",
  "tencent-tokenhub": "Tencent TokenHub",
  "tencent-tokenplan": "Tencent TokenPlan",
  "venice": "Venice",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "volcengine": "Volcengine",
  "volcengine-plan": "Volcengine Plan",
  "voyage": "Voyage",
  "vydra": "Vydra",
  "xiaomi": "Xiaomi",
  "xiaomi-token-plan": "Xiaomi Token Plan",
  "z-ai": "Z.AI",
  "zai": "Z.AI",
};

/** Providers the agent runtime image carries an integration for. */
const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "clawrouter",
  "copilot-proxy",
  "fal",
  "github-copilot",
  "google",
  "google-gemini-cli",
  "google-vertex",
  "huggingface",
  "litellm",
  "lmstudio",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "nvidia",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode-go",
  "openrouter",
  "sglang",
  "together",
  "vllm",
  "xai",
]);

export type ProviderNameKind = "reserved-plugin" | "builtin" | "custom";

export interface ProviderNameNotice {
  kind: ProviderNameKind;
  /** The official provider a reserved name means ("reserved-plugin" only). */
  provider?: string;
  /** A name that keeps the intent without meaning anything to the runtime. */
  suggestion?: string;
}

/** What the agent runtime makes of a provider name (already sanitized). */
export function providerNameNotice(name: string): ProviderNameNotice {
  const id = name.trim().toLowerCase();
  // Builtin first: a provider the image integrates itself needs nothing
  // installed, even when the official catalog also lists it (opencode-go).
  if (BUILTIN_PROVIDERS.has(id)) return { kind: "builtin" };
  const provider = RESERVED_PLUGIN_PROVIDERS[id];
  if (provider) {
    const base = id.slice(0, MAX_PROVIDER_NAME - 6).replace(/-+$/, "");
    return { kind: "reserved-plugin", provider, suggestion: `${base}-proxy` };
  }
  return { kind: "custom" };
}
