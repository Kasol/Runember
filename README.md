# agentdesk

把"人盯着 Codex 跑任务"变成"**人离线也能按计划推进、阻塞能找人、回来能看总结**"的无人值守工作台。

- 离线自动执行：任务队列串行推进（架构预留并行），同项目互不竞态
- 阻塞闭环：agent 卡住时**主动上报**（缺权限 / 需决策 / 额度耗尽）→ 钉钉群推送问题原文 → 人在手机上批复 → 同一会话上下文续跑
- 直接在你的真实项目目录里干活（git checkpoint 做安全网），代码不出本机
- 多 Agent 架构：已接 Codex CLI，新增 Claude Code / Gemini CLI 只需一个适配器文件
- 宿主机只依赖 Docker + Node；单机自托管、可开源

## 快速开始

Windows 用户可使用发布包，解压双击 **Start Agentdesk.cmd**。发布包带 Node 和 Web 看板，首次使用需安装宿主 Git 和 Codex CLI。详见 [Windows 快速上手](docs/windows-quickstart.md)。

源码运行前置为 Node 22+、Git 和宿主 Codex CLI。先按能力优先流程启动。

```bash
npm ci
npm run build -w apps/web
npm run desk -- doctor
npm run desk -- auth
npm run desk -- start
```

已有 Codex 登录时可通过 `doctor` 确认。默认 Web 地址为 `http://127.0.0.1:8787`，可在页面添加 Git 项目。构建 Windows 发布候选包时使用 `npm run release:windows`。

隔离模式另需 Docker。下面是隔离模式与 M0 探针的开发流程。

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
- 普通任务在注册的目录执行。启动前用临时 Git 索引记录工作树，快照保存在 `refs/agentdesk/checkpoints/`。用 `status <id>` 查看快照 SHA 和改动清单，用 `git diff <快照SHA>` 检查差异。
- 处于合并、rebase 等 Git 操作中的工作区会阻塞派单。daemon 重启后会检查仍活跃的执行器，普通任务结果未知时标为中断，由你查看日志后决定续跑。

### 阻塞与反馈

```bash
npm run desk -- status                    # 发现 [blocked] 任务
npm run desk -- resume 7 "可以合并，但今晚不部署"   # 带决定续跑（同一会话上下文）
npm run desk -- resume 7                  # 不带决定 = "请继续"
npm run desk -- retry 7                   # 重跑（全新执行）
npm run desk -- cancel 7                  # 取消（running 状态暂不支持在线取消）
```

> `resume` 需要任务编号，反馈文字可省略。

### 自动化合并 GitHub PR

给 `capability` 项目派合并任务前，把要发布的改动提交到源分支。用 daemon 的运行账号安装并登录 GitHub CLI，验证 `gh auth status --hostname github.com`、`gh pr list --repo OWNER/REPO` 和 `git ls-remote origin`。同一账号还需要能为 `origin` 推送分支。daemon 支持通过 PATH、`AGENTDESK_GH_PATH` 指定的路径或仓库内 `data/tools/gh.exe` 找到 `gh`。

宿主 GitHub HTTPS 流量需要代理时，在启动 daemon 的环境里设置 `AGENTDESK_MERGE_HTTPS_PROXY`。交互登录 `gh` 时使用同一个代理地址作为 `HTTPS_PROXY`。

```bash
npm run desk -- merge myapp --source feature_from_main_dev --base main --test "npm ci && npm test"
npm run desk -- status 7
npm run desk -- retry 7
```

将测试命令换成目标仓库的全量测试命令，包含独立工作树需要的依赖安装。daemon 在独立工作树 rebase 和测试，随后推送任务专用分支，创建或复用 GitHub PR，并对已验证的 head 执行 Rebase 合并。等待 CI 时任务保留在队列，约 30 秒后复查。远端 base 前移会触发重新 rebase 和测试。仓库必须允许 Rebase 合并，流程受必需检查、审批及合并队列规则约束。

冲突时，状态和运行日志会提供独立工作树路径。按项目约定解决冲突，在该路径完成 `git rebase --continue` 后，用 `retry` 继续。完成后会清理任务专用分支和工作树。需要同时退役源分支时，在派单时加 `--retire-dev`。源分支已前移或本地仍被检出时，会保留对应分支。自动化合并任务通过 CLI/API 管理，钉钉可接收状态通知。远程 API 操作需要配置 token。

### 认证

```bash
npm run desk -- auth                # 能力优先，登录本机 Codex
npm run desk -- auth --isolation    # 隔离模式，登录共享容器卷
```

