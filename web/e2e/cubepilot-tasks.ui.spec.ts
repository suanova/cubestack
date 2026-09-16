import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Report, Task, TaskTemplate } from "../lib/cubepilot/types";
import { seedSession } from "./auth";

// Deterministic, CI-cheap e2e suite for /cubepilot's 自动化任务 tab. Every
// /api/cubepilot/* endpoint is stubbed at the network level with CR-shaped
// payloads (lib/cubepilot/types.ts), so no KinD cluster, operator or agent
// runtime is required. Pinned to UTC so the fmtTime() cells (last/next run,
// report timestamps) are stable, and to zh-CN for the copy.

test.use({ timezoneId: "UTC" });

// ── fixtures (the CR projections the routes return) ──────────────────────

const TPL_INSPECT: TaskTemplate = {
  name: "cluster-inspect",
  displayName: "集群日常巡检",
  description: "节点 / GPU / 存储 / 网关全量巡检",
  instruction: "对 {{scope}} 范围执行全量巡检:节点 Ready 状态、非 Running Pod、GPU 温度、Ceph 水位。",
  paramsSchema: [{ name: "scope", type: "enum", enum: ["all", "compute", "inference", "storage"], default: "all" }],
  defaultCron: "0 6 * * *",
  skills: ["cluster-inspect"],
};

const TPL_GPU: TaskTemplate = {
  name: "gpu-health",
  displayName: "GPU 节点健康检查",
  description: "GPU 温度 / ECC / XID 事件",
  instruction: "检查 GPU 节点温度与 ECC 错误。",
  paramsSchema: [],
  defaultCron: "0 3 * * *",
  skills: ["gpu-health"],
};

/** A task with a completed run (the sample CR's shape). The tasks API is
 *  owner-scoped, so every stubbed task belongs to the signed-in user. */
const TASK_DAILY: Task = {
  id: "admin-task-a1b2c3d4",
  name: "每日集群巡检",
  prompt: "对 all 范围执行全量巡检",
  schedule: "0 6 * * *",
  templateRef: "cluster-inspect",
  enabled: true,
  creator: "admin",
  createdAt: "2026-09-14T09:13:26Z",
  lastRunAt: "2026-09-13T06:04:00Z",
  lastStatus: "success",
  nextRunAt: "2026-09-14T06:00:00Z",
};

/** A freshly created task nothing has executed yet (no status on the CR). */
const TASK_TEST: Task = {
  id: "admin-task-c4b4a2e7",
  name: "test",
  prompt: "对 all 范围执行全量巡检",
  schedule: "0 6 * * *",
  templateRef: "cluster-inspect",
  enabled: true,
  creator: "admin",
  createdAt: "2026-09-15T02:46:54Z",
};

/** A paused, manual-only, free-form task. */
const TASK_MANUAL: Task = {
  id: "admin-task-e4f5a6b7",
  name: "升级前预检(v1.4.0)",
  prompt: "校验 v1.3.2 → v1.4.0 升级路径",
  schedule: "",
  enabled: false,
  creator: "admin",
  createdAt: "2026-09-14T09:13:26Z",
  lastRunAt: "2026-09-13T22:01:22Z",
  lastStatus: "failed",
};

const REPORT_OK: Report = {
  id: "run-09130600",
  taskId: TASK_DAILY.id,
  taskName: TASK_DAILY.name,
  trigger: "Cron",
  status: "success",
  startedAt: "2026-09-13T06:00:00Z",
  finishedAt: "2026-09-13T06:04:00Z",
  content: "# 集群日常巡检报告\n\n**范围**: all\n\n- GPU 健康:⚠️ gpu-nvidia-02 GPU#3 温度 88°C(**P1**)\n- 存储容量:⚠️ osd-07 使用率 84%(**P1**)\n",
  p0: 0,
  p1: 2,
  p2: 1,
};

const REPORT_FAILED: Report = {
  id: "run-09132200",
  taskId: TASK_DAILY.id,
  taskName: TASK_DAILY.name,
  trigger: "Manual",
  status: "failed",
  startedAt: "2026-09-12T22:01:00Z",
  finishedAt: "2026-09-12T22:01:22Z",
  content: "升级预检失败:etcd 碎片率超过阈值,已中止。",
  p0: 1,
  p1: 0,
  p2: 0,
};

