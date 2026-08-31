import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardsPage from "./page";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform. Render next/link as a plain
// anchor so the page renders without router context (the card grid is built
// with <Box component={Link} />).
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) =>
    createElement("a", { href }, children),
}));

const { fetchDashboards } = vi.hoisted(() => ({ fetchDashboards: vi.fn() }));

vi.mock("@/lib/perses/perses-client", () => ({ fetchDashboards }));

describe("dashboards landing page", () => {
  beforeEach(() => {
    // Pin the platform locale to zh-CN so assertions don't depend on jsdom's
    // navigator.language ("en-US" by default) flipping the default locale.
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    // React 18's act() warns without this testing-environment flag.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    fetchDashboards.mockReset();
    document.body.innerHTML = "";
  });

  function renderPage() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(DashboardsPage));
    });
    return { container, root };
  }

  it("shows a spinner in flight, then a localized empty state for an empty list", async () => {
    let resolveList!: (dashboards: unknown[]) => void;
    fetchDashboards.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    const { container, root } = renderPage();
    // Request unresolved → still loading, even though dashboards.length === 0.
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();

    await act(async () => {
      resolveList([]);
    });

    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain("暂无看板");
    act(() => root.unmount());
  });

  it("renders a card per dashboard when the list is non-empty", async () => {
    fetchDashboards.mockResolvedValue([
      { metadata: { name: "metax-gpu" }, spec: { display: { name: "MetaX GPU" } } },
      {
        metadata: { name: "kubernetes-cluster-resources-overview" },
        spec: { display: { name: "Cluster Overview" } },
      },
    ]);

    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).toContain("MetaX GPU");
    expect(container.textContent).toContain("Cluster Overview");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => root.unmount());
  });

  it("renders the localized error message when the request fails", async () => {
    fetchDashboards.mockRejectedValue(new Error("boom"));

    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).toContain("加载看板列表失败: boom");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => root.unmount());
  });
});
