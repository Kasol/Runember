# agentdesk

把"人盯着 Codex 跑任务"变成"**人离线也能按计划推进、阻塞能找人、回来能看总结**"的无人值守工作台。

- 离线自动执行：任务队列串行推进（架构预留并行），同项目互不竞态
- 阻塞闭环：agent 卡住时**主动上报**（缺权限 / 需决策 / 额度耗尽）→ 钉钉群推送问题原文 → 人在手机上批复 → 同一会话上下文续跑
- 直接在你的真实项目目录里干活（git checkpoint 做安全网），代码不出本机
- 多 Agent 架构：已接 Codex CLI，新增 Claude Code / Gemini CLI 只需一个适配器文件
- 宿主机只依赖 Docker + Node；单机自托管、可开源

## 快速开始

前置：Docker Desktop（或 Engine）+ Node 22+。

```bash
npm install

# 1. 构建 runner 镜像并做技术自检（无需认证，约 1 分钟）
npm run m0:offline

# 2. 认证 Codex（二选一，订阅用户推荐 B）
cp .env.example .env        # A) 按量付费：填 CODEX_API_KEY
npm run m0:login            # B) ChatGPT Plus/Pro：终端出设备码 → 浏览器授权

npm run m0                  # 3. 完整探针：验证执行/事件流/会话持久化/resume（需认证）

# 4. 启动工作台
npm run daemon -- --data-dir ./data/agentdesk    # 保持运行（另开终端执行后续命令）
```

## CLI 使用手册（`npm run desk -- <命令>`）

### 日常主循环

```bash
npm run desk -- project add myapp D:/work/myapp   # 注册项目（git 仓库的本地绝对路径，一次即可）
npm run desk -- run myapp "重构 utils 目录并补全单元测试"   # 挂任务，立即入队
npm run desk -- status                            # 看全部任务（状态/所属项目）
npm run desk -- status 7                          # 看任务详情：每次 run 的状态与 agent 总结
```

- `run` 后任务进入队列，由 daemon 按并发配置自动调度执行（挂完就可以关电脑走人，前提是 daemon 所在机器不睡）
- 任务在**你注册的真实目录**里直接改文件；每个任务开始前自动做 checkpoint commit（回滚锚点），结束后 `status <id>` 可看 agent 总结与改动清单
- 约定：agent **不会**主动 `git push`；不满意可 `git reset --hard` 回到 checkpoint

### 阻塞与反馈

```bash
npm run desk -- status                    # 发现 [blocked] 任务
npm run desk -- resume 7 "可以合并，但今晚不部署"   # 带决定续跑（同一会话上下文）
npm run desk -- resume 7                  # 不带决定 = "请继续"
npm run desk -- retry 7                   # 重跑（全新执行）
npm run desk -- cancel 7                  # 取消（running 状态暂不支持在线取消）
```

> 有多个阻塞任务时 `resume` 必须带编号；只有一个时编号可省略。

### 认证

```bash
npm run desk -- auth codex     # 设备码登录（终端出码 → 浏览器授权 → 凭证写入共享卷）
```

凭证存在 `agentdesk-codex-home` 卷中，所有任务容器共享；token 过期会触发 `auth_missing` 阻塞，重跑本命令即可。

### 通知通路自检

```bash
npm run desk -- notify-test    # 向所有已配置的钉钉渠道发测试消息
```

## 钉钉闭环配置（可选，强烈推荐）

配置文件：`~/.agentdesk/config.json`（用户级，不入库）。

**单机器人方案**（推荐）：创建钉钉企业内部应用（[dev.dingtalk.com](https://dev.dingtalk.com)，个人团队即可自审批），添加**机器人**能力且消息接收模式选 **Stream 模式**，发布应用并把机器人拉进群：

```json
{
  "notify": {
    "channels": [{ "type": "dingtalk-app", "events": ["blocked", "failed"] }]
  },
  "feedback": {
    "dingtalkStream": {
      "clientId": "应用的 Client ID（AppKey）",
      "clientSecret": "应用的 Client Secret（AppSecret）"
    }
  }
}
```

重启 daemon 生效。之后任务阻塞时群里会收到问题原文，直接在群里 `@机器人 resume 你的决定` 即可完成反馈——全程手机操作，通道纯出站（零公网暴露、零内网穿透）。

**极简方案**（只要通知不要反馈）：群里添加"自定义"webhook 机器人（安全设置选**加签**），配置改为：

```json
{
  "notify": {
    "channels": [{
      "type": "dingtalk-webhook",
      "access_token": "webhook 地址里 access_token= 后的串",
      "secret": "SEC 开头的加签密钥",
      "events": ["blocked", "failed"]
    }]
  }
}
```

群内指令语法（Stream 模式）：`resume/继续 [id] <决定>`、`retry/重试 <id>`、`cancel/取消 <id>`、`status/状态`、`帮助`。首次使用需 @ 机器人任意发言一次以激活该群的主动推送（daemon 自动学习并持久化群标识）。

## 配置分层

优先级从低到高：代码默认值 → `~/.agentdesk/config.json` → 环境变量 `AGENTDESK_节__键`（如 `AGENTDESK_SCHEDULER__CONCURRENCY=2`）→ CLI 参数。

常用项：`scheduler.concurrency`（全局并发，v1 默认 1）、`scheduler.taskTimeoutMin`（单任务超时）、`agents.*.image`（执行镜像）、`proxy.httpsProxy`（容器内代理，如 `http://host.docker.internal:7897`）、`server.token`（API 鉴权）。

## 里程碑

- [x] M0 技术探针：容器执行 / 事件流 / 会话持久化 / 跨容器 resume（11/11 PASS）
- [x] M1 核心循环：monorepo + SQLite 队列 + 调度器 + host-dir 执行 + CLI（验收通过）
- [x] M3 钉钉闭环：阻塞推送 + 手机批复续跑，单机器人双职责，端到端验收通过
- [ ] M4 cron 计划 + 额度熔断 + 运行中任务插话/取消 + 并发放开
- [ ] M2 Web 看板：任务/日志/总结 GUI + 自由对话面板

## 目录

```
packages/core            # 纯领域层：状态机 / blocked 分类 / 调度闸门 / 扩展接口（零 IO）
packages/adapters        # Agent 注册表 + CodexAdapter（新增 agent = 加一个文件）
apps/daemon              # 配置 / 存储 / 调度 / Runner / API / 通知 —— 常驻核心
apps/cli                 # desk 命令行
scripts/                 # M0 探针（保留为验证工具）
images/runner-codex/     # 任务执行容器镜像（git + 钉版本 codex）
docs/                    # 钉钉消息预览图等
```

## 已知限制

- Windows 下 Git Bash 裸 `curl -d` 会打坏中文（GBK 控制台），中文参数请走 CLI
- running 状态的任务暂不支持在线取消（杀容器在 M4）
- Docker Desktop 的 Windows bind mount 对超大仓库偏慢；体验不佳时可将仓库移入 WSL2 文件系统
