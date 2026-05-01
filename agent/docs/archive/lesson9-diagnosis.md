## Lesson 9 - 启动错误诊断报告

### 1. Gateway 启动日志错误分析

**错误信息 1:**
```
2026-03-05T16:55:16.015Z [gateway] [plugins] failed to load plugin: Error: Cannot find module '@opentelemetry/api'
```
**错误原因:** OpenClaw Gateway 尝试加载一个插件时，找不到 `@opentelemetry/api` 这个 Node.js 模块。这通常意味着依赖没有正确安装或已损坏。Gateway 核心功能可能不受影响，但遥测（telemetry）相关功能可能无法正常工作。

**错误信息 2:**
```
2026-03-05T16:55:19.417Z [telegram] setMyCommands failed: Call to 'setMyCommands' failed! (400: Bad Request: BOT_COMMANDS_TOO_MUCH)
2026-03-05T16:55:19.423Z [telegram] command sync failed: GrammyError: Call to 'setMyCommands' failed! (400: Bad Request: BOT_COMMANDS_TOO_MUCH)
```
**错误原因:** Telegram 机器人命令同步失败。错误代码 `400: Bad Request: BOT_COMMANDS_TOO_MUCH` 表明尝试向 Telegram API 注册的命令数量过多，超出了其限制。这可能是由于系统内部注册了过多的 bot 命令，或者在短时间内频繁更新命令导致。
