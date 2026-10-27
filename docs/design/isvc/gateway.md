# ISVC 模型目录发布（Agent Router）设计

## 1. 目标与范围

把 ISVC 的公开发布从"每服务一个 hostname 的 HTTPRoute"改为 **Agent Router**（原 Envoy AI Gateway）
的**统一模型目录**：全平台一个入口 hostname，客户端用请求体里的 `model` 选服务。
这是 two-tier 架构里的 **tier2**（自托管推理集群入口）。

**做**:

- `spec.route.aigatewayRouter` 非空的发布形态改为生成 Agent Router 对象（EG `Backend` + 两个
  `AIServiceBackend` + 一个 `ReferenceGrant`），并由 operator 全量维护所选路由的共享
  `AIGatewayRoute` 与共享 `HTTPRoute` 的 `spec.rules`；删除 HTTPRoute 发布路径与 per-model hostname
- `spec.route.paths`（多选）声明本服务在目录上暴露的客户端路径（D2）
- 修复网关超时语义：总时长上限与无进展上限分开（D3）
- `route.modelName` 语义变为"目录模型名"，放宽校验（D7）
- operator 配置面、RBAC、RouteReady 判定、api.md、web 展示同步

**不做**（本次范围外）:

- token 配额 / 限流（QuotaPolicy 需要 ratelimit 执行服务，验证集群尚未部署）
- tier1（外部供应商统一入口、消费方认证）
- EPP / InferencePool 智能端点选择
- per-model hostname 的兼容保留（开发阶段，直接替代；一次性迁移动作见 §4）
- DevEnvironment 的寻址方式（其暴露面是自己声明的 ListenerSet 与 HTTPRoute 路径规则，不由网关域名推导，不受影响）

## 2. 已验证的关键事实

以下事实已在验证集群与 agent-router v1.1.0 文档/CRD schema 逐条查证，
实现时不必再验证：

**Agent Router 侧**

- 安装形态：controller `ai-gateway-controller` v1.1.0（ns `ai-gateway-system`，1 副本）；
  CRD `aigatewayroutes` / `aiservicebackends` / `backendsecuritypolicies` / `gatewayconfigs` /
  `mcproutes`（均 v1beta1）+ `quotapolicies`（v1alpha1）；extensionManager 全量挂钩
  （post Translation/Cluster/Route + includeAll）指向 `ai-gateway-controller.ai-gateway-system.svc:1063`。
- **模型路由机制**：ext_proc 解析请求体提取 `model` → 注入 `x-ai-eg-model` 请求头 →
  rule 用标准 header match 选后端（官方 basic 示例与 EPP 博客同构）。
- **`AIServiceBackend.backendRef` 必须是 EG `Backend` CR**（CEL 强制 `kind=='Backend' &&
  group=='gateway.envoyproxy.io'`；直指 Service 是未来特性 envoyproxy/ai-gateway#902）。
- **`modelNameOverride`**（AIGatewayRoute `rules[].backendRefs[]` 字段）：覆写发往后端的 model 名。
- `AIGatewayRoute` 与 `AIServiceBackend` 的 status 均为**单个 `Accepted/NotAccepted` 条件**。
- rule 级 timeout 两旋钮（CRD 原文）：
  `timeouts.request` = "maximum total time the gateway will wait for the entire response,
  **including all streamed chunks**"（不设时 AI Gateway 默认 60s）；
  `streamIdleTimeout` = "maximum time Envoy will wait **without receiving any bytes** from the
  upstream"（映射到 xDS 的 `retry_policy.per_try_idle_timeout`；首字节前触发可 failover，
  流中途触发断流/504；不设 = 不生效）。
