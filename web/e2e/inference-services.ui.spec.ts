import { expect, test, type Page } from "@playwright/test";
import { inferenceServiceList, inferenceServiceSummary } from "../test/fixtures/inferenceservices";

// Deterministic, CI-cheap e2e suite for /inference-services. /api/inferenceservices
// and /api/inferenceservices/options are stubbed at the network level with the
// shared fixtures, so no KinD cluster or Prometheus is required. The platform
// locale is pinned to zh-CN (headless Chromium defaults to en-US).

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  profiles: [
    {
      name: "metax-sglang-dsv4-pd",
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      models: ["MXC500"],
      architectures: ["deepseek_v4"],
      quantizations: ["w8a8"],
      gpuPerPod: 8,
      overrides: [
        { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, default: 2, description: null },
        { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, default: 1, description: null },
        { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], default: 1, description: null },
      ],
    },
  ],
  modelversions: [
    { name: "deepseek-v4-flash-w8a8-v1", model: "deepseek-v4-flash", version: "w8a8-v1", architecture: "deepseek_v4", quantization: "w8a8" },
  ],
};

function stubList(page: Page, payload: object) {
  return page.route("**/api/inferenceservices?*", (route) => route.fulfill({ json: payload })).then(() =>
    page.route("**/api/inferenceservices", (route) => route.fulfill({ json: payload })),
  );
}

function stubOptions(page: Page) {
  return page.route("**/api/inferenceservices/options", (route) => route.fulfill({ json: OPTIONS }));
}

async function pinLocale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
}

test.beforeEach(async ({ page }) => {
  await pinLocale(page);
});

test.describe("inference services landing (mocked data)", () => {
  test("renders service rows with status, multi-line replicas and QPS/P95 dashes", async ({ page }) => {
    await stubList(page, { items: inferenceServiceList() });
    await page.goto("/inference-services");

    const table = page.locator('[data-od-id="svc-table"]');
    await expect(table).toContainText("dsv4-pro-pd");
    await expect(table).toContainText("dsv4-flash-pd");

    // The fixture has no reported status -> both render as Pending.
    const pro = page.locator('[data-od-id="svc-row-dsv4-pro-pd"]');
    await expect(pro).toContainText("Pending");
    await expect(pro).toContainText("sglang");
    await expect(pro).toContainText("8 × MXC500");
    // Replicas render multi-line (decode / prefill / group on separate rows).
    await expect(pro).toContainText("decode 2");
    await expect(pro).toContainText("prefill 1");
    await expect(pro).toContainText("group 1");
    // No engine metrics -> QPS and P95 columns fall back to a dash.
    await expect(pro).toContainText("—");
    await expect(pro).toContainText("deepseek-v4-pro-w8a8-v1");
  });

  test("filters rows by Ready / 未就绪 tab", async ({ page }) => {
    const list = [
      inferenceServiceSummary({ name: "dsv4-pro-pd", ready: true, progressing: false, routeModelName: "dsv4-pro" }),
      inferenceServiceSummary({ name: "dsv4-flash-pd", ready: false, progressing: true, routeModelName: "dsv4-flash" }),
    ];
    await stubList(page, { items: list });
    await page.goto("/inference-services");

    const tabs = page.locator('[data-od-id="svc-toolbar"] [role="tab"]');
    await expect(tabs).toHaveCount(3);

    // All -> both rows present.
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toBeVisible();

    // Ready -> only the ready one.
    await tabs.filter({ hasText: "Ready" }).click();
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toHaveCount(0);

    // 未就绪 -> the other one only.
    await tabs.filter({ hasText: "未就绪" }).click();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toHaveCount(0);
  });

  test("selecting a service opens its detail panel", async ({ page }) => {
    await stubList(page, { items: inferenceServiceList() });
    await page.goto("/inference-services");

    await page.locator('[data-od-id="svc-row-dsv4-pro-pd"]').click();

    const detail = page.locator("body"); // Detail cards render beside the table.
    await expect(detail).toContainText("访问端点");
    await expect(detail).toContainText("外部端点(AI Gateway)");
    await expect(detail).toContainText("https://gateway.cubestack.local/v1/models/dsv4-pro");
    await expect(detail).toContainText("运行指标");
    await expect(page.locator('[data-od-id="metrics-empty"]')).toContainText("暂无监控数据");
    await expect(detail).toContainText("扩缩容");
    await expect(detail).toContainText("decodeReplicas");
    await expect(detail).toContainText("引擎参数");
    await expect(detail).toContainText("profileRef");
    await expect(detail).toContainText("metax-sglang-dsv4-pd");
  });

  test("deploys a service through the wizard and selects it", async ({ page }) => {
    await stubOptions(page);
    let created: { name: string } | null = null;
    await page.route("**/api/inferenceservices?*", (route) =>
      route.fulfill({
        json: {
          items: created ? [inferenceServiceSummary({ name: created.name }), ...inferenceServiceList()] : inferenceServiceList(),
        },
      }),
    );
    await page.route("**/api/inferenceservices", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name?: string };
        created = { name: body.name ?? "unknown" };
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: created.name }) });
      }
      return route.fulfill({
        json: { items: created ? [inferenceServiceSummary({ name: created.name }), ...inferenceServiceList()] : inferenceServiceList() },
      });
    });
    await page.goto("/inference-services");

    await page.locator('[data-od-id="deploy-btn"]').click();
    const wizard = page.locator('[data-od-id="deploy-wizard"]');
    await expect(wizard).toBeVisible();

    // Step 1: a valid name is the only requirement (namespace/profile default).
    await page.getByPlaceholder("e.g. dsv4-flash-serve").fill("my-serve");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="2"]')).toBeVisible();

    // Step 2: select the compatible model version.
    await page.getByText("选择模型版本…").click();
    await page.locator('[role="option"]').filter({ hasText: "deepseek-v4-flash-w8a8-v1" }).click();
    await expect(page.locator('[data-step="2"]')).toContainText("deepseek-v4-flash-w8a8-v1");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="3"]')).toBeVisible();

    // Step 3: create and expect the new service to appear and be selected.
    await page.locator('[data-od-id="wizard-create"]').click();
    await expect(page.locator('[data-od-id="svc-row-my-serve"]')).toBeVisible();
    await expect(page.locator('[data-od-id="deploy-wizard"]')).toBeHidden();
  });
});