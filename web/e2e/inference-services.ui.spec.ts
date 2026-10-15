import { expect, test, type Page } from "@playwright/test";
import { inferenceServiceList, inferenceServiceSummary } from "../test/fixtures/inferenceservices";
import { seedSession } from "./auth";

// Deterministic, CI-cheap e2e suite for /inference-services. /api/inferenceservices
// and /api/inferenceservices/options are stubbed at the network level with the
// shared fixtures, so no KinD cluster or Prometheus is required. The platform
// locale is pinned to zh-CN (headless Chromium defaults to en-US).

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  // The API names the namespace the wizard opens on; project-a sorts first.
  defaultNamespace: "default",
  profiles: [
    {
      name: "metax-sglang-dsv4-pd",
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      models: ["MXC500"],
      architectures: ["deepseek_v4"],
      quantizations: ["w8a8"],
      servingMode: "pd-separation",
      gpuPerPod: 8,
      roles: [
        { name: "prefill", vendor: "metax", models: ["MXC500"], gpuPerPod: 8 },
        { name: "decode", vendor: "nvidia", models: ["H200"], gpuPerPod: 8 },
      ],
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

test.beforeEach(async ({ context, page }) => {
  await pinLocale(page);
  await seedSession(context);
});

test.describe("inference services landing (mocked data)", () => {
  test("renders service rows with status, multi-line replicas and QPS/P95 dashes", async ({ page }) => {
    await stubList(page, { items: inferenceServiceList() });
    await page.goto("/cubestack/inference-services");

    const table = page.locator('[data-od-id="svc-table"]');
    await expect(table).toContainText("dsv4-pro-pd");
    await expect(table).toContainText("dsv4-flash-pd");

    // The fixture has no reported status -> both render as Pending.
    const pro = page.locator('[data-od-id="svc-row-dsv4-pro-pd"]');
    await expect(pro).toContainText("Pending");
    await expect(pro).toContainText("sglang");
    await expect(pro).toContainText("8 × MXC500");
    // Replicas render multi-line, one row per integer override the profile declares.
    await expect(pro).toContainText("decodeReplicas 2");
    await expect(pro).toContainText("prefillReplicas 1");
    await expect(pro).toContainText("groupSize 1");
    // No engine metrics -> QPS and P95 columns fall back to a dash.
    await expect(pro).toContainText("—");
    await expect(pro).toContainText("deepseek-v4-pro-w8a8-v1");
  });

  test("filters rows by Ready / 扩缩容中 tab", async ({ page }) => {
    const list = [
      inferenceServiceSummary({ name: "dsv4-pro-pd", ready: true, progressing: false, routeModelName: "dsv4-pro" }),
      inferenceServiceSummary({ name: "dsv4-flash-pd", ready: false, progressing: true, routeModelName: "dsv4-flash" }),
    ];
    await stubList(page, { items: list });
    await page.goto("/cubestack/inference-services");

    const tabs = page.locator('[data-od-id="svc-toolbar"] [role="tab"]');
    await expect(tabs).toHaveCount(3);

    // All -> both rows present.
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toBeVisible();

    // Ready -> only the ready one.
    await tabs.filter({ hasText: "Ready" }).click();
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toHaveCount(0);

    // 扩缩容中 (scaling, inclusive of every not-ready service) -> the other one only.
    await tabs.filter({ hasText: "扩缩容中" }).click();
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toHaveCount(0);
  });

  test("selecting a service opens its detail in that service's own row", async ({ page }) => {
    await stubList(page, { items: inferenceServiceList() });
    await page.goto("/cubestack/inference-services");

    // The first service is open on load, so its detail is already disclosed.
    const detail = page.locator("body");
    await expect(detail).toContainText("访问端点");
    await expect(detail).toContainText("外部端点(AI Gateway)");
    await expect(detail).toContainText("https://ai.cubestack.dev");
    await expect(detail).toContainText("运行指标");
    await expect(page.locator('[data-od-id="metrics-empty"]')).toContainText("暂无监控数据");
    await expect(detail).toContainText("扩缩容");
    await expect(detail).toContainText("decodeReplicas");
    await expect(detail).toContainText("引擎参数");
    await expect(detail).toContainText("profileRef");
    await expect(detail).toContainText("metax-sglang-dsv4-pd");
    await expect(page.locator('[data-od-id="svc-detail-dsv4-pro-pd"]')).toHaveCount(1);

    // Selecting the other service hands the disclosure over to it: one row is
    // open at a time, and the panel moves rather than being duplicated.
    await page.locator('[data-od-id="svc-row-dsv4-flash-pd"]').click();
    await expect(page.locator('[data-od-id="svc-detail-dsv4-flash-pd"]')).toHaveCount(1);
    await expect(page.locator('[data-od-id="svc-detail-dsv4-pro-pd"]')).toHaveCount(0);
  });

  test("discloses the detail in the row's own table row, and prints each condition beside its pill", async ({ page }) => {
    const list = inferenceServiceList();
    // The fixture carries no conditions; graft on the four shapes the card has
    // to tell apart — a True with no message, a True with a sentence, an
    // Unknown, and a False.
    list[0].conditions = [
      { type: "Ready", status: "True", reason: "Ready", message: "", transitionTime: null },
      { type: "RouteReady", status: "True", reason: "Published", message: "路由已发布到网关", transitionTime: null },
      { type: "Progressing", status: "Unknown", reason: "WaitingForReplicas", message: "等待 decode 副本调度", transitionTime: null },
      { type: "ReplicasReady", status: "False", reason: "PodNotReady", message: "0/2 decode 副本就绪", transitionTime: null },
    ];
    await stubList(page, { items: list });
    await page.goto("/cubestack/inference-services");

    // The panel is disclosed inside the table, under the row it belongs to,
    // rather than in a block below the table: it starts after that row and ends
    // before the next one begins.
    const row = await page.locator('[data-od-id="svc-row-dsv4-pro-pd"]').boundingBox();
    const detail = await page.locator('[data-od-id="svc-detail-dsv4-pro-pd"]').boundingBox();
    const next = await page.locator('[data-od-id="svc-row-dsv4-flash-pd"]').boundingBox();
    expect(row).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(next).not.toBeNull();
    expect(detail!.y).toBeGreaterThan(row!.y + row!.height - 1);
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(next!.y + 1);
    // And the row says so, the way a disclosure does.
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toHaveAttribute("aria-expanded", "true");
    // The detail row is not one of the rows the table counts.
    await expect(page.locator('[data-od-id^="svc-row-"]')).toHaveCount(2);

    // One line per condition, the object's sentence beside its own pill rather
    // than in a second list keyed by type.
    await expect(page.locator('[data-od-id="cond-Ready"]')).toHaveText("ReadyTrue");
    await expect(page.locator('[data-od-id="cond-note-Ready"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="cond-note-RouteReady"]')).toHaveText(": 路由已发布到网关");
    await expect(page.locator('[data-od-id="cond-note-Progressing"]')).toHaveText(": 等待 decode 副本调度");
    await expect(page.locator('[data-od-id="cond-note-ReplicasReady"]')).toHaveText(": 0/2 decode 副本就绪");
    // Every condition takes a line, the True ones included.
    await expect(page.locator('span[data-od-id^="cond-"]').filter({ hasNotText: ":" })).toHaveCount(4);
    // The reason is off the line but on the pill's hover.
    await expect(page.locator('[data-od-id="cond-ReplicasReady"]')).toHaveAttribute(
      "title",
      "ReplicasReady False (PodNotReady) 0/2 decode 副本就绪",
    );

    // Clicking the open row closes it, and clicking it again reopens it.
    await page.locator('[data-od-id="svc-row-dsv4-pro-pd"]').click();
    await expect(page.locator('[data-od-id="svc-detail-dsv4-pro-pd"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toHaveAttribute("aria-expanded", "false");
    await page.locator('[data-od-id="svc-row-dsv4-pro-pd"]').click();
    await expect(page.locator('[data-od-id="svc-detail-dsv4-pro-pd"]')).toHaveCount(1);
  });

  test("deletes a service after confirming in the console's own dialog", async ({ page }) => {
    let items = inferenceServiceList();
    let deleted: { namespace?: string; name?: string } | null = null;
    // The list is mutable because the delete is answered by re-reading it: the
    // row has to be gone on the next GET, not merely hidden.
    const service = (route: import("@playwright/test").Route) => {
      if (route.request().method() === "DELETE") {
        deleted = route.request().postDataJSON() as { namespace?: string; name?: string };
        items = items.filter((s) => !(s.name === deleted!.name && s.namespace === deleted!.namespace));
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { items } });
    };
    await page.route("**/api/inferenceservices?*", service);
    await page.route("**/api/inferenceservices", service);
    await page.goto("/cubestack/inference-services");

    // The open row has the width, so its action is laid out in it; the closed
    // row keeps the same action behind a kebab rather than in the table.
    await expect(page.locator('[data-od-id="act-del-dsv4-pro-pd"]')).toBeVisible();
    await expect(page.locator('[data-od-id="act-del-dsv4-flash-pd"]')).toHaveCount(0);

    await page.locator('[data-od-id="act-del-dsv4-pro-pd"]').click();
    await expect(page.locator('[data-od-id="delete-prompt"]')).toHaveText(
      "删除推理服务「dsv4-pro-pd」?其控制器创建的资源会一并回收,此操作不可撤销。",
    );
    // The row's button only named the target: nothing has been sent.
    expect(deleted).toBeNull();

    await page.locator('[data-od-id="delete-confirm"]').click();
    await expect(page.locator('[data-od-id="svc-row-dsv4-pro-pd"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toBeVisible();
    expect(deleted).toEqual({ namespace: "project-a", name: "dsv4-pro-pd" });
  });

  test("keeps a closed row's action behind its kebab", async ({ page }) => {
    await stubList(page, { items: inferenceServiceList() });
    await page.goto("/cubestack/inference-services");

    const kebab = page.locator('[data-od-id="svc-ops-dsv4-flash-pd"]');
    await expect(kebab).toHaveAttribute("aria-expanded", "false");
    await kebab.click();
    await expect(kebab).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-od-id="act-del-dsv4-flash-pd"]')).toBeVisible();
    // The kebab does not select the row it sits in: one click means one thing.
    await expect(page.locator('[data-od-id="svc-row-dsv4-flash-pd"]')).toHaveAttribute("aria-expanded", "false");
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
    await page.goto("/cubestack/inference-services");

    await page.locator('[data-od-id="deploy-btn"]').click();
    const wizard = page.locator('[data-od-id="deploy-wizard"]');
    await expect(wizard).toBeVisible();

    // Step 1: a valid name is the only requirement (namespace/profile default),
    // and the namespace is the one the API named rather than the first listed.
    await expect(page.locator('[data-od-id="deploy-namespace"]')).toContainText("default");
    await page.getByPlaceholder("e.g. dsv4-flash-serve").fill("my-serve");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="2"]')).toBeVisible();

    // Step 2: the pd-separation profile shows one read-only GPU select per
    // role, each fixed to that role's declared accelerator.
    await expect(page.locator('[data-step="2"]')).toContainText("GPU 类型");
    await expect(page.locator('[data-od-id="wizard-gpu-prefill"]')).toContainText("metax");
    await expect(page.locator('[data-od-id="wizard-gpu-decode"]')).toContainText("nvidia");

    // Step 2: select the compatible model version.
    await page.getByText("选择模型版本…").click();
    await page.locator('[role="option"]').filter({ hasText: "deepseek-v4-flash-w8a8-v1" }).click();
    await expect(page.locator('[data-step="2"]')).toContainText("deepseek-v4-flash-w8a8-v1");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="3"]')).toBeVisible();
    // Step 3: the summary spells out both roles' declared accelerators.
    await expect(page.locator('[data-step="3"]')).toContainText("prefill: metax / decode: nvidia");

    // Step 3: create and expect the new service to appear and be selected.
    await page.locator('[data-od-id="wizard-create"]').click();
    await expect(page.locator('[data-od-id="svc-row-my-serve"]')).toBeVisible();
    await expect(page.locator('[data-od-id="deploy-wizard"]')).toBeHidden();
  });
});