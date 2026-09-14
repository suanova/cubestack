// Simulated assistant replies for the 聊天 tab.
//
// The portal has no LLM backend yet, so replies are deterministic,
// scenario-based demo content: keyword matching picks one of the scripted
// answers below, each with the tool calls the "agent" would have run. The
// shapes match the real backend's message history (lib/cubepilot/types.ts) so a
// real agent can replace this module later.

import type { ChatToolCall } from "./types";

export interface AssistantReply {
  text: string;
  tools?: ChatToolCall[];
}

interface Scenario {
  /** Lowercased keywords; a match on any of them selects the scenario. */
  match: RegExp;
  reply: () => AssistantReply;
}

// Scenario order matters: the first match wins. GPU before the generic
// cluster scenario, pods before generic, so specific questions win.
const SCENARIOS: Scenario[] = [
  {
    match: /gpu|显卡|显存|温度|dcgm|风扇|利用率/i,
    reply: () => ({
      tools: [
        {
          name: "kubectl",
          cmd: "kubectl get nodes -l gpu=true -o wide",
          result:
            "NAME                 STATUS   ROLES    GPU POOL       VERSION\ngpu-nvidia-01        Ready    gpu      nvidia-compute   v1.29.4\ngpu-nvidia-02        Ready    gpu      nvidia-compute   v1.29.4\nmetax-infer-01..04   Ready    gpu      metax-inference  v1.29.4",
        },
        {
          name: "dcgm",
          cmd: "dcgm dmon -e 154,155,203 -d 1000 | head -20",
          result:
            "#Device GPU Util% Mem% TempC PowerW\n#GPU     GI  Core% FB%  Temp  Pwr\n   0      0    96   91    87   268  <- gpu-nvidia-02 GPU#3 温度 87°C(阈值 85°C)\n   1      0    74   62    72   214\n   2      0    81   66    75   231",
        },
      ],
      text: [
        "**结论:gpu-nvidia-02 的 GPU#3 温度 87°C,超出 85°C 告警阈值,直接原因是机箱风扇 #2 转速异常,叠加该卡承载的高负载推理副本。**",
        "- 同机其他 3 卡温度 71–78°C,机柜进风 24°C 正常,排除机房制冷问题",
        "- IPMI 自 05:41 起报 Fan#2 lower non-critical,与温升曲线吻合",
        "- 该卡利用率 96%、显存 91%,业务侧无报错,暂无紧急迁移必要",
        "**建议处置**",
        "1. 通过 DCGM 下发功率封顶(180W),预计 10 分钟内降至 80°C 以下",
        "2. 创建风扇更换工单,24 小时内处理",
        "3. 若 30 分钟内温度仍 > 85°C,可让我迁移该卡上的推理副本",
      ].join("\n"),
    }),
  },
  {
    match: /crashloop|crash|pod|重启|o[oO]m|异常/i,
    reply: () => ({
      tools: [
        {
          name: "kubectl",
          cmd: "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded | head -10",
          result:
            "NAMESPACE    NAME                                     READY   STATUS             RESTARTS   AGE\nmonitoring   prometheus-adapter-7d9f-x2k1   0/1     CrashLoopBackOff     3          42m\ndefault     nginx-ingress-5f8c7d9b6-abc   1/1     Running              0          12d",
        },
        {
          name: "kubectl",
          cmd: "kubectl logs -n monitoring prometheus-adapter-7d9f-x2k1 --previous --tail=30",
          result:
            'E0806 05:09:12 main.go:88] configmap "adapter-config" not found, retrying in 5s\nE0806 05:11:31 main.go:88] configmap "adapter-config" not found, retrying in 5s\nF0806 05:12:03 main.go:95] failed to load configuration after 3 retries',
        },
      ],
      text: [
        "**结论:monitoring/prometheus-adapter-7d9f-x2k1 处于 CrashLoopBackOff(近 1 小时重启 3 次),根因是 ConfigMap `adapter-config` 挂载失败,不是应用 bug。**",
        "- 容器启动时反复读取不到 configmap 内配置,3 次重试后退出",
        "- configmap 对象本身存在,怀疑是 volume 挂载时序问题(节点 storage-01 近期有磁盘压力告警)",
        "**建议处置**",
        "1. 删除该 Pod 重建(新调度可避开问题节点):`kubectl delete pod -n monitoring prometheus-adapter-7d9f-x2k1`",
        "2. 若重建后仍 CrashLoop,我可以直接导出容器日志并归档到 ops-archive",
        "3. 是否需要我创建一个「Pod 自动重建」Workflow 事件触发,以后同类问题自动处理?",
      ].join("\n"),
    }),
  },
  {
    match: /推理|inference|模型|扩容|缩容|副本|模型服务|isvc/i,
    reply: () => ({
      tools: [
        {
          name: "kubectl",
          cmd: "kubectl get isvc -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status,REPLICAS:.status.roles[0].replicas",
          result:
            "NS           NAME            READY   REPLICAS\ndefault    glm-5.2-chat    True      2\ndefault    deepseek-v4     True      2\ndefault    qwen2.5-72b     False     2 (扩缩容中: 1 就绪)",
        },
        {
          name: "curl",
          cmd: "curl -s -o /dev/null -w '%{http_code} %{time_total}s' https://ai-gw.cubestack.local/v1/chat/completions -d '{\"model\":\"glm-5.2-chat\"}'",
          result: "200 0.412s",
        },
      ],
      text: [
        "**当前推理服务状态(经 AI Gateway)**",
        "- `glm-5.2-chat` · 2 副本 Ready · P95 412ms",
        "- `deepseek-v4` · 2 副本 Ready · P95 388ms",
        "- `qwen2.5-72b` · 扩缩容中(1/2 就绪),controller 正在拉起第二副本,预计 5–8 分钟完成",
        "**关于扩容**",
        "1. 如需提升 `glm-5.2-chat` 容量,我可以将副本数从 2 调整到 4(需要 2 张空闲 GPU,当前推理池空闲 3 张,足够)",
        "2. 扩容走 InferenceService 的 overrides.replicas,controller 滚动生效,不中断已有请求",
        "3. 需要我现在执行吗?写操作会先经你审批",
      ].join("\n"),
    }),
  },
  {
    match: /开发环境|devenv|jupyter|ssh 环境|开发机|环境/i,
    reply: () => ({
      tools: [
        {
          name: "kubectl",
          cmd: "kubectl get devenv -A -o wide",
          result:
            "NAMESPACE    NAME               TYPE      GPU       STATUS    NODE            AGE\nproject-a    jupyter-nlp-ln      jupyter   2×nvidia  Running   gpu-nvidia-01   5d\nproject-a    ssh-dataset-prep    ssh       1×metax   Stopped   -             3d",
        },
      ],
      text: [
        "**你的开发环境(共 2 个)**",
        "- `project-a/jupyter-nlp-ln` · JupyterLab · 2×nvidia · **Running**(gpu-nvidia-01),JupyterLab 地址与 SSH 密钥经 AI Gateway 鉴权代理访问",
        "- `project-a/ssh-dataset-prep` · SSH · 1×metax · **Stopped**,可随时启动",
        "**可以帮你做的事**",
        "1. 启动/停止/删除任意开发环境(删除前我会确认存储卷保留策略)",
        "2. 新建开发环境:JupyterLab / SSH / VS Code 三种类型,规格 1–16 卡",
        "3. 查询环境连接信息(Token 与你的平台账号绑定,不会泄露)",
      ].join("\n"),
    }),
  },
  {
    match: /证书|tls|ssl|expir|过期/i,
    reply: () => ({
      tools: [
        {
          name: "openssl",
          cmd: "openssl s_client -connect ai-gw.cubestack.local:443 -servername ai-gw.cubestack.local 2>/dev/null | openssl x509 -noout -dates -issuer",
          result:
            "notBefore=May  6 02:00:00 2026 GMT\nnotAfter=Aug 30 02:00:00 2026 GMT\nissuer=C = CN, O = CubeStack, CN = cubestack.local",
        },
      ],
      text: [
        "**网关 TLS 证书:28 天后到期(Aug 30),建议本周内完成轮换。**",
        "- 证书链完整,中间证书由平台内部 CA `cubestack.local` 签发",
        "- 已预置「TLS 证书轮换」Workflow:自动签发新证书 → 更新 Envoy Gateway secret → 验证握手,全程不停机",
        "**建议**:审批该 Workflow 并在周六 02:00 窗口执行。需要我把它转入待审批队列吗?",
      ].join("\n"),
    }),
  },
  {
    match: /巡检|检查|健康|集群状态|概览|状态如何|怎么样/i,
    reply: () => ({
      tools: [
        {
          name: "kubectl",
          cmd: "kubectl get nodes -o wide | head -20 && kubectl get pods -A --no-headers | awk '{print $4}' | sort | uniq -c",
          result:
            "16 nodes · Ready 16 / NotReady 0\n  214 Running\n    3 Pending (qwen2.5-72b 扩容中)\n    0 CrashLoopBackOff",
        },
        {
          name: "ceph",
          cmd: "ceph df && ceph osd df | awk '$4>0.8 {print \"WARN:\", $0}'",
          result:
            "POOL      USED   VAR  MAX AVAIL\ncube-storage  3.1Ti  1.14  42%\nosd-07 used 82% (WARN: 使用率超 80% 观察线, 持续 42 分钟)",
        },
      ],
      text: [
        "**集群巡检结果(06:00 定时策略 daily-6am):24 / 26 项通过,2 项异常**",
        "| 类别 | 结果 |\n| --- | --- |\n| Kubernetes 控制面 | ✅ 4/4 |",
        "- 16 节点全部 Ready,无 CrashLoopBackOff Pod",
        "- 推理服务 11 就绪 · qwen2.5-72b 扩缩容中",
        "**异常项**",
        "1. `gpu-nvidia-02` GPU#3 温度 87°C(阈值 85°C)→ 建议功率封顶,详见 GPU 诊断",
        "2. `osd-07` 使用率 82%,预计 9 天后触及 90% 告警线 → 建议 PG 均衡或扩容 1.8Ti",
        "需要我把这两项转入 RCA 分析,或生成 PDF 巡检报告吗?",
      ].join("\n"),
    }),
  },
];

const DEFAULT_REPLY: AssistantReply = {
  text: [
    "你好,我是 CubeStack 智能助手(CubePilot)。我通过平台统一工具接口访问 Kubernetes / GPU 集群 / 推理服务 / 存储,可以帮你:",
    "- **集群巡检**:节点、Pod、GPU、存储、证书等健康检查",
    "- **故障排查**:GPU 温度、Pod 异常、网络问题的根因分析(RCA)",
    "- **资源操作**:推理服务扩缩容、开发环境启停、日志采集(写操作需你审批)",
    "- **自动化任务**:把巡检/诊断固化成定时 Workflow,在「自动化任务」页管理",
    "试着问我:「集群状态如何」「GPU 温度偏高的原因」「推理服务扩容」,或者直接把告警贴给我。",
  ].join("\n"),
};

/**
 * Pick the scripted reply for a user message. Matching is case-insensitive
 * keyword based; the first matching scenario wins.
 */
export function buildReply(userText: string): AssistantReply {
  const q = userText.toLowerCase();
  for (const s of SCENARIOS) {
    if (s.match.test(q)) return s.reply();
  }
  return DEFAULT_REPLY;
}
