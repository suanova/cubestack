# BMC Hardware Dashboard 面板详解

Dashboard 文件：`dashboards/grafana/bmc-hardware.json`（uid `bmc-hardware-cubestack`），
数据来源：`idrac_exporter`（标准 Redfish 组）+ `bmc-oem-exporter`（PCIeDevices OEM 字段），
采集与部署细节见 `docs/bmc-oem-exporter-design.md` 和 `docs/bmc-progress.md`。

先记住**两套健康值约定**（面板里已各自处理，但读原始数据时要注意）：

- **idrac_exporter**：`0=OK`（绿）、`1=Warning`（黄）、`2=Critical`（红）、`-1=Unknown`（灰）
- **bmc-oem-exporter**：`1=OK`（绿）、`0=Not OK`（红）

---

## 一、Overview（9 个概览 stat）

这一行是**第一眼判断区**：任何一块变红，就往下钻对应区块。

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **System Health** | BMC 报告的系统整体健康状态 | 非 OK 即异常。Warning=有部件降级但系统可用；Critical=系统级故障。显示的是所选 BMC 里**最差**的一个 |
| **Power State** | 整机是否上电 | Off = 机器被关机、掉电或电源全部失效。显示的是**任一** BMC 关机即 Off |
| **PSU Not OK** | 不健康的电源模块数量 | >0 = 有电源故障。1 台坏通常还有冗余；2 台坏=供电冗余丢失，随时可能整机掉电 |
| **PCIe Devices Not OK** | 在位但健康异常的 GPU/NIC/RAID 卡数量（空槽位已排除） | >0 = 某张卡降级或故障，先看 PCIe Device Health 表定位是哪张 |
| **Drives Not OK** | 不健康的硬盘数量 | >0 = 硬盘故障或预故障，看 Drive Health 表定位 |
| **Memory Modules Not OK** | 不健康的内存条数量 | >0 = DIMM 报错（通常是 ECC 错误累积），看 Memory Modules 表 |
| **Fans Not OK** | 不健康的风扇数量 | >0 = 风扇停转/失效，**立即查温度**——散热能力下降后温度会跟着涨 |
| **BMC Scrape Success** | bmc-oem-exporter 最近一次能否成功探测这台 BMC | Not OK = BMC 网络不通/宕机/密码错误。此时该 BMC 的 **PCIe Devices / GPU OEM 面板**（仅 bmc-oem-exporter 提供）数据是旧值，别信；温度/功耗/存储等标准面板由 idrac_exporter 独立抓取，不受影响 |
| **idrac Scrape Errors** | idrac_exporter 累计 Redfish 调用错误数（所选 BMC 合计） | 持续增长 = BMC 响应异常或频繁超时；偶尔+1 可忽略 |

---

## 二、Thermal（温度与风扇）

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **Temperatures** | 所有温度传感器的时序曲线（进风口、CPU、机箱内部等，H3C 命名按 `name` 区分） | ①任何传感器**陡升**；②CPU 温度长期 >85~90°C；③同类型传感器之间出现**明显分叉**（比如两个 CPU 温差 >20°C，可能一个散热器接触不良/风扇分区故障） |
| **Fans** | 每个风扇转子的转速。H3C 一个风扇模块有两个转子，所以图例是 `Fan1 #0`/`Fan1 #1` | ①某个转子转速**跌到接近 0**=停转；②全部转子**拉到最高转速**且温度不高=风扇控制异常或机房环境异常；③转速**忽高忽低振荡**=风扇或控制板故障前兆 |

**联动判读**：Fans Not OK + 温度上升 = 冷却链故障，优先处理风扇。

---

## 三、Power（整机供电）

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **Power Consumption** | 整机实时功耗（Current）与均值（Average），单位 W | ①功耗**长时间贴近额定容量**（对比 PSU 容量）；②功耗**突然掉到接近 0**=负载全没了或读不到值；③功耗在无负载时异常高=可能有部件短路/失效 |
| **Power Supplies** | 每块 PSU 的输出功率和输入功率对比 | ①某块 PSU 输出**恒为 0**=该电源已挂（输入正常但无输出）；②输出功率**长期大于输入功率**=传感器读数异常；③两块 PSU 输出**严重不均**（>60%/40%）=负载均衡异常或一块在降额运行 |
| **PSU Health** | 每块电源的健康状态表 | 任何一行不是 OK 就要注意，结合上方面板判断是该 PSU 自身故障还是上游供电问题 |

