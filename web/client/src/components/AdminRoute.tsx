import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useSimpleAuth } from "@/hooks/useSimpleAuth";
import { ShieldAlert, ArrowLeft } from "lucide-react";

/**
 * AdminRoute guard — wraps admin-only pages.
 * If the user is not an admin, shows a 403-style page with redirect option.
 * While auth is loading, shows a minimal spinner.
 */
export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSimpleAuth();
  const [, navigate] = useLocation();
  const [countdown, setCountdown] = useState(5);

  const isAdmin = user?.role === "admin";

  // Auto-redirect countdown for non-admin users
  useEffect(() => {
    if (loading || isAdmin) return;
    if (!user) {
      // Not logged in — redirect to login immediately
      navigate("/login");
      return;
    }
    // Non-admin user — countdown then redirect
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate("/dashboard");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [loading, isAdmin, user, navigate]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-zinc-500">验证权限中…</span>
        </div>
      </div>
    );
  }

  // Admin — render children
  if (isAdmin) {
    return <>{children}</>;
  }

  // Non-admin — show 403 page
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 px-4">
      <div className="max-w-md w-full text-center">
        {/* Icon */}
        <div className="mx-auto w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-6">
          <ShieldAlert className="w-10 h-10 text-red-400" />
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">权限不足</h1>
        <p className="text-sm text-zinc-400 mb-6">
          此页面仅限管理员访问。如需访问权限，请联系系统管理员。
        </p>

        {/* Countdown */}
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 mb-6">
          <p className="text-xs text-zinc-500">
            将在 <span className="text-amber-400 font-mono font-bold">{countdown}</span> 秒后自动跳转到首页
          </p>
          <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500/60 rounded-full transition-all duration-1000 ease-linear"
              style={{ width: `${((5 - countdown) / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* Manual redirect button */}
        <button
          onClick={() => navigate("/dashboard")}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          返回首页
        </button>
      </div>
    </div>
  );
}
