# CubeStack Observability — 外部依赖与接口要求

本文档列出 observability 组件对其他组件的依赖要求。各组件开发人员需按此规范实现，否则 Recording Rule 和 Dashboard 无法正常聚合指标。

---

## 1. InferenceService Controller

**组件路径：** `operator/`  
**负责人：** InferenceService 开发团队

### 1.1 必须暴露的 Prometheus 指标

Controller 需通过 `/metrics` 端点暴露以下指标，并配置对应 ServiceMonitor。

| 指标名 | 类型 | Labels | 说明 |
|---|---|---|---|
| `cubestack_inference_service_info` | Gauge (always 1) | `namespace`, `name`, `model`, `mode` | 每个 InferenceService CR 一条，用于计数和关联模型信息 |
| `cubestack_inference_service_ready` | Gauge (0\|1) | `namespace`, `name` | 1 = 服务整体可服务；0 = 不可服务（Starting 不算异常，不应置 0） |

`mode` 取值：`standard` | `disaggregated`

### 1.2 必须在所有 Pod Template 上打的 Labels

Controller 创建 LWS / Deployment 等 workload 时，**pod template** 的 labels 必须包含：

```yaml
labels:
  app.kubernetes.io/part-of: cubestack-inference   # 固定值
  cubestack.io/inference-service: <CR name>         # InferenceService CR 的 .metadata.name
  cubestack.io/role: prefill | decode | router       # 对应 workload 的角色
```

**为什么需要这些 label：**
- `app.kubernetes.io/part-of`：Recording Rule 用此过滤，避免误计算其他 pod 的 GPU 请求
- `cubestack.io/inference-service`：KSM 通过 `kube_pod_labels` 透传此 label，Recording Rule 用 `* on(namespace,pod) group_left(label_cubestack_io_inference_service)` 将 SGLang/GPU pod 指标关联回 InferenceService
- `cubestack.io/role`：PD 分离面板按 role 拆分 prefill/decode 指标

### 1.3 对 Envoy AI Gateway 的要求（待确认）

当前 Envoy AI Gateway 的 `gen_ai_*` 指标**不携带** namespace/pod/InferenceService 级别的 label，仅有 `gen_ai_request_model`。

目前 Recording Rule 以 `gen_ai_request_model` 作为 per-InferenceService 流量指标的近似。若一个集群中存在两个 InferenceService 服务同一模型，则流量无法区分。

**建议**：Gateway 在 metrics 中增加以下任一 label：
- `cubestack_inference_service`（推荐）：直接标注来自哪个 InferenceService
- 或通过 ServiceMonitor relabeling 从 pod label 注入

---

## 2. DevEnvironment Controller

**组件路径：** `operator/`  
**负责人：** DevEnvironment 开发团队

### 2.1 不需要暴露 Prometheus 指标

DevEnvironment 的所有可观测性指标均从 KSM / cAdvisor 取得，Controller **不需要**暴露 `/metrics` 端点。

| 指标语义 | 来源 | expr |
|---|---|---|
| Total | KSM StatefulSet | `count(kube_statefulset_replicas{label_app_kubernetes_io_part_of="cubestack-devenv"})` |
| Running | KSM StatefulSet | `count(kube_statefulset_status_replicas_ready{label_app_kubernetes_io_part_of="cubestack-devenv"} > 0)` |
| Stopped | KSM StatefulSet | `kube_statefulset_spec_replicas{...} == 0` |
| Running Time | KSM Pod | `time() - min by(namespace,devenv)(kube_pod_start_time join kube_pod_labels)` |

### 2.2 必须在 StatefulSet 和 Pod Template 上打的 Labels

DevEnvironment 创建 StatefulSet 时，**StatefulSet `.metadata.labels`** 和 **pod template labels** 都必须包含：

```yaml
labels:
  app.kubernetes.io/part-of: cubestack-devenv       # 固定值，StatefulSet 和 pod 都需要
  cubestack.io/devenv: <CR name>                     # DevEnvironment CR 的 .metadata.name，pod 必须有
```

**为什么 StatefulSet 本身也需要 `app.kubernetes.io/part-of`：**  
KSM 的 `kube_statefulset_replicas` 通过 StatefulSet `.metadata.labels` 透传 label，用于 Overview 页面的 Total/Running 计数（见 3.1）。Pod template 上的 label 仅透传到 `kube_pod_labels`，不会出现在 `kube_statefulset_*` 指标上。

---

## 3. Installer / Cluster 配置

**负责人：** Installer / Platform 团队

### 3.1 kube-state-metrics 配置

KSM 默认**不透传**自定义 pod/statefulset labels。必须通过以下配置开启：

```yaml
# kube-state-metrics values（Helm）
extraArgs:
  - --metric-labels-allowlist=pods=[app.kubernetes.io/part-of,cubestack.io/inference-service,cubestack.io/role,cubestack.io/devenv],statefulsets=[app.kubernetes.io/part-of]
```

- `pods=[...]`：使 `kube_pod_labels` 透传 pod label，供 Recording Rule join
- `statefulsets=[app.kubernetes.io/part-of]`：使 `kube_statefulset_replicas` 等指标透传 StatefulSet label，供 Overview 页面统计 DevEnvironment Total/Running

不开启此配置，Recording Rule 中所有 `kube_pod_labels` join 均无法工作，Overview DevEnvironment 计数也无法正确过滤。

### 3.2 Prometheus Operator 配置

需要在 Prometheus CR 或 `additionalScrapeConfigs` 中配置，使其能发现 `monitoring` namespace 下的 ServiceMonitor：

```yaml
serviceMonitorNamespaceSelector: {}   # 或指定 namespace
serviceMonitorSelector:
  matchLabels:
    app.kubernetes.io/part-of: cubestack-observability
```

### 3.3 PrometheusRule 部署 namespace

CubeStack Recording Rules 部署在 `monitoring` namespace，PrometheusRule CR 带有：

```yaml
labels:
  app.kubernetes.io/part-of: cubestack-observability
```

Prometheus CR 需配置 `ruleNamespaceSelector` 和 `ruleSelector` 能选中此 label。
