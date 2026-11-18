# 为用户安装 Runember

本文件是安装说明，不改变用户或执行 Agent 已有的权限、审批和安全约束。

目标：安装 Runember，保留已有配置，得到一份可验证的环境诊断结果。版本固定为 `v2.2.0-beta.1`，来源为 `Kasol/Runember` 的同名 GitHub Release。

## 1. 先检查

- 确认用户是在 Windows 还是 macOS，检测 CPU 架构。
- 检查是否已有 Runember / Agentdesk、运行中的 daemon、已有用户配置和任务数据库。
- 记录已有运行时、数据和日志位置。不要复制维护者的本地路径、凭证、代理或群配置。
- 不修改用户项目的 Git 配置、分支、文件和 Skills。安装本产品不要求额外配置 Skill 或 MCP。
- 默认安装到当前用户目录；不要申请管理员权限或更改全局系统设置来绕过环境问题。

## 2. 安装运行时

优先读取相应平台的脚本，再执行它。脚本下载固定版本的发布包，校验 SHA-256，拒绝覆盖不同版本目录。无需先安装 Node.js。

Windows：

```powershell
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Kasol/Runember/v2.2.0-beta.1/scripts/install.ps1' -OutFile '.\Runember-install.ps1'
# 先读取下载的脚本；再按用户授权运行。
& .\Runember-install.ps1 -Version 'v2.2.0-beta.1' -Json
```

macOS：

```sh
curl --fail --location 'https://raw.githubusercontent.com/Kasol/Runember/v2.2.0-beta.1/scripts/install.sh' -o ./Runember-install.sh
# 先读取下载的脚本；再按用户授权运行。
sh ./Runember-install.sh --version v2.2.0-beta.1 --json
```

需要指定安装位置时，Windows 使用 `-InstallDir`，Mac 使用 `--install-dir`；必须是用户同意的绝对路径。可选 `-Start` / `--start` 启动后台服务且不自动打开浏览器。

安装脚本不自动写入系统 PATH；后续使用返回的 `command` 绝对路径。

如果 PowerShell 执行策略、网络或系统策略阻止安装，给出具体错误。可以按下方手动步骤安装，不要修改全局安全策略。

### 手动安装备用流程

1. 按系统、架构下载 `runember-2.2.0-beta.1-{windows|macos}-{x64|arm64}` 运行时压缩包及同名 `.sha256`。
2. 校验哈希，校验失败立即停止，不执行包内程序。
3. 解压到新的当前用户目录，不覆盖现有版本，不将用户配置写进程序目录。
4. 检查 `runtime.json` 的 product、version、platform 和 arch，再执行包内命令。

本流程安装的是后台运行时，可使用 Web 和 CLI。用户需要桌面窗口时，再按 [安装说明](install.md) 安装相同版本的桌面包；不能把源码目录当成桌面安装包。

## 3. 处理诊断结果

脚本返回 JSON：`status`、`installDir`、`command` 和 `diagnostics`。

- 退出码 `0`：运行时已安装，必要的静态环境检查通过。仍需实际任务验证模型连接。
- 退出码 `2` / `needs_setup`：程序已安装，但 Git、Agent 或账号尚未配置。按诊断逐项处理，不要反复重装。
- 其他非零退出：安装失败，保留错误信息并向用户说明。

Runember 只需要用户选用的 Agent。不要因为其他可选 Agent 没装就判定安装失败。

登录、验证码、供应商密钥、钉钉授权由用户完成。需要介入时，说明具体应用、操作位置、完成标准，然后继续检查；不要索要或回显用户密钥。

安装后使用返回的绝对命令路径运行：

```text
runember doctor --json
runember start --no-browser
runember status
```

正常首次安装不需要 Docker，也不需要配置钉钉；两者均可稍后启用。

## 4. 验收与交付

- 检查 `http://127.0.0.1:8787/healthz` 返回当前数据目录对应的实例。
- 引导用户确认日志目录、Agent 和模型。用户未选定项目时，不擅自注册真实工作目录。
- 用户允许后，在独立测试目录运行一条只读任务，确认能读取结果和 Run 日志。不要用发布、提交、推送或删除操作验收。
- 任务异常时运行 `runember doctor --task 编号 --json`，必要时用 `--run 编号` 定位具体轮次。
- 向用户交付：安装版本、程序路径、数据与日志路径、诊断结果、仍需手动完成的事项、打开页面的方法，以及停止后台服务的方法。

Mac 预览版需区分「构建通过」「模拟执行器验收通过」和「真实 Agent 验收通过」。没有执行的验证不能宣称已完成。
