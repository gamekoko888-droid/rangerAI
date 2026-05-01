/**
 * RBAC Permission Module for RangerAI
 * 
 * Roles: admin, manager, member, viewer, cs
 * Permission format: module:action (e.g., "chat:write", "team:manage")
 */

// ─── Permission Definitions ───
export const PERMISSIONS = {
  // AI Chat
  'chat:read':       'View chat conversations',
  'chat:write':      'Send messages and create conversations',
  'chat:delete':     'Delete own conversations',
  'chat:delete_any': 'Delete any conversation',
  'chat:share':      'Share conversations',
  
  // Knowledge Base
  'knowledge:read':    'View knowledge base documents',
  'knowledge:write':   'Create and edit documents',
  'knowledge:delete':  'Delete documents',
  'knowledge:manage':  'Manage knowledge base settings',
  
  // Workflows
  'workflow:read':    'View workflows',
  'workflow:execute': 'Execute workflows',
  'workflow:write':   'Create and edit workflows',
  'workflow:manage':  'Manage workflow settings',
  
  // Prompts
  'prompt:read':    'View prompt templates',
  'prompt:write':   'Create and edit prompts',
  'prompt:manage':  'Manage all prompts',
  
  // Tasks
  'task:read':      'View task queue',
  'task:write':     'Create and manage tasks',
  'task:manage':    'Manage all tasks',
  
  // KOL Management
  'kol:read':       'View KOL data',
  'kol:write':      'Edit KOL data',
  'kol:manage':     'Full KOL management',
  
  // TikTok Operations
  'tiktok:read':    'View TikTok data',
  'tiktok:write':   'Edit TikTok operations',
  'tiktok:manage':  'Full TikTok management',
  
  // Tickets / Customer Service
  'ticket:read':      'View tickets',
  'ticket:write':     'Create and respond to tickets',
  'ticket:manage':    'Manage all tickets',
  
  // Inventory
  'inventory:read':   'View inventory',
  'inventory:write':  'Edit inventory',
  'inventory:manage': 'Full inventory management',
  
  // Scripts
  'script:read':    'View scripts',
  'script:write':   'Create and edit scripts',
  'script:manage':  'Manage all scripts',
  
  // Analytics & Reports
  'analytics:read':     'View analytics dashboards',
  'analytics:dept':     'View department-level analytics',
  'analytics:all':      'View all analytics',
  'report:read':        'View reports',
  'report:generate':    'Generate reports',
  
  // CEO Dashboard
  'ceo_dashboard:read': 'Access CEO dashboard',
  
  // Team Management
  'team:read':      'View team members',
  'team:manage':    'Manage team members',
  'team:dept':      'Manage department members',
  
  // System Administration
  'system:config':     'System configuration',
  'system:invite':     'Manage invite codes',
  'system:logs':       'View system logs',
  'system:skills':     'Manage AI skills',
  
  // Data Operations
  'data:import':    'Import data',
  'data:export':    'Export data',
};

