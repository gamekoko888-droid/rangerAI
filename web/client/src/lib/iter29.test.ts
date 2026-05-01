/**
 * Iter-29 Tests — Error Handling Robustness & UX Polish
 * - Toast error notifications in catch blocks
 * - PageLoadingSkeleton component
 * - i18n keys for error messages
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');

function readComponent(relativePath: string): string {
  return readFileSync(join(clientSrc, relativePath), 'utf-8');
}

// ─── Toast Error Notifications ─────────────────────────────────
describe('Toast error notifications in catch blocks', () => {
  it('StatsPage: imports toast from sonner', () => {
    const src = readComponent('pages/StatsPage.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('StatsPage: shows toast.error on fetch failure', () => {
    const src = readComponent('pages/StatsPage.tsx');
    expect(src).toContain("toast.error(t('stats.fetchError'))");
  });

  it('PromptTemplates: imports toast from sonner', () => {
    const src = readComponent('pages/PromptTemplates.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('PromptTemplates: shows toast.error on load failure', () => {
    const src = readComponent('pages/PromptTemplates.tsx');
    expect(src).toContain("toast.error(t('prompt.loadError'))");
  });

  it('TaskQueue: imports toast from sonner', () => {
    const src = readComponent('pages/TaskQueue.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('TaskQueue: shows toast.error on load failure', () => {
    const src = readComponent('pages/TaskQueue.tsx');
    expect(src).toContain("toast.error(t('taskQueue.loadError'))");
  });

  it('TeamManagement: imports sonnerToast from sonner', () => {
    const src = readComponent('pages/TeamManagement.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('TeamManagement: shows sonnerToast.error on load failure', () => {
    const src = readComponent('pages/TeamManagement.tsx');
    expect(src).toContain("sonnerToast.error(t('team.networkError'))");
  });

  it('WorkflowEditor: imports toast from sonner', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('WorkflowEditor: shows toast.error on load failure', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain("toast.error(t('workflow.loadError'))");
  });

  it('WorkflowEditor: shows toast.error on save failure', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain("toast.error(t('workflow.saveError'))");
  });

  it('WorkflowEditor: shows toast.error on delete failure', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain("toast.error(t('workflow.deleteError'))");
  });

  it('WorkflowEditor: shows toast.error on duplicate failure', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain("toast.error(t('workflow.duplicateError'))");
  });

  it('ChatPage: imports toast from sonner', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toContain("from 'sonner'");
  });

  it('ChatPage: shows toast.error on export failure', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toContain("toast.error(t('chatPage.exportError'))");
  });
});

// ─── PageLoadingSkeleton Component ─────────────────────────────
describe('PageLoadingSkeleton component', () => {
  it('exists as a component file', () => {
    const exists = existsSync(join(clientSrc, 'components/PageLoadingSkeleton.tsx'));
    expect(exists).toBe(true);
  });

  it('exports PageLoadingSkeleton', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    expect(src).toContain('export function PageLoadingSkeleton');
  });

  it('supports cards variant (default)', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    // cards is the default variant - it's the fallback after stats and list checks
    expect(src).toContain("'cards' | 'list' | 'stats'");
  });

  it('supports list variant', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    expect(src).toContain("variant === 'list'");
  });

  it('supports stats variant', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    expect(src).toContain("variant === 'stats'");
  });

  it('uses Skeleton component from ui', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    expect(src).toContain("from './ui/skeleton'");
  });

  it('uses animate-in for smooth appearance', () => {
    const src = readComponent('components/PageLoadingSkeleton.tsx');
    expect(src).toContain('animate-in');
  });
});

// ─── Pages use PageLoadingSkeleton ─────────────────────────────
describe('Pages use PageLoadingSkeleton for loading states', () => {
  it('PromptTemplates uses PageLoadingSkeleton', () => {
    const src = readComponent('pages/PromptTemplates.tsx');
    expect(src).toContain('PageLoadingSkeleton');
  });

  it('StatsPage uses PageLoadingSkeleton', () => {
    const src = readComponent('pages/StatsPage.tsx');
    expect(src).toContain('PageLoadingSkeleton');
  });

  it('WorkflowEditor uses PageLoadingSkeleton', () => {
    const src = readComponent('pages/WorkflowEditor.tsx');
    expect(src).toContain('PageLoadingSkeleton');
  });

  it('TaskQueue uses PageLoadingSkeleton', () => {
    const src = readComponent('pages/TaskQueue.tsx');
    expect(src).toContain('PageLoadingSkeleton');
  });
});

// ─── i18n error message keys ───────────────────────────────────
describe('i18n error message keys', () => {
  const errorKeys = [
    'stats.fetchError',
    'workflow.loadError',
    'workflow.saveError',
    'workflow.deleteError',
    'workflow.duplicateError',
    'taskQueue.loadError',
    'prompt.loadError',
    'chatPage.exportError',
  ];

  errorKeys.forEach(key => {
    it(`${key} exists in TranslationKeys and all locales`, () => {
      const src = readComponent('lib/i18n.tsx');
      const matches = src.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'g')) || [];
      // Should appear in: TranslationKeys type + zh-CN + zh-TW + en = 4
      expect(matches.length).toBeGreaterThanOrEqual(4);
    });
  });
});
