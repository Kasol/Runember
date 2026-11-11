@echo off
rem agentdesk daemon Windows 启动器：UTF-8 控制台
chcp 65001 >nul
node --import tsx apps/daemon/src/index.ts %*