- **ext_proc 的部署形态与翻译位置（实测）**：Agent Router 按需把 `ai-gateway-extproc` 作为 **sidecar
  注入 Gateway 的数据面 Pod**——没有 AIGatewayRoute 时该 Pod 只有 envoy 与 shutdown-manager，出现
  AI 路由后多出第三个容器；`ai-gateway-system` 里只有 controller，没有独立的 extproc 部署。
  协议翻译与 body 解析都跑在这个 sidecar 里；controller 只在 xDS 翻译期（extensionManager `:1063`）
  注入配置。分层：

  ```
  客户端（Host: <catalogHostname>，客户端协议由路径前缀选定，如 /anthropic/v1/messages）
    │
    ▼
  【数据面】envoy-cubestack-system-cubestack-gateway-*（ns envoy-gateway-system）
     ├─ envoy              ← 承载流量、按 header 匹配路由、把 request/response 流交给 ext_proc
     ├─ ai-gateway-extproc ← 协议翻译（OpenAI ↔ Anthropic / Cohere 等，含流式事件）、
     │                        提取 model（x-ai-eg-model）与 usage
     └─ shutdown-manager
    │
    ▼
  上游（vLLM，OpenAI 方言）

  【控制面】ns ai-gateway-system
     └─ ai-gateway-controller ← watch CRD、生成底层 HTTPRoute、经 extensionManager(:1063)
                                注入 ext_proc 与 schema 翻译配置
  ```

- **一个已发布请求的完整路径（实测）**：

  ```
  客户端
    │  POST <协议路径，如 /v1/chat/completions 或 /anthropic/v1/messages>
    │  Host: <catalogHostname>          ← 所有目录模型共用这一个入口
    │  body: {"model": "<目录名>", ...}  ← 目录名 = spec.route.modelName
    ▼
  NodePort ──> Gateway 的 Envoy listener :80
    │  ① Host 匹配：命中 Agent Router 从本服务 AIGatewayRoute 生成的那条 HTTPRoute
    ▼
  ② ext_proc（数据面 Pod 内的 sidecar，gRPC 双向流）
    │   · 按客户端协议解析请求体，提取 model → 注入 x-ai-eg-model 请求头；
    │     客户端协议 ≠ 后端 schema 时在此翻译请求体
    ▼
  ③ Envoy 按 x-ai-eg-model 匹配路由规则 → 选中该服务的 cluster
    │   · cluster 由 AIServiceBackend → EG Backend 的 FQDN 得出：
    │     <isvc>-<role>.<ns>.svc.cluster.local:<port>
    │   · modelNameOverride：把请求体里的目录名改写成引擎 served name
    ▼
  ④ 上游：Service <isvc>-<role> → Pod（vLLM）
    │   · timeoutSeconds → 总时长上限（默认 0 = 不设）；idleTimeoutSeconds → 无进展上限（默认 300s）
    │   · 控制台不再提供这两个输入，创建时使用 CRD 默认值
    ▼
  ⑤ ext_proc（响应阶段）
    │   · 解析响应体提取 usage（流式需客户端带 stream_options.include_usage）
    │   · 需要时把响应与流式事件翻译回客户端协议（如 Anthropic SSE）
    │   · usage → token 限流/记账：执行链尚未部署，为后续增量
    ▼
  客户端收到响应（协议形状与其请求一致）
  ```

- **客户端协议与后端 schema 是两件事（实测）**：客户端协议由 controller 的
  `--endpointPrefixes=openai:,cohere:/cohere,anthropic:/anthropic` 决定——同一个目录 host 下
  `/v1/chat/completions`、`/v1/responses`、`/anthropic/v1/messages`（含流式 SSE）都可用；
  `AIServiceBackend.schema` 声明的是**上游方言**（vLLM = OpenAI），网关在两者之间做双向翻译。
  任何协议下请求体的 `model` 都必须是目录名，否则 404。
- 配额执行链未部署（`--quotaRateLimitServiceAddr` 指向的 `envoy-ai-gateway-ratelimit` Service 不存在）。

**平台侧（现状与实测）**

- operator 现按 `--gateway-name=cubestack-gateway --gateway-namespace=cubestack-system` 运行（helm values
  `gateway.name` + chart 默认）；目录入口 hostname 无现成配置，由本次新增的 flag 传入（D5），旧的
  `--gateway-domain` 一并删除（无消费者，见 D1）。
  > 后记（chart 不再创建 Gateway）：`--gateway-namespace` 改为渲染 `gateway.namespace`，默认
  > `envoy-gateway-system`（平台装 Envoy Gateway 的命名空间）；`gateway.className` 随 Gateway
  > 模板一并删除。上文的 `cubestack-system` 是当时验证集群的取值。
