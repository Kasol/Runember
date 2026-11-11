# agentdesk · M0 探针镜像
# 模拟生产拓扑：探针容器内通过 /var/run/docker.sock 派生兄弟 Runner 容器
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts

ENTRYPOINT ["npx", "tsx", "scripts/m0-probe.ts"]
