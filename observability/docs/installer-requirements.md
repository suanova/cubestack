# CubeStack Observability — Installer 部署需求

本文档给 cubestack-installer 开发者，说明部署 Prometheus Stack 的配置要求，以及如何把 CubeStack recording rules、Grafana dashboard 和各类 exporter 部署到安装环境。

对应 installer 文件：`deployments/scripts/modules/03_addon/08_prometheus.sh`。

---

## 1. kube-prometheus-stack Helm values 配置要求

安装 `kube-prometheus-stack` 时必须通过 values 传入以下配置，否则 CubeStack recording rules 无法工作。

### 1.1 KSM label allowlist（必须，缺了所有 recording rule join 都失效）

```yaml
kube-state-metrics:
  extraArgs:
    - --metric-labels-allowlist=pods=[app.kubernetes.io/part-of,ai.cubestack.io/inference-service,ai.cubestack.io/role,ai.cubestack.io/dev-environment],statefulsets=[ai.cubestack.io/dev-environment]
```

**为什么需要：**
- `pods=[...]`：使 `kube_pod_labels` 透传 pod 自定义 label，recording rule 用 `* on(namespace,pod) group_left(...)` 将 SGLang/GPU/cAdvisor 指标关联回 InferenceService 和 DevEnvironment
- `statefulsets=[ai.cubestack.io/dev-environment]`：使 `kube_statefulset_replicas` 透传 StatefulSet label，Overview 页面用于统计 DevEnvironment Total/Running 数量

### 1.2 Prometheus 能发现 CubeStack 的 ServiceMonitor / PrometheusRule / ScrapeConfig

```yaml
prometheus:
  prometheusSpec:
    serviceMonitorNamespaceSelector: {}   # 监听所有 namespace 的 ServiceMonitor
    serviceMonitorSelector: {}            # 不过滤，接受所有 ServiceMonitor
    ruleNamespaceSelector: {}            # 监听所有 namespace 的 PrometheusRule
    ruleSelector:
      matchLabels:
        app.kubernetes.io/part-of: cubestack-observability
    scrapeConfigNamespaceSelector: {}    # 监听所有 namespace 的 ScrapeConfig
    scrapeConfigSelector:
      matchLabels:
        app.kubernetes.io/part-of: cubestack-observability
```

CubeStack PrometheusRule / ScrapeConfig 均带 label `app.kubernetes.io/part-of: cubestack-observability`，
Prometheus CR 的选择器**必须按此 label 匹配**。

### 1.3 node-exporter：infiniband 采集 + `node` label（RDMA/按节点分组规则依赖）

```yaml
prometheus-node-exporter:
  extraArgs:
    - --collector.infiniband     # C500 有真实 IB 硬件(mlx5)，默认不采集
  prometheus:
    monitor:
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node        # recording rule 的 min by (node) 依赖
```

**为什么需要：**
- `--collector.infiniband`：默认 collector 不含 IB；不开则 `node_infiniband_*` 指标全部缺失，
  RDMA dashboard 无数据；
- `node` label relabeling：node-exporter 的 ServiceMonitor 默认不打 `node` label（instance 是
  节点 IP，不是节点名），而 `cluster_node:cubestack_network_rdma_port_up:min` 等规则按 `node`
  分组 —— 缺 label 时规则输出无节点维度的序列。

### 1.4 抓取和评估间隔（建议）

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
```

> ⚠ **label 必须与 Prometheus CR 的 `ruleSelector` 匹配，否则规则静默失效**——CR 创建成功但
> Prometheus 不加载。kube-prometheus-stack 默认 selector 是 helm release 名
> （`ruleSelectorNilUsesHelmValues`），与仓库文件的 `part-of` label 不匹配。两种做法二选一：
> - 按 §1.2 把 `ruleSelector` 配成匹配 `part-of` label —— 仓库文件原样 apply 即可；
> - 不改 §1.2，apply 时给 CR 额外打 `release: ${PROMETHEUS_RELEASE_NAME}` label（测试环境
>   实测采用此方式：6 个规则 CR 均带 `release: kube-prometheus`，9 组 59 条规则全部加载）。
> 部署后必须用 `/api/v1/rules` 验证 cubestack 分组实际加载，不能只看 CR 创建成功。

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
bmc-hardware.json                       # BMC Hardware（H3C BMC 带外监控）
ceph-2842.json                          # Ceph Cluster
envoy-ai-gateway.json                   # Envoy AI Gateway
envoy-proxy-overview-24459.json         # Envoy Proxy Overview
metax-gpu-c500.json                     # MetaX GPU C500
node-exporter-1860.json                 # Node Exporter Full
nvidia-dcgm.json                        # NVIDIA GPU (DCGM)
rdma-infiniband-23823.json              # InfiniBand / RDMA
sglang-pd.json                          # SGLang PD 推理
vllm.json                               # vLLM 性能
workload-troubleshooting.json           # Kubernetes Workload 排障
```

