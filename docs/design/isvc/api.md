# CubeStack Inference API 设计

本文档通过定义三个 CRD 在 Kubernetes 上部署和维护 LLM 推理服务：

- **InferenceService** (`namespaced`)：用户提交的服务部署请求
- **InferenceRuntimeProfile** (`cluster-scoped`) ：管理员验证过的运行配置组合
- **ModelVersion** (`cluster-scoped`)： 模型版本信息与存储配置

## 1. 架构总览

```
   (admin)                                 (user)
   assets (模板, immutable)        InferenceService (namespaced) 
        │                                        │ 
        ▼                                        ▼ 
   InferenceRuntimeProfile ◄──────┐       ModelVersion ◄─────────────┐
   (cluster-scoped)               │       (cluster-scoped)           │
        └────────────┬────────────┘────────────┘                     │
                     ▼                                               │
            inference-operator   ◄───────────────────────────────────┘
            解析 → 校验 → 渲染 → 创建
                     │
                     ▼
   用户 namespace 内生成的资源（全部带 ownerReference → InferenceService）:
     <isvc>-<role>            工作负载（LWS / Deployment / Service）
     <isvc>-<assets>          ConfigMap
     <isvc>-model-<key>       模型的 PVC

- assets 指模型服务需要的脚本，以 ConfigMap 保存于 cubestack-system namespace
- isvc 为 InferenceService 的缩写，<isvc> 表示 InferenceService 的名称
- role 为在 isvc 中定义的模型服务的工作负载
```


### 1.1 角色分工

| 角色 | 操作对象 | 职责 |
|---|---|---|
| 管理员 | `InferenceRuntimeProfile`、 `ModelVersion`、asset | 定义推理服务并维护模型目录与存储配置 |
| 用户 | `InferenceService` | 通过选择模型和 Profile 部署推理服务 |
| Operator | All | Reconcile 相关资源与维护资源状态 |

**核心原则**：管理员定义**经过验证的**推理服务配置，用户只能在**管理员授权的范围内**调整参数并部署推理服务。

## 2. 校验

校验分三层执行：对象的字段约束、对象的语义约束和引用对象间的存在性与兼容性。

### 2.1 分层

| 层 | 职责 | 工具 |
|---|---|---|
| L0 | 对象的字段约束：字段类型、required、枚举、静态格式与范围 | CRD structural schema |
| L1 | 对象自身语义：跨字段、同对象引用、命名规则、不可变约束 | Validating Admission Policy（VAP） |
| L2 | 引用对象间的存在性与兼容性、override 值、渲染合法性 | Controller + status conditions |

### 2.2 校验失败处理规则

- 发现失败后停止：L2 按渲染管线顺序执行。某一步失败后，Controller 不再创建或更新后续资源。
- 保留当前有效配置：校验或渲染失败的新配置不会写入集群；已存在的工作负载和创建资源保持上一次有效状态。对应的 condition 需要说明失败原因。

## 3. API 设计

### 3.1 ModelVersion

`ModelVersion`（`cluster-scoped`）：模型的唯一注册记录，承载兼容校验所需的模型属性与存储配置。

```yaml
apiVersion: ai.cubestack.io/v1alpha1
kind: ModelVersion
metadata:
  name: deepseek-v4-flash-w8a8-v1
spec:
  model: deepseek-v4-flash
  version: w8a8-v1
  architecture: deepseek_v4
  quantization: w8a8
  meta:
    launcherSpec: deepseek-v4-flash
  storage:
    strategy: HostPath
    hostPath:
      path: /workspace/wnma/model/DeepSeek-V4-Flash-FlexSMQ-AWQ-W8A8
    # Or:
    # strategy: PVC
    # pvc:
    #   storageClassName: juicefs-model-cache
    #   subPath: models/deepseek-v4-flash/w8a8-v1
    #   capacity: 320Gi
```

#### 命名规则与不可变性

| 规则 | 内容 |
|---|---|
| 命名绑定（CREATE） | `.metadata.name == .spec.model + '-' + .spec.version`。|
| `spec` 不可变（UPDATE） | 通过 VAP 强制 `spec` 不可变（`object.spec == oldObject.spec`）。管理员需要变更模型内容时，必须创建新的 `ModelVersion` 对象。`metadata` 不受该规则限制，可继续用于维护 `annotation`、`label` 等可变信息。 |

**同名重建** 

VAP 校验无法防止 DELETE+CREATE 组合操作，平台允许该组合操作，管理员在删除操作前应检查 `ModelVersion` 的状态，（见删除正在使用的 ModelVersion）。

#### 字段

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `model` | string | L0：必填 | 模型语义名称；与 `version` 一起决定 `metadata.name`（见命名规则）。 |
| `version` | string | L0：必填 | 模型版本。模型名称可能包含 `-`（如 `deepseek-v4-flash`），不能可靠地从 `metadata.name` 反向解析，因此必须显式保存在 `spec` 中，避免与对象名重复维护同一信息后出现不一致。 |
| `architecture` | string | L0：必填；L2：作为 InferenceRuntimeProfile `modelRequirements` 兼容校验的输入 | 模型的架构标识，来自 HuggingFace 或内部 `config.json` 中的 `model_type`，例如 `deepseek_v4` / `glm4`。当前在模型注册时记录，未来可由模型导入流程自动提取并填充；同时作为 `model.architecture` 提供给渲染上下文。 |
| `quantization` | string | L0：必填；L2：兼容校验输入 | 模型的权重量化方式，例如 `w8a8`。不同的量化方式可能需要特定的推理引擎和 GPU 才能正常运行，因此参与模型兼容性校验。 |
| `meta` | map | L0：可选 | 管理员维护的自由 map，用于处理厂商 launcher 所需名称与 `architecture` 不一致的情况。若 launcher 直接使用架构名，Profile 模板应直接引用 `{{ model.architecture }}`，避免重复维护同一信息。 |
| `storage.strategy` | enum（`HostPath`\|`PVC`） | L0：必填、枚举；strategy 与对应配置块 oneOf | v1alpha1 支持 `HostPath`（模型已预分发到节点）和 `PVC`（controller 在用户 namespace 中创建 PVC）。|
| `storage.hostPath.path` | string | L0：绝对路径；仅 `strategy: HostPath` 时必填 | 预分发模型根目录；多机 `workload.group.size>1` 时要求组内全部节点已预分发该模型。 |
| `storage.pvc.storageClassName` | string | L0：仅 `strategy: PVC` 时必填 | 引用平台管理员预先创建的 StorageClass。 |
| `storage.pvc.subPath` | string | L0：仅 `strategy: PVC` 时必填 | 共享存储内的模型目录；同一 StorageClass 下按 `<model>/<version>` 组织。 |
| `storage.pvc.capacity` | Quantity (k8s) | L0：仅 `strategy: PVC` 时必填 | 创建 PVC 时写入 `spec.resources.requests.storage`。模型大小是否装得下由平台管理员在注册时保证，controller 不做校验。 |

#### 存储与 PVC 创建规则

当 `storage.strategy: PVC` 时，controller 在 `InferenceService` 所在的 namespace 中创建模型 PVC，并遵循以下规则。

- PVC 名称为 `<isvc>-model-<key>`;
- PVC 设置 `ownerReference` 指向对应的 `InferenceService`;
- PVC 固定使用 `accessModes: [ReadOnlyMany]`；
- `InferenceRuntimeProfile` 中的 `mounts[]` 已规定模型卷必须以 `readOnly: true` 挂载，因此模型 PVC 不支持写入数据；
- 删除 `InferenceService` 时，Kubernetes 会根据 ownerReference 回收该 PVC；
- PVC 的创建和删除仅管理 PVC 对象本身，不影响底层模型数据。

**配置变更与滚动更新**

- 模型存储配置会参与 `template-hash` 的计算，包括 `strategy` 以及对应配置块中的 `capacity`、`subPath` 和 `storageClassName`。
- 当模型存储配置发生变化时，渲染后的工作负载配置也会发生变化，因此按模板变更处理并触发滚动更新；上述滚动更新以 PVC 可原地变更为前提，`storageClassName` 变化、`capacity` 缩小等情形需要整体重建，处理规则见 §5.1。

#### Status

ModelVersion 的 status 主要帮助管理员确认：

- PVC 存储策略引用的 StorageClass 是否可用？
- 当前有哪些服务正在引用该模型版本，是否适合删除或弃用？

```yaml
status:
  usedBy:
  - namespace: project-a
    name: dsv4-flash-pd
  - namespace: project-b
    name: glm52-demo
  conditions:
  - type: StorageResolved
    status: "True"
  - type: InUse
    status: "True"
    reason: ReferencedByServices
    message: "Referenced by 2 InferenceService"
```

