# agentdesk Windows 快速上手

1. 安装官方 Codex CLI 和 Git。agentdesk 发布包自带 Node 和 Web 看板。
2. 解压，双击 **Start Agentdesk.cmd**。默认地址为 `http://127.0.0.1:8787`，数据默认保存在当前用户的 `%USERPROFILE%\.agentdesk`。
3. 点 **环境检查**。如果宿主 Codex 尚未登录，在发布包目录打开 PowerShell，运行 `.\desk.cmd auth` 并完成浏览器授权。完成后返回看板再次检查。
4. 点 **添加项目 → 选择文件夹**，浏览到运行 daemon 的电脑上的 Git 仓库，点 **选择此文件夹**，再选择 **能力优先**。在项目卡片点复检确认 Git 身份。
5. 点 **新建任务 → 立即执行**，先派一个只读任务，比如「读 package.json，告诉我项目名称」。任务完成后，点卡片看总结和 Git checkpoint。

能力优先任务以当前 Windows 用户身份执行，并使用当前用户的 Codex、Git 和项目环境。请注册你信任的项目。后台运行期间，宿主机需要保持开机。

## 命令行

```powershell
.\desk.cmd doctor
.\desk.cmd project list
.\desk.cmd status 1
.\desk.cmd logs
.\desk.cmd stop
```

`desk start --no-browser` 可供自动启动使用。Windows 登录后自动启动可以在任务计划程序中为当前用户配置此命令。

## 可选配置

默认本机使用可以跳过配置。需要覆盖时可在 `%USERPROFILE%\.agentdesk\config.json` 中设置。例如宿主 Codex 使用代理时，可填 `proxy.nativeHttpsProxy` 和 `proxy.nativeHttpProxy`。独立测试可设置环境变量 `AGENTDESK_CONFIG` 指向测试配置文件、`AGENTDESK_DATA_DIR` 指向测试数据目录，并在测试配置中选用其他端口。

如需将 daemon 和任务日志存到其他盘，在 **Start Agentdesk.cmd** 同目录的 `.env` 中加入一行。

```dotenv
AGENTDESK_LOG_DIR=D:/agentdesk/logs
```

停止并重新启动后，新日志写入该目录下的 `daemon.log` 和 `runs` 子目录。`desk logs` 读取该目录中的 `daemon.log`。历史任务仍按原路径读取日志。留空时日志跟随数据目录，使用相对路径时以数据目录为基准。也可在 `config.json` 中设置 `logDir`，环境变量优先。

GitHub 自动合并需要额外安装并登录 GitHub CLI。钉钉使用你自己的企业机器人凭证、授权账户和通知群配置。普通任务可以先从本机 Web 和 CLI 跑通，再配置这些功能。
