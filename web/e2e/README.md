# E2E tests

Two suites cover the overview landing at different layers:

## Suite A — `e2e/overview.ui.spec.ts` + `e2e/inference-services.ui.spec.ts` (CI-cheap, deterministic)

`/api/overview` is stubbed at the network level with the shared fixtures in
`test/fixtures/overview.ts`, so **no KinD cluster or Prometheus is needed**.
Covers the whole overview UI state space: KPI row, subtitle, trend legend,
allocation donut, empty/error states + retry, the 30s poll, and the locale
switch. The inference-services suite (`inference-services.ui.spec.ts`, backed
by `test/fixtures/inferenceservices.ts`) covers the service table, the
Ready/未就绪 filter, the detail panel, and the deploy-wizard create flow.

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
- Both suites pin the platform locale to `zh-CN` because headless Chromium
  defaults `navigator.language` to `en-US`.