---

## 四、GPU Power（每张 GPU 卡的 BMC 侧功耗）

这组数据来自 **bmc-oem-exporter**（PCIeDevices OEM 字段），是**带外视角**——即使 GPU 卡的 OS 驱动挂了，这里仍能看到卡的功耗。

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **GPU Power Draw** | 每张 GPU 卡（按槽位 position）的实时功耗曲线 | ①某张卡功耗**恒为 0**=卡不在位/掉卡/卡故障（结合 PCIe Device Health 表）；②某张卡功耗**明显高于其他同型号卡**=该卡负载不均或卡内短路风险；③整体功耗**长时间贴着容量**=散热/供电压力大 |
| **GPU Power Capacity Total** | 所有 GPU 卡额定功耗之和（参考值） | 单独看无意义，和 Power Draw 对比用 |
| **GPU Memory Total** | 所有 GPU 显存之和（参考值） | 同上 |
| **GPU Power per Card** | 每张卡的三列对照表：实时功耗 / 额定容量 / 显存大小 | ①**Power > Capacity**=该卡超功耗运行；②某张卡 **Memory 与其他卡不同**=卡型不一致或被换过；③某张卡整行缺失=掉卡 |

---

## 五、PCIe Devices（设备在位与身份）

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **PCIe Device Health** | 在位的 GPU/NIC/RAID 卡健康状态（空槽位已过滤） | 任何一行 Not OK = 该卡健康异常。**位置**列就是物理槽位（position），可以直接报修定位 |
| **PCIe Device Inventory** | 每张卡的完整身份：厂商、型号、芯片、固件版本、序列号 | ①**序列号/型号变了**=卡被更换（对账用）；②**固件版本不一致**=同型号卡固件没对齐；③某张卡从清单里消失/新增=卡在位状态变化 |

---

## 六、Storage & Memory（硬盘与内存）

| 面板 | 含义 | 异常判读 |
|---|---|---|
| **Drive Health** | 每块硬盘健康状态（含 RAID 控制器、槽位信息） | 任何一行非 OK = 硬盘故障或预故障。**有 RAID 时一块盘 Warning 系统还能跑，但换盘前不要大意**——RAID 重建期间再坏一块就丢数据 |
| **Drive Capacity** | 每块硬盘容量 | 容量变化=盘被换过；主要用于对账 |
| **Drive Life Left** | 硬盘剩余寿命百分比 | **<10% = 尽快安排更换**；突然从 90%+ 掉到个位数=闪存介质快速劣化 |
| **Memory Modules** | 每条内存（DIMM）健康状态 | 任何一条非 OK = 该 DIMM 报错（多为 ECC 纠错事件超阈值）。**单条 DIMM 报 Warning 时尽快更换**，否则一旦系统切到冗余降级模式性能会掉 |
| **Memory Module Capacity** | 每条内存容量 | 容量不一致或变化=内存被换过/插错槽位 |
| **System Info** | 机器/BIOS/厂商信息 | BIOS 版本变化追踪；换机器时确认序列号 |

---

## 快速巡检顺序

日常巡检按这个顺序看，10 秒能判断整机状态：

1. **Overview 第一行**：全绿 = 整机健康，跳过细节
2. 哪个 stat 不是 0/OK → 去对应区块的表定位具体部件
3. **GPU Power Draw** 扫一眼有没有"一条线平躺"或"一条线起飞"的卡
4. 最后看 **BMC Scrape Success** 确认数据本身是新鲜的（Not OK 时只影响 bmc-oem-exporter 提供的 PCIe/GPU OEM 面板；idrac_exporter 独立抓取的标准面板不受影响）
