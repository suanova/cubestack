# Examples

Each directory is one self-contained example: a notebook to upload into a CubeStack
DevEnvironment, plus everything it needs to run.

| Directory | Notebook | Needs | Leaves behind |
| --- | --- | --- | --- |
| `environment-checks/` | `metax-environment-check.ipynb`, `nvidia-environment-check.ipynb` | one accelerator (MetaX C550 or any CUDA GPU) | nothing — verifies the runtime |
| `tiny-gpt-training/` | `tiny-gpt-training.ipynb` | one GPU, about ten minutes | a GPT-2 checkpoint directory in `~/runs/<id>/serving/` |
| `lora-finetuning/` | `lora-finetuning.ipynb` | one GPU, about ten minutes | a merged Hugging Face model directory in `~/runs/<id>/serving/` |

## What a notebook ends with

Both training examples end at the model: the export section writes a standard Hugging
Face directory to `~/runs/<id>/serving/` and reloads it with the stock library classes.
That directory is the deliverable, and the only thing an inference engine needs.

Serving it is not a notebook step. The directory has to be moved into the platform's
model storage, registered as a `ModelVersion`, and run as an `InferenceService`, so
that half of the story is a platform operation and lives in the walkthrough rather
than in a cell.

The platform objects in between are cluster-scoped: an `InferenceRuntimeProfile` (how
to run an engine on this hardware, reused across models) and a `ModelVersion` (where
one artifact lives). The `InferenceService` itself is created from the console:
**Inference Services → Deploy Model**.

## Serving a model

### 1. Copy the artifact into model storage

`ModelVersion` uses `HostPath` storage, pointing at a shared directory on the node,
under `/mnt/cephfs/models/`. The two examples use `tiny-gpt-demo-v1` and
`qwen25-05b-lora-demo`. That directory and the DevEnvironment workspace volume are
different volumes, and the console has no "publish artifact" action, so the copy is a
cluster-side operation: run a temporary Pod that mounts the workspace PVC (RWX) and the
node's `/mnt/cephfs`, then copy.

```bash
# inside a Pod that mounts the workspace PVC at /workspace and /mnt/cephfs at /ceph.
# This is the tiny-gpt-training copy; the LoRA example uses qwen25-05b-lora-demo.
# No -p: mkdir fails when the directory exists, which is the right outcome -- a
# ModelVersion may already point there -- and && keeps the copy from running.
mkdir /ceph/models/tiny-gpt-demo-v1 &&
  cp -a /workspace/runs/<run-id>/serving/. /ceph/models/tiny-gpt-demo-v1/
```

Each export gets its own directory, named for the version it will be registered as.
A `ModelVersion`'s `spec` is immutable, so a later training run must not overwrite the
directory it points at: copy to a new one (`tiny-gpt-demo-v2`, …) and register a new
`ModelVersion`. If the directory already exists, that artifact has been staged — deploy
the `ModelVersion` that references it, or stage the new export under another name.

`config.json` and the weight files must sit directly in the target directory — the
engine loads that directory itself and does not look into subdirectories.

### 2. Register a ModelVersion

```yaml
# tiny-gpt-training
apiVersion: ai.cubestack.io/v1alpha1
kind: ModelVersion
metadata:
  name: tiny-gpt-demo-v1
spec:
  model: tiny-gpt-demo
  version: v1
  architecture: gpt2
  quantization: fp16
  storage:
    strategy: HostPath
    hostPath:
      path: /mnt/cephfs/models/tiny-gpt-demo-v1
```

```yaml
# lora-finetuning
apiVersion: ai.cubestack.io/v1alpha1
kind: ModelVersion
metadata:
  name: qwen25-05b-demo-v1
spec:
  model: qwen25-05b-demo
  version: v1
  architecture: qwen2
  quantization: fp16
  storage:
    strategy: HostPath
    hostPath:
      path: /mnt/cephfs/models/qwen25-05b-lora-demo
```

