/**
 * RoleGuard — Permission-based route/component guard for RangerAI
 * 
 * Wraps components or routes that require specific permissions.
 * Shows PermissionDenied page when user lacks required permission.
 * 
 * FIX v2: Actively triggers checkAuth() when auth hasn't been initialized yet.
 * This handles the case where user directly navigates to a protected URL
 * (e.g., /inventory) without going through ChatPage first.
 * Previously, checkAuth() was only called inside useChatStore's useEffect,
 * which only runs when ChatPage loads.
 */
import { ReactNode, useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { PermissionDenied } from '../pages/PermissionDenied';

interface RoleGuardProps {
  children: ReactNode;
  /** Single permission to check */
  permission?: string;
  /** Multiple permissions to check */
  permissions?: string[];
  /** If true, require ALL permissions; if false, require ANY (default: false) */
  requireAll?: boolean;
  /** Required role (alternative to permission-based check) */
  role?: string;
  /** Required roles (any of these) */
  roles?: string[];
  /** If true, show nothing instead of PermissionDenied (for conditional rendering) */
  silent?: boolean;
  /** Custom fallback component */
  fallback?: ReactNode;
}

/** Minimal loading spinner shown while auth state is being resolved */
function AuthLoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-zinc-500">Verifying permissions…</span>
      </div>
    </div>
  );
}

export function RoleGuard({
  children,
  permission,
  permissions,
  requireAll = false,
  role,
  roles,
  silent = false,
  fallback,
}: RoleGuardProps) {
  const user = useAuthStore(s => s.user);
  const isAuthLoading = useAuthStore(s => s.isAuthLoading);
  const checkAuth = useAuthStore(s => s.checkAuth);
  const can = useAuthStore(s => s.can);
  const canAny = useAuthStore(s => s.canAny);
  const canAll = useAuthStore(s => s.canAll);
  const hasTriggeredAuth = useRef(false);

  // ─── FIX v2: Actively trigger checkAuth if it hasn't been called yet ───
  // When user directly navigates to a protected URL (e.g., /inventory),
  // ChatPage doesn't load, so useChatStore's useEffect never calls checkAuth().
  // We trigger it here to ensure auth state is initialized.
  useEffect(() => {
    if (isAuthLoading && !hasTriggeredAuth.current) {
      hasTriggeredAuth.current = true;
      checkAuth();
    }
  }, [isAuthLoading, checkAuth]);

  // Wait for auth to complete before making permission decisions
  if (isAuthLoading) {
    return silent ? null : <AuthLoadingSpinner />;
  }

  // Not authenticated (auth finished loading but no user)
  if (!user) {
    return silent ? null : (fallback ?? <PermissionDenied />);
  }

  // Admin always passes
  if (user.role === 'admin') {
    return <>{children}</>;
  }

  // Role-based check
  if (role && user.role !== role) {
    return silent ? null : (fallback ?? <PermissionDenied />);
  }
  if (roles && !roles.includes(user.role)) {
    return silent ? null : (fallback ?? <PermissionDenied />);
  }

  // Permission-based check
  if (permission && !can(permission)) {
    return silent ? null : (fallback ?? <PermissionDenied />);
  }
  if (permissions) {
    const hasAccess = requireAll ? canAll(permissions) : canAny(permissions);
    if (!hasAccess) {
      return silent ? null : (fallback ?? <PermissionDenied />);
    }
  }

  return <>{children}</>;
}

/**
 * IfCan — Inline conditional rendering based on permission.
 * 
 * Usage:
 *   <IfCan permission="knowledge:write">
 *     <button>Edit</button>
 *   </IfCan>
 */
export function IfCan({ permission, children }: { permission: string; children: ReactNode }) {
  return <RoleGuard permission={permission} silent>{children}</RoleGuard>;
}
