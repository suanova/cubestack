// UI strings for the platform chrome, localized for en / zh-CN / zh-TW.
//
// zh-CN is the source of truth: its keys define the MessageKey type, and
// TypeScript forces zh-TW and en to cover every key (Dictionary = Record).
// {name} placeholders are interpolated by t(key, params).

import type { Locale } from "./locale";

const zhCN = {
  "app.title": "CubeStack 智算云",
  "app.description": "CubeStack 智算云平台",
  "brand.sub": "智算云平台",
  "nav.section.portal": "平台模块",
  "nav.overview": "平台总览",
  "nav.monitoring": "监控中心",
  "nav.inference": "推理服务",
  "nav.playground": "推理 Playground",
  "nav.devenv": "开发环境",
  "nav.copilot": "智能助手 OpenClaw",
  "nav.aria": "主导航",
  "crumb.portal": "门户",
  "tag.cluster": "集群 · {name}",
  "tag.demo": "演示数据",
  "theme.toLight": "切换浅色模式",
  "theme.toDark": "切换深色模式",
  "theme.toggleTitle": "切换深色 / 浅色",
  "lang.switch": "切换语言",
  "dash.loadError": "加载看板列表失败: {error}",
  "dash.viewError": "加载看板失败: {error}",
  "dash.empty": "暂无看板",
  "dash.desc.cluster": "集群级资源概览：CPU、内存的利用率与配额，以及网络吞吐",
  "dash.desc.node": "按节点查看 Pod 的 CPU、内存用量与 GPU 利用率",
  "dash.desc.metax": "MetaX 加速卡：利用率、温度、功耗与时钟频率",
  "dash.desc.sglang": "SGLang 推理服务：请求延迟、吞吐、排队与缓存命中",
  "dash.desc.dcgm": "NVIDIA GPU（DCGM）：温度、功耗、利用率与显存",
} as const;

export type MessageKey = keyof typeof zhCN;
export type Dictionary = Record<MessageKey, string>;

const zhTW: Dictionary = {
  "app.title": "CubeStack 智算雲",
  "app.description": "CubeStack 智算雲平台",
  "brand.sub": "智算雲平台",
  "nav.section.portal": "平台模組",
  "nav.overview": "平台總覽",
  "nav.monitoring": "監控中心",
  "nav.inference": "推理服務",
  "nav.playground": "推理 Playground",
  "nav.devenv": "開發環境",
  "nav.copilot": "智能助手 OpenClaw",
  "nav.aria": "主導覽",
  "crumb.portal": "門戶",
  "tag.cluster": "集群 · {name}",
  "tag.demo": "演示數據",
  "theme.toLight": "切換淺色模式",
  "theme.toDark": "切換深色模式",
  "theme.toggleTitle": "切換深色 / 淺色",
  "lang.switch": "切換語言",
  "dash.loadError": "載入儀表板清單失敗: {error}",
  "dash.viewError": "載入儀表板失敗: {error}",
  "dash.empty": "暫無看板",
  "dash.desc.cluster": "叢集級資源概覽：CPU、記憶體的使用率與配額，以及網路吞吐",
  "dash.desc.node": "依節點檢視 Pod 的 CPU、記憶體用量與 GPU 使用率",
  "dash.desc.metax": "MetaX 加速卡：使用率、溫度、功耗與時脈頻率",
  "dash.desc.sglang": "SGLang 推論服務：請求延遲、吞吐、佇列與快取命中",
  "dash.desc.dcgm": "NVIDIA GPU（DCGM）：溫度、功耗、使用率與記憶體",
};

const en: Dictionary = {
  "app.title": "CubeStack AI Cloud",
  "app.description": "CubeStack AI Cloud Platform",
  "brand.sub": "AI Cloud Platform",
  "nav.section.portal": "Platform Modules",
  "nav.overview": "Overview",
  "nav.monitoring": "Monitoring",
  "nav.inference": "Inference Services",
  "nav.playground": "Inference Playground",
  "nav.devenv": "Dev Environments",
  "nav.copilot": "AI Assistant OpenClaw",
  "nav.aria": "Main navigation",
  "crumb.portal": "Portal",
  "tag.cluster": "Cluster · {name}",
  "tag.demo": "Demo data",
  "theme.toLight": "Switch to light mode",
  "theme.toDark": "Switch to dark mode",
  "theme.toggleTitle": "Toggle dark / light",
  "lang.switch": "Switch language",
  "dash.loadError": "Failed to load dashboards: {error}",
  "dash.viewError": "Failed to load dashboard: {error}",
  "dash.empty": "No dashboards yet",
  "dash.desc.cluster": "Cluster-wide CPU, memory utilization and quotas, plus network throughput",
  "dash.desc.node": "Per-node Pod CPU, memory usage and GPU utilization",
  "dash.desc.metax": "MetaX accelerator: utilization, temperature, power and clocks",
  "dash.desc.sglang": "SGLang inference: request latency, throughput, queuing and cache hits",
  "dash.desc.dcgm": "NVIDIA GPU (DCGM): temperature, power, utilization and memory",
};

export const dictionaries: Record<Locale, Dictionary> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
};
