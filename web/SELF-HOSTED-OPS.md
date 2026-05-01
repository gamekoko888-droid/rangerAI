# RangerAI 自主运维手册

> 本文档是 RangerAI 项目脱离 Manus 平台后的完整运维指南。所有操作均在阿里云服务器 `8.219.186.244` 上独立完成，无需任何外部平台依赖。

---

## 1. 系统架构总览

RangerAI 采用前后端分离架构，由 Caddy 反向代理统一对外提供 HTTPS 服务。

| 组件 | 端口 | 服务名 | 工作目录 | 说明 |
|------|------|--------|----------|------|
| Caddy | 443 | caddy | /etc/caddy/ | HTTPS 反向代理 + 静态文件服务 |
| OpenClaw Gateway | 18789 | openclaw-gateway | /home/admin | AI Agent 网关 |
| RangerAI Agent | 3002 | rangerai-agent | /opt/rangerai-agent/ | 后端 API + WebSocket |
| RangerAI ACP | 3003 | rangerai-acp | /opt/rangerai-agent/ | Agent Communication Protocol |
| RangerAI FileServer | — | rangerai-fileserver | /opt/rangerai-agent/ | 文件上传/下载服务 |
| 前端静态文件 | — | — | /var/www/rangerai/ | Caddy 直接提供 SPA 服务 |

### 请求路由

Caddy 根据 URL 路径将请求分发到不同后端：

- `/api/chats*`, `/api/auth*`, `/api/admin/*`, `/ws` 等 → **rangerai-agent** (3002)
- `/upload`, `/health`, `/files/*`, `/workspace/*` → **OpenClaw Gateway** (3001)
- `/acp/*` → **rangerai-acp** (3003)
- 其他路径 → **静态文件** (/var/www/rangerai/)，SPA fallback 到 index.html

---

## 2. 源代码位置

| 代码库 | 路径 | 说明 |
|--------|------|------|
| 前端源码 | `/opt/rangerai-web/client/src/` | React + TypeScript + Tailwind |
| 前端构建配置 | `/opt/rangerai-web/vite.config.standalone.ts` | Manus-free 独立构建配置 |
| 后端源码 | `/opt/rangerai-agent/` | Node.js ESM (.mjs) |
| 后端模块 | `/opt/rangerai-agent/modules/` | WebSocket、路由、AI 服务等 |
| 后端 API | `/opt/rangerai-agent/api/` | REST API 路由处理 |
| 后端 Worker | `/opt/rangerai-agent/worker/` | Agent 工作线程 |
| Caddy 配置 | `/etc/caddy/conf.d/` | 模块化 Caddy 配置 |
| OpenClaw 启动脚本 | `/opt/start-openclaw-gateway.sh` | Gateway 启动 + 环境变量 |

---

## 3. 前端修改与部署

### 3.1 修改前端代码

前端源码位于 `/opt/rangerai-web/client/src/`，主要目录结构：

```
client/src/
├── App.tsx              # 路由定义
├── pages/               # 页面组件（ChatPage, AdminDashboard, etc.）
├── components/          # 可复用组件
│   ├── chat/            # 聊天相关组件
│   └── ui/              # shadcn/ui 基础组件
├── hooks/               # 自定义 Hooks
├── lib/                 # 工具函数（api.ts, i18n.tsx, types.ts）
├── contexts/            # React Context
└── index.css            # 全局样式
```

修改代码后，按照以下步骤部署。

### 3.2 一键部署

```bash
# 方式一：使用部署脚本（推荐）
sudo bash /opt/rangerai-agent/deploy-frontend.sh

# 方式二：手动构建
cd /opt/rangerai-web
npx vite build --config vite.config.standalone.ts
sudo cp dist/index.html /var/www/rangerai/
sudo rm -rf /var/www/rangerai/assets
sudo cp -r dist/assets /var/www/rangerai/
```

部署完成后无需重启任何服务，用户刷新页面即可看到新版本。

### 3.3 安装新的前端依赖

```bash
cd /opt/rangerai-web
sudo pnpm add <package-name>
```

### 3.4 注意事项

- **必须使用** `vite.config.standalone.ts` 构建，不要使用 `vite.config.ts`（后者包含 Manus 调试插件）
- 构建输出目录为 `/opt/rangerai-web/dist/`
- 部署目标为 `/var/www/rangerai/`（Caddy 直接提供服务的目录）

---

## 4. 后端修改与部署

### 4.1 修改后端代码

后端采用 ESM 模块（`.mjs` 文件），主要入口：

| 文件 | 说明 |
|------|------|
| `server.mjs` | 主入口，启动 HTTP 服务器 |
| `modules/http-routes.mjs` | HTTP 路由注册 |
| `modules/ws-handler.mjs` | WebSocket 消息处理 |
| `smart-router.mjs` | LLM 智能路由（OpenRouter） |
| `database.mjs` | MySQL 数据库连接 |
| `auth.mjs` | JWT 认证 |
| `api/*.mjs` | 各业务 API 模块 |

### 4.2 部署后端

```bash
# 1. 语法检查（推荐先做）
bash /opt/rangerai-agent/validate-mjs.sh

# 2. 重启服务
sudo systemctl restart rangerai-agent

# 3. 检查状态
sudo systemctl status rangerai-agent
journalctl -u rangerai-agent -n 20 --no-pager
```

### 4.3 安装新的后端依赖

```bash
cd /opt/rangerai-agent
sudo npm install <package-name>
```

---

## 5. 服务管理命令

### 5.1 常用命令