| 字段/条件 | 语义 |
|---|---|
| `StorageResolved` | 使用 PVC 时，引用的 `storageClassName` 是否存在。使用 HostPath 时恒为 `True`，因为 Controller 无法在集群范围内确认每个节点上的目录是否存在；相关错误会在服务的 condition 和 Pod 事件中显示。 |
| `usedBy[]` | 正在引用该 ModelVersion 的 InferenceService 列表。条目固定为 `{namespace, name}`，kind 为 `InferenceService`。Controller 会完整重建该列表；将来需要支持其他引用者时，可扩展为 `{group, kind, namespace, name}`。 |
| `InUse` | 是否存在引用该 ModelVersion 的服务。`True` 仅作为删除或弃用前的警告，不阻止删除。 |

#### 删除正在使用的 ModelVersion

在 `v1alpha1` 中不使用 `finalizer` 阻止删除正在被 InferenceService 引用的 ModelVersion。删除 ModelVersion 不会立即修改已经创建的 `LWS`/`Deployment`、`Service`、`ConfigMap` 等资源，因此现有 Pod 可以继续运行。Controller 只会在后续 reconcile 时重新解析 `modelRef`。如果此时引用的 `ModelVersion` 已被删除，`InferenceService` 将显示：`Resolved=False, reason=ModelNotFound` 同时 Controller 不再创建或更新后续资源。

因此，`v1alpha1` 中仅通过 `usedBy` 和 `InUse` 提示对象仍被引用，不阻止删除。管理员删除 `ModelVersion` 前，应根据 `usedBy` 确认没有服务仍依赖该版本。后续版本可以在不改变现有引用语义的前提下，通过 `finalizer` 增加对正在使用的 `ModelVersion` 的删除保护。

#### Controller 行为

Controller 监听 `ModelVersion` 及其引用关系的变化并维护 `ModelVersion` 的 `status`。

### 3.2 InferenceRuntimeProfile

`InferenceRuntimeProfile` (`cluster-scoped`)：经过验证过的引擎、显卡、镜像、启动脚本、拓扑和可配置参数的组合。

```yaml
apiVersion: ai.cubestack.io/v1alpha1
kind: InferenceRuntimeProfile
metadata:
  name: metax-sglang-dsv4-pd
  annotations:
    ai.cubestack.io/description: "MetaX C500 + SGLang PD Disaggregation"
spec:

  accelerator:
    vendor: metax
    models: [MXC500]

  engine:
    name: sglang
    version: vendor-0.5.12-rc1

  modelRequirements:
    architectures: [deepseek_v4]
    quantization: [w8a8]

  vars:
    prefillHca: "mlx5_0,mlx5_1"
    decodeHca: "mlx5_0,mlx5_1"

  assets:
  - name: bootstrap
    configMapRef:
      name: metax-c500-bootstrap-v0.5.12-rc1
    mount:
      path: /opt/cubestack-bootstrap
      mode: 0755
  - name: runtime-config
    configMapRef:
      name: metax-dsv4-runtime-v0.5.12-rc1
    envFrom: true

  overrides:
  - name: prefillReplicas
    type: integer
    min: 1
    max: 8
    default: 1
    description: "prefill LWS array"
  - name: decodeReplicas
    type: integer
    min: 1
    max: 16
    default: 1
    description: "decode LWS array"
  - name: groupSize
    type: integer
    enum: [1, 2, 4]
    default: 1
    description: "prefill/decode group pod counts"

  roles:
  - name: router
    dependsOn: [prefill, decode]   # 启动参数引用这两个 role 的 Service
    workload:
      kind: Deployment             # CPU-only 流量入口，无组概念
      replicas: 1
    podTemplate: {...}
    service:
      ports:
      - name: http          # endpoint.portName 默认引用的端口名
        port: 8001
        targetPort: http
  - name: prefill
    dependsOn: []
    workload:
      kind: LeaderWorkerSet
      replicas: "{{ overrides.prefillReplicas }}"
      group:
        size: "{{ overrides.groupSize }}"
        startupPolicy: LeaderCreated
    podTemplate: {...}
    service: {...}
  - name: decode
    dependsOn: []
    workload:
      kind: LeaderWorkerSet
      replicas: "{{ overrides.decodeReplicas }}"
      group:
        size: "{{ overrides.groupSize }}"
        startupPolicy: LeaderCreated
    podTemplate: {...}
    service: {...}

  endpoint:
    role: router
  readinessPolicy:
    requireAllRoles: true
```

#### 命名规则与不可变性

| 规则 | 内容 |
|---|---|
| 命名（CREATE） | 名称格式为 `<vendor>-<engine>-<profile>`，例如 `metax-sglang-dsv4-pd`。`vendor` 和 `engine` 必须分别与 `spec.accelerator.vendor`、`spec.engine.name` 一致；`profile` 由管理员填写，用于说明模型兼容范围和拓扑，例如 `dsv4-pd`。VAP 校验名称前缀 `<vendor>-<engine>-`。 |
| `spec` 不可变（UPDATE） | 通过 VAP 强制 `InferenceRuntimeProfile` 的 `spec` 不可变。修改运行配置时，管理员需要创建新的 `InferenceRuntimeProfile` 并使用新的名称（例如在名称末尾增加版本标识），再修改 InferenceService 的 `profileRef` 完成迁移。`metadata` 不受该规则限制，可继续用于维护 `annotation`、`label` 等可变信息。 |

**同名重建** 

VAP 校验无法防止 DELETE+CREATE 组合操作，平台允许该组合操作，管理员在删除操作前应检查 `InferenceRuntimeProfile` 的状态（见删除正在使用的 InferenceRuntimeProfile）。

#### 字段

##### accelerator

`accelerator` 中的字段分别用于确定 GPU 资源名称和限制服务可调度的 GPU 型号。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `vendor` | enum | L0：必填、枚举 | GPU 资源名映射，根据厂商映射为 Kubernetes GPU 扩展资源名。例如 `metax` → `metax-tech.com/gpu`，`nvidia` → `nvidia.com/gpu`。Controller 使用该资源名，根据 `gpuPerPod` 为 Pod 设置 GPU `requests` 和 `limits`。                          |
| `models` | list | L0：必填、string 列表 | 限制可调度的 GPU 型号，Controller 根据声明的 GPU 型号自动注入节点选择约束。单个型号使用 `nodeSelector`；多个型号使用 `nodeAffinity` 的 `In` 表达式，因为 `nodeSelector` 无法表示多个型号之间的“或”关系。GPU 型号使用平台约定的节点 label：`ai.cubestack.io/accelerator-model`。 |

**GPU 型号约束的目的**

GPU 扩展资源通常只区分厂商，不区分具体 GPU 型号。例如，在混合部署 C500 和 C550 的 MetaX 集群中，两类 GPU 节点可能都提供：`metax-tech.com/gpu`。如果 `InferenceRuntimeProfile` 仅请求该 GPU 资源，而没有限制 GPU 型号，则一个已经针对 C500 验证的 `InferenceRuntimeProfile` 仍可能被调度到 C550 节点。这可能导致：

- 推理引擎在错误的目标架构上进行 JIT 编译；
- 模型显存配置与实际 GPU 不匹配；
- 服务在启动一段时间后才暴露运行问题。

因此，`accelerator.models` 的作用是将 `InferenceRuntimeProfile` 的兼容性校验范围与实际调度范围保持一致。当 Controller 注入 GPU 型号约束后，如果集群中不存在符合条件的节点，Pod 将保持在 Pending 状态，并通过 Kubernetes 调度事件明确说明节点选择条件不满足，而不会被调度到不兼容的 GPU 型号。

**与 podTemplate.nodeSelector 的组合** 

自动注入的 GPU 型号约束与管理员在 podTemplate 中声明的节点选择条件可以同时存在。两者遵循 Kubernetes 原生的 AND 语义：

- `accelerator.models` 负责限制 GPU 型号；
- 管理员在 `podTemplate.nodeSelector` 中声明其他节点约束，例如机架、机房或其它基础设施属性。

不需要定义额外的字段合并规则。最终只有同时满足所有约束的节点才能被调度。

**与多节点 HostPath 的关系** 

对于使用 HostPath 的模型存储，模型通常需要预先分发到对应的 GPU 节点。当 `accelerator.models` 限制服务只能调度到指定 GPU 型号的节点时，模型预分发的范围也可以按照对应的 GPU 型号节点池进行管理。因此，管理员需要保证：服务允许调度到的 GPU 型号的所有节点，均已完成对应模型的预分发。这样，模型预分发范围与服务的实际调度范围保持一致。

**节点 GPU 型号信息** 

