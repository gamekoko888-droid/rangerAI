# RangerAI

RangerAI 全栈 monorepo — 游侠出海 AI 中台协作工具。

## 结构

- **agent/** — 后端 Agent 服务（Node.js, WebSocket, Gateway 集成）
- **web/** — 前端 Web 应用（React + Vite + tRPC）

## 本地开发

- 建议先分别阅读 `agent/` 与 `web/` 子目录中的说明文件。
- 提交前请在对应子项目中运行测试与 lint，避免跨项目变更引入回归。

## 部署

部署目标：阿里云服务器 8.219.186.244
- agent → /opt/rangerai-agent/
- web → /opt/rangerai-web/
