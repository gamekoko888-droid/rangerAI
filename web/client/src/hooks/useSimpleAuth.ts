/**
 * useSimpleAuth — Lightweight auth hook using the project's own REST API.
 * 
 * This replaces `useAuth` from `_core/hooks/useAuth` which depends on tRPC.
 * Since RangerAI uses its own HTTP API (not tRPC), the _core useAuth crashes
 * with "Unable to find tRPC Context" on any page that uses it.
 * 
 * This hook calls /api/auth/me to check auth state.
 */
import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';
import type { User } from '../lib/types';

interface SimpleAuthState {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
}

export function useSimpleAuth() {
  const [state, setState] = useState<SimpleAuthState>({
    user: null,
    loading: true,
    isAuthenticated: false,
  });

  const checkAuth = useCallback(async () => {
    try {
      const result = await api.getMe();
      setState({
        user: result?.user ?? null,
        loading: false,
        isAuthenticated: !!result?.user,
      });
    } catch {
      setState({
        user: null,
        loading: false,
        isAuthenticated: false,
      });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const refresh = useCallback(() => {
    setState(prev => ({ ...prev, loading: true }));
    checkAuth();
  }, [checkAuth]);

  return {
    ...state,
    refresh,
  };
}
