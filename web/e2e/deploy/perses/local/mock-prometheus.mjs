#!/usr/bin/env node
// Mock Prometheus HTTP API.
//
// Feeds the Perses dashboards synthetic metrics so the portal can be previewed
// without a real Prometheus. Implements just the endpoints the Perses Prometheus
// plugin uses: query, query_range, series, labels, label/<name>/values, plus the
// health/buildinfo probes the readiness path touches.
//
// Data is generated on the fly: every query returns a handful of series whose
// metric name is parsed out of the PromQL and whose values are deterministic
// waves with a bit of noise. Variables and series lookups return canned label
// sets so the dashboard dropdowns populate.
//
// Usage: node mock-prometheus.mjs [port]   (default 9090)

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 9090);

// SGLang (inference server) metrics are grouped by the inference service
// exposing them (the `instance` label is the service name, e.g. dsv4-flash-pd)
// and by the single model that service serves (`model_name`). The dashboard's
// `instance` variable is the only place an `instance` label is queried, so the
// services live here rather than in LABEL_VALUES (which the kubernetes-mixin
// dashboards use for node-style instances).
const SGLANG_INSTANCES = ["dsv4-flash-pd", "dsv4-pro-pd"];
const SGLANG_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
// Histogram bucket [lower, upper] bounds (seconds) for the two latency families.
const SGLANG_HISTOGRAM_BUCKETS = {
  e2e: [
    ["0.001", "0.01"], ["0.01", "0.05"], ["0.05", "0.1"], ["0.1", "0.25"],
    ["0.25", "0.5"], ["0.5", "1"], ["1", "2.5"], ["2.5", "5"], ["5", "10"],
  ],
  ttft: [
    ["0.001", "0.01"], ["0.01", "0.05"], ["0.05", "0.1"], ["0.1", "0.25"],
    ["0.25", "0.5"], ["0.5", "1"], ["1", "2"], ["2", "4"],
  ],
};

// MetaX (mxExporter) GPU servers and per-server device ids. The dashboard's
// `server` variable reads the `instance` label while panel queries filter on
// `Hostname`, so both labels carry the same value here (they differ only by
// scrape port in the real exporter, which the mock does not model).
const METAX_SERVERS = ["lg-pc-10-2-122-120", "lg-pc-10-2-122-121", "lg-pc-10-2-122-122"];
const METAX_DEVICES = ["0", "1"];
// Link ids shown by the MetaXLink tables (speed / link width).
const METAX_LINK_IDS = ["0", "1", "2", "3"];
const METAX_EID_INFO = [
  "ERR_INVALID_DEVICE_HANDLE",
  "ERR_MEMORY_INIT",
  "ERR_CONTEXT_CREATE",
  "ERR_NOT_INITIALIZED",
];

// Canned label values, grouped by the label names the kubernetes-mixin
// dashboards filter on. Enough variety for the variable dropdowns to feel real.
const LABEL_VALUES = {
  instance: ["node-a", "node-b", "dev-test-1", "dev-demo-1"],
  node: ["node-a", "node-b", "dev-test-1", "dev-demo-1"],
  pod: ["prometheus-0", "kube-state-metrics-0", "etcd-0", "kube-apiserver-0"],
  namespace: ["default", "kube-system", "openshift-monitoring", "openshift-etcd"],
  container: ["POD", "kube-rbac-proxy", "prometheus", "etcd"],
  job: ["kubelet", "node-exporter", "kube-state-metrics", "etcd", "kube-apiserver"],
  mode: ["idle", "user", "system", "iowait"],
  condition: ["true", "false", "unknown"],
  gpu: ["gpu0", "gpu1", "gpu2", "gpu3"],
  usage: ["inference server", "devEnvironment"],
  cluster: ["perses-dev"],
  model_name: SGLANG_MODELS,
};

