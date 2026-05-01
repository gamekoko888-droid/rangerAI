/**
 * LoginPage — Login & Register with invite code for RangerAI.
 * Enhanced with product branding, feature showcase, and visual design.
 * Mobile: full-screen layout with safe-area padding, touch-friendly inputs.
 * 
 * NOTE: This component does NOT depend on ChatProvider/useChatStore.
 * It uses direct API calls (login/register) and reloads the page on success
 * so ChatProvider picks up the new auth state on next mount.
 */

import { useState } from 'react';
import { login as apiLogin, register as apiRegister } from '../lib/api';
import {
  Loader2, Shield, AlertCircle, UserPlus, LogIn,
  Bot, BarChart3, Package, Globe, Zap, Lock
} from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { FloatingLanguageSwitcher } from '../components/chat/LanguageSwitcher';
import { validateFields, required, minLength, valuesMatch } from '../lib/formValidation';

type Mode = 'login' | 'register';

const FEATURES = [
  { icon: Bot, label: 'AI 智能助手', desc: '多模型对话，工单处理，文案生成', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  { icon: BarChart3, label: '数据分析', desc: 'CEO 仪表盘，损耗率监控，利润分析', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  { icon: Package, label: '库存管理', desc: '实时库存监控，智能补货建议', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  { icon: Globe, label: 'TikTok 运营', desc: 'KOL 管理，脚本生成，效果分析', color: 'text-pink-400', bg: 'bg-pink-500/10' },
];

export default function LoginPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const baseResult = validateFields([
      { value: username, rules: [required('login.errorEmptyFields')] },
      { value: password, rules: [required('login.errorEmptyFields')] },
    ]);
    if (!baseResult.valid) { setError(t(baseResult.errorKey! as keyof import('../lib/i18n').TranslationKeys)); return; }

    if (mode === 'register') {
      if (!valuesMatch(password, confirmPassword)) {
        setError(t('login.errorPasswordMismatch')); return;
      }
      const regResult = validateFields([
        { value: password, rules: [minLength(6, 'login.errorPasswordTooShort')] },
        { value: inviteCode, rules: [required('login.errorNoInviteCode')] },
      ]);
      if (!regResult.valid) { setError(t(regResult.errorKey! as keyof import('../lib/i18n').TranslationKeys)); return; }
    }

    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await apiLogin(username.trim(), password);
      } else {
        await apiRegister(username.trim(), password, inviteCode.trim());
      }
      window.location.href = '/';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : mode === 'login' ? t('login.errorLoginFailed') : t('login.errorRegisterFailed');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-zinc-950 flex flex-col lg:flex-row
                    pb-[max(2rem,env(safe-area-inset-bottom))]">
      <FloatingLanguageSwitcher />

      {/* Left: Branding Panel (hidden on mobile, shown on lg+) */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600/20 via-purple-600/10 to-zinc-950" />
        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-purple-500/5 rounded-full blur-3xl" />
        
        {/* Grid pattern overlay */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />

        <div className="relative z-10 flex flex-col justify-center px-12 xl:px-20 py-12 w-full">
          {/* Logo + Title */}
          <div className="mb-12">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 
                              flex items-center justify-center shadow-lg shadow-blue-500/20">
                <Shield size={28} className="text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-zinc-100">RangerAI</h1>
                <p className="text-sm text-zinc-400">{'游侠出海 · 智能业务中台'}</p>
              </div>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed max-w-md">
              {'为游戏出海团队打造的一站式 AI 业务中台，集成智能客服、数据分析、库存管理、TikTok 运营等核心能力，让团队协作更高效。'}
            </p>
          </div>

          {/* Feature Cards */}
          <div className="grid grid-cols-2 gap-3 mb-12">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <div
                  key={i}
                  className="bg-zinc-900/40 backdrop-blur border border-zinc-800/50 rounded-xl p-4 
                             hover:border-zinc-700/50 transition-all duration-300 group"
                >
                  <div className={`p-2 rounded-lg ${f.bg} w-fit mb-3`}>
                    <Icon size={18} className={f.color} />
                  </div>
                  <h3 className="text-sm font-medium text-zinc-200 mb-1">{f.label}</h3>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>

          {/* Stats */}
          <div className="flex items-center gap-8">
            <div>
              <p className="text-2xl font-bold text-zinc-100">105</p>
              <p className="text-[11px] text-zinc-500">{'团队成员'}</p>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div>
              <p className="text-2xl font-bold text-zinc-100">3</p>
              <p className="text-[11px] text-zinc-500">{'业务中心'}</p>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div>
              <p className="text-2xl font-bold text-zinc-100">24/7</p>
              <p className="text-[11px] text-zinc-500">AI {'在线'}</p>
            </div>
            <div className="w-px h-8 bg-zinc-800" />
            <div>
              <p className="text-2xl font-bold text-emerald-400">99.9%</p>
              <p className="text-[11px] text-zinc-500">{'服务可用性'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Login Form */}
      <div className="flex-1 flex items-center justify-center px-4 py-8 lg:py-0">
        <div className="w-full max-w-sm">
          {/* Mobile Logo (shown on small screens) */}
          <div className="text-center mb-6 sm:mb-8 lg:hidden">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 
                            flex items-center justify-center mx-auto mb-3 sm:mb-4 shadow-lg shadow-blue-500/20">
              <Shield size={28} className="text-white sm:hidden" />
              <Shield size={32} className="text-white hidden sm:block" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">RangerAI</h1>
            <p className="text-xs sm:text-sm text-zinc-500 mt-1">{t('login.subtitle')}</p>
          </div>

          {/* Desktop form header */}
          <div className="hidden lg:block mb-8">
            <h2 className="text-xl font-semibold text-zinc-100">
              {mode === 'login' ? '欢迎回来' : '创建账号'}
            </h2>
            <p className="text-sm text-zinc-500 mt-1">
              {mode === 'login' ? '登录以继续使用 RangerAI' : '填写信息开始使用'}
            </p>
          </div>

          {/* Security badge */}
          <div className="flex items-center gap-2 mb-5 px-3 py-2 bg-zinc-900/50 border border-zinc-800/50 rounded-lg">
            <Lock size={12} className="text-emerald-400" />
            <span className="text-[11px] text-zinc-500">{'端到端加密 · 企业级安全防护'}</span>
          </div>

          {/* Mode Tabs */}
          <div className="flex bg-zinc-900 rounded-lg p-1 mb-5 sm:mb-6">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 sm:py-2 text-sm font-medium rounded-md transition-colors ${
                mode === 'login'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-300 active:text-zinc-200'
              }`}
            >
              <LogIn size={14} />
              {t('login.loginTab')}
            </button>
            <button
              type="button"
              onClick={() => { setMode('register'); setError(''); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 sm:py-2 text-sm font-medium rounded-md transition-colors ${
                mode === 'register'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-300 active:text-zinc-200'
              }`}
            >
              <UserPlus size={14} />
              {t('login.registerTab')}
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3.5 sm:space-y-4">
            {error && (
              <div role="alert" className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                <AlertCircle size={16} className="text-red-400 shrink-0" aria-hidden="true" />
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}

            <div>
              <label htmlFor="username" className="block text-sm font-medium text-zinc-400 mb-1.5">
                {t('login.username')}
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('login.usernamePlaceholder')}
                autoComplete="username"
                autoFocus
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-3 sm:py-2.5 text-sm text-zinc-100
                           placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                           transition-colors"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-zinc-400 mb-1.5">
                {t('login.password')}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? t('login.passwordMinLength') : t('login.passwordPlaceholder')}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-3 sm:py-2.5 text-sm text-zinc-100
                           placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                           transition-colors"
              />
            </div>

            {mode === 'register' && (
              <>
                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-zinc-400 mb-1.5">
                    {t('login.confirmPassword')}
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('login.confirmPasswordPlaceholder')}
                    autoComplete="new-password"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-3 sm:py-2.5 text-sm text-zinc-100
                               placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                               transition-colors"
                  />
                </div>

                <div>
                  <label htmlFor="inviteCode" className="block text-sm font-medium text-zinc-400 mb-1.5">
                    {t('login.inviteCode')}
                  </label>
                  <input
                    id="inviteCode"
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="RNG-XXXXXXXX"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-3 sm:py-2.5 text-sm text-zinc-100
                               placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                               transition-colors font-mono tracking-wider"
                  />
                  <p className="text-xs text-zinc-600 mt-1">{t('login.inviteCodeHint')}</p>
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400
                         active:from-blue-700 active:to-blue-600
                         disabled:from-blue-600/50 disabled:to-blue-500/50 disabled:cursor-not-allowed
                         text-white font-medium rounded-lg py-3 sm:py-2.5 text-sm transition-all
                         flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{mode === 'login' ? t('login.loggingIn') : t('login.registering')}</span>
                </>
              ) : (
                <span>{mode === 'login' ? t('login.loginButton') : t('login.registerButton')}</span>
              )}
            </button>
          </form>

          <p className="text-xs text-zinc-600 text-center mt-5 sm:mt-6">
            {mode === 'login'
              ? t('login.noAccountHint')
              : t('login.hasAccountHint')}
          </p>

          {/* Mobile feature hints */}
          <div className="mt-8 lg:hidden">
            <div className="flex items-center justify-center gap-4 text-[10px] text-zinc-600">
              <span className="flex items-center gap-1"><Zap size={10} className="text-blue-400" /> AI {'助手'}</span>
              <span className="flex items-center gap-1"><BarChart3 size={10} className="text-emerald-400" /> {'数据分析'}</span>
              <span className="flex items-center gap-1"><Package size={10} className="text-amber-400" /> {'库存管理'}</span>
              <span className="flex items-center gap-1"><Globe size={10} className="text-pink-400" /> TikTok</span>
            </div>
          </div>
        </div>
      </div>

      {/* Language Switcher on Login Page */}
      <FloatingLanguageSwitcher />
    </div>
  );
}
