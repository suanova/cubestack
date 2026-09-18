#!/bin/bash
# deploy-bmc.sh: sync BMC exporter sources to the test machine, build static
# binaries + scratch images remotely (buildah), import them into containerd and
# install via the cubestack-bmc-exporter-chart Helm chart (release name
# cubestack-bmc-exporter).
# 用法：SSHPASS='<测试机密码>' BMC_USER=root BMC_PASS='<BMC密码>' bash deploy-bmc.sh
# 前提：本机到测试机 vm1-weina:22 的隧道已建立（端口 12201，见 docs/bmc-progress.md），
#       已安装 sshpass；测试机已装 Go 工具链、buildah 和 helm。
# 说明：测试环境无可用 registry，镜像本地构建并 ctr import，helm 安装用 values
#       文件（凭据/hosts 不经 shell 命令行拼接）把镜像指向 docker.io/library/<name>。

TEST_PORT=12201
TEST_USER=ubuntu
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # observability/
CHART_DIR="$ROOT_DIR/helm/cubestack-bmc-exporter-chart"

# 测试机 SSH 密码不硬编码: 经 SSHPASS 环境变量注入, sshpass -e 读取
# (进程参数中不出现密码)
if [ -z "${SSHPASS:-}" ]; then
  echo "请设置环境变量 SSHPASS(测试机 SSH 密码)" >&2
  exit 1
fi

# BMC 凭据不硬编码,通过环境变量注入
BMC_USER="${BMC_USER:?请设置环境变量 BMC_USER(如 export BMC_USER=root)}"
BMC_PASS="${BMC_PASS:?请设置环境变量 BMC_PASS(如 export BMC_PASS=xxx)}"

SSHT="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p $TEST_PORT $TEST_USER@127.0.0.1"
SCPT="sshpass -e scp -o StrictHostKeyChecking=no -q -P $TEST_PORT"

echo "=== 1. 同步文件到测试机 ==="
$SSHT "rm -rf /tmp/bmc-deploy && mkdir -p /tmp/bmc-deploy"
$SCPT -r "$ROOT_DIR/bmc-oem-exporter" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/
$SCPT -r "$ROOT_DIR/deploy/bmc" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/
$SCPT -r "$CHART_DIR" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/

echo "=== 2. 远程编译 idrac-exporter（静态二进制） ==="
# bmc-oem-exporter 不用在此编译: 其 Dockerfile 已改为多阶段构建(见步骤 3)
$SSHT "set -e; export PATH=\$PATH:/usr/local/go/bin GOPROXY=https://goproxy.cn,direct; \
  IDRAC_SRC=\"\$(go env GOMODCACHE)/github.com/mrlhansen/idrac_exporter@v1.6.2\"; \
  if [ -d \"\$IDRAC_SRC\" ]; then \
    (cd \"\$IDRAC_SRC\" && GOPROXY=off CGO_ENABLED=0 go build -o /tmp/bmc-deploy/idrac_exporter ./cmd/idrac_exporter) \
      || cp /tmp/bin/idrac_exporter /tmp/bmc-deploy/idrac_exporter; \
  else \
    cp /tmp/bin/idrac_exporter /tmp/bmc-deploy/idrac_exporter; \
  fi"

echo "=== 3. buildah 构建 scratch 镜像 ==="
# bmc-oem-exporter: 用仓库 Dockerfile 多阶段构建(源码目录作 context)。
# 前提: 本机 buildah store 已有 golang:1.26 基础镜像(离线环境先
# 'sudo buildah pull golang:1.26' 或从 tar 导入一次)。
$SSHT "set -e; \
  mkdir -p /tmp/bmc-deploy/ctx/idrac; \
  cp /tmp/bmc-deploy/idrac_exporter /tmp/bmc-deploy/ctx/idrac/; \
  cp /tmp/bmc-deploy/bmc/Dockerfile.idrac-exporter /tmp/bmc-deploy/ctx/idrac/Dockerfile; \
  sudo buildah bud -t docker.io/library/bmc-oem-exporter:latest /tmp/bmc-deploy/bmc-oem-exporter && \
  sudo buildah bud -t docker.io/library/idrac-exporter:latest /tmp/bmc-deploy/ctx/idrac && \
  sudo buildah push docker.io/library/bmc-oem-exporter:latest docker-archive:/tmp/bmc-deploy/bmc-oem.tar && \
  sudo buildah push docker.io/library/idrac-exporter:latest docker-archive:/tmp/bmc-deploy/idrac.tar"

