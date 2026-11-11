#!/usr/bin/env bash
# agentdesk · M0 探针编排
#   构建两个镜像 → 在探针容器内运行 m0-probe.ts（挂 docker.sock，与生产 daemon 同拓扑）
# 用法:
#   npm run m0                 # 完整探针（需要 CODEX_API_KEY）
#   npm run m0:offline         # 离线冒烟（不需要 key：卷/workspace/codex --version）
#   bash scripts/m0.sh --reset # 连 m0 卷一起清掉重跑
set -euo pipefail
cd "$(dirname "$0")/.."

# Git Bash 下禁用 MSYS 路径转换，否则 -v /var/run/docker.sock 会被改写成
# C:/Program Files/Git/var/run/... 导致 socket 挂载失败（ENOENT）
export MSYS_NO_PATHCONV=1

IMAGE_RUNNER="${IMAGE_RUNNER:-agentdesk/runner-codex:m0}"
IMAGE_PROBE="agentdesk/m0-probe:m0"

# 载入 .env（如存在）
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# 国内环境：容器内 codex 访问 openai 需要代理。
# 在 .env 里设 HTTPS_PROXY=http://host.docker.internal:7897（代理需开启 Allow LAN）
PROXY_FLAGS=()
[ -n "${HTTPS_PROXY:-}" ] && PROXY_FLAGS+=(-e HTTPS_PROXY="$HTTPS_PROXY" -e https_proxy="$HTTPS_PROXY")
[ -n "${HTTP_PROXY:-}" ]  && PROXY_FLAGS+=(-e HTTP_PROXY="$HTTP_PROXY" -e http_proxy="$HTTP_PROXY")

# 子命令: login —— ChatGPT 订阅（Plus/Pro）登录，凭证 auth.json 写入 codex-home 卷
# 设备码模式：终端出码，本机浏览器打开授权页输入即可，无需回调端口
if [ "${1:-}" = "login" ]; then
  shift
  echo "[m0-login] 构建 runner 镜像..."
  docker build -q -t "$IMAGE_RUNNER" images/runner-codex
  docker volume create agentdesk-m0-codex-home >/dev/null
  echo "[m0-login] 启动登录容器（按提示在浏览器完成授权）..."
  exec docker run --rm -it \
    -v agentdesk-m0-codex-home:/codex-home \
    -e CODEX_HOME=/codex-home \
    "${PROXY_FLAGS[@]}" \
    "$IMAGE_RUNNER" codex login --device-auth
fi

echo "[m0] 构建镜像（首次较慢）..."
docker build -q -t "$IMAGE_RUNNER" images/runner-codex
docker build -q -t "$IMAGE_PROBE" -f images/m0-probe/Dockerfile .

# Git Bash 下 pwd -W 输出 D:/... 形式，docker.exe 才认
HOST_DIR="$(pwd -W 2>/dev/null || pwd)"
mkdir -p data

TTY_FLAGS=""
[ -t 0 ] && TTY_FLAGS="-t"

echo "[m0] 启动探针容器..."
exec docker run --rm -i $TTY_FLAGS \
  --name agentdesk-m0-probe \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOST_DIR/data:/app/data" \
  -e CODEX_API_KEY -e OPENAI_API_KEY \
  -e IMAGE_RUNNER="$IMAGE_RUNNER" \
  "${PROXY_FLAGS[@]}" \
  "$IMAGE_PROBE" "$@"
