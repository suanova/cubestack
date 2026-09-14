// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetStore,
  addLlm,
  agentChips,
  agentGreeting,
  agentScenario,
  createSession,
  deleteLlm,
  getAgentDemo,
  getConfirm,
  getConfig,
  getSession,
  getStatus,
  listLlms,
  listMessages,
  listSessions,
  listSkills,
  modelChips,
  saveConfig,
  saveConfirm,
  sendUserMessage,
  setSkillEnabled,
  updateLlm,
} from "./store";

beforeEach(() => {
  vi.useFakeTimers();
  __resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("seeded demo state", () => {
  it("seeds three sessions in display order", () => {
    expect(listSessions().map((s) => s.sessionKey)).toEqual([
      "agent:main-gpu-temp-0826",
      "agent:main-cluster-0825",
      "agent:main-isvc-0824",
    ]);
    expect(getSession("agent:main-gpu-temp-0826")?.messages).toHaveLength(2);
  });

  it("seeds llms, config, confirm rules and skills", () => {
    expect(listLlms().map((m) => m.name)).toEqual(["glm-5.2-chat", "qwen2.5-72b", "deepseek-v4"]);
    expect(getConfig().model).toBe("glm-5.2-chat");
    const confirm = getConfirm();
    expect(confirm.confirmPolicy).toBe("Allowlist");
    // 1 owned rule + 6 platform rules.
    expect(confirm.allowlist).toHaveLength(7);
    expect(confirm.allowlist.find((r) => r.pattern === "helm upgrade")?.owned).toBe(true);
    expect(confirm.allowlist.filter((r) => !r.owned)).toHaveLength(6);
    expect(listSkills()).toHaveLength(6);
    expect(listSkills().find((s) => s.name === "devenv-ops")?.enabled).toBe(false);
  });
});

describe("sessions", () => {
  it("creates a session that appears first in the list", () => {
    const key = createSession();
    expect(key).toMatch(/^agent:main-s-/);
    expect(listSessions()[0].sessionKey).toBe(key);
    expect(listMessages(key)).toEqual([]);
  });

  it("appends the simulated reply and derives the title from the first message", () => {
    const key = createSession();
    const res = sendUserMessage(key, "帮我做一次集群巡检");
    expect(res.reply?.text).toContain("| 类别 | 结果 |");
    expect(res.reply?.tools?.[0].name).toBe("kubectl");
    expect(listMessages(key).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(getSession(key)?.title).toBe("帮我做一次集群巡检");
  });

  it("truncates long titles at 24 characters", () => {
    const key = createSession();
    const longText = "这是一个非常非常非常非常非常非常非常非常非常长的巡检请求啊"; // 31 chars
    sendUserMessage(key, longText);
    expect(longText.length).toBeGreaterThan(24);
    expect(getSession(key)?.title).toBe(longText.slice(0, 24) + "…");
  });

  it("returns a null reply for unknown sessions", () => {
    expect(sendUserMessage("agent:main-nope", "hi").reply).toBeNull();
  });
});

describe("llm catalog", () => {
  it("guards add/update/delete", () => {
    expect(addLlm({ name: "", endpoint: "https://x/v1", keyed: true })).toEqual({ ok: false, error: "name required" });
    expect(addLlm({ name: "m", endpoint: " ", keyed: true })).toEqual({ ok: false, error: "endpoint required" });
    expect(addLlm({ name: "glm-5.2-chat", endpoint: "https://x/v1", keyed: true })).toEqual({
      ok: false,
      error: 'model "glm-5.2-chat" already exists',
    });

    expect(addLlm({ name: "new-model", endpoint: "https://x/v1", keyed: false })).toEqual({ ok: true });
    expect(listLlms().at(-1)).toEqual({ name: "new-model", endpoint: "https://x/v1", keyed: false });

    expect(updateLlm("new-model", { endpoint: "https://y/v1" })).toEqual({ ok: true });
    expect(listLlms().find((m) => m.name === "new-model")?.endpoint).toBe("https://y/v1");
    // A blank endpoint keeps the current value.
    expect(updateLlm("new-model", { endpoint: "  " })).toEqual({ ok: true });
    expect(listLlms().find((m) => m.name === "new-model")?.endpoint).toBe("https://y/v1");
    expect(updateLlm("nope", { endpoint: "https://y/v1" })).toEqual({ ok: false, error: 'model "nope" not found' });

    // The model selected by the instance cannot be deleted.
    expect(deleteLlm("glm-5.2-chat")).toEqual({ ok: false, error: 'model "glm-5.2-chat" is selected by your instance' });
    expect(deleteLlm("new-model")).toEqual({ ok: true });
    expect(deleteLlm("new-model")).toEqual({ ok: false, error: 'model "new-model" not found' });
  });
});

describe("config / status / confirm / skills", () => {
  it("saves the config patch", () => {
    const saved = saveConfig({ model: "deepseek-v4", systemPrompt: "custom prompt" });
    expect(getConfig().model).toBe("deepseek-v4");
    expect(getConfig().systemPrompt).toBe("custom prompt");
    // An empty-string prompt clears it.
    expect(saveConfig({ systemPrompt: "" }).systemPrompt).toBe("");
    expect(saved.exists).toBe(true);
  });

  it("reports the instance status for the caller", () => {
    const st = getStatus("tester");
    expect(st.exists).toBe(true);
    expect(st.id).toBe("agent-tester");
    expect(st.phase).toBe("Ready");
    expect(st.user).toBe("tester");
    expect(st.uptimeSeconds).toBe(2 * 24 * 3600 + 5 * 3600);
    expect(st.gatewayImage).toBe("cubestack/cubepilot-gateway:v1.4.0");
  });

  it("saves the confirm override and owned rules only", () => {
    const view = getConfirm();
    const saved = saveConfirm({ confirmPolicy: "AlwaysAsk", allowlist: view.allowlist });
    expect(saved.override).toBe("AlwaysAsk");
    expect(saved.confirmPolicy).toBe("AlwaysAsk");
    // Platform rules are dropped from the owned state but re-merged on read.
    expect(saved.allowlist.filter((r) => r.owned)).toHaveLength(1);
    expect(saved.allowlist).toHaveLength(7);

    // Reset to the template default.
    const reset = saveConfirm({ confirmPolicy: "", allowlist: [] });
    expect(reset.override).toBe("");
    expect(reset.confirmPolicy).toBe("Allowlist"); // falls back to templatePolicy
    expect(reset.allowlist.filter((r) => r.owned)).toHaveLength(0);
  });

  it("toggles skills by name", () => {
    setSkillEnabled("devenv-ops", true);
    expect(listSkills().find((s) => s.name === "devenv-ops")?.enabled).toBe(true);
    setSkillEnabled("devenv-ops", false);
    expect(listSkills().find((s) => s.name === "devenv-ops")?.enabled).toBe(false);
    // Unknown skills are a no-op.
    expect(setSkillEnabled("nope", true)).toEqual(listSkills());
  });

});

describe("unified chat: agent demo content", () => {
  it("exposes the CubePilot profile, tool whitelist and recent calls", () => {
    const demo = getAgentDemo();
    expect(demo.agent).toMatchObject({
      id: "cubepilot",
      name: "CubePilot",
      role: "智能运维 Agent",
      heartbeat: 12,
      ro: 34,
      rw: 8,
    });
    // 14 listed rows; the rail total shows the full 42 (ro + rw).
    expect(demo.tools).toHaveLength(14);
    expect(demo.tools.filter((t) => t.scope === "rw")).toHaveLength(6);
    expect(demo.agent.ro + demo.agent.rw).toBe(42);
    expect(demo.calls).toHaveLength(6);
    expect(demo.calls.at(-1)).toEqual({ time: "09:36:47", tool: "workflow.create", scope: "rw" });
  });

  it("plays a greeting ending in a meta line", () => {
    const blocks = agentGreeting();
    expect(blocks).toHaveLength(3);
    expect(blocks[0].p).toContain("CubePilot");
    expect(blocks.at(-1)?.meta).toContain("会话审计已开启");
  });

  it("returns the ceph scenario with actions that carry canned results", () => {
    const blocks = agentScenario("ceph");
    expect(blocks.some((b) => b.cmd?.includes("ceph pg stat"))).toBe(true);
    const actionBlock = blocks.find((b) => b.actions);
    expect(actionBlock?.actions).toHaveLength(2);
    const primary = actionBlock?.actions?.[0];
    expect(primary?.primary).toBe(true);
    expect(primary?.label).toBe("执行只读诊断");
    expect(primary?.doneLabel).toBe("已执行");
    // Clicking the action appends an output block + a follow-up paragraph.
    expect(primary?.results.some((r) => r.out?.includes("osd.7"))).toBe(true);
    expect(primary?.results.at(-1)?.p).toContain("reweight-by-utilization");
  });

  it("covers the other scenarios and falls back to the generic reply", () => {
    expect(agentScenario("gpu-temp").some((b) => b.p?.includes("风扇"))).toBe(true);
    expect(agentScenario("pre-upgrade").at(-1)?.meta).toContain("pre-upgrade-check");
    const generic = agentScenario(null);
    expect(generic).toHaveLength(3);
    expect(generic.at(-1)?.meta).toContain("工具白名单 42 项");
    // Unknown keys also fall back to the generic reply.
    expect(agentScenario("nope")).toEqual(generic);
  });

  it("returns fresh clones so playback state cannot leak", () => {
    const a = agentScenario("ceph");
    const b = agentScenario("ceph");
    a[0].p = "mutated";
    a.find((x) => x.actions)?.actions?.[0].results.push({ p: "injected" });
    expect(b[0].p).not.toBe("mutated");
    expect(b.find((x) => x.actions)?.actions?.[0].results).toHaveLength(2);
  });

  it("provides quick chips for both object types", () => {
    expect(modelChips()).toHaveLength(3);
    expect(modelChips().map((c) => c.key)).toEqual([undefined, undefined, undefined]);
    const agentChipsList = agentChips();
    expect(agentChipsList).toHaveLength(3);
    expect(agentChipsList.map((c) => c.key)).toEqual(["ceph", "gpu-temp", "pre-upgrade"]);
  });
});