自动注入 GPU 型号约束的前提是，节点上存在可信的 GPU 型号 label：`ai.cubestack.io/accelerator-model` 该 label 可以由 GPU 设备发现机制或平台 Agent 负责写入。具体的事实来源和打标方式需要在实现阶段确认。在 GPU 型号 label 的来源尚未确定之前，Controller 不启用自动注入逻辑。管理员仍可以通过 `podTemplate.nodeSelector` 手动添加等价的节点约束。这不会改变 `accelerator.models` 的字段语义；后续启用自动注入仅属于 Controller 行为的增强，API 字段本身无需调整。

##### modelRequirements

`modelRequirements` 用于声明 `InferenceRuntimeProfile` 支持哪些模型架构和量化方式。Controller 在解析引用阶段校验（`Resolved`）：模型的 `architecture` 必须包含在 `architectures` 中，`quantization` 必须包含在 `quantization` 中。任一条件不满足时，服务会被标记为 `Resolved=False, reason=ModelIncompatible`，不会继续部署。

**为什么按架构限制**

- 不使用精确模型名：`InferenceRuntimeProfile` 的 spec 不可变。如果同一架构的微调版本（例如 `-instruct`）也需要单独创建 `InferenceRuntimeProfile`，维护成本高。
- 不使用宽泛的系列名：例如 `deepseek` 是产品系列名，不能说明技术兼容性。V2、V3、V4 的 `model_type` 分别为 `deepseek_v2`、`deepseek_v3`、`deepseek_v4`，彼此可能不兼容；推理引擎和厂商 launcher 也是按架构提供支持。
- 使用架构名：架构名来自上游 `config.json`，是引擎和 launcher 实际使用的兼容标识。管理员可以通过增减 `architectures` 列表中的项来控制支持范围。

**适用范围**

此校验只避免明显不兼容的模型组合，不保证模型一定能以当前 `InferenceRuntimeProfile` 的资源配置稳定运行。同一架构的不同尺寸模型（例如 flash 与 pro）可能因 `InferenceRuntimeProfile` 固定的 TP、GPU 数量或显存配置不足而发生 OOM。这类情况需要在发布时验证：为新的尺寸模型创建新的 `InferenceRuntimeProfile` 版本，先以 `publish: false` 创建服务进行影子验证，确认就绪后再迁移。因此，`InferenceRuntimeProfile` 仍应按模型尺寸档维护；架构和量化校验负责阻止已知不兼容的模型进入部署流程。

##### assets[]

`assets[]` 定义 `InferenceRuntimeProfile` 使用的 `ConfigMap` 模板。Controller 会读取 `cubestack-system` 中的源 `ConfigMap`，以服务级变量渲染其 data，并在服务所在 `namespace` 创建副本。Pod 使用的是该副本，源 `ConfigMap` 不会被修改。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `name` | string | L0：必填；L1：Profile 内唯一 | 该 asset 在 Profile 内的别名，供 `envFromAssets[]` 等引用。渲染后的 ConfigMap 名称为 `<isvc>-<name>`。 |
| `configMapRef.name` | string | L0：必填 | 源 ConfigMap 的名称。固定从 `cubestack-system` 读取，因此不需要也不允许指定 namespace。版本化命名与 `immutable` 要求见下方约束。 |
| `mount` / `envFrom` | object / bool | L0：二选一（oneOf） | `mount` 指定 `path` 和 `mode`，将副本作为文件挂载；`envFrom: true` 将副本中的键值作为环境变量注入。两种方式都对所有 role 的 Pod 生效。 |

**约束**

- 源 ConfigMap 必须使用版本化名称，例如 `*-v0.5.12-rc1`（L1，VAP 校验引用名称的版本化格式）。
- 源 ConfigMap 必须设置 `immutable: true`（L2，`AssetsResolved` 检查时校验；VAP 无法查看其他对象）。
- ConfigMap 的 data 值可以使用 `{{ }}` 占位符。渲染时只能使用服务级上下文，不能使用 `role.*` 等 role 级变量，确保所有 Pod 得到相同的内容。
- Controller 校验源 ConfigMap 是否存在（L2，`Resolved`）；VAP 校验引用名称是否符合命名规范（L1）。

##### overrides[]

`overrides[]` 用于声明用户可以调整的参数。Profile 定义每个参数的名称、类型和取值范围；用户在 `InferenceService.spec.overrides` 中提供具体值。未提供的参数使用 `default`。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `name` | string | L0：必填；L1：同一 Profile 内唯一 | 参数名称，也是用户在 `spec.overrides` 中使用的 key。 |
| `type` | enum | L0：必填、枚举（`integer` \| `string` \| `boolean`） | 参数类型，决定 override 值的解析方式。 |
| `enum` | list | L0：可选；L1：不能与 `min`、`max` 同时使用 | 可接受的值列表。 |
| `min` / `max` | number | L0：可选；L1：与 `enum` 互斥 | 数值参数的最小值和最大值。 |
| `default` | scalar | L0：可选；L1：设置 `enum` 时 `default` 必须属于 `enum`（VAP 校验）；`type` 符合性与 `min` / `max` 边界在 L2 解析时校验 | 用户未提供该参数时使用的值。 |
| `description` | string | L0：可选 | 向用户说明参数的用途和推荐取值。 |

**使用规则**

用户只能填写 Profile 中已声明的参数。Controller 会拒绝未知参数、类型不匹配的值，以及超出 `enum` 或数值范围的值；校验通过后，解析出的值可通过 `{{ overrides.<name> }}` 在 Profile 模板中引用。

##### roles[] 公共字段

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `name` | string | L0：必填；L1：同一 Profile 内唯一 | role 名，作为引用锚点：`endpoint.role`、`dependsOn` 和模板 `{{ roles.<name>.* }}` 均按名引用；生成的资源名中也包含它（`<isvc>-<role>`）。 |
| `dependsOn` | list | L1：引用的 role 名必须存在；L2：依赖构成 DAG（拓扑排序时检测循环） | role 间的启动依赖，构成 DAG。Controller 按拓扑序创建并做就绪门控（见 §4.3）。 |

##### roles[].podTemplate

`podTemplate` 是平台支持的 Pod 模板子集，不等同于原生 `PodTemplateSpec`。只允许下表中的字段，并提供 `gpuPerPod`、`mounts[]`、`envFromAssets[]` 等平台字段，以避免通过任意 `hostPath`、`initContainer` 或特权配置绕过平台约束。

**模板和运行期变量**

Controller 将此模板按 `workload.kind` 写入对应位置：`LeaderWorkerSet` 写入 `leaderWorkerTemplate.workerTemplate`（`leaderTemplate` 留空，由 LWS 继承该模板），`Deployment` 写入 `spec.template.spec`。因此，LWS 同一组的 leader 和 worker 使用相同的模板。Pod 之间的差异，例如 rank 或 leader 地址，必须使用 kubelet 或运行期注入的变量（如 `$(LWS_WORKER_INDEX)`），不能由 `{{ }}` 模板生成。启动入口不同的引擎（如 Ray head/worker）后续通过 `leaderPatch` 支持。

**渲染规则**

