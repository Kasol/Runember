# 安装 Runember

当前 Windows / Mac 团队内测版为 `v2.2.0-beta.5`：[下载发布包](https://github.com/Kasol/Runember/releases/tag/v2.2.0-beta.5)。Mac 提供 Apple Silicon / Intel 构建，实机安装与 Agent 运行验收仍待完成。

## 选择安装方式

| 使用方式 | Windows | Mac |
|---|---|---|
| 桌面客户端 | `Runember-版本-win-x64.exe`，或客户端 zip | 选择与你机器匹配的 `Runember-版本-mac-arm64.dmg` / `mac-x64.dmg` |
| Web + CLI 后台运行时 | `runember-版本-windows-x64.zip` | `runember-版本-macos-arm64.tar.gz` / `macos-x64.tar.gz` |

桌面客户端自带运行时。无界面运行时提供同一套任务能力，通过浏览器和 CLI 使用，不含托盘窗口。

## 桌面安装

### Windows

1. 下载 `.exe` 安装程序，或将客户端 zip 解压到自己有写入权限的目录。
2. 在安装向导中选择程序安装目录，可以使用默认位置或其他盘上自己有写入权限的目录；安装完成后打开 `Runember.exe`。
3. 首次启动使用随附运行时；已有用户会继续使用此前保存的运行时位置。

无需先安装 Node.js。安装程序默认按当前用户安装，不要求把后台服务注册成系统服务。

程序安装目录与用户数据目录是两回事：Electron 客户端配置在 `%APPDATA%\agentdesk`（保留内部兼容名），任务数据默认在 `%USERPROFILE%\.agentdesk`，日志默认跟随任务数据。把程序安装到 D 盘不会自动移动这些用户数据；日志目录可在环境设置中调整。

未签名的内测安装包可能被 Windows「智能应用控制」拦截。遇到拦截请保留系统提示，等待维护者提供可信签名版本，不需要关闭系统安全功能。校验 SHA-256 只能核对下载文件，不能代替发布者的代码签名；便携 zip 中的程序也可能被拦截。[微软代码签名说明](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)

### Mac

1. Apple Silicon 机器选 `arm64`，Intel 机器选 `x64`；不确定时查看「关于本机」。
2. 打开 dmg，将 `Runember.app` 拖到「应用程序」，再打开应用。
3. 预览包可能尚未签名或公证。如果 macOS 拦截，请由用户按组织安全策略确认，或使用终端运行时；不要关闭 Gatekeeper 或批量清除系统安全属性。

Mac 版本的真实 Agent 验收状态见 [兼容性说明](compatibility.md)。

## 首次配置

1. 安装 [Git](https://git-scm.com/downloads)，以及你要使用的 Agent。只需至少一个 Agent，不要求同时安装三个。
2. 在对应 Agent 中完成登录或供应商配置，确认该 Agent 本身能正常执行任务。Runember 不替用户创建模型账号或填入密钥。
3. 打开顶部「环境设置」，检查实际 CLI 路径。自动检测不到时手动选择入口。
   若 Codex 出现连接失败，可在「Agent 网络代理」填入本机实际代理地址并检测连接；不需要代理时保留默认。不要照抄他人的端口。
4. 选择日志目录。保存后重启后台服务才会切换新日志；默认跟随任务数据目录。
5. 打开「诊断中心」，按提示处理必要依赖。没有使用的 Agent 显示为可选，不应阻止你使用已配置的 Agent。
6. 添加一个本机 Git 项目，选择 Agent 与可选模型。
7. 选中项目，新建只读任务：`读取当前目录 package.json 的 name，不修改文件，报告结果。`

不要使用包含真实发布、推送或删除操作的任务做首次连接测试。

## 终端运行时

Windows 解压后执行：

```powershell
.\runember.cmd doctor --json
.\runember.cmd start
```

Mac 解压后，在运行时目录执行：

```sh
./runember doctor --json
./runember start
```

默认页面为 `http://127.0.0.1:8787`。旧命令 `desk` 与 `desk.cmd` 同样可用。启动命令独立运行后台服务，关闭终端或浏览器不会主动停止它；电脑仍需保持开机，不能休眠。

## 让 Agent 自动安装

使用 [Agent 安装说明](INSTALL_FOR_AGENTS.md)。Agent 会先请你选择「桌面客户端」或「CLI + Web」，并确认程序安装位置、说明用户数据位置；你已经指定时直接按指定方式安装。AI 的目录权限提示是对其文件操作的授权，不是安装目录选择器。

选择桌面客户端时，下载对应系统和架构的桌面安装包；选择 CLI + Web 时，使用 `scripts/install.ps1` 或 `scripts/install.sh` 下载运行时并校验 SHA-256。脚本不要求预装 Node.js，不修改系统 PATH，不覆盖用户配置。

## 升级与卸载

- 先停止后台服务，等待活动任务结束，再升级程序。
- 脚本按版本安装到新目录；保留旧程序，方便切回。新版本继续读取原来的用户配置和任务数据库。
- 旧数据目录为 `~/.agentdesk`，品牌改为 Runember 后仍保留此位置。
- 更换日志目录不自动移动历史文件；历史任务继续记录原来的日志路径。
- Windows 卸载程序默认保留用户数据。Mac 删除应用也不代表删除任务和日志。
- 如果不再使用钉钉通知，请先停止对应后台服务，避免旧进程继续接收群消息。

## 故障排查

从「诊断中心」开始。后台服务无法启动时，可在终端执行 `runember doctor --json`，或使用客户端「帮助 → 本机诊断」。详见 [故障排查](troubleshooting.md)。