echo "=== 4. 导入镜像到 containerd（k8s.io namespace） ==="
$SSHT "sudo ctr -n k8s.io images import /tmp/bmc-deploy/bmc-oem.tar && \
  sudo ctr -n k8s.io images import /tmp/bmc-deploy/idrac.tar && \
  sudo crictl images | grep -E 'bmc-oem|idrac'"

echo "=== 5. 生成 values 文件(凭据/hosts 不进命令行) ==="
# 用 python3 结构化序列化, 密码含空格/引号/$ 等特殊字符也不会破坏 YAML 或注入 shell
VALUES_FILE="$(mktemp -t bmc-values.XXXXXX.json)"
trap 'rm -f "$VALUES_FILE"' EXIT
python3 - "$BMC_USER" "$BMC_PASS" >"$VALUES_FILE" <<'PYEOF'
import json, sys
values = {
    "bmc": {
        "username": sys.argv[1],
        "password": sys.argv[2],
        "hosts": ["10.6.2.14", "10.6.2.18"],
    },
    "bmcOemExporter": {
        # BMC 自签名证书: 显式跳过 TLS 校验(生产应配置 CA 并把该值保持 false)
        "tlsInsecure": True,
        "image": {"repository": "docker.io/library/bmc-oem-exporter"},
        "nodeSelector": {"kubernetes.io/hostname": "vm1-weina"},
    },
    "idracExporter": {
        "image": {"repository": "docker.io/library/idrac-exporter"},
        "nodeSelector": {"kubernetes.io/hostname": "vm1-weina"},
    },
}
json.dump(values, sys.stdout, indent=2)
PYEOF
$SCPT "$VALUES_FILE" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/values.json

echo "=== 6. 清理旧裸 yaml 部署并 helm 安装 ==="
# kubectl/helm 走 sudo:vm1 的 kubeconfig 在 root 下(ubuntu 用户无 ~/.kube/config)
$SSHT "sudo kubectl -n monitoring delete deploy,svc,scrapeconfig,secret \
    cubestack-bmc-oem-exporter cubestack-idrac-exporter \
    cubestack-bmc-credentials cubestack-idrac-exporter-config \
    --ignore-not-found >/dev/null 2>&1; \
  sudo helm upgrade --install cubestack-bmc-exporter /tmp/bmc-deploy/cubestack-bmc-exporter-chart \
    -n monitoring -f /tmp/bmc-deploy/values.json; \
  rm -f /tmp/bmc-deploy/values.json"

echo "=== 7. 等待 Pod 就绪 ==="
$SSHT "sudo kubectl -n monitoring rollout status deployment/cubestack-bmc-exporter-bmc-oem-exporter --timeout=60s && \
  sudo kubectl -n monitoring rollout status deployment/cubestack-bmc-exporter-idrac-exporter --timeout=60s"

echo "=== 8. 验证 exporter 响应(含白名单拒绝) ==="
$SSHT "sudo kubectl -n monitoring port-forward svc/cubestack-bmc-exporter-bmc-oem-exporter 19622:9622 &>/dev/null & \
  PF_PID=\$!; sleep 3; \
  echo -n 'bmc-oem /probe lines: '; curl -s 'http://127.0.0.1:19622/probe?target=10.6.2.14' | grep -c '^bmc_pcie'; \
  echo -n '非白名单 target 应 403: '; curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:19622/probe?target=1.2.3.4'; \
  kill \$PF_PID 2>/dev/null; true"

echo "Done. Prometheus 下个抓取周期（<=60s）后 up{job=~\"bmc-oem-exporter|idrac-exporter\"} 应全部为 1。"