- 网关 `cubestack-gateway`：Envoy Gateway v1.9.1；仅 HTTP:80 listener（NodePort 30365）；
  `allowedRoutes.namespaces.from: All`（ISVC 跨 namespace 附着 Gateway 已有先例）。
- **超时实测（现网 HTTPRoute 的 60s request timeout）**：非流式 6000 token →
  **60.0s 收到 504 `upstream request timeout`**；流式 15000 token → **61.0s 静默截断**
  （curl exit 18、无 `[DONE]`、无 `finish_reason`）。→ 现契约在砍正常的长生成，本次一并修复。
- **bufferLimit 实测**：无 CTP 时普通 HTTPRoute 的 36KB / 90KB prompt 均 200（流式转发不整体
  缓冲请求体）；32KiB 上限咬的是必须有过滤器攒整个 body 的 AI 路由（ext_proc 解析 model）→
  CTP 是 AI 路由的部署前提（D8）。
- ClientTrafficPolicy 默认值（读自装好的 CRD）：`connection.bufferLimit` 32768 字节；
  `http2.initialStreamWindowSize` 64KiB / `initialConnectionWindowSize` 1MiB。

## 3. 架构决策

### D1 发布契约：目录替代 per-model hostname

- `spec.route.aigatewayRouter` 非空时语义为**发布到平台模型目录**。客户端寻址：统一入口 hostname +
  请求体 `model` 选模型；`Host` 恒定，模型名是参数。
- **目录是平台预装、operator 全量维护的一对共享对象**（均在 `--gateway-namespace`）：
  `AIGatewayRoute` `cubestack-ai-gateway` / `cubestack-ai-gateway-private`（承接全部四个目录路径）。
  ISVC 用 `spec.route.aigatewayRouter` 选择其一；operator 每次 reconcile 都用**全部已发布 ISVC**
  重建这条对象的 `spec.rules` ——**整体接管**：缺失时创建，存在时覆写（含手工加进去的 rule），
  不追加、不局部修改。不再各自创建 per-service 的 AIGatewayRoute。
- **不再有普通 `HTTPRoute`**：`cubestack-openai-paths[-private]` 已退役。它的路径分流（按 path 直连
  `Backend`）与 listener 级全量缓冲都会绕过 Agent Router，也无法与 `/v1/messages` 共存于同一
  `AIGatewayRoute` rule（rule 只有 header 一种匹配维度）。现在全部路径都走 `AIGatewayRoute`，
  命中同一个 OpenAI-schema backend，由 ext_proc 读请求体 `model` 注入 `x-ai-eg-model`。
- `spec.route.paths` = 本服务在目录上暴露的路径（多选，CRD 枚举四个值）；未设置 = 全部路径，
  显式空列表 = 不暴露任何路径。暴露任一非空路径就生成一条 rule（rule 不区分路径）。
- `route.modelName` = **目录里的模型名**（客户端 `model` 字段要填的值），在**所选路由内**唯一（D4）。
- 删除：per-model hostname `<modelName>.<gatewayDomain>`、`publicHostname()`、HTTPRoute 生成路径，以及
  `--gateway-domain` flag —— 它没有别的消费者：DevEnvironment 的暴露面是自己的 ListenerSet 与
  HTTPRoute 路径规则，不由网关域名推导。
- `aigatewayRouter` 为空（或 `spec.route` 不存在）语义不变（未发布，仅 ClusterIP 内部端点）。

### D2 生成对象（每个 published ISVC 四个，均在 ISVC namespace）+ 共享对象里的 rule

