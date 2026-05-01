/**
 * RBAC Router Permission Check
 * 
 * Injected into http-router.mjs between JWT auth and route handlers.
 * Maps URL patterns to required permissions and returns 403 if user lacks access.
 */

import { hasPermission, hasAnyPermission, getDataScope, buildScopeFilter, ROLE_PERMISSIONS, getModulesForRole } from './rbac.mjs';

// ─── Route → Permission Mapping ───
const ROUTE_PERMISSIONS = [
  // CEO Dashboard
  { pattern: '/api/ceo',              permissions: ['ceo_dashboard:read'] },
  
  // Team Management  
  { pattern: '/api/admin/users',      permissions: ['team:read', 'team:manage', 'team:dept'] },
  { pattern: '/api/admin/departments',permissions: ['team:manage', 'team:dept'] },
  
  // Invite Codes
  { pattern: '/api/admin/invite',     permissions: ['system:invite'] },
  
  // System Config
  { pattern: '/api/admin/system',     permissions: ['system:config'] },
  { pattern: '/api/admin/skills',     permissions: ['system:skills'] },
  
  // Analytics & Stats
  { pattern: '/api/stats',            permissions: ['analytics:read'] },
  { pattern: '/api/analytics',        permissions: ['analytics:read'] },
  { pattern: '/api/observability',    permissions: ['analytics:read'] },
  
  // Reports
  { pattern: '/api/reports',          permissions: ['report:read'] },
  { pattern: '/api/report',           permissions: ['report:read'] },
  
  // Knowledge Base
  { pattern: '/api/knowledge',        permissions: ['knowledge:read'] },
  
  // Workflows
  { pattern: '/api/workflows',        permissions: ['workflow:read'] },
  { pattern: '/api/workflow-runs',    permissions: ['workflow:read'] },
  
  // Tickets
  { pattern: '/api/tickets',          permissions: ['ticket:read'] },
  
  // KOL Management
  { pattern: '/api/kols',             permissions: ['kol:read'] },
  
  // TikTok
  { pattern: '/api/tiktok',           permissions: ['tiktok:read'] },
  
  // Data Import/Export
  { pattern: '/api/data/',            permissions: ['data:import', 'data:export'] },
  
  // Prompts
  { pattern: '/api/prompts',          permissions: ['prompt:read'] },
];

// Write operations require elevated permissions
const WRITE_PERMISSION_MAP = {
  'knowledge': 'knowledge:write',
  'workflows': 'workflow:write',
  'workflow-runs': 'workflow:execute',
  'tickets': 'ticket:write',
  'kols': 'kol:write',
  'tiktok': 'tiktok:write',
  'prompts': 'prompt:write',
  'data': 'data:import',
  'reports': 'report:generate',
};

/**
 * Check RBAC permissions for a request.
 * Returns true if allowed, false if blocked (sends 403).
 */
export function checkRoutePermission(req, res, urlPath) {
  const user = req._authenticatedUser;
  if (!user) return true; // Unauthenticated routes handled by auth middleware
  
  // Admin bypasses all permission checks
  if (user.role === 'admin') {
    req._dataScope = 'all';
    return true;
  }
  
  // Find matching route permission
  const matchedRoute = ROUTE_PERMISSIONS.find(r => urlPath.startsWith(r.pattern));
  if (!matchedRoute) {
    // No permission mapping = allowed (chat, auth, health, etc.)
    req._dataScope = getDataScope(user.role);
    return true;
  }
  
  // Check read permission
  if (!hasAnyPermission(user.role, matchedRoute.permissions)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Forbidden',
      message: '您没有访问此功能的权限',
      messageEn: 'You do not have permission to access this feature',
      requiredPermissions: matchedRoute.permissions,
      userRole: user.role,
    }));
    return false;
  }
  
  // For write operations, check write permission
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const module = urlPath.split('/')[2]; // /api/{module}/...
    const writePermission = WRITE_PERMISSION_MAP[module];
    if (writePermission && !hasPermission(user.role, writePermission)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: '您没有执行此操作的权限',
        messageEn: 'You do not have permission to perform this action',
        requiredPermission: writePermission,
        userRole: user.role,
      }));
      return false;
    }
  }
  
  // Attach data scope for downstream handlers
  req._dataScope = getDataScope(user.role);
  req._scopeFilter = buildScopeFilter(user);
  
  return true;
}

/**
 * Get user permissions payload for frontend
 * Called from /api/auth/me or WebSocket connection
 */
export function getUserPermissionsPayload(user) {
  if (!user) return { permissions: [], modules: [], dataScope: 'self', role: null };
  
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  const modules = getModulesForRole(user.role);
  
  return {
    role: user.role,
    permissions,
    modules,
    dataScope: getDataScope(user.role),
    departmentId: user.department_id || null,
  };
}

export default { checkRoutePermission, getUserPermissionsPayload };
