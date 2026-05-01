# 迭代 1：数据库迁移方案 — SQLite → MySQL

**文档编号：** ITER-001  
**日期：** 2026-03-08  
**作者：** Manus AI  
**状态：** 待讨论

---

## 一、背景与目标

当前 RangerAI 使用 SQLite 作为唯一数据库，存储 17 张表、约 474 条记录。SQLite 使用文件级写锁，当团队扩展到 20+ 人同时在线时，并发写入会导致 SQLITE_BUSY 错误，影响对话和工单功能。

**本轮迭代目标：** 将 SQLite 替换为 MySQL 8.0，消除并发写入瓶颈，同时保持所有现有功能不变。

---

## 二、当前架构分析

数据库访问分布在以下模块中：

| 模块 | 访问方式 | 说明 |
|------|---------|------|
| database.mjs (29KB) | 直接使用 better-sqlite3 | 主数据库模块，60+ 导出函数 |
| knowledge-db.mjs | 独立 better-sqlite3 连接 | 知识库 + 工作流表 |
| server.mjs | import database.mjs | 对话创建、消息写入 |
| chat-api.mjs | import database.mjs | 聊天 API |
| user-management-api.mjs | import database.mjs | 用户管理 |
| ticket-kol-api.mjs | getDb() 直接操作 | 工单和 KOL |
| workflow-api.mjs | import knowledge-db.mjs | 工作流 |
| knowledge-api.mjs | import database.mjs (工具函数) | 知识库 API |

**关键发现：** 有两个独立的 SQLite 连接（database.mjs 和 knowledge-db.mjs），但指向同一个 .db 文件。ticket-kol-api.mjs 通过 getDb() 直接操作数据库对象，绕过了封装。

---

## 三、迁移方案

### 3.1 技术选型

在阿里云 ECS 上安装 MySQL 8.0 Community Edition（本地部署，非 RDS），原因如下：

- 数据量极小（474 条记录），不需要托管服务
- 本地部署延迟最低（localhost 连接）
- 节省成本（RDS 基础版 ~200 元/月）
- 后续可随时迁移到 RDS

### 3.2 迁移步骤

**步骤 1：安装 MySQL 8.0**

在阿里云 ECS (Alibaba Cloud Linux 3) 上安装 MySQL 8.0：

```bash
# 安装 MySQL 8.0
sudo yum install -y mysql-server
sudo systemctl start mysqld
sudo systemctl enable mysqld
# 创建数据库和用户
mysql -u root -e "CREATE DATABASE rangerai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE USER 'rangerai'@'localhost' IDENTIFIED BY '<strong_password>';"
mysql -u root -e "GRANT ALL PRIVILEGES ON rangerai.* TO 'rangerai'@'localhost';"
```

**步骤 2：创建 MySQL Schema**

将 SQLite 的 17 张表转换为 MySQL 语法。主要差异：

| SQLite | MySQL |
|--------|-------|
| TEXT PRIMARY KEY | VARCHAR(36) PRIMARY KEY |
| INTEGER PRIMARY KEY AUTOINCREMENT | INT AUTO_INCREMENT PRIMARY KEY |
| datetime('now') | NOW() |
| COLLATE NOCASE | COLLATE utf8mb4_general_ci |
| TEXT (JSON) | JSON 或 TEXT |

**步骤 3：编写适配层 db-adapter.mjs**

创建一个数据库适配层，统一 SQLite 和 MySQL 的 API：

```javascript
// db-adapter.mjs — 数据库适配层
// 根据环境变量选择 SQLite 或 MySQL
const DB_TYPE = process.env.DB_TYPE || 'sqlite'; // 'sqlite' | 'mysql'

export function query(sql, params) {
  if (DB_TYPE === 'mysql') {
    return mysqlPool.execute(sql, params);
  } else {
    return sqliteDb.prepare(sql).all(...params);
  }
}
```

**步骤 4：修改 database.mjs**

将 database.mjs 中的 better-sqlite3 调用替换为 db-adapter.mjs 调用。由于 better-sqlite3 是同步 API 而 mysql2 是异步 API，所有数据库函数需要改为 async。

**步骤 5：数据迁移脚本**

编写 migrate-sqlite-to-mysql.mjs 脚本，将现有数据从 SQLite 导入 MySQL。

**步骤 6：灰度切换**

通过环境变量 DB_TYPE 控制切换：
1. 先设置 DB_TYPE=sqlite（默认，不影响现有功能）
2. 数据迁移完成后，设置 DB_TYPE=mysql
3. 观察 24 小时无异常后，移除 SQLite 相关代码

---

## 四、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 同步→异步改造引入 Bug | 高 | 逐函数改造，每改一个测试一个 |
| MySQL 安装失败 | 中 | 备选方案：使用 MariaDB |
| 数据迁移丢失 | 高 | 迁移前备份 SQLite 文件 |
| 性能回退 | 低 | MySQL localhost 连接延迟 < 1ms |

---

## 五、备份策略

每个子步骤开始前：

```bash
# 备份格式：{模块名}-{时间戳}.bak
cp database.mjs database.mjs.bak-20260308-0200
cp knowledge-db.mjs knowledge-db.mjs.bak-20260308-0200
cp rangerai.db rangerai.db.bak-20260308-0200
```

---

## 六、验收标准

1. MySQL 8.0 安装成功，rangerai 数据库创建成功
2. 所有 17 张表在 MySQL 中创建成功
3. 现有 474 条记录全部迁移到 MySQL
4. 所有 API 端点功能正常（对话、用户、工单、KOL、知识库）
5. 前端页面无报错，对话功能正常
6. 并发测试：5 个同时发消息，无错误

---

## 七、讨论要点

请 Ranger 评估以下问题：

1. **同步→异步改造的范围：** database.mjs 有 60+ 导出函数，全部改为 async 会影响所有调用方。是否应该先用 mysql2 的同步包装（如 sync-mysql）来减少改动范围？

2. **适配层 vs 直接替换：** 是保留 db-adapter.mjs 适配层（支持 SQLite 回退），还是直接替换为 MySQL（更简洁但不可回滚）？

3. **knowledge-db.mjs 的处理：** 是合并到 database.mjs 统一管理，还是保持独立但共享 MySQL 连接池？

4. **ticket-kol-api.mjs 的 getDb() 直接调用：** 是否应该在本轮迭代中修复这个绕过封装的问题？

---

*请 Ranger 审阅此文档并提出意见，达成共识后开始开发。*
