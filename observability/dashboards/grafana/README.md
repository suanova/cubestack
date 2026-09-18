# Grafana Dashboards

CubeStack V1 Grafana Dashboard 清单。所有 Dashboard 面向管理员 / SRE 深度诊断，不作为普通用户默认入口。

## 导入方式

Grafana UI → Dashboards → Import → Upload JSON file，或通过 installer 自动导入（见 `observability/docs/installer-requirements.md`）。

---

## Dashboard 清单

### 社区原版（直接导入，保留原版 uid）

| 文件 | 来源 | uid | 说明 |
|---|---|---|---|
| `node-exporter-1860.json` | Grafana Community ID 1860 | `rYdddlPWk` | Node CPU / Memory / Disk / Network / System 深度诊断 |
| `rdma-infiniband-23823.json` | Grafana Community ID 23823 | `eefhg6y1xs8owa` | RDMA HCA / Port / Traffic / Error |
| `ceph-2842.json` | Grafana Community ID 2842 | `tbO9LAiZK` | Ceph Health / Capacity / OSD / PG / IO |
| `envoy-proxy-overview-24459.json` | Grafana Community ID 24459 | `envoy-overview-skj2` | 标准 Envoy Proxy 运维视图（非 AI Gateway 专用） |

### CubeStack 定制版

| 文件 | 来源 | uid | 说明 |
|---|---|---|---|
| `envoy-ai-gateway.json` | 基于 `gen_ai_*` 指标定制 | `envoy-ai-gateway-cubestack` | Request / Token / TTFT / TPOT / Provider / Model |
| `metax-gpu-c500.json` | MetaX mxExporter 官方 Dashboard 适配 | `metax-gpu-c500-cubestack` | GPU Util / VRAM / Temp / Power / PCIe / MetaXLink / RAS |
| `sglang-pd.json` | SGLang 官方 Dashboard 适配（PD v3） | `sglang-cubestack-pd-v3` | Running / Queue / Token / KV / TTFT / PD Queue / Rank Diagnosis |
| `workload-troubleshooting.json` | KSM + cAdvisor 定制 | `k8s-workload-cubestack` | Namespace → Workload → Pod → Container 定向排障 |
| `nvidia-dcgm.json` | NVIDIA DCGM Exporter 定制 | `nvidia-dcgm-cubestack` | GPU Util / Memory / Temp / Power / Health（需 NVIDIA GPU 环境） |
| `vllm.json` | vLLM 官方指标定制 | `vllm-cubestack` | vLLM Runtime 性能指标（需 vLLM 环境） |
| `bmc-hardware.json` | idrac_exporter 社区 BMC overview 定制 + bmc-oem-exporter PCIe 指标 | `bmc-hardware-cubestack` | C500 带外统一健康视图：系统/温度/风扇/电源/GPU 功耗/PCIe 设备/硬盘/内存（instance 变量切换 BMC；两套健康值约定阈值分开配） |

---

## 命名规范

- **文件名**：`<name>[-<community-id>].json`，全小写，用 `-` 分隔
- **uid**：社区原版保留原 uid；定制版格式 `<name>-cubestack[-<version>]`
- **tags**：所有 dashboard 必须包含 `cubestack`；社区原版保留原有 tags；定制版补充内容相关 tags

## 面板说明

`bmc-hardware.json` 每个面板的含义与异常判读见 `../../docs/bmc-dashboard-panels.md`。