`command`、`args`、`env[].value`、`nodeSelector`、`labels` 和 `annotations` 的字符串值都可以使用 `{{ }}`。可用变量仅限 `model.*`、`service.*`、`overrides.*`、`role.*`、`roles.<name>.*`、`profile.*` 和 `route.*`；使用未知变量时，Controller 将设置 `Rendered=False`。字段名和 map 的 key 必须是字面量，不能使用模板。渲染完成后，Controller 会再次校验结果是否符合 Kubernetes 的格式要求。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `image` / `imagePullPolicy` / `workingDir` | - | — | 与 Kubernetes 含义相同。 |
| `imagePullSecrets[]` | list | — | 与 Kubernetes 含义相同，用于引用私有镜像仓库的拉取凭证。 |
| `command` / `args` | list | — | 支持 `{{ }}` 渲染，也支持运行期的 `$()` 和 `${}` 变量。 |
| `env[]` | list | L0：`value` 与 `fieldRef` 二选一 | `{name, value}` 或 `{name, fieldRef}`。`value` 支持 `{{ }}` 和 `$()`；后者可引用通过 `envFrom` 注入的环境变量。 |
| `envFromAssets[]` | list[asset 别名] | — | 将渲染后的指定 ConfigMap 以 `envFrom` 方式注入 Pod。 |
| `resources` | object | — | `{cpu, memory, gpuPerPod}`。`cpu` 和 `memory` 写入 requests；`gpuPerPod` 按 GPU 厂商映射为扩展资源，并同时写入 requests 和 limits。 |
| `securityContext` | object | — | `{privileged?, runAsUser?, runAsGroup?}`。三个字段可分别设置。 |
| `terminationGracePeriodSeconds` | int | L0：可选，默认 30 | 需要等待连接摘流或 checkpoint 写入时可适当增大。 |
| `mounts[]` | list | L0：`model` 固定 `main`、`readOnly` 固定 `true` | 模型挂载声明：`{model: main, at: <容器内路径>, readOnly: true}`。Profile 指定容器内挂载位置，ModelVersion 指定模型的存储方式。 |
| `volumes[]` | list | L0：仅支持 Kubernetes Volume 的受控子集 | 附加卷，例如 shm `emptyDir` 或 InfiniBand `hostPath`。 |
| `nodeSelector` | map | L0：可选 | 多机使用 HostPath 时，用于限定到已预分发模型的节点池。多个 role 共用的约束可引用 `{{ profile.vars.* }}`。只有管理员明确希望用户决定调度位置时，才应引用 `{{ overrides.* }}`。 |
| `ports[]` | list | — | 容器端口：`{name, containerPort}`。 |
| `probes` | object | L0：仅支持 `httpGet` / `tcpSocket` | `startup`、`readiness`、`liveness` 探针，以及 `path`、`port`、`periodSeconds`、`timeoutSeconds`、`failureThreshold`、`initialDelaySeconds`。大模型启动较慢时，应设置足够大的 `failureThreshold`，例如 180。 |
| `hostNetwork` / `dnsPolicy` | - | L1：启用 `hostNetwork` 时，`dnsPolicy` 必须为 `ClusterFirstWithHostNet` | 与 Kubernetes 含义相同。典型动机是 GPU role 的 RDMA/bootstrap 数据面（如 PD 分离的 prefill/decode，见部署基线）；纯 HTTP 入口 role（如 router）不应使用——其流量经 Service 与网关转发，不依赖节点 IP。启用 `hostNetwork` 时 Controller 自动把 `ports[].containerPort` 回填为 `hostPort`，使调度器能对 host 端口记账；注意固定端口意味着同节点端口独占：绑定相同端口的两个实例（即使属于不同 InferenceService）不能调度到同一节点。 |
| `labels` | map | L0：可选；L1：禁止 `ai.cubestack.io/*` 前缀 | 原样传递给 Pod。可供 NetworkPolicy、admission webhook、Kyverno 或计费系统按标签选择 Pod；若与 Controller 生成的 selector 标签冲突，以 Controller 的值为准。 |
| `annotations` | map | L0：可选 | 原样传递给 Pod。Profile 可在此定义 Prometheus 注解和端口，也可填写外部平台所需的注解。 |

**hostPort 回填的边界**：`hostNetwork` 开启时的自动回填只覆盖显式声明在 `ports[]` 中的端口。引擎在运行期监听但未声明的端口（例如厂商 launcher 隐式使用的 bootstrap/管理端口）不会被调度器记录，同节点仍可能冲突。因此使用 `hostNetwork` 的 Profile 必须把引擎实际监听的端口全部声明在 `ports[]` 中；Controller 无法自动发现遗漏，这属于 Profile 的运维约束。

##### roles[].service

`service` 定义当前 role 的 Kubernetes Service。Controller 为**声明了 `service` 字段**的 role 创建名称为 `<isvc>-<role>` 的普通 Service（Kubernetes 拒绝无端口的 ClusterIP Service，因此未声明 `service`——即没有端口列表——的 role 不生成 Service）；其他 role 可通过 `{{ roles.<name>.serviceName }}` 获取该 Service 名称并访问它。`endpoint.role` 的 L1 规则要求端点 role 必须声明 `service`，因此端点 Service 总是存在。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `ports[]` | list | L0：`{name, port, targetPort}` | Service 端口列表。`targetPort` 可以直接引用 `podTemplate.ports[]` 中定义的容器端口名。 |
| `headless` | bool | L0：可选 | 设为 `true` 时，额外创建无头 Service `<isvc>-<role>-hl>`（`ClusterIP: None`），供需要直接发现各个 Pod 的场景使用。 |

##### roles[].workload

`workload` 定义当前 role 的实例数量和组内拓扑。v1 支持两种 kind：

- `LeaderWorkerSet`：承载模型推理的 role。每个实例组由一个 leader 和若干 worker 组成；`group.size: 1` 表示单 Pod 组。
- `Deployment`：无组概念的辅助 role，如 PD 分离的 router（CPU-only 流量入口，不承载模型、不占 GPU），每个 replica 是独立 Pod。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `kind` | enum | L0：必填、枚举（`LeaderWorkerSet` \| `Deployment`）；L1：`kind` 与子字段的 oneOf（`LeaderWorkerSet` ⇒ `group` 必填；`Deployment` ⇒ 仅允许 `replicas`，出现 `group` 将被拒绝） | 工作负载类型，由 Controller 使用固定映射创建对应资源。`workload` 下可用的子字段由 `kind` 决定。 |
| `replicas` | int \| template | — | `LeaderWorkerSet` 时为实例组数量，`Deployment` 时为 Pod 数量。可使用 `{{ overrides.* }}` 模板，让管理员明确声明的参数控制副本数。 |

**`workload.group`（仅 `kind: LeaderWorkerSet`，必填）**：

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `size` | int \| template | L0：必填 | 每个实例组的 Pod 数量，包含 leader。可使用 `{{ overrides.* }}` 模板；值为 1 时为单 Pod 组。 |
| `startupPolicy` | enum | L0：v1 固定 `LeaderCreated` | 组内启动顺序：`LeaderCreated` 即先创建 leader，再创建 worker。 |

**更新策略**：`LeaderWorkerSet` 固定 `rolloutStrategy: RollingUpdate{maxSurge: 0, maxUnavailable: 1}`（§4.3）；`Deployment` 固定 `strategy: RollingUpdate{maxSurge: 0, maxUnavailable: 1}`——先杀后建、不并发绑定 host 端口，即使 podTemplate 启用 hostNetwork 固定端口也同样安全（前提是 `hostPort` 已声明，见 `podTemplate.hostNetwork` 字段说明）。`replicas = 1` 时两种 kind 的更新都等价于全停重建。更新中断影响见 §5.2。

##### 其他字段

这些字段作用于整个 Profile，而不是单个 role。

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `vars` | map | L0：可选 | 管理员定义的模板常量。可在模板中通过 `{{ profile.vars.<key> }}` 引用，适合存放多个 role 共用的配置。 |
| `endpoint.role` | string | L0：必填；L1：必须存在于 `roles`，且该 role 须定义 `service` | 作为服务对外端点的 role 名称。Controller 以该 role 的 Service 作为内部端点（InferenceService 的 `status.endpoint.internal`）；`publish: true` 时，它同时作为 HTTPRoute 的后端。渲染后 Service 的可解析性由 `EndpointReady` 校验（见 §3.3）。 |
| `endpoint.portName` | string | L0：可选，默认 `http`；L2：渲染后须存在于端点 Service 的端口中（`EndpointReady`） | 对外端点使用的 Service 端口名，与 `endpoint.role` 一起确定 HTTPRoute 的后端端口。 |
| `readinessPolicy.requireAllRoles` | bool | L0：v1alpha1 固定 `true` | 服务就绪条件的聚合方式：所有 role 的工作负载和 Pod 都就绪后，InferenceService 才会标记为 Ready。 |

#### Status

InferenceRuntimeProfile 与 ModelVersion 都是由管理员注册、供 InferenceService 引用的配置对象。它们的 status 主要说明两件事：

- Profile 引用的资源是否仍然可用？
- 当前有哪些服务正在引用该 Profile，是否适合删除或弃用？

```yaml
status:
  usedBy:
  - namespace: project-a
    name: dsv4-flash-pd
  - namespace: project-b
    name: glm52-demo
  conditions:
  - type: AssetsResolved
    status: "True"
  - type: InUse
    status: "True"
    reason: ReferencedByServices
    message: "Referenced by 2 InferenceService"
```

| 字段/条件 | 语义 |
|---|---|
| `AssetsResolved` | Profile 的 asset 引用是否完整。所有 `assets[].configMapRef.name` 都必须存在于 `cubestack-system`；否则为 `False`，reason 为 `AssetNotFound`，包括源 ConfigMap 被错误删除的情况。此 condition 不依赖服务存在，可提前发现问题。服务在渲染时仍会再次校验，避免读取和使用之间源对象被删除。 |
| `usedBy[]` | 正在引用该 Profile 的 InferenceService 列表。Controller 基于 `InferenceService.spec.profileRef` 维护该反向索引。 |
| `InUse` | 是否存在引用该 Profile 的服务。`True` 仅表示警告，不阻止删除；条目格式与 ModelVersion 的 `usedBy` 一致，kind 固定为 `InferenceService`。 |