const REPORT_RUNNING: Report = {
  id: "run-09150600",
  taskId: TASK_TEST.id,
  taskName: TASK_TEST.name,
  trigger: "Manual",
  status: "running",
  startedAt: "2026-09-15T03:00:00Z",
  finishedAt: "",
  content: "",
  p0: 0,
  p1: 0,
  p2: 0,
};

interface Captured {
  requests: Array<{ method: string; path: string; body: unknown }>;
}

interface Stub {
  tasks?: Task[];
  templates?: TaskTemplate[];
  /** Reports by task id — mutated by the run/create branches. */
  reports?: Record<string, Report[]>;
}

/** Stub every endpoint the mounted panes touch; task state is live so each
 *  action's follow-up refetch reflects it. */
async function stubTasks(page: Page, stub: Stub = {}): Promise<Captured> {
  const captured: Captured = { requests: [] };
  let tasks = [...(stub.tasks ?? [])];
  const templates = stub.templates ?? [TPL_INSPECT, TPL_GPU];
  const reports: Record<string, Report[]> = { ...(stub.reports ?? {}) };
  let created = 0;

  await page.route("**/api/cubepilot/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body: unknown = method === "GET" || method === "DELETE" ? null : JSON.parse(req.postData() ?? "{}");
    captured.requests.push({ method, path, body });
    const json = (payload: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    // The chat/config panes are mounted too: keep their data benign.
    if (path.endsWith("/agent/status")) return json({ exists: false, user: "admin" });
    if (path.endsWith("/agent/config")) return json({ config: { exists: false, selectedModel: "", userInstructions: "" } });
    if (path.endsWith("/agent/confirm"))
      return json({ exists: false, confirmPolicy: "Allowlist", templatePolicy: "Allowlist", override: "", allowlist: [], channel: "unknown" });
    if (path.endsWith("/api/cubepilot/skills")) return json({ skills: [] });
    if (path.endsWith("/api/cubepilot/playground/services")) return json({ models: [{ id: "glm-5.2-chat", ownedBy: "cubestack" }], endpoint: null });
    if (path.includes("/api/cubepilot/pilot/")) return json({ sessions: [] });

    // ── the tasks tab ──
    if (path.endsWith("/api/cubepilot/tasktemplates")) return json({ taskTemplates: templates });

    const reportsMatch = path.match(/\/api\/cubepilot\/tasks\/([^/]+)\/reports$/);
    if (reportsMatch) return json({ reports: reports[decodeURIComponent(reportsMatch[1])] ?? [] });

    const runMatch = path.match(/\/api\/cubepilot\/tasks\/([^/]+)\/run$/);
    if (runMatch && method === "POST") {
      const id = decodeURIComponent(runMatch[1]);
      // The scheduler is what actually writes a run: stand in for it.
      reports[id] = [{ ...REPORT_RUNNING }];
      return json({ started: true });
    }

    const toggleMatch = path.match(/\/api\/cubepilot\/tasks\/([^/]+)\/toggle$/);
    if (toggleMatch && method === "POST") {
      const id = decodeURIComponent(toggleMatch[1]);
      // The route applies the state the client asks for; a body-less call flips.
      // Mirror its contract: anything else is rejected, so a spec cannot pass
      // here while the client violates the real route.
      const desired = (body as { state?: unknown } | null)?.state;
      if (desired !== undefined && desired !== "Enabled" && desired !== "Paused") {
        return json({ error: 'state must be "Enabled" or "Paused"' }, 400);
      }
      tasks = tasks.map((x) =>
        x.id === id ? { ...x, enabled: desired !== undefined ? desired === "Enabled" : !x.enabled } : x,
      );
      return json({ task: tasks.find((x) => x.id === id) });
    }

    const taskMatch = path.match(/\/api\/cubepilot\/tasks\/([^/]+)$/);
    if (taskMatch && method === "DELETE") {
      const id = decodeURIComponent(taskMatch[1]);
      tasks = tasks.filter((x) => x.id !== id);
      delete reports[id];
      return json({ deleted: true });
    }

    if (path.endsWith("/api/cubepilot/tasks")) {
      if (method === "POST") {
        const input = body as { name: string; prompt?: string; schedule?: string; templateRef?: string; params?: Record<string, string> };
        created += 1;
        const task: Task = {
          id: `user-task-${created}`,
          name: input.name,
          prompt: input.prompt ?? "",
          schedule: input.schedule ?? "",
          templateRef: input.templateRef,
          enabled: true,
          creator: "admin",
          createdAt: "2026-09-15T03:10:00Z",
        };
        tasks = [task, ...tasks];
        reports[task.id] = [];
        return json({ task }, 201);
      }
      return json({ tasks });
    }
    return json({ error: `unstubbed ${method} ${path}` }, 404);
  });
  return captured;
}

