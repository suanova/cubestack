import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "./page";

// The login page reads window.location.search (for ?next=) and navigates via
// window.location.assign on success. jsdom's location is read-only, so we swap
// in a controllable stub.
function installLocation(search: string) {
  const assign = vi.fn();
  const location = {
    search,
    assign,
    pathname: "/login",
    href: "",
    origin: "http://localhost",
    host: "localhost",
    protocol: "http:",
  };
  Object.defineProperty(window, "location", { configurable: true, value: location });
  return assign;
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(LoginPage));
  });
  return { container, root };
}

function stubLogin(response: { status: number; body?: object }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    })),
  );
}

function fillInput(container: HTMLElement, dataOdId: string, value: string) {
  const input = container.querySelector(`[data-od-id="${dataOdId}"] input`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  act(() => form.requestSubmit());
}

describe("login page", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the localized login form", () => {
    installLocation("");
    const { container, root } = renderPage();
    expect(container.textContent).toContain("登录 CubeStack");
    expect(container.querySelector('[data-od-id="login-submit"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("requires a username and password", async () => {
    installLocation("");
    stubLogin({ status: 401 });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    submitForm(container);
    await act(async () => {});

    expect(container.textContent).toContain("请输入密码");

    // Fill the password and clear the username to show the other requirement.
    fillInput(container, "login-password", "pw");
    fillInput(container, "login-username", "");
    submitForm(container);
    await act(async () => {});
    expect(container.textContent).toContain("请输入用户名");

    act(() => root.unmount());
  });

  it("shows a localized error on bad credentials", async () => {
    installLocation("");
    stubLogin({ status: 401, body: { error: "用户名或密码错误" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "wrong");
    submitForm(container);
    await act(async () => {});

    expect(container.querySelector('[data-od-id="login-error"]')?.textContent).toContain("用户名或密码错误");
    act(() => root.unmount());
  });

  it("redirects to the originally requested page on success", async () => {
    const assign = installLocation("?next=/dashboards?dashboard=x");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});

    expect(assign).toHaveBeenCalledWith("/dashboards?dashboard=x");
    act(() => root.unmount());
  });

  it("redirects to / by default when no next param is present", async () => {
    const assign = installLocation("");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});

    expect(assign).toHaveBeenCalledWith("/");
    act(() => root.unmount());
  });

  it("falls back to / for a cross-origin next (open-redirect guard)", async () => {
    // Decoded to /\/evil.example: a backslash is treated as a slash by
    // navigations, so it must not become //evil.example (a foreign origin).
    for (const next of ["/%5Cevil.example", "//evil.example", "https://evil.example"]) {
      const assign = installLocation(`?next=${next}`);
      stubLogin({ status: 200, body: { user: "admin" } });
      const { container, root } = renderPage();
      fillInput(container, "login-username", "admin");
      fillInput(container, "login-password", "correct");
      submitForm(container);
      await act(async () => {});
      expect(assign).toHaveBeenCalledWith("/");
      act(() => root.unmount());
    }
  });

  it("keeps a plain same-origin path from next", async () => {
    const assign = installLocation("?next=/dev-environments");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();
    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});
    expect(assign).toHaveBeenCalledWith("/dev-environments");
    act(() => root.unmount());
  });

  it("updates the theme toggle label after a click", async () => {
    installLocation("");
    delete document.documentElement.dataset.theme;
    const { container, root } = renderPage();

    const toggle = container.querySelector('[data-od-id="theme-toggle"]') as HTMLButtonElement;
    const before = toggle.getAttribute("aria-label");
    act(() => toggle.click());
    const after = toggle.getAttribute("aria-label");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(after).not.toBe(before);
    expect(after).toBeTruthy();

    act(() => root.unmount());
  });
})