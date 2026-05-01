/**
 * Iter-40 Tests — Clipboard utilities and share functionality
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

describe('Iter-40: Unified clipboard utility', () => {
  const clipboardSrc = readSrc('client/src/lib/clipboard.ts');

  it('exports copyToClipboard function', () => {
    expect(clipboardSrc).toContain('export async function copyToClipboard');
  });

  it('exports buildShareUrl function', () => {
    expect(clipboardSrc).toContain('export function buildShareUrl');
  });

  it('has fallback for older browsers (execCommand)', () => {
    expect(clipboardSrc).toContain('execCommand');
  });

  it('buildShareUrl uses window.location.origin', () => {
    expect(clipboardSrc).toContain('window.location.origin');
  });
});

describe('Iter-40: All raw navigator.clipboard.writeText replaced', () => {
  const filesToCheck = [
    'client/src/components/chat/MessageList.tsx',
    'client/src/components/chat/AIFileOutput.tsx',
    'client/src/components/chat/FilePanel.tsx',
    'client/src/pages/InviteCodesPage.tsx',
    'client/src/pages/PromptTemplates.tsx',
  ];

  filesToCheck.forEach((file) => {
    it(`${file} does not use raw navigator.clipboard.writeText`, () => {
      const src = readSrc(file);
      expect(src).not.toContain('navigator.clipboard.writeText');
    });

    it(`${file} imports copyToClipboard from clipboard utility`, () => {
      const src = readSrc(file);
      // Pages use ../lib/clipboard, components use ../../lib/clipboard
      expect(src).toContain("from '");
      expect(src).toContain("lib/clipboard'");
    });
  });
});

describe('Iter-40: ShareDialog copy link feature', () => {
  const shareDialogSrc = readSrc('client/src/components/chat/ShareDialog.tsx');

  it('imports copyToClipboard and buildShareUrl', () => {
    expect(shareDialogSrc).toContain("import { copyToClipboard, buildShareUrl }");
  });

  it('has handleCopyLink function', () => {
    expect(shareDialogSrc).toContain('handleCopyLink');
  });

  it('uses buildShareUrl to construct share URL', () => {
    expect(shareDialogSrc).toContain('buildShareUrl(`/chat/');
  });

  it('has linkCopied state for copy feedback', () => {
    expect(shareDialogSrc).toContain('linkCopied');
  });

  it('displays copy link button with i18n text', () => {
    expect(shareDialogSrc).toContain("t('share.copyLink')");
    expect(shareDialogSrc).toContain("t('share.linkCopied')");
  });
});

describe('Iter-40: i18n keys for share copy link', () => {
  const i18nSrc = readSrc('client/src/lib/i18n.tsx');

  const keys = ['share.copyLink', 'share.linkCopied'];

  keys.forEach((key) => {
    it(`has TranslationKeys type for '${key}'`, () => {
      expect(i18nSrc).toContain(`'${key}': string;`);
    });

    it(`has zh-CN translation for '${key}'`, () => {
      const zhCNMatch = i18nSrc.match(new RegExp(`'${key.replace('.', '\\.')}': '[^']+',`));
      expect(zhCNMatch).not.toBeNull();
    });
  });
});

describe('Iter-40: InviteCodesPage and PromptTemplates import paths', () => {
  it('InviteCodesPage imports from ../lib/clipboard', () => {
    const src = readSrc('client/src/pages/InviteCodesPage.tsx');
    expect(src).toContain("from '../lib/clipboard'");
  });

  it('PromptTemplates imports from ../lib/clipboard', () => {
    const src = readSrc('client/src/pages/PromptTemplates.tsx');
    expect(src).toContain("from '../lib/clipboard'");
  });
});
