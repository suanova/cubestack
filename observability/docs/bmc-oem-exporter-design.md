# BMC 带外监控设计方案（idrac_exporter + bmc-oem-exporter）

**范围：** CPU 管理节点 / C500 GPU 节点 / C550 超节点、H200

---

## 1. 背景

集群未来有 4 类主机：CPU 管理节点、MetaX C500 GPU 节点、超节点（4×C550）、NVIDIA H200。目前测试环境只有 2 台 C500（BMC IP 见 `tmp/remote_env`），先在 C500 上完成实现和验证，设计上预留其他机型的扩展空间。

带外数据来自标准 Redfish API（已实测 H3C AST2600 BMC，Redfish 1.15.1，`/redfish/v1/{Systems,Chassis,Managers}` 及子资源）。

## 2. 实测结论

- 标准 Redfish 资源（`Thermal`/`Power`/`Sensors`/`PCIeDevices`）完整可用，单机 3 个端点总耗时 <1.5s，采集压力很小。
- GPU（Metax C500）以 `PCIeDevices` 形式暴露：型号/固件版本/健康状态/在位功耗；不含 GPU 芯片温度/利用率——这些已由 GPU 侧 `mx-exporter` 覆盖，BMC exporter 只需补"整机硬件层"（温度、风扇、电源、PSU、网卡链路、固件、PCIe 卡在位），职责边界清晰，不重复采集。
- `PCIeDevices` 下 `Oem.Public.PCIeCardType` 字段是**通用分类字段**，GPU/NIC/RAID 卡都有（已用 device 1/4/7 三种卡型验证），因此可以用一套通用采集/解析逻辑覆盖所有 PCIe 卡类型，GPU 专属字段（`PowerWatts`/`PowerCapacityWatts`/`MemorySizeMiB`）按 `PCIeCardType=="GPU"` 条件附加。
- 网络拓扑：测试环境 k8s 业务网段可直接路由到 BMC 管理网段，无 NetworkPolicy 限制，两个 exporter 都可以作为集群内 Deployment 部署（不需要像 `mx-exporter` 那样跑裸机 systemd）。
- BMC 支持 EventService 订阅（webhook 推送），但需要 BMC 反向连通我们，增加网络方向复杂度，不采用推送模式。
- operator 侧没有任何现成 CRD 记录 node↔BMC IP 映射或硬件型号，这个映射由 exporter 自己的配置维护（类比现有 `mx-exporter` 用 ScrapeConfig 静态 target 的做法）。

## 3. 架构决策

### 3.1 两个 exporter，职责分离

| Exporter | 来源 | 职责 |
|---|---|---|
| `idrac_exporter`（`mrlhansen/idrac_exporter`） | 社区，直接拉镜像，不改代码 | 标准 Redfish 字段：温度/风扇/电源/存储/内存/网络/管理器等，多厂商兼容逻辑已由社区维护 |
| `bmc-oem-exporter` | 自建（Go，本次新增） | 所有厂商 OEM 扩展字段：当前是 GPU 通过 `PCIeDevices.Oem.Public`；后续超节点/机柜/液冷等 OEM 专属数据也加入同一个 exporter，作为新的采集函数，而不是新起一个 exporter |

理由：
- `idrac_exporter` 零维护成本，社区持续验证，符合"优先用社区现成代码"的前提。
- OEM 扩展字段厂商差异大、无标准 schema，注定要自己写；把它们都放进同一个自建 exporter，避免"每加一个硬件维度就多一个进程"的碎片化，也避免 fork `idrac_exporter` 带来的上游合并成本。
- 两者对 BMC 的查询逻辑独立（`idrac_exporter` 走它自己的多厂商兼容层，`bmc-oem-exporter` 走 basic auth 查 Redfish OEM 路径），合并没有实际代码复用收益，运维上多一套 Deployment/Service/ScrapeConfig 只是几十行 YAML，成本可接受。

### 3.2 不引入 Redis / 缓存层

DaoCloud 参考实现（`cube-oob-*`）用 Redis 是因为他们的场景（超节点 + PMC 电源柜 + SNMP trap + 动态 Probe CRD，多种探测目标混合）下 BMC 查询可能拖到几秒到几十秒，必须把"后台异步刷新"和"scrape 只读缓存"解耦。

