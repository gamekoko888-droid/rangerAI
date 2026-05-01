/**
 * usePermissions — RBAC permission hook for RangerAI
 * 
 * Provides convenient permission checking methods that read from useAuthStore.
 * Use this hook in components that need to conditionally render based on permissions.
 * 
 * Usage:
 *   const { can, canAny, hasModule, isAdmin, role } = usePermissions();
 *   if (can('knowledge:write')) { ... }
 *   if (hasModule('kol')) { ... }
 */
import { useAuthStore } from '../stores/useAuthStore';

export function usePermissions() {
  const user = useAuthStore(s => s.user);
  const can = useAuthStore(s => s.can);
  const canAny = useAuthStore(s => s.canAny);
  const canAll = useAuthStore(s => s.canAll);
  const hasModule = useAuthStore(s => s.hasModule);
  const nav = useAuthStore(s => s.nav);

  return {
    /** Check a single permission */
    can,
    /** Check if user has any of the given permissions */
    canAny,
    /** Check if user has all of the given permissions */
    canAll,
    /** Check if user has access to a module */
    hasModule,
    /** Current user role */
    role: user?.role ?? null,
    /** Is admin? */
    isAdmin: user?.role === 'admin',
    /** Is manager or above? */
    isManagerOrAbove: user?.role === 'admin' || user?.role === ('manager' as string),
    /** Data scope for current user */
    dataScope: user?.dataScope ?? 'self',
    /** Filtered navigation items */
    nav,
    /** Current user permissions list */
    permissions: user?.permissions ?? [],
    /** Current user modules list */
    modules: user?.modules ?? [],
  };
}