#### 删除正在使用的 InferenceRuntimeProfile

删除 `InferenceRuntimeProfile` 不会立即修改已经创建的 LWS/Deployment、Service、ConfigMap 等资源，因此现有 Pod 可以继续运行。`InferenceRuntimeProfile` 仅在 Controller 后续 reconcile 时用于解析和渲染配置；此时如果找不到 Profile，服务会显示 `Resolved=False, reason=ProfileNotFound`，且不会继续更新。更重要的是，`InferenceRuntimeProfile` 是升级和回滚的版本引用：删除旧 `InferenceRuntimeProfile` 后，服务在升级失败时无法再切回原来的配置。因此，删除前除了确认 `InUse=False`，还应确认它不再是任何服务的回滚目标。`v1alpha1` 与 `ModelVersion` 一样，只提供警告和运维约束；`finalizer` 留待后续实现。

#### Controller 行为

Controller 监听 `InferenceRuntimeProfile` 及其引用关系的变化并维护 `InferenceRuntimeProfile` 的 `status`。

### 3.3 InferenceService

`InferenceService` (namespaced)：选模型、选套餐、调整授权范围内的参数、决定要不要公开发布。

```yaml
apiVersion: ai.cubestack.io/v1alpha1
kind: InferenceService
metadata:
  name: dsv4-flash-pd
  namespace: project-a
spec:
  modelRef: deepseek-v4-flash-w8a8-v1
  profileRef: metax-sglang-dsv4-pd
  overrides:
    prefillReplicas: 1
    decodeReplicas: 2
    maxModelLen: 131072
  route:
    publish: true
    modelName: dsv4-flash
    timeoutSeconds: 60
```

#### 字段

| 字段 | 类型 | 校验规则 | 说明 |
|---|---|---|---|
| `spec.modelRef` | string | L0：必填、对象名格式；L2：引用存在性与兼容性（`Resolved`） | 引用 ModelVersion。ModelVersion 的 spec 不可变，因此修改此字段就是切换模型版本，用于升级或回滚。 |
| `spec.profileRef` | string | L0：必填、对象名格式；L2：引用存在性（`Resolved`） | 引用 InferenceRuntimeProfile。Profile 的 spec 不可变，因此修改此字段就是切换运行配置版本，用于升级或回滚。 |
| `spec.overrides` | map | L2：key 和 value 对照 Profile 的 `overrides[]` 声明校验（`Rendered`），未知 key 或不合法的值在 reconcile 时被拒绝 | 用户填写的可调参数。 |
| `spec.route.publish` | bool | L0：可选，默认 `false` | 网关公开服务。未发布的服务只提供 ClusterIP 内部端点。 |
| `spec.route.modelName` | string | L0：RFC1123 单 label（`[a-z0-9-]`）；L1：`publish: true` 时必填；L2：已发布服务的全平台唯一性（`RouteReady`） | 对外模型别名，同时用于生成 hostname `<modelName>.<平台域名>`。客户端请求中的 `model` 必须与它相同，否则返回 404；单 label 以确保 hostname 可被平台的单级通配 TLS 证书覆盖。未发布时可省略，省略后引擎使用 ModelVersion 的 `spec.model`；未发布服务使用各自的 ClusterIP，不会相互影响。 |
| `spec.route.timeoutSeconds` | int | L0：可选，范围 1–86400，默认 60 | 网关请求超时，单位秒。 |

#### Status

```yaml
status:
  observedGeneration: 3                    # 已处理到的 InferenceService generation
  profile:
    name: metax-sglang-dsv4-pd  # 解析结果回显
    revision: a1b2c3...         # 最后一次成功应用时的 Profile spec 与 asset 内容综合 hash；同名重建检测的基线
  model:
    name: deepseek-v4-flash
    version: w8a8-v1  # 回显自解析出的 ModelVersion（非用户输入字段）
  conditions:
  - type: Resolved
    status: "True"
  - type: Rendered
    status: "True"
  - type: Provisioned
    status: "True"
  - type: WorkloadsApplied
    status: "True"
  - type: EndpointReady
    status: "True"
  - type: RouteReady
    status: "False"
  - type: Ready
    status: "False"
    reason: RolesNotReady
    message: "decode not ready (0/2)"
  - type: Progressing
    status: "True"
    reason: Reconciling
    message: "Deploying for the first time：decode (1/2)"
  roles:              # 解析后的拓扑，供计费和配额读取
  - name: router
    kind: Deployment
    replicas: 1
    workloadName: dsv4-flash-pd-router
    serviceName: dsv4-flash-pd-router
    readyReplicas: 1
    ready: true
  - name: prefill
    kind: LeaderWorkerSet
    replicas: 1
    groupSize: 1
    workloadName: dsv4-flash-pd-prefill
    serviceName: dsv4-flash-pd-prefill
    readyReplicas: 1
    ready: true
  - name: decode
    kind: LeaderWorkerSet
    replicas: 2
    groupSize: 1
    workloadName: dsv4-flash-pd-decode
    serviceName: dsv4-flash-pd-decode
    readyReplicas: 0
    ready: false
  endpoint:
    internal: "dsv4-flash-pd-router.project-a.svc:8001"
    public: "https://dsv4-flash.maas.example.com"     # 仅 publish=true
  assets:             # 创建来源与内容 hash（审计链）
  - name: runtime-config
    source: metax-dsv4-runtime-v0.5.12-rc1
    hash: sha256:9f2c...
```

**observedGeneration**: 表示 Controller 已处理到的 InferenceService generation；若该值小于 `metadata.generation`，则当前 status 可能仍对应旧 spec。`roles[].replicas` 表示期望实例组数量（Deployment 时为 Pod 数量），`roles[].readyReplicas` 表示当前就绪的实例组数量；`ready` 是该 role 是否已就绪的汇总结果。`groupSize` 仅 `kind: LeaderWorkerSet` 的 role 出现，Deployment 的 role 没有该字段。

下表中 `Resolved`、`Rendered`、`EndpointReady`、`RouteReady` 即 §2.1 中的 L2 校验点；`Provisioned` 和 `WorkloadsApplied` 标记生成步骤（§4.1 步骤 3–4）的应用结果：

| Condition | 检查 | 失败 reason 示例 |
|---|---|---|
| `Resolved` | 引用解析：`profileRef` 指向的 Profile 存在；`modelRef` 指向的 ModelVersion 存在，且模型的 `architecture` 和 `quantization` 都满足 Profile 的要求；所有 asset 源都存在于 `cubestack-system`。三项校验全部执行，任一失败即为 `False`：reason 按上述顺序取第一个失败项，`message` 汇总全部失败。Profile 对象上的 `AssetsResolved` 预检（§3.2）不依赖服务存在，用于提前发现问题；服务解析时仍会再次校验，避免源对象在两次操作之间被删除。 | `ProfileNotFound`、`ModelNotFound`、`ModelIncompatible`、`AssetNotFound` |
| `Rendered` | override 值合法；Phase 1 只使用允许的变量；所有占位符都在允许的变量范围内；引用 `{{ model.path }}` 的 role 已挂载对应模型。 | `UnknownOverride`、`InvalidOverride`、`PhaseViolation`、`UnknownPlaceholder`、`ModelNotMounted` |
| `Provisioned` | 渲染后的 asset ConfigMap 与模型 PVC 已在服务 namespace 中创建成功。仅指对象创建成功；PVC 的绑定与存储供给由存储系统完成，其异常通过 Pod 事件体现。 | `AssetConfigMapFailed`、`PVCCreateFailed` |
| `WorkloadsApplied` | 期望配置已完整写入 Service 与工作负载（LWS/Deployment），即渲染结果已下发到期望版本。只表示配置已应用，不表示就绪：滚动更新期间保持 `True`，Pod 未就绪由 `Ready` 与 `roles[]` 反映。 | `ServiceApplyFailed`、`WorkloadApplyFailed` |
| `EndpointReady` | 无论 `publish` 取值，内部端点都必须实际可访问：`endpoint.role` 渲染后指向存在的 role，该 role 的 Service 中存在名为 `endpoint.portName`（默认 `http`）的端口，且该 Service 至少有一个就绪的后端端点（对应 Pod 已通过就绪探针）。该 condition 决定 `status.endpoint.internal` 是否有效；`RouteReady` 仅在它为 True 后才在网关上创建路由。 | `EndpointRoleNotFound`、`EndpointPortNotFound`、`EndpointNotReady` |
| `RouteReady` | 仅覆盖网关侧的公开路由发布。`publish: true` 时，`modelName` 在发布范围内唯一，且以 `EndpointReady` 解析出的 Service 端口为后端的 HTTPRoute **已生成并被网关接受**（依赖 `EndpointReady=True`；接受 = 路由 `status.parents` 中匹配网关的条目 `Accepted=True` 且 `ResolvedRefs=True`）；`modelName` 与他人冲突时，保留先占用者当前有效的 HTTPRoute，本服务保持 False。等待网关接受期间为 `False`，reason 为 `GatewayNotAccepted`；平台网关未配置或网关 CRD 缺失时降级为 `False`，reason 为 `GatewayNotConfigured`。`publish: false` 时为 `True`，reason 为 `NotPublished`，表示未请求创建公开路由。 | `ModelNameConflict`、`GatewayNotAccepted`、`GatewayNotConfigured`、`EndpointNotReady` |
| `Ready` | 按 `readinessPolicy.requireAllRoles` 聚合。v1 要求所有 role 的工作负载（LWS/Deployment）和 Pod 都就绪。 | `RolesNotReady`（message 包含各 role 的状态） |
| `Progressing` | spec 变更后，Controller 是否仍在应用期望配置。该条件与 `Ready` 独立。 | `True`：`Reconciling`、`Rollout` 或 `Scaling`；`False`：`Converged` |
| `ProfileDeprecated`（警示） | 引用的 Profile 带有 deprecated label（`ai.cubestack.io/deprecated`）。 | 不阻断；提示迁移 |
| `ProfileDrifted`（警示） | `profileRef` 未变，但当前内容 hash 与 `status.profile.revision` 不同，通常由删除后以相同名称重新创建 Profile 引起。 | 不阻断；审计告警 |

