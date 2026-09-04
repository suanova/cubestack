# Overview 页面 PromQL 表达式

UI 开发者直接使用本文档中的 expr，无需自行编写 PromQL。
刷新间隔建议 30s。

---

## 第一行：状态卡片（Stat）

### GPU Capacity / Allocated / Ratio
```
sum(cluster_node:cubestack_gpu_capacity:sum)
sum(cluster_node:cubestack_gpu_allocated:sum)
sum(cluster_node:cubestack_gpu_allocated:sum) / sum(cluster_node:cubestack_gpu_capacity:sum)
```
- Unit：count / count / ratio (0-1)

### GPU Average Utilization
```
avg(cluster_node:cubestack_gpu_utilization_ratio:avg)
```
- Unit：ratio (0-1)

### Node Ready / Total
```
sum(kube_node_status_condition{condition="Ready", status="true"})
count(kube_node_info)
```
- 展示格式：`8/8`

### InferenceService Ready / Total
```
sum(cubestack_inference_service_ready == 1) or vector(0)
count(cubestack_inference_service_info) or vector(0)
```
- **注：依赖 Controller metric，待开发，上线前返回 0**

### DevEnvironment Total / Running
```
count(kube_statefulset_replicas{label_app_kubernetes_io_part_of="cubestack-devenv"})
count(kube_statefulset_status_replicas_ready{label_app_kubernetes_io_part_of="cubestack-devenv"} > 0)
```
- 依赖 KSM `statefulsets=[app.kubernetes.io/part-of]` allowlist 配置（见 docs/dependencies.md 3.1）
- Total = StatefulSet 数量；Running = 至少有 1 个 ready replica 的 StatefulSet 数量

### Ceph Health
```
max(ceph_health_status) or vector(0)
```
- 值：`0`=HEALTH_OK，`1`=HEALTH_WARN，`2`=HEALTH_ERR

### RDMA 异常节点数
```
count(count by (node)(infiniband_port_state != 4)) or vector(0)
```
- 0 时绿色 Healthy，>0 时红色

---

## 第二行：趋势图（Time Series）

### GPU Average Utilization
```
avg(cluster_node:cubestack_gpu_utilization_ratio:avg)
```
- Unit：ratio (0-1)

### Requests/s
```
sum(rate(gen_ai_server_request_duration_seconds_count[5m]))
```

### Prompt Tokens/s
```
sum(rate(gen_ai_client_token_usage_count{gen_ai_token_type="input"}[5m]))
```

### Generation Tokens/s
```
sum(rate(gen_ai_client_token_usage_count{gen_ai_token_type="output"}[5m]))
```

### Cluster CPU Utilization
```
1 - sum(rate(node_cpu_seconds_total{mode="idle", job="node-exporter"}[5m])) / sum(rate(node_cpu_seconds_total{job="node-exporter"}[5m]))
```
- Unit：ratio (0-1)

### Cluster Memory Utilization
```
1 - sum(node_memory_MemAvailable_bytes{job="node-exporter"}) / sum(node_memory_MemTotal_bytes{job="node-exporter"})
```
- Unit：ratio (0-1)

### Storage Utilization
```
sum(ceph_cluster_total_used_bytes) / sum(ceph_cluster_total_bytes)
```
- Unit：ratio (0-1)
