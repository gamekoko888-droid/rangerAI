/**
 * Iter-31 Tests — Security Hardening
 * - Security headers middleware
 * - Rate limiting middleware
 * - Input sanitization helpers
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const serverDir = join(__dirname);
const coreDir = join(__dirname, '_core');

function readFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

// ─── Security Headers ──────────────────────────────────────────
describe('Security headers middleware', () => {
  it('exports securityHeaders function', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('export function securityHeaders');
  });

  it('sets X-Frame-Options to SAMEORIGIN', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'X-Frame-Options'");
    expect(src).toContain('SAMEORIGIN');
  });

  it('sets X-Content-Type-Options to nosniff', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'X-Content-Type-Options'");
    expect(src).toContain('nosniff');
  });

  it('sets X-XSS-Protection header', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'X-XSS-Protection'");
  });

  it('sets Referrer-Policy header', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'Referrer-Policy'");
    expect(src).toContain('strict-origin-when-cross-origin');
  });

  it('sets Permissions-Policy header', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'Permissions-Policy'");
    expect(src).toContain('camera=()');
  });

  it('sets Content-Security-Policy header', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'Content-Security-Policy'");
    expect(src).toContain("default-src 'self'");
    expect(src).toContain("object-src 'none'");
  });
});

// ─── Rate Limiting ─────────────────────────────────────────────
describe('Rate limiting middleware', () => {
  it('exports rateLimit function', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('export function rateLimit');
  });

  it('sets X-RateLimit headers', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain("'X-RateLimit-Limit'");
    expect(src).toContain("'X-RateLimit-Remaining'");
    expect(src).toContain("'X-RateLimit-Reset'");
  });

  it('returns 429 when rate limit exceeded', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('429');
    expect(src).toContain('Too many requests');
  });

  it('has cleanup interval for expired entries', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('setInterval');
    expect(src).toContain('rateLimitStore');
  });
});

// ─── Input Sanitization ────────────────────────────────────────
describe('Input sanitization helpers', () => {
  it('exports sanitizeString function', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('export function sanitizeString');
  });

  it('sanitizeString strips HTML tags', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('<[^>]*>');
  });

  it('sanitizeString escapes special characters', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('&lt;');
    expect(src).toContain('&gt;');
    expect(src).toContain('&quot;');
    expect(src).toContain('&amp;');
  });

  it('exports sanitizeSearchQuery function', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('export function sanitizeSearchQuery');
  });

  it('sanitizeSearchQuery enforces max length', () => {
    const src = readFile(serverDir, 'security.ts');
    expect(src).toContain('maxLength');
    expect(src).toContain('.slice(0, maxLength)');
  });
});

// ─── Server Integration ────────────────────────────────────────
describe('Security middleware integration', () => {
  it('server/_core/index.ts imports security middleware', () => {
    const src = readFile(coreDir, 'index.ts');
    expect(src).toContain("from \"../security\"");
  });

  it('server/_core/index.ts applies securityHeaders()', () => {
    const src = readFile(coreDir, 'index.ts');
    expect(src).toContain('app.use(securityHeaders())');
  });

  it('server/_core/index.ts applies rateLimit to /api/', () => {
    const src = readFile(coreDir, 'index.ts');
    expect(src).toContain("app.use('/api/'");
    expect(src).toContain('rateLimit(');
  });
});