**Progressing 与 Ready**：

- `Progressing=True, reason=Reconciling` 表示 Controller 正在首次创建服务所需资源，或正在处理不属于滚动更新和扩缩容的变更，例如生成路由。
- `Progressing=True, reason=Rollout` 表示 Pod 模板变化，工作负载正在滚动更新（LWS 与 Deployment 均为 RollingUpdate，见 §4.3）。
- `Progressing=True, reason=Scaling` 表示只修改副本数，不更新 Pod 模板。
- `Progressing=False, reason=Converged` 表示期望配置已应用完成，但不表示服务一定健康；此时仍可能 `Ready=False`。
- `Ready=True, Progressing=False` 表示服务稳定可用；`Ready=True, Progressing=True` 表示服务在更新中但仍可用；`Ready=False, Progressing=True` 表示服务正在启动；`Ready=False, Progressing=False` 表示配置已应用，但服务尚未就绪。
- 如果渲染失败，新的配置不会写入已创建的资源。此时 `Progressing=False`，`Ready` 继续反映当前部署的实际状态。
- `Rendered` 单独表示配置是否已成功渲染。渲染在一次 reconcile 中同步完成，因此不使用 `Progressing=True, reason=Rendering`。
- 资源创建或工作负载应用的 API 级失败由 `Provisioned` / `WorkloadsApplied` 表示，`Progressing` 的 reason 不承载失败语义。

#### Controller 行为

Controller 监听 `InferenceService` 及其引用关系的变化、解析引用、渲染、创建维护工作负载和聚合各个资源的 status。

### 3.4 RBAC

- `InferenceRuntimeProfile` / `ModelVersion`：平台管理员可写（create/update/delete）；用户可读（get/list）；controller 需要 get/list/watch 和 status 写权限；
- `cubestack-system` namespace 下的 `ConfigMap`：平台管理员可写（create/update/delete）；controller 需要 get/list/watch 和 status 写权限；
- `InferenceService`：用户可在各自 namespace 创建；
- Controller 需要在用户 namespace 下创建 LWS/Deployment/Service/ConfigMap/PVC 的权限。

## 4. 渲染与资源创建

### 4.1 渲染管线总览

```
输入: InferenceService + InferenceRuntimeProfile + ModelVersion + assets（源 ConfigMap）
        │
        ▼
 1) 解析引用        profileRef / modelRef / assets
        │ (Resolved)
        ▼
 2) 渲染            按 profile 声明校验用户值 + 填默认值
                    workload 结构字段 {{ overrides.* }}
                    podTemplate/asset data/endpoint 静态解析
        │ (Rendered)
        ▼
 3) 创建资源        asset ConfigMap / 模型 PVC → 用户 ns（ownerRef → isvc）
         │ (Provisioned)
 4) 创建工作负载     Service + 工作负载（LWS/Deployment）
                    - 按 dependsOn DAG 拓扑序创建；被依赖 role 就绪后才创建依赖 role
                    - template-hash 比较 → 创建 / 滚动更新 / 扩缩容 / 跳过
        │ (WorkloadsApplied)
        ▼
 5) 端点可达性      endpoint.role 的 Service endpoints ≥ 1 ready
        │ (EndpointReady)
        ▼
 6) 路由发布        仅 publish=true 且 EndpointReady=True
                    - modelName 全局唯一性（冲突保留先占用者的路由，本服务 False）
                    - 在网关创建/更新 HTTPRoute，并等待网关接受
                      （status.parents 的 Accepted 与 ResolvedRefs 均为 True）
        │ (RouteReady)
        ▼
 7) 聚合 status     roles[] / endpoint / revision / observedGeneration
        |
      Ready (readinessPolicy)
```

失败语义分两类：

- **生成步骤（1-4）**：任何一步失败，置对应 condition（False + reason），不生成/不更新后续资源。
- **收敛步骤（5–7）**：失败只影响自身 condition（如 `EndpointNotReady`、`ModelNameConflict`），不阻塞其他 role 的 status 聚合，也不回滚已创建的资源。

**路由生命周期**："端点可达后再配路由"仅约束首次创建。HTTPRoute 创建后，其生命周期跟随 Service：即使 `EndpointReady` 后续变为 False（如滚动更新期间 endpoints 抖动），也不删除已创建的 HTTPRoute，由网关健康检查完成摘流；否则滚动期间删除路由会导致 hostname 直接 `404`。

### 4.2 替换规则

| 语法 | 执行者 | 时机 | 适用值 |
|---|---|---|---|
| `{{ ctx }}` | Controller | reconcile 渲染期 | 静态值（模型/路由/服务/解析后拓扑/解析后 overrides） |
| `$(ENV)` | kubelet | Pod 启动期 | 引用已注入 env（含 envFrom 创建的 asset 与 LWS 注入变量） |
| `${ENV}`（bash 内） | shell | 进程启动期 | 脚本文本内的运行期引用 |
| `fieldRef` | kubelet | Pod 启动期 | `status.hostIP` 等 downward API |

如：

```yaml
env:
- {name: NNODES,      value: "{{ role.group.size }}"}    # Controller 替换：role 静态拓扑（仅 LWS role）
- {name: RANK,        value: "$(LWS_WORKER_INDEX)"}      # 运行期：per-Pod 身份
- {name: HOST_IP,     fieldRef: status.hostIP}           # 运行期：downward API
- {name: PD_HCA_LIST, value: "$(PREFILL_HCA_LIST)"}      # 运行期：引用 envFrom asset 注入的 key
```

### 4.3 生成资源规约

| 生成资源 | 命名 | 标签 |
|---|---|---|
| LWS（`kind: LeaderWorkerSet` 的 role） | `<isvc>-<role>` | `ai.cubestack.io/{inference-service, role, profile, managed-by: inference-Controller}` |
| Deployment（`kind: Deployment` 的 role） | `<isvc>-<role>` | 同上 |
| Service（声明 `service` 的 role） | `<isvc>-<role>`（headless：`<isvc>-<role>-hl`） | 同上；无 `service` 声明的 role 不生成 Service（§3.2） |
| 创建 ConfigMap | `<isvc>-<asset>` | + `ai.cubestack.io/asset` |
| 模型 PVC | `<isvc>-model-<key>` | + `ai.cubestack.io/model` |

全部带 ownerReference → InferenceService（GC 与 reconcile 归属）。

#### role 到工作负载字段映射

**LWS (`kind: LeaderWorkerSet`)**

| profile | LWS | 备注 |
|---|---|---|
| `workload.replicas` | `spec.replicas` | 组数 |
| `workload.group.size` | `leaderWorkerTemplate.size` | 组内 Pod 数（含 leader） |
| `workload.group.startupPolicy` | `spec.startupPolicy` | v1alpha1 固定 `LeaderCreated` |
| `podTemplate` | `leaderWorkerTemplate.workerTemplate` | leader 继承（§3.2 同模板） |
| —（固定值） | `restartPolicy: RecreateGroupOnPodRestart` | 引擎进程组语义：组内一进程死全组重建 |
| —（固定值） | `networkConfig.subdomainPolicy: UniquePerReplica` | 稳定主机名（分布式发现） |
| —（固定值，不开放） | `rolloutStrategy: RollingUpdate{maxSurge: 0, maxUnavailable: 1}` | GPU 集群 surge 不现实；replicas=1 时等价 Recreate |
| 调度约束 | `nodeSelector`（podTemplate 手写）与 `accelerator.models` 推导（§3.2）合并 | K8s 原生 AND：nodeSelector 与 nodeAffinity 交集 |

