/**
 * Security middleware for RangerAI
 * - Security headers (CSP, X-Frame-Options, etc.)
 * - Rate limiting for API endpoints
 * - Input sanitization helpers
 */
import type { Request, Response, NextFunction } from 'express';

// ─── Security Headers Middleware ───────────────────────────────
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Enable XSS filter in older browsers
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Referrer policy — don't leak full URL to third parties
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Permissions policy — disable unnecessary browser features
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
    
    // Content Security Policy — allow self + CDN + API endpoints
    // Note: 'unsafe-inline' needed for Tailwind/styled-components, 'unsafe-eval' for mermaid/shiki
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
      "img-src 'self' data: blob: https: http:",
      "connect-src 'self' https: wss:",
      "media-src 'self' blob: https:",
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    
    res.setHeader('Content-Security-Policy', csp);
    
    next();
  };
}

// ─── Simple Rate Limiter ───────────────────────────────────────
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  rateLimitStore.forEach((entry, key) => {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  });
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware
 * @param maxRequests Maximum requests per window
 * @param windowMs Time window in milliseconds
 */
export function rateLimit(maxRequests: number = 100, windowMs: number = 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    
    let entry = rateLimitStore.get(key);
    
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }
    
    entry.count++;
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());
    
    if (entry.count > maxRequests) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }
    
    next();
  };
}

// ─── Input Sanitization Helpers ────────────────────────────────
/**
 * Sanitize a string by removing HTML tags and trimming
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/[<>"'&]/g, (char) => {
      const entities: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '&': '&amp;',
      };
      return entities[char] || char;
    })
    .trim();
}

/**
 * Validate and sanitize a search query
 */
export function sanitizeSearchQuery(query: string, maxLength: number = 200): string {
  return query.slice(0, maxLength).replace(/[^\w\s\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef.,!?@#-]/g, '').trim();
}
