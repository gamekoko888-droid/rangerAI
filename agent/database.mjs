/**
 * RangerAI Database Module v4 — Facade Layer
 * 
 * Phase 2 of architecture decoupling:
 * This file is now a thin facade that re-exports from domain-specific services.
 * All actual business logic lives in services/*.
 * 
 * New code should import directly from:
 *   - services/user-service.mjs    (auth, users, invite codes)
 *   - services/chat-service.mjs    (chats, messages, search, tags, sharing)
 *   - services/admin-service.mjs   (stats, config, audit, health)
 *   - services/content-service.mjs (prompts, AI roles)
 * 
 * This facade ensures backward compatibility — existing imports from database.mjs
 * continue to work without modification.
 */
import { logger } from './lib/logger.mjs';
import { initAdapter, closeAdapter, getDbType, isMySQL } from './db-adapter.mjs';

// ─── Re-export from User Service ────────────────────────────
export {
  createUser, getUserById, getUserByUsername, authenticateUser,
  getUsers, getAllUsers, extractUserFromRequest,
  generateToken, verifyToken,
  createInviteCode, validateInviteCode, useInviteCode,
  getInviteCodes, deactivateInviteCode, registerUser,
} from './services/user-service.mjs';

// ─── Re-export from Chat Service ────────────────────────────
export {
  getChats, getChatById, getChatBySessionKey,
  createChat, updateChatTitle, touchChat, deleteChat, deleteChats,
  getMessages, createMessage, getConversationHistory, getMessageCount,
  importSession, deleteMessagesFrom, getMessageById, getLastUserMessageBefore,
  searchChats, getAllTags, updateChatTags, getChatsByTag,
  shareChat, unshareChat, getSharedWithMe, getChatShares, hasShareAccess,
  updateMessageMetadata,
} from './services/chat-service.mjs';

// ─── Re-export from Admin Service ───────────────────────────
export {
  getStats, getSystemStatus,
  getSystemConfigs, getSystemConfig, updateSystemConfig,
  getAuditLogs, insertAuditLog,
  getLatestHealthCheck, getHealthCheckHistory,
  getDb,
} from './services/admin-service.mjs';

// ─── Re-export from Content Service ────────────────────────
export {
  getQuickPrompts, incrementPromptUsage,
  createPrompt, updatePrompt, deletePrompt, getAllPrompts,
  getRoleById, getAllRoles,
  getAiRoles, getAiRole, createAiRole, updateAiRole, deleteAiRole,
} from './services/content-service.mjs';

// ─── Initialization (stays here as the central entry point) ──
let initialized = false;

export async function initDatabase() {
  if (initialized) return;
  
  const adapter = await initAdapter();
  
  // For SQLite, create tables if they don't exist (MySQL tables are pre-created)
  if (!isMySQL()) {
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id          TEXT PRIMARY KEY,
        sessionKey  TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL DEFAULT '新对话',
        model       TEXT,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now')),
        userId      TEXT,
        tags        TEXT,
        metadata    TEXT
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role      TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content   TEXT NOT NULL,
        model     TEXT,
        tokens    INTEGER,
        msgId     TEXT,
        metadata  TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
      CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt);
      CREATE INDEX IF NOT EXISTS idx_chats_userId ON chats(userId);
      CREATE TABLE IF NOT EXISTS shared_chats (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sharedWithUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sharedByUserId   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chatId, sharedWithUserId)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_chats_chatId ON shared_chats(chatId);
      CREATE INDEX IF NOT EXISTS idx_shared_chats_sharedWith ON shared_chats(sharedWithUserId);
      
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        salt        TEXT NOT NULL,
        displayName TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
        team        TEXT,
        isActive    INTEGER NOT NULL DEFAULT 1,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        lastLoginAt TEXT
      );
    `);

    // v2.1 Migration: Add metadata column to messages table
    try {
      const { query } = await import('./db-adapter.mjs');
      const columns = await query(`PRAGMA table_info(messages)`);
      const hasMetadata = columns.some(c => c.name === 'metadata');
      if (!hasMetadata) {
        const { run } = await import('./db-adapter.mjs');
        await run(`ALTER TABLE messages ADD COLUMN metadata TEXT`);
        logger.info(`[database] Migration: Added metadata column to messages table`);
      }
    } catch (migErr) {
      logger.info(`[database] Migration check: ${migErr.message}`);
    }
  }

  initialized = true;
  logger.info(`[database] v4 Facade initialized with ${getDbType()} backend (services: user, chat, admin, content)`);
}

export async function closeDatabase() {
  await closeAdapter();
  initialized = false;
  logger.info('[database] Connection closed');
}

// ─── HTTP Helpers (not DB-related, kept for backward compat) ──
export function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Iter-17 Abstraction: Reporter Statistics
 * Decouples reporter history from MySQL/SQLite dialects.
 */
export async function getReporterRecentHistory(reporterName, days = 7) {
  let sql;
  if (isMySQL()) {
    sql = `SELECT * FROM dingtalk_reports 
           WHERE reporter_name = ? 
           AND create_time >= DATE_SUB(NOW(), INTERVAL ? DAY) 
           ORDER BY create_time DESC`;
  } else {
    sql = `SELECT * FROM dingtalk_reports 
           WHERE reporter_name = ? 
           AND create_time >= datetime('now', '-' || ? || ' days', 'localtime') 
           ORDER BY create_time DESC`;
  }
  return await query(sql, [reporterName, days]);
}

/**
 * Iter-17 Abstraction: Template breakdown stats
 */
export async function getTemplateDistribution() {
  const sql = `SELECT template_name, COUNT(*) as count 
               FROM dingtalk_reports 
               GROUP BY template_name 
               ORDER BY count DESC`;
  return await query(sql, []);
}

/**
 * Iter-17 Abstraction: Get last single report (robustly)
 */
export async function getReporterLastReport(reporterName) {
  // MySQL dialect for "last 48 hours" or simply limit 1 since it's ordered
  const sql = `SELECT create_time, content FROM dingtalk_reports 
               WHERE reporter_name = ? 
               ORDER BY create_time DESC LIMIT 1`;
  return await query(sql, [reporterName]);
}
