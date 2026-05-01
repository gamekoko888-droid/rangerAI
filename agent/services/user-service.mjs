/**
 * RangerAI User Service v3 — Domain: Authentication, Users, Departments, Invite Codes
 * 
 * Iter-56: SQL 下沉 — 将 user-management-api.mjs 中的 36 处 raw SQL 全部迁移到此 service 层。
 * API 层实现"零直接数据库访问"。
 * 
 * 领域划分:
 *   1. Authentication: JWT token, password hashing, extractUserFromRequest
 *   2. User CRUD: 创建/查询/更新/停用用户（含组织架构字段）
 *   3. Department CRUD: 部门的增删改查
 *   4. Org Tree: 组织架构树、tree_path 构建
 *   5. Invite Codes: 邀请码管理
 *   6. Audit: 审计日志
 */
import { logger } from '../lib/logger.mjs';
import crypto from 'crypto';
import { query, queryOne, run, isMySQL } from '../db-adapter.mjs';

// ─── Helpers ────────────────────────────────────────────────
function generateId() { return crypto.randomUUID(); }
function now() { return isMySQL() ? 'NOW()' : "datetime('now')"; }

// v2.1: Lazy getter — reads env at call time (after secrets.json injection)
function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.RANGERAI_JWT_SECRET || 'rangerai-jwt-secret-2026';
}

// ─── Password Hashing (scrypt) ──────────────────────────────
export function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

export async function verifyPassword(password, salt, hash) {
  const derived = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

export function generateSalt() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── JWT Token (simple HMAC-based) ──────────────────────────
function base64url(str) { return Buffer.from(str).toString('base64url'); }
function base64urlDecode(str) { return Buffer.from(str, 'base64url').toString('utf-8'); }

export function generateToken(payload, expiresInHours = 168) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowTs = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({
    ...payload,
    iat: nowTs,
    exp: nowTs + expiresInHours * 3600,
  }));
  const signature = crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getJwtSecret())
      .update(`${header}.${body}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(base64urlDecode(body));
    const nowTs = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowTs) return null;
    return payload;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// 1. USER CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new user (basic version for registration)
 */
export async function createUser({ username, password, displayName = '', role = 'member', team = null }) {
  const id = generateId();
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  await run(
    `INSERT INTO users (id, username, passwordHash, salt, displayName, role, team) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, username, passwordHash, salt, displayName || username, role, team]
  );
  return { id, username, displayName: displayName || username, role, team, isActive: 1 };
}

/**
 * Create a user with full org fields (admin creation)
 * Extracted from user-management-api.mjs POST /api/admin/users
 */
export async function createUserFull({ username, password, displayName, role, department_id, manager_id, org_level, email, phone }) {
  const id = generateId();
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const level = org_level || 4;

  await run(`
    INSERT INTO users (id, username, passwordHash, salt, displayName, role, department_id, manager_id, org_level, email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, username, passwordHash, salt, displayName || username, role, department_id || null, manager_id || null, level, email || null, phone || null]);

  // Build tree_path
  const treePath = await buildTreePath(id);
  await run('UPDATE users SET tree_path = ? WHERE id = ?', [treePath, id]);

  return {
    id, username, displayName: displayName || username, role,
    department_id, manager_id, org_level: level, tree_path: treePath,
    email, phone, isActive: 1
  };
}

export async function getUserById(userId) {
  return await queryOne(
    `SELECT id, username, displayName, role, team, isActive, createdAt, lastLoginAt, department_id, org_level, email, phone, avatar FROM users WHERE id = ?`,
    [userId]
  );
}

export async function getUserByUsername(username) {
  if (isMySQL()) {
    return await queryOne(`SELECT * FROM users WHERE username = ?`, [username]);
  }
  return await queryOne(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`, [username]);
}

/**
 * Get full user record (including passwordHash/salt) for password verification
 */
export async function getUserFullById(userId) {
  return await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
}

/**
 * Get users list with org fields (for admin panel)
 * Extracted from user-management-api.mjs GET /api/admin/users
 */
export async function getUsersWithOrgInfo() {
  return await query(`
    SELECT u.id, u.username, u.displayName, u.role, u.team, u.isActive,
           u.department_id, u.manager_id, u.org_level, u.tree_path,
           u.email, u.phone, u.avatar, u.createdAt, u.lastLoginAt,
           d.name as departmentName,
           COALESCE(m.displayName, m.username) as managerName
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN users m ON u.manager_id = m.id
    ORDER BY u.org_level ASC, u.createdAt ASC
  `);
}

