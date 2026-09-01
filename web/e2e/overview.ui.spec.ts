import { expect, test, type Page } from "@playwright/test";
import { overviewSummary } from "../test/fixtures/overview";

// Suite A — the deterministic, CI-cheap e2e suite. /api/overview is stubbed at
// the network level with the shared fixtures, so no cluster or Prometheus is
// needed. Headless Chromium defaults navigator.language to en-US; pin the
// platform locale so assertions don't depend on the runner's environment.
// The locale-switch test overrides it per-test.

async function pinLocale(page: Page, locale: string) {
  await page.addInitScript((l) => {
    localStorage.setItem("cubestack-locale", l);
    localStorage.setItem("cubestack-theme", "light");
  }, locale);
}

test.beforeEach(async ({ page }) => {
  await pinLocale(page, "zh-CN");
});

function stubOverview(page: Page, payload: object) {
  return page.route("**/api/overview", (route) => route.fulfill({ json: payload }));
}

test.describe("overview landing (mocked data)", () => {
  test("renders the KPI row and subtitle from the payload", async ({ page }) => {
    await stubOverview(page, overviewSummary());
    await page.goto("/");

    await expect(page.locator('[data-od-id="page-head"]')).toContainText(
      "Kubernetes v1.29 · 16 节点 · 双资源池(计算 / 推理)",
    );

    const nodes = page.locator('[data-od-id="kpi-nodes"]');
    await expect(nodes).toContainText("节点总数");
    await expect(nodes).toContainText("16");
    await expect(nodes).toContainText("Ready 15 · NotReady 1");

    const gpu = page.locator('[data-od-id="kpi-gpu"]');
    await expect(gpu).toContainText("GPU 卡总数");
    await expect(gpu).toContainText("128");
    await expect(gpu).toContainText("2 品牌");
    await expect(gpu).toContainText("当前利用率 62% · 显存 58%");

    const inf = page.locator('[data-od-id="kpi-inference"]');
    await expect(inf).toContainText("推理服务");
    await expect(inf).toContainText("12");
    await expect(inf).toContainText("就绪 11 · 扩缩容中 1");

    const dev = page.locator('[data-od-id="kpi-devenv"]');
    await expect(dev).toContainText("开发环境");
    await expect(dev).toContainText("8");
    await expect(dev).toContainText("运行中 5 · 已停止 3");
  });

  test("renders the trend legend values and the allocation donut", async ({ page }) => {
    await stubOverview(page, overviewSummary());
    await page.goto("/");

    const trend = page.locator('[data-od-id="gpu-trend-card"]');
    await expect(trend).toContainText("GPU 集群利用率 · 近 24 小时");
    await expect(trend).toContainText("算力利用率 62%");
    await expect(trend).toContainText("显存占用 58%");
    await expect(page.locator('[data-od-id="trend-empty"]')).toHaveCount(0);

    const alloc = page.locator('[data-od-id="gpu-alloc-card"]');
    await expect(alloc).toContainText("GPU 资源分配");
    await expect(alloc).toContainText("共 128 卡");
    await expect(alloc).toContainText("已分配 / 卡");
    await expect(alloc).toContainText("计算池(训练/开发)");
    await expect(alloc).toContainText("推理池(vLLM/SGLang)");
    await expect(alloc).toContainText("空闲可调度");
    await expect(alloc).toContainText("50");
    await expect(alloc).toContainText("30");
    await expect(alloc).toContainText("48");
  });

  test("shows the empty trend state and hides the GPU foot when trend is null", async ({ page }) => {
    await stubOverview(page, overviewSummary({ trend: null }));
    await page.goto("/");

    await expect(page.locator('[data-od-id="trend-empty"]')).toContainText("暂无监控数据");
    const gpu = page.locator('[data-od-id="kpi-gpu"]');
    await expect(gpu).toContainText("128");
    await expect(gpu).not.toContainText("当前利用率");
  });

  test("shows the error state and recovers via retry", async ({ page }) => {
    let ok = false;
    await page.route("**/api/overview", (route) => {
      if (!ok) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Failed to load overview" }),
        });
      }
      return route.fulfill({ json: overviewSummary() });
    });
    await page.goto("/");

    const err = page.locator('[data-od-id="overview-error"]');
    // The page rejects non-ok responses with `HTTP <status>` regardless of body.
    await expect(err).toContainText("加载失败: HTTP 500");
    await expect(err.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(page.locator('[data-od-id="kpi-row"]')).toHaveCount(0);

    ok = true;
    await err.getByRole("button", { name: "重试" }).click();
    await expect(page.locator('[data-od-id="kpi-nodes"]')).toContainText("节点总数");
    await expect(page.locator('[data-od-id="overview-error"]')).toHaveCount(0);
  });

  test("polls every 30s and refreshes the values", async ({ page }) => {
    const payloads = [
      overviewSummary(),
      overviewSummary({ nodes: { total: 17, ready: 16, version: "v1.29" } }),
    ];
    let calls = 0;
    await page.route("**/api/overview", (route) => {
      const payload = payloads[Math.min(calls, payloads.length - 1)];
      calls += 1;
      return route.fulfill({ json: payload });
    });
    await page.clock.install();
    await page.goto("/");

    const nodes = page.locator('[data-od-id="kpi-nodes"]');
    await expect(nodes).toContainText("16");
    await page.clock.fastForward(30_000);
    await expect(nodes).toContainText("17");
    await expect(nodes).toContainText("Ready 16 · NotReady 1");
  });

  test("switches locale to English", async ({ page }) => {
    await pinLocale(page, "en");
    await stubOverview(page, overviewSummary());
    await page.goto("/");

    await expect(page.locator('[data-od-id="page-head"]')).toContainText(
      "Kubernetes v1.29 · 16 nodes · compute / inference pools",
    );
    const nodes = page.locator('[data-od-id="kpi-nodes"]');
    await expect(nodes).toContainText("Total nodes");
    await expect(nodes).toContainText("15 ready · 1 not ready");
  });
});
