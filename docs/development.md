# 开发与发布

需要 Node.js 24+、npm 和 Git。内部包名、环境变量前缀和用户数据目录保留 agentdesk，避免升级时丢失已有配置。

```sh
npm ci
npm run typecheck
npm test
npm run build -w apps/web
npm run desk -- start
```

测试和首次验证使用独立的数据、日志与工作目录，不读取或改写维护者的真实项目。开发时也可以分别运行 `npm run daemon` 和 `npm run web`。

## 构建

```sh
npm run release:runtime
node scripts/smoke-runtime.mjs dist/运行时目录名
npm run package:desktop -- dist/运行时目录名 dist/installers
```

在目标系统和 CPU 架构上构建。运行时包含 Node.js、Web、CLI、daemon、生产依赖及许可证；桌面包额外包含 Electron。输出目录必须不存在，避免静默覆盖候选包。

`npm run ci:build` 串行完成以上步骤。`.github/workflows/build.yml` 在 Windows x64、Mac ARM 和 Mac Intel 上执行测试、运行时回归及客户端打包，保存安装包和 SHA-256 附件。模拟执行器回归包含正常执行、原会话续跑、日志目录重启切换和离线故障诊断。

## 发布检查

1. 核对版本、许可证、文档链接和兼容性声明；运行类型检查及全量测试。
2. 检查 Git 文件和历史中没有凭证、`.env`、用户数据库或真实项目内容。
3. 使用同一个已验证提交的跨平台 CI 产物发布，不拼接不同提交的安装包。
4. 核对产物哈希，在独立用户目录实际下载、安装并执行诊断。
5. 真实 Agent 的登录、运行、续跑和取消需在目标系统验收。没有验证的范围明确标为预览。

Windows 安装器默认按当前用户安装并保留卸载后的任务数据。当前预览包可能未签名。Mac 构建支持通过 CI secrets 提供 `CSC_LINK`、`CSC_KEY_PASSWORD` 和 Apple 公证凭证；配置前不得宣称已完成签名或公证，不要将凭证提交进仓库。

新版本部署到已有用户环境前，先确认活动任务和运行实例，记录原程序、数据及日志位置。只停止归属明确的 daemon，不批量结束所有 Node 进程。