**Deployment(`kind: Deployment`)**

| profile | Deployment | 备注 |
|---|---|---|
| `workload.replicas` | `spec.replicas` | Pod 数 |
| `podTemplate` | `spec.template.spec` | — |
| —（固定值，不开放） | `strategy: RollingUpdate{maxSurge: 0, maxUnavailable: 1}` | 与 LWS 同一策略：先杀后建不产生并发端口绑定；`replicas=1` 时等价 Recreate |
| 调度约束 | 同 LWS 的合并规则 | — |

**Service 映射**：`service.ports[]`（targetPort 可取容器端口名）；`service.headless: true` 额外生成 `<isvc>-<role>-hl`（ClusterIP: None）。Service 名即 `roles.<name>.serviceName` 上下文值，供跨 role 发现：`http://{{ roles.prefill.serviceName }}:30000`。未声明 `service` 的 role 没有 Service，`roles.<name>.serviceName` 指向不存在的对象——引用方应只依赖声明了 `service` 的 role。

**资源映射**：`gpuPerPod` → `accelerator.vendor` 映射的资源名（metax → `metax-tech.com/gpu`，nvidia → `nvidia.com/gpu`）的 requests+limits；`cpu`/`memory` → requests。

**依赖顺序**：`dependsOn` 构成 DAG，创建按拓扑序执行，且采用**就绪门控**——被依赖 role 的工作负载就绪后，才创建依赖它的 role。这样避免依赖方（如 router）在被依赖方尚未可用时启动，空转并产生误导性的失败探针。被依赖 role 未就绪时，依赖 role 不计入 Ready（`requireAllRoles` 聚合）。更新时同样按拓扑序执行：被依赖的 role 先更新，端点 role 最后更新（§5.1）。

### 4.4 asset 创建规则

- Controller 只读取 `cubestack-system` 中版本化且不可变的源 ConfigMap，不会修改它。渲染 data 后，在服务所在 namespace 创建副本 `<isvc>-<asset 别名>`。
- 副本的 ownerReference 指向 InferenceService；annotation 记录源名称和 data hash，并在 `status.assets` 中回显。
- `mount` 类型的副本以 `defaultMode: <mode>` 挂载到声明的路径，对所有 role 生效。
- `envFrom` 类型的副本作为环境变量注入所有 role 的 Pod。
- 如果源 ConfigMap 被删除，Controller 会在下一次 reconcile 时设置 `Resolved=False, reason=AssetNotFound`。

### 4.5 模型挂载组合规则

模型挂载由两个输入组合而成，各管一侧：

| 输入 | 维护者 | 职责 |
|---|---|---|
| `ModelVersion.storage` | 平台管理员 | 模型物理上存在哪里、以什么方式提供：节点本地 HostPath（已预分发）或共享存储 PVC。 |
| `roles[].podTemplate.mounts[]` | Profile 管理员 | 模型在容器内出现的位置（`at`）。推理引擎的 launcher 通常硬编码模型路径，因此 `at` 必须与引擎期望一致——这是引擎契约。 |

v1alpha1 每个服务只有一个主模型：`mounts[].model` 固定为 `main`；多模型（`models.<key>`）已预留（见 TODO）。下文资源与卷名中的 `<key>` 即模型 key，v1 恒为 `main`。

**渲染规则**（按 role）：对 `mounts[]` 的每一项，Controller 生成一个 volume 和一个 volumeMount：

| strategy | 生成的 volume | 生成的 volumeMount |
|---|---|---|
| HostPath | `hostPath{path: storage.hostPath.path, type: Directory}`，卷名 `model-<key>` | `{name: model-<key>, mountPath: at, readOnly: true}` |
| PVC | `persistentVolumeClaim{claimName: <isvc>-model-<key>}`；PVC 由 Controller 在用户 ns 创建（accessModes 固定 `ReadOnlyMany`；`storageClassName`/`capacity` 来自配方；ownerRef → isvc） | 同左，另加 `subPath: storage.pvc.subPath`（共享存储内的模型目录 `<model>/<version>`） |

- `readOnly` 在 v1 固定为 `true`：模型卷只读，不支持通过该 API 写入模型数据（§3.1）。
- 生成的 volume/volumeMount 作用于该 role 的所有 Pod（LWS 的 leader 与 worker 共享同一模板，见 §3.2）。
- 不需要模型的 role（如 PD 分离的 router）不声明 `mounts[]`，也就不会有模型卷。

**`{{ model.path }}`**：按 role 解析，等于该 role 的 `mounts[]` 中 `model: main` 一项的 `at`，供模板引用模型路径而不硬编码。引用 `{{ model.path }}` 但未声明 `model: main` 挂载的 role，Controller 设置 `Rendered=False, reason=ModelNotMounted`。

**多机 HostPath**：`workload.group.size>1` 时，组内所有节点都必须已预分发该模型；`nodeSelector` 和 GPU 型号节点池用于限制可调度节点（与 §3.1 `storage.hostPath.path` 说明一致）。

## 5. 更新与升级

### 5.1 升级方式与更新判断

ModelVersion 与 InferenceRuntimeProfile 的 spec 均不可变（§3.1、§3.2），因此"升级"不是修改对象，而是切换引用：

| 升级动作 | 操作 |
|---|---|
| 模型升级 / 回滚 | 管理员创建新的 ModelVersion（存储策略属于 spec，变更存储也必须新建对象）；用户修改 `spec.modelRef` 指向新版本。 |
| 运行配置升级 / 回滚 | 管理员创建新的 InferenceRuntimeProfile（名称带版本标识，见 §3.2 命名规则）；用户修改 `spec.profileRef` 指向新版本。 |
| 参数调整 | 用户在 Profile 授权的 `overrides[]` 范围内修改 `spec.overrides`；是否触发工作负载更新由 template-hash 判断，见下文。 |

**template-hash**：Controller 每次 reconcile 完整渲染后，为每个 role 的工作负载计算 template-hash，写入 Pod 模板 annotation（`ai.cubestack.io/template-hash` 及分项 hash），据此决定创建、滚动、扩缩容或跳过（§4.1 步骤 4）。hash 的输入包括：

- 渲染后的 Pod 模板（LWS 为 `leaderWorkerTemplate.workerTemplate`，Deployment 为 `spec.template.spec`，含模板的 labels 与 annotations）；
- 创建的 asset 内容 hash——必须参与计算，否则 ConfigMap 更新后不会有任何滚动，故障重建的 Pod 可能使用新脚本但保留旧模板配置；
- 模型存储配置 hash——存储配置变化会使渲染后的工作负载配置随之变化，因此按模板变更处理并触发滚动更新（§3.1）。该项仅对声明了 `mounts[]` 的 role 参与计算：不挂模型的 role（如 router）不因模型存储变化而重启。

已解析 override 不单独参与综合 hash：渲染后的 Pod 模板已内嵌被引用的 override 值（模板变化由 Pod 模板 hash 覆盖），只影响 asset 数据的 override 由 asset 内容 hash 覆盖。因此"仅副本数变化"（如 `workload.replicas` 绑定 `{{ overrides.* }}` 时只改该 override）不会改变综合 hash，按扩缩容处理而非滚动。

比较的是**最终渲染结果**，而非 Profile 字段本身：例如用户值覆盖了被修改的默认值时，渲染结果未变，就不触发滚动，只更新 `status.profile.revision`。存储配置中的容量字段（`storage.pvc.capacity`）是 `resource.Quantity` 类型，参与 hash 前必须先解析并取规范序列化值（如 `1024Mi` 归一化为 `1Gi`），避免语义等量的不同书写被误判为存储配置变更。

按变更类型，Controller 的处理方式如下：

| isvc 变更 | template-hash | 处理方式 |
|---|---|---|
| 仅副本数变化 | 不变 | 只更新各工作负载的 `spec.replicas`，不触发滚动（`Progressing=Scaling`）。 |
| 模板变化（切换 `modelRef` / `profileRef`，或修改影响模板的 override、`route.modelName` 等） | 变化 | 按下文的更新顺序按 role 逐个更新（`Progressing=Rollout`）；涉及 PVC 重建的存储变更除外，见下文。 |
| role / asset 集合变化（切换到拓扑不同的 Profile） | —— | 新增资源按拓扑序创建并做就绪门控（§4.3）；不再期望的旧资源按下文规则清理。 |

