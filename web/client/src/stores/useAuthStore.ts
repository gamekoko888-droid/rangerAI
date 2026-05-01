/**
 * useAuthStore — Authentication + RBAC state (Zustand)
 * 
 * Manages: user session, login/logout, auth loading state, RBAC permissions, nav config.
 * Consumers: ChatPage, Sidebar, LoginPage, RoleGuard, usePermissions
 */
import { create } from 'zustand';
import type { User, NavConfigItem } from '../lib/types';
import * as api from '../lib/api';

interface AuthState {
  user: User | null;
  isAuthLoading: boolean;
  // RBAC state
  nav: NavConfigItem[];
}

interface AuthActions {
  setUser: (user: User | null) => void;
  setAuthLoading: (loading: boolean) => void;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  // RBAC helpers
  can: (permission: string) => boolean;
  canAny: (permissions: string[]) => boolean;
  canAll: (permissions: string[]) => boolean;
  hasModule: (module: string) => boolean;
}

export type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>((set, get) => ({
  // ─── State ───────────────────────────────────────────────
  user: null,
  isAuthLoading: true,
  nav: [],

  // ─── Actions ─────────────────────────────────────────────
  setUser: (user) => set({ user, isAuthLoading: false }),
  setAuthLoading: (loading) => set({ isAuthLoading: loading }),

  checkAuth: async () => {
    set({ isAuthLoading: true });
    try {
      const token = api.getAuthToken();
      if (!token) {
        set({ user: null, isAuthLoading: false, nav: [] });
        return;
      }
      const result = await api.getMe();
      if (result) {
        set({ user: result.user, nav: result.nav, isAuthLoading: false });
      } else {
        set({ user: null, nav: [], isAuthLoading: false });
      }
    } catch {
      set({ user: null, nav: [], isAuthLoading: false });
    }
  },

  login: async (username: string, password: string): Promise<User> => {
    const { user } = await api.login(username, password);
    set({ user, isAuthLoading: false });
    // After login, fetch full auth data with permissions
    try {
      const result = await api.getMe();
      if (result) {
        set({ user: result.user, nav: result.nav });
        return result.user;
      }
    } catch { /* fall through */ }
    return user;
  },

  logout: async () => {
    await api.logout();
    set({ user: null, nav: [] });
  },

  // ─── RBAC Helpers ────────────────────────────────────────
  can: (permission: string): boolean => {
    const { user } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions?.includes(permission) ?? false;
  },

  canAny: (permissions: string[]): boolean => {
    const { user } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return permissions.some(p => user.permissions?.includes(p) ?? false);
  },

  canAll: (permissions: string[]): boolean => {
    const { user } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return permissions.every(p => user.permissions?.includes(p) ?? false);
  },

  hasModule: (module: string): boolean => {
    const { user } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.modules?.includes(module) ?? false;
  },
}));