`metadata.name` must equal `<model>-<version>`, and the `storage.hostPath.path` must
name the directory from step 1. Both blocks are complete: save the one for your
example as `modelversion.yaml`. `spec` is immutable: to change the artifact or its
attributes, create a new `ModelVersion` with a different name.

```bash
kubectl apply -f modelversion.yaml
```

### 3. Runtime profile

A profile declares the image, start command, probes and resource shape for one
"hardware + engine + model architecture" combination. Clusters that run these examples
usually ship two:

| Profile | Hardware and engine | Serves |
| --- | --- | --- |
| `metax-vllm-gpt2-v027` | MetaX C550, vLLM 0.27.0, single-card LWS | `architecture: gpt2`, `quantization: fp16` |
| `metax-vllm-qwen2-v027` | MetaX C550, vLLM 0.27.0, single-card LWS | `architecture: qwen2`, `quantization: fp16` |

If they are missing on another cluster, save this file as `runtime-profiles.yaml` — it
creates both:

```yaml
apiVersion: ai.cubestack.io/v1alpha1
kind: InferenceRuntimeProfile
metadata:
  name: metax-vllm-gpt2-v027
  annotations:
    ai.cubestack.io/description: MetaX C550 + vLLM 0.27.0, single-card GPT-2 checkpoints
spec:
  accelerator:
    vendor: metax
    models:
    - MXC550
  engine:
    name: vllm
    version: 0.27.0-maca.ai3.8.2.302
  modelRequirements:
    architectures:
    - gpt2
    quantization:
    - fp16
  endpoint:
    role: vllm
    portName: http
  nodeSelector: '{{ overrides.nodeSelector }}'
  overrides:
  - name: replicas
    type: integer
    default: 1
    min: 1
    max: 1
    description: Replicas of this service.
  - name: maxModelLen
    type: integer
    default: 512
    min: 128
    max: 2048
    description: Maximum context length in tokens. The default matches the example checkpoint, whose position table ends at 512; a longer limit only works for a checkpoint that was trained for it.
  - name: nodeSelector
    type: stringList
    default: []
    description: Nodes every role runs on; empty lets the scheduler choose.
  readinessPolicy:
    requireAllRoles: true
  roles:
  - name: vllm
    workload:
      kind: LeaderWorkerSet
      replicas: '{{ overrides.replicas }}'
      group:
        size: 1
        startupPolicy: LeaderCreated
    service:
      ports:
      - name: http
        port: 8000
        targetPort: http
    podTemplate:
      image: registry.cubestack.io:5000/suanova/vllm-metax:0.27.0-maca.ai3.8.2.302-torch2.10-py312-ubuntu22.04-amd64
      imagePullPolicy: IfNotPresent
      command: ["/bin/bash", "-c"]
      args:
      - exec /opt/conda/bin/vllm serve "{{ model.path }}" --served-model-name "{{ model.name }}" --dtype float16 --max-model-len {{ overrides.maxModelLen }} --gpu-memory-utilization 0.45 --host 0.0.0.0 --port 8000
      env:
      - name: MODEL_PATH
        value: '{{ model.path }}'
      ports:
      - name: http
        containerPort: 8000
      mounts:
      - model: main
        at: /models
        readOnly: true
      volumes:
      - name: dshm
        at: /dev/shm
        emptyDir:
          medium: Memory
          sizeLimit: 2Gi
      resources:
        cpu: "4"
        memory: 16Gi
        gpuPerPod: "1"
      nodeSelector:
        metax-tech.com/gpu.product: MXC550
      probes:
        readiness:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 120
      terminationGracePeriodSeconds: 30
---
apiVersion: ai.cubestack.io/v1alpha1
kind: InferenceRuntimeProfile
metadata:
  name: metax-vllm-qwen2-v027
  annotations:
    ai.cubestack.io/description: MetaX C550 + vLLM 0.27.0, single-card Qwen2 models (merged LoRA exports)
spec:
  accelerator:
    vendor: metax
    models:
    - MXC550
  engine:
    name: vllm
    version: 0.27.0-maca.ai3.8.2.302
  modelRequirements:
    architectures:
    - qwen2
    quantization:
    - fp16
  endpoint:
    role: vllm
    portName: http
  nodeSelector: '{{ overrides.nodeSelector }}'
  overrides:
  - name: replicas
    type: integer
    default: 1
    min: 1
    max: 1
    description: Replicas of this service.
  - name: maxModelLen
    type: integer
    default: 4096
    min: 512
    max: 32768
    description: Maximum context length in tokens. Qwen2.5-0.5B supports 32768; lower it to serve more concurrent requests.
  - name: nodeSelector
    type: stringList
    default: []
    description: Nodes every role runs on; empty lets the scheduler choose.
  readinessPolicy:
    requireAllRoles: true
  roles:
  - name: vllm
    workload:
      kind: LeaderWorkerSet
      replicas: '{{ overrides.replicas }}'
      group:
        size: 1
        startupPolicy: LeaderCreated
    service:
      ports:
      - name: http
        port: 8000
        targetPort: http
    podTemplate:
      image: registry.cubestack.io:5000/suanova/vllm-metax:0.27.0-maca.ai3.8.2.302-torch2.10-py312-ubuntu22.04-amd64
      imagePullPolicy: IfNotPresent
      command: ["/bin/bash", "-c"]
      args:
      - exec /opt/conda/bin/vllm serve "{{ model.path }}" --served-model-name "{{ model.name }}" --dtype float16 --max-model-len {{ overrides.maxModelLen }} --gpu-memory-utilization 0.45 --host 0.0.0.0 --port 8000
      env:
      - name: MODEL_PATH
        value: '{{ model.path }}'
      ports:
      - name: http
        containerPort: 8000
      mounts:
      - model: main
        at: /models
        readOnly: true
      volumes:
      - name: dshm
        at: /dev/shm
        emptyDir:
          medium: Memory
          sizeLimit: 2Gi
      resources:
        cpu: "4"
        memory: 16Gi
        gpuPerPod: "1"
      nodeSelector:
        metax-tech.com/gpu.product: MXC550
      probes:
        readiness:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 120
      terminationGracePeriodSeconds: 30
```

