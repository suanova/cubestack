import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OverviewPage from "./page";
import { overviewSummary as summary } from "@/test/fixtures/overview";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform. Render next/link as a plain
// anchor so the page renders without router context (the clickable KPI cards
// are built with <Box component={Link} />).
vi.mock("next/link", () => ({
  // Pass all props through so data-od-id stays on the anchor (the clickable
  // KPI cards carry their test hook via <Box component={Link} data-od-id />).
  default: (props: Record<string, unknown>) => createElement("a", props),
}));

vi.mock("@/lib/perses/theme", () => ({
  platformPalette: {
    light: { accent: "#1677ff", bg: "#ffffff", surface: "#f7f8fa", fg: "#111111", muted: "#6b7280", border: "#d9dee7" },
    dark: { accent: "#1677ff", bg: "#111111", surface: "#1f1f1f", fg: "#ffffff", muted: "#9ca3af", border: "#34373c" },
  },
  usePlatformTheme: () => "light",
}));

function cardText(container: HTMLElement, dataOdId: string): string {
  return container.querySelector(`[data-od-id="${dataOdId}"]`)?.textContent ?? "";
}

describe("overview landing page", () => {
  beforeEach(() => {
    // Pin the platform locale to zh-CN so assertions don't depend on jsdom's
    // navigator.language ("en-US" by default) flipping the default locale.
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    // jsdom's canvas is unimplemented; the trend chart must no-op cleanly.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function renderPage() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(OverviewPage));
    });
    return { container, root };
  }

  function stubOverview(payload: object, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => payload })),
    );
  }

  it("shows a loading state until the cluster request resolves", () => {
    stubOverview(summary());
    const { container, root } = renderPage();

    expect(container.querySelector('[data-od-id="overview-loading"]')).not.toBeNull();
    expect(container.textContent).toContain("加载中…");

    act(() => root.unmount());
  });

  it("renders the KPI row with live-cluster values and a real subtitle", async () => {
    stubOverview(summary());
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).toContain("Kubernetes v1.29 · 16 节点");

    // 节点总数 is the first card (replaces the prototype's 活跃告警). It links
    // to the /dashboards landing with Resource Overview preselected: the full
    // per-node CPU/GPU/Memory/RDMA usage rows.
    expect(cardText(container, "kpi-nodes")).toContain("节点总数");
    expect(cardText(container, "kpi-nodes")).toContain("16");
    expect(cardText(container, "kpi-nodes")).toContain("Ready 15 · NotReady 1");
    expect(container.querySelector('[data-od-id="kpi-nodes"]')?.getAttribute("href")).toBe(
      "/dashboards?dashboard=resource-overview-dashboard",
    );

    expect(cardText(container, "kpi-gpu")).toContain("GPU 卡总数");
    expect(cardText(container, "kpi-gpu")).toContain("128");
    expect(cardText(container, "kpi-gpu")).toContain("2 品牌");
    expect(cardText(container, "kpi-gpu")).toContain("当前利用率 62% · 显存 58%");
    // The GPU card lands GPU-scoped on Resource Overview (?scope=gpu): the node
    // CPU/Memory/RDMA rows are dropped on arrival, leaving per-GPU panels.
    expect(container.querySelector('[data-od-id="kpi-gpu"]')?.getAttribute("href")).toBe(
      "/dashboards?dashboard=resource-overview-dashboard&scope=gpu",
    );

    expect(cardText(container, "kpi-inference")).toContain("推理服务");
    expect(cardText(container, "kpi-inference")).toContain("12");
    expect(cardText(container, "kpi-inference")).toContain("就绪 11 · 扩缩容中 1");
    // The inference card links to the /dashboards landing with Inference Service
    // preselected.
    expect(container.querySelector('[data-od-id="kpi-inference"]')?.getAttribute("href")).toBe(
      "/dashboards?dashboard=inference-service-dashboard",
    );

    expect(cardText(container, "kpi-devenv")).toContain("开发环境");
    expect(cardText(container, "kpi-devenv")).toContain("8");
    expect(cardText(container, "kpi-devenv")).toContain("运行中 5 · 已停止 3");
    // The dev-env card links to the /dashboards landing with the Dev Environment
    // dashboard preselected (cluster-wide GPU/CPU/memory/network/storage usage).
    expect(container.querySelector('[data-od-id="kpi-devenv"]')?.getAttribute("href")).toBe(
      "/dashboards?dashboard=dev-environment-dashboard",
    );

    act(() => root.unmount());
  });

  it("renders the utilization trend and allocation cards from live data", async () => {
    stubOverview(summary());
    const { container, root } = renderPage();
    await act(async () => {});

    const trend = cardText(container, "gpu-trend-card");
    expect(trend).toContain("GPU 集群利用率 · 近 24 小时");
    expect(trend).toContain("算力利用率 62%");
    expect(trend).toContain("显存占用 58%");
    expect(container.querySelector('[data-od-id="trend-empty"]')).toBeNull();

    const alloc = cardText(container, "gpu-alloc-card");
    expect(alloc).toContain("GPU 资源分配");
    expect(alloc).toContain("共 128 卡");
    expect(alloc).toContain("已分配 / 卡");
    expect(alloc).toContain("计算池(训练/开发)");
    expect(alloc).toContain("推理池(vLLM/SGLang)");
    expect(alloc).toContain("空闲可调度");
    expect(alloc).toContain("50");
    expect(alloc).toContain("30");
    expect(alloc).toContain("48");

    act(() => root.unmount());
  });

  it("shows the trend empty state and hides the GPU foot when Prometheus has no data", async () => {
    stubOverview(summary({ trend: null }));
    const { container, root } = renderPage();
    await act(async () => {});

    const empty = container.querySelector('[data-od-id="trend-empty"]');
    expect(empty?.textContent).toContain("暂无监控数据");
    // The GPU card keeps its count and vendor meta, but no fabricated util/mem.
    expect(cardText(container, "kpi-gpu")).toContain("128");
    expect(cardText(container, "kpi-gpu")).toContain("2 品牌");
    expect(cardText(container, "kpi-gpu")).not.toContain("当前利用率");

    act(() => root.unmount());
  });

  it("polls /api/overview every 30s and pauses while the tab is hidden", async () => {
    vi.useFakeTimers();
    const first = summary();
    const second = summary({ trend: null });
    const third = summary({ trend: null });
    second.nodes.total = 17;
    third.nodes.total = 18;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const payload = [first, second, third][Math.min(calls, 2)];
        calls += 1;
        return { ok: true, status: 200, json: async () => payload };
      }),
    );

    const { container, root } = renderPage();
    await act(async () => {});
    expect(calls).toBe(1);
    expect(container.textContent).toContain("16");

    // First poll: a fresh cluster snapshot replaces the rendered values.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    expect(container.textContent).toContain("17");

    // Hidden tab: the interval is cleared, no further fetches.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(calls).toBe(2);

    // Visible again: polling resumes from the next tick.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(calls).toBe(3);
    expect(container.textContent).toContain("18");

    act(() => root.unmount());
  });

  it("shows an error with a retry button when the cluster request fails", async () => {
    stubOverview({ error: "Failed to load overview" }, false);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="overview-error"]')).not.toBeNull();
    expect(cardText(container, "overview-error")).toContain("加载失败");
    expect(cardText(container, "overview-error")).toContain("重试");
    expect(container.querySelector('[data-od-id="kpi-row"]')).toBeNull();

    act(() => root.unmount());
  });
});