```yaml
# 名称 <isvc>-endpoint；endpoints 用 FQDN 指向 endpoint role 的 Service（同 EG 官方示例）
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
spec:
  endpoints:
    - fqdn: {hostname: <isvc>-<role>.<ns>.svc.cluster.local, port: <port>}
---
# 名称 <isvc>-backend
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
spec:
  schema: {name: OpenAI}
  backendRef: {group: gateway.envoyproxy.io, kind: Backend, name: <isvc>-endpoint}
---
# 名称 <isvc>-anthropic：同一个 Backend，Anthropic 方言（/v1/messages 用）
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
spec:
  schema: {name: Anthropic}
  backendRef: {group: gateway.envoyproxy.io, kind: Backend, name: <isvc>-endpoint}
---
# 名称 <isvc>-grant：授权两条跨 namespace 引用 —— 共享 AIGatewayRoute 引用本服务的两个
# AIServiceBackend，以及 Agent Router 由该路由展开出的子 HTTPRoute 引用本服务的 Backend
apiVersion: gateway.networking.k8s.io/v1
kind: ReferenceGrant
spec:
  from:
    - {group: aigateway.envoyproxy.io, kind: AIGatewayRoute, namespace: <gateway.namespace>}
    - {group: gateway.networking.k8s.io, kind: HTTPRoute, namespace: <gateway.namespace>}
  to:
    - {group: aigateway.envoyproxy.io, kind: AIServiceBackend, name: <isvc>-backend}
    - {group: aigateway.envoyproxy.io, kind: AIServiceBackend, name: <isvc>-anthropic}
    - {group: gateway.envoyproxy.io, kind: Backend, name: <isvc>-endpoint}
```

- **schema 是 AIServiceBackend 级别**，所以 Anthropic 出口必须每模型一个，不能与 OpenAI 共用；
  两者指向同一个 `Backend`。
- `HTTPRoute → EG Backend` 这一跳必须由**本服务自己的** grant 授权，不能再假设平台装了
  全量 grant：Agent Router 把 AIGatewayRoute 展开成子 HTTPRoute 时，backendRef 指向本 ns 的
  `Backend`，缺授权时路由 Accepted 但 `ResolvedRefs=False/RefNotPermitted`，请求全部 500。
  `to` 带 `name` 所以只授权本服务的 Backend，不会连带授权别的服务。

**共享路由里的 rule**（operator 全量重建，见 D1）：

```yaml
# AIGatewayRoute <可选路由> 的 spec.rules[]：每个暴露任一目录路径的模型两条，
# 顺序固定 —— 先 Anthropic 原生，再 OpenAI 兜底。
- matches:                          # ① 原生 Anthropic：SDK 必带 anthropic-version
    - headers:
        - {type: Exact, name: x-ai-eg-model, value: <route.modelName>}
        - {type: Exact, name: anthropic-version, value: 2023-06-01}
  backendRefs:
    - name: <isvc>-anthropic         # Anthropic schema：/v1/messages 一族原样透传
      namespace: <isvc.ns>
      modelNameOverride: <status.model.name>
      weight: 1
      priority: 0
  timeouts: {request: <timeoutSeconds>s}
  streamIdleTimeout: <idleTimeoutSeconds>s   # 默认 0s = 不掐断
  modelsOwnedBy: CubeStack
- matches:                          # ② OpenAI：其余全部路径
    - headers: [{type: Exact, name: x-ai-eg-model, value: <route.modelName>}]
  backendRefs:
    - name: <isvc>-backend           # OpenAI schema：chat/completions、completions、
      namespace: <isvc.ns>           # responses、images 透传，/v1/messages 走翻译
      modelNameOverride: <status.model.name>
      weight: 1
      priority: 0
  timeouts: {request: <timeoutSeconds>s}
  streamIdleTimeout: <idleTimeoutSeconds>s
  modelsOwnedBy: CubeStack
```

- **客户端不发 `x-ai-eg-model`**：header 由 Agent Router 的 ext_proc 从请求体 `model` 注入，这也是
  `AIGatewayRoute` rule 能当目录用的前提。
- **两条 rule 的区分维度只能是 header**（rule 无 path 维度，生成的 HTTPRoute 恒为 `PathPrefix /`）。
  因此原生 Anthropic 那条用 SDK 必带的 `anthropic-version: 2023-06-01` 作为额外匹配条件：Envoy 按
  顺序取第一条命中，所以它必须排在同模型的 OpenAI rule 之前。客户端无需改任何东西 —— 用 Anthropic
  SDK 就自动走原生后端，用 OpenAI SDK 就自动走 OpenAI 后端。
- **`/v1/messages` 两条路都通**：带 `anthropic-version` 的走 `<isvc>-anthropic`（Anthropic 原生，
  保留 thinking / cache_control 等 OpenAI schema 会丢的字段）；不带该头（裸 curl、或未来版本的
  `anthropic-version`）回落 OpenAI rule，由 ext_proc 做 Anthropic→OpenAI 翻译。
