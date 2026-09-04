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
    { tag: "base-cuda-12.4:v1.6", label: "base-cuda-12.4:v1.6 · CUDA 12.4 / PyTorch 2.5" },
    { tag: "base-cuda-12.1:v1.6", label: "base-cuda-12.1:v1.6 · CUDA 12.1 / PyTorch 2.4" },
    { tag: "base-maca-2.28:v1.3", label: "base-maca-2.28:v1.3 · MACA 2.28 (沐曦)" },
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
    await expect(jupyter).toContainText("base-cuda-12.4:v1.6");
    await expect(jupyter).toContainText("1×nvidia");
    await expect(jupyter).toContainText("Running");
    await expect(jupyter).toContainText("project-a");

    const ssh = page.locator('[data-od-id="dev-row-ssh-dataset-prep"]');
    await expect(ssh).toContainText("SSH");
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
    await expect(detail).toContainText("base-cuda-12.4:v1.6");
    await expect(detail).toContainText("1 × nvidia");
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

    // Step 3: create and expect the new env to appear and be selected.
    await page.locator('[data-od-id="wizard-create"]').click();
    await expect(page.locator('[data-od-id="dev-row-my-env"]')).toBeVisible();
    await expect(page.locator('[data-od-id="create-wizard"]')).toBeHidden();
  });
});