### 方式：ConfigMap sidecar 自动导入

kube-prometheus-stack 的 grafana sidecar 默认已启用（label `grafana_dashboard`、value `1`、
NAMESPACE=ALL），只需创建带 label 的 ConfigMap（一个 dashboard 一个 CM，文件名即 key）：

```bash
for f in /opt/cubestack/observability/dashboards/grafana/*.json; do
  name="cubestack-$(basename "${f}" .json)"
  kubectl create configmap "${name}" \
    -n monitoring \
    --from-file="${f}" \
    --dry-run=client -o yaml \
  | kubectl apply -f -
  kubectl label configmap "${name}" -n monitoring grafana_dashboard=1 --overwrite
done
```

**语义说明（installer 开发者须知）：**

- **持久性**：dashboard 源头是 etcd 中的 ConfigMap，Grafana 每次启动时 sidecar 自动重新导入，
  因此 Prometheus/Grafana 重启、Pod 重建、helm upgrade 都不会丢 dashboard（与 Grafana DB
  是否挂 PVC 无关）。测试环境实测：整个监控栈重装（helm release 改名、Grafana 无 PVC）
  后 sidecar dashboard 依然存在。**不要**用 Grafana API 手动导入——API 导入只写 Grafana DB，
  默认 kube-prometheus-stack 不挂 PVC，Pod 重建即丢失。
- **修改必须走 ConfigMap**：sidecar 导入的是 provisioned dashboard，Grafana UI 上的任何修改
  会在下次同步时被 ConfigMap 版本覆盖。改 dashboard = 改仓库 JSON → 更新 ConfigMap。
- 所有 dashboard 默认落在 General 文件夹（sidecar `foldersFromFilesStructure: false` 默认）。
- sidecar 的 reload 凭据取自 Grafana admin secret，adminPassword 自定义后无需额外配置。

---

## 4. cluster.conf.example 新增配置项

在 `PROMETHEUS_ENABLED` 附近补充：

```bash
# ---- Prometheus / Observability 配置（PROMETHEUS_ENABLED=true 时生效）----
PROMETHEUS_NAMESPACE="${PROMETHEUS_NAMESPACE:-monitoring}"
PROMETHEUS_RELEASE_NAME="${PROMETHEUS_RELEASE_NAME:-kube-prometheus}"
PROMETHEUS_CHART_DIR="${PROMETHEUS_CHART_DIR:-${REPO_ROOT}/deployments/offline-files/kube-prometheus-stack}"
GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-CHANGE_ME}"   # 必须传入 helm values grafana.adminPassword; 部署前校验见下方 ⚠
# CubeStack observability 目录（recording rules + dashboards）
# 默认从 cubestack 仓库同级目录读取；离线环境打包后放 /opt/cubestack/observability
CUBESTACK_OBSERVABILITY_DIR="${CUBESTACK_OBSERVABILITY_DIR:-/opt/cubestack/observability}"
```

> ⚠ `GRAFANA_ADMIN_PASSWORD` 必须落地到 helm values（`grafana.adminPassword`）。
> **helm 安装前必须硬失败校验**：变量未设置、为空、或仍等于 `CHANGE_ME` 占位符时立即报错退出，
> 禁止用已知默认口令部署 Grafana（与 BMC exporter 的凭据校验同理）。不设置时 helm 会生成
> 随机密码存 secret，用户无法预知（实测环境因此需要手工重置），也不是可接受的行为。

---

## 5. 离线打包清单

需要把以下目录打进离线安装包，部署到节点 `/opt/cubestack/observability/`：

| 源路径（cubestack 仓库） | 目标（节点） |
|---|---|
| `observability/recording-rules/` | `/opt/cubestack/observability/recording-rules/` |
| `observability/dashboards/grafana/` | `/opt/cubestack/observability/dashboards/grafana/` |
| `observability/helm/cubestack-bmc-exporter-chart/` | `/opt/cubestack/observability/helm/cubestack-bmc-exporter-chart/`（BMC exporter，见 §7） |

---

## 6. 08_prometheus.sh 执行步骤顺序

```
1. 创建 monitoring namespace
2. helm install kube-prometheus-stack（含 1.1~1.4 的 values）
3. 等待 Prometheus / Grafana Pod 就绪
4. kubectl apply recording rules（observability/recording-rules/*.yaml）
5. 导入 Grafana dashboard（observability/dashboards/grafana/*.json，ConfigMap sidecar）
6. 验证：kubectl get prometheusrule -n monitoring | grep cubestack
   + GET /api/search 确认 dashboard 已导入
```

---

## 7. 集群 GPU / BMC 硬件指标 exporter 部署需求

### 7.1 MetaX GPU 指标（mx-exporter）—— GPU dashboard 数据源

MetaX Operator 的 `dataExporter` 组件默认**不部署**（ClusterOperator CR `spec.dataExporter.deploy: false`），
需要 installer 启用：