我们实测 C500 单机 3 个 Redfish 端点总耗时 <1.5s，远低于 Prometheus 默认 10s `scrape_timeout`，不存在这个问题。方案：
- 直接 on-demand 查询 BMC，不加缓存组件。
- scrape interval 可以设置得比业务指标长（如 60-120s），风扇/电源/固件这类数据变化慢，间隔长不影响可观测性。
- 如果后续 BMC 数量增多导致轮询压力变大，优先做法是调长 interval 或利用 `idrac_exporter` 内置的 `concurrency` 配置限流，而不是引入缓存层。

### 3.3 不做 push / EventService 订阅

避免 BMC 反向连接集群带来的网络方向复杂度，全部走 Prometheus scrape 主动拉取。

### 3.4 Dashboard 与 recording rules

- **不**把硬件健康加到 Node Detail 页面，单独做一个"BMC Hardware" Grafana dashboard。
- **不**为硬件指标写 `cubestack_*` recording rules，dashboard 直接查询 `idrac_exporter` 和 `bmc-oem-exporter` 暴露的 raw metrics。这是相对现有 recording-rule 命名规范（`docs/overview.md`/`docs/node.md`）的有意例外：硬件层指标本身就是"节点级"粒度，没有跨 runtime（vLLM/SGLang、DCGM/MetaX）的抽象需求，raw metrics 已经足够稳定，不需要额外一层间接。

## 4. `bmc-oem-exporter` 采集范围（本次实现）

### 4.1 PCIeDevices 通用模型

单次调用 `GET /redfish/v1/Chassis/{id}/PCIeDevices?$expand=.`（已验证一次请求返回全部 device 详情，避免 N+1）。

通用字段（所有卡类型）：
- `CardManufacturer`, `CardModel`, `Manufacturer`, `Model`, `PartNumber`, `SerialNumber`, `FirmwareVersion`
- `Status.Health`, `Status.State`
- `Oem.Public.{PCIeCardType, ChipManufacturer, ChipModel, DeviceLocator, Position, SlotNumber, MezzSlot}`

`PCIeCardType == "GPU"` 时追加：
- `Oem.Public.PowerWatts`, `Oem.Public.PowerCapacityWatts`, `Oem.Public.MemorySizeMiB`

已验证的 3 种卡型（C500 BMC1，10.6.2.14）：
- GPU（Metax C500-PCIe-64GB，device 7-14，8 张）
- NIC（Mellanox ConnectX-7，device 1-3）
- RAID（H3C RAID-P460-B2 / Microchip PM8204，device 4）

### 4.2 具体指标（初版）

| 指标 | 类型 | Labels | 说明 |
|---|---|---|---|
| `bmc_pcie_device_info` | Gauge（恒 1） | `bmc_ip`, `chassis`, `position`, `card_type`, `manufacturer`, `model`, `chip_manufacturer`, `chip_model`, `firmware_version`, `serial_number` | 每张 PCIe 卡一条，用于关联型号/固件信息 |
| `bmc_pcie_device_health` | Gauge（0/1） | `bmc_ip`, `chassis`, `position`, `card_type` | 1=OK，0=非 OK（Warning/Critical） |
| `bmc_pcie_device_present` | Gauge（0/1） | `bmc_ip`, `chassis`, `position`, `card_type` | 卡在位状态（`Status.State == Enabled`） |
| `bmc_gpu_power_watts` | Gauge | `bmc_ip`, `chassis`, `position` | 仅 `card_type=GPU`，在位功耗 |
| `bmc_gpu_power_capacity_watts` | Gauge | `bmc_ip`, `chassis`, `position` | 仅 `card_type=GPU`，额定功耗上限 |
| `bmc_gpu_memory_size_mib` | Gauge | `bmc_ip`, `chassis`, `position` | 仅 `card_type=GPU`，显存容量（非利用率，利用率由 GPU 侧 exporter 提供） |

label 用 `bmc_ip` 而不是 `node`，是因为 exporter 本身不知道 BMC IP 对应哪个 k8s node（无 CRD 映射）；node 级关联留给 dashboard/Grafana 层通过变量或人工映射表处理，避免 exporter 里硬编码拓扑关系。

### 4.3 暂不实现（等对应硬件到测试环境再验证）

