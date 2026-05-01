import { useSimpleAuth } from "../hooks/useSimpleAuth";
import { Redirect } from "wouter";

/**
 * Home page — redirects to chat if authenticated, otherwise to login.
 * This is a lightweight entry point that avoids loading heavy dependencies.
 */
export default function Home() {
  const { isAuthenticated, loading } = useSimpleAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 gap-4">
        {/* Logo pulse */}
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center animate-pulse">
          <span className="text-white font-bold text-lg">R</span>
        </div>
        {/* Skeleton bars */}
        <div className="space-y-2 w-48">
          <div className="h-2 bg-zinc-800 rounded-full animate-pulse" />
          <div className="h-2 bg-zinc-800/60 rounded-full animate-pulse w-3/4 mx-auto" />
        </div>
        <p className="text-xs text-zinc-600 mt-2">{'正在加载 RangerAI...'}</p>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Redirect to="/chat" />;
  }

  return <Redirect to="/login" />;
}