```bash
kubectl -n metax-operator patch clusteroperator cluster-operator --type=merge \
  -p '{"spec":{"dataExporter":{"deploy":true}}}'
```

启用后 operator 在 GPU 节点起 `metax-data-exporter` DaemonSet + Service（端口名 `metrics`）。
再创建 ServiceMonitor 让 Prometheus 抓取（Service 的 **metadata label** 必须是
`app: metax-data-exporter`，SD 的 keep 过滤依赖它）：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cubestack-mx-exporter
  namespace: metax-operator
  labels:
    app.kubernetes.io/part-of: cubestack-observability
spec:
  selector:
    matchLabels:
      app: metax-data-exporter
  endpoints:
    - port: metrics
      interval: 30s
```

验证：Prometheus targets 中 job=`metax-data-exporter`（relabel 会把 job 重写为 Service 名，
**不是** ServiceMonitor 名）2 个 target up（每 GPU 节点 1 个）。

### 7.2 BMC 带外监控（bmc-oem-exporter + idrac-exporter）

**交付形态**：Helm chart `cubestack-bmc-exporter-chart`（Deployment×2 + Service×2 + ScrapeConfig×2，
BMC 凭据经 values 传入）。chart（OCI: `harbor.isuanova.com/suanova/cubestack-bmc-exporter-chart`）
与两个 exporter 镜像（`harbor.isuanova.com/suanova/bmc-oem-exporter`、
`harbor.isuanova.com/suanova/idrac-exporter`）均由 CI 在 main 合入后发布，
**部署只需 helm install**。

**前置条件**：

- 监控栈已按 §1 部署；chart 的 `scrapeConfigs.releaseLabel`（默认 `kube-prometheus`）必须与
  Prometheus CR 的 `scrapeConfigSelector`（默认 = stack 的 helm release 名）匹配，
  否则 BMC 指标静默丢失；
- exporter 所在节点可直连 BMC 管理网段（10.6.2.x；实测集群节点可达，无需隧道）。

**安装**：

BMC 密码不要放 `--set`（shell history / 进程参数可见，且含特殊字符时易被 helm 误解析）——
用 values 文件（权限 600）传入，装完即删：

```bash
umask 077
cat > /tmp/bmc-values.yaml <<EOF
bmc:
  username: root
  password: '<BMC 密码>'
  hosts: [10.6.2.14, 10.6.2.18]
bmcOemExporter:
  tlsInsecure: true   # BMC 为自签名证书时显式开启; 生产环境应配置 CA 并保持 false
EOF

helm upgrade --install cubestack-bmc-exporter \
  oci://harbor.isuanova.com/suanova/cubestack-bmc-exporter-chart \
  --version 1.0.0 \
  -n monitoring \
  -f /tmp/bmc-values.yaml
rm -f /tmp/bmc-values.yaml
```

**常用配置**：

- 监控栈 helm release 名不是 `kube-prometheus`：`--set scrapeConfigs.releaseLabel=<release 名>`
- 钉在 control-plane 节点时（⚠ 必须同时加 tolerations，否则 NoSchedule 污点导致 pod 永远
  Pending，2026-09-14 实测；idracExporter 同理）：

```bash
--set 'bmcOemExporter.nodeSelector.kubernetes\.io/hostname=<master 节点>' \
--set 'bmcOemExporter.tolerations[0].key=node-role.kubernetes.io/control-plane' \
--set 'bmcOemExporter.tolerations[0].operator=Exists' \
--set 'bmcOemExporter.tolerations[0].effect=NoSchedule'
```

- 离线环境无法访问 harbor 时：镜像需在节点本地构建导入（bmc-oem-exporter 用仓库 Dockerfile
  多阶段构建，需本机 buildah store 先有 `golang:1.26` 基础镜像；idrac-exporter 为 Go 静态编译
  + buildah scratch 镜像；均需 `ctr -n k8s.io images import`，参考
  `deploy/bmc/deploy-bmc.sh`），安装时**两个 exporter 的镜像仓库都要覆盖**（只覆盖一个时
  另一个仍指向 harbor 无法拉取）；导入的 tag 不是 `latest` 时两个 `image.tag` 也要一起
  显式指定：
  `--set bmcOemExporter.image.repository=<本地名> --set idracExporter.image.repository=<本地名>
  --set bmcOemExporter.image.tag=<导入tag> --set idracExporter.image.tag=<导入tag>`。

**验证**：

```bash
kubectl -n monitoring rollout status deploy/cubestack-bmc-exporter-bmc-oem-exporter
kubectl -n monitoring rollout status deploy/cubestack-bmc-exporter-idrac-exporter
# Prometheus targets：job=bmc-oem-exporter / idrac-exporter，instance=BMC IP，共 4 个 up
# Grafana："BMC Hardware" dashboard（uid bmc-hardware-cubestack）
```
