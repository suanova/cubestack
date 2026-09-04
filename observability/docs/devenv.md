# DevEnvironment 页面 PromQL 表达式

变量：
- `$namespace`（来自 `label_values(cubestack_devenv_cpu_usage_cores:sum, namespace)`）
- `$devenv`（来自 `label_values(kube_statefulset_replicas{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace"}, statefulset)`）

> **注意 label 区分：**
> - State/Running Time 来自 KSM StatefulSet metric，使用 `statefulset` label，对应 `statefulset="$devenv"`
> - Recording rule 产出的 resource metric（CPU/Memory/GPU/Network 等）使用 `devenv` label，对应 `devenv="$devenv"`
> - 两套 label key 不同，查询时需按各自 label 名过滤

---

## DevEnvironment List（每行一个环境）

### State（从 KSM StatefulSet 推断）
```
# Running
kube_statefulset_status_replicas_ready{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace", statefulset="$devenv"} > 0

# Stopped（用户主动 scale down）
kube_statefulset_spec_replicas{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace", statefulset="$devenv"} == 0

```
- UI 根据以上条件判断并展示对应状态标签

### Running Time
```
time() - min by (namespace, devenv) (
  label_replace(
    kube_pod_start_time
    * on(namespace, pod) group_left(label_cubestack_io_devenv)
    kube_pod_labels{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace"},
    "devenv", "$1", "label_cubestack_io_devenv", "(.*)"
  )
){devenv="$devenv"}
```
- Unit：s；取最早启动的 pod 时间作为 devenv 启动时间

### CPU Request
```
cubestack_devenv_cpu_request_cores:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：cores

### Memory Request
```
cubestack_devenv_memory_request_bytes:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：bytes

### GPU Allocated
```
cubestack_devenv_gpu_allocated:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：count（0 时隐藏 GPU 列）

### PVC Status
```
cubestack_devenv_pvc_bound:min{namespace="$namespace", devenv="$devenv"}
```
- 1=all Bound，0=any Unbound

---

## DevEnvironment Detail

### Status

#### State
```
# Running
kube_statefulset_status_replicas_ready{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace", statefulset="$devenv"} > 0
# Stopped
kube_statefulset_spec_replicas{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace", statefulset="$devenv"} == 0
```

#### Running Time
```
time() - min by (namespace, devenv) (
  label_replace(
    kube_pod_start_time
    * on(namespace, pod) group_left(label_cubestack_io_devenv)
    kube_pod_labels{label_app_kubernetes_io_part_of="cubestack-devenv", namespace="$namespace"},
    "devenv", "$1", "label_cubestack_io_devenv", "(.*)"
  )
){devenv="$devenv"}
```

#### Pod Ready
```
cubestack_devenv_pod_ready:min{namespace="$namespace", devenv="$devenv"}
```
- 1=all pods ready

#### Container Ready
```
cubestack_devenv_container_ready:min{namespace="$namespace", devenv="$devenv"}
```

#### Restarts
```
cubestack_devenv_container_restarts_total:sum{namespace="$namespace", devenv="$devenv"}
```

---

### CPU / Memory（Time Series）

#### CPU Usage / Request
```
cubestack_devenv_cpu_usage_cores:sum{namespace="$namespace", devenv="$devenv"}
cubestack_devenv_cpu_request_cores:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：cores

#### Memory Usage / Request
```
cubestack_devenv_memory_working_set_bytes:sum{namespace="$namespace", devenv="$devenv"}
cubestack_devenv_memory_request_bytes:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：bytes

---

### GPU（仅 `cubestack_devenv_gpu_allocated:sum > 0` 时展示）

变量：`$uuid`（来自 `label_values(cubestack_gpu_utilization_ratio:max{namespace="$namespace", devenv="$devenv"}, uuid)`）

```
cubestack_devenv_gpu_allocated:sum{namespace="$namespace", devenv="$devenv"}
cubestack_gpu_utilization_ratio:max{namespace="$namespace", devenv="$devenv", uuid="$uuid"}
cubestack_gpu_memory_utilization_ratio:max{namespace="$namespace", devenv="$devenv", uuid="$uuid"}
```

---

### Network / IO（Time Series）

```
cubestack_devenv_network_receive_bytes:rate5m{namespace="$namespace", devenv="$devenv"}
cubestack_devenv_network_transmit_bytes:rate5m{namespace="$namespace", devenv="$devenv"}
cubestack_devenv_fs_read_bytes:rate5m{namespace="$namespace", devenv="$devenv"}
cubestack_devenv_fs_write_bytes:rate5m{namespace="$namespace", devenv="$devenv"}
```
- Unit：B/s

---

### Storage

#### PVC Status
```
cubestack_devenv_pvc_bound:min{namespace="$namespace", devenv="$devenv"}
```

#### PVC Requested Capacity
```
cubestack_devenv_pvc_requested_capacity_bytes:sum{namespace="$namespace", devenv="$devenv"}
```
- Unit：bytes
