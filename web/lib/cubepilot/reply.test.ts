// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildReply } from "./reply";

describe("buildReply", () => {
  it("matches the GPU temperature scenario", () => {
    const r = buildReply("gpu-nvidia-02 的 GPU 温度偏高,帮我看看原因");
    expect(r.text).toContain("风扇 #2");
    expect(r.tools?.map((t) => t.name)).toEqual(["kubectl", "dcgm"]);
    expect(r.tools?.[1].cmd).toContain("dcgm dmon");
  });

  it("matches the pod crashloop scenario", () => {
    const r = buildReply("prometheus-adapter 的 pod 一直在重启");
    expect(r.text).toContain("CrashLoopBackOff");
    expect(r.tools?.[0].cmd).toContain("kubectl get pods");
  });

  it("matches the inference scaling scenario", () => {
    const r = buildReply("glm-5.2-chat 想扩到 4 副本,资源够吗?");
    expect(r.text).toContain("qwen2.5-72b");
    expect(r.tools?.[0].cmd).toContain("kubectl get isvc");
  });

  it("matches the dev-environment scenario", () => {
    const r = buildReply("帮我看看我的开发环境");
    expect(r.text).toContain("jupyter-nlp-ln");
    expect(r.tools?.[0].cmd).toContain("kubectl get devenv");
  });

  it("matches the certificate expiry scenario", () => {
    const r = buildReply("网关证书什么时候过期?");
    expect(r.text).toContain("28 天后到期");
    expect(r.tools?.[0].name).toBe("openssl");
  });

  it("matches the cluster inspection scenario with a markdown table", () => {
    const r = buildReply("帮我做一次集群巡检");
    expect(r.text).toContain("| 类别 | 结果 |");
    expect(r.tools?.map((t) => t.name)).toEqual(["kubectl", "ceph"]);
  });

  it("prefers the GPU scenario over the generic inspection scenario", () => {
    // "温度" is a GPU keyword and appears before the inspection scenario.
    const r = buildReply("GPU 温度巡检");
    expect(r.tools?.[1].name).toBe("dcgm");
  });

  it("falls back to the default capability introduction without tools", () => {
    const r = buildReply("你好");
    expect(r.tools).toBeUndefined();
    expect(r.text).toContain("CubeStack 智能助手");
  });
});
