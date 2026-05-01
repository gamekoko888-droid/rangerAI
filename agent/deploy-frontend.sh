#!/bin/bash
# deploy-frontend.sh — 标准化前端部署脚本
# 用法: bash /opt/rangerai-agent/deploy-frontend.sh
# 依赖: /opt/rangerai-web/dist/ 已构建完成

set -e

SRC="/opt/rangerai-web/dist/public"
DEST="/opt/rangerai-agent/dist"
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/rangerai-agent/dist-backups/deploy-${TS}"

echo "[deploy] 开始前端部署 $(date)"

# 1. 验证源目录
if [ ! -d "${SRC}/assets" ] || [ ! -f "${SRC}/index.html" ]; then
  echo "[deploy] 错误: 源目录 ${SRC} 不完整，请先执行构建" >&2
  exit 1
fi

# 2. 备份
echo "[deploy] 备份当前产物到 ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"
if [ -f "${DEST}/index.html" ]; then
  cp "${DEST}/index.html" "${BACKUP_DIR}/index.html"
fi
if [ -d "${DEST}/assets" ]; then
  cp -r "${DEST}/assets" "${BACKUP_DIR}/assets"
fi
echo "[deploy] 备份完成"

# 3. 删除旧 assets
echo "[deploy] 清除旧 assets 目录"
rm -rf "${DEST}/assets"

# 4. 复制新产物（使用 /. 确保内容复制而非目录嵌套）
echo "[deploy] 复制新 assets"
cp -r "${SRC}/assets" "${DEST}/assets"
cp "${SRC}/index.html" "${DEST}/index.html"

# 保持 static-server.cjs（非构建产物，不覆盖）
if [ ! -f "${DEST}/static-server.cjs" ]; then
  echo "[deploy] 警告: static-server.cjs 不存在，尝试从备份恢复"
  if [ -f "${BACKUP_DIR}/static-server.cjs" ]; then
    cp "${BACKUP_DIR}/static-server.cjs" "${DEST}/static-server.cjs"
  elif [ -f "${SRC}/static-server.cjs" ]; then
    cp "${SRC}/static-server.cjs" "${DEST}/static-server.cjs"
  else
    echo "[deploy] 错误: 无法找到 static-server.cjs" >&2
    exit 1
  fi
fi

echo "[deploy] 文件复制完成"

# 5. 重启 rangerai-web
echo "[deploy] 重启 rangerai-web 服务"
sudo systemctl restart rangerai-web
sleep 3

# 6. 验证服务状态
if ! sudo systemctl is-active --quiet rangerai-web; then
  echo "[deploy] 错误: rangerai-web 重启失败" >&2
  sudo systemctl status rangerai-web --no-pager | head -10 >&2
  exit 1
fi
echo "[deploy] rangerai-web 服务正常运行"

# 7. 验证 HTTP 响应
echo "[deploy] 验证本地 HTTP (127.0.0.1:3000)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null || echo "000")
if [ "${HTTP_CODE}" != "200" ]; then
  echo "[deploy] 警告: 本地 HTTP 返回 ${HTTP_CODE}" >&2
else
  echo "[deploy] 本地 HTTP 200 OK"
fi

# 8. 输出 JS hash 用于比对
BUILD_JS=$(ls "${DEST}/assets/" | grep "^index-" | grep "\.js$" | head -1)
echo "[deploy] 当前 JS 入口: ${BUILD_JS}"
echo "[deploy] 部署完成 $(date)"
