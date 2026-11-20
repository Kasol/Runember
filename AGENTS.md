# AGENTS.md — Runember 开发须知

面向在本仓库工作的 AI agent 与新开发者。**先读这页再动手**，能避开我们踩过的所有坑。

## 项目背景与定位

**Runember**（原 agentdesk）是通用 Agent 调度工作台：负责排队、执行器生命周期、状态、会话与通知。任务如何完成由 Agent、用户提示词、MCP 和 Skill 决定，不预设特定业务流程。内部包名和数据目录保留 agentdesk 以兼容旧用户。

- 调度 Codex、ZCode 和 DeepSeek Harness，通过 Adapter 抽象扩展。
- 四端入口：CLI / Web 看板 / Electron 桌面端 / 钉钉。
- 双执行模式：**capability**（默认，codex 直接跑宿主，原生依赖可用）/ **isolation**（Linux 容器隔离执行，注册时检测 Windows 原生组件，不兼容拒绝）
- git 安全网在宿主侧：checkpoint/审计由 daemon 用宿主 git 执行（继承用户 LFS/filemode 配置），容器不碰 `.git`
- 能力优先模式以当前用户身份执行可信项目的任务。用户或外部程序仍可能同时修改文件，不能假定不存在竞态。取消保留已有改动，不自动回退。

## 仓库结构

```
packages/core       # 纯领域层：状态机/blocked分类/调度闸门/协议标记（零 IO，可单测）
packages/adapters   # Agent 注册表 + CodexAdapter（新增 agent = 加一个文件）
apps/daemon         # Fastify API + 调度器 + Runner + 钉钉通道 + node:sqlite 存储
apps/web            # React 看板（开发用 vite，发布产物由 daemon 托管）
apps/desktop        # Electron 主进程 + 内嵌 Web，随附运行时
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
- **capability 模式已解法**：CodexAdapter 按执行模式设置 `--sandbox danger-full-access`（命令以用户完整身份跑）。隔离模式使用 `workspace-write`。
- isolation 模式容器内必须 `seccomp=unconfined`（codex 的 bwrap 沙箱需要 userns），否则 agent 命令全部静默失败
- 宿主进程必须显式关闭 stdin（`OpenStdin:false` / stdio ignore），否则 codex 完成后等 stdin 挂起，状态滞后

### git（安全网在宿主侧）
- git 元数据操作（checkpoint/审计）只在宿主 daemon 执行（hostgit.ts），**容器永远不碰 `.git`**——两套 git 环境（LFS/filemode/hook）不一致曾造成 1.3G 误提交事故
- capability 模式下 agent 可执行宿主 git（fetch/commit/push 已验证）；push 直连 GitHub 会被 RST，走代理即通（仓库级 `http.https://github.com.proxy`，由用户决定是否配置）
- isolation 模式注册时守门员检测 Windows 原生组件（.dll/.exe + 原生模块），命中拒绝并提示切 capability

### 钉钉 Stream 通道
- 钉钉 Stream 的心跳计时器只作用于本次 WebSocket，连接关闭时清除。心跳丢失后重连，连接失败会退避重试。旧 SDK 在重连期间残留心跳可导致 daemon 退出。
- 机器人 CALLBACK 每次投递都通过收到该投递的 WebSocket 按 `headers.messageId` 确认，包括重复投递。当前只订阅机器人 CALLBACK。
- 群指令必须同时通过发送者和会话授权。主动通知用显式配置的群，排查日志只输出必要的连接状态和投递标识。
- 配置 `notify.dingtalkReport.executable/configDir` 后，结束通知先创建并回读钉钉报告，再附「查看详情」按钮。报告链接按 Run 保存，发送重试复用同一文档。文档失败时仍发送原通知，错误写入 daemon 日志。
- 去重优先用机器人消息体的 `msgId`，缺失时用回调头的 `messageId`。**禁止内容级去重**，用户可以重新发送相同指令。
- `~/.codex/config.toml` 的 MCP 配置（如 GUI 的 node_repl）在 CLI 会话里可能依赖 GUI 会话变量而不可用；第三方标准 MCP（url/command 型）原生可用

