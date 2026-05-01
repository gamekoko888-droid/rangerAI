/**
 * Iter-35 Tests — Notification System Polish
 * - Toaster configuration (position, richColors, closeButton)
 * - NotificationCenter improvements (skeleton loading, toast errors, aria-labels)
 * - i18n keys for notification actions
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');

function readFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

// ─── Toaster Configuration ─────────────────────────────────────
describe('Toaster configuration', () => {
  const appSrc = readFile(join(clientSrc), 'App.tsx');

  it('sets position to top-right', () => {
    expect(appSrc).toContain('position="top-right"');
  });

  it('limits visible toasts to 5', () => {
    expect(appSrc).toContain('visibleToasts={5}');
  });

  it('enables close button', () => {
    expect(appSrc).toContain('closeButton');
  });

  it('enables rich colors', () => {
    expect(appSrc).toContain('richColors');
  });

  it('sets default duration to 4000ms', () => {
    expect(appSrc).toContain('duration: 4000');
  });
});

// ─── NotificationCenter Improvements ───────────────────────────
describe('NotificationCenter improvements', () => {
  const ncSrc = readFile(join(clientSrc, 'pages'), 'NotificationCenter.tsx');

  it('imports Skeleton component', () => {
    expect(ncSrc).toContain("import { Skeleton }");
  });

  it('uses Skeleton for loading state instead of text', () => {
    expect(ncSrc).toContain('<Skeleton');
    // Should not have the old simple text loading
    expect(ncSrc).not.toContain('className="text-center py-20 text-zinc-500"');
  });

  it('has toast.error for fetch failure', () => {
    expect(ncSrc).toContain("toast.error(t('notif.fetchError'))");
  });

  it('has toast.error for mark-as-read failure', () => {
    expect(ncSrc).toContain("toast.error(t('notif.markReadError'))");
  });

  it('has toast.error for delete failure', () => {
    expect(ncSrc).toContain("toast.error(t('notif.deleteError'))");
  });

  it('has aria-label on mark-as-read button', () => {
    expect(ncSrc).toContain("aria-label={t('notif.markRead')}");
  });

  it('has aria-label on delete button', () => {
    expect(ncSrc).toContain("aria-label={t('notif.delete')}");
  });

  it('uses i18n for button titles instead of hardcoded strings', () => {
    expect(ncSrc).toContain("title={t('notif.markRead')}");
    expect(ncSrc).toContain("title={t('notif.delete')}");
    // Should not have hardcoded English titles
    expect(ncSrc).not.toContain("title=\"Mark as read\"");
    expect(ncSrc).not.toContain("title=\"Delete\"");
  });
});

// ─── i18n Keys ─────────────────────────────────────────────────
describe('Notification i18n keys', () => {
  const i18nSrc = readFile(join(clientSrc, 'lib'), 'i18n.tsx');

  const requiredKeys = [
    'notif.fetchError',
    'notif.markReadError',
    'notif.deleteError',
    'notif.markRead',
    'notif.delete',
  ];

  for (const key of requiredKeys) {
    it(`has ${key} in TranslationKeys`, () => {
      expect(i18nSrc).toContain(`'${key}': string`);
    });

    it(`has ${key} in zh-CN locale`, () => {
      // Check it appears at least twice (type + zh-CN)
      const matches = i18nSrc.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'));
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(4); // type + zh-CN + zh-TW + en
    });
  }
});