// Label names the mixin dashboards use in their variable queries.
const ALL_LABELS = ["__name__", "instance", "node", "pod", "namespace", "container", "job", "mode", "condition", "gpu", "cluster", "usage", "model_name"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => min + Math.random() * (max - min);

// Pull the metric name out of a PromQL expression (e.g. "sum(rate(node_cpu_seconds_total{...}[5m])) by (instance)")
// or a series selector (e.g. "node_cpu_seconds_total"). Falls back to a default.
const FUNCTION_NAMES = new Set([
  "sum", "avg", "min", "max", "count", "rate", "irate", "increase", "delta",
  "quantile", "histogram_quantile", "topk", "bottomk", "by", "on", "without",
  "label_replace", "label_join", "abs", "ceil", "floor", "round", "clamp_min",
  "clamp_max", "clamp", "last_over_time", "sort", "sort_desc", "time", "vector",
  "absent", "stddev", "stdvar", "group", "count_values", "scalar", "deriv", "resets",
  // PromQL set operators join whole expressions ("a or vector(0)"); without
  // them here, `metricNameOf` returns "or" as the last identifier and the
  // overview's aggregate queries (which end in `or vector(1)`) fall back to a
  // generic near-zero wave instead of the DCGM/mx GPU metrics they reference.
  "or", "and", "unless",
]);

function metricNameOf(expr) {
  // Grafana range variables (`$__rate_interval`, `$__interval`) appear inside
  // `[...]`; strip every `$var` token so `_rate_interval` can't shadow the
  // metric name as the last identifier.
  expr = expr.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*/g, "");
  const inline = /__name__\s*=\s*"([^"]+)"/.exec(expr);
  if (inline) return inline[1];
  // The metric name sits directly before a label selector, e.g.
  // `dcgm_gpu_utilization{cluster="",node=~""}`. Drop everything from the last
  // `{` onward so a selector label like `node`/`gpu` can't shadow the real
  // metric name, then take the last identifier that remains.
  const open = expr.lastIndexOf("{");
  const text = open > 0 ? expr.slice(0, open) : expr;
  const tokens = text.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
  const candidate = tokens.filter((t) => !FUNCTION_NAMES.has(t)).at(-1);
  return candidate && candidate.length > 0 ? candidate : "example_metric";
}

// GPU metrics (DCGM / NVIDIA exporters) get a per-node GPU label so panels can
// group by (gpu) and see one series per device. DCGM metric names are uppercase
// (e.g. DCGM_FI_DEV_GPU_UTIL), so match case-insensitively. MetaX metrics
// (`mx_*`) also carry "gpu" (mx_gpu_usage, mx_gpu_state, ...) but are handled by
// their own catalog, so they must not be classified as DCGM here.
function isGpuMetric(metric) {
  return !/^mx_/.test(metric) && /dcgm|nvidia|gpu/i.test(metric);
}

// Plausible value band per DCGM metric family (min, max, amplitude) so a
// migrated Grafana GPU dashboard shows realistic temps, power, clocks,
// utilization and framebuffer bytes instead of a flat line.
function gpuValueRange(metric) {
  const m = metric.toLowerCase();
  if (m.includes("temp")) return [35, 78, 4]; // °C
  if (m.includes("util")) return [20, 90, 6]; // %
  if (m.includes("power")) return [80, 320, 12]; // W
  if (m.includes("clock")) return [400, 1700, 40]; // MHz
  if (m.includes("fb")) return [2e9, 24e9, 1.5e9]; // bytes (framebuffer)
  return [25, 85, 8];
}

// ---- SGLang metrics ----------------------------------------------------------
//
// The SGLang dashboard groups by instance and model_name. Series carry both
// labels; the two latency histograms are served two ways:
//   * the `_bucket` counters under `histogram_quantile(...)` (P99/P90/P50 lines),
//   * the base name (`..._seconds`) as a *native histogram*, which is the only
//     form the perses HeatMapChart panel can render.

function isSglangMetric(metric) {
  return /^sglang_/.test(metric);
}

// Native histogram series are addressed by the base name (no _bucket/_sum/_count).
function isSglangHistogramName(metric) {
  return (
    isSglangMetric(metric) &&
    /_seconds$/.test(metric) &&
    !/_bucket$|_sum$|_count$/.test(metric)
  );
}

// Plausible value band per sglang metric family (min, max, amplitude).
function sglangValueRange(metric) {
  const m = metric.toLowerCase();
  if (m.includes("latency")) return [0.05, 1.2, 0.15]; // seconds
  if (m.includes("time_to_first")) return [0.02, 0.4, 0.05]; // seconds
  if (m.includes("running")) return [4, 28, 3]; // request count
  if (m.includes("throughput")) return [80, 600, 40]; // tokens/s
  if (m.includes("cache_hit")) return [0.4, 0.95, 0.08]; // ratio
  if (m.includes("queue")) return [1, 12, 1.5]; // request count
  return [1, 100, 5];
}

