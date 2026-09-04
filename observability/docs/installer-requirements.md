# CubeStack Observability — Installer 部署需求

本文档给 cubestack-installer 开发者，说明部署 Prometheus Stack 的配置要求，以及如何把 CubeStack recording rules 和 Grafana dashboard 部署到安装环境。

对应 installer 文件：`deployments/scripts/modules/03_addon/08_prometheus.sh`（当前为伪代码占位）。

---

## 1. kube-prometheus-stack Helm values 配置要求

安装 `kube-prometheus-stack` 时必须通过 values 传入以下配置，否则 CubeStack recording rules 无法工作。

### 1.1 KSM label allowlist（必须，缺了所有 recording rule join 都失效）

```yaml
kube-state-metrics:
  extraArgs:
    - --metric-labels-allowlist=pods=[app.kubernetes.io/part-of,cubestack.io/inference-service,cubestack.io/role,cubestack.io/devenv],statefulsets=[app.kubernetes.io/part-of]
```

**为什么需要：**
- `pods=[...]`：使 `kube_pod_labels` 透传 pod 自定义 label，recording rule 用 `* on(namespace,pod) group_left(...)` 将 SGLang/GPU/cAdvisor 指标关联回 InferenceService 和 DevEnvironment
- `statefulsets=[app.kubernetes.io/part-of]`：使 `kube_statefulset_replicas` 透传 StatefulSet label，Overview 页面用于统计 DevEnvironment Total/Running 数量

### 1.2 Prometheus 能发现 CubeStack 的 ServiceMonitor 和 PrometheusRule

```yaml
prometheus:
  prometheusSpec:
    serviceMonitorNamespaceSelector: {}   # 监听所有 namespace 的 ServiceMonitor
    serviceMonitorSelector: {}            # 不过滤，接受所有 ServiceMonitor
    ruleNamespaceSelector: {}            # 监听所有 namespace 的 PrometheusRule
    ruleSelector:
      matchLabels:
        app.kubernetes.io/part-of: cubestack-observability
```

CubeStack PrometheusRule 带有 label `app.kubernetes.io/part-of: cubestack-observability`，Prometheus 必须配置 `ruleSelector` 能选中此 label。

### 1.3 抓取和评估间隔（建议）

```yaml
prometheus:
  prometheusSpec:
    scrapeInterval: "30s"
    evaluationInterval: "60s"
```

---

## 2. 部署 CubeStack Recording Rules

Recording rules 位于 `observability/recording-rules/`，共 6 个文件：

```
gpu.yaml            # MetaX GPU node/per-card/workload 指标
gpu-nvidia.yaml     # NVIDIA DCGM per-card/workload 指标
infra.yaml          # Node CPU/Memory/Network/RDMA 指标
inference.yaml      # InferenceService 推理业务指标
inference-vllm.yaml # vLLM 补丁规则
devenv.yaml         # DevEnvironment 资源指标
```

每个文件是一个 `PrometheusRule` CR，已包含所需 label：

```yaml
metadata:
  namespace: monitoring
  labels:
    app.kubernetes.io/part-of: cubestack-observability
    release: kube-prometheus-stack
```

**部署步骤：** 在 kube-prometheus-stack 安装完成并就绪后，apply 到 `monitoring` namespace：

```bash
kubectl apply -n monitoring -f /opt/cubestack/observability/recording-rules/
```

**验证：**

```bash
# 确认 PrometheusRule 对象已创建
kubectl get prometheusrule -n monitoring | grep cubestack

# 确认 Prometheus 已加载规则（等待约 30-60s）
curl -s http://localhost:9090/api/v1/rules | python3 -c "
import json,sys
d=json.load(sys.stdin)
for g in d['data']['groups']:
    if 'cubestack' in g['name']:
        print(g['name'], '-', len(g['rules']), 'rules')
"
```

---

## 3. 部署 Grafana Dashboard

Grafana dashboard JSON 位于 `observability/dashboards/grafana/`，共 11 个运维 dashboard：

