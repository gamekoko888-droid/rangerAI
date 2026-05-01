/**
 * RangerAI User Management API v3 — Pure routing layer (zero raw SQL)
 * Iter-56: All database operations delegated to services/user-service.mjs
 *
 * 路由:
 * - GET    /api/admin/users              — 用户列表（含组织架构字段，admin/manager）
 * - POST   /api/admin/users              — 管理员创建用户（不需要邀请码）
 * - PATCH  /api/admin/users/:id          — 更新用户信息（角色/部门/上级等）
 * - DELETE /api/admin/users/:id          — 停用用户
 * - POST   /api/admin/users/:id/reset-password — 管理员重置用户密码
 *
 * - GET    /api/admin/departments        — 部门列表（树状）
 * - POST   /api/admin/departments        — 创建部门
 * - PATCH  /api/admin/departments/:id    — 更新部门
 * - DELETE /api/admin/departments/:id    — 删除部门
 *
 * - POST   /api/auth/change-password     — 用户自己改密码（需要旧密码）
 * - GET    /api/admin/org-tree           — 组织架构树
 *
 * @module user-management-api
 */
import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';
import * as userService from '../services/user-service.mjs';

// ─── Required deps fields (fail-fast on missing) ────────────
const REQUIRED_DEPS = ['db'];

let deps = null;

/**
 * Initialize the user management API with injected dependencies.
 */
export function init(injected) {
  validateDeps(REQUIRED_DEPS, injected, 'user-management-api');
  deps = injected;
  logger.info('[user-mgmt] Initialized (v3.0.0 — zero raw SQL)');
}

// ─── Convenience accessors ──────────────────────────────────
const db = () => deps.db;
const ts = () => new Date().toISOString();

// ─── Helper: require admin or manager (RBAC v2) ─────────────────────────
function requireAdmin(user, res) {
  if (!user) {
    db().sendJson(res, 401, { error: '未登录或 token 已过期' });
    return false;
  }
  if (user.role !== 'admin' && user.role !== 'manager') {
    db().sendJson(res, 403, { error: '仅管理员或经理可执行此操作' });
    return false;
  }
  return true;
}

// Strict admin-only check (for sensitive operations like role changes)
function requireStrictAdmin(user, res) {
  if (!user) {
    db().sendJson(res, 401, { error: '未登录或 token 已过期' });
    return false;
  }
  if (user.role !== 'admin') {
    db().sendJson(res, 403, { error: '仅超级管理员可执行此操作' });
    return false;
  }
  return true;
}

/**
 * Handle /api/admin/* and /api/auth/change-password routes
 */