// ─── Role → Permission Mapping ───
export const ROLE_PERMISSIONS = {
  admin: [
    // Admin gets everything
    ...Object.keys(PERMISSIONS),
  ],
  
  manager: [
    // Chat
    'chat:read', 'chat:write', 'chat:delete', 'chat:share',
    // Knowledge
    'knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:manage',
    // Workflows
    'workflow:read', 'workflow:execute', 'workflow:write', 'workflow:manage',
    // Prompts
    'prompt:read', 'prompt:write', 'prompt:manage',
    // Tasks
    'task:read', 'task:write', 'task:manage',
    // KOL
    'kol:read', 'kol:write', 'kol:manage',
    // TikTok
    'tiktok:read', 'tiktok:write', 'tiktok:manage',
    // Tickets
    'ticket:read', 'ticket:write', 'ticket:manage',
    // Inventory
    'inventory:read', 'inventory:write',
    // Scripts
    'script:read', 'script:write', 'script:manage',
    // Analytics (department level)
    'analytics:read', 'analytics:dept',
    'report:read', 'report:generate',
    // Team (department level)
    'team:read', 'team:dept',
    // Data
    'data:import', 'data:export',
  ],
  
  member: [
    // Chat
    'chat:read', 'chat:write', 'chat:delete', 'chat:share',
    // Knowledge (read + limited write)
    'knowledge:read', 'knowledge:write',
    // Workflows (read + execute)
    'workflow:read', 'workflow:execute',
    // Prompts (read + write own)
    'prompt:read', 'prompt:write',
    // Tasks
    'task:read', 'task:write',
    // KOL (assigned only - enforced at data level)
    'kol:read', 'kol:write',
    // TikTok (assigned only - enforced at data level)
    'tiktok:read', 'tiktok:write',
    // Tickets (own only - enforced at data level)
    'ticket:read', 'ticket:write',
    // Inventory (read only)
    'inventory:read',
    // Scripts
    'script:read', 'script:write',
    // Analytics (own stats)
    'analytics:read',
    'report:read',
    // Team (read only)
    'team:read',
    // Data
    'data:export',
  ],
  
  viewer: [
    // Read-only access to most modules
    'chat:read',
    'knowledge:read',
    'workflow:read',
    'prompt:read',
    'task:read',
    'inventory:read',
    'analytics:read',
    'report:read',
    'team:read',
  ],
  
  cs: [
    // Customer service focused
    'chat:read', 'chat:write', 'chat:delete',
    // Knowledge (read for reference)
    'knowledge:read',
    // Tickets (full access)
    'ticket:read', 'ticket:write', 'ticket:manage',
    // Limited analytics
    'analytics:read',
    'report:read',
    // Scripts (read for reference)
    'script:read',
    // Team (read)
    'team:read',
    // Prompts (read for reference)
    'prompt:read',
    // Tasks (cs can submit tasks — TD-040)
    'task:read', 'task:write',
  ],

  finance: [
    // Chat
    'chat:read', 'chat:write', 'chat:delete',
    // Knowledge (read for reference)
    'knowledge:read',
    // Tickets (read + write for payment/refund handling)
    'ticket:read', 'ticket:write',
    // Analytics — full read + report generation (对账/资金统计需求)
    'analytics:read', 'analytics:dept', 'analytics:all',
    'report:read', 'report:generate',
    // CEO Dashboard (财务需要全局视图)
    'ceo_dashboard:read',
    // Data export (凭证/报表导出)
    'data:export',
    // Inventory read (库存对账)
    'inventory:read',
    // KOL/TikTok read (结算对账参考)
    'kol:read',
    'tiktok:read',
    // Team read
    'team:read',
  ],
};

// ─── Permission Check Functions ───

/**
 * Check if a role has a specific permission
 */
