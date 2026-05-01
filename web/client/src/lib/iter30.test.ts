/**
 * Iter-30 Tests — Code Splitting & Bundle Optimization
 * - Route-based code splitting with React.lazy
 * - Vite manual chunks configuration
 * - Home page lightweight redirect
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');
const projectRoot = join(__dirname, '..', '..', '..');

function readComponent(relativePath: string): string {
  return readFileSync(join(clientSrc, relativePath), 'utf-8');
}

function readProjectFile(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf-8');
}

// ─── Route-based Code Splitting ────────────────────────────────
describe('Route-based code splitting', () => {
  it('ChatPage is lazy-loaded (not eagerly imported)', () => {
    const src = readComponent('App.tsx');
    expect(src).toContain("const ChatPage = lazy(() => import");
    expect(src).not.toMatch(/^import ChatPage from/m);
  });

  it('LoginPage is eagerly loaded (lightweight)', () => {
    const src = readComponent('App.tsx');
    expect(src).toContain("import LoginPage from");
  });

  it('All secondary pages use React.lazy', () => {
    const src = readComponent('App.tsx');
    const lazyPages = [
      'InviteCodesPage', 'StatsPage', 'PromptTemplates', 'KnowledgeBase',
      'WorkflowEditor', 'TeamManagement', 'TaskQueue', 'AdminDashboard',
      'TicketManager', 'KolManager', 'KolDetail', 'NotificationCenter',
      'SearchDebug', 'NotFound',
    ];
    for (const page of lazyPages) {
      expect(src).toContain(`const ${page} = lazy(`);
    }
  });

  it('Suspense wraps all routes with PageLoader fallback', () => {
    const src = readComponent('App.tsx');
    expect(src).toContain('<Suspense fallback={<PageLoader />}');
  });
});

// ─── Home Page Lightweight Redirect ────────────────────────────
describe('Home page lightweight redirect', () => {
  it('Home.tsx does NOT import Streamdown', () => {
    const src = readComponent('pages/Home.tsx');
    expect(src).not.toContain('Streamdown');
  });

  it('Home.tsx does NOT import heavy libraries', () => {
    const src = readComponent('pages/Home.tsx');
    expect(src).not.toContain('streamdown');
    expect(src).not.toContain('shiki');
    expect(src).not.toContain('mermaid');
  });

  it('Home.tsx redirects to /chat when authenticated', () => {
    const src = readComponent('pages/Home.tsx');
    expect(src).toContain('Redirect');
    expect(src).toContain('/chat');
  });

  it('Home.tsx redirects to /login when not authenticated', () => {
    const src = readComponent('pages/Home.tsx');
    expect(src).toContain('/login');
  });
});

// ─── Vite Manual Chunks Configuration ──────────────────────────
describe('Vite manual chunks configuration', () => {
  it('has manual chunks for mermaid', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-mermaid'");
  });

  it('has manual chunks for shiki', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-shiki'");
  });

  it('has manual chunks for cytoscape', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-cytoscape'");
  });

  it('has manual chunks for katex', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-katex'");
  });

  it('has manual chunks for recharts/d3', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-recharts'");
  });

  it('has manual chunks for react', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-react'");
  });

  it('has manual chunks for lucide-react icons', () => {
    const src = readProjectFile('vite.config.ts');
    expect(src).toContain("'vendor-icons'");
  });
});