```bash
# 查看所有服务状态
for svc in rangerai-agent openclaw-gateway rangerai-acp rangerai-fileserver caddy; do
  echo "$svc: $(systemctl is-active $svc)"
done

# 重启单个服务
sudo systemctl restart rangerai-agent

# 查看服务日志
journalctl -u rangerai-agent -f          # 实时跟踪
journalctl -u rangerai-agent -n 50       # 最近50行
journalctl -u rangerai-agent --since "1 hour ago"

# 重启所有服务
for svc in rangerai-agent rangerai-acp rangerai-fileserver openclaw-gateway; do
  sudo systemctl restart $svc
done
```

### 5.2 Caddy 管理

```bash
# 验证配置
caddy validate --config /etc/caddy/Caddyfile

# 重新加载配置（不中断服务）
sudo systemctl reload caddy

# 查看 Caddy 日志
journalctl -u caddy -n 20 --no-pager
```

### 5.3 数据库管理

```bash
# 连接 MySQL（Docker 内运行）
docker exec -it $(docker ps -q --filter name=mysql) mysql -u root -p

# 或使用 mysql 客户端（如已安装）
mysql -h 127.0.0.1 -P 3306 -u rangerai -p
```

---

## 6. 回归测试

服务器上内置了自动化回归测试脚本：

```bash
bash /opt/rangerai-agent/regression-test.sh
```

测试覆盖 7 大类 19 项检查：服务健康、API 端点、WebSocket、前端资产、Caddy 代理、数据库、代码语法。

---

## 7. 故障排查

### 7.1 前端白屏

```bash
# 检查 JS 文件是否存在
JS_FILE=$(grep -o 'index-[A-Za-z0-9_-]*\.js' /var/www/rangerai/index.html | head -1)
ls -la /var/www/rangerai/assets/$JS_FILE

# 如果文件不存在，重新构建部署
sudo bash /opt/rangerai-agent/deploy-frontend.sh
```

### 7.2 API 返回 502

```bash
# 检查后端是否在运行
systemctl status rangerai-agent
ss -tlnp | grep 3002

# 如果没在运行，重启
sudo systemctl restart rangerai-agent
journalctl -u rangerai-agent -n 30
```

### 7.3 WebSocket 断连

```bash
# 检查 WebSocket 端口
ss -tlnp | grep 3002

# 检查 Caddy WebSocket 配置
grep -A5 "/ws" /etc/caddy/conf.d/10-ranger-main.caddy

# 重启后端
sudo systemctl restart rangerai-agent
```

### 7.4 OpenClaw Gateway 无响应

```bash
# 检查 Gateway 状态
systemctl status openclaw-gateway
ss -tlnp | grep 18789

# 重启 Gateway
sudo systemctl restart openclaw-gateway
```

---

## 8. 关键配置文件

### 8.1 Caddy 配置（模块化）

```
/etc/caddy/
├── Caddyfile              # 主入口（import conf.d/*.caddy）
└── conf.d/
    ├── 00-global.caddy    # 全局设置
    ├── 10-ranger-main.caddy  # 主站点路由
    └── 20-gateway.caddy   # Gateway 子域名
```

### 8.2 Systemd 服务文件

```
/etc/systemd/system/
├── rangerai-agent.service
├── rangerai-acp.service
├── rangerai-fileserver.service
├── rangerai-web.service       # 注意：此服务已不再使用（Caddy 直接提供静态文件）
├── rangerai-static.service    # 注意：此服务已不再使用
├── openclaw-gateway.service
└── caddy.service
```

### 8.3 环境变量

后端环境变量存储在 `/opt/rangerai-agent/` 下的配置文件中，包含数据库连接、API 密钥等。OpenClaw Gateway 的环境变量在 `/opt/start-openclaw-gateway.sh` 中设置。

---

## 9. 备份与恢复

### 9.1 备份

```bash
# 备份前端源码
tar czf ~/backup-frontend-$(date +%Y%m%d).tar.gz -C /opt rangerai-web --exclude=node_modules --exclude=dist

# 备份后端源码
tar czf ~/backup-backend-$(date +%Y%m%d).tar.gz -C /opt rangerai-agent --exclude=node_modules

# 备份数据库
docker exec $(docker ps -q --filter name=mysql) mysqldump -u root -p --all-databases > ~/backup-db-$(date +%Y%m%d).sql

# 备份 Caddy 配置
tar czf ~/backup-caddy-$(date +%Y%m%d).tar.gz -C /etc caddy
```

### 9.2 恢复

```bash
# 恢复前端
tar xzf ~/backup-frontend-YYYYMMDD.tar.gz -C /opt
cd /opt/rangerai-web && pnpm install
sudo bash /opt/rangerai-agent/deploy-frontend.sh

# 恢复后端
tar xzf ~/backup-backend-YYYYMMDD.tar.gz -C /opt
cd /opt/rangerai-agent && npm install
sudo systemctl restart rangerai-agent
```

---

## 10. Manus 依赖清单（已全部移除/替代）

| 原 Manus 依赖 | 替代方案 | 状态 |
|---------------|---------|------|
| Manus OAuth (server/_core/oauth.ts) | rangerai-agent 自有 JWT 认证 (auth.mjs) | 已替代 |
| Manus Forge LLM API | OpenRouter API (smart-router.mjs) | 已替代 |
| Manus Debug Collector (vite plugin) | 已移除，使用 vite.config.standalone.ts | 已移除 |
| Manus tRPC Server | rangerai-agent REST API | 已替代 |
| Manus S3 Storage | 本地文件系统 + rangerai-fileserver | 已替代 |
| Manus 构建部署 | deploy-frontend.sh v5 (standalone) | 已替代 |
| Manus 域名 (*.manus.space) | ranger.voyage (自有域名) | 已替代 |

**结论**：RangerAI 项目在阿里云服务器上完全自主运行，不依赖任何 Manus 平台服务。所有源代码、构建工具链、运行时依赖均在服务器本地，可以直接修改代码并部署，无需通过 Manus 中转。