- **`modelNameOverride` = `status.model.name`**（引擎 served name；profile 契约
  `--served-model-name "{{ model.name }}"`）。作用：目录名与引擎名解耦——同一模型的不同版本
  （fp16 / w8a8）都能以各自的目录名共存，客户端始终用目录名。
- **rule 定位键** = `backendRefs[0].(namespace, name)`：`<isvc>-anthropic` 或 `<isvc>-backend`，
  与 rule 顺序无关。
- **跨 namespace 引用**：两条 rule 都指向 `<isvc.ns>` 的 AIServiceBackend，需要 `<isvc>-grant`。
- 已知副作用：`/v1/models` 由 controller 遍历 rule 生成，同模型出现两次（上表的 ① 也会被计入）。
  `ExcludeFromModelsEndpoint` 字段 v1.2.0 才有，Go 依赖仍钉 v1.1.0 —— 升依赖后给 ① 置 true 即可消除。
- 四个对象均 `SetControllerReference(isvc)`，标签沿用 `inferenceServiceLabelKey/profileLabelKey/
  managedByLabelKey`；端口复用现有 `endpointPort(endpoint.Internal)` 解析。共享对象不归某个
  ISVC 所有（owner 是平台），故用 **finalizer**（`isvc-catalog-finalizer`）在删除时触发一次
  全量重建——本服务的 rule 随重建消失；四个 owned 对象随 ownerRef 级联。
- **历史对象清理**：无论是否设置 `aigatewayRouter`，若存在 owner 为本 ISVC 的 HTTPRoute
  `<isvc>-route`（旧原语产物），删除之（复用现有 delete-owned-route 分支；所有集群迁完后可删该分支）。
- **切换路由**：`aigatewayRouter` 从 public 改为 private（或反向）时，所选路由（对）按全量规则
  重建，另一条（对）也同步重建——它已不再包含本服务。两次写不是原子的，极端情况下会短暂同时
  存在，reconcile 幂等收敛。取消发布、删除与 finalizer 同样对两条（对）路由做全量重建。

### D3 timeout 语义（本次修复）

- `route.timeoutSeconds` → `rules[].timeouts.request`（**总时长上限**），
  **默认从 60 改为 0 = 不设上限**。
- **新增 `route.idleTimeoutSeconds`** → `rules[].streamIdleTimeout`（**无进展上限**），**默认 0 = 不设上限**。
- 语义文档必须写明：非流式请求在生成期间**零字节**，idle 计时同样在跑——idle 实际决定
  "非流式生成最长能多久"（默认 300s）；要更久就调大。流式则只要有字节流动就不受 idle 约束，
  受 request（默认不设）约束。
- Phase 0 验证 `request: 0s` 是否真 disable（Gateway API 语义为 SHOULD；不生效则 fallback 用大值，
  e.g. 86400）与 idle 在无 retry 场景是否生效；结论回写本节。

### D4 唯一性、接受判定与降级

- **唯一性**：重建共享规则集时按创建时间（再按 namespace/name）排序，取
  `route.modelName` 与每个服务比对；同名时**先占用者保留**，后来的服务在两条共享对象里都没有
  自己的 rule，`RouteReady=False, reason=ModelNameConflict`。public 与 private 各自独立，
  同一目录名可同时存在于两条路由。
- **容量上限**（两条共享对象各自有 CRD 上限，operator 在重建时逐个服务累加，放不下就整组跳过）：
  - `AIGatewayRoute.spec.rules` 上限 15 条，每模型 2 条（原生 Anthropic + OpenAI），
    即最多 7 个模型；放不下时整组（2 条一起）跳过，不留半条；
  - 共享 `HTTPRoute` 由 controller 从 `AIGatewayRoute` 生成，operator 不再单独占额度。
  当前服务因任一条放不下 → `RouteReady=False, reason=CatalogFull`。规模约束见 Q1。
