/**
 * Unified clipboard utility with fallback for older browsers.
 *
 * Usage:
 *   import { copyToClipboard } from '@/lib/clipboard';
 *   const ok = await copyToClipboard(text);
 */

/**
 * Copy text to clipboard using the modern Clipboard API with
 * a `document.execCommand('copy')` fallback for older browsers.
 *
 * @returns `true` on success, `false` on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern Clipboard API (requires secure context / HTTPS)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy approach
    }
  }

  // Legacy fallback using a hidden textarea + execCommand
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Prevent scroll jump
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Build a shareable URL for a given path.
 * Uses `window.location.origin` to stay deployment-agnostic.
 */
export function buildShareUrl(path: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${cleanPath}`;
}
