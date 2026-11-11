# agentdesk

把"人盯着 Codex 跑任务"变成"**人离线也能按计划推进、阻塞能找人、回来能看总结**"的无人值守工作台。

- GUI 看板：任务 / 运行状态 / 日志 / 总结
- 多 Agent 调度：先 Codex CLI，架构可扩展 Claude Code / Gemini CLI
- 离线自动执行：队列 + 定时；同项目串行，架构预留并行
- 阻塞闭环：缺权限 / 需确认 / 额度耗尽 → 钉钉通知 → 人反馈 → `codex exec resume` 续跑
- 宿主机只依赖 Docker；可自托管、开源

## 当前状态：M0 探针（技术风险验证）

M0 用一个 ~350 行的探针脚本，一次性验证整个架构依赖的四个假设：

| # | 假设 | 验证方式 |
|---|------|---------|
| P1 | runner 容器能跑 codex，workspace 卷可初始化为 git 仓库 | 容器内 `git init` + `codex --version` |
| P2 | `codex exec --json` 事件流逐行可解析 | 收集全部事件类型并落盘 |
| P3 | sessions 落在 codex-home 卷，跨容器可见 | 检查卷内 `sessions/*.jsonl` |
| P4 | 新容器 `codex exec resume` 带反馈续跑，上下文延续 | 两阶段"暗号"测试：任务1记住暗号 → 新容器 resume 复述 |

探针自身也跑在容器里（挂 `docker.sock` 派生兄弟容器）——**与生产 daemon 完全同拓扑**，探针通过即生产路径通过。

## 快速开始

前置：宿主机安装 Docker（Desktop 或 Engine 均可）+ Node 22+（仅用于 npm 脚本编排）。

```bash
npm install

# 认证二选一：
cp .env.example .env          # A) 填 CODEX_API_KEY（按量付费）
npm run m0:login              # B) ChatGPT Plus/Pro 订阅：设备码登录，凭证写入 codex-home 卷

npm run m0:offline            # 第一步：离线冒烟（不需要认证）
npm run m0                    # 第二步：完整探针（需要认证，约 3-5 分钟）
```

输出：终端直接打印 PASS/FAIL 结论表；明细在 `data/m0/`（原始 JSONL、inspect 日志、summary.json）。

清掉全部状态重跑：`bash scripts/m0.sh --reset`

## 里程碑

- [x] M0 探针（本目录）
- [x] M1 核心循环：monorepo + SQLite 队列 + 调度器 + host-dir 容器执行 + CLI（验收通过）
- [x] M2（缓行）
- [x] M3 钉钉闭环：webhook 通知 + Stream 反馈（手机 @机器人 resume，端到端验收通过）
- [ ] M4 cron 计划 + 额度熔断 + 并发放开（CONCURRENCY）

## M3 手机闭环（已验收）

任务阻塞 → 钉钉群推送问题原文 → 手机上 `@机器人 resume <id> 你的决定` → daemon（出站 WSS，零公网暴露）收到指令 → 同一会话上下文续跑 → 完成回群汇报。指令语法：`resume/继续 <id> <决定>`、`retry/重试 <id>`、`cancel/取消 <id>`、`status/状态`。

预览图：`docs/preview-dingtalk.png`

## M1 用法

```bash
npm run daemon -- --data-dir ./data/agentdesk   # 1. 起 daemon（保持运行）
npm run desk -- project add demo D:/work/demo   # 2. 注册项目（任意 git 仓库的本地路径）
npm run desk -- auth codex                      # 3. 首次：设备码登录（浏览器授权，凭证落卷）
npm run desk -- run demo "给 README 补一节 FAQ" # 4. 挂任务（离线时按队列自动推进）
npm run desk -- status                          # 5. 看队列；status <id> 看总结
npm run desk -- resume <id> "按方案B继续"       # 阻塞后带反馈续跑（同一会话上下文）
```

注意：往 API 提交中文请走 CLI（Node fetch，UTF-8 安全）；裸 `curl -d` 在 GBK 控制台会把中文打坏。

## 目录

```
packages/core            # 纯领域层：状态机 / blocked 分类 / 调度闸门 / 三大接口（零 IO）
packages/adapters        # Agent 注册表 + CodexAdapter（新增 agent = 加一个文件）
apps/daemon              # 配置/存储/调度/Runner/API/通知 —— 常驻核心
apps/cli                 # desk 命令行
scripts/m0-probe.ts      # M0 探针（保留为验证工具）
images/runner-codex/     # 任务执行容器镜像（git + 钉版本 codex）
```