- 液冷 / 漏液检测（C500 是风冷，`Thermal.Oem.Public.CoolingMedium == "AirCooled"`，`LiquidCoolers` 数组为空）
- 超节点内部互联（NVLink/NVSwitch 状态等，无标准 schema，需要 C550 真机确认 OEM 路径）
- H200 的 NVIDIA OEM 扩展字段（完全未验证，字段名/路径未知）

这些留空不是遗漏，是按用户明确指示"没有的指标，有测试环境再测试"推迟到硬件到位后再加采集函数，代码结构上只需要在 `bmc-oem-exporter` 里新增 collector，不影响现有实现。

## 5. Exporter 接口设计

- 采用 `?target=<bmc_ip>` 多目标模式（与 `idrac_exporter`、blackbox_exporter 一致），单个 Deployment 服务所有 BMC。
- BMC 凭据（user/password）通过 exporter 自身配置（ConfigMap/Secret）按 IP 或全局管理，不依赖 k8s CRD。
- HTTP handler：`/probe?target=<bmc_ip>` 返回该 BMC 的 Prometheus text 格式指标。

## 6. Prometheus 接入

沿用现有 `mx-exporter` 的 `ScrapeConfig` 静态 target 模式。两个 exporter 各自一个 ScrapeConfig（`job` label 区分），每个 BMC 一个 staticConfigs entry，用 `__param_target` label 把 BMC IP 注入 scrape URL，并用 `relabelings` 把 `instance` 重写为 BMC IP（这样两个 BMC 的指标在 dashboard 里用 `instance` 区分）：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: cubestack-bmc-oem-exporter
  namespace: monitoring
  labels:
    app.kubernetes.io/part-of: cubestack-observability
    release: kube-prometheus-stack
spec:
  metricsPath: /probe
  scrapeInterval: 60s
  staticConfigs:
    - targets: [cubestack-bmc-oem-exporter.monitoring.svc:9622]
      labels:
        job: bmc-oem-exporter
        __param_target: 10.6.2.14
    - targets: [cubestack-bmc-oem-exporter.monitoring.svc:9622]
      labels:
        job: bmc-oem-exporter
        __param_target: 10.6.2.18
  relabelings:
    - sourceLabels: [__param_target]
      targetLabel: instance