/**
 * Update user fields (admin operation)
 * Extracted from user-management-api.mjs PATCH /api/admin/users/:id
 * 
 * @param {string} userId - Target user ID
 * @param {object} fields - Fields to update (allowedFields filtered by caller)
 * @returns {object} Updated user with org info
 */
export async function updateUser(userId, fields) {
  const allowedFields = ['displayName', 'role', 'team', 'department_id', 'manager_id', 'org_level', 'email', 'phone', 'avatar', 'isActive'];
  const sets = [];
  const vals = [];

  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      let val = fields[field];
      if (field === 'isActive' && typeof val === 'boolean') val = val ? 1 : 0;
      sets.push(`${field} = ?`);
      vals.push(val);
    }
  }

  if (sets.length === 0) return null;

  vals.push(userId);
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);

  // Rebuild tree_path if manager changed
  if (fields.manager_id !== undefined) {
    const treePath = await buildTreePath(userId);
    await run('UPDATE users SET tree_path = ? WHERE id = ?', [treePath, userId]);
    // Also rebuild tree_path for all subordinates
    const subordinates = await query('SELECT id FROM users WHERE manager_id = ?', [userId]);
    for (const sub of subordinates) {
      const subPath = await buildTreePath(sub.id);
      await run('UPDATE users SET tree_path = ? WHERE id = ?', [subPath, sub.id]);
    }
  }

  // Return updated user with org info
  return await getUserWithOrgInfo(userId);
}

/**
 * Get single user with org info (for returning after update)
 */
export async function getUserWithOrgInfo(userId) {
  return await queryOne(`
    SELECT u.id, u.username, u.displayName, u.role, u.team, u.isActive,
           u.department_id, u.manager_id, u.org_level, u.tree_path,
           u.email, u.phone, u.avatar, u.createdAt, u.lastLoginAt,
           d.name as departmentName,
           COALESCE(m.displayName, m.username) as managerName
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN users m ON u.manager_id = m.id
    WHERE u.id = ?
  `, [userId]);
}

/**
 * Deactivate user (soft delete)
 * Extracted from user-management-api.mjs DELETE /api/admin/users/:id
 */
export async function deactivateUser(userId) {
  await run('UPDATE users SET isActive = 0 WHERE id = ?', [userId]);
}

/**
 * Reset user password (admin operation)
 * Extracted from user-management-api.mjs POST /api/admin/users/:id/reset-password
 */
export async function resetPassword(userId, newPassword) {
  const salt = generateSalt();
  const passwordHash = await hashPassword(newPassword, salt);
  await run('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?', [passwordHash, salt, userId]);
}

/**
 * Change own password (user self-service)
 * Extracted from user-management-api.mjs POST /api/auth/change-password
 * 
 * @returns {{ success: boolean, error?: string }}
 */
export async function changePassword(userId, oldPassword, newPassword) {
  const fullUser = await getUserFullById(userId);
  if (!fullUser) return { success: false, error: '用户不存在' };

  const valid = await verifyPassword(oldPassword, fullUser.salt, fullUser.passwordHash);
  if (!valid) return { success: false, error: '旧密码不正确' };

  await resetPassword(userId, newPassword);
  return { success: true };
}

export async function authenticateUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user || !user.isActive) return null;
  const valid = await verifyPassword(password, user.salt, user.passwordHash);
  if (!valid) return null;
  await run(`UPDATE users SET lastLoginAt = ${now()} WHERE id = ?`, [user.id]);
  return {
    id: user.id, username: user.username, displayName: user.displayName,
    role: user.role, team: user.team, isActive: user.isActive,
  };
}

export async function getUsers() {
  return await query(
    `SELECT id, username, displayName, role, team, isActive, createdAt, lastLoginAt, department_id, org_level, email, phone, avatar FROM users ORDER BY createdAt DESC`
  );
}

export async function getAllUsers() {
  return await query('SELECT id, username, displayName, role, team FROM users WHERE isActive = 1');
}

// ─── Auth Middleware Helper ─────────────────────────────────
export async function extractUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;
  const user = await getUserById(payload.userId);
  if (!user || !user.isActive) return null;
  return user;
}

