# E2E tests

Two suites cover the overview landing at different layers:

## Suite A — `e2e/overview.ui.spec.ts` + `e2e/inference-services.ui.spec.ts` + `e2e/cubepilot.ui.spec.ts` + `e2e/cubepilot-tasks.ui.spec.ts` (CI-cheap, deterministic)

`/api/overview` is stubbed at the network level with the shared fixtures in
`test/fixtures/overview.ts`, so **no KinD cluster or Prometheus is needed**.
Covers the whole overview UI state space: KPI row, subtitle, trend legend,
allocation donut, empty/error states + retry, the 30s poll, and the locale
switch. The inference-services suite (`inference-services.ui.spec.ts`, backed
by `test/fixtures/inferenceservices.ts`) covers the service table, the
Ready/未就绪 filter, the detail panel, and the deploy-wizard create flow.

The cubepilot suites stub every `/api/cubepilot/*` endpoint with CR-shaped
payloads — no cluster, cubepilot-api or AI Gateway. `cubepilot.ui.spec.ts`
drives the agent surface: the CR-projected greeting and context rail, the SSE
turn (deltas, paired tool result, write-approval card, approve decision), an
ask_user question, the persisted-session restore path (history + a
still-pending approval), and the config tab's model/prompt/policy/allowlist
editing including the gateway-unreachable degradation.
`cubepilot-tasks.ui.spec.ts` drives the 自动化任务 tab: the task table
(template display name, rendered cron, last/next run, enabled state), the empty
states (no task at all, and a task the run pipeline has not executed yet), a
run's history + severity split + rendered report body + markdown export, 立即运行
(scheduler annotation → the new in-flight run), 暂停/启用, 删除 with its confirm,
and the create dialog (free-form vs template params + instruction preview, cron
validation, manual trigger, and the posted payload).

```sh
npm run test:e2e            # playwright test (playwright.config.ts)
```

The `webServer` is `npm run dev`; locally it reuses a server already running
on :3000 (`reuseExistingServer`).

## Suite B — `e2e/overview.datapath.spec.ts` (local smoke, opt-in)

One resilient spec that runs the **real** `/api/overview` route against the
preview stack: mock Prometheus (:9090) + perses (:8081) + Next (:3000), with
the live KinD cluster supplying the node/CR figures. This is the only place the
PromQL parse → padSeries(48) → chart path is verified end to end.

```sh
npm run test:e2e:datapath   # playwright test -c playwright.datapath.config.ts
```

Requirements:
- the KinD cluster reachable via the default kubeconfig (`kind-cubestack`)
- the preview stack, started by `e2e/deploy/perses/local/run-preview.sh`
  (downloads the perses binary into `~/.cache/perses-preview` on first use)

Assertions are intentionally coarse (node total ≥ 0, a Ready/NotReady breakdown,
trend shows a percentage) because the cluster numbers change.

## One-time setup

```sh
npx playwright install chromium --only-shell
```

## Notes

- Fixtures are shared with the vitest unit tests, so unit and e2e assert the
  same payloads (`test/fixtures/overview.ts`).
- These suites pin the platform locale to `zh-CN` because headless Chromium
  defaults `navigator.language` to `en-US`.
- Reusing a running :3000 dev server only works when it was started with
  `SESSION_SECRET=e2e-session-secret` (the specs mint real signed cookies with
  it); otherwise stop it first — Playwright then starts its own server with the
  fixed secret, and Next refuses a second `next dev` for the same directory.