```
1860_rev45.json                              # Node Exporter Full
23823_rev1.json                              # InfiniBand / RDMA
24459_rev3.json                              # Envoy Proxy Overview
25091_Kube-State-Metrics_Overview_...json   # KSM Overview
2842_rev18.json                              # Ceph Cluster
Envoy_AI_Gateway_DCE5_CubeStack.json       # Envoy AI Gateway
Kubernetes_Workload_Troubleshooting_...json # Workload 排障
MetaX-GPU-C500_DCE5_CubeStack.json         # MetaX GPU C500
MetaX-GPU-C500.json                         # MetaX GPU（原版）
SGLang_Dashboard_DCE5_CubeStack_PD_v3.json # SGLang PD 推理
vllm-performance-statistics.json           # vLLM 性能
```

### 方式 A：Grafana API 导入（推荐）

在 kube-prometheus-stack 就绪后，通过 port-forward + API 导入：

```bash
# port-forward Grafana（在目标节点执行）
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80 &
sleep 3

# 导入所有 dashboard
for f in /opt/cubestack/observability/dashboards/grafana/*.json; do
  PAYLOAD=$(python3 -c "
import json
d = json.load(open('${f}'))
d['id'] = None
print(json.dumps({'dashboard': d, 'overwrite': True, 'folderId': 0}))
")
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -u "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
    -d "${PAYLOAD}" \
    http://localhost:3000/api/dashboards/db
done
```

### 方式 B：ConfigMap sidecar（自动导入）

在 kube-prometheus-stack values 里启用 sidecar：

```yaml
grafana:
  sidecar:
    dashboards:
      enabled: true
      label: grafana_dashboard
      labelValue: "1"
      searchNamespace: monitoring
```

然后把每个 dashboard JSON 创建为带 label 的 ConfigMap：

```bash
for f in /opt/cubestack/observability/dashboards/grafana/*.json; do
  name="cubestack-dashboard-$(basename "${f}" .json | tr '[:upper:]' '[:lower:]' | tr '_.' '-' | cut -c1-50)"
  kubectl create configmap "${name}" \
    -n monitoring \
    --from-file="$(basename ${f})=${f}" \
    --dry-run=client -o yaml \
  | kubectl annotate --local -f - \
      "meta.helm.sh/release-name=kube-prometheus-stack" \
      --overwrite -o yaml \
  | kubectl label --local -f - grafana_dashboard=1 -o yaml \
  | kubectl apply -f -
done
```

---

## 4. cluster.conf.example 新增配置项

在 `PROMETHEUS_ENABLED` 附近补充：

```bash
# ---- Prometheus / Observability 配置（PROMETHEUS_ENABLED=true 时生效）----
PROMETHEUS_NAMESPACE="${PROMETHEUS_NAMESPACE:-monitoring}"
PROMETHEUS_RELEASE_NAME="${PROMETHEUS_RELEASE_NAME:-kube-prometheus-stack}"
PROMETHEUS_CHART_DIR="${PROMETHEUS_CHART_DIR:-${REPO_ROOT}/deployments/offline-files/kube-prometheus-stack}"
GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-CHANGE_ME}"
# CubeStack observability 目录（recording rules + dashboards）
# 默认从 cubestack 仓库同级目录读取；离线环境打包后放 /opt/cubestack/observability
CUBESTACK_OBSERVABILITY_DIR="${CUBESTACK_OBSERVABILITY_DIR:-/opt/cubestack/observability}"
```

---

## 5. 离线打包清单

需要把以下目录打进离线安装包，部署到节点 `/opt/cubestack/observability/`：

| 源路径（cubestack 仓库） | 目标（节点） |
|---|---|
| `observability/recording-rules/` | `/opt/cubestack/observability/recording-rules/` |
| `observability/dashboards/grafana/` | `/opt/cubestack/observability/dashboards/grafana/` |

---

## 6. 08_prometheus.sh 执行步骤顺序

```
1. 创建 monitoring namespace
2. helm install kube-prometheus-stack（含 1.1~1.3 的 values）
3. 等待 Prometheus / Grafana Pod 就绪
4. kubectl apply recording rules（observability/recording-rules/*.yaml）
5. 导入 Grafana dashboard（observability/dashboards/grafana/*.json）
6. 验证：kubectl get prometheusrule -n monitoring | grep cubestack
```
