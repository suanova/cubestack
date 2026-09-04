import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardsPage from "./page";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform. The perses island mounts a
// standalone react-18 bundle (scripts + createRoot into the host div), which
// jsdom can't run; stub it with a marker div so we can assert which dashboard
// is being shown.
vi.mock("@/components/perses/PersesIslandHost", () => ({
  PersesIslandHost: ({ dashboardName }: { dashboardName: string }) =>
    createElement("div", { "data-od-id": "dash-viewer" }, `dashboard:${dashboardName}`),
}));

const { fetchDashboards, fetchDashboard } = vi.hoisted(() => ({
  fetchDashboards: vi.fn(),
  fetchDashboard: vi.fn(),
}));

vi.mock("@/lib/perses/perses-client", () => ({ fetchDashboards, fetchDashboard }));

const DASHBOARDS = [
  {
    metadata: { name: "metax-gpu" },
    spec: { display: { name: "MetaX GPU", description: "MetaX accelerator: utilization, temperature, power and clocks" } },
  },
  {
    metadata: { name: "kubernetes-cluster-resources-overview" },
    spec: { display: { name: "Cluster Overview", description: "Cluster resource usage at a glance" } },
  },
];

function viewerText(container: HTMLElement): string {
  return container.querySelector('[data-od-id="dash-viewer"]')?.textContent ?? "";
}

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
    fetchDashboard.mockReset();
    document.body.innerHTML = "";
  });

  function renderPage(searchParams?: Promise<{ [key: string]: string | string[] | undefined }>) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(DashboardsPage, searchParams ? { searchParams } : {}));
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
    // No dropdown, no viewer when the list is empty.
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(viewerText(container)).toBe("");
    act(() => root.unmount());
  });

  it("renders a dropdown defaulting to the first dashboard and its panels", async () => {
    fetchDashboards.mockResolvedValue(DASHBOARDS);
    fetchDashboard.mockResolvedValue({ metadata: { name: "metax-gpu" }, spec: {} });

    const { container, root } = renderPage();
    await act(async () => {});

    // The dropdown is present with the localized label.
    expect(container.textContent).toContain("选择看板");
    // Default selection = first dashboard; its panels render below.
    expect(fetchDashboard).toHaveBeenCalledWith("perses-dev", "metax-gpu");
    expect(viewerText(container)).toContain("dashboard:metax-gpu");
    // The select's current value is the first dashboard's display name, and the
    // description is read straight off the dashboard resource (spec.display).
    expect(container.textContent).toContain("MetaX GPU");
    expect(container.textContent).toContain("MetaX accelerator: utilization, temperature, power and clocks");

    act(() => root.unmount());
  });

  it("preselects the dashboard named by the ?dashboard= query param", async () => {
    fetchDashboards.mockResolvedValue(DASHBOARDS);
    fetchDashboard.mockImplementation((_project: string, name: string) =>
      Promise.resolve({ metadata: { name }, spec: {} }),
    );

    // Overview KPI cards land here with e.g. /dashboards?dashboard=resource-overview-dashboard;
    // a matching name must win over the default first item.
    const { container, root } = renderPage(
      Promise.resolve({ dashboard: "kubernetes-cluster-resources-overview" }),
    );
    await act(async () => {});

    expect(fetchDashboard).toHaveBeenLastCalledWith("perses-dev", "kubernetes-cluster-resources-overview");
    expect(viewerText(container)).toContain("dashboard:kubernetes-cluster-resources-overview");
    expect(container.textContent).toContain("Cluster Overview");

    act(() => root.unmount());
  });

  it("falls back to the first dashboard when the query param matches nothing", async () => {
    fetchDashboards.mockResolvedValue(DASHBOARDS);
    fetchDashboard.mockResolvedValue({ metadata: { name: "metax-gpu" }, spec: {} });

    const { container, root } = renderPage(Promise.resolve({ dashboard: "nope-dashboard" }));
    await act(async () => {});

    expect(fetchDashboard).toHaveBeenLastCalledWith("perses-dev", "metax-gpu");
    expect(viewerText(container)).toContain("dashboard:metax-gpu");

    act(() => root.unmount());
  });

  it("swaps the panels when a different dashboard is chosen", async () => {
    fetchDashboards.mockResolvedValue(DASHBOARDS);
    fetchDashboard.mockImplementation((_project: string, name: string) =>
      Promise.resolve({ metadata: { name }, spec: {} }),
    );

    const { container, root } = renderPage();
    await act(async () => {});
    expect(viewerText(container)).toContain("dashboard:metax-gpu");

    // Drive the MUI Select's native input (sibling of the combobox, holds the
    // value) to pick the second dashboard. Set the value through the prototype
    // setter so React's input value tracker isn't bypassed/desynced, then fire
    // the native input event React's onChange listens for.
    const input = container.querySelector<HTMLInputElement>("input.MuiSelect-nativeInput");
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "kubernetes-cluster-resources-overview");
    await act(async () => {
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});

    expect(fetchDashboard).toHaveBeenLastCalledWith("perses-dev", "kubernetes-cluster-resources-overview");
    expect(viewerText(container)).toContain("dashboard:kubernetes-cluster-resources-overview");
    // The description follows the selection, straight from the list payload.
    expect(container.textContent).toContain("Cluster resource usage at a glance");

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
