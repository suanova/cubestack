# Node 页面 PromQL 表达式

变量：`$node`（来自 `label_values(kube_node_info, node)`）

---

## Node List（每行一个节点）

### Ready 状态
```
kube_node_status_condition{condition="Ready", status="true", node="$node"}
```
- 值 1=Ready，0=NotReady

### GPU Count（allocatable）
```
cluster_node:cubestack_gpu_capacity:sum{node="$node"}
```

### GPU Allocated
```
cluster_node:cubestack_gpu_allocated:sum{node="$node"}
```

### GPU Average Utilization
```
cluster_node:cubestack_gpu_utilization_ratio:avg{node="$node"}
```
- Unit：ratio (0-1)

---

## Node Detail

### Summary

#### Ready 状态
```
kube_node_status_condition{condition="Ready", status="true", node="$node"}
```

#### CPU Utilization
```
cubestack_node_cpu_utilization_ratio{node="$node"}
```

#### Memory Utilization
```
cubestack_node_memory_utilization_ratio{node="$node"}
```

#### GPU Allocated / Total
```
cluster_node:cubestack_gpu_allocated:sum{node="$node"}
cluster_node:cubestack_gpu_capacity:sum{node="$node"}
```

#### GPU Average Utilization
```
cluster_node:cubestack_gpu_utilization_ratio:avg{node="$node"}
```

#### RDMA Health（1=all Active，0=any down）
```
cluster_node:cubestack_network_rdma_port_up:min{node="$node"}
```

#### Node Pressure
```
kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure", status="true", node="$node"}
```
- `condition` label 取值：`MemoryPressure` / `DiskPressure` / `PIDPressure`
- 值 1=pressure active

---

### CPU / Memory（Time Series）

```
cubestack_node_cpu_utilization_ratio{node="$node"}
cubestack_node_memory_utilization_ratio{node="$node"}
```

---

### GPU（per UUID，Time Series）

变量：`$uuid`（来自 `label_values(cubestack_gpu_utilization_ratio{node="$node"}, uuid)`）

#### Utilization
```
cubestack_gpu_utilization_ratio{node="$node", uuid="$uuid"}
```

#### VRAM Utilization
```
cubestack_gpu_memory_utilization_ratio{node="$node", uuid="$uuid"}
```

#### Temperature
```
cubestack_gpu_temperature_celsius{node="$node", uuid="$uuid"}
```
- Unit：℃

#### Power
```
cubestack_gpu_power_watts{node="$node", uuid="$uuid"}
```
- Unit：W

---

### Network / Disk（Time Series）

#### Network RX
```
cluster_node:cubestack_node_network_receive_bytes:rate5m{node="$node"}
```
- Unit：B/s

#### Network TX
```
cluster_node:cubestack_node_network_transmit_bytes:rate5m{node="$node"}
```

#### Disk Read
```
sum by (node) (
  label_replace(
    rate(node_disk_read_bytes_total{job="node-exporter"}[5m]),
    "internal_ip", "$1", "instance", "([^:]+):.*"
  )
  * on (internal_ip) group_left(node) kube_node_info
){node="$node"}
```
- Unit：B/s

#### Disk Write
```
sum by (node) (
  label_replace(
    rate(node_disk_written_bytes_total{job="node-exporter"}[5m]),
    "internal_ip", "$1", "instance", "([^:]+):.*"
  )
  * on (internal_ip) group_left(node) kube_node_info
){node="$node"}
```

---

### RDMA（Time Series）

#### RDMA RX
```
cluster_node:cubestack_network_rdma_receive_bytes:rate5m{node="$node"}
```
- Unit：B/s

#### RDMA TX
```
cluster_node:cubestack_network_rdma_transmit_bytes:rate5m{node="$node"}
```