- **接受判定**：`RouteReady` 要求 **所选共享 `AIGatewayRoute` `Accepted=True`**、**本服务的
  `<isvc>-backend` 与 `<isvc>-anthropic` 两个 `AIServiceBackend` 均 `Accepted=True`**，且本服务的
  rule 仍在路由里（缺一 → `GatewayNotAccepted`）。所有路径（含 `/v1/messages`）都走
  `AIGatewayRoute`，不再校验共享 `HTTPRoute` 的 `parents[]`。共享对象只有 route 级条件，
  per-service 粒度落在 AIServiceBackend 上，Agent Router 亦逐对象接受它；
  `EndpointReady` 前置不变（rule 生命周期仍跟随 Service：endpoint 抖动不删 rule，清空
  `aigatewayRouter` 才删）。
- **降级**：
  - 启动探测 aigateway CRD（同 `ServiceMonitorAvailable` 模式，探测一次）。缺失时发布请求 →
    `RouteReady=False, reason=AgentRouterUnavailable`（新 reason），其余条件与工作负载不受影响。
  - 共享对象缺失且没有规则可写 → 不创建空对象（`RouteReady` 停在 `GatewayNotAccepted`，
    等平台或下一个发布的服务补上）。private 与 public 对称，没有额外前置条件。
  - **平台 Gateway 未配置**（`--gateway-name` 为空）→ `RouteReady=False,
    reason=GatewayNotConfigured`（沿用）。
- `catalogHostname` 不再是发布门：它只决定 `status.endpoint.public` 是否展示（D6），空 = 不展示，
  不影响 `RouteReady`。

### D5 配置面

- 目标路由由 CRD 枚举固定：`spec.route.aigatewayRouter` ∈ {`cubestack-ai-gateway`,
  `cubestack-ai-gateway-private`}，两条共享路由与两条共享 HTTPRoute 都落在 `--gateway-namespace`；
  operator 缺失时补建（无规则可写时不建空对象）。operator 不再有选择路由的 flag。
- `--gateway-catalog-hostname`（`gateway.catalogHostname`）降级为**展示项**：只决定
  `status.endpoint.public` 是否展示，空 = 不展示；不再门控发布。
- 验证集群取值：两条共享路由都在 `envoy-gateway-system`、`catalogHostname=ai.cubestack.dev`。

### D6 status 与 web

- `status.endpoint.public = https://<catalogHostname>`（共享入口；不加新字段，模型名在
  `spec.route.modelName`）；`endpoint.internal` 不变。
- web 端：InferenceService 详情展示目录入口 + 目录模型名（现有 `publicEndpoint` 字段沿用，
  展示行补模型名）。

### D7 VAP 调整