async function pinLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cubestack-locale", "zh-CN");
    localStorage.setItem("cubestack-theme", "light");
  });
}

/** Open the 自动化任务 tab (the panes all mount; only this one is visible). */
async function openTasks(page: Page, stub: Stub = {}): Promise<Captured> {
  const captured = await stubTasks(page, stub);
  await page.goto("/cubepilot");
  await page.locator('[data-od-id="cp-tab-tasks"]').click();
  await expect(page.locator('[data-od-id="cp-tasks-pane"]')).toBeVisible();
  return captured;
}

test.beforeEach(async ({ context, page }) => {
  await pinLocale(page);
  await seedSession(context);
});

test.describe("cubepilot tasks tab (CR-backed data)", () => {
  test("renders the task rows from the CR projection", async ({ page }) => {
    await openTasks(page, { tasks: [TASK_DAILY, TASK_MANUAL, TASK_TEST] });

    const pane = page.locator('[data-od-id="cp-tasks-pane"]');
    await expect(pane).toContainText("自动化任务");
    await expect(pane).toContainText("3 个任务 · 报告类型取决于模板");

    // Cron task: the template's display name, the rendered schedule and the
    // last/next run the operator wrote back.
    const daily = page.locator(`[data-od-id="cp-task-row-${TASK_DAILY.id}"]`);
    await expect(daily).toContainText("每日集群巡检");
    await expect(daily).toContainText("集群日常巡检");
    await expect(daily).toContainText("定时 + 手动");
    await expect(daily).toContainText("每天 06:00 (UTC)");
    await expect(daily).toContainText("已启用");
    // fmtTime drops the date for same-day values, so accept both forms.
    await expect(daily).toContainText(/(09-13 )?06:04/);
    await expect(daily).toContainText(/(09-14 )?06:00/);
    await expect(daily).toContainText("admin");

    // Manual, paused, free-form task.
    const manual = page.locator(`[data-od-id="cp-task-row-${TASK_MANUAL.id}"]`);
    await expect(manual).toContainText("升级前预检(v1.4.0)");
    await expect(manual).toContainText("自由任务");
    await expect(manual).toContainText("仅手动");
    await expect(manual).toContainText("已停用");
    await expect(manual).toContainText("启用");

    // A task nothing has run yet: both run cells fall back to a dash.
    const fresh = page.locator(`[data-od-id="cp-task-row-${TASK_TEST.id}"]`);
    await expect(fresh).toContainText("test");
    await expect(fresh).toContainText("-");
    await expect(page.locator('[data-od-id="cp-tasks-run-now"]')).toBeDisabled();
  });

  test("guides the user when no task exists", async ({ page }) => {
    await openTasks(page);
    await expect(page.locator('[data-od-id="cp-tasks-pane"]')).toContainText("暂无任务 — 点击右上角「新建任务」创建");
    await expect(page.locator('[data-od-id="cp-tasks-report"]')).toHaveCount(0);
  });

  test("a selected task with no run yet explains there is nothing to show", async ({ page }) => {
    // The freshly created task's case: the CR exists, the run pipeline has not
    // executed it, so /reports is empty.
    await openTasks(page, { tasks: [TASK_TEST] });

    await page.locator(`[data-od-id="cp-task-row-${TASK_TEST.id}"]`).click();
    const pane = page.locator('[data-od-id="cp-tasks-pane"]');
    await expect(pane).toContainText("任务报告");
    await expect(pane).toContainText("选择任务查看其执行记录");
    await expect(page.locator('[data-od-id="cp-tasks-report"]')).toHaveCount(0);
    // Running it is still offered (and enabled now that a task is selected).
    await expect(page.locator('[data-od-id="cp-tasks-run-now"]')).toBeEnabled();
  });

  test("shows a task's run history, severity split and report body, and exports it", async ({ page }) => {
    await openTasks(page, { tasks: [TASK_DAILY], reports: { [TASK_DAILY.id]: [REPORT_OK, REPORT_FAILED] } });

    await page.locator(`[data-od-id="cp-task-row-${TASK_DAILY.id}"]`).click();
    const report = page.locator('[data-od-id="cp-tasks-report"]');
    // The report header (title + selected-run subtitle) sits above the panel.
    await expect(page.locator('[data-od-id="cp-tasks-pane"]')).toContainText("每日集群巡检 · 定时触发 · 报告即 Agent 真实输出");
    await expect(report).toContainText("上次运行");
    await expect(report).toContainText(/(09-13 )?06:00/);
    await expect(report).toContainText("耗时 4m 0s");
    await expect(report).toContainText("严重度统计");
    await expect(report).toContainText("3 项");
    await expect(report).toContainText("P0 0");
    await expect(report).toContainText("P1 2");
    await expect(report).toContainText("P2 1");
    await expect(report).toContainText("运行次数");
    await expect(report).toContainText("成功");
    // The Markdown body of the newest run is rendered.
    await expect(report).toContainText("集群日常巡检报告");
    await expect(report).toContainText("gpu-nvidia-02 GPU#3 温度 88°C");

    // Switching the run selector shows the older, failed run.
    await page.locator('[data-od-id="cp-tasks-report-select"]').selectOption("1");
    await expect(report).toContainText("手动触发");
    await expect(report).toContainText("失败");
    await expect(report).toContainText("etcd 碎片率超过阈值");

    // Export downloads the selected run as markdown.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('[data-od-id="cp-tasks-export"]').click(),
    ]);
    expect(download.suggestedFilename()).toBe("report-run-09132200.md");
    const text = readFileSync((await download.path()) as string, "utf8");
    expect(text).toContain("# 每日集群巡检");
    expect(text).toContain("Status: failed");
    expect(text).toContain("etcd 碎片率超过阈值");
  });

  test("run now asks the scheduler to fire the task and shows the new run", async ({ page }) => {
    const captured = await openTasks(page, { tasks: [TASK_TEST] });

    await page.locator(`[data-od-id="cp-task-row-${TASK_TEST.id}"]`).click();
    await page.locator('[data-od-id="cp-tasks-run-now"]').click();

    await expect(page.getByText("已触发,任务正在以你的身份运行")).toBeVisible();
    const run = captured.requests.filter((r) => r.path.endsWith(`/${TASK_TEST.id}/run`));
    expect(run).toHaveLength(1);
    expect(run[0].method).toBe("POST");

    // The refreshed run list carries the in-flight run, so the report panel
    // switches to the running state (and the pane starts polling it).
    const report = page.locator('[data-od-id="cp-tasks-report"]');
    await expect(report).toContainText("运行中");
    await expect(report).toContainText("运行进行中,报告内容将在完成后显示。");
  });

  test("toggles a task and deletes it after confirming", async ({ page }) => {
    const captured = await openTasks(page, { tasks: [TASK_DAILY, TASK_TEST] });
    const row = page.locator(`[data-od-id="cp-task-row-${TASK_DAILY.id}"]`);

    // Pause: the row's own action posts /toggle and the refetched list flips.
    await row.getByRole("button", { name: "停用" }).click();
    await expect(page.getByText("任务已停用")).toBeVisible();
    await expect(row).toContainText("已停用");
    await expect(row).toContainText("启用");

    // Delete: a native confirm gates it, then the row disappears.
    page.on("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "删除" }).click();
    await expect(page.getByText("任务已删除")).toBeVisible();
    await expect(page.locator(`[data-od-id="cp-task-row-${TASK_DAILY.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-od-id="cp-task-row-${TASK_TEST.id}"]`)).toBeVisible();

    const paths = captured.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`POST /api/cubepilot/tasks/${TASK_DAILY.id}/toggle`);
    expect(paths).toContain(`DELETE /api/cubepilot/tasks/${TASK_DAILY.id}`);
  });

  test("creates a template task with its params, cron and rendered instruction", async ({ page }) => {
    const captured = await openTasks(page, { tasks: [TASK_TEST] });

    await page.locator('[data-od-id="cp-tasks-new"]').click();
    const dialog = page.locator('[data-od-id="cp-tasks-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("新建定时任务");

    // A free-form task needs a prompt: the client refuses before any request.
    await page.locator('[data-od-id="cp-tasks-dialog-name"]').fill("冒烟检查");
    await page.locator('[data-od-id="cp-tasks-dialog-create"]').click();
    await expect(page.getByText("请输入任务指令,或选择模板")).toBeVisible();
    expect(captured.requests.some((r) => r.method === "POST" && r.path.endsWith("/api/cubepilot/tasks"))).toBe(false);

    // Picking the inspection template pulls its default cron and params.
    await dialog.getByLabel("任务模板").selectOption(TPL_INSPECT.name);
    await expect(dialog).toContainText("参数 · 集群日常巡检");
    await expect(dialog).toContainText("模板默认:0 6 * * *(UTC)");
    await expect(dialog).toContainText("将于每天 06:00(UTC)执行");
    await expect(page.locator('[data-od-id="cp-tasks-dialog-cron"]')).toHaveValue("0 6 * * *");
    await expect(dialog).toContainText("对 all 范围执行全量巡检");

    // Changing a param re-renders the (read-only) instruction preview.
    await dialog.getByLabel("scope").selectOption("compute");
    await expect(dialog).toContainText("对 compute 范围执行全量巡检");

    // An invalid cron is caught inline and blocks submission.
    await page.locator('[data-od-id="cp-tasks-dialog-cron"]').fill("bad");
    await expect(dialog).toContainText("无效的 Cron 表达式");
    await page.locator('[data-od-id="cp-tasks-dialog-create"]').click();
    expect(captured.requests.some((r) => r.method === "POST" && r.path.endsWith("/api/cubepilot/tasks"))).toBe(false);

    // Valid input posts the template ref + params, then selects the new task.
    await page.locator('[data-od-id="cp-tasks-dialog-cron"]').fill("0 2 * * *");
    await page.locator('[data-od-id="cp-tasks-dialog-create"]').click();
    await expect(page.getByText("任务「冒烟检查」已创建,将以你的身份运行")).toBeVisible();
    await expect(dialog).toHaveCount(0);

    const post = captured.requests.find((r) => r.method === "POST" && r.path.endsWith("/api/cubepilot/tasks"));
    expect(post?.body).toEqual({
      name: "冒烟检查",
      schedule: "0 2 * * *",
      templateRef: TPL_INSPECT.name,
      params: { scope: "compute" },
    });
    await expect(page.locator('[data-od-id="cp-task-row-user-task-1"]')).toContainText("冒烟检查");
  });

  test("a manual task carries no schedule", async ({ page }) => {
    const captured = await openTasks(page, { tasks: [] });

    await page.locator('[data-od-id="cp-tasks-new"]').click();
    const dialog = page.locator('[data-od-id="cp-tasks-dialog"]');
    await page.locator('[data-od-id="cp-tasks-dialog-name"]').fill("现场排查");
    await dialog.getByLabel("任务指令(AI 执行内容)").fill("检查 compute-02 的 GPU 温度并给出结论");
    await dialog.getByRole("radio", { name: "手动" }).click();
    // The cron field is gone in manual mode.
    await expect(page.locator('[data-od-id="cp-tasks-dialog-cron"]')).toHaveCount(0);
    await page.locator('[data-od-id="cp-tasks-dialog-create"]').click();

    await expect(page.getByText("任务「现场排查」已创建,将以你的身份运行")).toBeVisible();
    const post = captured.requests.find((r) => r.method === "POST" && r.path.endsWith("/api/cubepilot/tasks"));
    expect(post?.body).toEqual({ name: "现场排查", prompt: "检查 compute-02 的 GPU 温度并给出结论", schedule: "" });
    await expect(page.locator('[data-od-id="cp-task-row-user-task-1"]')).toContainText("仅手动");
  });

  test("the templates segment lists the TaskTemplates and creates from one", async ({ page }) => {
    await openTasks(page, { tasks: [] });

    await page.locator('[data-od-id="cp-tasks-seg-templates"]').click();
    const card = page.locator('[data-od-id="cp-tasks-templates"]');
    await expect(card).toContainText("模板管理");
    await expect(card).toContainText("集群日常巡检");
    await expect(card).toContainText("节点 / GPU / 存储 / 网关全量巡检");
    await expect(card).toContainText("0 6 * * *");
    await expect(card).toContainText("GPU 节点健康检查");

    // 基于此创建 opens the dialog with that template pre-selected.
    await card.getByRole("button", { name: "基于此创建" }).first().click();
    const dialog = page.locator('[data-od-id="cp-tasks-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("参数 · 集群日常巡检");
    await expect(dialog).toContainText("将于每天 06:00(UTC)执行");
  });
});
