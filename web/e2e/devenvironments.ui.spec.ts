import { expect, test, type Page } from "@playwright/test";
import { devEnvironmentList, devEnvironmentSummary } from "../test/fixtures/devenvironments";
import { seedSession } from "./auth";

// Deterministic, CI-cheap e2e suite for /dev-environments. /api/devenvironments
// and /api/devenvironments/options are stubbed at the network level with the
// shared fixtures, so no KinD cluster is required. The platform locale is
// pinned to zh-CN (headless Chromium defaults to en-US).

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  // The API names the namespace the wizard opens on. Here it is `default` even
  // though project-a sorts first, which is the point of the field.
  defaultNamespace: "default",
  images: [
    { tag: "harbor.isuanova.com/suanova/jupyter-minimal:latest", label: "suanova/jupyter-minimal · CPU · JupyterLab (jovyan)", user: "jovyan", runAsGroup: 100, interface: "jupyter", vendor: "cpu" },
    { tag: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest", label: "suanova/ssh-ubuntu22.04 · CPU · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "cpu" },
    { tag: "harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest", label: "suanova/jupyter-cuda-pytorch · NVIDIA CUDA · JupyterLab (ubuntu)", user: "ubuntu", interface: "jupyter", vendor: "nvidia" },
    { tag: "harbor.isuanova.com/suanova/ssh-cuda-pytorch:latest", label: "suanova/ssh-cuda-pytorch · NVIDIA CUDA · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "nvidia" },
    { tag: "harbor.isuanova.com/suanova/jupyter-maca-pytorch:latest", label: "suanova/jupyter-maca-pytorch · Metax MACA · JupyterLab (ubuntu)", user: "ubuntu", interface: "jupyter", vendor: "metax" },
    { tag: "harbor.isuanova.com/suanova/ssh-maca-pytorch:latest", label: "suanova/ssh-maca-pytorch · Metax MACA · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "metax" },
  ],
  // What the cluster's nodes advertise, per vendor — the wizard's model select
  // is exactly this list plus "any".
  gpuModels: { nvidia: ["A100", "H200"], metax: ["MXC500", "MXC550"] },
  // The nodes the wizard may pin to, each with the accelerators it advertises —
  // the placement select is exactly this list plus "any".
  nodes: [
    { name: "worker-01", vendors: ["nvidia"] },
    { name: "worker-02", vendors: [] },
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

// The environment's own Jupyter token, served the way the route serves it: only
// when the card asks. Returns the request log, so a test can prove the credential
// is not fetched for a card the user merely selected.
function stubToken(page: Page, token = "itest-jupyter-token-0f3a"): string[] {
  const requests: string[] = [];
  page.route("**/api/devenvironments/token?*", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: { token, secret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" } } });
  });
  return requests;
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
    await page.goto("/cubestack/dev-environments");

    const table = page.locator('[data-od-id="dev-table"]');
    await expect(table).toContainText("jupyter-nlp-ln");
    await expect(table).toContainText("ssh-dataset-prep");

    const jupyter = page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]');
    await expect(jupyter).toContainText("JUPYTER");
    await expect(jupyter).toContainText("1 × GPU");
    await expect(jupyter).toContainText("Running");
    await expect(jupyter).toContainText("project-a");

    const ssh = page.locator('[data-od-id="dev-row-ssh-dataset-prep"]');
    await expect(ssh).toContainText("SSH");
    // A CPU image with no accelerator: spec.resources.gpu is absent, so the
    // cell says so rather than inventing a card.
    await expect(ssh).toContainText("无加速卡");
    await expect(ssh).toContainText("Stopped");
    // The image is a detail-panel fact, not a column: a long registry path in
    // every row is what made the table unreadable. It belongs to the panel under
    // the row, which is why the rows are what carry no image rather than the
    // table — the table now holds the open panel too.
    await expect(jupyter).not.toContainText("jupyter-cuda-pytorch:latest");
    await expect(ssh).not.toContainText("ssh-ubuntu22.04:latest");

    // A closed row keeps its actions behind the kebab, which is what one
    // clicks first.
    await ssh.locator('[data-od-id="env-ops-ssh-dataset-prep"]').click();
    await expect(page.locator('[data-od-id="act-start-ssh-dataset-prep"]')).toBeVisible();
    await expect(page.locator('[data-od-id="act-del-ssh-dataset-prep"]')).toBeVisible();
  });

  test("filters rows by Running / Stopped tab", async ({ page }) => {
    await stubList(page, { items: devEnvironmentList() });
    await page.goto("/cubestack/dev-environments");

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
    const requests = stubToken(page);
    await page.goto("/cubestack/dev-environments");

    // The detail sits under the row it belongs to, so the row is a disclosure:
    // the first environment is open on arrival, a click closes it, and the next
    // click opens it again.
    const row = page.locator('[data-od-id="dev-row-jupyter-nlp-ln"]');
    await expect(page.locator('[data-od-id="dev-detail-jupyter-nlp-ln"]')).toBeVisible();
    // The open row lays its actions out in the row; the kebab is what a closed
    // row keeps them behind, and it comes back when the row closes.
    await expect(page.locator('[data-od-id="act-stop-jupyter-nlp-ln"]')).toBeVisible();
    await expect(page.locator('[data-od-id="env-ops-jupyter-nlp-ln"]')).toHaveCount(0);
    await row.click();
    await expect(page.locator('[data-od-id="dev-detail-jupyter-nlp-ln"]')).toHaveCount(0);
    await expect(page.locator('[data-od-id="env-ops-jupyter-nlp-ln"]')).toHaveCount(1);
    await expect(page.locator('[data-od-id="act-stop-jupyter-nlp-ln"]')).toHaveCount(0);
    await row.click();
    await expect(page.locator('[data-od-id="dev-detail-jupyter-nlp-ln"]')).toBeVisible();

    const detail = page.locator("body");
    await expect(detail).toContainText("连接信息");
    await expect(detail).toContainText("https://dev.cubestack.local/ws/jupyter-nlp-ln");
    // The endpoint opens the container's own UI: it is an anchor, not text the
    // user has to select and paste, and Copy is still beside it.
    const endpoint = page.locator('[data-od-id="endpoint-link"]').first();
    await expect(endpoint).toHaveAttribute("href", "https://dev.cubestack.local/ws/jupyter-nlp-ln");
    await expect(endpoint).toHaveAttribute("target", "_blank");
    await expect(detail.getByRole("button", { name: "复制" }).first()).toBeVisible();
    // The spec and the status are separate sections, so each is asserted by its
    // own title rather than by one heading that covered both.
    await expect(detail).toContainText("规格");
    await expect(detail).toContainText("状态");
    await expect(detail).toContainText("harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest");
    await expect(detail).toContainText("1 × nvidia");
    // Step 3's three new sections each get a row, and the storage row carries
    // the mount path the CR states rather than one the panel invents.
    await expect(detail).toContainText("200Gi · /home/ubuntu");
    await expect(detail).toContainText("data-cache → /data");
    await expect(detail).toContainText("HF_HOME · HF_TOKEN");
    await expect(detail).toContainText("python -m jupyter lab");
    await expect(detail).toContainText("--port 8080");
    await expect(detail).toContainText("api:8080/http");
    // Where the pod runs and what it may reach. Egress is stated for every
    // environment, so the row names the policy this one asked for rather than
    // leaving the reader to infer it from a missing row.
    await expect(detail).toContainText("kubernetes.io/hostname=worker-01");
    await expect(detail).toContainText("不受限");
    // The jupyter token is the token itself, masked until asked for: the card
    // used to hand the user a `kubectl` command to run against a cluster.
    await expect(detail).toContainText("Jupyter Token");
    await expect(page.locator('[data-od-id="token-secret"]')).toContainText("project-a/jupyter-nlp-ln-jupyter-token");
    await expect(page.locator('[data-od-id="token-value"]')).toHaveText("•".repeat(12));
    await expect(page.locator('[data-od-id="token-toggle"]')).toHaveAttribute("aria-label", "显示 Token");
    await expect(detail).not.toContainText("kubectl -n");

    await page.locator('[data-od-id="token-toggle"]').click();
    await expect(page.locator('[data-od-id="token-value"]')).toHaveText("itest-jupyter-token-0f3a");
    await expect(page.locator('[data-od-id="token-toggle"]')).toHaveAttribute("aria-label", "隐藏 Token");

    // ...and hiding it again reads nothing a second time.
    await page.locator('[data-od-id="token-toggle"]').click();
    await expect(page.locator('[data-od-id="token-value"]')).toHaveText("•".repeat(12));
    expect(requests).toHaveLength(1);
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
    await page.goto("/cubestack/dev-environments");

    // A stopped environment offers start behind the kebab; the patch follows
    // the menu item, not the row.
    await page.locator('[data-od-id="env-ops-ssh-dataset-prep"]').click();
    await page.locator('[data-od-id="act-start-ssh-dataset-prep"]').click();
    await expect.poll(() => patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ namespace: "project-a", name: "ssh-dataset-prep", running: true });
  });

  test("delete asks in the console's own dialog, and cancelling sends nothing", async ({ page }) => {
    const deletes: Array<Record<string, unknown>> = [];
    await stubList(page, { items: devEnvironmentList() });
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "DELETE") {
        deletes.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { items: devEnvironmentList() } });
    });
    await page.goto("/cubestack/dev-environments");

    await page.locator('[data-od-id="env-ops-ssh-dataset-prep"]').click();
    await page.locator('[data-od-id="act-del-ssh-dataset-prep"]').click();

    // The console's dialog rather than the browser's: a native confirm would
    // block the page and leave nothing to query, and it could not be composed
    // from what the console knows — the workspace's fate, named per environment.
    const dialog = page.locator('[data-od-id="delete-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-od-id="delete-prompt"]')).toContainText("ssh-dataset-prep");
    await expect(page.locator('[data-od-id="delete-confirm"]')).toContainText("删除");
    expect(deletes).toHaveLength(0);

    await page.locator('[data-od-id="delete-cancel"]').click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toHaveLength(0);

    // Confirming is what sends it.
    await page.locator('[data-od-id="env-ops-ssh-dataset-prep"]').click();
    await page.locator('[data-od-id="act-del-ssh-dataset-prep"]').click();
    await page.locator('[data-od-id="delete-confirm"]').click();
    await expect.poll(() => deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({ namespace: "project-a", name: "ssh-dataset-prep" });
  });

  test("creates an environment through the wizard and selects it", async ({ page }) => {
    await stubOptions(page);
    // The namespace is carried through from the POST: the console selects the
    // environment it just created by `${namespace}/${name}`, so a stub that
    // answers in the fixture's own namespace would leave the selection silently
    // pointing at the environment that was selected before.
    let created: { name: string; namespace: string } | null = null;
    const createdSummary = () =>
      devEnvironmentSummary({ name: created?.name, namespace: created?.namespace, endpoints: [] });
    const posts: Array<Record<string, unknown>> = [];
    await page.route("**/api/devenvironments?*", (route) =>
      route.fulfill({
        json: {
          items: created ? [createdSummary(), ...devEnvironmentList()] : devEnvironmentList(),
        },
      }),
    );
    await page.route("**/api/devenvironments", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name?: string; namespace?: string };
        posts.push(body);
        created = { name: body.name ?? "unknown", namespace: body.namespace ?? "default" };
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ created: true, name: created.name }) });
      }
      return route.fulfill({
        json: { items: created ? [createdSummary(), ...devEnvironmentList()] : devEnvironmentList() },
      });
    });
    await page.goto("/cubestack/dev-environments");

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
    // Selected means opened: the detail is under the row, and it is this one's.
    await expect(page.locator('[data-od-id="dev-detail-my-env"]')).toBeVisible();
    await expect(page.locator('[data-od-id="create-wizard"]')).toBeHidden();

    // The wizard walks the untouched defaults through to the API: the catalog
    // opens on the CPU jupyter image with no accelerator chosen, and `none` is
    // the body's way of saying spec.resources.gpu stays absent.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      name: "my-env",
      // Step 1 opens on the namespace the API offers, not on the first one it
      // lists — project-a sorts first and is not the default.
      namespace: "default",
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
    expect(posts[0]).not.toHaveProperty("gpuModel");
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
    await page.goto("/cubestack/dev-environments");

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
    await page.goto("/cubestack/dev-environments");

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
    await page.goto("/cubestack/dev-environments");

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
    await page.locator('[data-od-id="wizard-command"] input').fill("python -m jupyter lab");

    await page.locator('[data-od-id="row-add"]').nth(2).click();
    await page.locator('[data-od-id="port-name"] input').fill("debug");
    await page.locator('[data-od-id="port-num"] input').fill("9229");

    // Egress on, and a node to pin the pod to. The select lists "any" plus one
    // entry per node the options read advertised, the GPU ones carrying the
    // vendors they advertise beside their name.
    await page.locator('[data-od-id="wizard-egress"] input').click();
    await page.locator('[data-od-id="wizard-node"]').click();
    await expect(page.locator('[role="option"]')).toHaveText(["不限(由调度器选择)", "worker-01 · nvidia", "worker-02"]);
    await page.locator('[role="option"]').filter({ hasText: "worker-01" }).click();

    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.locator('[data-step="4"]')).toBeVisible();
    await expect(page.locator('[data-step="4"]')).toContainText("shared-models → /models");
    // Both of this step's new choices are restated before the environment is
    // created: the node by its own name, and the egress policy it asked for.
    await expect(page.locator('[data-step="4"]')).toContainText("worker-01");
    await expect(page.locator('[data-step="4"]')).toContainText("不受限");

    await page.locator('[data-od-id="wizard-create"]').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      name: "advanced-env",
      mountPath: "/data",
      volumes: [{ pvcName: "shared-models", mountPath: "/models" }],
      env: [{ name: "HF_HOME", value: "/data/hf" }],
      // One line each on the wire; the route splits them into argv.
      command: "python -m jupyter lab",
      args: "--port 8080",
      ports: [{ name: "debug", containerPort: 9229, type: "http" }],
      // The node's own name, not a label map: the route turns it into the
      // kubernetes.io/hostname pin.
      nodeName: "worker-01",
      egressUnrestricted: true,
    });
  });

  test("an untouched advanced step sends none of its optional keys", async ({ page }) => {
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
    await page.goto("/cubestack/dev-environments");

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
    // pinning one would override the home the image's entrypoint derives. The
    // node select opens on "any" and the egress switch on off, so the pin and
    // the policy are absent too: an empty selector selects nothing, and
    // `unrestricted: false` is what the CRD already applies.
    for (const key of ["mountPath", "volumes", "env", "command", "args", "ports", "nodeName", "egressUnrestricted"]) {
      expect(posts[0]).not.toHaveProperty(key);
    }
  });
});