**模型存储配置变更与 PVC**：模型存储配置参与 template-hash（§3.1），变更按模板更新处理。但 PVC 的部分字段创建后不可原地修改，滚动更新无法覆盖所有情形，需按下表处理：

| 存储变更 | 处理方式 |
|---|---|
| `subPath` 变化 | 只在 volumeMount 中体现，随 Pod 模板滚动更新，PVC 对象不变。 |
| `capacity` 增大（`storageClassName` 不变） | 原地扩容 PVC 后滚动更新；前提是对应 StorageClass 开启 `allowVolumeExpansion`，否则按下一条重建。 |
| `storageClassName` 变化、`capacity` 缩小 | PVC 无法原地修改，滚动更新也不可行——新 Pod 必须在新 PVC 就绪后才能启动，而旧 PVC 受 `pvc-protection` 保护，在被 Pod 使用期间无法删除。Controller 按整体重建执行：先删除引用该 PVC 的工作负载，待 Pod 释放后删除并重建 PVC，再按新模板重新创建工作负载。重建只管理 PVC 对象本身，不影响共享存储内的模型数据（§3.1）；但服务在重建期间完全不可用，属计划内中断，灰度计划应将其计入（§5.2）。 |
| `HostPath` ↔ `PVC` 互切 | 渲染出的 volume 结构不同，按模板变化滚动；切换到 PVC 时新建 PVC，从 PVC 切出后旧 PVC 按残留资源清理规则保留。 |

**更新顺序**：模板变化时按 role 逐个更新：**被依赖的 role 先更新，端点 role 最后更新**（与创建时的拓扑序一致，见 §4.3）。一个 role 的工作负载更新完成且就绪后，才更新下一个；单个 role 内由该工作负载自身完成更新（LWS 与 Deployment 均为 `RollingUpdate{maxSurge: 0, maxUnavailable: 1}`，固定策略见 §4.3）。

**校验或渲染失败**：新配置不会写入集群，已存在的有效配置保持不变（见 §2.2）。

**残留资源清理**：`profileRef` 切换后，若新旧 Profile 的 role 集合或 asset 集合不同（例如新拓扑去掉了某个 role），不再被期望的旧资源（`<isvc>-<旧 role>` 的工作负载与 Service、`<isvc>-<旧 asset>` ConfigMap）会变成孤儿——ownerRef 仍指向 InferenceService，GC 只在 isvc 删除时生效。Controller 在每次渲染成功后，对比期望资源集与现存的自有资源（ownerRef 指向本 isvc 且带 `managed-by: inference-Controller` 标签），删除多余项；被删除 role 的服务随之立即终止，可用性影响见 §5.2。模型 PVC 不参与清理，保留至 isvc 删除时由 GC 回收。

### 5.2 升级过程中的可用性

本设计的更新不保证零中断；它保证**更新顺序确定、影响可预期**。单个 role 在更新期间是否可用，由该 role 工作负载的固定更新策略（§4.3）与副本数共同决定：

| 工作负载 | 更新策略 | `replicas = 1` | `replicas ≥ 2` |
|---|---|---|---|
| `LeaderWorkerSet` | `RollingUpdate{maxSurge: 0, maxUnavailable: 1}` | 重载模型期间该 role 完全不可用 | 逐组更新：容量降级，但通常不停止服务 |
| `Deployment` | `RollingUpdate{maxSurge: 0, maxUnavailable: 1}` | 完全不可用（等价 Recreate） | 逐个更新：容量降级，但通常不停止服务 |

由此可以预判每种升级路径的服务影响：

- **更新 LWS role**（模型或运行配置升级，如 prefill/decode）：`replicas ≥ 2` 时通常不中断；`replicas = 1` 时是一次计划内中断。PD 场景下整条流水线的可用性取决于冗余最少的 role：prefill 为单副本时，即使 decode 有冗余，prefill 更新期间整条流水线也会停止生成。
- **更新端点 role**（如 PD router）：端点 role 按 §5.1 的顺序最后更新，其更新窗口发生在升级流程的末段。router 为 CPU-only HTTP 入口，流量经 Service 与网关转发，不应使用 hostNetwork（见 §3.2 `podTemplate.hostNetwork`），因此与 LWS 使用相同的滚动策略：`replicas ≥ 2` 时更新不停止服务，`replicas = 1` 时是计划内中断（等价 Recreate）。
- **拓扑变化**（切换到 role 集合不同的 Profile）：被清理的旧 role 立即终止（§5.1）；若它在数据路径上（例如端点 role 更名），服务从旧 role 删除到新 role 就绪之间中断。
- **修改公开名称（`modelName`）**：会产生两类 404。其一，滚动期间网关已使用新 hostname，但旧 Pod 仍使用旧的 `served-model-name`，请求命中旧 Pod 时返回 404，直到全部 Pod 更新完成；其二，hostname 由 `modelName` 生成（§3.3），旧公开地址在新路由生效后立即失效，客户端必须改用新地址与新 model 名。
- **回滚耗时与升级相当**：滚动过程中切回旧版本会再次触发完整滚动。大模型加载通常需要数十分钟，因此灰度计划应把升级和可能回滚的时间都计入中断预算；回滚还要求旧 ModelVersion 与旧 InferenceRuntimeProfile 仍然存在（见 §3.1、§3.2 的删除注意事项）。

**结论**：v1alpha1 可以通过冗余在更新时保留 LWS role 的服务能力——关键 role（尤其是 PD 的 prefill）应配置至少两个副本。但以下情形仍是计划内中断：单副本 role 更新、拓扑变化中被清理的 role，以及需要整体重建的 PVC 存储变更（§5.1）。完整零中断需要 `maxSurge = 1`（更新期间占用双倍 GPU）或服务级蓝绿切流（新旧两套服务并存、由网关按权重切流），两者都需要额外的 GPU 容量或网关能力，不在 v1alpha1 范围内。

## 6. API 演进

### 6.1 变更分类

| 变更 | 兼容性 | 处置 |
|---|---|---|
| 新增可选字段 | 向后兼容 | 同 apiVersion 内合入，存量对象与客户端零动作 |
| 枚举扩值 | 向后兼容（写方仅 Controller/管理员，旧值路径不受影响） | 同增量 |
| 渲染上下文新增命名空间/字段 | 向后兼容，但属 API 契约变更需评审，需遵循 "未知占位符 = 渲染失败" 的封闭性契约 | 同增量 + 评审 |
| condition type / reason 新增 | 向后兼容 | 同增量 |
| 删除/重命名字段、改变字段语义、收紧校验规则（如可选变更为必填） | **breaking** | 新 apiVersion + 并存 served + 迁移公告。注意 K8s 仅在写入时校验（ratcheting）：存量对象不受收紧影响，但"同样的值老对象能跑、新写入被拒"会造成困惑，故归入 breaking |

### 6.2 版本升级

- `v1alpha1` 可随时变更，不保证兼容，但变更须公告；
- 等真实多用户使用稳定后升 `beta`。

## 7. TODO

- [ ] ModelVersion：支持模型溯源，如新增 `source{registry, repo, revision}` 记录来源，revision 可以考虑使用 HuggingFace/ModelScope 的 revision commit ID 。
- [ ] ModelVersion：支持更多的模型存储策略，如 puller sidecar / image volume
- [ ] ModelVersion：PVC 策略支持静态供给的共享文件系统（如 CephFS 静态 PV）。
- [ ] 模型存储配置变更的 PVC 处理（§5.1 表格）：`capacity` 增大的原地扩容（依赖 StorageClass 的 `allowVolumeExpansion`），以及 `storageClassName` 变化 / `capacity` 缩小的整体重建（先删除引用该 PVC 的工作负载 → 待 Pod 释放后删除并重建 PVC → 按新模板重建工作负载）。当前实现仅按模板变更滚动更新工作负载，PVC 对象本身创建后不更新（create-only）。
- [ ] 更新顺序的逐 role 就绪门控（§5.1）：模板变化时一个 role 的工作负载更新完成且就绪后，才更新下一个（需跨 reconcile 状态跟踪）。当前实现按拓扑序单次下发所有变更，不等待就绪。
- [ ] ModelVersion / InferenceRuntimeProfile 的 in-use finalizer：组织对象仍被引用时删除。
- [ ] InferenceRuntimeProfile：增加 leaderPatch：为 leader 和 worker 提供差异化配置，通过受控合并写入 LWS `leaderTemplate`。仅在两者启动入口不同（如 Ray head/worker、MPI launcher）或 leader 资源不同的引擎中使用。
