import { useState } from 'react';
import { adminLogin } from '../lib/ratingApi';

interface Props {
  onLogin: (admin: any) => void;
}

export default function RatingAdminLogin({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) { setError('请输入用户名和密码'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await adminLogin(username, password);
      localStorage.setItem('rating_admin_token', result.token);
      localStorage.setItem('rating_admin_user', JSON.stringify(result.admin));
      onLogin(result.admin);
    } catch (e: any) {
      setError(e.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-4xl mb-3">🏆</div>
          <h1 className="text-2xl font-bold text-white">评分系统管理后台</h1>
          <p className="text-zinc-500 text-sm mt-1">Ranger 匿名互评管理平台</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">管理员账号</label>
            <input
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 transition"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">密码</label>
            <input
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 transition"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
          </div>
          {error && (
            <div className="bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2 text-red-400 text-sm">
              {error}
            </div>
          )}
          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white rounded-lg py-2.5 text-sm font-medium transition"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
