import { expect, test, type Page } from "@playwright/test";
import { devEnvironmentList, devEnvironmentSummary } from "../test/fixtures/devenvironments";
import { seedSession } from "./auth";

// Deterministic, CI-cheap e2e suite for /dev-environments. /api/devenvironments
// and /api/devenvironments/options are stubbed at the network level with the
// shared fixtures, so no KinD cluster is required. The platform locale is
// pinned to zh-CN (headless Chromium defaults to en-US).

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  images: [
    { tag: "harbor.isuanova.com/suanova/jupyter-minimal:latest", label: "suanova/jupyter-minimal · CPU · JupyterLab (jovyan)", user: "jovyan", runAsGroup: 100 },
    { tag: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest", label: "suanova/ssh-ubuntu22.04 · CPU · SSH (ubuntu)", user: "ubuntu" },
    { tag: "harbor.isuanova.com/suanova/base-cuda:latest", label: "suanova/base-cuda · NVIDIA CUDA (ubuntu)", user: "ubuntu" },
    { tag: "harbor.isuanova.com/suanova/base-maca:latest", label: "suanova/base-maca · Metax MACA (ubuntu)", user: "ubuntu" },
  ],
};

function stubList(page: Page, payload: object) {
  return page.route("**/api/devenvironments?*", (route) => route.fulfill({ json: payload })).then(() =>
    page.route("**/api/devenvironments", (route) => route.fulfill({ json: payload })),
  );
}

function stubOptions(page: Page) {
  return page.route("**/api/devenvironments/options", (route) => route.fulfill({ json: OPTIONS }));
}

/**
 * Step 3's account, uid and gid boxes, in render order (the root toggle is a
 * checkbox). Scoped to the security section: the other three sections of the
 * step carry inputs of their own.
 */
function identity(page: Page) {
  return page.locator('[data-od-id="sec-security"] input:not([type="checkbox"])');
}

async function pinLocale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
}

test.beforeEach(async ({ context, page }) => {
  await pinLocale(page);
  await seedSession(context);
});