export async function handleUserManagementApi(req, res) {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // [R47-T1] Helper: resolve current user, preferring http-router injected user
  // (covers Admin Token Bearer auth set by http-router.mjs [R44-T2] fallback)
  const resolveUser = async () => req._authenticatedUser || await db().extractUserFromRequest(req);

  try {
    // ═══════════════════════════════════════════════════════════
    // USER MANAGEMENT ROUTES
    // ═══════════════════════════════════════════════════════════

    // ─── GET /api/admin/users — 用户列表（含组织架构字段）───
    if (urlPath === '/api/admin/users' && method === 'GET') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const users = await userService.getUsersWithOrgInfo();
      db().sendJson(res, 200, { users });
      return true;
    }

    // ─── POST /api/admin/users — 管理员创建用户 ───
    if (urlPath === '/api/admin/users' && method === 'POST') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const body = await db().parseJsonBody(req);
      const { username, password, displayName, role, department_id, manager_id, org_level, email, phone } = body;

      // Input validation
      if (!username || !password) {
        db().sendJson(res, 400, { error: '用户名和密码不能为空' });
        return true;
      }
      if (password.length < 6) {
        db().sendJson(res, 400, { error: '密码至少 6 个字符' });
        return true;
      }

      // Check username uniqueness
      const existing = await userService.getUserByUsername(username);
      if (existing) {
        db().sendJson(res, 409, { error: '用户名已存在' });
        return true;
      }

      // Validate role
      const validRoles = ['admin', 'manager', 'member', 'viewer', 'cs'];
      const userRole = role && validRoles.includes(role) ? role : 'member';

      // Non-admin cannot create admin users
      if (currentUser.role !== 'admin' && (userRole === 'admin' || userRole === 'manager')) {
        db().sendJson(res, 403, { error: '仅超级管理员可创建管理员或经理账号' });
        return true;
      }

      const user = await userService.createUserFull({
        username, password, displayName, role: userRole,
        department_id, manager_id, org_level, email, phone
      });

      // Audit log
      await userService.insertAuditLog(currentUser.id, currentUser.username, 'create_user', 'user', user.id, JSON.stringify({ username, role: userRole }));

      logger.info(`[${ts()}] [user-mgmt] User created: ${username} (role=${userRole}) by ${currentUser.username}`);
      db().sendJson(res, 201, { user });
      return true;
    }

    // ─── PATCH /api/admin/users/:id — 更新用户信息 ───
    const userPatchMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userPatchMatch && method === 'PATCH') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const targetId = userPatchMatch[1];
      const target = await userService.getUserById(targetId);
      if (!target) {
        db().sendJson(res, 404, { error: '用户不存在' });
        return true;
      }

      const body = await db().parseJsonBody(req);

      // Validate role (RBAC v2: strict admin-only for role changes)
      if (body.role !== undefined) {
        const validRoles = ['admin', 'manager', 'member', 'viewer', 'cs', 'finance'];
        if (!validRoles.includes(body.role)) {
          db().sendJson(res, 400, { error: `无效角色: ${body.role}` });
          return true;
        }
        // Only admin can change roles
        if (!requireStrictAdmin(currentUser, res)) return true;
        // Prevent setting anyone else to admin
        if (body.role === 'admin' && targetId !== currentUser.id) {
          db().sendJson(res, 403, { error: '禁止将其他用户提升为管理员' });
          return true;
        }
        // Prevent demoting self from admin
        if (target.role === 'admin' && body.role !== 'admin') {
          db().sendJson(res, 403, { error: '禁止降级管理员角色' });
          return true;
        }
      }

      // Prevent circular manager reference
      if (body.manager_id === targetId) {
        db().sendJson(res, 400, { error: '不能将自己设为自己的上级' });
        return true;
      }

      const updated = await userService.updateUser(targetId, body);
      if (!updated) {
        db().sendJson(res, 400, { error: '没有要更新的字段' });
        return true;
      }

      await userService.insertAuditLog(currentUser.id, currentUser.username, 'update_user', 'user', targetId, JSON.stringify(body));

      logger.info(`[${ts()}] [user-mgmt] User updated: ${target.username} by ${currentUser.username}`);
      db().sendJson(res, 200, { user: updated });
      return true;
    }

    // ─── DELETE /api/admin/users/:id — 停用用户 ───
    const userDeleteMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userDeleteMatch && method === 'DELETE') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const targetId = userDeleteMatch[1];
      if (targetId === currentUser.id) {
        db().sendJson(res, 400, { error: '不能停用自己的账号' });
        return true;
      }

      const target = await userService.getUserById(targetId);
      if (!target) {
        db().sendJson(res, 404, { error: '用户不存在' });
        return true;
      }

      await userService.deactivateUser(targetId);
      await userService.insertAuditLog(currentUser.id, currentUser.username, 'deactivate_user', 'user', targetId, JSON.stringify({ username: target.username }));

      logger.info(`[${ts()}] [user-mgmt] User deactivated: ${target.username} by ${currentUser.username}`);
      db().sendJson(res, 200, { success: true, message: `用户 ${target.username} 已停用` });
      return true;
    }

    // ─── POST /api/admin/users/:id/reset-password — 管理员重置密码 ───
    const resetMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (resetMatch && method === 'POST') {
      const currentUser = await resolveUser();
      if (!currentUser || currentUser.role !== 'admin') {
        db().sendJson(res, 403, { error: '仅管理员可重置密码' });
        return true;
      }

      const targetId = resetMatch[1];
      const target = await userService.getUserById(targetId);
      if (!target) {
        db().sendJson(res, 404, { error: '用户不存在' });
        return true;
      }

      const body = await db().parseJsonBody(req);
      const newPassword = body.newPassword;
      if (!newPassword || newPassword.length < 6) {
        db().sendJson(res, 400, { error: '新密码至少 6 个字符' });
        return true;
      }

      await userService.resetPassword(targetId, newPassword);
      await userService.insertAuditLog(currentUser.id, currentUser.username, 'reset_password', 'user', targetId, JSON.stringify({ username: target.username }));

      logger.info(`[${ts()}] [user-mgmt] Password reset for ${target.username} by ${currentUser.username}`);
      db().sendJson(res, 200, { success: true, message: `已重置 ${target.username} 的密码` });
      return true;
    }

    // ═══════════════════════════════════════════════════════════
    // DEPARTMENT MANAGEMENT ROUTES
    // ═══════════════════════════════════════════════════════════

    // ─── GET /api/admin/departments — 部门列表 ───
    if (urlPath === '/api/admin/departments' && method === 'GET') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const departments = await userService.getDepartments();
      db().sendJson(res, 200, { departments });
      return true;
    }

    // ─── POST /api/admin/departments — 创建部门 ───
    if (urlPath === '/api/admin/departments' && method === 'POST') {
      const currentUser = await resolveUser();
      if (!currentUser || currentUser.role !== 'admin') {
        db().sendJson(res, 403, { error: '仅管理员可创建部门' });
        return true;
      }

      const body = await db().parseJsonBody(req);
      const { name, description, parent_id, manager_id, sort_order } = body;

      if (!name || !name.trim()) {
        db().sendJson(res, 400, { error: '部门名称不能为空' });
        return true;
      }

      if (await userService.isDepartmentNameDuplicate(name, parent_id)) {
        db().sendJson(res, 409, { error: '同级下已存在同名部门' });
        return true;
      }

      const department = await userService.createDepartment({ name, description, parent_id, manager_id, sort_order });
      await userService.insertAuditLog(currentUser.id, currentUser.username, 'create_department', 'department', department.id, JSON.stringify({ name }));

      logger.info(`[${ts()}] [user-mgmt] Department created: ${name} by ${currentUser.username}`);
      db().sendJson(res, 201, { department });
      return true;
    }

    // ─── PATCH /api/admin/departments/:id — 更新部门 ───
    const deptPatchMatch = urlPath.match(/^\/api\/admin\/departments\/([^/]+)$/);
    if (deptPatchMatch && method === 'PATCH') {
      const currentUser = await resolveUser();
      if (!currentUser || currentUser.role !== 'admin') {
        db().sendJson(res, 403, { error: '仅管理员可更新部门' });
        return true;
      }

      const deptId = deptPatchMatch[1];
      const dept = await userService.getDepartmentById(deptId);
      if (!dept) {
        db().sendJson(res, 404, { error: '部门不存在' });
        return true;
      }

      const body = await db().parseJsonBody(req);

      // Prevent circular parent reference
      if (body.parent_id === deptId) {
        db().sendJson(res, 400, { error: '不能将部门设为自己的父部门' });
        return true;
      }

      const updated = await userService.updateDepartment(deptId, body);
      if (!updated) {
        db().sendJson(res, 400, { error: '没有要更新的字段' });
        return true;
      }

      await userService.insertAuditLog(currentUser.id, currentUser.username, 'update_department', 'department', deptId, JSON.stringify(body));

      logger.info(`[${ts()}] [user-mgmt] Department updated: ${dept.name} by ${currentUser.username}`);
      db().sendJson(res, 200, { department: updated });
      return true;
    }

    // ─── DELETE /api/admin/departments/:id — 删除部门 ───
    const deptDeleteMatch = urlPath.match(/^\/api\/admin\/departments\/([^/]+)$/);
    if (deptDeleteMatch && method === 'DELETE') {
      const currentUser = await resolveUser();
      if (!currentUser || currentUser.role !== 'admin') {
        db().sendJson(res, 403, { error: '仅管理员可删除部门' });
        return true;
      }

      const deptId = deptDeleteMatch[1];
      const dept = await userService.getDepartmentById(deptId);
      if (!dept) {
        db().sendJson(res, 404, { error: '部门不存在' });
        return true;
      }

      const { canDelete, error } = await userService.canDeleteDepartment(deptId);
      if (!canDelete) {
        db().sendJson(res, 400, { error });
        return true;
      }

      await userService.deleteDepartment(deptId);
      await userService.insertAuditLog(currentUser.id, currentUser.username, 'delete_department', 'department', deptId, JSON.stringify({ name: dept.name }));

      logger.info(`[${ts()}] [user-mgmt] Department deleted: ${dept.name} by ${currentUser.username}`);
      db().sendJson(res, 200, { success: true, message: `部门 ${dept.name} 已删除` });
      return true;
    }

    // ═══════════════════════════════════════════════════════════
    // USER SELF-SERVICE ROUTES
    // ═══════════════════════════════════════════════════════════

    // ─── POST /api/auth/change-password — 用户自己改密码 ───
    if (urlPath === '/api/auth/change-password' && method === 'POST') {
      const currentUser = await resolveUser();
      if (!currentUser) {
        db().sendJson(res, 401, { error: '未登录或 token 已过期' });
        return true;
      }

      const body = await db().parseJsonBody(req);
      const { oldPassword, newPassword } = body;

      if (!oldPassword || !newPassword) {
        db().sendJson(res, 400, { error: '旧密码和新密码不能为空' });
        return true;
      }
      if (newPassword.length < 6) {
        db().sendJson(res, 400, { error: '新密码至少 6 个字符' });
        return true;
      }

      const result = await userService.changePassword(currentUser.id, oldPassword, newPassword);
      if (!result.success) {
        db().sendJson(res, 401, { error: result.error });
        return true;
      }

      await userService.insertAuditLog(currentUser.id, currentUser.username, 'change_password', 'user', currentUser.id, '用户自行修改密码');

      logger.info(`[${ts()}] [user-mgmt] Password changed by user: ${currentUser.username}`);
      db().sendJson(res, 200, { success: true, message: '密码修改成功' });
      return true;
    }

    // ─── GET /api/admin/org-tree — 组织架构树 ───
    if (urlPath === '/api/admin/org-tree' && method === 'GET') {
      const currentUser = await resolveUser();
      if (!requireAdmin(currentUser, res)) return true;

      const { departments, users } = await userService.getOrgTree();
      db().sendJson(res, 200, { departments, users });
      return true;
    }


    // ─── P3: GET /api/user/:id/memory — 获取用户记忆 ───
    const memGetMatch = urlPath.match(/^\/api\/user\/([^/]+)\/memory$/);
    if (memGetMatch && method === 'GET') {
      const targetUserId = decodeURIComponent(memGetMatch[1]);
      // Allow internal calls and the user themselves
      const isInternal = req.headers['x-internal-call'] === '1';
      if (!isInternal) {
        const currentUser = await resolveUser();
        if (!currentUser || (currentUser.id !== targetUserId && currentUser.role !== 'admin')) {
          db().sendJson(res, 403, { error: '无权限' });
          return true;
        }
      }
      try {
        const { query } = await import('../db-adapter.mjs');
        const rows = await query('SELECT agentMemory FROM users WHERE id = ?', [targetUserId]);
        const memory = rows?.[0]?.agentMemory || '{}';
        db().sendJson(res, 200, { memory });
      } catch (e) {
        db().sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── P3: PUT /api/user/:id/memory — 更新用户记忆 ───
    const memPutMatch = urlPath.match(/^\/api\/user\/([^/]+)\/memory$/);
    if (memPutMatch && method === 'PUT') {
      const targetUserId = decodeURIComponent(memPutMatch[1]);
      const isInternal = req.headers['x-internal-call'] === '1';
      if (!isInternal) {
        const currentUser = await resolveUser();
        if (!currentUser || (currentUser.id !== targetUserId && currentUser.role !== 'admin')) {
          db().sendJson(res, 403, { error: '无权限' });
          return true;
        }
      }
      try {
        const body = await db().parseJsonBody(req);
        const memory = body.memory || '';
        const { run } = await import('../db-adapter.mjs');
        await run('UPDATE users SET agentMemory = ? WHERE id = ?', [memory, targetUserId]);
        logger.info(`[${ts()}] [user-mgmt] Memory updated for user ${targetUserId} (${memory.length} chars)`);
        db().sendJson(res, 200, { success: true });
      } catch (e) {
        db().sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    return false; // Not handled
  } catch (err) {
    logger.error(`[${ts()}] [user-mgmt] Error: ${err.message}`);
    db().sendJson(res, 500, { error: '服务器内部错误', detail: err.message });
    return true;
  }
}
