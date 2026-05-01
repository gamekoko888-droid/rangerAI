-- ============================================================
-- RangerAI MySQL Schema
-- 从 SQLite DDL 转换而来
-- 日期: 2026-03-08
-- 数据库: rangerai (utf8mb4_unicode_ci)
-- ============================================================

SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- 1. chats 对话表
CREATE TABLE IF NOT EXISTS chats (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(500) DEFAULT '新对话',
  userId VARCHAR(64),
  model VARCHAR(128),
  systemPrompt TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  isShared TINYINT(1) DEFAULT 0,
  shareId VARCHAR(64),
  isPinned TINYINT(1) DEFAULT 0,
  roleId VARCHAR(64),
  INDEX idx_chats_userId (userId),
  INDEX idx_chats_createdAt (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. messages 消息表
CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  chatId VARCHAR(64) NOT NULL,
  role VARCHAR(20) NOT NULL,
  content LONGTEXT,
  model VARCHAR(128),
  `timestamp` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  parentId VARCHAR(64),
  toolCalls TEXT,
  toolResults TEXT,
  metadata TEXT,
  INDEX idx_messages_chatId (`chatId`),
  INDEX idx_messages_timestamp (`timestamp`),
  CONSTRAINT fk_messages_chatId FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. quick_prompts 快捷提示表
CREATE TABLE IF NOT EXISTS quick_prompts (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(100) DEFAULT '通用',
  icon VARCHAR(50) DEFAULT 'zap',
  sortOrder INT DEFAULT 0,
  isActive TINYINT(1) DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  useCount INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. invite_codes 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) UNIQUE NOT NULL,
  createdBy VARCHAR(64),
  maxUses INT DEFAULT 1,
  usedCount INT DEFAULT 0,
  expiresAt DATETIME,
  isActive TINYINT(1) DEFAULT 1,
  note VARCHAR(500),
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assignedRole VARCHAR(50) DEFAULT 'member',
  assignedTeam VARCHAR(100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. invite_usage 邀请码使用记录表
CREATE TABLE IF NOT EXISTS invite_usage (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  invite_code_id INT NOT NULL,
  used_by VARCHAR(64) NOT NULL,
  used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_invite_usage_code FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. shared_chats 共享对话表
CREATE TABLE IF NOT EXISTS shared_chats (
  id VARCHAR(64) PRIMARY KEY,
  chatId VARCHAR(64) NOT NULL,
  sharedBy VARCHAR(64),
  title VARCHAR(500),
  messages LONGTEXT,
  expiresAt DATETIME,
  viewCount INT DEFAULT 0,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shared_chats_chatId (chatId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. audit_logs 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  userId VARCHAR(64),
  username VARCHAR(200),
  `action` VARCHAR(200) NOT NULL,
  target VARCHAR(200),
  targetId VARCHAR(64),
  detail TEXT,
  ip VARCHAR(50),
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_logs_userId (userId),
  INDEX idx_audit_logs_action (`action`),
  INDEX idx_audit_logs_createdAt (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. system_config 系统配置表
CREATE TABLE IF NOT EXISTS system_config (
  `key` VARCHAR(200) PRIMARY KEY,
  `value` TEXT NOT NULL,
  description TEXT,
  category VARCHAR(100) DEFAULT 'general',
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updatedBy VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. ai_roles AI角色表
CREATE TABLE IF NOT EXISTS ai_roles (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  systemPrompt LONGTEXT NOT NULL,
  icon VARCHAR(50) DEFAULT 'bot',
  color VARCHAR(20) DEFAULT '#3b82f6',
  category VARCHAR(100) DEFAULT 'general',
  isActive TINYINT(1) DEFAULT 1,
  sortOrder INT DEFAULT 0,
  createdBy VARCHAR(64),
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_roles_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. tickets 工单表
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  ticket_no VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'medium',
  category VARCHAR(100) DEFAULT 'general',
  customer_name VARCHAR(200),
  customer_email VARCHAR(200),
  customer_platform VARCHAR(100),
  assigned_to VARCHAR(64),
  created_by VARCHAR(64),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  tags TEXT,
  ai_suggestion TEXT,
  resolution TEXT,
  INDEX idx_tickets_status (status),
  INDEX idx_tickets_priority (priority),
  INDEX idx_tickets_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. ticket_comments 工单评论表
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  content TEXT NOT NULL,
  author VARCHAR(200),
  is_internal TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_comments_ticket_id (ticket_id),
  CONSTRAINT fk_ticket_comments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. kols KOL表
CREATE TABLE IF NOT EXISTS kols (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  platform VARCHAR(100) NOT NULL,
  handle VARCHAR(200),
  followers INT DEFAULT 0,
  engagement_rate DOUBLE DEFAULT 0,
  category VARCHAR(100),
  country VARCHAR(100),
  language VARCHAR(50),
  contact_email VARCHAR(200),
  contact_phone VARCHAR(50),
  status VARCHAR(20) DEFAULT 'active',
  cooperation_status VARCHAR(20) DEFAULT 'none',
  notes TEXT,
  tags TEXT,
  last_contacted DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  data_updated_at DATETIME,
  INDEX idx_kols_status (status),
  INDEX idx_kols_platform (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. kol_cooperations KOL合作表
CREATE TABLE IF NOT EXISTS kol_cooperations (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  kol_id INT NOT NULL,
  campaign_name VARCHAR(200),
  content_type VARCHAR(100),
  budget DOUBLE,
  actual_cost DOUBLE,
  start_date DATE,
  end_date DATE,
  deliverables TEXT,
  performance_metrics TEXT,
  status VARCHAR(50) DEFAULT 'planned',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_kol_cooperations_kol_id (kol_id),
  CONSTRAINT fk_kol_cooperations_kol FOREIGN KEY (kol_id) REFERENCES kols(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. assign_rules 分配规则表
CREATE TABLE IF NOT EXISTS assign_rules (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  category VARCHAR(100) NOT NULL,
  priority VARCHAR(20) DEFAULT 'all',
  assignee VARCHAR(64) NOT NULL,
  assignee_name VARCHAR(200),
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. notifications 通知表
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(500) NOT NULL,
  content TEXT,
  type VARCHAR(20) DEFAULT 'info',
  target_user VARCHAR(64),
  related_type VARCHAR(50),
  related_id INT,
  is_read TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notifications_target_user (target_user),
  INDEX idx_notifications_is_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. departments 部门表
CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT (''),
  parent_id VARCHAR(64),
  manager_id VARCHAR(64),
  sort_order INT DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_departments_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. users 用户表
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(200) NOT NULL UNIQUE,
  passwordHash VARCHAR(200) NOT NULL,
  salt VARCHAR(100) NOT NULL,
  displayName VARCHAR(200) NOT NULL DEFAULT '',
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  team VARCHAR(100),
  isActive TINYINT(1) NOT NULL DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastLoginAt DATETIME,
  department_id VARCHAR(64),
  manager_id VARCHAR(64),
  org_level INT DEFAULT 4,
  tree_path VARCHAR(500) DEFAULT '/',
  email VARCHAR(200),
  phone VARCHAR(50),
  avatar TEXT,
  password_reset_token VARCHAR(200),
  password_reset_expires DATETIME,
  INDEX idx_users_department (department_id),
  INDEX idx_users_manager (manager_id),
  INDEX idx_users_tree_path (tree_path),
  INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. knowledge_docs 知识库文档表 (knowledge-db.mjs)
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT (''),
  category VARCHAR(100) DEFAULT '未分类',
  tags TEXT DEFAULT (''),
  fileName VARCHAR(500),
  filePath VARCHAR(1000),
  fileSize INT DEFAULT 0,
  mimeType VARCHAR(100) DEFAULT 'text/plain',
  content LONGTEXT DEFAULT (''),
  uploadedBy VARCHAR(64),
  isActive TINYINT(1) DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. workflows 工作流表 (knowledge-db.mjs)
CREATE TABLE IF NOT EXISTS workflows (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT (''),
  steps LONGTEXT NOT NULL DEFAULT ('[]'),
  category VARCHAR(100) DEFAULT '未分类',
  createdBy VARCHAR(64),
  isActive TINYINT(1) DEFAULT 1,
  runCount INT DEFAULT 0,
  lastRunAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cronExpression VARCHAR(100) DEFAULT NULL,
  cronEnabled TINYINT(1) DEFAULT 0,
  nextRunAt DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
