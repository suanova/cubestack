# CubeStack 智算云平台

企业级 AI 基础设施控制平面，基于 Kubernetes 统一底座，通过 CRD + Controller 模式向上扩展 AI 能力。聚焦智算资源管理、AI 工作负载编排与智能运维，支持完全私有化部署。

## 核心功能

- **AI 开发环境** — 交互式 GPU 开发实例（SSH / JupyterLab）
- **训练 / 微调** — 单机/多机多卡训练，支持 LoRA / QLoRA / Full Fine-tune
- **推理服务** — 高性能 LLM 推理，兼容 OpenAI API，多引擎支持（vLLM / SGLang / Triton / GPUStack）
- **AI 资产中心** — 模型、数据集、Checkpoint 统一管理
- **虚拟机实例** — 基于 KubeVirt，支持 GPU 直通
- **GPU 资源池** — 多品牌 GPU 统一纳管（NVIDIA / 沐曦 / 壁仞）
- **资源治理** — 租户/项目两级隔离，Kueue 队列调度
- **智能运维** — 全栈可观测性，AI 智能助手（CubePilot）
