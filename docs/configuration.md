# 配置说明

## 配置与兼容

品牌为 Runember，兼容配置目录仍为 `~/.agentdesk`。配置文件是 `config.json`，任务数据库是 `agentdesk.db`。不要将个人配置或密钥提交到仓库。

默认值 → 用户配置文件 → 环境变量 → CLI 参数。环境设置保存的 CLI 入口和日志目录针对当前任务数据目录生效，覆盖对应文件及环境变量配置。显式启动参数 `--log-dir` 仍优先。

数据目录可通过 `AGENTDESK_DATA_DIR` 指定，配置文件可通过 `AGENTDESK_CONFIG` 指定。更换数据目录表示使用另一套任务数据库；更换日志目录不会更换数据库。

## 常用配置

```json
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "scheduler": { "concurrency": 1, "taskTimeoutMin": 30 },
  "logDir": "D:/Runember/logs"
}
```

Mac 日志路径示例：`/Users/你的用户名/Library/Logs/Runember`，请按实际用户名填写。

常用环境变量：`AGENTDESK_LOG_DIR`、`AGENTDESK_PORT`、`AGENTDESK_SCHEDULER__CONCURRENCY`、`AGENTDESK_SCHEDULER__TASKTIMEOUTMIN`。`.env` 从实际运行时目录加载；发布包不会携带维护者的 `.env`。

默认并发数为 1；同一工作目录有占用保护。提升并发前，应在自己的项目与 Agent 组合下验收，不要将多个安装实例指向同一用户数据目录来模拟并行。

## 模型与 Agent

在项目的 Agent 设置中选择执行器和可选模型。留空沿用 Agent 当前配置。任务创建时保存绑定；修改项目配置不会把历史任务切换到另一种 Agent。

「推理强度」默认沿用 Agent 配置，可按当前模型支持的选项单独指定。Codex 从本机模型缓存读取选项，ZCode 从模型规则读取选项，DeepSeek Harness 的原生官方模型支持 `off / low / high / max`。未知模型或未提供能力信息时仅可沿用 Agent 配置。切换 Agent 或模型后重新选择强度，Runember 不再替 ZCode 自动选择高强度。

强度只覆盖本轮执行，不修改 Agent 的全局设置。新建任务和草稿保存当时的选择，重试、续跑沿用原任务的选择；项目设置只影响后续创建的任务。任务详情、Run 历史、CLI 和钉钉运行信息展示已指定的强度；「沿用 Agent 配置」不代表 Runember 已观测到模型实际采用的强度。

CLI 可用 `runember project set 项目名 --reasoning-effort high` 指定，`--reasoning-effort auto` 恢复沿用 Agent 配置。可以通过 `GET /api/agents/Agent编号/reasoning?model=模型` 查看可选值，接口字段为 `reasoning_effort`，空值表示沿用。

登录、供应商、MCP 和 Skill 由对应 Agent 管理。Runember 自动发现安装位置，并允许手动指定 CLI 路径。ZCode 内置 CLI 的供应商文件路径会由适配器传入，无需给每条任务添加启动提示词。

## 网络代理

```json
{
  "proxy": {
    "nativeHttpsProxy": "http://127.0.0.1:你的代理端口",
    "nativeHttpProxy": "http://127.0.0.1:你的代理端口"
  }
}
```

仅在确有需要时配置；不要照抄维护者的端口。对应环境变量为 `AGENTDESK_PROXY__NATIVEHTTPSPROXY` 和 `AGENTDESK_PROXY__NATIVEHTTPPROXY`。

顶部「环境设置 → Agent 网络代理」可选择沿用启动配置，或指定 HTTP/HTTPS 代理地址。默认不添加代理覆盖；界面保存的地址对下一轮宿主 Agent 及其子进程生效，不修改系统代理、Agent 全局文件、容器代理或通知渠道。使用代理时保留原有 NO_PROXY 规则，并让 localhost / 本机回环地址直连，供本机 MCP、开发服务使用。恢复「沿用启动配置」会移除这项覆盖。CLI 对应 `runember proxy`、`runember proxy set http://127.0.0.1:端口`、`runember proxy set auto` 和 `runember proxy test`。

连接检测只访问 Codex 服务，不携带账号凭证、不调用模型。HTTP 401/403 表示服务返回了响应，不代表账号或模型验证通过；代理认证失败（407）和连接超时会明确提示。它不能保证其他供应商或长连接均正常。新 Run 会记录启动时的代理地址（不含认证信息），旧 Run 不推测历史代理设置。

Agent 持续报告连接错误时，任务仍为「运行中」，详情显示连接重试及最后有效活动时间；持续重连 2 分钟且没有有效进展会按已有失败通知订阅告警一次，恢复有效活动后提示一次。单纯长时间执行工具不会触发此告警。运行停止后显示「已结束 · 连接失败」或实际超时原因，连续同因失败会提示先检查连接，但不会阻止手动续跑或自动重放任务。已有任务状态和 Agent 会话保留。

DeepSeek Harness 不允许项目 `.env` 声明 `HTTPS_PROXY` / `HTTP_PROXY` 等启动变量，即使父进程已有同名变量也会拒绝启动。请使用上述 Runember 配置，由执行器通过进程环境传入；或在 Harness 用户级配置中设置代理。Runember 不会自动删除用户项目的 `.env` 或绕过这项检查。容器探针使用 `AGENTDESK_PROXY__HTTPSPROXY` / `AGENTDESK_PROXY__HTTPPROXY`，不要在宿主中使用 `host.docker.internal` 作为代理地址。

## 钉钉（可选）

首次安装可跳过。需要手机派单时，创建自己的钉钉企业内部应用机器人，使用 Stream 模式，发布后加入目标群。

```json
{
  "notify": {
    "channels": [{
      "type": "dingtalk-app",
      "conversationId": "你的目标会话 ID",
      "events": ["blocked", "failed", "succeeded", "cancelled"]
    }]
  },
  "feedback": {
    "dingtalkStream": {
      "clientId": "你的应用 ID",
      "clientSecret": "你的应用密钥",
      "allowedSenderIds": ["授权的发送者 ID"],
      "allowedConversationIds": ["授权的会话 ID"]
    }
  }
}
```

发送者与会话必须同时授权。`runember notify-test` 会真实发送测试消息，仅在你准备验证通知时执行。

群指令为「项目 / 开始 / 状态 / 继续 / 取消 / 帮助」。例如 `开始【项目名】描述`、`开始 55`、`状态 55`、`继续 55 补充说明`。群内不能创建草稿；草稿在 Web 或桌面端保存。

「查看详情」需要另外配置钉钉报告发布器及用户自己的文档授权；未配置时仍可在本机看板看完整详情。配置项为 `notify.dingtalkReport.executable`、`configDir`、可选 `profile` 和 `folder`。具体文档 CLI 安装与授权由该 CLI 的官方说明决定，不需要为运行普通 Agent 任务安装它。

钉钉界面语言在顶部「钉钉设置」选择 auto / 中文 / English，保存后即时生效。用户提示词和 Agent 答复保留原文。

## 隔离执行（进阶）

默认能力优先不要求 Docker。Codex 的 Linux 容器隔离模式是单独的执行选项，需要 Docker、镜像和容器凭证。ZCode、DeepSeek Harness 的隔离镜像未验收时明确拒绝。新用户先把能力优先模式跑通即可。