export function hasPermission(role, permission) {
  if (!role || !ROLE_PERMISSIONS[role]) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Check if a role has ANY of the specified permissions
 */
export function hasAnyPermission(role, permissions) {
  if (!role || !ROLE_PERMISSIONS[role]) return false;
  return permissions.some(p => ROLE_PERMISSIONS[role].includes(p));
}

/**
 * Check if a role has ALL of the specified permissions
 */
export function hasAllPermissions(role, permissions) {
  if (!role || !ROLE_PERMISSIONS[role]) return false;
  return permissions.every(p => ROLE_PERMISSIONS[role].includes(p));
}

/**
 * Get all permissions for a role
 */
export function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

/**
 * Get permission modules (unique module prefixes) for a role
 */
export function getModulesForRole(role) {
  const perms = ROLE_PERMISSIONS[role] || [];
  const modules = new Set(perms.map(p => p.split(':')[0]));
  return [...modules];
}

// ─── Data Scope Functions ───

/**
 * Determine data scope for a user based on role
 * Returns: 'all' | 'department' | 'self'
 */
export function getDataScope(role) {
  switch (role) {
    case 'admin':   return 'all';
    case 'manager': return 'department';
    case 'cs':      return 'all'; // CS sees all tickets
    case 'finance': return 'all'; // Finance sees all data for reconciliation
    default:        return 'self';
  }
}

/**
 * Build SQL WHERE clause for data scoping
 */
export function buildScopeFilter(user, tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const scope = getDataScope(user.role);
  
  switch (scope) {
    case 'all':
      return { clause: '1=1', params: [] };
    case 'department':
      return {
        clause: `${prefix}department_id = ?`,
        params: [user.department_id],
      };
    case 'self':
      return {
        clause: `${prefix}user_id = ? OR ${prefix}assigned_to = ?`,
        params: [user.id, user.id],
      };
    default:
      return { clause: '1=0', params: [] }; // deny all
  }
}

// ─── HTTP Middleware Factory ───

/**
 * Express/raw-http middleware that checks permission
 * Usage: requirePermission('knowledge:write')
 */
export function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    const user = req._authenticatedUser;
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    }
    
    if (!hasAnyPermission(user.role, requiredPermissions)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Forbidden', 
        message: `Requires permission: ${requiredPermissions.join(' or ')}`,
        requiredPermissions,
        userRole: user.role,
      }));
      return false;
    }
    
    // Attach scope info to request for downstream handlers
    req._dataScope = getDataScope(user.role);
    req._scopeFilter = buildScopeFilter(user);
    
    if (next) next();
    return true;
  };
}

