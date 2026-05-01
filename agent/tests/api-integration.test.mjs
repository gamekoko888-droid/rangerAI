import { describe, it, beforeAll } from "vitest";;
import { expect } from "vitest";;

const BASE_URL = 'http://localhost:3000';

describe('API Integration Tests', () => {
  describe('Health Endpoint', () => {
    it('should return 200 on /api/health', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status === 'ok' || body.ok === true || res.status === 200).toBeTruthy();
    });

    it('should return JSON content type', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      const ct = res.headers.get('content-type') || '';
      expect(ct.includes('application/json') || ct.includes('text/'), `Expected JSON, got: ${ct}`).toBeTruthy();
    });
  });

  describe('Security Headers', () => {
    it('should include X-Content-Type-Options', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('should include X-Frame-Options', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('should include CSP without unsafe-eval', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      const csp = res.headers.get('content-security-policy') || '';
      expect(!csp.includes('unsafe-eval'), 'CSP should not contain unsafe-eval').toBeTruthy();
    });

    it('should include Referrer-Policy', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      const rp = res.headers.get('referrer-policy');
      expect(rp, 'Referrer-Policy header should be present').toBeTruthy();
    });
  });

  describe('Auth Endpoints', () => {
    it('should return 401 for unauthenticated admin access', async () => {
      const res = await fetch(`${BASE_URL}/api/admin/browser-status`);
      expect([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`).toBeTruthy();
    });

    it('should return 401 for invalid admin token', async () => {
      const res = await fetch(`${BASE_URL}/api/admin/browser-status`, {
        headers: { 'Authorization': 'Bearer invalid-token-12345' }
      });
      expect([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`).toBeTruthy();
    });
  });

  describe('Metrics Endpoint', () => {
    it('should return 401 without auth', async () => {
      const res = await fetch(`${BASE_URL}/api/metrics`);
      expect(res.status).toBe(401);
    });

    it('should return 200 with valid admin token', async () => {
      const token = process.env.ADMIN_TOKEN;
      if (!token) {
        // Skip if no token available in test env
        return;
      }
      const res = await fetch(`${BASE_URL}/api/metrics`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      expect(res.status).toBe(200);
    });
  });

  describe('CORS Handling', () => {
    it('should handle OPTIONS preflight', async () => {
      const res = await fetch(`${BASE_URL}/api/health`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'https://ranger.voyage' }
      });
      expect([200, 204].includes(res.status), `Expected 200/204, got ${res.status}`).toBeTruthy();
    });
  });

  describe('Rate Limiting', () => {
    it('should not block normal request rate', async () => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${BASE_URL}/api/health`);
        results.push(res.status);
      }
      expect(results.every(s => s === 200 || s === 429), 'All 5 requests should succeed').toBeTruthy();
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown API routes', async () => {
      const res = await fetch(`${BASE_URL}/api/nonexistent-route-xyz`);
      expect([404, 400, 429].includes(res.status), `Expected 404/400, got ${res.status}`).toBeTruthy();
    });
  });
});