test.describe("dev environments landing (mocked data)", () => {
  test("renders environment rows with type badges, status chips and GPU columns", async ({ page }) => {
    await stubList(page, { items: devEnvironmentList() });
    await page.goto("/dev-environments");

    const table = page.locator('[data-od-id="dev-table"]');
    await expect(table).toContainText("jupyter-nlp-ln");
    await expect(table).toContainText("ssh-dataset-prep");

    const jupyter = page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]');
    await expect(jupyter).toContainText("JUPYTER");
    await expect(jupyter).toContainText("harbor.isuanova.com/suanova/base-cuda:latest");
    await expect(jupyter).toContainText("1 × GPU");
    await expect(jupyter).toContainText("Running");
    await expect(jupyter).toContainText("project-a");

    const ssh = page.locator('[data-od-id="dev-row-ssh-dataset-prep"]');
    await expect(ssh).toContainText("SSH");
    // A CPU image with no accelerator: spec.resources.gpu is absent, so the
    // cell says so rather than inventing a card.
    await expect(ssh).toContainText("harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest");
    await expect(ssh).toContainText("无加速卡");
    await expect(ssh).toContainText("Stopped");
    await expect(ssh.locator('[data-od-id="act-start-ssh-dataset-prep"]')).toBeVisible();
    await expect(ssh.locator('[data-od-id="act-del-ssh-dataset-prep"]')).toBeVisible();
  });

  test("filters rows by Running / Stopped tab", async ({ page }) => {
    await stubList(page, { items: devEnvironmentList() });
    await page.goto("/dev-environments");

    const tabs = page.locator('[data-od-id="dev-toolbar"] [role="tab"]');
    await expect(tabs).toHaveCount(3);

    await tabs.filter({ hasText: "运行中" }).click();
    await expect(page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]')).toBeVisible();
    await expect(page.locator('[data-od-id="dev-row-ssh-dataset-prep"]')).toHaveCount(0);

    await tabs.filter({ hasText: "已停止" }).click();
    await expect(page.locator('[data-od-id="dev-row-ssh-dataset-prep"]')).toBeVisible();
    await expect(page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]')).toHaveCount(0);
  });

  test("selecting an environment opens its connection + spec detail", async ({ page }) => {
    await stubList(page, { items: devEnvironmentList() });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]').click();

    const detail = page.locator("body");
    await expect(detail).toContainText("连接信息");
    await expect(detail).toContainText("https://dev.cubestack.local/ws/jupyter-nlp-ln");
    await expect(detail).toContainText("规格与状态");
    await expect(detail).toContainText("harbor.isuanova.com/suanova/base-cuda:latest");
    await expect(detail).toContainText("1 × nvidia");
    // Step 3's three new sections each get a row, and the storage row carries
    // the mount path the CR states rather than one the panel invents.
    await expect(detail).toContainText("200Gi · /home/ubuntu");
    await expect(detail).toContainText("data-cache → /data");
    await expect(detail).toContainText("HF_HOME · HF_TOKEN");
    await expect(detail).toContainText("--port 8080");
    await expect(detail).toContainText("api:8080/http");
  });

  test("start/stop a stopped environment via the row actions", async ({ page }) => {
    const patches: Array<unknown> = [];
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "PATCH") {
        patches.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="act-start-ssh-dataset-prep"]').click();
    await expect.poll(() => patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ namespace: "project-a", name: "ssh-dataset-prep", running: true });
  });

  test("creates an environment through the wizard and selects it", async ({ page }) => {
    await stubOptions(page);
    let created: { name: string } | null = null;
    const posts: Array<Record<string, unknown>> = [];
    await page.route("**/api/devenvironments?*", (route) =>
      route.fulfill({
        json: {
          items: created
            ? [devEnvironmentSummary({ name: created.name, endpoints: [] }), ...devEnvironmentList()]
            : devEnvironmentList(),
        },
      }),
    );
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name?: string };
        posts.push(body);
        created = { name: body.name ?? "unknown" };
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: created.name }) });
      }
      return route.fulfill({
        json: { items: created ? [devEnvironmentSummary({ name: created.name, endpoints: [] }), ...devEnvironmentList()] : devEnvironmentList() },
      });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="create-env-btn"]').click();
    const wizard = page.locator('[data-od-id="create-wizard"]');
    await expect(wizard).toBeVisible();

    // Step 1: name + defaults (namespace/image default from options).
    await page.getByPlaceholder("e.g. jupyter-nlp-ln").fill("my-env");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="2"]')).toBeVisible();

    // Step 2: resources are pre-filled; just advance.
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="3"]')).toBeVisible();

    // Step 3: the identity the image implies, which is what a user leaves alone
    // unless their image disagrees with the catalog.
    await expect(identity(page).nth(0)).toHaveValue("jovyan");
    await expect(identity(page).nth(1)).toHaveValue("1000");
    await expect(identity(page).nth(2)).toHaveValue("100");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="4"]')).toBeVisible();

    // Step 4: create and expect the new env to appear and be selected.
    await page.locator('[data-od-id="wizard-create"]').click();
    await expect(page.locator('[data-od-id="dev-row-my-env"]')).toBeVisible();
    await expect(page.locator('[data-od-id="create-wizard"]')).toBeHidden();

    // The wizard walks the untouched defaults through to the API: the catalog
    // opens on the CPU jupyter image with no accelerator chosen, and `none` is
    // the body's way of saying spec.resources.gpu stays absent.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      name: "my-env",
      namespace: "project-a",
      type: "jupyter",
      image: "harbor.isuanova.com/suanova/jupyter-minimal:latest",
      accelerator: "none",
      // Not just "ignored server-side": the stale default must not be sent at
      // all, or the request describes a card nobody asked for.
      cpu: "2",
      memory: "4Gi",
      // The identity is stated explicitly rather than left to the server to
      // re-derive: what the user confirmed on step 4 is what is sent.
      runtimeUser: "jovyan",
      runAsUser: 1000,
      runAsGroup: 100,
    });
    expect(posts[0]).not.toHaveProperty("gpuCount");
  });

  test("a typed image and a hand-edited identity reach the API", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    await stubOptions(page);
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: body.name }) });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="create-env-btn"]').click();
    await page.getByPlaceholder("e.g. jupyter-nlp-ln").fill("byo-env");

    // The image box is editable, not a fixed list: a reference the platform does
    // not publish is kept verbatim.
    const image = page.locator('[data-od-id="wizard-image"] input');
    await image.fill("harbor.local/ai-images/custom:1.0");
    // Nothing in the catalog matches, so the (empty) popup sits over the footer
    // until the box loses focus — dismiss it the way a user would.
    await image.blur();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="3"]')).toBeVisible();

    // Nothing states that image's identity, so the fields fall back to the
    // platform's own and the user overrides them.
    await expect(identity(page).nth(0)).toHaveValue("user");
    await identity(page).nth(0).fill("alice");
    await identity(page).nth(1).fill("1500");
    await identity(page).nth(2).fill("1500");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.locator('[data-od-id="wizard-create"]').click();

    expect(posts[0]).toMatchObject({
      name: "byo-env",
      image: "harbor.local/ai-images/custom:1.0",
      runtimeUser: "alice",
      runAsUser: 1500,
      runAsGroup: 1500,
    });
  });

  test("running as root is sent as uid 0 with no account", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    await stubOptions(page);
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: body.name }) });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="create-env-btn"]').click();
    await page.getByPlaceholder("e.g. jupyter-nlp-ln").fill("root-env");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();

    await page.locator('[data-od-id="wizard-root"] input').click();
    await expect(identity(page).nth(0)).toHaveValue("root");
    await expect(identity(page).nth(1)).toHaveValue("0");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.locator('[data-od-id="wizard-create"]').click();

    // The operator serves "root" for an uid-0 container and reports
    // spec.runtime.user as overridden, so there is no account to send.
    expect(posts[0]).toMatchObject({ name: "root-env", runAsUser: 0, runAsGroup: 0 });
    expect(posts[0]).not.toHaveProperty("runtimeUser");
  });

  test("the advanced step's storage, runtime and network sections reach the API", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    await stubOptions(page);
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: body.name }) });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="create-env-btn"]').click();
    await page.getByPlaceholder("e.g. jupyter-nlp-ln").fill("advanced-env");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="3"]')).toBeVisible();

    // A workspace path the user states — left alone the box stays empty and the
    // controller derives one instead.
    await page.locator('[data-od-id="wizard-mount-path"] input').fill("/data");

    // One row of each kind, added through that section's own button: the rows
    // start empty, so the click is what puts the boxes on the page.
    await page.locator('[data-od-id="row-add"]').nth(0).click();
    await page.locator('[data-od-id="pvc-name"] input').fill("shared-models");
    await page.locator('[data-od-id="pvc-path"] input').fill("/models");

    await page.locator('[data-od-id="row-add"]').nth(1).click();
    await page.locator('[data-od-id="env-name"] input').fill("HF_HOME");
    await page.locator('[data-od-id="env-value"] input').fill("/data/hf");
    await page.locator('[data-od-id="wizard-args"] input').fill("--port 8080");

    await page.locator('[data-od-id="row-add"]').nth(2).click();
    await page.locator('[data-od-id="port-name"] input').fill("debug");
    await page.locator('[data-od-id="port-num"] input').fill("9229");

    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="4"]')).toBeVisible();
    await expect(page.locator('[data-step="4"]')).toContainText("shared-models → /models");

    await page.locator('[data-od-id="wizard-create"]').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      name: "advanced-env",
      mountPath: "/data",
      volumes: [{ pvcName: "shared-models", mountPath: "/models" }],
      env: [{ name: "HF_HOME", value: "/data/hf" }],
      // One line on the wire; the route splits it into argv.
      args: "--port 8080",
      ports: [{ name: "debug", containerPort: 9229, type: "http" }],
    });
  });

  test("an untouched advanced step sends none of its four keys", async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    await stubOptions(page);
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: body.name }) });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/dev-environments");

    await page.locator('[data-od-id="create-env-btn"]').click();
    await page.getByPlaceholder("e.g. jupyter-nlp-ln").fill("plain-env");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();

    // Add a row to each section and leave all three empty: nothing to say.
    await page.locator('[data-od-id="row-add"]').nth(0).click();
    await page.locator('[data-od-id="row-add"]').nth(1).click();
    await page.locator('[data-od-id="row-add"]').nth(2).click();

    await page.getByRole("button", { name: "下一步" }).click();
    await page.locator('[data-od-id="wizard-create"]').click();
    await expect.poll(() => posts.length).toBe(1);

    // The mount-path box is empty, so the body must not carry a path at all —
    // pinning one would override the home the image's entrypoint derives.
    for (const key of ["mountPath", "volumes", "env", "args", "ports"]) {
      expect(posts[0]).not.toHaveProperty(key);
    }
  });
});