// One series per inference service carrying its own model (each service serves
// exactly one model, so no instance x model cross product), used for
// native-histogram / matcher lookups.
function sglangSeries() {
  return SGLANG_INSTANCES.map((instance, i) => ({
    instance,
    model_name: SGLANG_MODELS[i % SGLANG_MODELS.length],
    job: "sglang",
    cluster: "perses-dev",
  }));
}

// One series per instance for the plain gauges/counters, so the `{{instance}}`
// legend stays one line per server. Identical to sglangSeries (one model each).
function sglangInstanceSeries() {
  return sglangSeries();
}

// A native histogram sample: `[time, {count, sum, buckets: [[idx, lower, upper, count]]}]`
// as the perses HeatMapChart expects (single series, cumulative bucket counts).
function sglangNativeHistogram(time, metric) {
  const bounds = SGLANG_HISTOGRAM_BUCKETS[metric.includes("time_to_first") ? "ttft" : "e2e"];
  const total = Math.floor(rand(1200, 2600));
  const counts = [];
  let prev = 0;
  for (let i = 0; i < bounds.length; i++) {
    let c = Math.floor(((total * (i + 1)) / bounds.length) * rand(0.85, 1.1));
    if (c <= prev) c = prev + 1;
    counts.push(c);
    prev = c;
  }
  counts[counts.length - 1] = Math.max(counts[counts.length - 1], total);
  const buckets = bounds.map(([lo, hi], i) => [i, lo, hi, String(counts[i])]);
  const avg = rand(0.15, 0.4); // seconds
  return [time, { count: total, sum: (total * avg).toFixed(3), buckets }];
}

// ---- MetaX (mxExporter) metrics ----------------------------------------------
//
// The MetaX GPU dashboard filters by server (Hostname) and deviceId. Series are
// answered from a fixed catalog — one series per server x device — plus
// per-family labels (modelName / driver_version / bios_version for the string
// stats, mxlkId for the MetaXLink tables, `type` for the rx/tx and ce/ue pairs).

function isMetaxMetric(metric) {
  return /^mx_/.test(metric);
}

// Plausible value band per MetaX metric family (min, max, amplitude).
function metaxValueRange(metric) {
  const m = metric.toLowerCase();
  if (m.includes("temp")) return [38, 105, 5]; // °C
  if (m.includes("power")) return [120, 650, 25]; // W
  if (m.includes("usage") || m.includes("util")) return [5, 95, 6]; // %
  if (m.includes("clock")) return [300, 1900, 60]; // MHz
  if (m.includes("mxlk_speed")) return [12.5, 50, 3]; // GT/s (link speeds)
  if (m.includes("speed") || m.includes("bridge")) return [2.5, 16, 1.5]; // GT/s
  if (m.includes("width")) return [8, 32, 1]; // lanes
  if (m.includes("dpm")) return [0, 3, 0.5]; // DPM level
  if (m.includes("eid")) return [1, 20, 2]; // EID codes
  if (m.includes("gpu_state")) return [1, 1, 0]; // 1 = unavailable
  if (m.includes("clk_thr")) return [0, 1, 0.5]; // 1 = throttling
  if (m.includes("aer") || m.includes("ecc") || m.includes("ras") || m.includes("event")) return [0, 120, 10]; // counts
  return [0, 100, 10];
}

// One base label set per server x device, carrying the labels the string stats
// render via StatChart's metricLabel.
function metaxBaseSeries() {
  const series = [];
  for (const server of METAX_SERVERS) {
    for (const deviceId of METAX_DEVICES) {
      series.push({
        Hostname: server,
        deviceId,
        instance: server,
        modelName: "C500",
        driver_version: "V1.11.0",
        bios_version: "V1.0.12",
        job: "mx-exporter",
        cluster: "perses-dev",
      });
    }
  }
  return series;
}