/**
 * Express/raw-http middleware that checks role
 * Usage: requireRole('admin', 'manager')
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const user = req._authenticatedUser;
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    }
    
    if (!allowedRoles.includes(user.role)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Forbidden', 
        message: `Requires role: ${allowedRoles.join(' or ')}`,
        userRole: user.role,
      }));
      return false;
    }
    
    req._dataScope = getDataScope(user.role);
    req._scopeFilter = buildScopeFilter(user);
    
    if (next) next();
    return true;
  };
}

// ─── Navigation Config (shared with frontend) ───
export const NAV_CONFIG = [
  // -- Primary (always visible if permitted) --
  { id: 'chat', label: 'AI 对话', labelEn: 'AI Chat', icon: 'MessageSquare', path: '/', permission: 'chat:read', category: 'primary' },
  { id: 'knowledge', label: '知识库', labelEn: 'Knowledge', icon: 'FolderOpen', path: '/knowledge', permission: 'knowledge:read', category: 'primary' },
  { id: 'workflows', label: '工作流', labelEn: 'Workflows', icon: 'Zap', path: '/workflows', permission: 'workflow:read', category: 'primary' },
  { id: 'tasks', label: '任务队列', labelEn: 'Tasks', icon: 'ListTodo', path: '/tasks', permission: 'task:read', category: 'primary' },
  { id: 'notifications', label: '通知', labelEn: 'Notifications', icon: 'Bell', path: '/notifications', permission: 'chat:read', category: 'primary' },
  { id: 'prompts', label: '提示词', labelEn: 'Prompts', icon: 'Sparkles', path: '/prompts', permission: 'prompt:read', category: 'primary' },
  // -- Business modules --
  { id: 'tickets', label: '工单', labelEn: 'Tickets', icon: 'Headphones', path: '/tickets', permission: 'ticket:read', category: 'business' },
  { id: 'kols', label: 'KOL', labelEn: 'KOL', icon: 'Crown', path: '/kols', permission: 'kol:read', category: 'business' },
  { id: 'tiktok', label: 'TikTok', labelEn: 'TikTok', icon: 'Users', path: '/tiktok-partners', permission: 'tiktok:read', category: 'business' },
  { id: 'scripts', label: '文案', labelEn: 'Scripts', icon: 'Film', path: '/tiktok-scripts', permission: 'script:read', category: 'business' },
  { id: 'inventory', label: '库存', labelEn: 'Inventory', icon: 'Package', path: '/inventory', permission: 'inventory:read', category: 'business' },
  { id: 'data_upload', label: '数据摄食', labelEn: 'Data Import', icon: 'Upload', path: '/data-upload', permission: 'data:import', category: 'business' },
  { id: 'daily_reports', label: '日报', labelEn: 'Daily Reports', icon: 'Clock', path: '/daily-reports', permission: 'analytics:all', category: 'business' },
  { id: 'data_analytics', label: '数据分析', labelEn: 'Data Analytics', icon: 'BarChart3', path: '/data-analytics', permission: 'analytics:read', category: 'business' },
  { id: 'price_monitor', label: '价格监控', labelEn: 'Price Monitor', icon: 'TrendingUp', path: '/price-monitor', permission: 'analytics:read', category: 'business' },
  // -- Analytics --
  { id: 'ceo_dashboard', label: 'CEO 看板', labelEn: 'CEO Dashboard', icon: 'Eye', path: '/ceo', permission: 'ceo_dashboard:read', category: 'analytics' },
  { id: 'ops', label: '运营', labelEn: 'Ops', icon: 'Gauge', path: '/ops-efficiency', permission: 'analytics:all', category: 'analytics' },
  // -- Admin --
  { id: 'team', label: '团队管理', labelEn: 'Team', icon: 'Users', path: '/team', permission: 'team:read', category: 'admin' },
  { id: 'admin', label: '管理控制台', labelEn: 'Console', icon: 'Shield', path: '/admin', permission: 'system:config', category: 'admin' },
  { id: 'stats', label: '统计', labelEn: 'Stats', icon: 'BarChart3', path: '/stats', permission: 'analytics:all', category: 'admin' },
  { id: 'invite_codes', label: '邀请码', labelEn: 'Invite Codes', icon: 'Ticket', path: '/invite-codes', permission: 'system:invite', category: 'admin' },
  { id: 'system', label: '系统设置', labelEn: 'System', icon: 'Settings', path: '/admin/system', permission: 'system:config', category: 'admin' },
];

export default {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  NAV_CONFIG,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  getPermissionsForRole,
  getModulesForRole,
  getDataScope,
  buildScopeFilter,
  requirePermission,
  requireRole,
};

// --- Merged from root rbac.mjs (TD-002) ---

const ROLE_HIERARCHY_COMPAT = { viewer: 1, user: 2, operator: 3, manager: 4, admin: 5 };
const PERMISSIONS_COMPAT = {
  "view:tasks": 1, "create:tasks": 2, "edit:tasks": 2,
  "delete:tasks": 4, "view:users": 3, "manage:users": 5,
  "view:reports": 2, "export:data": 3, "manage:settings": 5,
};

export function getRoleLevel(role) {
  return ROLE_HIERARCHY_COMPAT[role] || 0;
}

export function hasRole(user, minRole) {
  return getRoleLevel(user?.role) >= getRoleLevel(minRole);
}

export function getTaskVisibility(user) {
  const level = getRoleLevel(user?.role);
  if (level >= 5) return "all";
  if (level >= 4) return "department";
  return "own";
}

export function buildTaskVisibilityFilter(user) {
  const scope = getTaskVisibility(user);
  switch (scope) {
    case "all":
      return { clause: "1=1", params: [] };
    case "department":
      if (user.department_id) {
        return {
          clause: "(userId = ? OR userId IN (SELECT id FROM users WHERE department_id = ?))",
          params: [user.id, user.department_id],
        };
      }
      return { clause: "userId = ?", params: [user.id] };
    default:
      return { clause: "userId = ?", params: [user.id] };
  }
}

export function denyAccess(res, sendJson, action, userRole) {
  const required = PERMISSIONS_COMPAT[action];
  const requiredRole = Object.entries(ROLE_HIERARCHY_COMPAT)
    .find(([, level]) => level === required)?.[0] || "admin";
  sendJson(res, 403, {
    error: `权限不足：此操作需要 ${requiredRole} 及以上角色（当前角色: ${userRole}）`,
    requiredRole,
    currentRole: userRole,
    action,
  });
}