- `modelName`：不再是 hostname 段，放宽为 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`
  （首字符字母数字，允许 `.` `_` `/` `-`，长度 ≤128）。删掉"单 label 以确保单级通配 TLS 覆盖"的约束理由。
- `timeoutSeconds`：范围 0–86400（0 = 不设上限）。
- `idleTimeoutSeconds`：新增，范围 1–86400，默认 300。
- `paths`：新增，`MaxItems=4`、`listType=set`，枚举四个客户端路径；未设置 = 全部，空列表 = 不暴露。

### D8 平台 prerequisite（不进 operator）

- **CTP 一条**（挂平台 Gateway）：`connection.bufferLimit: 50Mi` +
  `http2` 窗口恢复 Envoy 原生值（16Mi/24Mi）。Phase 0 手工 apply。
  > 后记（chart 不再创建 Gateway）：CTP 归平台，与 Gateway 同生命周期，不再随 chart 发布——
  > chart 与 kustomize base 都不再创建 Gateway/CTP，只渲染指向它们的 flag。参考形态见
  > chart README 的 Prerequisites 与 `operator/test/e2e/assets/gateway.yaml`。
- agent-router 的升级/监控与 envoy-gateway 同级对待（xDS 翻译硬依赖其 controller）。
- ratelimit 服务与 QuotaPolicy：非本次范围。

### D9 operator 依赖、RBAC 与测试夹具

- go.mod 新增两个依赖：aigateway API（v1beta1，模块路径以 v1.1.0 为准）+ envoy gateway API
  （EG `Backend` 类型，以 EG v1.9.1 对应版本为准）。
- RBAC（`make manifests` 从 kubebuilder 注释生成，helm chart 同步）：
  - `aigatewayroutes`：`get/list/watch/create/update/patch`（**无 delete**——共享路由缺失时 operator
    会补建，但从不删除它们）。
  - `httproutes`、`aiservicebackends`、`backends`、`referencegrants`
    （gateway.networking.k8s.io）：`get/list/watch/create/update/patch/delete`。
- envtest 夹具两组 CRD（aigateway v1beta1、gateway.envoyproxy.io）+ ReferenceGrant CRD（gateway-api
  自带）；**同时保留 CRD 缺失的降级路径测试**。
- `route_test.go` 覆盖：四对象 + 两类 rule 渲染、共享对象缺失时创建、rule 满（`CatalogFull`，
  AIGatewayRoute 15 条与 HTTPRoute 16 条两种上限）、modelName 冲突、按 `spec.route.paths`
  只生成选中路径、接受判定（共享 AIGatewayRoute + `<isvc>-anthropic` + 共享 HTTPRoute parents）、
  全量重建不动他人 rule、无漂移、清空 `aigatewayRouter` 删四对象 + 两条（对）路由都不留 rule、
  public/private 选择与切换、finalizer 删除后重建、CRD 缺失降级。

## 4. 实施顺序

1. **Phase 0（手工验证，动代码之前）**：对 `qwen38-27b-s3` 手工建三对象 + CTP，验证：
   目录式 chat 流式/非流式、大 prompt、override 行为、controller 停机 fail 模式、`/v1/models`、
   usage 元数据、多路由共享 hostname 合并、ext_proc 部署形态、timeout 各语义。产出：
   `request: 0s` 与 idle 语义结论、共享 hostname 是否可行的结论（**若多路由共享 hostname 不可行，
   fallback 为单例 catalog AIGatewayRoute**，需回来改 D2）。
2. **Phase 1（operator 实现）**：按 D1–D9 改代码（TDD）。
3. **Phase 2（平台收尾）**：验证集群切新路径并删除旧 HTTPRoute（一次性迁移动作）；
   CTP 落地；api.md §3.3/§3.4 更新；web 展示调整。

## 5. 交付物清单

- operator：四个 owned 对象（Backend / 两个 AIServiceBackend / 一个 ReferenceGrant）+ 两条（对）
  共享对象的 rule 全量重建（乐观并发 + 无变化不写）+ 渲染/判定/降级逻辑（route.go 重写）、
  finalizer、RBAC、envtest CRD 夹具、单测
- helm chart：`gateway.catalogHostname`（降级为展示）value + RBAC 规则（路由名来自 spec，不再有 value）
- `docs/design/isvc/api.md` §3.3（route 字段表、RouteReady 语义与新增 reason、status 示例）与 §3.4（RBAC）更新
- web：InferenceService 详情展示目录入口 + 模型名
- 平台侧：CTP 清单（运维 SOP；Phase 0 手工 apply 的记录）

## 6. 验收标准

1. 验证集群：切新路径后 `POST http://<nodeport>/v1/chat/completions`（`Host: ai.cubestack.dev`，
   body `model` = 目录名）200；请求不再依赖 `<modelName>.<domain>`。
2. **长生成修复**：>60s 的流式生成完整结束（有 `[DONE]` 与 `finish_reason`）；非流式长生成在
   idle 预算内不再 504。
3. 冲突：两个 ISVC 用同一 `modelName` → 后者 `RouteReady=False, reason=ModelNameConflict`，
   先占用者不受影响。
4. 降级：无 agent-router CRD 的集群（kind e2e）`RouteReady=False, reason=AgentRouterUnavailable`，
   其余条件与工作负载正常。
   共享对象被手工删掉后，下一次 reconcile 用全部已发布服务重建；
   已发布服务删除后两条共享对象里都不留残留 rule（finalizer 生效）。
5. 大 prompt（≥50KB）经 CTP 通过 AI 路由。
6. `make test` / `make lint` 绿；kind e2e 不回归。

## 7. 后续（非本次）

- QuotaPolicy / token 限流（部署 ratelimit 服务后）
- tier1（外部供应商、消费方认证、全局限流）
- EPP / InferencePool 智能端点选择（多副本 PD 场景）
- 非 OpenAI 后端 schema 翻译（AIServiceBackend schema 已预留）