```bash
kubectl apply -f runtime-profiles.yaml
```

### 4. Deploy and call

In the console, **Inference Services → Deploy Model**:

- fill in **Service name** and **Target namespace**, and pick a **Runtime profile** and
  **Model version**;
- set the `maxModelLen` override to the context the model was trained with — 512 for
  both examples. vLLM refuses to start when the limit is longer than the checkpoint's
  position table, which is 512 for the Tiny GPT export;
- choose the **Catalog model name** (the `model` field clients send);
- under **Published APIs**, select only `/v1/chat/completions` — extra paths add rules
  to the gateway's shared route, and `/v1/messages` also makes the model appear twice
  in `/v1/models`.

`Ready` covers the workload, not the catalog. Publication is a separate condition,
`RouteReady`: it stays `False` while the shared route has not accepted the backend
(`GatewayNotAccepted`), when another service on the same route already holds the
catalog name (`ModelNameConflict`), or when the route's rule slots are full
(`CatalogFull`). Call the gateway once `Ready` and `RouteReady` are both `True`; the
model is then published under the catalog model name:

```bash
curl -s http://<gateway>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "<catalog model name>",
       "messages": [{"role": "user", "content": "你好"}],
       "max_tokens": 100}'
```

The Tiny GPT model returns a continuation, not an answer; the merged LoRA model returns
a short formatted answer whose quality depends on the fine-tuning data and step count.

The Chinese walkthroughs, including the screenshots, live in the documentation
repository under `devenvironment/tutorials/`.
