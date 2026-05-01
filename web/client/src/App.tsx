import { Toaster } from "@/components/ui/sonner";
import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { I18nProvider } from "./lib/i18n";
import { NetworkStatusBar } from "./components/NetworkStatusBar";

// Critical path — loaded eagerly (login page is lightweight)
import LoginPage from "./pages/LoginPage";
import { Breadcrumb } from "./components/Breadcrumb";
import { CommandPalette } from "./components/CommandPalette";
import { RoleGuard } from "./components/RoleGuard";

// Lazy-loaded pages — only fetched when navigated to
// ChatPage is lazy-loaded because it pulls in Streamdown → shiki (9MB) + mermaid (1.7MB)
const ChatPage = lazy(() => import("./pages/ChatPage"));
const InviteCodesPage = lazy(() => import("./pages/InviteCodesPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const PromptTemplates = lazy(() => import("./pages/PromptTemplates"));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase"));
const WorkflowEditor = lazy(() => import("./pages/WorkflowEditor"));
const TeamManagement = lazy(() => import("./pages/TeamManagement"));
const TaskQueue = lazy(() => import("./pages/TaskQueue"));
const TaskDetailPage = lazy(() => import("./pages/TaskDetailPage"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const TicketManager = lazy(() => import("./pages/TicketManager"));
const KolManager = lazy(() => import("./pages/KolManager"));
const KolDetail = lazy(() => import("./pages/KolDetail"));
const NotificationCenter = lazy(() => import("./pages/NotificationCenter"));
const SearchDebug = lazy(() => import("./pages/SearchDebug"));
const CeoDashboard = lazy(() => import("./pages/CeoDashboard"));
const DataAnalytics = lazy(() => import("./pages/DataAnalytics"));
const DailyReportsV2 = lazy(() => import("./pages/DailyReportsV2"));
const TikTokDashboard = lazy(() => import("./pages/TikTokDashboard"));
const TikTokScriptGen = lazy(() => import("./pages/TikTokScriptGen"));
const InventoryMonitor = lazy(() => import("./pages/InventoryMonitor"));
const OperationalEfficiency = lazy(() => import("./pages/OperationalEfficiency"));
const GlobalDashboard = lazy(() => import("./pages/GlobalDashboard"));
const DataUploadPage = lazy(() => import("./pages/DataUploadPage"));
const PriceMonitor = lazy(() => import("./pages/PriceMonitor"));
const NotFound = lazy(() => import("./pages/NotFound"));
const CostDashboard = lazy(() => import("./pages/CostDashboard"));
const VotePage = lazy(() => import("./pages/VotePage"));
const RatingLoginPage = lazy(() => import("./pages/RatingLoginPage"));

/** Minimal loading fallback for lazy-loaded routes */
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-zinc-500">Loading…</span>
      </div>
    </div>
  );
}

/** Page transition wrapper — clears residual transform after animation to avoid breaking position:fixed children */
function AnimatedPage({ children }: { children: React.ReactNode }) {
  const [animDone, setAnimDone] = useState(false);
  return (
    <div
      className={animDone ? undefined : "animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"}
      onAnimationEnd={() => setAnimDone(true)}
      style={animDone ? { transform: "none" } : undefined}
    >
      {children}
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Breadcrumb />
      <AnimatedPage>
      <Switch>
        <Route path={"/"} component={ChatPage} />
        <Route path={"/login"} component={LoginPage} />
        <Route path={"/invite-codes"}>{() => <RoleGuard permission="system:invite"><InviteCodesPage /></RoleGuard>}</Route>
        <Route path={"/stats"}>{() => <RoleGuard permission="analytics:all"><StatsPage /></RoleGuard>}</Route>
        <Route path={"/prompts"}>{() => <RoleGuard permission="prompt:read"><PromptTemplates /></RoleGuard>}</Route>
        <Route path={"/knowledge"}>{() => <RoleGuard permission="knowledge:read"><KnowledgeBase /></RoleGuard>}</Route>
        <Route path={"/search-debug"} component={SearchDebug} />
        <Route path={"/workflows"}>{() => <RoleGuard permission="workflow:read"><WorkflowEditor /></RoleGuard>}</Route>
        <Route path={"/team"}>{() => <RoleGuard permission="team:read"><TeamManagement /></RoleGuard>}</Route>
        <Route path={"/tasks"}>{() => <RoleGuard permission="task:read"><TaskQueue /></RoleGuard>}</Route>
        <Route path={"/tasks/:id"}>{() => <RoleGuard permission="task:read"><TaskDetailPage /></RoleGuard>}</Route>
        <Route path={"/admin"}>{() => <RoleGuard permission="system:config"><AdminDashboard /></RoleGuard>}</Route>
        <Route path={"/tickets"}>{() => <RoleGuard permission="ticket:read"><TicketManager /></RoleGuard>}</Route>
        <Route path={"/kols"}>{() => <RoleGuard permission="kol:read"><KolManager /></RoleGuard>}</Route>
        <Route path={"/kols/:id"}>{() => <RoleGuard permission="kol:read"><KolDetail /></RoleGuard>}</Route>
        <Route path={"/notifications"}>{() => <RoleGuard permission="chat:read"><NotificationCenter /></RoleGuard>}</Route>
        <Route path={"/ceo"}>{() => <RoleGuard permission="ceo_dashboard:read"><CeoDashboard /></RoleGuard>}</Route>
        <Route path={"/data-analytics"}>{() => <RoleGuard permission="analytics:read"><DataAnalytics /></RoleGuard>}</Route>
        <Route path={"/daily-reports"}>{() => <RoleGuard permission="analytics:all"><DailyReportsV2 /></RoleGuard>}</Route>
        <Route path={"/tiktok-partners"}>{() => <RoleGuard permission="tiktok:read"><TikTokDashboard /></RoleGuard>}</Route>
        <Route path={"/tiktok-scripts"}>{() => <RoleGuard permission="script:read"><TikTokScriptGen /></RoleGuard>}</Route>
        <Route path={"/inventory"}>{() => <RoleGuard permission="inventory:read"><InventoryMonitor /></RoleGuard>}</Route>
        <Route path={"/ops-efficiency"}>{() => <RoleGuard permission="analytics:all"><OperationalEfficiency /></RoleGuard>}</Route>
        <Route path={"/dashboard"}>{() => <RoleGuard permission="analytics:read"><GlobalDashboard /></RoleGuard>}</Route>
        <Route path={"/data-upload"}>{() => <RoleGuard permission="data:import"><DataUploadPage /></RoleGuard>}</Route>
        <Route path={"/cost"}>{() => <RoleGuard permission="system:config"><CostDashboard /></RoleGuard>}</Route>
        <Route path={"/price-monitor"}>{() => <RoleGuard permission="analytics:read"><PriceMonitor /></RoleGuard>}</Route>
        <Route path={"/rating/login"} component={RatingLoginPage} />
        <Route path={"/vote/:token"} component={VotePage} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </AnimatedPage>
    </Suspense>
  );
}