test.describe("platform chrome", () => {
  test("paints a ?theme= override before hydration and keeps it", async ({ page }) => {
    // The root layout's inline script stamps `?theme=` before the first paint and
    // never writes it to localStorage — so a console that derives the theme from
    // storage on mount paints the override away again a few milliseconds later
    // (measured on cs7, `?theme=dark` with nothing stored: dark at 1ms, light at
    // 3ms). Recording every write to the attribute is the only way to see that
    // from the outside.
    await page.addInitScript(() => {
      const writes: string[] = [];
      (window as unknown as { themeWrites: string[] }).themeWrites = writes;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "data-theme") writes.push((record.target as HTMLElement).dataset.theme ?? "");
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
    });
    await stubList(page, { items: devEnvironmentList() });
    // pinLocale stores `light`, so the override has something to win against.
    await page.goto("/cubestack/dev-environments?theme=dark");

    // The bootstrap writes once; every component that reads the theme re-stamps
    // it on mount, which is a write of the same value. Waiting for that second
    // write is what makes the assertions below about the console and not about
    // the pre-hydration paint they would otherwise race.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { themeWrites: string[] }).themeWrites.length))
      .toBeGreaterThan(1);

    // The mounted console must leave the override alone. Read from storage
    // instead, this is `light` — the theme pinLocale stored — which is the whole
    // defect: the override is stamped for a paint or two and then written over.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const writes = await page.evaluate(() => (window as unknown as { themeWrites: string[] }).themeWrites);
    expect([...new Set(writes)]).toEqual(["dark"]);

    // ...and the toggle still answers, from an overridden first paint.
    await page.locator('[data-od-id="theme-toggle"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
