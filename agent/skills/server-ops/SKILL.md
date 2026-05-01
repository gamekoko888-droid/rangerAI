---
name: server-ops
description: 服务器运维技能。系统管理、服务部署、性能监控、故障排查、安全加固、Docker/Nginx/systemd 管理。当用户提到服务器、部署、运维、监控、Docker、Nginx、防火墙、进程管理等关键词时使用。
---

# 服务器运维 (Server Operations)

## 环境信息
- **OS**: CentOS / Ubuntu (阿里云 ECS)
- **包管理**: yum / apt
- **容器**: Docker + Docker Compose
- **Web 服务器**: Nginx (反向代理)
- **进程管理**: systemd
- **隧道**: Cloudflare Tunnel (cloudflared)

## 系统检查清单

执行运维任务前，先了解系统状态：

```bash
# 系统基本信息
uname -a && cat /etc/os-release | head -5

# 资源使用
df -h          # 磁盘
free -m        # 内存
uptime         # 负载和运行时间
nproc          # CPU 核心数

# 网络
ss -tlnp       # 监听端口
ip addr show   # 网络接口

# 服务状态
systemctl list-units --type=service --state=running
docker ps      # 运行中的容器
```

## 常见任务

### 部署新服务
1. 检查端口占用：`ss -tlnp | grep :PORT`
2. 创建服务目录：`mkdir -p /opt/SERVICE_NAME`
3. 编写配置文件
4. Docker：编写 docker-compose.yml → `docker compose up -d`
5. 验证：`curl localhost:PORT`
6. Nginx 反向代理（如需要）
7. 开机自启：`systemctl enable SERVICE`

### Nginx 反向代理模板
```nginx
server {
    listen 80;
    server_name domain.com;
    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # WebSocket 支持
    location /ws {
        proxy_pass http://127.0.0.1:PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 故障排查流程
```
服务不可用
├── 进程存在？ → ps aux | grep SERVICE
├── 端口监听？ → ss -tlnp | grep :PORT
├── 日志？ → journalctl -u SERVICE -n 50 / docker logs CONTAINER
├── 资源？ → free -m / df -h
├── 网络？ → curl -v localhost:PORT
└── 防火墙？ → iptables -L -n / firewall-cmd --list-all
```

### Docker 操作
```bash
docker ps -a                    # 查看容器
docker logs CONTAINER --tail 100  # 查看日志
docker restart CONTAINER        # 重启
docker system prune -f          # 清理
docker compose up -d            # 启动
docker compose logs -f          # 实时日志
```

## 注意事项
- 修改配置前**必须备份**：`cp file file.bak.$(date +%Y%m%d)`
- 重启服务前确认影响范围
- Docker 容器内数据如果没有挂载卷，重建容器会丢失
- 使用 `screen` 或 `tmux` 执行长时间操作，防止 SSH 断开
