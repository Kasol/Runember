# agentdesk · Codex Runner 镜像
# 每个任务的执行容器：git + 钉版本的 Codex CLI
# M0 阶段以 root 运行简化权限问题；生产版切换非 root 用户（见架构文档）
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Codex CLI 已是 Rust 原生二进制，npm 包只是分发壳，不引入额外运行时负担
RUN npm install -g @openai/codex@0.167.0

# 会话/凭证目录固定在这里，由 daemon 挂 named volume 进来（resume 的命脉）
ENV CODEX_HOME=/codex-home

WORKDIR /workspace