宿主任务使用当前系统账号的 Codex 登录。隔离模式凭证写入 `agentdesk-codex-home` 卷。

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
    "channels": [{
      "type": "dingtalk-app",
      "conversationId": "主动推送的目标群 ID",
      "events": ["blocked", "failed"]
    }]
  },
  "feedback": {
    "dingtalkStream": {
      "clientId": "应用的 Client ID（AppKey）",
      "clientSecret": "应用的 Client Secret（AppSecret）",
      "allowedSenderIds": ["获准操作的钉钉 senderStaffId 或 senderId"],
      "allowedConversationIds": ["获准发指令的会话 ID"]
    }
  }
}
```

重启 daemon 生效。普通任务阻塞时，群里会收到问题和任务编号。可在群里发 `@机器人 继续 7 你的决定`。

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

群内指令以 `@机器人 帮助` 为准。发送者和会话都要命中授权列表。主动通知使用渠道上显式设置的 `conversationId`。

首次配置时，在宿主机生成一段 16 位随机十六进制文本，让待授权用户在指定群里发 `@机器人 agentdesk-pair <随机文本>`。在 daemon 本机日志里核对这段文本的 SHA-256 对应的「本机授权核对」，将其中的 `sender` 和 `conversation` 填入授权列表，重启生效。

## 配置分层

优先级从低到高：代码默认值 → `~/.agentdesk/config.json` → 环境变量 `AGENTDESK_节__键`（如 `AGENTDESK_SCHEDULER__CONCURRENCY=2`）→ CLI 参数。

常用项：`scheduler.concurrency`（全局并发，v1 默认 1）、`scheduler.taskTimeoutMin`（单任务超时）、`agents.*.image`（执行镜像）、`proxy.httpsProxy`（容器内代理，如 `http://host.docker.internal:7897`）、`server.token`（API 鉴权）。

宿主 Codex 和容器代理可以分别设置。用 `AGENTDESK_PROXY__NATIVEHTTPSPROXY` 或 `proxy.nativeHttpsProxy` 配置宿主 HTTPS 代理，HTTP 对应 `nativeHttpProxy`。

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
| `execution` | `'capability'`（默认，Codex 以当前用户身份运行）或 `'isolation'`（Linux 容器） |
| `extraPackages` | 项目级系统依赖（如 `["resvg"]`）→ daemon 预装进项目专属镜像（`curl` 实战验证） |
| `mcpServers` | 声明任务需要的 MCP server 名 → 渲染进容器内 codex config.toml（需先在 `~/.agentdesk/config.json` 的 `agents.codex.mcp` 登记地址；未登记的声明会被跳过并告警） |

内建安全机制（自动运行，无需配置）：

- **git 安全网在宿主侧**：checkpoint/审计由 daemon 用宿主 git 执行（继承你的 LFS/filemode 配置），容器不触碰 `.git`
- **循环熔断**：任务 1 小时内阻塞 ≥3 次，通知升级为"需要人工修复环境"，不再无限循环
- **契约环境规则**：agent 被告知系统级依赖装不了就精确上报一次（附安装方式），不反复重试
- **注册时自动配置**：项目仓库自动设 `core.filemode=false`（跨容器权限位噪音根治）；宿主未装 git 拒绝注册并提示

环境自检用 `npm run desk -- doctor`。隔离模式追加 `--isolation`，自动化合并额外检查追加 `--merge`。

## Web 看板使用手册

Windows 发布包双击 **Start Agentdesk.cmd** 即可。源码开发时先构建 Web，再运行 `npm run desk -- start`。默认地址为 `http://127.0.0.1:8787`。顶部可以添加项目和查看宿主环境检查。

1. **派发任务**。点「新建任务」，选择项目并填写描述，然后选择「立即执行」或「存草稿」。
2. **查看进度**。看板约每 3 秒刷新，分开显示草稿、进行中、阻塞、完成、失败、取消。排队任务可取消。
3. **查看详情**。卡片或 `?task=<编号>` 可打开详情，查看总结、运行历史、checkpoint、日志尾部以及合并任务的 PR。
4. **处理阻塞**。普通任务可带决定续跑。合并任务可核对并继续已有合并进度。
5. **失败重试**。点击失败任务卡片上的「重试」重新运行。

关闭浏览器后 daemon 会继续执行队列。执行期间需保持 daemon 和宿主机运行。隔离模式还需要 Docker。

启用 `server.token` 后，在看板输入连接密钥。CLI 默认读取同一配置，也可用 `AGENTDESK_TOKEN` 指定。启动或连接失败时用 `desk logs` 查看 daemon 最近日志。

开发 Web 源码时可以单独运行 `npm run web`。开发服务器的 `/api` 代理默认指向 `127.0.0.1:8787`，使用其他端口时同步调整 `apps/web/vite.config.ts`。

## 手机派单（钉钉群）

```
@agentdesk 执行 <项目名> <任务描述>
@agentdesk 草稿 <项目名> <任务描述>
@agentdesk 执行 55
@agentdesk 继续 55 可以合并，今晚不部署
@agentdesk 状态 55
```

只有一个项目时可省略项目名。编号支持 `55`、`#55`，也可写 `55 继续` 或 `55 取消`。`状态` 查看队列，`状态 55` 查看单条任务，`详情` 等旧查询入口也会转到「状态」。

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
