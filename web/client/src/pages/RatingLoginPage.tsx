import { useState } from 'react';
import { ratingFetch } from '../lib/api';

export default function RatingLoginPage() {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [m, setM] = useState('');

  const reg = async () => {
    await ratingFetch('/api/rating/auth/register', { method: 'POST', body: { username: u, password: p } });
    setM('已注册');
  };

  const log = async () => {
    const r = await ratingFetch('/api/rating/auth/login', { method: 'POST', body: { username: u, password: p } }) as { token: string };
    localStorage.setItem('rating_token', r.token);
    setM('已登录');
  };

  return (
    <div className="min-h-dvh bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-bold">匿名评分系统登录</h1>
        <input className="w-full rounded bg-zinc-900 p-3" value={u} onChange={e => setU(e.target.value)} placeholder="用户名" />
        <input className="w-full rounded bg-zinc-900 p-3" value={p} onChange={e => setP(e.target.value)} type="password" placeholder="密码" />
        <div className="grid grid-cols-2 gap-2">
          <button className="rounded bg-zinc-700 p-3" onClick={reg}>注册</button>
          <button className="rounded bg-blue-600 p-3" onClick={log}>登录</button>
        </div>
        {m && <p>{m}</p>}
      </div>
    </div>
  );
}