// ═══════════════════════════════════════════════════════════════
// 2. DEPARTMENT CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * Get all departments with manager info and member count
 * Extracted from user-management-api.mjs GET /api/admin/departments
 */
export async function getDepartments() {
  return await query(`
    SELECT d.*, 
           COALESCE(m.displayName, m.username) as managerName,
           (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.isActive = 1) as memberCount
    FROM departments d
    LEFT JOIN users m ON d.manager_id = m.id
    ORDER BY d.sort_order ASC, d.createdAt ASC
  `);
}

/**
 * Get department by ID
 */
export async function getDepartmentById(deptId) {
  return await queryOne('SELECT * FROM departments WHERE id = ?', [deptId]);
}

/**
 * Check if department name exists under same parent
 */
export async function isDepartmentNameDuplicate(name, parentId) {
  const existing = await queryOne(
    'SELECT id FROM departments WHERE name = ? AND (parent_id IS NULL AND ? IS NULL OR parent_id = ?)',
    [name.trim(), parentId || null, parentId || null]
  );
  return !!existing;
}

/**
 * Create a new department
 * Extracted from user-management-api.mjs POST /api/admin/departments
 */
export async function createDepartment({ name, description, parent_id, manager_id, sort_order }) {
  const id = generateId();
  await run(`
    INSERT INTO departments (id, name, description, parent_id, manager_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, name.trim(), description || '', parent_id || null, manager_id || null, sort_order || 0]);
  return { id, name: name.trim(), description: description || '', parent_id, manager_id, sort_order: sort_order || 0 };
}

/**
 * Update department fields
 * Extracted from user-management-api.mjs PATCH /api/admin/departments/:id
 */
export async function updateDepartment(deptId, fields) {
  const allowedFields = ['name', 'description', 'parent_id', 'manager_id', 'sort_order'];
  const sets = [];
  const vals = [];

  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      sets.push(`${field} = ?`);
      vals.push(fields[field]);
    }
  }

  if (sets.length === 0) return null;

  vals.push(deptId);
  await run(`UPDATE departments SET ${sets.join(', ')} WHERE id = ?`, vals);

  // Return updated department with manager info
  return await queryOne(`
    SELECT d.*, COALESCE(m.displayName, m.username) as managerName,
           (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.isActive = 1) as memberCount
    FROM departments d
    LEFT JOIN users m ON d.manager_id = m.id
    WHERE d.id = ?
  `, [deptId]);
}

/**
 * Check if department can be deleted (no members, no sub-departments)
 * @returns {{ canDelete: boolean, error?: string }}
 */
export async function canDeleteDepartment(deptId) {
  const memberCount = await queryOne('SELECT COUNT(*) as count FROM users WHERE department_id = ? AND isActive = 1', [deptId]);
  if (memberCount.count > 0) {
    return { canDelete: false, error: `该部门还有 ${memberCount.count} 名成员，请先转移成员后再删除` };
  }
  const subDepts = await queryOne('SELECT COUNT(*) as count FROM departments WHERE parent_id = ?', [deptId]);
  if (subDepts.count > 0) {
    return { canDelete: false, error: `该部门还有 ${subDepts.count} 个子部门，请先删除子部门` };
  }
  return { canDelete: true };
}

/**
 * Delete a department
 * Extracted from user-management-api.mjs DELETE /api/admin/departments/:id
 */
export async function deleteDepartment(deptId) {
  await run('DELETE FROM departments WHERE id = ?', [deptId]);
}

// ═══════════════════════════════════════════════════════════════
// 3. ORG TREE
// ═══════════════════════════════════════════════════════════════

/**
 * Build tree_path for a user by traversing the manager chain
 * Extracted from user-management-api.mjs buildTreePath()
 */
export async function buildTreePath(userId) {
  const paths = [];
  let current = userId;
  let depth = 0;
  while (current && depth < 10) {
    paths.unshift(current);
    const user = await queryOne('SELECT manager_id FROM users WHERE id = ?', [current]);
    current = user?.manager_id || null;
    depth++;
  }
  return '/' + paths.join('/') + '/';
}

/**
 * Get org tree data (departments + active users)
 * Extracted from user-management-api.mjs GET /api/admin/org-tree
 */
export async function getOrgTree() {
  const departments = await query(`
    SELECT d.*, COALESCE(m.displayName, m.username) as managerName
    FROM departments d
    LEFT JOIN users m ON d.manager_id = m.id
    ORDER BY d.sort_order ASC
  `);

  const users = await query(`
    SELECT id, username, displayName, role, department_id, manager_id, org_level, tree_path, isActive
    FROM users
    WHERE isActive = 1
    ORDER BY org_level ASC, displayName ASC
  `);

  return { departments, users };
}

// ═══════════════════════════════════════════════════════════════
// 4. AUDIT LOG
// ═══════════════════════════════════════════════════════════════

/**
 * Insert audit log entry
 * Re-exported for use by API layer
 */
export async function insertAuditLog(userId, username, action, targetType, targetId, details) {
  // id 字段：MySQL 用 UUID（TEXT），SQLite 用 INTEGER 自增。
  // isMySQL() 判断分支，避免 datatype mismatch。
  if (isMySQL()) {
    const id = generateId();
    await run(
      `INSERT INTO audit_logs (id, userId, username, action, targetType, targetId, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, username, action, targetType, targetId, details]
    );
  } else {
    await run(
      `INSERT INTO audit_logs (userId, username, action, targetType, targetId, details) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, username, action, targetType, targetId, details]
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. INVITE CODES
// ═══════════════════════════════════════════════════════════════

export async function createInviteCode(createdBy, maxUses = 1, expiresInDays = 7, role = 'member') {
  // Security: never allow creating admin invite codes
  const ALLOWED_INVITE_ROLES = ['member', 'manager', 'cs', 'viewer', 'finance'];
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    throw new Error(`Invalid role for invite code: ${role}. Allowed: ${ALLOWED_INVITE_ROLES.join(', ')}`);
  }
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const id = generateId();
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await run(
    `INSERT INTO invite_codes (id, code, createdBy, maxUses, currentUses, expiresAt, active, role) VALUES (?, ?, ?, ?, 0, ?, 1, ?)`,
    [id, code, createdBy, maxUses, expiresAt, role]
  );
  return { id, code, createdBy, maxUses, currentUses: 0, expiresAt, active: 1, role };
}

export async function validateInviteCode(code) {
  const invite = await queryOne(`SELECT * FROM invite_codes WHERE code = ?`, [code]);
  if (!invite) return { valid: false, error: '邀请码不存在' };
  if (!invite.active) return { valid: false, error: '邀请码已停用' };
  if (invite.currentUses >= invite.maxUses) return { valid: false, error: '邀请码已用完' };
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return { valid: false, error: '邀请码已过期' };
  }
  return { valid: true, invite };
}

export async function useInviteCode(code, userId) {
  const result = await run(
    `UPDATE invite_codes SET currentUses = currentUses + 1, usedBy = ?, usedAt = ${now()} WHERE code = ? AND active = 1 AND currentUses < maxUses`,
    [userId, code]
  );
  return result.changes > 0;
}

export async function getInviteCodes(createdBy = null) {
  if (createdBy) {
    return await query(`SELECT * FROM invite_codes WHERE createdBy = ? ORDER BY createdAt DESC`, [createdBy]);
  }
  return await query(`SELECT * FROM invite_codes ORDER BY createdAt DESC`);
}

export async function deactivateInviteCode(codeId) {
  const result = await run(`UPDATE invite_codes SET active = 0 WHERE id = ?`, [codeId]);
  return result.changes > 0;
}

export async function registerUser(username, password, inviteCode) {
  const validation = await validateInviteCode(inviteCode);
  if (!validation.valid) return { success: false, error: validation.error };
  const existing = await getUserByUsername(username);
  if (existing) return { success: false, error: '用户名已存在' };
  if (!password || password.length < 6) return { success: false, error: '密码至少6位' };
  if (!username || username.length < 2) return { success: false, error: '用户名至少2个字符' };
  // Use the role specified in the invite code (defaults to 'member' for old codes)
  const assignedRole = validation.invite.role || 'member';
  // Security: never allow admin role via invite code
  const safeRole = assignedRole === 'admin' ? 'member' : assignedRole;
  const user = await createUser({ username, password, role: safeRole });
  await useInviteCode(inviteCode, user.id);
  return { success: true, user };
}
