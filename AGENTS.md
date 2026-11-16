# AGENTS.md — agentdesk 开发须知

面向在本仓库工作的 AI agent 与新开发者。**先读这页再动手**，能避开我们踩过的所有坑。

## 项目背景与定位

**agentdesk** = 无人值守 Agent 调度工作台：把"人盯着 Codex 跑任务"变成"人离线也能按计划推进、阻塞能找人、回来能看总结"。

- 调度 Codex CLI（后续可扩展 Claude Code / Gemini CLI 等，通过 Adapter 抽象）
- 三端入口：CLI / Web 看板 / 钉钉（手机派单、批复、状态查询）
- 双执行模式：**capability**（默认，codex 直接跑宿主，原生依赖可用）/ **isolation**（Linux 容器隔离执行，注册时检测 Windows 原生组件，不兼容拒绝）
- git 安全网在宿主侧：checkpoint/审计由 daemon 用宿主 git 执行（继承用户 LFS/filemode 配置），容器不碰 `.git`
- 定位公理：能力优先模式 = 离线无人值守 + 自家项目，agent 以用户完整身份跑（无沙箱降权），无人操作故无竞态前提

## 仓库结构

```
packages/core       # 纯领域层：状态机/blocked分类/调度闸门/协议标记（零 IO，可单测）
packages/adapters   # Agent 注册表 + CodexAdapter（新增 agent = 加一个文件）
apps/daemon         # Fastify API + 调度器 + Runner + 钉钉通道 + node:sqlite 存储
apps/web            # React 看板（dev 用 vite，构建产物可由 daemon 托管——待实现）
apps/cli            # desk 命令行
scripts/            # M0 探针与编排
images/runner-codex # 隔离模式任务执行镜像（node:24-slim + git + codex@0.167.0）
docs/               # 钉钉消息预览图
```

## 常用命令

```bash
npm run daemon -- --data-dir ./data/agentdesk   # 启动 daemon（单实例锁防双开）
npm run web                                      # Web 看板 dev server（5173）
npm run desk -- status | run | resume | draft... # CLI
npm run desk -- doctor                           # 环境自检
npm run typecheck                                # tsc --noEmit（提交前必跑）
```

## 环境特定知识与坑（血泪清单，改动前先对照）

### Windows / Git Bash
- **MSYS 路径转换**会改写 `-v /var/run/docker.sock` 和 `-e CODEX_HOME=/xxx` → 一律 `export MSYS_NO_PATHCONV=1`
- GBK 控制台里裸 `curl -d` 会打坏中文 → 中文参数走 CLI（Node fetch，UTF-8 安全）
- 宿主 codex CLI 是 **GUI 私有运行时**（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，故意不进 PATH）→ 用 `findHostCodex()`（native.ts）动态发现，禁止硬编码路径

### Codex 沙箱（重要）
- codex Windows 沙箱把命令降权到 `CodexSandboxUsers` 受限账户；web-cad 等仓库的 `.git` 有对该账户的显式拒绝写 ACL → agent 的 fetch/commit/push 会失败
- **capability 模式已解法**：runner 把 `--sandbox workspace-write` 升级为 `danger-full-access`（命令以用户完整身份跑）。不要"顺手"改回去
- isolation 模式容器内必须 `seccomp=unconfined`（codex 的 bwrap 沙箱需要 userns），否则 agent 命令全部静默失败
- 宿主进程必须显式关闭 stdin（`OpenStdin:false` / stdio ignore），否则 codex 完成后等 stdin 挂起，状态滞后

### git（安全网在宿主侧）
- git 元数据操作（checkpoint/审计）只在宿主 daemon 执行（hostgit.ts），**容器永远不碰 `.git`**——两套 git 环境（LFS/filemode/hook）不一致曾造成 1.3G 误提交事故
- capability 模式下 agent 可执行宿主 git（fetch/commit/push 已验证）；push 直连 GitHub 会被 RST，走代理即通（仓库级 `http.https://github.com.proxy`，由用户决定是否配置）
- isolation 模式注册时守门员检测 Windows 原生组件（.dll/.exe + 原生模块），命中拒绝并提示切 capability

### 钉钉 Stream 通道
- **必须 `keepAlive: true`**（SDK 默认 false）：WS ping/pong 心跳 8s 一轮，防半开僵尸连接（NAT 过期/网络切换导致的"静默断连"靠它 8 秒自愈）
- **机器人 CALLBACK 要通过 Stream 主动 ACK**：用 `client.socketCallBackResponse(headers.messageId, {})` 确认每次投递，包括重复投递。SDK 对 EVENT 的自动 ACK 走独立路径。缺少 CALLBACK ACK 会触发约 60 秒后的重推。
- 群指令必须同时通过发送者和会话授权。主动通知用显式配置的群，排查日志只输出必要的连接状态和投递标识。
- 去重优先用机器人消息体的 `msgId`，缺失时用回调头的 `messageId`。**禁止内容级去重**，用户可以重新发送相同指令。
- `~/.codex/config.toml` 的 MCP 配置（如 GUI 的 node_repl）在 CLI 会话里可能依赖 GUI 会话变量而不可用；第三方标准 MCP（url/command 型）原生可用

### 结果协议（任务收尾契约）
- agent 结束前必须输出 `###AGENTCTL_RESULT### {"done":bool,"summary":...,"remaining":...}`
- `done:false` → 任务标记部分完成（partial_remaining 落库），三端可见 + 一键后续任务
- 续跑阻塞或部分完成任务：`继续 <编号> [说明]` 或 `resume <编号> [说明]`，编号可带 `#`。
- 展示 agent 总结时用 `stripAgentctlLines()` 剥离协议标记行，别让协议原文漏给用户

### 进程管理
- **重启 daemon 前后清点 node 进程**：历史孤儿实例各持一条钉钉 WS 连接 → 消息被多实例重复消费/回复（双回复事故根因之一）。单实例锁（daemon.lock + PID 活性检查）是兜底，不是借口
- vite（5173）与 daemon 是独立进程，清 node 会连带杀掉，注意分别拉起

## 已完成里程碑（全部实测验收）

- [x] M0 技术探针（11/11：容器执行/事件流/会话持久化/跨容器 resume）
- [x] M1 核心循环（队列/调度/host-dir/checkpoint/CLI）
- [x] M2 Web 看板（项目主导 + 六栏队列 + 草稿队列 + 详情）
- [x] M3 钉钉闭环（三态通知 + 手机派单/批复/续跑，单机器人双职责）
- [x] M4/M4.5 环境冲刺（宿主 git/依赖三层/MCP 声明/熔断/双模式/沙箱提升/doctor/结果协议）

## 待办（M4.5 backlog）

- cron 定时任务、额度熔断、阻塞时效策略（24h 未处理提醒/过期）
- 运行中任务取消（杀容器/杀进程）与插话
- 并发放开实测（`AGENTDESK_SCHEDULER__CONCURRENCY=2`，架构已预留）
- daemon 托管 web 构建产物（单进程形态）+ compose 部署食谱
- 推 GitHub 开源

## 测试约定

- 改动 daemon/runner 后：typecheck → 重启 daemon → 用 selftest 派任务回归
- 钉钉相关改动：真发一条消息对账（推送卡片/回复内容）
- 不要动 `D:\work2\onshape-web-cad`（用户真实项目）——除非任务明确要求，且写操作先征得同意
