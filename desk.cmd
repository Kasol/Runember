@echo off
rem agentdesk CLI Windows 启动器：切 UTF-8 代码页，规避中文乱码（GBK 控制台 + npm 管道）
chcp 65001 >nul
node --import tsx apps/cli/src/index.ts %*