```

- **抓取路径实测（2026-09-09 真机验证）：`bmc-oem-exporter` 是 `/probe?target=<ip>`，`idrac_exporter` v1.6.2 是 `/metrics?target=<ip>`（不是 /probe）**，两个 ScrapeConfig 的 `metricsPath` 不同。
- ScrapeConfig 的 relabel 字段名是 `relabelings`（与 ServiceMonitor 一致，v1alpha1 严格解码不接受 `relabelConfigs`）。
- 交付形式为 Helm chart：`helm/cubestack-bmc-exporter-chart/`（templates 生成上述 ScrapeConfig，`bmc.hosts` 列表驱动），CI 发布 OCI 到 harbor。测试环境安装见 `deploy/bmc/deploy-bmc.sh`。

## 7. 落地顺序

1. 实现 `bmc-oem-exporter`（Go），覆盖第 4 节列出的 PCIeDevices/GPU 指标。✅ 已完成，见 `observability/bmc-oem-exporter/`。
2. 部署 `idrac_exporter`（社区镜像，不改代码）+ `bmc-oem-exporter` 到测试环境，ScrapeConfig 指向 2 台 C500 BMC（10.6.2.14 / 10.6.2.18）。
3. 验证两个 exporter 的指标都能进入 Prometheus。
4. 做一个独立的 "BMC Hardware" Grafana dashboard，直接用 raw metrics（不经 recording rule）。
5. C550 超节点、H200 拿到真机后，在 `bmc-oem-exporter` 里补充对应的 OEM 采集函数，按需扩展 dashboard。

## 9. 二进制验证结果（本地构建，未走容器镜像）

两个 exporter 都已跳过 K8s 部署，先在本地直接对 2 台 C500 BMC（通过 SSH 隧道）验证：

### 9.1 `bmc-oem-exporter`

`go build` 后二进制直连两台 BMC 的 `/probe?target=<ip>`：
- BMC1（10.6.2.14）：8 GPU + 3 NIC + 1 RAID + 1 空槽（`card_type=unknown`, `present=0`），全部字段与之前 curl 实测一致。
- BMC2（10.6.2.18）：13 个设备，`bmc_pcie_scrape_success=1`。
- 单次 probe 延迟 ~0.6s。
- 异常路径验证：无 `target` 参数 → HTTP 400；BMC 不可达 → `bmc_pcie_scrape_success=0`，不 crash、不返回残留数据。

### 9.2 `idrac_exporter`（社区二进制，非容器方式验证）

Docker Hub 与测试环境 k3s 配置的 `docker.m.daocloud.io` mirror 都无法拉取镜像（前者网络不通，后者 403）。改用 `go install github.com/mrlhansen/idrac_exporter/cmd/idrac_exporter@v1.6.2`（走 goproxy.cn）直接编译源码，本地跑二进制指向 BMC 隧道端口，等效验证：

- 两台 BMC 均返回 302 行指标，`idrac_exporter_scrape_errors_total=0`，单次请求 ~3.3s（含 system+sensors+power+storage+memory 5 组，符合"多端点合计 <10s scrape_timeout"预期，比单独查 PCIeDevices 慢是因为组多）。
- 已确认可用的组：`system`（BIOS/CPU/内存总量/开机状态/健康）、`sensors`（风扇转速、温度）、`power`（PSU 输入电压/功率/健康）、`storage`（硬盘容量/型号/健康，RAID 控制器关联正确）、`memory`（DIMM 容量，8+ 条全部识别）。
- **`network` 组在这台 H3C BMC 上无输出**：`Systems/1/NetworkInterfaces` 下 3 个 `PCIeSlot*` 成员均存在，但每个成员对象缺少标准 `Status` 字段；`idrac_exporter` 的 `RefreshNetwork` 逻辑要求 `Status.State == "Enabled"` 才继续采集端口，否则跳过整个 interface。这是该 BMC 厂商固件对标准 Redfish schema 的字段缺失，不是 idrac_exporter 的 bug，也不是我们能改的（不改社区代码的前提下）。网卡链路状态目前只能靠 `bmc-oem-exporter` 的 `bmc_pcie_device_health/present`（PCIeDevices 路径下的 NIC 卡在位/健康）间接覆盖，链路 up/down 细节（`idrac_network_port_link_up`）暂时拿不到。
- **健康状态数值约定不同**：`idrac_exporter` 用 `0=OK, 1=Warning, 2=Critical, -1=未知`（`idrac_system_health`/`idrac_power_supply_health`/`idrac_drive_health` 等统一遵循这个约定），而 `bmc-oem-exporter` 用 `1=OK, 0=非OK`。两者是独立指标体系，dashboard 面板阈值需要分别设置，不能用同一套"1=健康"假设。
- 厂商信息确认：两台 BMC 均为 `New H3C Technologies Co., Ltd.` / `H3C UniServer R5300 G6`，`idrac_exporter` 通过标准 `Manufacturer`/`Model` 字段完成厂商检测，未见特殊分支报错。

### 9.3 结论

- 两个 exporter 分工成立：标准字段（温度/风扇/电源/存储/内存）由 idrac_exporter 覆盖，PCIeDevices GPU/NIC/RAID OEM 字段由 bmc-oem-exporter 覆盖，两者在这台硬件上没有重叠也没有空白（网卡链路细节的缺口已知且不影响当前范围）。
- 部署到测试环境时二进制方式（非镜像）也是可行的备选：如果 K8s 侧镜像拉取问题（docker.io 不通、内部 mirror 403）在容器化部署时依然存在，可以考虑把 idrac_exporter 和 bmc-oem-exporter 都编译成二进制打进自建的最小基础镜像（如从 `golang:alpine` 构建阶段产出二进制，最终镜像用已知可拉取的 base image），避免依赖 Docker Hub。

## 8. 与 DaoCloud 参考代码的关系

设计与实现参考了 `cube-oob-*` 的整体思路（Redfish 采集、面板分类），但：
- 不复用其 Redis 缓存架构（本场景不需要）。
- 不采用其 json-exporter + nginx proxy 组合，改为自建 Go exporter 直接对接 Redfish。
- 不直接搬用其 Dashboard JSON 或产品命名，重新设计指标名（`bmc_*` 前缀）和面板，避免品牌关联。