// The label sets that answer a query for `metric`: the base catalog plus the
// family's extra labels (typed rx/tx pairs, link ids, error descriptors...).
function metaxSeriesFor(metric) {
  const base = metaxBaseSeries();
  if (metric === "mx_gpu_state") {
    // Only one device is unavailable; the rest report no reason and are
    // excluded by the panel's `unavailable_reason!=""` matcher.
    return base.map((s, i) => (i === 0 ? { ...s, unavailable_reason: "PCIe link down" } : { ...s, unavailable_reason: "" }));
  }
  if (metric === "mx_driver_eid_errors" || metric === "mx_sdk_eid_errors") {
    return base.map((s, i) => ({ ...s, eid_info: METAX_EID_INFO[i % METAX_EID_INFO.length] }));
  }
  if (metric === "mx_memory_usage") {
    return base.map((s) => ({ ...s, type: "vram" }));
  }
  if (metric === "mx_mxlk_speed" || metric === "mx_mxlk_width") {
    const out = [];
    for (const s of base) for (const mxlkId of METAX_LINK_IDS) out.push({ ...s, mxlkId });
    return out;
  }
  const typed = {
    mx_mxlk_traffic_total_bytes: ["tx", "rx"],
    mx_mxlk_aer_count: ["ce", "ue"],
    mx_pcie_bw: ["rx", "tx"],
    mx_pci_event: ["aer_ce", "aer_ue"],
    mx_mxlk_bw: ["rx", "tx"],
  };
  if (typed[metric]) {
    const out = [];
    for (const s of base) for (const type of typed[metric]) out.push({ ...s, type });
    return out;
  }
  return base;
}

// ---- GPU catalog + matcher filtering ----------------------------------------
//
// The GPU dashboards filter devices by node and usage ("inference server" /
// "devEnvironment"). To make those filters actually narrow the charts, GPU
// queries are answered from a fixed catalog — one series per device on each
// node — instead of a random handful. Label matchers in the PromQL selector
// are parsed and applied against the catalog.

const GPU_CLUSTER = "perses-dev";
// node-a / node-b carry the inference services; dev-test-1 / dev-demo-1 are the
// Dev Environment pool's machines (the instance values the Dev Environment
// dashboard lists).
const GPU_NODES = ["node-a", "node-b", "dev-test-1", "dev-demo-1"];
const GPU_COUNT_PER_NODE = 4;
// Usage is a flat per-GPU label; each node's devices serve one workload kind.
const USAGE_OF_NODE = {
  "node-a": "inference server",
  "node-b": "inference server",
  "dev-test-1": "devEnvironment",
  "dev-demo-1": "devEnvironment",
};

function gpuDeviceSeries() {
  const series = [];
  for (const node of GPU_NODES) {
    for (let i = 0; i < GPU_COUNT_PER_NODE; i++) {
      series.push({
        cluster: GPU_CLUSTER,
        node,
        gpu: `gpu${i}`,
        usage: USAGE_OF_NODE[node],
        instance: node,
        job: "dcgm",
      });
    }
  }
  return series;
}

// Node host-resource usage (the GPU overview's CPU / memory / RDMA row and the
// Dev Environment dashboard's CPU / memory / network / storage row) is per
// node, not per device, so these families answer from a one-series-per-node
// catalog on the same nodes the DCGM devices live on. The generic node-metric
// path below would give these random per-family labels, so they must be
// intercepted before it.
const NODE_HOST_METRICS = new Set([
  "node_cpu_usage",
  "node_memory_usage",
  "node_network_usage",
  "node_storage_usage",
  "rdma_usage",
]);

function isNodeHostMetric(metric) {
  return NODE_HOST_METRICS.has(metric);
}

// Plausible % band per node host metric family (min, max, amplitude).
function nodeHostValueRange(metric) {
  const m = metric.toLowerCase();
  if (m.includes("memory")) return [45, 92, 5];
  if (m.includes("cpu")) return [20, 85, 7];
  if (m.includes("rdma")) return [5, 70, 10];
  if (m.includes("network")) return [10, 85, 12];
  if (m.includes("storage")) return [40, 95, 3];
  return [20, 90, 6];
}

function nodeHostSeries() {
  return GPU_NODES.map((node) => ({
    cluster: GPU_CLUSTER,
    node,
    instance: node,
    usage: USAGE_OF_NODE[node],
    job: "node-exporter",
  }));
}

