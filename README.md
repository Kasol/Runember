# Runember

本机 Agent 任务调度工作台：排队执行、查看过程、接收通知，并在需要时恢复原会话。

Runember 管理任务与执行器的生命周期。任务内部如何完成，由所选 Agent 及其提示词、MCP、Skill 和账号配置决定。

> 当前版本：**2.2.0-beta.1，团队内测版**。旧版 Agentdesk 的 `desk` 命令、配置目录和任务记录继续兼容。

## 开始使用

- **直接安装**：[下载发布包](https://github.com/Kasol/Runember/releases/tag/v2.2.0-beta.1)，按 [安装与首次配置](docs/install.md) 操作。
- **让自己的 Agent 安装**：把本页地址交给它，并附上：

  > 请按此仓库 docs/INSTALL_FOR_AGENTS.md 安装 Runember。先检查环境、保留已有配置，安装后运行诊断；需要登录或授权时明确告诉我。

- **遇到问题**：打开顶部「诊断中心」，或查看 [故障排查](docs/troubleshooting.md)。

## 有哪些能力

- 项目绑定 Codex、ZCode 或 DeepSeek Harness，可指定模型。
- 同一个项目可以保存草稿、安排任务、查询状态和最近活动。
- Task 记录用户任务，Run 记录每一轮执行；有会话时可恢复上下文继续。
- Web、Electron 客户端、CLI 和钉钉共享任务状态及操作入口。
- 支持运行中取消：确认执行器停止后释放执行槽，保留已经发生的改动。
- 支持环境诊断、按 Run 定位故障和预览导出诊断报告。
- 日志目录可配置，历史日志继续按原路径读取。

## 系统与安装包

| 系统 | 桌面包 | 无界面运行时 |
|---|---|---|
| Windows x64 | 安装程序 `.exe` / 便携包 `.zip` | `runember-版本-windows-x64.zip` |
| macOS Apple Silicon | `.dmg` / 应用 `.zip` | `runember-版本-macos-arm64.tar.gz` |
| macOS Intel | `.dmg` / 应用 `.zip` | `runember-版本-macos-x64.tar.gz` |

Mac 产物属于预览版；各 Agent 的平台验收范围见 [兼容性与验收](docs/compatibility.md)。发布包自带 Node.js 和 Web 页面，用户无需安装 Node.js。宿主仍需 Git，以及至少一个已安装、已配置账号的 Agent。

默认使用能力优先模式。Docker 仅用于可选的隔离执行，不是首次安装的必需项。

## 第一次运行

1. 打开客户端。首次安装自动使用随附运行时；已有用户继续使用保存的运行时路径。
2. 查看「使用引导」，到「环境设置」确认 Agent CLI 和日志目录。
3. 在对应 Agent 中完成登录或供应商配置，再打开「诊断中心」。
4. 添加项目，选择本机 Git 工作目录并绑定 Agent 和模型。
5. 选中项目，新建一个只读任务，例如：`读取当前目录 package.json 的 name，不修改文件，报告结果。`
6. 点击任务查看运行详情、最近活动和日志。

关闭客户端或浏览器不会停止独立运行的后台服务。**电脑必须保持开机并避免休眠**，本机任务才能继续执行。

## 任务状态

| 状态 | 含义 |
|---|---|
| 草稿 | 已保存，尚未安排执行 |
| 排队 | 等待执行槽或工作目录 |
| 运行中 | 调度器接手了本轮；取消过程中显示「正在停止」 |
| 等待确认 | Agent 明确提出需要用户回答或授权 |
| 已结束 | 本轮停止；详情区分正常退出、启动失败、超时和中断 |
| 已取消 | 用户取消，且执行器已确认停止 |

「已结束」描述执行事实。是否达到业务目标，需要结合 Agent 答复和产物判断。

## CLI

发布包内提供 `runember`；旧命令 `desk` 同样可用。Windows 对应 `runember.cmd` / `desk.cmd`。

```bash
runember doctor --json
runember agents
runember project add demo /absolute/path/to/repo --agent codex
runember run demo "读取项目说明并概括，不修改文件"
runember status 1
runember activity 1
runember resume 1 "继续处理待完成事项"
runember cancel 1
runember doctor --task 1 --json
runember doctor --task 1 --run 1 --output diagnostics.json
```

运行时文件夹没有自动写入系统 PATH。可以使用命令的绝对路径，或先进入运行时目录，在 Windows 执行 `.\runember.cmd`，在 Mac 执行 `./runember`。

## 配置、数据与日志

为兼容现有用户，默认用户配置仍为 `~/.agentdesk/config.json`，任务数据库为 `~/.agentdesk/agentdesk.db`。

顶部「环境设置」支持选择 CLI 路径和日志目录。日志目录保存后需重启后台服务；新日志使用新位置，已有文件不自动移动。`daemon.log` 是后台服务日志，`runs/*.jsonl` 是 Run 输出。

配置优先级：默认值 → 用户配置文件 → 环境变量 → CLI 参数。界面保存的 CLI 路径和日志目录针对当前任务数据目录生效，覆盖对应的文件及环境配置；显式 CLI `--log-dir` 参数仍可覆盖启动目录。

代理、端口、可选隔离模式和钉钉配置见 [配置说明](docs/configuration.md)。Agent 本身的会话、缓存、登录和模型调用仍由各 Agent 管理。

## 执行与数据边界

能力优先模式以当前用户身份运行 Agent，Agent 可以修改授权范围内的文件并执行外部操作。取消不自动回退这些操作。

任务在本机执行，不等于模型上下文永不外发；使用云端模型时，Agent 会按自身行为发送必要上下文。Runember 不会因诊断而另行上传完整日志、提示词或凭证文件，导出内容可先预览。

## 开发与构建

需要 Node.js 24+ 和 Git。

```bash
npm ci
npm run typecheck
npm test
npm run build -w apps/web
npm run desk -- start
```

构建命令、跨平台 CI 和发布步骤见 [开发与发布](docs/development.md)。

## 反馈问题

请提供系统、架构、版本、任务与 Run 编号，以及诊断报告中的错误代码。先预览报告并移除不希望公开的信息；不要提交账号凭证、完整项目代码或个人配置文件。

[提交 Issue](https://github.com/Kasol/Runember/issues) · [故障排查](docs/troubleshooting.md) · [MIT 许可证](LICENSE)
