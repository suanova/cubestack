# InferenceService 页面 PromQL 表达式

变量：
- `$namespace`（来自 `label_values(cubestack_inference_requests_running:sum, namespace)`）
- `$inference_service`（来自 `label_values(cubestack_inference_requests_running:sum{namespace="$namespace"}, inference_service)`）
- `$model`（来自 `label_values(cubestack_inference_requests:rate5m, gen_ai_request_model)`）

> **注意 label 区分：**
> - Controller metric（`cubestack_inference_service_ready`、`cubestack_inference_service_info`）使用 `name` label 标识服务，对应 `name="$inference_service"`
> - Recording rule 产出的 runtime metric（`cubestack_inference_requests_running:sum` 等）使用 `inference_service` label，对应 `inference_service="$inference_service"`
> - 两套 label key 不同，查询时需按各自 label 名过滤

---

## InferenceService List（每行一个服务）

### Ready 状态
```
cubestack_inference_service_ready{namespace="$namespace", name="$inference_service"}
```

### Model / Mode（from info metric labels）
```
cubestack_inference_service_info{namespace="$namespace", name="$inference_service"}
```
- 取 `model` label 展示模型名，`mode` label 展示 unified/disaggregated

### Requests/s
```
cubestack_inference_requests:rate5m{gen_ai_request_model="$model"}
```

### Generation Tokens/s
```
cubestack_inference_generation_tokens:rate5m{gen_ai_request_model="$model"}
```

### TTFT P95
```
cubestack_inference_time_to_first_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
```
- Unit：s

### TPOT P95
```
cubestack_inference_time_per_output_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
```

### Waiting Requests
```
sum by (inference_service) (
  cubestack_inference_requests_waiting:sum{namespace="$namespace", inference_service="$inference_service"}
)
```

### KV Usage（max）
```
max by (inference_service) (
  cubestack_inference_kv_cache_usage_ratio:max{namespace="$namespace", inference_service="$inference_service"}
)
```

### GPU Allocated
```
cubestack_inference_gpu_allocated:sum{namespace="$namespace", inference_service="$inference_service"}
```

---

## InferenceService Detail

### Summary

```
cubestack_inference_service_ready{namespace="$namespace", name="$inference_service"}
cubestack_inference_service_info{namespace="$namespace", name="$inference_service"}
cubestack_inference_gpu_allocated:sum{namespace="$namespace", inference_service="$inference_service"}
cubestack_inference_requests:rate5m{gen_ai_request_model="$model"}
cubestack_inference_generation_tokens:rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_to_first_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_per_output_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
```

---

### Traffic（Time Series）

```
cubestack_inference_requests:rate5m{gen_ai_request_model="$model"}
cubestack_inference_prompt_tokens:rate5m{gen_ai_request_model="$model"}
cubestack_inference_generation_tokens:rate5m{gen_ai_request_model="$model"}
```

---

### User Latency（Time Series）

#### Request Duration
```
cubestack_inference_request_duration_seconds:p50_rate5m{gen_ai_request_model="$model"}
cubestack_inference_request_duration_seconds:p95_rate5m{gen_ai_request_model="$model"}
cubestack_inference_request_duration_seconds:p99_rate5m{gen_ai_request_model="$model"}
```

#### TTFT
```
cubestack_inference_time_to_first_token_seconds:p50_rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_to_first_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_to_first_token_seconds:p99_rate5m{gen_ai_request_model="$model"}
```

#### TPOT
```
cubestack_inference_time_per_output_token_seconds:p50_rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_per_output_token_seconds:p95_rate5m{gen_ai_request_model="$model"}
cubestack_inference_time_per_output_token_seconds:p99_rate5m{gen_ai_request_model="$model"}
```

---

### Runtime Capacity（Time Series）

#### Running / Waiting Requests（sum across all roles）
```
sum by (inference_service) (
  cubestack_inference_requests_running:sum{namespace="$namespace", inference_service="$inference_service"}
)
sum by (inference_service) (
  cubestack_inference_requests_waiting:sum{namespace="$namespace", inference_service="$inference_service"}
)
```

#### KV Cache Usage（max across all roles）
```
max by (inference_service) (
  cubestack_inference_kv_cache_usage_ratio:max{namespace="$namespace", inference_service="$inference_service"}
)
```

#### Prefix Cache Hit Ratio
```
cubestack_inference_cache_hit_ratio:avg{namespace="$namespace", inference_service="$inference_service"}
```

---

### PD 分离（仅 mode=disaggregated 时展示）

条件：`cubestack_inference_service_info{namespace="$namespace", name="$inference_service", mode="disaggregated"}` 存在

#### Prefill Running / Waiting / KV
```
cubestack_inference_requests_running:sum{namespace="$namespace", inference_service="$inference_service", role="prefill"}
cubestack_inference_requests_waiting:sum{namespace="$namespace", inference_service="$inference_service", role="prefill"}
cubestack_inference_kv_cache_usage_ratio:max{namespace="$namespace", inference_service="$inference_service", role="prefill"}
```

#### Decode Running / Waiting / KV
```
cubestack_inference_requests_running:sum{namespace="$namespace", inference_service="$inference_service", role="decode"}
cubestack_inference_requests_waiting:sum{namespace="$namespace", inference_service="$inference_service", role="decode"}
cubestack_inference_kv_cache_usage_ratio:max{namespace="$namespace", inference_service="$inference_service", role="decode"}
```

---

### GPU（per UUID，Time Series）

变量：`$uuid`（来自 `label_values(cubestack_gpu_utilization_ratio:max{namespace="$namespace", inference_service="$inference_service"}, uuid)`）

```
cubestack_gpu_utilization_ratio:max{namespace="$namespace", inference_service="$inference_service", uuid="$uuid"}
cubestack_gpu_memory_utilization_ratio:max{namespace="$namespace", inference_service="$inference_service", uuid="$uuid"}
```
