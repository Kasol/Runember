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

接下来可使用下方 CLI，或按 [Web 看板使用手册](#web-看板使用手册) 启动浏览器工作台。

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
- [x] M3 钉钉闭环：阻塞推送 + 手机批复续跑（含派单），单机器人双职责，端到端验收通过
- [x] M2 Web 看板：三栏看板 / 任务详情（总结+日志）/ 页面派发与反馈
- [x] M4 环境冲刺：宿主侧 git 安全网 / 依赖三层通道 / MCP 声明 / 循环熔断 / NativeBackend / doctor
- [ ] M4.5 cron 计划 + 额度熔断 + 运行中任务插话/取消 + 并发放开

## 项目配置进阶（M4）

注册项目（`POST /api/projects`）支持的可选字段：

| 字段 | 说明 |
|---|---|
| `execution` | `'docker'`（默认，容器隔离）/ `'native'`（codex 直接跑宿主，原生速度零播种；⚠️ agent 以你的用户身份操作本机） |
| `extraPackages` | 项目级系统依赖（如 `["resvg"]`）→ daemon 预装进项目专属镜像（`curl` 实战验证） |
| `mcpServers` | 声明任务需要的 MCP server 名 → 渲染进容器内 codex config.toml（需先在 `~/.agentdesk/config.json` 的 `agents.codex.mcp` 登记地址；未登记的声明会被跳过并告警） |

内建安全机制（自动运行，无需配置）：

- **git 安全网在宿主侧**：checkpoint/审计由 daemon 用宿主 git 执行（继承你的 LFS/filemode 配置），容器不触碰 `.git`
- **循环熔断**：任务 1 小时内阻塞 ≥3 次，通知升级为"需要人工修复环境"，不再无限循环
- **契约环境规则**：agent 被告知系统级依赖装不了就精确上报一次（附安装方式），不反复重试
- **注册时自动配置**：项目仓库自动设 `core.filemode=false`（跨容器权限位噪音根治）；宿主未装 git 拒绝注册并提示

环境自检：`npm run desk -- doctor`（Docker / git / 镜像 / 凭证 / skills 五项）

## Web 看板使用手册

### 启动与访问

先完成「快速开始」中的依赖安装、runner 镜像构建与 Codex 认证。在项目根目录打开两个终端：

```bash
# 终端 1：启动后端，保持运行；已启动则无需重复执行
npm run daemon -- --data-dir ./data/agentdesk

# 终端 2：首次使用先注册要操作的项目（替换为实际的 git 仓库绝对路径）
npm run desk -- project add myapp /absolute/path/to/myapp

# 启动 Web 开发服务器，保持运行
npm run web
```

浏览器打开 http://localhost:5173，顶部显示「daemon 已连接」即可使用。若 5173 已被占用，以 Vite 终端输出的实际地址为准。Windows 项目路径可写为 `D:/work/myapp`；已注册的项目无需重复添加，当前页面不提供项目注册入口。

### 页面操作

1. **派发任务**：点击「＋ 派发任务」，选择项目、填写任务描述，再点击「入队」。任务由 daemon 自动调度，在所选项目的真实目录中执行。
2. **查看进度**：看板每 3 秒刷新一次。「阻塞」列展示等待处理的任务，「进行中」列包含排队和运行中的任务，「最近」列展示最近 12 条已完成、失败或取消的任务。
3. **查看详情**：点击任务卡片，查看任务描述、最新 run 的 agent 总结与改动文件概览、Run 历史及最新 run 的日志末尾（最多显示 40 行，每 3 秒刷新）。点击右上角「✕」或弹层外部关闭详情。
4. **处理阻塞**：在详情中填写决定，点击「带决定续跑」，即可在同一会话上下文中继续。留空或点击阻塞卡片上的「继续」会发送「请继续」；需要明确批复时请填写决定。阻塞任务也可在详情中点击「取消任务」。
5. **失败重试**：点击失败任务卡片上的「重试」，发起一次全新执行。运行中的任务暂不支持页面取消。

关闭浏览器或 Web 开发服务器后，daemon 仍可继续执行队列；执行期间需保持 daemon 和 Docker 运行，且宿主机不休眠。

### 连接配置与排查

- 默认由 Vite 将 `/api` 请求代理到 `http://127.0.0.1:8787`，本机默认配置无需额外设置。若修改 daemon 的监听端口，需同步调整 `apps/web/vite.config.ts` 中的代理目标，并重启 Web 开发服务器。
- 页面显示「daemon 离线」时，检查错误横幅、daemon 是否运行，以及代理目标是否与 daemon 地址一致；该提示也可能由 API 请求失败引起。
- 项目下拉框为空时，先通过上面的 `project add` 命令注册项目，等待页面下次刷新后再派单。
- 当前 Web 客户端未提供 token 输入，也不会发送 `x-agentdesk-token` 请求头；启用 `server.token` 后，默认 Web 请求会返回 401。此时可通过 `AGENTDESK_TOKEN` 环境变量为 CLI 提供对应 token，或自行接入能为 API 请求附加该请求头的代理。

当前 `npm run web` 启动的是 Vite 开发服务器。可运行 `npm run build -w apps/web` 构建静态资源（输出到 `apps/web/dist`）；daemon 不负责托管这些文件，部署时需另行配置静态文件服务及 `/api` 反向代理。

## 手机派单（钉钉群）

```
@agentdesk run <项目名> <任务描述>
@agentdesk run 给登录接口加限流        ← 仅一个项目时项目名可省
```

## 目录

```
packages/core            # 纯领域层：状态机 / blocked 分类 / 调度闸门 / 扩展接口（零 IO）
packages/adapters        # Agent 注册表 + CodexAdapter（新增 agent = 加一个文件）
apps/daemon              # 配置 / 存储 / 调度 / Runner / API / 通知 —— 常驻核心
apps/cli                 # desk 命令行
apps/web                 # React + Vite Web 看板：派单 / 任务详情 / 阻塞反馈
scripts/                 # M0 探针（保留为验证工具）
images/runner-codex/     # 任务执行容器镜像（git + 钉版本 codex）
docs/                    # 钉钉消息预览图等
```

## 已知限制

- Windows 下 Git Bash 裸 `curl -d` 会打坏中文（GBK 控制台），中文参数请走 CLI
- running 状态的任务暂不支持在线取消（杀容器在 M4）
- Docker Desktop 的 Windows bind mount 对超大仓库偏慢；体验不佳时可将仓库移入 WSL2 文件系统
