import { expect, test } from "@playwright/test";

// Suite B — one smoke spec for the *real* /api/overview data path. The node
// and CR figures come from the live KinD cluster; the 24h trend comes from
// mock Prometheus through the perses proxy. Assertions are resilient because
// the exact cluster numbers vary (run-preview.sh reuses whatever is running).
//
// Run with:  npm run test:e2e:datapath
// Requires the KinD cluster + the preview stack (playwright.datapath.config.ts
// starts it via e2e/deploy/perses/local/run-preview.sh).

test("real route renders cluster KPIs and a Prometheus trend", async ({ page }) => {
  // The live /api/overview resolves the node/CR reads plus four Prometheus
  // proxy round-trips, and the first-hit Next compile for the whole portal
  // happens on this route, so the overview data can take a few seconds to
  // appear. Give the real-data assertions a generous wait instead of racing a
  // 5s default timeout (which flakes on cold start when unrelated routes grow
  // the bundle).
  test.setTimeout(60_000);

  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
  await page.goto("/");

  // Subtitle reflects the real cluster version + node count.
  await expect(page.locator('[data-od-id="page-head"]')).toContainText(/Kubernetes v\d+\.\d+ · \d+ 节点/, { timeout: 20_000 });

  // Node KPI: a positive total with a Ready/NotReady breakdown.
  const nodes = page.locator('[data-od-id="kpi-nodes"]');
  await expect(nodes).toContainText("节点总数");
  await expect(nodes).toContainText(/Ready \d+ · NotReady \d+/);

  // The trend must carry mocked metrics: no empty state, legend shows a %.
  const trend = page.locator('[data-od-id="gpu-trend-card"]');
  await expect(trend).toContainText("GPU 集群利用率 · 近 24 小时");
  await expect(page.locator('[data-od-id="trend-empty"]')).toHaveCount(0);
  await expect(trend).toContainText(/算力利用率 \d+%/);

  // Allocation card renders the real totals.
  await expect(page.locator('[data-od-id="gpu-alloc-card"]')).toContainText("已分配 / 卡");
});
