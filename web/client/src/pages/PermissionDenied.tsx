/**
 * PermissionDenied — Shown when user lacks required permissions.
 * 
 * Provides a friendly message and navigation back to home.
 */
import { ShieldX, ArrowLeft, Home } from 'lucide-react';
import { useLocation } from 'wouter';
import { useAuthStore } from '../stores/useAuthStore';

export function PermissionDenied() {
  const [, navigate] = useLocation();
  const user = useAuthStore(s => s.user);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-6">
        <ShieldX size={32} className="text-red-400" />
      </div>
      
      <h1 className="text-xl font-semibold text-zinc-100 mb-2">
        权限不足
      </h1>
      
      <p className="text-sm text-zinc-400 max-w-md mb-1">
        抱歉，您的账号 <span className="text-zinc-300 font-medium">{user?.displayName || user?.username}</span> 没有访问此页面的权限。
      </p>
      
      <p className="text-xs text-zinc-500 mb-8">
        当前角色：<span className="text-zinc-400 font-mono">{user?.role || '未知'}</span>
        {' · '}
        如需更高权限，请联系管理员。
      </p>

      <div className="flex gap-3">
        <button
          onClick={() => window.history.back()}
          className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          <ArrowLeft size={16} />
          返回上页
        </button>
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
        >
          <Home size={16} />
          回到首页
        </button>
      </div>
    </div>
  );
}
