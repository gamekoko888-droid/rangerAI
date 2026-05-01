/**
 * Iter-32 Tests — SEO & Meta Tags Optimization
 * - Meta tags, OG tags, Twitter cards
 * - robots.txt and sitemap.xml
 * - Structured data (JSON-LD)
 * - Favicon
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const clientDir = join(__dirname, '..', '..');
const publicDir = join(clientDir, 'public');

function readFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

// ─── Meta Tags ─────────────────────────────────────────────────
describe('HTML meta tags', () => {
  const html = readFile(clientDir, 'index.html');

  it('has descriptive title with brand name', () => {
    expect(html).toContain('<title>RangerAI');
  });

  it('has meta description', () => {
    expect(html).toContain('name="description"');
    expect(html).toContain('AI 中台');
  });

  it('has meta keywords', () => {
    expect(html).toContain('name="keywords"');
    expect(html).toContain('RangerAI');
  });

  it('has meta author', () => {
    expect(html).toContain('name="author"');
    expect(html).toContain('游侠出海');
  });

  it('has meta robots', () => {
    expect(html).toContain('name="robots"');
    expect(html).toContain('index, follow');
  });

  it('has canonical URL', () => {
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('https://ranger.voyage/');
  });
});

// ─── Open Graph Tags ───────────────────────────────────────────
describe('Open Graph tags', () => {
  const html = readFile(clientDir, 'index.html');

  it('has og:title', () => {
    expect(html).toContain('og:title');
  });

  it('has og:description', () => {
    expect(html).toContain('og:description');
  });

  it('has og:type', () => {
    expect(html).toContain('og:type');
    expect(html).toContain('website');
  });

  it('has og:url', () => {
    expect(html).toContain('og:url');
    expect(html).toContain('https://ranger.voyage/');
  });

  it('has og:site_name', () => {
    expect(html).toContain('og:site_name');
    expect(html).toContain('RangerAI');
  });

  it('has og:locale with alternates', () => {
    expect(html).toContain('og:locale');
    expect(html).toContain('zh_CN');
    expect(html).toContain('zh_TW');
    expect(html).toContain('en_US');
  });
});

// ─── Twitter Card Tags ─────────────────────────────────────────
describe('Twitter Card tags', () => {
  const html = readFile(clientDir, 'index.html');

  it('has twitter:card', () => {
    expect(html).toContain('twitter:card');
    expect(html).toContain('summary');
  });

  it('has twitter:title', () => {
    expect(html).toContain('twitter:title');
  });

  it('has twitter:description', () => {
    expect(html).toContain('twitter:description');
  });
});

// ─── Structured Data ───────────────────────────────────────────
describe('Structured data (JSON-LD)', () => {
  const html = readFile(clientDir, 'index.html');

  it('has JSON-LD script tag', () => {
    expect(html).toContain('application/ld+json');
  });

  it('has schema.org context', () => {
    expect(html).toContain('https://schema.org');
  });

  it('has WebApplication type', () => {
    expect(html).toContain('"WebApplication"');
  });

  it('has application name', () => {
    expect(html).toContain('"RangerAI"');
  });
});

// ─── SEO Files ─────────────────────────────────────────────────
describe('SEO files', () => {
  it('robots.txt exists', () => {
    expect(existsSync(join(publicDir, 'robots.txt'))).toBe(true);
  });

  it('robots.txt allows crawling', () => {
    const robots = readFile(publicDir, 'robots.txt');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
  });

  it('robots.txt blocks API routes', () => {
    const robots = readFile(publicDir, 'robots.txt');
    expect(robots).toContain('Disallow: /api/');
  });

  it('robots.txt references sitemap', () => {
    const robots = readFile(publicDir, 'robots.txt');
    expect(robots).toContain('Sitemap:');
    expect(robots).toContain('sitemap.xml');
  });

  it('sitemap.xml exists', () => {
    expect(existsSync(join(publicDir, 'sitemap.xml'))).toBe(true);
  });

  it('sitemap.xml has valid structure', () => {
    const sitemap = readFile(publicDir, 'sitemap.xml');
    expect(sitemap).toContain('<?xml');
    expect(sitemap).toContain('<urlset');
    expect(sitemap).toContain('https://ranger.voyage/');
  });
});

// ─── Favicon ───────────────────────────────────────────────────
describe('Favicon', () => {
  it('favicon.svg exists', () => {
    expect(existsSync(join(publicDir, 'favicon.svg'))).toBe(true);
  });

  it('index.html references favicon.svg', () => {
    const html = readFile(clientDir, 'index.html');
    expect(html).toContain('favicon.svg');
  });

  it('favicon.svg is valid SVG', () => {
    const svg = readFile(publicDir, 'favicon.svg');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
});
