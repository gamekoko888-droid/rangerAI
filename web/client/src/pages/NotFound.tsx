import { Button } from "@/components/ui/button";
import { Home, ArrowLeft, Shield, Compass } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-950 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500/3 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/3 rounded-full blur-3xl" />
      
      {/* Grid pattern */}
      <div className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '80px 80px',
        }}
      />

      <div className="relative z-10 w-full max-w-lg mx-4 text-center">
        {/* Animated compass icon */}
        <div className="flex justify-center mb-8">
          <div className="relative">
            <div className="absolute inset-0 bg-blue-500/10 rounded-full animate-pulse scale-150" />
            <div className="relative w-24 h-24 rounded-full bg-zinc-900/50 border border-zinc-800/50 flex items-center justify-center">
              <Compass className="h-10 w-10 text-blue-400 animate-[spin_8s_linear_infinite]" />
            </div>
          </div>
        </div>

        {/* 404 text with gradient */}
        <h1 className="text-8xl font-black bg-gradient-to-b from-zinc-300 to-zinc-700 bg-clip-text text-transparent mb-2 tracking-tighter">
          404
        </h1>

        <h2 className="text-xl font-semibold text-zinc-300 mb-3">
          {'迷失在数字丛林中'}
        </h2>

        <p className="text-sm text-zinc-500 mb-8 leading-relaxed max-w-xs mx-auto">
          {'您访问的页面不存在或已被移动。请检查 URL 是否正确，或返回首页重新开始。'}
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            onClick={() => window.history.back()}
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-5 py-2.5 rounded-lg transition-all"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {'返回上页'}
          </Button>
          <Button
            onClick={() => setLocation("/")}
            className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 
                       text-white px-5 py-2.5 rounded-lg transition-all shadow-lg shadow-blue-500/20"
          >
            <Home className="w-4 h-4 mr-2" />
            {'回到首页'}
          </Button>
        </div>

        {/* Branding footer */}
        <div className="mt-12 flex items-center justify-center gap-2 text-zinc-700">
          <Shield size={14} />
          <span className="text-xs">RangerAI</span>
        </div>
      </div>
    </div>
  );
}