// Detect an aggregation collapsed onto a label group ("avg by (node) ( ... )"
// / "avg by (instance) ( ... )") so the mock can return one series per group
// value instead of every device series. The GPU Usage rows (GPU Overview's
// avg by (node), Dev Environment's avg by (instance)) collapse the per-GPU
// DCGM devices up to one line per machine.
function parseGroupBy(expr) {
  const m = /(avg|sum)\s*by\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\)\s*\(/.exec(expr);
  if (!m) return null;
  return { op: m[1], labels: m[2].split(/\s*,\s*/).map((s) => s.trim()) };
}

// Parse the `{label=~"value",...}` selector out of a PromQL expression.
function parseMatchers(expr) {
  const open = expr.indexOf("{");
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < expr.length; i++) {
    if (expr[i] === "{") depth++;
    else if (expr[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];
  const matchers = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(!~|!=|=~|=)\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(expr.slice(open + 1, close)))) {
    matchers.push({ label: m[1], op: m[2], value: m[3] });
  }
  return matchers;
}

// Prometheus matcher semantics against a series' labels (missing label = "").
function matchersMatch(labels, matchers) {
  return matchers.every(({ label, op, value }) => {
    const actual = labels[label] ?? "";
    switch (op) {
      case "=":
        return actual === value;
      case "!=":
        return actual !== value;
      case "=~": {
        let re;
        try {
          re = new RegExp(value);
        } catch {
          return false;
        }
        return re.test(actual);
      }
      case "!~": {
        let re;
        try {
          re = new RegExp(value);
        } catch {
          return true;
        }
        return !re.test(actual);
      }
      default:
        return true;
    }
  });
}

// Build a plausible label set for a metric family.
function labelsFor(metric) {
  const labels = { instance: pick(LABEL_VALUES.instance), job: pick(LABEL_VALUES.job) };
  if (metric.startsWith("node_") || metric.includes("node_cpu") || metric.includes("node_memory") || metric.includes("node_network")) {
    labels.node = pick(LABEL_VALUES.node);
  }
  if (metric.startsWith("container_")) {
    labels.pod = pick(LABEL_VALUES.pod);
    labels.namespace = pick(LABEL_VALUES.namespace);
    labels.container = pick(LABEL_VALUES.container);
  }
  if (metric.startsWith("kube_") || metric.startsWith("namespace_")) {
    labels.namespace = pick(LABEL_VALUES.namespace);
    if (metric.includes("node")) labels.node = pick(LABEL_VALUES.node);
  }
  if (metric.includes("cpu")) labels.mode = pick(LABEL_VALUES.mode);
  if (metric.includes("_total") || metric.includes("_count") || metric.includes("_sum")) {
    // histogram/le handled below when present
  }
  if (isGpuMetric(metric)) {
    labels.node = pick(LABEL_VALUES.node);
    labels.gpu = pick(LABEL_VALUES.gpu);
  }
  return labels;
}

// One generated series over [start, end] at `step` seconds. `index` seeds the
// per-device GPU label so a `by (gpu)` panel separates into distinct series.
function makeSeries(metric, start, end, step, index = 0, device = null) {
  // `device` carries the full label set of one GPU in the cluster catalog (so
  // the node/usage filters stay effective); otherwise labels are generated per
  // metric family.
  const labels = device ?? labelsFor(metric);
  if (isGpuMetric(metric) && !device) {
    labels.gpu = `gpu${index}`;
  }
  const isCounter =
    /_total$|_count$|_sum$/.test(metric) ||
    metric.startsWith("rest_client_requests") ||
    (isMetaxMetric(metric) && /_total_bytes$/.test(metric));
  // GPU metrics get a lively per-family band (see gpuValueRange), sglang metrics
  // theirs (see sglangValueRange), and MetaX metrics theirs (metaxValueRange);
  // everything else stays a small 0..1 wave.
  const valueRange = isSglangMetric(metric)
    ? sglangValueRange(metric)
    : isGpuMetric(metric)
      ? gpuValueRange(metric)
      : isMetaxMetric(metric)
        ? metaxValueRange(metric)
        : isNodeHostMetric(metric)
          ? nodeHostValueRange(metric)
          : null;
  const base = isCounter ? rand(0, 10) : valueRange ? rand(valueRange[0], valueRange[1]) : rand(0.1, 0.9);
  const amp = valueRange ? valueRange[2] : rand(0.05, 0.4);
  const phase = rand(0, Math.PI * 2);
  const values = [];
  let counter = base;
  for (let t = start; t <= end; t += step) {
    if (isCounter) {
      counter += rand(0, 1);
      values.push([t, counter.toFixed(3)]);
    } else {
      const wave = Math.sin(t / 60 + phase) * amp;
      values.push([t, (base + wave + rand(-0.02, 0.02)).toFixed(3)]);
    }
  }
  return { metric: labels, values };
}

