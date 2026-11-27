import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

// ThemeToggle pulls @perses-dev/components for the chart palette, which vitest's
// resolver cannot load (mdi-material-ui subpaths). The topbar only needs the
// mode.
vi.mock("@/lib/perses/theme", () => ({
  usePlatformTheme: () => "light",
  togglePlatformTheme: vi.fn(),
  PLATFORM_THEME_STORAGE_KEY: "cubestack-theme",
}));

import { Topbar } from "./Topbar";

function renderTopbar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Topbar));
  });
  return { container, root };
}

function stubMe(isAdmin: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: "admin", isAdmin }),
    })),
  );
}

async function openMenu(container: HTMLElement) {
  await act(async () => {
    (container.querySelector('[data-od-id="current-user"]') as HTMLElement).click();
  });
}

describe("topbar user menu", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.push.mockReset();
    nav.replace.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("opens a menu with 设置 for an admin and navigates to it", async () => {
    stubMe(true);
    const { container, root } = renderTopbar();
    await act(async () => {});

    await openMenu(container);
    const settings = document.querySelector('[data-od-id="settings-menu-item"]') as HTMLElement;
    expect(settings.textContent).toContain("平台设置");

    act(() => settings.click());
    expect(nav.push).toHaveBeenCalledWith("/settings");
    expect(document.querySelector('[data-od-id="logout-button"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("hides 设置 for a non-admin but still offers sign-out", async () => {
    stubMe(false);
    const { container, root } = renderTopbar();
    await act(async () => {});

    await openMenu(container);
    expect(document.querySelector('[data-od-id="settings-menu-item"]')).toBeNull();
    expect(document.querySelector('[data-od-id="logout-button"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("signs out from the menu and returns to the login page", async () => {
    stubMe(true);
    const { container, root } = renderTopbar();
    await act(async () => {});

    await openMenu(container);
    const logout = document.querySelector('[data-od-id="logout-button"]') as HTMLElement;
    await act(async () => {
      logout.click();
    });

    expect(nav.replace).toHaveBeenCalledWith("/login");

    act(() => root.unmount());
  });
});