/** Scroll-to-top button that appears on long pages */
function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!visible) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-6 right-6 z-50 w-10 h-10 rounded-full bg-zinc-800/90 border border-zinc-700/50 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-all shadow-lg backdrop-blur-sm flex items-center justify-center"
      aria-label="Scroll to top"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 12V4M4 7l4-4 4 4" />
      </svg>
    </button>
  );
}

/** Keyboard shortcut help panel */
function KeyboardHelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const shortcuts = [
    { keys: ['Ctrl', 'K'], desc: '\u8DF3\u8F6C\u4E3B\u9875' },
    { keys: ['?'], desc: '\u663E\u793A\u5FEB\u6377\u952E\u5E2E\u52A9' },
    { keys: ['G', 'C'], desc: '\u8DF3\u8F6C CEO \u4EEA\u8868\u76D8' },
    { keys: ['G', 'D'], desc: '\u8DF3\u8F6C\u6570\u636E\u5206\u6790' },
    { keys: ['G', 'T'], desc: '\u8DF3\u8F6C\u5DE5\u5355\u7BA1\u7406' },
    { keys: ['G', 'I'], desc: '\u8DF3\u8F6C\u5E93\u5B58\u76D1\u63A7' },
    { keys: ['G', 'K'], desc: '\u8DF3\u8F6C KOL \u7BA1\u7406' },
    { keys: ['Esc'], desc: '\u5173\u95ED\u5F39\u7A97/\u9762\u677F' },
  ];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-200">{'\u952E\u76D8\u5FEB\u6377\u952E'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition">\u2715</button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 border-b border-zinc-800/50 last:border-0">
              <span className="text-xs text-zinc-400">{s.desc}</span>
              <div className="flex gap-1">
                {s.keys.map((k, j) => (
                  <kbd key={j} className="px-2 py-0.5 text-[10px] font-mono bg-zinc-800 border border-zinc-700 rounded text-zinc-300">{k}</kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Global keyboard shortcuts */
function GlobalKeyboardShortcuts() {
  const [, navigate] = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [gPressed, setGPressed] = useState(false);
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      navigate('/');
      return;
    }
    if (e.key === '?') { setHelpOpen(p => !p); return; }
    if (e.key === 'Escape') { setHelpOpen(false); return; }
    if (e.key === 'g' || e.key === 'G') {
      if (!gPressed) { setGPressed(true); setTimeout(() => setGPressed(false), 1000); return; }
    }
    if (gPressed) {
      setGPressed(false);
      if (e.key === 'c') navigate('/ceo');
      else if (e.key === 'd') navigate('/data-analytics');
      else if (e.key === 't') navigate('/tickets');
      else if (e.key === 'i') navigate('/inventory');
      else if (e.key === 'k') navigate('/kols');
    }
  }, [navigate, gPressed]);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
  return <KeyboardHelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />;
}

function App() {
  return (
    <I18nProvider>
      <ErrorBoundary>
        <ThemeProvider defaultTheme="dark">
          <Toaster 
            position="top-right"
            toastOptions={{ duration: 4000 }}
            visibleToasts={5}
            closeButton
            richColors
          />
          <NetworkStatusBar />
          <CommandPalette />
          <GlobalKeyboardShortcuts />
          <Router />
          <ScrollToTopButton />
        </ThemeProvider>
      </ErrorBoundary>
    </I18nProvider>
  );
}

export default App;
