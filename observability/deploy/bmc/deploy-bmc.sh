#!/bin/bash
# deploy-bmc.sh: sync BMC exporter sources to the test machine, build static
# binaries + scratch images remotely (buildah), import them into containerd and
# install via the cubestack-bmc-exporter Helm chart.
# 用法：bash deploy-bmc.sh
# 前提：本机到测试机 vm1-weina:22 的隧道已建立（端口 12201，见 docs/bmc-progress.md），
#       已安装 sshpass；测试机已装 Go 工具链、buildah 和 helm。
# 说明：测试环境无可用 registry，镜像本地构建并 ctr import，helm 安装时用
#       --set 把镜像指向 docker.io/library/<name>（import 后的名字）。

TEST_PORT=12201
TEST_USER=ubuntu
TEST_PASS=ubuntu
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # observability/
CHART_DIR="$ROOT_DIR/helm/cubestack-bmc-exporter-chart"

# BMC 凭据不硬编码,通过环境变量注入:
#   BMC_USER=root BMC_PASS='xxx' bash deploy-bmc.sh
BMC_USER="${BMC_USER:?请设置环境变量 BMC_USER(如 export BMC_USER=root)}"
BMC_PASS="${BMC_PASS:?请设置环境变量 BMC_PASS(如 export BMC_PASS=xxx)}"

SSHT="sshpass -p $TEST_PASS ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p $TEST_PORT $TEST_USER@127.0.0.1"
SCPT="sshpass -p $TEST_PASS scp -o StrictHostKeyChecking=no -q -P $TEST_PORT"

echo "=== 1. 同步文件到测试机 ==="
$SSHT "rm -rf /tmp/bmc-deploy && mkdir -p /tmp/bmc-deploy"
$SCPT -r "$ROOT_DIR/bmc-oem-exporter" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/
$SCPT -r "$ROOT_DIR/deploy/bmc" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/
$SCPT -r "$CHART_DIR" $TEST_USER@127.0.0.1:/tmp/bmc-deploy/

echo "=== 2. 远程编译两个 exporter（静态二进制） ==="
$SSHT "set -e; export PATH=\$PATH:/usr/local/go/bin GOPROXY=https://goproxy.cn,direct; \
  cd /tmp/bmc-deploy/bmc-oem-exporter && \
  CGO_ENABLED=0 go build -o /tmp/bmc-deploy/bmc-oem-bin ./cmd/bmc-oem-exporter; \
  IDRAC_SRC=\"\$(go env GOMODCACHE)/github.com/mrlhansen/idrac_exporter@v1.6.2\"; \
  if [ -d \"\$IDRAC_SRC\" ]; then \
    (cd \"\$IDRAC_SRC\" && GOPROXY=off CGO_ENABLED=0 go build -o /tmp/bmc-deploy/idrac_exporter ./cmd/idrac_exporter) \
      || cp /tmp/bin/idrac_exporter /tmp/bmc-deploy/idrac_exporter; \
  else \
    cp /tmp/bin/idrac_exporter /tmp/bmc-deploy/idrac_exporter; \
  fi"

echo "=== 3. buildah 构建 scratch 镜像 ==="
$SSHT "set -e; \
  mkdir -p /tmp/bmc-deploy/ctx/oem /tmp/bmc-deploy/ctx/idrac; \
  cp /tmp/bmc-deploy/bmc-oem-bin /tmp/bmc-deploy/ctx/oem/bmc-oem-exporter; \
  cp /tmp/bmc-deploy/idrac_exporter /tmp/bmc-deploy/ctx/idrac/; \
  cp /tmp/bmc-deploy/bmc-oem-exporter/Dockerfile /tmp/bmc-deploy/ctx/oem/; \
  cp /tmp/bmc-deploy/bmc/Dockerfile.idrac-exporter /tmp/bmc-deploy/ctx/idrac/Dockerfile; \
  sudo buildah bud -t docker.io/library/bmc-oem-exporter:latest /tmp/bmc-deploy/ctx/oem && \
  sudo buildah bud -t docker.io/library/idrac-exporter:latest /tmp/bmc-deploy/ctx/idrac && \
  sudo buildah push docker.io/library/bmc-oem-exporter:latest docker-archive:/tmp/bmc-deploy/bmc-oem.tar && \
  sudo buildah push docker.io/library/idrac-exporter:latest docker-archive:/tmp/bmc-deploy/idrac.tar"

echo "=== 4. 导入镜像到 containerd（k8s.io namespace） ==="
$SSHT "sudo ctr -n k8s.io images import /tmp/bmc-deploy/bmc-oem.tar && \
  sudo ctr -n k8s.io images import /tmp/bmc-deploy/idrac.tar && \
  sudo crictl images | grep -E 'bmc-oem|idrac'"

echo "=== 5. 清理旧裸 yaml 部署并 helm 安装 ==="
# kubectl/helm 走 sudo:vm1 的 kubeconfig 在 root 下(ubuntu 用户无 ~/.kube/config)
$SSHT "sudo kubectl -n monitoring delete deploy,svc,scrapeconfig,secret \
    cubestack-bmc-oem-exporter cubestack-idrac-exporter \
    cubestack-bmc-credentials cubestack-idrac-exporter-config \
    --ignore-not-found >/dev/null 2>&1; \
  sudo helm upgrade --install cubestack-bmc-exporter /tmp/bmc-deploy/cubestack-bmc-exporter-chart \
    -n monitoring \
    --set bmc.username="$BMC_USER" --set bmc.password="$BMC_PASS" \
    --set bmcOemExporter.image.repository=docker.io/library/bmc-oem-exporter \
    --set idracExporter.image.repository=docker.io/library/idrac-exporter \
    --set 'bmcOemExporter.nodeSelector.kubernetes\.io/hostname=vm1-weina' \
    --set 'idracExporter.nodeSelector.kubernetes\.io/hostname=vm1-weina'"

echo "=== 6. 等待 Pod 就绪 ==="
$SSHT "sudo kubectl -n monitoring rollout status deployment/cubestack-bmc-exporter-bmc-oem-exporter --timeout=60s && \
  sudo kubectl -n monitoring rollout status deployment/cubestack-bmc-exporter-idrac-exporter --timeout=60s"

echo "=== 7. 验证 exporter 响应 ==="
$SSHT "sudo kubectl -n monitoring port-forward svc/cubestack-bmc-exporter-bmc-oem-exporter 19622:9622 &>/dev/null & \
  PF_PID=\$!; sleep 3; \
  echo -n 'bmc-oem /probe lines: '; curl -s 'http://127.0.0.1:19622/probe?target=10.6.2.14' | grep -c '^bmc_pcie'; \
  kill \$PF_PID 2>/dev/null; true"

echo "Done. Prometheus 下个抓取周期（<=60s）后 up{job=~\"bmc-oem-exporter|idrac-exporter\"} 应全部为 1。"