### 任务指令和结果
- 普通任务默认不限时。创建任务可选 `timeout_min`（分钟），新 Run 在 `limits` 保存快照；旧的全局 `scheduler.taskTimeoutMin` 不再限制任务。历史 Run 没有快照时不推测旧设置。
- 无时限在执行器内使用 0，Windows / POSIX 受管进程与 Docker 都必须跳过截止时间判断，不能创建立即触发的 0 毫秒终止计时器。取消仍须确认执行器停止。
- 连接错误持续 2 分钟、无可见活动默认 10 分钟，只触发运行中状态提醒。私有推理进展不等同可见活动，长耗时工具也可能安静；提醒不停止任务、不释放槽位、不自动重试任务。
- Codex 接收用户的任务指令或续跑反馈。提交、推送和验收按适用的 skill 与用户指令执行。
- 普通任务按运行事件结算。正常退出、启动失败、超时和中断都显示为「已结束」，详情保留运行事实和 Agent 答复。只有适配器事件或有效的旧版 `###AGENTCTL_BLOCKED###` 请求才进入「等待确认」。旧版 `###AGENTCTL_RESULT###` 继续作为结果详情读取。
- Codex 适配器通过 `--output-schema` 接收最终答复中的必需输入请求。任务提示词和原会话续跑反馈按原文传递。
- 支持 codex / zcode / deepseek，项目提供 Agent、模型与推理强度的默认值，新任务可独立覆盖；钉钉沿用项目默认值。Task 创建时保存 agent_id / model / execution，Run 保存该轮绑定；旧 Task 按 Codex 兼容，不能用项目当前 Agent 覆盖历史任务或跨 Agent 恢复会话。
- 宿主执行入口由 agent-runtime.ts 按 Agent 发现；ZCode 桌面内置 zcode.cjs 通过原生会话协议运行，DeepSeek 桌面通过官方 dsh-desktop-host CLI 的 headless --json 运行。模型使用会话参数或单次覆盖层，禁止修改用户的 Agent 默认配置。新增 Agent 的隔离镜像未验收时明确拒绝 isolation。
- 用 `继续 <编号> [说明]` 或 `resume <编号> [说明]` 续跑，编号可带 `#`。用户明确续跑时，能力优先任务可以接着处理当前工作树上的 Git 操作。
- 展示 agent 总结时用 `stripAgentctlLines()` 剥离协议标记行，别让协议原文漏给用户
- CLI、Web、桌面端和钉钉共享 daemon 的六种任务状态。详情列出明确记录的卡点和待完成事项。历史任务、Run 和会话保留原始数据。
- 取消运行中的 Agent 时，先持久化针对当前 Run 的请求，再停执行器。确认退出后才释放执行槽。宿主用受管进程树，隔离模式用对应容器。取消保留已有改动和日志。
- 钉钉「状态 <编号>」展示 Agent 最近消息、原始描述与本轮描述，不重复附活动列表或运行中日志路径；独立「最近活动」和 CLI `desk activity <编号>` 仍可查询。活动时间是 daemon 收到事件的时间，完整输出保留在 Run 日志。
- 钉钉面向用户的指令为「项目 / 开始 / 状态 / 继续 / 取消 / 帮助」。草稿在 Web 或桌面端保存，用「开始 编号」启动；「重试」兼容别名转为「继续」。CLI 与 Web 保留独立重试能力。
- 钉钉语言设置保存在任务数据目录的 settings 表，可选 auto / zh-CN / en。自动模式按已授权用户的指令语言判断，群通知跟随群最近的指令语言；固定语言即时覆盖。机器人消息没有客户端语言字段。用户任务和 Agent 答复保持原文。

### 进程管理
- **重启 daemon 前后清点 node 进程**：历史孤儿实例各持一条钉钉 WS 连接 → 消息被多实例重复消费/回复（双回复事故根因之一）。单实例锁（daemon.lock + PID 活性检查）是兜底，不是借口
- vite（5173）与 daemon 是独立进程，清 node 会连带杀掉，注意分别拉起

## 历史里程碑（Windows 已实测；Mac 见 docs/compatibility.md）

- [x] M0 技术探针（11/11：容器执行/事件流/会话持久化/跨容器 resume）
- [x] M1 核心循环（队列/调度/host-dir/checkpoint/CLI）
- [x] M2 Web 看板（项目主导 + 六栏队列 + 草稿队列 + 详情）
- [x] M3 钉钉闭环（三态通知 + 手机派单/批复/续跑，单机器人双职责）
- [x] M4/M4.5 环境冲刺（宿主 git/依赖三层/MCP 声明/熔断/双模式/沙箱提升/doctor/结果协议）

## 待办（M4.5 backlog）

- cron 定时任务、额度熔断、阻塞时效策略（24h 未处理提醒/过期）
- 运行中任务插话
- 并发放开实测（`AGENTDESK_SCHEDULER__CONCURRENCY=2`，架构已预留）
- compose 部署食谱
- 真实 Mac 安装与各 Agent 的运行验收

## 测试约定

- 改动 daemon/runner 后：typecheck → 重启 daemon → 用 selftest 派任务回归
- 钉钉相关改动：真发一条消息对账（推送卡片/回复内容）
- 不要动 `D:\work2\onshape-web-cad`（用户真实项目）——除非任务明确要求，且写操作先征得同意