function seriesCountFor(metric) {
  // Give the "by (instance)" / "by (gpu)" panels a few lines so the charts look populated.
  if (isGpuMetric(metric) || metric.includes("node") || metric.includes("pod") || metric.includes("namespace")) return 4;
  return 2;
}

// ---- request handling -------------------------------------------------------

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  // Prometheus clients (and the Perses datasource proxy) send POST bodies with
  // the query form-encoded (`query=...&start=...`) or as JSON. Read the body so
  // `params` below resolves `query`/`match[]` no matter how it was submitted.
  let params = url.searchParams;
  if (req.method === "POST") {
    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });
    if (body) {
      try {
        if (req.headers["content-type"]?.includes("json")) {
          const json = JSON.parse(body);
          params = new URLSearchParams();
          for (const [k, v] of Object.entries(json)) {
            if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
            else params.append(k, String(v));
          }
        } else {
          params = new URLSearchParams(body);
        }
      } catch {
        params = new URLSearchParams(body);
      }
    }
  }

  if (pathname === "/-/healthy") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Prometheus Server is Healthy.\n");
    return;
  }

  if (pathname === "/api/v1/status/buildinfo") {
    send(res, 200, { status: "success", data: { version: "2.40.0-mock", versionShort: "2.40.0-mock" } });
    return;
  }

  // Labels metadata, used by the variable plugin.
  if (pathname === "/api/v1/labels") {
    send(res, 200, { status: "success", data: ALL_LABELS });
    return;
  }

  const labelValues = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(pathname);
  if (labelValues) {
    const name = labelValues[1];
    // The variable plugin sends the variable's matchers as match[], so a label
    // can resolve per metric family (MetaX `instance` = its servers, DCGM
    // `node` = its nodes, sglang `instance` = its endpoints).
    const match = params.getAll("match[]").join(" ");
    const metric = match ? metricNameOf(match) : null;
    let catalog = null;
    if (metric && isMetaxMetric(metric)) catalog = metaxSeriesFor(metric);
    else if (metric && isSglangMetric(metric)) catalog = sglangSeries();
    else if (metric && isGpuMetric(metric)) catalog = gpuDeviceSeries();
    else if (metric && isNodeHostMetric(metric)) catalog = nodeHostSeries();
    if (catalog) {
      // A dependent variable scopes its label lookup to the parent's selection
      // via matchers (e.g. model_name for a chosen inference service), so apply
      // them against the catalog before collecting distinct values.
      const matchers = parseMatchers(match);
      const values = [
        ...new Set(
          catalog
            .filter((l) => matchersMatch(l, matchers))
            .map((l) => l[name])
            .filter((v) => v !== undefined && v !== ""),
        ),
      ];
      send(res, 200, { status: "success", data: values });
      return;
    }
    if (name === "instance") {
      // Only the SGLang dashboard queries an `instance` label (server endpoints);
      // the mixin/DCGM dashboards filter on cluster/node/usage/gpu instead.
      send(res, 200, { status: "success", data: SGLANG_INSTANCES });
      return;
    }
    send(res, 200, { status: "success", data: LABEL_VALUES[name] ?? ["unknown"] });
    return;
  }

  // Series discovery for the variable queries (match[] carries a selector).
  if (pathname === "/api/v1/series") {
    const match = params.getAll("match[]").join(" ");
    const metric = metricNameOf(match || "up");
    const result = [];
    if (isGpuMetric(metric)) {
      // Variable lookups resolve against the device catalog so distinct node /
      // usage / gpu values match what the charts will actually return.
      const matchers = parseMatchers(match);
      for (const labels of gpuDeviceSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push({ ...labels, __name__: metric });
      }
    } else if (isSglangMetric(metric)) {
      const matchers = parseMatchers(match);
      for (const labels of sglangSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push({ ...labels, __name__: metric });
      }
    } else if (isMetaxMetric(metric)) {
      const matchers = parseMatchers(match);
      for (const labels of metaxSeriesFor(metric).filter((l) => matchersMatch(l, matchers))) {
        result.push({ ...labels, __name__: metric });
      }
    } else if (isNodeHostMetric(metric)) {
      const matchers = parseMatchers(match);
      for (const labels of nodeHostSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push({ ...labels, __name__: metric });
      }
    } else {
      for (let i = 0; i < seriesCountFor(metric); i++) {
        result.push({ ...labelsFor(metric), __name__: metric });
      }
    }
    send(res, 200, { status: "success", data: result });
    return;
  }

  if (pathname === "/api/v1/query_range") {
    const query = params.get("query") ?? "";
    const start = Number(params.get("start") ?? Math.floor(Date.now() / 1000) - 3600);
    const end = Number(params.get("end") ?? Math.floor(Date.now() / 1000));
    const step = Math.max(Number(params.get("step") ?? 60), 1);
    const metric = metricNameOf(query);
    const result = [];
    if (isSglangMetric(metric)) {
      const matchers = parseMatchers(query);
      // histogram_quantile(q, ...) -> one latency line scaled by q (P99 > P90 > P50).
      const hq = /histogram_quantile\(\s*([\d.]+)/.exec(query);
      if (hq) {
        const q = parseFloat(hq[1]);
        const [gMin, gMax, gAmp] = sglangValueRange(metric);
        const base = gMin + (gMax - gMin) * (0.3 + 0.7 * q);
        const values = [];
        for (let t = start; t <= end; t += step) {
          values.push([t, (base + Math.sin(t / 90 + q * 3) * gAmp * 0.35 + rand(-0.02, 0.02)).toFixed(3)]);
        }
        result.push({ metric: { instance: SGLANG_INSTANCES[0], model_name: SGLANG_MODELS[0], job: "sglang" }, values });
      } else if (isSglangHistogramName(metric)) {
        // Native histogram for the heatmap panels — the chart wants exactly one series.
        const device = sglangSeries().find((s) => matchersMatch(s, matchers)) ?? sglangSeries()[0];
        const histograms = [];
        const values = [];
        for (let t = start; t <= end; t += step) {
          const h = sglangNativeHistogram(t, metric);
          histograms.push(h);
          values.push([t, h[1].sum]);
        }
        result.push({ metric: device, values, histograms });
      } else if (query.includes("_sum") && query.includes("_count")) {
        // avg(rate(sum)/rate(count)) -> the average latency, a single series.
        const [gMin, gMax, gAmp] = sglangValueRange(metric);
        const base = rand(gMin, gMax);
        const values = [];
        for (let t = start; t <= end; t += step) {
          values.push([t, (base + Math.sin(t / 90) * gAmp * 0.3 + rand(-0.02, 0.02)).toFixed(3)]);
        }
        result.push({ metric: { instance: SGLANG_INSTANCES[0], model_name: SGLANG_MODELS[0], job: "sglang" }, values });
      } else {
        for (const device of sglangInstanceSeries().filter((l) => matchersMatch(l, matchers))) {
          result.push(makeSeries(metric, start, end, step, 0, device));
        }
      }
    } else if (isGpuMetric(metric)) {
      // Answer GPU queries from the fixed device catalog so the node / usage
      // matchers actually narrow the returned series.
      const matchers = parseMatchers(query);
      const devices = gpuDeviceSeries().filter((l) => matchersMatch(l, matchers));
      const group = parseGroupBy(query);
      if (group) {
        // avg/sum by (label): collapse the matching per-device series into one
        // series per group value (computed here, since the mock cannot run the
        // real PromQL aggregation). Keeps the GPU Usage row to one line/node.
        const grouped = new Map();
        for (const device of devices) {
          const series = makeSeries(metric, start, end, step, 0, device);
          const key = JSON.stringify(group.labels.map((l) => device[l] ?? ""));
          let members = grouped.get(key);
          if (members === undefined) {
            members = [];
            grouped.set(key, members);
          }
          members.push(series);
        }
        for (const [key, members] of grouped) {
          const count = members[0].values.length;
          const values = [];
          for (let i = 0; i < count; i++) {
            const time = members[0].values[i][0];
            let acc = 0;
            for (const member of members) acc += Number(member.values[i][1]);
            const value = group.op === "sum" ? acc : acc / members.length;
            values.push([time, value.toFixed(3)]);
          }
          const labels = { cluster: GPU_CLUSTER };
          group.labels.forEach((label, i) => {
            labels[label] = JSON.parse(key)[i];
          });
          result.push({ metric: labels, values });
        }
      } else {
        for (const device of devices) result.push(makeSeries(metric, start, end, step, 0, device));
      }
    } else if (isMetaxMetric(metric)) {
      // Answer MetaX queries from the server x device catalog so the Hostname /
      // deviceId matchers actually narrow the returned series.
      const matchers = parseMatchers(query);
      for (const device of metaxSeriesFor(metric).filter((l) => matchersMatch(l, matchers))) {
        result.push(makeSeries(metric, start, end, step, 0, device));
      }
    } else if (isNodeHostMetric(metric)) {
      // Node host usage is one series per node (see nodeHostSeries), so the
      // node matcher narrows the row to the selected node.
      const matchers = parseMatchers(query);
      for (const device of nodeHostSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push(makeSeries(metric, start, end, step, 0, device));
      }
    } else {
      for (let i = 0; i < seriesCountFor(metric); i++) {
        result.push(makeSeries(metric, start, end, step, i));
      }
    }
    send(res, 200, { status: "success", data: { resultType: "matrix", result } });
    return;
  }

  if (pathname === "/api/v1/query") {
    const query = params.get("query") ?? "";
    const time = Number(params.get("time") ?? Math.floor(Date.now() / 1000));
    const metric = metricNameOf(query);
    const result = [];
    if (isSglangMetric(metric)) {
      const matchers = parseMatchers(query);
      const hq = /histogram_quantile\(\s*([\d.]+)/.exec(query);
      if (hq) {
        const q = parseFloat(hq[1]);
        const [gMin, gMax] = sglangValueRange(metric);
        result.push({ metric: { instance: SGLANG_INSTANCES[0], model_name: SGLANG_MODELS[0], job: "sglang" }, value: [time, (gMin + (gMax - gMin) * (0.3 + 0.7 * q)).toFixed(3)] });
      } else if (isSglangHistogramName(metric)) {
        const device = sglangSeries().find((l) => matchersMatch(l, matchers)) ?? sglangSeries()[0];
        result.push({ metric: device, histogram: sglangNativeHistogram(time, metric) });
      } else {
        const [gMin, gMax] = sglangValueRange(metric);
        for (const device of sglangInstanceSeries().filter((l) => matchersMatch(l, matchers))) {
          result.push({ metric: device, value: [time, rand(gMin, gMax).toFixed(3)] });
        }
      }
    } else if (isGpuMetric(metric)) {
      const matchers = parseMatchers(query);
      const [gMin, gMax] = gpuValueRange(metric);
      for (const device of gpuDeviceSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push({ metric: device, value: [time, rand(gMin, gMax).toFixed(3)] });
      }
    } else if (isMetaxMetric(metric)) {
      const matchers = parseMatchers(query);
      const [gMin, gMax] = metaxValueRange(metric);
      for (const device of metaxSeriesFor(metric).filter((l) => matchersMatch(l, matchers))) {
        result.push({ metric: device, value: [time, rand(gMin, gMax).toFixed(3)] });
      }
    } else if (isNodeHostMetric(metric)) {
      const matchers = parseMatchers(query);
      const [gMin, gMax] = nodeHostValueRange(metric);
      for (const device of nodeHostSeries().filter((l) => matchersMatch(l, matchers))) {
        result.push({ metric: device, value: [time, rand(gMin, gMax).toFixed(3)] });
      }
    } else {
      for (let i = 0; i < seriesCountFor(metric); i++) {
        result.push({
          metric: labelsFor(metric),
          value: [time, rand(0, 2).toFixed(3)],
        });
      }
    }
    send(res, 200, { status: "success", data: { resultType: "vector", result } });
    return;
  }

  send(res, 404, { status: "error", errorType: "bad_data", error: `no handler for ${pathname}` });
});

server.listen(PORT, () => {
  console.log(`[mock-prometheus] listening on http://localhost:${PORT}`);
});
