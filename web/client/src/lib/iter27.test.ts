/**
 * Iter-27 Tests — Empty State Unification, Web Vitals, Code Quality
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

// ─── Empty State Unification ───────────────────────────────────

describe('Iter-27: Empty State Unification', () => {
  it('EmptyState component should exist with required props', () => {
    const src = readSrc('client/src/components/EmptyState.tsx');
    expect(src).toContain('interface EmptyStateProps');
    expect(src).toContain('icon');
    expect(src).toContain('title');
    expect(src).toContain('description');
    expect(src).toContain('action');
  });

  it('InviteCodesPage should use EmptyState component', () => {
    const src = readSrc('client/src/pages/InviteCodesPage.tsx');
    expect(src).toContain("import { EmptyState }");
    expect(src).toContain('<EmptyState');
    expect(src).toContain("icon={Ticket}");
  });

  it('PromptTemplates should use EmptyState component', () => {
    const src = readSrc('client/src/pages/PromptTemplates.tsx');
    expect(src).toContain("import { EmptyState }");
    expect(src).toContain('<EmptyState');
    expect(src).toContain("icon={Sparkles}");
  });

  it('TeamManagement should use EmptyState component', () => {
    const src = readSrc('client/src/pages/TeamManagement.tsx');
    expect(src).toContain("import { EmptyState }");
    expect(src).toContain('<EmptyState');
    expect(src).toContain("icon={Users}");
  });

  it('NotificationCenter should already use EmptyState', () => {
    const src = readSrc('client/src/pages/NotificationCenter.tsx');
    expect(src).toContain('EmptyState');
  });

  it('KolManager should already use EmptyState', () => {
    const src = readSrc('client/src/pages/KolManager.tsx');
    expect(src).toContain('EmptyState');
  });

  it('TicketManager should already use EmptyState', () => {
    const src = readSrc('client/src/pages/TicketManager.tsx');
    expect(src).toContain('EmptyState');
  });
});

// ─── i18n Keys for Empty States ────────────────────────────────

describe('Iter-27: i18n Empty State Keys', () => {
  it('should have invite.emptyDesc key in all locales', () => {
    const src = readSrc('client/src/lib/i18n.tsx');
    expect(src).toContain("'invite.emptyDesc': string;");
    // zh-CN
    expect(src).toMatch(/invite\.emptyDesc.*创建/);
    // zh-TW
    expect(src).toMatch(/invite\.emptyDesc.*建立/);
    // en
    expect(src).toMatch(/invite\.emptyDesc.*create/i);
  });

  it('should have prompt.emptyDesc key in all locales', () => {
    const src = readSrc('client/src/lib/i18n.tsx');
    expect(src).toContain("'prompt.emptyDesc': string;");
    expect(src).toMatch(/prompt\.emptyDesc.*创建/);
    expect(src).toMatch(/prompt\.emptyDesc.*建立/);
    expect(src).toMatch(/prompt\.emptyDesc.*Create/);
  });

  it('should have team.noMatchUsersDesc and team.noUsersDesc keys', () => {
    const src = readSrc('client/src/lib/i18n.tsx');
    expect(src).toContain("'team.noMatchUsersDesc': string;");
    expect(src).toContain("'team.noUsersDesc': string;");
  });
});

// ─── Web Vitals Integration ────────────────────────────────────

describe('Iter-27: Web Vitals', () => {
  it('webVitals.ts should exist and export initWebVitals', () => {
    const src = readSrc('client/src/lib/webVitals.ts');
    expect(src).toContain('export function initWebVitals');
    expect(src).toContain('onCLS');
    expect(src).toContain('onFCP');
    expect(src).toContain('onLCP');
    expect(src).toContain('onTTFB');
    expect(src).toContain('onINP');
  });

  it('main.tsx should initialize web vitals', () => {
    const src = readSrc('client/src/main.tsx');
    expect(src).toContain("import { initWebVitals }");
    expect(src).toContain('initWebVitals()');
  });

  it('web-vitals package should be installed', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['web-vitals'] || pkg.devDependencies?.['web-vitals']).toBeTruthy();
  });

  it('webVitals should have performance thresholds', () => {
    const src = readSrc('client/src/lib/webVitals.ts');
    expect(src).toContain('THRESHOLDS');
    expect(src).toContain('good');
    expect(src).toContain('poor');
    expect(src).toContain('needs-improvement');
  });

  it('webVitals should export getCollectedVitals', () => {
    const src = readSrc('client/src/lib/webVitals.ts');
    expect(src).toContain('export function getCollectedVitals');
  });
});

// ─── Code Quality ──────────────────────────────────────────────

describe('Iter-27: Code Quality', () => {
  it('should have no .bak files in client/src', () => {
    const bakFiles = [
      'client/src/components/chat/ModelSelector.tsx.bak-20260306192000',
      'client/src/components/chat/MessageList.tsx.bak-20260307-screenshot',
      'client/src/lib/api.ts.bak-20260307-recover',
      'client/src/pages/StatsPage.tsx.bak-20260307-recover',
      'client/src/pages/TeamManagement.tsx.bak-old',
    ];
    for (const f of bakFiles) {
      expect(existsSync(resolve(ROOT, f))).toBe(false);
    }
  });

  it('EmptyState component should have consistent dark theme styling', () => {
    const src = readSrc('client/src/components/EmptyState.tsx');
    expect(src).toContain('bg-zinc-800');
    expect(src).toContain('text-zinc-300');
    expect(src).toContain('text-zinc-500');
  });
});
